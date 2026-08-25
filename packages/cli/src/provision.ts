// Provisioning: pick/create a project, add a service, and mint the project's
// ingest key, via the existing cloud routes and carrying the CLI bearer token.
// Network calls inherit net.ts's single-retry + method/URL-in-message policy.
//
// Minting is deliberately NOT part of provisionFlow. env-file.ts decides first
// whether the key has anywhere safe to go, and only then is one minted, so a
// rerun against an already configured app does not leave a live unused
// credential behind on every pass. The wizard sequences the two.

import type { Stack } from "crumbtrail-core";
import type { Recipe } from "./detect";
import { RECIPE_REGISTRY } from "./recipe-registry";
import { ApiError, requestJson } from "./net";
import { color, type Prompter, type Ui } from "./ui";
import { ok } from "./theme";

export interface Project {
  id: string;
  name: string;
}

export interface Service {
  id: string;
  name: string;
  /**
   * Repository-relative directory the service was detected in, as the cloud
   * holds it. Null on every row the CLI created before it started sending one.
   */
  sourcePath?: string | null;
  /** The repository the service belongs to, when the cloud carries one. */
  repo?: string | null;
}

/**
 * Which repository, and which directory inside it, this run is wiring.
 *
 * A project can hold one service per name, ignoring case, so `api` in one
 * repository and `api` in another are the same row to the cloud. Sending the
 * identity is what lets the two be told apart: the cloud already has a
 * `source_path` column for the directory, and the repository is what
 * distinguishes two apps whose directory is `.` in both.
 */
export interface ServiceIdentity {
  /** Repository-relative app directory, e.g. `services/api` or `.`. */
  sourcePath?: string;
  /** Stable repository name, from the git origin remote where there is one. */
  repo?: string;
}

/** Thrown on a 402 from POST /api/projects — carries the upgrade copy + URL. */
export class UpgradeRequiredError extends Error {
  readonly upgradeUrl?: string;
  constructor(message: string, upgradeUrl?: string) {
    super(message);
    this.name = "UpgradeRequiredError";
    this.upgradeUrl = upgradeUrl;
  }
}

/** A project route rejected a token that is valid for this endpoint. */
export class ProjectAccessError extends Error {
  readonly projectId: string;
  readonly status: number;

  constructor(message: string, projectId: string, status: number) {
    super(message);
    this.name = "ProjectAccessError";
    this.projectId = projectId;
    this.status = status;
  }
}

// ── Pure inference helpers (unit-tested) ─────────────────────────────────────

/**
 * Project name: package.json `name` → git dir basename → "my-app". A scoped
 * package name (`@scope/app`) collapses to its last segment.
 */
export function inferProjectName(
  pkgName?: string | null,
  gitDirBasename?: string | null,
): string {
  const fromPkg = pkgName?.trim();
  if (fromPkg) {
    const last = fromPkg.split("/").pop();
    if (last) return last;
  }
  const fromDir = gitDirBasename?.trim();
  if (fromDir) return fromDir;
  return "my-app";
}

/**
 * Service name from stack/workspace: an explicit workspace package name wins;
 * otherwise Node backends default to "api" and client stacks to "web".
 */
export function inferServiceName(
  recipe: Recipe,
  workspaceName?: string | null,
): string {
  const ws = workspaceName?.trim();
  if (ws) {
    const last = ws.split("/").pop();
    if (last) return last;
  }
  return RECIPE_REGISTRY[recipe].serviceName;
}

// ── Cloud calls ──────────────────────────────────────────────────────────────

export async function listProjects(
  base: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<Project[]> {
  const res = await requestJson<{ projects?: Project[] }>(
    `${base}/api/projects`,
    { token, fetchImpl },
  );
  return Array.isArray(res.projects) ? res.projects : [];
}

export async function createProject(
  base: string,
  token: string,
  name: string,
  fetchImpl?: typeof fetch,
): Promise<Project> {
  try {
    return await requestJson<Project>(`${base}/api/projects`, {
      method: "POST",
      token,
      body: { name },
      fetchImpl,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) {
      const body =
        err.body && typeof err.body === "object"
          ? (err.body as Record<string, unknown>)
          : {};
      const copy =
        typeof body.error === "string"
          ? body.error
          : "Your plan's project limit was reached. Upgrade to add more.";
      const url =
        typeof body.upgradeUrl === "string"
          ? body.upgradeUrl
          : typeof body.billingUrl === "string"
            ? body.billingUrl
            : undefined;
      throw new UpgradeRequiredError(copy, url);
    }
    throw err;
  }
}

export async function listServices(
  base: string,
  token: string,
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<Service[]> {
  const res = await requestJson<{ services?: Service[] }>(
    `${base}/api/projects/${projectId}/services`,
    { token, fetchImpl },
  );
  return Array.isArray(res.services) ? res.services : [];
}

/**
 * Create a service, or adopt the one that already carries this name.
 *
 * Service names are unique per project, ignoring case, so the second run of the
 * wizard in a wired app used to die on a 409 before it ever reached the
 * already-wired check further down. Re-running is the single most natural thing
 * somebody does when they are not sure the first run worked, so a name that is
 * taken is treated as "this is the same app, carry on" rather than a failure.
 *
 * The 409 is still the source of truth for the collision: only after the server
 * refuses do we read the list back, which keeps the happy path one request and
 * makes the adopted service the real row rather than a guess.
 *
 * Adoption matches the name, because that is what the cloud's uniqueness rule
 * is built on. The name alone cannot tell "the same app, run again" from "a
 * different repository that also calls its backend api", so the identity this
 * run sends is compared against the identity the existing row carries, and the
 * three answers are reported separately: same repository, different
 * repository, or unknown because the row predates the CLI sending one.
 */
export type AdoptionMatch = "same-source" | "other-source" | "unknown-source";

export async function createService(
  base: string,
  token: string,
  projectId: string,
  args: { name: string; stack?: string; identity?: ServiceIdentity },
  fetchImpl?: typeof fetch,
): Promise<Service & { adopted?: boolean; adoptionMatch?: AdoptionMatch }> {
  const identity = args.identity ?? {};
  try {
    return await requestJson<Service>(
      `${base}/api/projects/${projectId}/services`,
      {
        method: "POST",
        token,
        body: {
          name: args.name,
          stack: args.stack,
          // Sent so the cloud can hold two same-named apps apart. A deployment
          // that does not read these ignores them, which is why the adoption
          // below still has to cope with a row that carries neither.
          ...(identity.sourcePath ? { sourcePath: identity.sourcePath } : {}),
          ...(identity.repo ? { repo: identity.repo } : {}),
        },
        fetchImpl,
      },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    const wanted = args.name.trim().toLowerCase();
    const existing = await listServices(base, token, projectId, fetchImpl);
    const match = existing.find(
      (service) => service.name.trim().toLowerCase() === wanted,
    );
    // No match after a name-taken 409 means the collision is with something
    // this token cannot read, and inventing a service would be worse than the
    // original error. The server's own words stand.
    if (!match) throw err;
    return { ...match, adopted: true, adoptionMatch: compareIdentity(match, identity) };
  }
}

/** Same repository, another one, or no way to tell from what the cloud returned. */
export function compareIdentity(
  existing: Pick<Service, "sourcePath" | "repo">,
  identity: ServiceIdentity,
): AdoptionMatch {
  const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();
  const theirRepo = norm(existing.repo);
  const ourRepo = norm(identity.repo);
  if (theirRepo && ourRepo) {
    if (theirRepo !== ourRepo) return "other-source";
    // Same repository. A different directory inside it is still a different app.
    const theirPath = norm(existing.sourcePath);
    const ourPath = norm(identity.sourcePath);
    if (theirPath && ourPath && theirPath !== ourPath) return "other-source";
    return "same-source";
  }
  const theirPath = norm(existing.sourcePath);
  const ourPath = norm(identity.sourcePath);
  // A path with no repository beside it says which directory, not which
  // checkout, so a match here is only ever evidence of the same directory.
  if (theirPath && ourPath) {
    return theirPath === ourPath ? "unknown-source" : "other-source";
  }
  return "unknown-source";
}

/**
 * Mint a project-scoped ingest key and return it in plaintext.
 *
 * The route is additive by default: it issues another key and leaves existing
 * ones live, which is the right shape here. Rotating would kill the key a
 * deployed app is already using, and this wizard has no business doing that to
 * a project it was merely pointed at.
 *
 * Plaintext is returned exactly once, by the server, and is never stored
 * anywhere by this process — the caller writes it straight into the app's env
 * file. See env-file.ts for the rules that write follows.
 *
 * The key id comes back with it because additive minting means a project can
 * hold several live keys, and the dashboard lists them all. Without the id the
 * run cannot say WHICH of those rows is the one now sitting in the app's env
 * file, which is the question a second run leaves behind.
 */
export async function createIngestKey(
  base: string,
  token: string,
  projectId: string,
  fetchImpl?: typeof fetch,
  identityLabel?: string,
): Promise<{ apiKey: string; keyId?: string }> {
  try {
    const res = await requestJson<{ keyId?: string; apiKey?: string }>(
      `${base}/api/projects/${projectId}/keys`,
      { method: "POST", token, body: {}, fetchImpl },
    );
    if (typeof res.apiKey !== "string" || res.apiKey.length === 0) {
      throw new Error("The server minted a key but returned no value for it.");
    }
    return {
      apiKey: res.apiKey,
      ...(typeof res.keyId === "string" && res.keyId
        ? { keyId: res.keyId }
        : {}),
    };
  } catch (err) {
    throw explainWrongAccount(err, projectId, identityLabel);
  }
}

// ── Orchestrated flow ────────────────────────────────────────────────────────

export interface ProvisionInput {
  base: string;
  token: string;
  recipe: Recipe;
  /**
   * The detected non-JS backend Stack for the `otlp` recipe
   * (`DetectResult.otlpStack`). When set it OVERRIDES the static
   * `RECIPE_REGISTRY[recipe].stack` placeholder on the createService call — this
   * is how the single otlp recipe reports its variable Stack to the service.
   */
  stack?: Stack | null;
  ui: Ui;
  prompter: Prompter;
  /** Skip prompts (non-interactive / --yes). */
  assumeYes: boolean;
  /** --project <id>: skip creation, attach a service to this project. */
  projectId?: string;
  /** Inferred defaults (from detection / package.json / git). */
  defaultProjectName: string;
  defaultServiceName: string;
  /** Which repository and directory this app lives in. */
  identity?: ServiceIdentity;
  /** Who the token belongs to, for the wrong-account message. */
  identityLabel?: string;
  fetchImpl?: typeof fetch;
}

export interface ProvisionResult {
  projectId: string;
  projectName: string;
  serviceId: string;
  serviceName: string;
  /** True when the service already existed and this run reused it. */
  adopted?: boolean;
  /** How much of that reuse the cloud's own identity could confirm. */
  adoptionMatch?: AdoptionMatch;
  /** Carried into the run summary when reuse could be the wrong application. */
  adoptionNote?: string;
}

export interface ResolveProjectInput {
  base: string;
  token: string;
  ui: Ui;
  prompter: Prompter;
  assumeYes: boolean;
  projectId?: string;
  defaultProjectName: string;
  /** Who the token belongs to, for the wrong-account message. */
  identityLabel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the project a service will report to: explicit --project, an
 * interactive pick among existing projects, or a freshly created one.
 *
 * Split out of provisionFlow so the batch installer can resolve ONE project and
 * then mint many services under it.
 */
export async function resolveProject(
  input: ResolveProjectInput,
): Promise<Project> {
  const { base, token, ui, prompter, fetchImpl } = input;
  let project: Project;

  if (input.projectId) {
    // Look the name up rather than printing the id under a "Project:" label.
    // The dashboard's setup wizard passes --project when it is adding an app
    // to a project the reader is already looking at, so the line under the
    // command is the one place the two surfaces have to agree, and `prj_7f3a`
    // agrees with nothing the reader has seen.
    //
    // A saved login is validated against the endpoint, never against this id,
    // so a token for another account used to sail through and print the id as
    // if the project were ours, then die on createService as "Project not
    // found". If this account's list does not contain the id, fail here and
    // name the account: the id was copied off Setup, so the login is what is
    // wrong. A network failure still falls back to the id; naming is not
    // worth failing a run that can still succeed.
    try {
      const existing = await listProjects(base, token, fetchImpl);
      const match = existing.find((p) => p.id === input.projectId);
      if (!match) throw projectNotVisible(input.projectId, input.identityLabel);
      project = { id: match.id, name: match.name };
    } catch (err) {
      if (err instanceof ProjectAccessError) throw err;
      project = { id: input.projectId, name: input.projectId };
    }
  } else {
    const existing = await listProjects(base, token, fetchImpl);
    if (existing.length > 0 && !input.assumeYes) {
      // Which option is safe to accept blind decides the order.
      //
      // A blind Enter has to be the harmless answer. Defaulting to the first
      // existing project made it the opposite: in a tenant with several
      // projects, the first row belongs to somebody else's app, so pressing
      // Enter filed this repo's production telemetry into their project — a
      // mistake nothing in the run afterwards reveals. Creating a project too
      // many is visible, empty, and deletable.
      //
      // The one case where joining IS established is an existing project whose
      // name matches the name inferred from this repo. Then that project leads
      // and is the default, which keeps a re-run out of a duplicate project.
      const wanted = input.defaultProjectName.trim().toLowerCase();
      const matchIndex = existing.findIndex(
        (p) => p.name.trim().toLowerCase() === wanted,
      );
      const createLabel = `Create a new project (${input.defaultProjectName})`;
      const labels =
        matchIndex >= 0
          ? [...existing.map((p) => p.name), createLabel]
          : [createLabel, ...existing.map((p) => p.name)];
      const choice = await prompter.select(
        "Which project should this app report to?",
        labels,
        matchIndex >= 0 ? matchIndex : 0,
      );
      const createChosen =
        matchIndex >= 0 ? choice === existing.length : choice === 0;
      if (createChosen) {
        // Created only after the name is confirmed — never before the pick, so
        // a run abandoned at the prompt leaves no empty project behind.
        const name = await prompter.ask(
          "New project name",
          input.defaultProjectName,
        );
        project = await createProject(base, token, name, fetchImpl);
      } else {
        project = existing[matchIndex >= 0 ? choice : choice - 1];
      }
    } else {
      // No existing projects, or --yes, which cannot ask. A second unattended
      // run in the same app inferred the same name again and created a second
      // project under it, so the app's sessions split across two identical
      // looking rows in the dashboard and neither one held the whole story.
      // An exact name match is the same app by the only test available here,
      // so it is joined rather than duplicated. Case is ignored, because the
      // two names are indistinguishable to whoever has to pick between them.
      const wanted = input.defaultProjectName.trim().toLowerCase();
      const already = existing.find(
        (p) => p.name.trim().toLowerCase() === wanted,
      );
      project =
        already ??
        (await createProject(base, token, input.defaultProjectName, fetchImpl));
    }
  }
  ui.out(ok(`Project: ${color.bold(color.brand(project.name))}`));
  return project;
}

export interface ProvisionServiceInput {
  base: string;
  token: string;
  projectId: string;
  /** Who the token belongs to, for the wrong-account message. */
  identityLabel?: string;
  recipe: Recipe;
  /** Detected otlp stack; overrides the registry placeholder. */
  stack?: Stack | null;
  serviceName: string;
  /** Which repository and directory this app lives in, sent with the create. */
  identity?: ServiceIdentity;
  ui: Ui;
  fetchImpl?: typeof fetch;
}

/**
 * Add one service to an already-resolved project.
 *
 * Still key-free, and still on purpose: one key covers the whole project, so
 * minting is a project-level step the wizard runs once, not something each
 * service repeats. Prompt-free by design too — the batch installer names
 * services from detection rather than asking N times.
 */
export async function provisionService(input: ProvisionServiceInput): Promise<{
  serviceId: string;
  serviceName: string;
  adopted?: boolean;
  adoptionMatch?: AdoptionMatch;
  /** Printed by the caller's summary when adoption could be the wrong app. */
  adoptionNote?: string;
}> {
  const { base, token, ui, fetchImpl } = input;
  // Prefer the DETECTED otlp stack when present; otherwise the registry stack.
  // For otlp the registry value is only a placeholder, so input.stack is what
  // actually files the service under django/flask/fastapi/go/rails/dotnet.
  // `reportedStack` covers the recipes the closed `Stack` vocabulary has no id
  // for (flutter). Without it the service files under the placeholder the
  // registry carries for typing, and the telemetry that exists to aim SDK work
  // would read a Flutter app as a React one.
  const meta = RECIPE_REGISTRY[input.recipe];
  const serviceStack = input.stack ?? meta.reportedStack ?? meta.stack;
  let service: Service & { adopted?: boolean; adoptionMatch?: AdoptionMatch };
  try {
    service = await createService(
      base,
      token,
      input.projectId,
      {
        name: input.serviceName,
        stack: serviceStack,
        ...(input.identity ? { identity: input.identity } : {}),
      },
      fetchImpl,
    );
  } catch (err) {
    throw explainWrongAccount(err, input.projectId, input.identityLabel);
  }
  // "Application" is what the dashboard calls this object. The CLI used to call
  // it a service here and then link the reader to a page that has no such word
  // on it.
  const label = `Application: ${color.bold(color.brand(service.name))}`;
  ui.out(
    ok(
      service.adopted
        ? `${label} ${color.dim(adoptionSuffix(service.adoptionMatch))}`
        : label,
    ),
  );
  const line = service.adopted
    ? adoptionWarning(service.name, service.adoptionMatch, input.identity)
    : undefined;
  // A verified clash is a decision the reader has to make now, so it is a
  // warning and it is repeated in the end of run summary. A name match the
  // cloud could not qualify is context: every rerun of a wired app produces
  // one, and carrying it into the summary each time would train the reader to
  // skip the line that matters.
  const clash = service.adoptionMatch === "other-source";
  if (line) ui.out(clash ? color.yellow(`! ${line}`) : color.dim(`  ${line}`));

  return {
    serviceId: service.id,
    serviceName: service.name,
    ...(service.adopted ? { adopted: true } : {}),
    ...(service.adoptionMatch ? { adoptionMatch: service.adoptionMatch } : {}),
    ...(clash && line ? { adoptionNote: line } : {}),
  };
}

function adoptionSuffix(match?: AdoptionMatch): string {
  return match === "same-source"
    ? "(this repository already has it here, reusing it)"
    : "(already in this project, reusing it)";
}

/**
 * What the reader has to know when an existing application was reused.
 *
 * Reusing the row is right when it is the same app run again, and it is the
 * whole reason a second run does not die on a 409. It is wrong when the name
 * happens to be shared with an app in another repository, because both then
 * file their events under one application and neither reader can separate
 * them. The CLI cannot tell which case it is unless the cloud returns the
 * identity, so it says which of the two it verified.
 */
function adoptionWarning(
  name: string,
  match?: AdoptionMatch,
  identity?: ServiceIdentity,
): string | undefined {
  if (match === "same-source") return undefined;
  const here = identity?.repo
    ? ` This run is wiring ${identity.repo}${identity.sourcePath && identity.sourcePath !== "." ? `/${identity.sourcePath}` : ""}.`
    : "";
  if (match === "other-source") {
    return `The application named ${name} in this project belongs to a different repository or directory, and reusing it would file both sets of events under one application.${here} Re run with a distinct name (the CLI asks for one), or pick another project.`;
  }
  return `An application named ${name} already existed in this project and was reused. The cloud returned no repository for it, so this run matched on the name alone.${here} If another repository also reports an application called ${name} here, their events land together.`;
}

/**
 * Rewrite a cloud refusal on a named project.
 *
 * The API hides another tenant's project behind the same 404 as a missing id,
 * so the wizard used to print "Project not found" for both. That reads as a bad
 * id and sends the reader off to re-check a string they copied off their own
 * Setup page. Split the two:
 *
 *   - we know who is signed in → the project is not visible to that account,
 *     and the fix is to sign in as the account that owns it
 *   - we do not → no such project, and the id itself is what failed
 *
 * A 403 is always the first case: the route exists and the token was refused.
 */
export function projectNotVisible(
  projectId: string,
  identityLabel?: string,
  status = 404,
): ProjectAccessError {
  if (!identityLabel && status === 404) {
    return new ProjectAccessError(
      projectMissingMessage(projectId),
      projectId,
      status,
    );
  }
  const who = identityLabel ? ` as ${identityLabel}` : "";
  return new ProjectAccessError(
    `The account you are signed in${who} cannot see project ${projectId}. ` +
      `The project id is probably right and this saved login is for another ` +
      `account. Run \`crumbtrail logout\`, then \`npx crumbtrail\` again to ` +
      `sign in as the owner of that project.`,
    projectId,
    status,
  );
}

export function projectMissingMessage(projectId: string): string {
  return `No project ${projectId} exists. Check the id.`;
}

export function explainWrongAccount(
  err: unknown,
  projectId: string,
  identityLabel?: string,
): unknown {
  if (
    !(err instanceof ApiError) ||
    (err.status !== 403 && err.status !== 404)
  ) {
    return err;
  }
  return projectNotVisible(projectId, identityLabel, err.status);
}

/**
 * De-collide inferred service names. Two frontends in `apps/web` and
 * `apps/marketing` both infer to "web" (RECIPE_REGISTRY[next].serviceName), and
 * two identically-named services in one project are indistinguishable in the
 * dashboard. On a collision, fall back to the directory basename, then to a
 * numeric suffix. Order-stable: the first claimant keeps the plain name.
 */
export function uniqueServiceNames(
  candidates: { name: string; relDir: string }[],
): string[] {
  const taken = new Set<string>();
  return candidates.map((c) => {
    const options = [
      c.name,
      c.relDir.split("/").filter(Boolean).pop() ?? c.name,
      // Distinguish apps/web from packages/web: use the parent too.
      c.relDir.split("/").filter(Boolean).join("-"),
    ];
    for (const option of options) {
      if (option && !taken.has(option)) {
        taken.add(option);
        return option;
      }
    }
    let n = 2;
    while (taken.has(`${c.name}-${n}`)) n += 1;
    const fallback = `${c.name}-${n}`;
    taken.add(fallback);
    return fallback;
  });
}

/**
 * Resolve a project and add a service to it, returned to the wizard for the
 * summary. Composed from resolveProject + provisionService so the
 * single-package path keeps its exact behavior (including the interactive
 * "Service name" prompt). The key is minted later, by the wizard, once
 * env-file.ts has confirmed it has somewhere safe to go.
 */
export async function provisionFlow(
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const project = await resolveProject(input);

  let serviceName = input.defaultServiceName;
  if (!input.assumeYes) {
    serviceName = await input.prompter.ask(
      "Service name",
      input.defaultServiceName,
    );
  }

  const service = await provisionService({
    base: input.base,
    token: input.token,
    projectId: project.id,
    recipe: input.recipe,
    stack: input.stack,
    serviceName,
    ui: input.ui,
    ...(input.identity ? { identity: input.identity } : {}),
    ...(input.identityLabel ? { identityLabel: input.identityLabel } : {}),
    fetchImpl: input.fetchImpl,
  });

  return {
    projectId: project.id,
    projectName: project.name,
    serviceId: service.serviceId,
    serviceName: service.serviceName,
    ...(service.adopted ? { adopted: true } : {}),
    ...(service.adoptionMatch ? { adoptionMatch: service.adoptionMatch } : {}),
    ...(service.adoptionNote ? { adoptionNote: service.adoptionNote } : {}),
  };
}
