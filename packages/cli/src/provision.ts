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
 */
export async function createService(
  base: string,
  token: string,
  projectId: string,
  args: { name: string; stack?: string },
  fetchImpl?: typeof fetch,
): Promise<Service & { adopted?: boolean }> {
  try {
    return await requestJson<Service>(
      `${base}/api/projects/${projectId}/services`,
      {
        method: "POST",
        token,
        body: { name: args.name, stack: args.stack },
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
    return { ...match, adopted: true };
  }
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
}

export interface ResolveProjectInput {
  base: string;
  token: string;
  ui: Ui;
  prompter: Prompter;
  assumeYes: boolean;
  projectId?: string;
  defaultProjectName: string;
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
    // agrees with nothing the reader has seen. A failed or unmatched read
    // falls back to the id, which is still true, just less useful.
    let name = input.projectId;
    try {
      const existing = await listProjects(base, token, fetchImpl);
      const match = existing.find((p) => p.id === input.projectId);
      if (match) name = match.name;
    } catch {
      /* the id stands in; naming the project is not worth failing the run */
    }
    project = { id: input.projectId, name };
  } else {
    const existing = await listProjects(base, token, fetchImpl);
    if (existing.length > 0 && !input.assumeYes) {
      // The existing projects come first, so the default is joining one rather
      // than making another. A tenant with exactly one project is the common
      // case, and offering "Create a new project" as the default landed a
      // first application in a second project the dashboard is not scoped to.
      const labels = [
        ...existing.map((p) => p.name),
        `Create a new project (${input.defaultProjectName})`,
      ];
      const choice = await prompter.select(
        "Which project should this app report to?",
        labels,
        0,
      );
      if (choice === existing.length) {
        const name = await prompter.ask(
          "New project name",
          input.defaultProjectName,
        );
        project = await createProject(base, token, name, fetchImpl);
      } else {
        project = existing[choice];
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
export async function provisionService(
  input: ProvisionServiceInput,
): Promise<{ serviceId: string; serviceName: string; adopted?: boolean }> {
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
  let service: Service & { adopted?: boolean };
  try {
    service = await createService(
      base,
      token,
      input.projectId,
      { name: input.serviceName, stack: serviceStack },
      fetchImpl,
    );
  } catch (err) {
    throw explainWrongAccount(err, input.projectId, input.identityLabel);
  }
  ui.out(
    ok(
      service.adopted
        ? `Service: ${color.bold(color.brand(service.name))} ${color.dim("(already in this project — reusing it)")}`
        : `Service: ${color.bold(color.brand(service.name))}`,
    ),
  );

  return {
    serviceId: service.id,
    serviceName: service.name,
    ...(service.adopted ? { adopted: true } : {}),
  };
}

/**
 * Rewrite the cloud's 404 for a project id that is real but belongs to another
 * workspace.
 *
 * A CLI token is validated against the ENDPOINT and never against the project,
 * so a stale token for a different tenant sails through login and dies here as
 * "Project not found" — which reads as a bad id, and sends the reader off to
 * re-check an id that was correct all along. The account is the thing that is
 * wrong, so the message names it.
 */
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
  const who = identityLabel ? ` as ${identityLabel}` : "";
  return new ProjectAccessError(
    `The account you are signed in${who} cannot see project ${projectId}. ` +
      `The project id is probably right and this saved login is for another ` +
      `account. Run \`crumbtrail logout\`, then \`npx crumbtrail\` again to ` +
      `sign in as the owner of that project. (${err.message})`,
    projectId,
    err.status,
  );
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
    ...(input.identityLabel ? { identityLabel: input.identityLabel } : {}),
    fetchImpl: input.fetchImpl,
  });

  return {
    projectId: project.id,
    projectName: project.name,
    serviceId: service.serviceId,
    serviceName: service.serviceName,
    ...(service.adopted ? { adopted: true } : {}),
  };
}
