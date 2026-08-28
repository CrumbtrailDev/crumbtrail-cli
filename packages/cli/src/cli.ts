#!/usr/bin/env node
// The `crumbtrail` setup wizard. Hand-rolled arg parsing (no CLI framework to keep
// npx cold-start fast), a non-TTY guard that runs BEFORE any prompt, and the
// end-to-end flow: banner → detect → login → provision → SDK install → inject →
// verify → summary. Injection is the LAST repo-mutating step and only ever runs
// through CP3's buildPlan/executePlan.
//
// All logic is exported for tests; the bin auto-runs only when this file is the
// invoked script (guarded at the bottom), so importing it in vitest is inert.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildPlan,
  DENO_UNSUPPORTED_REASON,
  defaultInjectIO,
  detect,
  executePlan,
  findNearbyProjectDirs,
  localFsReader,
  PROCESS_WRAPPER_REASON,
  type DetectResult,
  type PackageManager,
  type Plan,
  type Recipe,
} from "./index";
import {
  canUseBrowser,
  clearAuth as clearStoredAuth,
  describeIdentity,
  ensureToken,
  fetchIdentity,
  loadAuth,
  openBrowser,
  reportedAppBase,
} from "./auth";
import {
  exitCodeFor,
  runPreflight,
  toJson,
  type AuthProbe,
  type PreflightResult,
  type StageResult,
} from "./preflight";
import {
  createIngestKey,
  inferProjectName,
  inferServiceName,
  provisionFlow,
  provisionService,
  ProjectAccessError,
  resolveProject,
  setSessionReplay,
  uniqueServiceNames,
  UpgradeRequiredError,
  type ProvisionResult,
  type ServiceIdentity,
} from "./provision";
import {
  applyEnvEdits,
  buildEnvKeyEdits,
  defaultEnvFileIO,
  planEnvKeyWrite,
  readEnvVar,
  type EnvFileIO,
  type EnvKeyPlan,
} from "./env-file";
import {
  pollForRealEvent,
  pollForServices,
  type PollRealEventResult,
  type PollServicesResult,
} from "./verify";
import { discoverServices, type ServiceCandidate } from "./discover";
import { isBackendRecipe, resolveBackendOrigins } from "./backend-origins";
import { otlpGuidePlan, renderOtlpGuide } from "./otlp-guide";
import { RECIPE_REGISTRY, sdkInstallSpec } from "./recipe-registry";
import { APP_URL_ENV_VAR, dashboardBase, resolveEndpoint } from "./net";
import {
  color,
  consoleUi,
  stdinPrompter,
  type MultiSelectItem,
  type Prompter,
  type Ui,
} from "./ui";
import {
  alert,
  banner,
  chip,
  headline,
  outcomeBar,
  caps,
  field,
  glyphs,
  note,
  ok,
  rule,
  step,
} from "./theme";

/** How many numbered steps the single-package wizard shows. */
const TOTAL_STEPS = 6;

// ── Version ──────────────────────────────────────────────────────────────────

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirnameCompat(), "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** __dirname in CJS; a computed fallback for ESM builds. */
function __dirnameCompat(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return process.cwd();
}

/** Order two dotted numeric versions. A prerelease suffix sorts below its release. */
export function compareSdkVersions(a: string, b: string): number {
  const parts = (v: string): number[] => {
    const core = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!core) return [0, 0, 0, 0];
    const prerelease = /^\d+\.\d+\.\d+-/.test(v.trim()) ? 0 : 1;
    return [Number(core[1]), Number(core[2]), Number(core[3]), prerelease];
  };
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** A released x.y.z, or undefined for anything else (prerelease, unreadable). */
function releaseVersion(version: string): string | undefined {
  return /^\d+\.\d+\.\d+$/.test(version.trim()) ? version.trim() : undefined;
}

/**
 * The install spec for one SDK package, floored at THIS CLI's own version.
 *
 * `SDK_VERSION_FLOORS` is a CAPABILITY floor — the oldest SDK the recipes still
 * work against — and it is deliberately not raised for every release. That is
 * the right rule for a resolver that takes the newest matching version, and the
 * wrong one for pnpm 10+/11, whose release-age gate silently skips versions
 * published in the last few days: a run of `crumbtrail` 0.37.0 asking for
 * `>=0.31.0` resolved `crumbtrail-node` 0.36.0 hours after 0.37.0 shipped, and
 * 0.36.0's backend log capture does not work. The SDKs and the CLI are released
 * in lockstep, so the CLI's own version is a version that exists on the
 * registry, and asking for it by name is what makes pnpm's gate step aside.
 * The capability floor still wins when it is HIGHER (a CLI older than the
 * recipes it carries cannot happen, but the max costs nothing).
 */
export function sdkInstallSpecForCli(
  pkg: string,
  cliVersion: string = readVersion(),
): string {
  const declared = sdkInstallSpec(pkg);
  const capabilityFloor = declared.startsWith(`${pkg}@>=`)
    ? declared.slice(pkg.length + 3)
    : undefined;
  // A prerelease CLI must not demand a prerelease SDK that was never published.
  const ownVersion = releaseVersion(cliVersion);
  if (!ownVersion) return declared;
  if (!capabilityFloor) return `${pkg}@>=${ownVersion}`;
  return compareSdkVersions(ownVersion, capabilityFloor) > 0
    ? `${pkg}@>=${ownVersion}`
    : declared;
}

/**
 * The version of `pkg` as it actually sits on disk for an app at `cwd`, or
 * undefined when it is not there. Walks up through parent `node_modules` because
 * npm and yarn hoist, and a pnpm workspace links the dependency into the app's
 * own `node_modules` while the store lives at the root.
 *
 * This is the only honest answer to "did the install work". A package manager's
 * exit code is not: pnpm 10+/11 exits 1 with ERR_PNPM_IGNORED_BUILDS whenever
 * ANY dependency in the tree has an unapproved build script (esbuild, sharp,
 * prisma…), long after the packages it was asked to add are installed.
 */
export function resolvedSdkVersion(
  cwd: string,
  pkg: string,
): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const manifest = path.join(
      dir,
      "node_modules",
      ...pkg.split("/"),
      "package.json",
    );
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        version?: string;
      };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // not here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

export type Command =
  "wizard" | "login" | "logout" | "token" | "verify" | "help" | "version";

export interface ParsedArgs {
  command: Command;
  yes: boolean;
  project?: string;
  noBrowser: boolean;
  skipVerify: boolean;
  /**
   * Do not mint an ingest key or write one to an env file — print the variable
   * to set instead. For anyone whose secrets come from a vault or a platform's
   * own env UI, where a key on a developer's disk is the wrong artifact.
   */
  noWriteKey: boolean;
  endpoint?: string;
  /**
   * Monorepo root only: wire exactly these services (repeatable `--only`,
   * matched against a service's package name or path). Also the non-interactive
   * escape hatch — a root run in CI must name its services somehow.
   */
  only?: string[];
  /** Monorepo root only: select every wireable service, no prompt. */
  all: boolean;
  /**
   * Target a specific package directory instead of the detected repo root. In a
   * monorepo this bypasses the batch scan and wires exactly this one package
   * (resolved relative to cwd; must exist and hold a package.json).
   */
  workspace?: string;
  /**
   * Turn session replay on (`--replay`) or off (`--no-replay`) for the project
   * without being asked. Unset means ask on a TTY and leave replay alone
   * otherwise, because recording a customer's end users is not a default a
   * non-interactive run should pick on their behalf.
   */
  replay?: boolean;
  /**
   * `verify` only: the ingest key to probe with (else $CRUMBTRAIL_KEY, else the
   * cached login token). The primary CI credential for a pre-deploy check.
   */
  key?: string;
  /** `verify` only: emit a machine-readable JSON result instead of the human table. */
  json: boolean;
  /** Non-flag/subcommand leftover — an unknown token triggers usage help. */
  unknown?: string;
  /** A flag that needs a value was used without one. */
  parseError?: string;
}

function flagValue(
  args: string[],
  index: number,
  flag: string,
): { value?: string; error?: string } {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    return { error: `${flag} requires a value.` };
  }
  return { value };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const parsed: ParsedArgs = {
    command: "wizard",
    yes: false,
    noBrowser: false,
    skipVerify: false,
    noWriteKey: false,
    all: false,
    json: false,
  };
  let commandSet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--help":
      case "-h":
        parsed.command = "help";
        return parsed;
      case "--version":
      case "-v":
        parsed.command = "version";
        return parsed;
      case "--yes":
      case "-y":
        parsed.yes = true;
        break;
      case "--no-browser":
        parsed.noBrowser = true;
        break;
      case "--skip-verify":
        parsed.skipVerify = true;
        break;
      case "--replay":
        parsed.replay = true;
        break;
      case "--no-replay":
        parsed.replay = false;
        break;
      case "--no-write-key":
        parsed.noWriteKey = true;
        break;
      case "--project":
        {
          const value = flagValue(args, i, a);
          if (value.error) parsed.parseError ??= value.error;
          else {
            parsed.project = value.value;
            i += 1;
          }
        }
        break;
      case "--endpoint":
        {
          const value = flagValue(args, i, a);
          if (value.error) parsed.parseError ??= value.error;
          else {
            parsed.endpoint = value.value;
            i += 1;
          }
        }
        break;
      case "--key":
        {
          const value = flagValue(args, i, a);
          if (value.error) parsed.parseError ??= value.error;
          else {
            parsed.key = value.value;
            i += 1;
          }
        }
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--all":
        parsed.all = true;
        break;
      case "--only":
        {
          const value = flagValue(args, i, a);
          if (value.error) parsed.parseError ??= value.error;
          else {
            (parsed.only ??= []).push(value.value as string);
            i += 1;
          }
        }
        break;
      case "--workspace":
        {
          const value = flagValue(args, i, a);
          if (value.error) parsed.parseError ??= value.error;
          else {
            parsed.workspace = value.value;
            i += 1;
          }
        }
        break;
      default:
        if (a.startsWith("--project=")) {
          const value = a.slice("--project=".length).trim();
          if (value) parsed.project = value;
          else parsed.parseError ??= "--project requires a value.";
        } else if (a.startsWith("--endpoint=")) {
          const value = a.slice("--endpoint=".length).trim();
          if (value) parsed.endpoint = value;
          else parsed.parseError ??= "--endpoint requires a value.";
        } else if (a.startsWith("--key=")) {
          const value = a.slice("--key=".length).trim();
          if (value) parsed.key = value;
          else parsed.parseError ??= "--key requires a value.";
        } else if (a.startsWith("--only=")) {
          const value = a.slice("--only=".length).trim();
          if (value) (parsed.only ??= []).push(value);
          else parsed.parseError ??= "--only requires a value.";
        } else if (a.startsWith("--workspace=")) {
          const value = a.slice("--workspace=".length).trim();
          if (value) parsed.workspace = value;
          else parsed.parseError ??= "--workspace requires a value.";
        } else if (
          !commandSet &&
          (a === "login" || a === "logout" || a === "token" || a === "verify")
        ) {
          parsed.command = a;
          commandSet = true;
        } else if (!a.startsWith("-")) {
          parsed.unknown = a;
        } else {
          parsed.unknown = a;
        }
    }
  }
  return parsed;
}

const TAGLINE = "Bug context for coding agents. Set it up in one command.";

/**
 * Help text. Built per call rather than as a constant so it picks up the
 * terminal's real colour depth and width, and so `--help` piped to a file is
 * plain text.
 */
function usage(): string {
  const g = glyphs();
  const head = (t: string) => chip(` ${t.toUpperCase()} `, "brandDeep");
  const flag = (f: string, text: string) =>
    `  ${color.brand(f.padEnd(26))} ${text}`;
  const cmd = (c: string, text: string) =>
    `  ${color.bold(c.padEnd(26))} ${color.dim(text)}`;

  return [
    ...banner(readVersion(), TAGLINE),
    "",
    head("Usage"),
    cmd(
      "crumbtrail [options]",
      `Run the setup wizard (detect ${g.arrow} login ${g.arrow} wire ${g.arrow} verify)`,
    ),
    cmd("crumbtrail login", "Log in and cache a token, nothing else"),
    cmd("crumbtrail logout", "Delete the cached token"),
    cmd(
      "crumbtrail token",
      "Print the cached CLI token (set it as CRUMBTRAIL_TOKEN in CI)",
    ),
    cmd(
      "crumbtrail verify",
      "Preflight an endpoint + key (DNS, TLS, auth) — PASS/FAIL",
    ),
    "",
    color.dim(
      "With more than one app, run it from the repo root: it scans every workspace and service,",
    ),
    color.dim("shows you what it found, and wires the ones you pick."),
    "",
    // Help used to say "browser" exactly once, in an unrelated login flag, so a
    // reader came away certain this was a backend-only product and that the
    // frontend half of their app was out of scope. It is not: browser capture
    // is the primary frontend path, and help is where that has to be visible.
    head("What it captures"),
    `  ${color.bold("Browser".padEnd(9))}console, network, DOM and errors — Next.js, SvelteKit, Nuxt, Remix,`,
    color.dim(
      "           Astro, Angular, Vite SPA, Create React App, Capacitor, React",
    ),
    color.dim(
      "           Native, Flutter, and plain static pages (script tag).",
    ),
    `  ${color.bold("Server".padEnd(9))}requests, crashes, logs and SQL — Express, NestJS, Fastify, Hono,`,
    color.dim(
      "           a plain Node server, and Django/Flask/FastAPI/Go/Rails/.NET over OTLP.",
    ),
    "",
    head("Options"),
    flag("--yes, -y", "Skip confirmations (required with --project in CI)"),
    flag("--project <id>", "Attach to an existing project (skip creation)"),
    flag("--only <name>", "Monorepo: wire only this service (repeatable)"),
    flag("--all", "Monorepo: wire every service it can, no prompt"),
    flag(
      "--workspace <dir>",
      "Target one package dir (relative to cwd) instead of",
    ),
    `  ${" ".repeat(26)} the repo root — wires just that package`,
    flag("--no-browser", "Use the device-code login flow"),
    flag("--skip-verify", "Don't wait for the first event"),
    flag("--no-write-key", "Don't mint or write an ingest key; print the"),
    `  ${" ".repeat(26)} variable to set instead`,
    flag("--replay, --no-replay", "Record session replay for this project, or"),
    `  ${" ".repeat(26)} don't — else you are asked once`,
    flag(
      "--endpoint <url>",
      "Cloud endpoint (else $CRUMBTRAIL_BASE_URL, else default)",
    ),
    flag("--help, -h", "Show this help"),
    flag("--version, -v", "Print the version"),
    "",
    head("verify options"),
    color.dim("  Pre-deploy check — point it at any environment."),
    flag(
      "--endpoint <url>",
      "Endpoint to probe (else $CRUMBTRAIL_BASE_URL, else default)",
    ),
    flag(
      "--key <ingestKey>",
      "Ingest key to probe with (else $CRUMBTRAIL_KEY, else cached login)",
    ),
    flag("--project <id>", "Project id for the auth GET fallback (no key)"),
    flag(
      "--json",
      "Emit a machine-readable result (exit 0 = pass, non-0 = fail)",
    ),
    "",
    head("Appearance"),
    color.dim(
      `  NO_COLOR / FORCE_COLOR set the colour depth; CRUMBTRAIL_ASCII=1 forces plain ASCII.`,
    ),
  ].join("\n");
}

// ── SDK install ──────────────────────────────────────────────────────────────

export interface InstallSdkInput {
  cwd: string;
  packageManager: PackageManager | null;
  recipe: Recipe;
  base: string;
  ui: Ui;
  /** Injected runner (tests); returns the child exit code. */
  spawnFn?: (cmd: string, args: string[], cwd: string) => number;
  /** Injected fetch for the tarball-manifest fallback (tests); defaults to global. */
  fetchImpl?: typeof fetch;
  /** Injected on-disk version reader (tests); defaults to `resolvedSdkVersion`. */
  resolvedVersionFn?: (cwd: string, pkg: string) => string | undefined;
  /** This CLI's own version (tests); defaults to its package.json. */
  cliVersion?: string;
}

export interface InstallSdkResult {
  installed: boolean;
  packages: string[];
  note?: string;
}

/**
 * A loud line when the SDK that landed is OLDER than the CLI that wired it.
 *
 * The CLI and the SDKs ship in lockstep, so anything below this CLI's version
 * is a resolver that did not take what was asked for — in practice pnpm's
 * `minimumReleaseAge` gate skipping a version published in the last few days.
 * That is invisible in the install output (pnpm prints a quiet "0.37.0 is
 * available" line), and the user's app then captures with an SDK whose
 * behaviour does not match what setup just told them. Naming the cause and the
 * exact command is the difference between a five-minute fix and a bug report.
 */
function staleSdkNote(
  cwd: string,
  packages: string[],
  cliVersion: string,
  cmd: string,
  add: string,
  resolveVersion: (cwd: string, pkg: string) => string | undefined,
): string | undefined {
  const own = releaseVersion(cliVersion);
  if (!own) return undefined;
  const stale: string[] = [];
  for (const pkg of packages) {
    const version = resolveVersion(cwd, pkg);
    if (version && compareSdkVersions(version, own) < 0) {
      stale.push(`${pkg}@${version}`);
    }
  }
  if (stale.length === 0) return undefined;
  const pinned = packages.map((pkg) => `${pkg}@${own}`).join(" ");
  return (
    `Your package manager installed ${stale.join(", ")}, older than this ` +
    `CLI (${own}). The usual cause is a release-age setting that skips ` +
    `recently published versions (pnpm's minimumReleaseAge, on by default in ` +
    `pnpm 10 and 11). Older SDKs do not capture everything this setup ` +
    `assumes, so pin them: \`${cmd} ${add} ${pinned}\`.`
  );
}

function sdkPackagesFor(recipe: Recipe): string[] {
  return RECIPE_REGISTRY[recipe].sdkPackages;
}

function pmInvocation(pm: PackageManager | null): { cmd: string; add: string } {
  switch (pm) {
    case "pnpm":
      return { cmd: "pnpm", add: "add" };
    case "yarn":
      return { cmd: "yarn", add: "add" };
    case "bun":
      return { cmd: "bun", add: "add" };
    default:
      return { cmd: "npm", add: "install" };
  }
}

// ── Repository identity ──────────────────────────────────────────────────────

/**
 * Read one value out of git, or nothing.
 *
 * Config reads only: neither query compares the working tree against the index,
 * so neither makes git hash a file, so neither can run a repository's clean
 * filter. Same property env-file.ts relies on, and the reason this is safe to
 * run in a repository this process did not create. Machine level config is
 * excluded so a surrounding hook cannot change the answer.
 */
function gitValue(cwd: string, args: string[]): string | null {
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_CONFIG_SYSTEM = "/dev/null";
    const res = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    if (res.status !== 0 || typeof res.stdout !== "string") return null;
    return res.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * A remote URL reduced to the repository it names, so the same repository
 * reads the same however it was cloned: `git@github.com:acme/api.git`,
 * `https://github.com/acme/api.git` and `ssh://git@github.com/acme/api` all
 * become `github.com/acme/api`.
 */
export function normalizeRepoUrl(url: string): string {
  let s = url.trim();
  s = s.replace(/\.git$/i, "");
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  // scp style `host:path`, but not `host:port/path`: rewriting a port would
  // report one self hosted repository under two names depending on the URL the
  // reader happened to clone with.
  s = s.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

/**
 * Which repository, and which directory inside it, is being wired.
 *
 * A project holds one application per name, ignoring case, so `api` in this
 * repository and `api` in another are one row to the cloud and their events
 * arrive mixed. This is the identity that tells them apart, and it is sent with
 * every create.
 *
 * The repository is taken from the origin remote and from nothing else. A
 * directory basename would be a guess, and a wrong guess here reports two
 * checkouts of one repository as two different repositories.
 */
export function serviceIdentity(appDir: string): ServiceIdentity {
  const top = gitValue(appDir, ["rev-parse", "--show-toplevel"]);
  const root = top ?? appDir;
  const remote = gitValue(root, ["remote", "get-url", "origin"]);
  const sourcePath = path.relative(root, appDir) || ".";
  return {
    sourcePath,
    ...(remote ? { repo: normalizeRepoUrl(remote) } : {}),
  };
}

function realSpawn(cmd: string, args: string[], cwd: string): number {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.error) return 1;
  return res.status ?? 1;
}

/**
 * Discover the deploy's tarball URLs for the given packages via
 * `GET <base>/install/manifest.json` (served by cloud's install-routes from the
 * baked pack-manifest). Returns one URL per package in order, or an empty array
 * when the manifest is unavailable or any package is missing — the caller then
 * falls back to a manual note rather than a partial install.
 */
async function discoverTarballUrls(
  base: string,
  packages: string[],
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  try {
    const doFetch = fetchImpl ?? fetch;
    const res = await doFetch(`${base}/install/manifest.json`);
    if (!res.ok) return [];
    const body = (await res.json()) as { files?: unknown };
    const files = Array.isArray(body.files)
      ? body.files.filter((f): f is string => typeof f === "string")
      : [];
    const urls: string[] = [];
    for (const pkg of packages) {
      const file = files.find(
        (f) => f.startsWith(`${pkg}-`) && f.endsWith(".tgz"),
      );
      if (!file) return [];
      urls.push(`${base}/install/${file}`);
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Install the SDK with the detected package manager. If the registry install
 * fails (e.g. packages not yet public, or a self-hosted endpoint), fall back to
 * installing the deploy's packed tarballs — discovered via
 * `GET <base>/install/manifest.json` — so a fresh deploy wires up before the
 * packages are on npm. Every recipe's SDK (including react-native and tauri, now
 * packed as optional channels by pack-local.mjs) is resolved by name prefix from
 * that manifest, so the fallback is uniform. Non-fatal either way, since
 * injection only writes import statements.
 */
export async function installSdk(
  input: InstallSdkInput,
): Promise<InstallSdkResult> {
  const packages = sdkPackagesFor(input.recipe);
  // Empty package list (the `otlp` guidance recipe): there is no SDK to add —
  // skip the install entirely. Never spawn a bare `<pm> add`/`npm install` with
  // no args, which would install ALL deps. Early-return a skipped result.
  if (packages.length === 0) {
    return { installed: false, packages: [] };
  }
  const run = input.spawnFn ?? realSpawn;
  const meta = RECIPE_REGISTRY[input.recipe];

  // A package that is not on its registry cannot be added, and saying so is the
  // whole job here. Attempting it produces a failure whose real cause — the
  // package does not exist — is invisible in the exit code, so the wizard would
  // report something it does not know and send the user to debug their own
  // toolchain.
  if (meta.sdkUnpublished) {
    const registry = meta.packageEcosystem === "pub" ? "pub.dev" : "npm";
    return {
      installed: false,
      packages,
      note: `${packages.join(", ")} is not published on ${registry} yet, so this app cannot be wired automatically. Nothing was installed and no files were changed.`,
    };
  }

  // Dart packages live on pub.dev, not npm. Nothing below this branch applies to
  // them: there is no detected package manager, no npm version floor, and the
  // deploy's tarball fallback serves npm tarballs only.
  if (meta.packageEcosystem === "pub") {
    input.ui.out(
      `  ${color.dim("Installing SDK:")} ${color.brand(`flutter pub add ${packages.join(" ")}`)}`,
    );
    const pubCode = run("flutter", ["pub", "add", ...packages], input.cwd);
    if (pubCode === 0) return { installed: true, packages };
    // Deliberately does not name a cause. The exit code says the command
    // failed, not why, and the two usual reasons — no Flutter SDK on PATH, and
    // the package not resolving — send the user to completely different places.
    return {
      installed: false,
      packages,
      note: `\`flutter pub add ${packages.join(" ")}\` failed. Run it yourself to see what pub reported.`,
    };
  }

  const { cmd, add } = pmInvocation(input.packageManager);
  // Pin the registry install to at least this CLI's own version, so neither a
  // stale dist-tag nor a package manager's release-age gate can leave a freshly
  // wired service on an older SDK. The tarball fallback below keeps bare names
  // (tarball URLs are resolved by name prefix).
  const cliVersion = input.cliVersion ?? readVersion();
  const specs = packages.map((pkg) => sdkInstallSpecForCli(pkg, cliVersion));
  // Specs carry a `>=` range. Spawning below is shell-free so the raw argv is
  // correct, but the echoed line is something people copy into a shell, where
  // an unquoted `>` would redirect stdout into a file. Quote it for display.
  const shown = specs.map((spec) => `'${spec}'`).join(" ");
  input.ui.out(
    `  ${color.dim("Installing SDK:")} ${color.brand(`${cmd} ${add} ${shown}`)}`,
  );
  const resolveVersion = input.resolvedVersionFn ?? resolvedSdkVersion;
  const code = run(cmd, [add, ...specs], input.cwd);
  const versionNote = (): string | undefined =>
    staleSdkNote(input.cwd, packages, cliVersion, cmd, add, resolveVersion);
  if (code === 0) {
    const note = versionNote();
    return { installed: true, packages, ...(note ? { note } : {}) };
  }

  // A nonzero exit is not the same as "not installed". pnpm 10+/11 exits 1 with
  // ERR_PNPM_IGNORED_BUILDS whenever ANY dependency in the tree has an
  // unapproved build script — esbuild, sharp and prisma between them cover a
  // large share of real repos — with the packages it was asked to add already
  // on disk. Trusting the code alone made the wizard announce "crumbtrail-node
  // is not installed", withhold the wiring, and send the user round a loop that
  // could not end: running the add command by hand succeeds-with-warning in
  // exactly the same way. Ask the disk instead.
  const onDisk = packages.map((pkg) => resolveVersion(input.cwd, pkg));
  if (onDisk.every((version) => version !== undefined)) {
    const stale = versionNote();
    const landed = packages.map((pkg, i) => `${pkg}@${onDisk[i]}`).join(", ");
    const plural = packages.length > 1 ? "are" : "is";
    return {
      installed: true,
      packages,
      note:
        `${cmd} exited nonzero but ${landed} ${plural} installed, so setup ` +
        `continued. The message ${cmd} printed above is about your project, ` +
        `not about Crumbtrail — pnpm exits nonzero for ignored build scripts ` +
        `(ERR_PNPM_IGNORED_BUILDS) even when the add succeeded.` +
        (stale ? ` ${stale}` : ""),
    };
  }

  // Registry install failed — fall back to the deploy's packed tarballs,
  // discovered by package-name prefix from the install manifest (react-native
  // and tauri included, now that pack-local packs them as optional channels).
  const tarballs = await discoverTarballUrls(
    input.base,
    packages,
    input.fetchImpl,
  );
  if (tarballs.length === packages.length) {
    input.ui.out(
      color.dim(
        `Registry unavailable — installing from ${input.base}/install tarballs…`,
      ),
    );
    const fallbackCode = run(cmd, [add, ...tarballs], input.cwd);
    if (fallbackCode === 0) {
      return {
        installed: true,
        packages,
        note: `Installed ${packages.join(", ")} from the deploy's install tarballs (registry unavailable).`,
      };
    }
    return {
      installed: false,
      packages,
      // No install script is pointed at here on purpose. The line this replaced
      // told people to pipe `<cloud>/install.sh` into a shell, and no
      // deployment has ever served that route, so the one instruction printed
      // at the moment the install failed was itself a 404.
      note: `SDK install via ${cmd} failed, and so did the ${input.base}/install tarball fallback. Run \`${cmd} ${add} ${shown}\` in this app yourself to see what ${cmd} reports, then run \`npx crumbtrail\` again.`,
    };
  }

  return {
    installed: false,
    packages,
    note: `SDK install via ${cmd} failed. Run \`${cmd} ${add} ${shown}\` in this app yourself to see what ${cmd} reports, then run \`npx crumbtrail\` again.`,
  };
}

// ── Wizard deps (injectable for tests) ───────────────────────────────────────

export interface WizardDeps {
  detect: (cwd: string) => DetectResult;
  ensureToken: typeof ensureToken;
  provisionFlow: typeof provisionFlow;
  createIngestKey: typeof createIngestKey;
  /** Filesystem + git boundary for the env key write (faked in tests). */
  envFileIO: EnvFileIO;
  installSdk: (input: InstallSdkInput) => Promise<InstallSdkResult>;
  buildPlan: typeof buildPlan;
  executePlan: typeof executePlan;
  pollForRealEvent: typeof pollForRealEvent;
  /** Batch path (monorepo root). */
  discoverServices: typeof discoverServices;
  resolveProject: typeof resolveProject;
  provisionService: typeof provisionService;
  setSessionReplay: typeof setSessionReplay;
  pollForServices: typeof pollForServices;
  /** Synthetic preflight for `verify` (stub in tests). */
  runPreflight: typeof runPreflight;
  /** Browser opener for the end-of-wizard dashboard hand-off (stub in tests). */
  openBrowserFn?: (url: string) => Promise<boolean>;
  /**
   * The saved login on this machine, which decides the endpoint prompt's
   * default. Injectable so a test does not answer from the developer's own
   * ~/.config/crumbtrail/auth.json.
   */
  loadStoredAuth?: typeof loadAuth;
  ui: Ui;
  prompter: Prompter;
  env: NodeJS.ProcessEnv;
  cwd: string;
  isTTY: boolean;
  fetchImpl?: typeof fetch;
}

export function defaultDeps(): WizardDeps {
  return {
    detect,
    ensureToken,
    provisionFlow,
    createIngestKey,
    envFileIO: defaultEnvFileIO,
    installSdk,
    buildPlan,
    executePlan,
    pollForRealEvent,
    discoverServices,
    resolveProject,
    provisionService,
    setSessionReplay,
    pollForServices,
    runPreflight,
    openBrowserFn: openBrowser,
    loadStoredAuth: loadAuth,
    ui: consoleUi,
    prompter: stdinPrompter,
    env: process.env,
    cwd: process.cwd(),
    isTTY: !!(process.stdout.isTTY && process.stdin.isTTY),
    fetchImpl: undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** name + dependencies of a package directory, for the import overlap check. */
function readPkgDeps(
  dir: string,
): { name?: string; dependencies?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      name?: string;
      dependencies?: unknown;
    };
  } catch {
    return null;
  }
}

function readPkgName(dir: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as { name?: string };
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

/** Filesystem probes for --workspace validation; injectable so the resolver is
 *  unit-testable without touching real directories. */
export interface WorkspaceIO {
  isDir: (p: string) => boolean;
  isFile: (p: string) => boolean;
}

const defaultWorkspaceIO: WorkspaceIO = {
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

/**
 * Resolve `--workspace <dir>` to an absolute package directory. The dir is taken
 * relative to the wizard's cwd, must exist, and must hold a package.json (the
 * workspace-package manifest) — otherwise detect() would run against nothing
 * useful, so we refuse with a concrete message rather than proceed. Pure aside
 * from the injected probes.
 */
export function resolveWorkspaceDir(
  baseCwd: string,
  workspace: string,
  io: WorkspaceIO = defaultWorkspaceIO,
): { dir: string } | { error: string } {
  const dir = path.resolve(baseCwd, workspace);
  if (!io.isDir(dir)) {
    return { error: `--workspace ${workspace}: no such directory (${dir}).` };
  }
  if (!io.isFile(path.join(dir, "package.json"))) {
    return {
      error: `--workspace ${workspace}: looked in ${dir}; no package.json. Point --workspace at a package directory.`,
    };
  }
  return { dir };
}

// ── Wizard ───────────────────────────────────────────────────────────────────

/**
 * The endpoint this run will send data to, confirmed out loud.
 *
 * A run that took the hosted default in silence looked identical to one the
 * user had chosen: the header printed the URL, nothing ever asked, and someone
 * setting up against a local stack only found out after the wizard had created
 * a project on the wrong deployment. So when nothing stated an endpoint —
 * no `--endpoint`, no CRUMBTRAIL_BASE_URL — the interactive run asks, with a
 * default pre-filled so Enter still means something sane.
 *
 * That default is the endpoint of a saved login when this machine has one. A
 * run that had just done `crumbtrail login --endpoint http://127.0.0.1:19890`
 * was offered the hosted cloud as the default, then printed "Using your saved
 * Crumbtrail login for http://127.0.0.1:19890" two lines later, so pressing
 * Enter wired the whole app to a deployment the run had no login for. The
 * login this machine actually holds is the honest default; the hosted cloud is
 * the default only when there is no login to speak for.
 * `--yes` and non-interactive shells take the same default without a prompt.
 */
export async function confirmEndpoint(
  parsed: ParsedArgs,
  deps: WizardDeps,
  base: string,
): Promise<string> {
  const stated =
    (parsed.endpoint && parsed.endpoint.trim()) ||
    (deps.env.CRUMBTRAIL_BASE_URL && deps.env.CRUMBTRAIL_BASE_URL.trim());
  if (stated) return base;
  const savedEndpoint = (deps.loadStoredAuth ?? loadAuth)(
    deps.env,
  )?.endpoint?.trim();
  const preferred = savedEndpoint
    ? resolveEndpoint(savedEndpoint, deps.env)
    : base;
  if (parsed.yes || !deps.isTTY) return preferred;
  const answer = await deps.prompter.ask(
    preferred === base
      ? "Which Crumbtrail endpoint should this project send to?"
      : `Which Crumbtrail endpoint should this project send to? You are logged in to ${preferred}.`,
    preferred,
  );
  return resolveEndpoint(answer, deps.env);
}

export async function runWizard(
  parsed: ParsedArgs,
  deps: WizardDeps,
): Promise<number> {
  const { ui } = deps;
  let base = resolveEndpoint(parsed.endpoint, deps.env);
  // Captured at wizard entry: the real-event poll only accepts sessions started
  // at/after this instant, so a stale session from a prior run can't be
  // mistaken for "your first event" (verify.ts wizardStart filter).
  const wizardStart = Date.now();

  for (const line of banner(readVersion(), TAGLINE)) ui.out(line);
  // Printed once, and only once the endpoint is settled: printing the default
  // first and the answer second showed two Endpoint lines to a run that was
  // never asked anything, and the first of them was not where the run went.
  base = await confirmEndpoint(parsed, deps, base);
  ui.out(color.dim(`  Endpoint  ${base}`));

  // 1. Detect. A monorepo root forks to the batch installer, which scans every
  // service and wires the ones the user picks. Everything below this fork is the
  // single-package path and is unchanged.
  //
  // --workspace narrows the target to one package dir first: pointing detect at
  // that dir means a package inside a monorepo classifies as itself (not as the
  // monorepo root), so the wizard wires exactly it instead of forking to the
  // batch scan.
  ui.out(step(1, TOTAL_STEPS, "Detect your framework"));
  let cwd = deps.cwd;
  if (parsed.workspace) {
    const resolved = resolveWorkspaceDir(deps.cwd, parsed.workspace);
    if ("error" in resolved) {
      ui.err(color.red(resolved.error));
      return 1;
    }
    cwd = resolved.dir;
    ui.out(
      color.dim(`Targeting workspace: ${path.relative(deps.cwd, cwd) || cwd}`),
    );
  }
  const result = deps.detect(cwd);
  if (result.isMonorepo) {
    return runBatchWizard(parsed, deps, { base, wizardStart, root: result });
  }

  // A repo root can hold several services without any workspace file linking
  // them — `admin/` next to `api/`, a root package.json with no framework deps.
  // --help promises the root run scans every service, and detection can already
  // name these, so they are wired from the root like real workspaces instead of
  // the user being sent to cd into each one and start over.
  if (!result.recipe && !parsed.workspace) {
    const siblings = deps.discoverServices(cwd, result, undefined, {
      endpoint: base,
      includeUnlinkedApps: true,
    });
    if (siblings.some((c) => c.selectable)) {
      return runBatchWizard(parsed, deps, {
        base,
        wizardStart,
        root: result,
        includeUnlinkedApps: true,
      });
    }
  }

  if (!result.recipe) {
    const isDeno = result.reasons.includes(DENO_UNSUPPORTED_REASON);
    if (isDeno) {
      ui.err(
        color.red(
          `No supported framework in ${result.cwd}. This directory looks like a Deno project, which Crumbtrail cannot wire yet.`,
        ),
      );
    } else {
      ui.err(color.red(`No supported framework in ${result.cwd}.`));
    }
    for (const r of result.reasons) ui.err(color.dim(`  · ${r}`));
    for (const n of result.notes) ui.err(color.dim(`  · ${n}`));
    if (!isDeno) {
      const nearby = findNearbyProjectDirs(
        result.cwd,
        localFsReader(result.cwd),
      );
      ui.err("");
      if (nearby.length > 0) {
        ui.err(
          "The app is probably in a subdirectory. Run the wizard from one of these:",
        );
        for (const rel of nearby) {
          ui.err(color.dim(`  cd ${rel} && npx crumbtrail`));
        }
      } else {
        ui.err("If this is a monorepo, run from the app package:");
        ui.err(color.dim("  cd apps/web && npx crumbtrail"));
        ui.err("If you ran this from the folder above the project:");
        ui.err(color.dim("  cd <project folder> && npx crumbtrail"));
      }
      ui.err(
        "Supported: Next.js, SvelteKit, Nuxt, Remix, Astro, Angular, Vite SPA, Create React App, NestJS, Express, Hono, Fastify, a Node server, or a non-JS backend that speaks OpenTelemetry (Django, Flask, FastAPI, Go, Rails, .NET).",
      );
      // No recipe is not the same as no route. Plain webpack, Vue CLI and
      // Electron all capture correctly once init runs; only the automatic
      // wiring is missing. Ending on the supported list alone read as
      // "your app is not supported", which for a React app also contradicts
      // what the site says.
      ui.err("");
      ui.err(
        "No recipe does not mean no capture. Any JavaScript app can be wired by hand in two steps:",
      );
      ui.err(color.dim("  1. npm install crumbtrail-core"));
      ui.err(
        color.dim(
          '  2. Crumbtrail.init({ key: "<your ctkey_ key>" }) as early as your app starts',
        ),
      );
      ui.err(
        color.dim(
          `     Mint the key, and copy the exact snippet for your setup, at ${appBaseFor(base, deps.env)}/setup`,
        ),
      );
    }
    return 1;
  }
  ui.out(ok(`Detected a ${color.bold(color.brand(result.recipe))} project.`));
  for (const n of result.notes) ui.out(note(n));

  // 2. Login (reuse a cached token when possible).
  ui.out(step(2, TOTAL_STEPS, "Sign in"));
  let token: string;
  try {
    token = await deps.ensureToken({
      base,
      ui,
      noBrowser: parsed.noBrowser,
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      allowInteractiveLogin: deps.isTTY,
    });
  } catch (err) {
    ui.err(color.red(`Login failed: ${errMessage(err)}`));
    return 1;
  }

  // Who this token belongs to. Memoized in auth.ts, so the line ensureToken
  // already printed and the wrong-account message below share one request.
  const identityLabel = describeIdentity(
    await fetchIdentity(base, token, deps.fetchImpl),
  );

  // 3. Provision project + service + key.
  ui.out(step(3, TOTAL_STEPS, "Create the project and service"));
  const pkgName = readPkgName(cwd);
  const defaultProjectName = inferProjectName(pkgName, path.basename(cwd));
  const defaultServiceName = inferServiceName(result.recipe);
  let provisioned: ProvisionResult;
  try {
    provisioned = await deps.provisionFlow({
      base,
      token,
      recipe: result.recipe,
      stack: result.otlpStack,
      ui,
      prompter: deps.prompter,
      assumeYes: parsed.yes,
      projectId: parsed.project,
      defaultProjectName,
      defaultServiceName,
      // Which repository this app is, so a project that already holds an
      // application of the same name from somewhere else is not reused blind.
      identity: serviceIdentity(cwd),
      identityLabel,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    if (err instanceof UpgradeRequiredError) {
      ui.err("");
      ui.err(color.yellow(err.message));
      if (err.upgradeUrl) ui.err(`  Upgrade: ${color.brand(err.upgradeUrl)}`);
      return 1;
    }
    ui.err(color.red(`Provisioning failed: ${errMessage(err)}`));
    return 1;
  }

  // 4. Build the injection plan BEFORE installing the SDK. buildPlan is
  // read-only, but its project-level idempotency check keys off whether
  // package.json already references crumbtrail-core/-node. If we let installSdk
  // add those deps first, buildPlan would see them and wrongly return
  // "skip-already-wired" — self-cancelling injection on a fresh setup. So the
  // plan is computed against the pre-install repo; only executePlan (below,
  // after install) mutates files, keeping injection the LAST repo-mutating step.
  const singleAppOrigins = resolveBackendOrigins(cwd, localFsReader(cwd));
  const plan = deps.buildPlan(
    {
      cwd,
      recipe: result.recipe,
      endpoint: base,
      entryFile: result.entryFile,
      nextVersion: result.nextVersion,
      stack: result.otlpStack ?? undefined,
      // The name we just provisioned (not the one we asked for — the cloud
      // de-dups). One key covers the whole project, so the injected init is the
      // only thing that says which app a session came from; without it the
      // wizard creates a named service and then wires code that reports under
      // no app at all.
      serviceName: provisioned.serviceName,
      // Correlation is off unless the emitted init names the origins this app
      // calls, so read them out of the app's own dev proxy and env config. A
      // single-package run knows of no sibling services, so that is the whole
      // source here; the batch path adds the backends it is wiring alongside.
      backendOrigins: singleAppOrigins,
      // Only the `static` recipe reads these: it emits a CDN module URL pinned
      // to this CLI's release, and a key literal that has to say where the real
      // value is minted.
      sdkVersion: readVersion(),
      mintUrl: appUrl(
        appBaseFor(base, deps.env),
        "/setup",
        provisioned.projectId,
      ),
      options: { force: parsed.yes },
    },
    defaultInjectIO,
  );

  // 5. Install the SDK (repo-mutating: adds deps to package.json).
  ui.out(step(4, TOTAL_STEPS, "Install the SDK"));
  // The dirty-file prompt governs the whole local setup transaction. Asking it
  // after installSdk used to leave package.json changed, and the later env-key
  // write still happened after a "No". Review every local write first so a
  // decline really means hands-off.
  const injectionDecision = await confirmInjection(plan, parsed, deps, {
    projectName: provisioned.projectName,
    serviceName: provisioned.serviceName,
  });
  const install: InstallSdkResult = injectionDecision.approved
    ? await deps.installSdk({
        cwd,
        packageManager: result.packageManager,
        recipe: result.recipe,
        base,
        ui,
        fetchImpl: deps.fetchImpl,
      })
    : { installed: false, packages: [] };
  if (install.installed) {
    ui.out(ok(`Installed ${color.bold(install.packages.join(", "))}.`));
    // An install can succeed and still be worth a word: a nonzero exit code the
    // wizard looked past, or a version older than this CLI. Printing it only on
    // failure hid both.
    if (install.note) ui.out(alert(color.yellow(install.note)));
  } else if (install.note) {
    ui.out(alert(color.yellow(install.note)));
  }

  // 6. Inject — the LAST repo-mutating step, applying the pre-computed plan via
  // CP3's executor. The install result still guards against imports for an SDK
  // that failed to install.
  ui.out(step(5, TOTAL_STEPS, "Wire it into your code"));
  const inject = await applyInjection(
    plan,
    parsed,
    deps,
    {
      installed: install.installed,
      packages: install.packages,
    },
    {
      dirtyDecision: injectionDecision.approved,
      warningsPrinted: true,
    },
  );

  // 7. The ingest key. Last of the repo-mutating steps and separate from the
  // injection apply on purpose: if this fails, the wiring above is still
  // correct and worth keeping, so it reports rather than rolling anything back.
  const sdkInstallFailed = !install.installed && install.packages.length > 0;
  const keyWrite =
    !sdkInstallFailed &&
    inject.outcome !== "withheld" &&
    inject.outcome !== "declined"
      ? await writeIngestKey({
          base,
          token,
          projectId: provisioned.projectId,
          projectName: provisioned.projectName,
          appDir: cwd,
          repoRoot: cwd,
          // A compile-time key (Flutter) has no env file to live in. Writing one
          // would mint a live credential into a file the app never reads, and every
          // line printed after it would report success for an app capturing nothing.
          varName: plan.keyIsCompileTime ? undefined : plan.keyEnvVar,
          identityLabel,
          parsed,
          deps,
        })
      : skippedKeyWrite(
          plan.keyEnvVar,
          inject.outcome === "declined"
            ? "No ingest key was minted because the local wiring changes were declined."
            : "No ingest key was minted because the SDK was not installed and the app was not wired.",
        );

  // 8. Next steps. With the key on disk the first-event wait is a real wait on
  // the app starting, rather than a wait on a manual step nobody was told to do.
  const notes: string[] = [];
  if (provisioned.adoptionNote) notes.push(provisioned.adoptionNote);
  if (install.note) notes.push(install.note);
  notes.push(...inject.notes);
  notes.push(
    ...correlationNotes(result.recipe, singleAppOrigins, 0, inject.outcome),
  );
  if (keyWrite.note) notes.push(keyWrite.note);

  const keyReady =
    keyWrite.status === "written" || keyWrite.status === "already-set";

  // Only once this app can actually report. Offering to record replays for a
  // run that wired nothing is a question about a feature the asker cannot yet
  // reach, and the setup that failed is the thing they need to hear about.
  if (keyReady) {
    notes.push(
      await offerSessionReplay({
        base,
        token,
        projectId: provisioned.projectId,
        parsed,
        deps,
        identityLabel,
      }),
    );
  }

  const setKeyHint = keyReady
    ? "Start your app"
    : plan.keyIsCompileTime
      ? `Rebuild with --dart-define=${plan.keyEnvVar}=<your-ingest-key>`
      : plan.keyEnvVar
        ? `Set ${plan.keyEnvVar} in your .env to your ingest key`
        : "Set your ingest key";

  // User-facing links point at the app host (the SPA), not the API host.
  const appBase = appBaseFor(base, deps.env);

  // Nothing was installed and nothing was wired, so no event can arrive. Waiting
  // for one would spend the user's time on a countdown with a foregone answer,
  // and end on "no event yet" as though they had done something wrong.
  const nothingWired = sdkInstallFailed || inject.outcome === "declined";
  const cloudEventUnavailable = result.recipe === "tauri";
  // Nothing reached the user's entry file: the plan fell back to a snippet
  // they were asked to paste, or they declined the prepend. The key is on
  // disk and the SDK is installed, so waiting is still right — they may paste
  // while it waits — but the wait is on them, not on their dev server.
  const awaitingManualWiring =
    inject.outcome === "guidance" || inject.outcome === "declined";

  let sessionUrl: string | undefined;
  // What this run can honestly say about capture. It starts as "no wait ran",
  // and only the poll finding an event is allowed to move it to confirmed.
  let capture: CaptureState = "unverified";
  if (parsed.skipVerify) {
    notes.push("Verification skipped (--skip-verify).");
  } else if (nothingWired) {
    notes.push(
      inject.outcome === "declined"
        ? "Nothing was changed, so there is no first event to wait for. Add the snippet above when you are ready, then run `npx crumbtrail` again."
        : "Nothing is wired yet, so there is no first event to wait for. Install the SDK, then run `npx crumbtrail` again.",
    );
  } else if (cloudEventUnavailable) {
    notes.push(
      "Tauri stores events locally through its Rust plugin; it does not send a cloud event for this wizard to wait for. Complete the Rust plugin and permission steps above, then inspect the local session store.",
    );
  } else {
    ui.out(step(6, TOTAL_STEPS, "Catch your first event"));
    ui.out(
      color.dim(
        keyReady
          ? awaitingManualWiring
            ? "Add the snippet above to your entry file, then start your dev server and load a page. This one stays here watching for the event."
            : "In another terminal, start your dev server (restart it if it is already running, so it reads the new key) and load a page in your browser. This one stays here watching for the event."
          : `${setKeyHint}. Mint one at ${appUrl(appBase, "/setup", provisioned.projectId)}, then start your app.`,
      ),
    );
    const keyProbe = await probeWrittenKey(base, keyWrite, deps);
    if (keyProbe && !keyProbe.ok) {
      notes.push(
        keyRejectionNote(
          {
            name: "",
            write: keyWrite,
            ...(keyWrite.file ? { where: rel(cwd, keyWrite.file) } : {}),
            mintUrl: appUrl(appBase, "/setup", provisioned.projectId),
          },
          keyProbe,
        ),
      );
      printEvidenceSourcesPointer(ui, base, provisioned.projectId);
      const incomplete = printSummary(
        ui,
        base,
        provisioned,
        inject.filesTouched,
        notes,
        plan.keyEnvVar,
        sessionUrl,
        keyWrite,
        cwd,
        plan.keyIsCompileTime,
        inject.outcome === "guidance" ||
          inject.outcome === "withheld" ||
          inject.outcome === "declined" ||
          // A page with no bundler carries its key as a literal, so nothing was
          // written and the run really does have one step left.
          plan.keyIsSourceLiteral === true,
        plan.keyIsSourceLiteral === true,
        // The endpoint refused the key on disk, so nothing this run wired can
        // report until that value is replaced. The bar and the exit code both
        // have to say so.
        { capture: "none", keyRejected: true },
      );
      return incomplete ? 1 : 0;
    }
    const poll = await pollWithSigint(
      base,
      token,
      provisioned.projectId,
      deps,
      wizardStart,
    );
    if (poll.outcome === "found") {
      // The emotional payoff: deep-link straight to the captured session
      // (spec §4), and open it in the browser when one is available.
      sessionUrl = poll.sessionId
        ? appUrl(
            appBase,
            `/sessions/${encodeURIComponent(poll.sessionId)}`,
            provisioned.projectId,
          )
        : appUrl(appBase, "/issues", provisioned.projectId);
      capture = "confirmed";
      ui.out(ok(color.bold("First real event received.")));
      ui.out(`  Watch it live: ${color.brand(sessionUrl)}`);
      if (canUseBrowser(parsed.noBrowser, deps.env)) {
        const open = deps.openBrowserFn ?? openBrowser;
        if (await open(sessionUrl)) {
          ui.out(color.dim("  Opened your dashboard in the browser."));
        }
      }
    } else if (poll.outcome === "cancelled") {
      // The wait was cut short by the reader, so the run learned nothing about
      // capture either way.
      capture = "unverified";
      notes.push(
        "Stopped waiting for the first event — load your app any time.",
      );
    } else {
      capture = "none";
      // Which step is still outstanding, rather than one sentence about the
      // dev server. Two outcomes reach this wait with nothing injected — a
      // fallback snippet the user was asked to paste, and a prepend they
      // declined — and telling those users to restart their app sends them
      // looking for a fault in a step they never completed.
      notes.push(
        !keyReady
          ? `No event yet — ${setKeyHint.toLowerCase()} and start your app.`
          : awaitingManualWiring
            ? "No event yet — the snippet above still has to go into your entry file. Paste it, then start your app."
            : keyWrite.status === "already-set"
              ? `No event yet — ${plan.keyEnvVar ?? "the ingest key"} was already set, and Crumbtrail left it alone. If that key was not minted in ${provisioned.projectName}, events are going wherever it points instead.`
              : "No event yet — start your app, or restart it if it was already running when the key was written, then load a page.",
      );
      notes.push(
        `Check the connection itself with \`npx crumbtrail verify\`: it resolves the host, opens TLS, and sends one authenticated test event, so it separates a problem here from a problem on your side.`,
      );
    }
    // Point the user at the next lever — pulling in the evidence sources they
    // already run. Pointer only, no prompt.
    printEvidenceSourcesPointer(ui, base, provisioned.projectId);
  }

  // 7. Summary.
  const incomplete = printSummary(
    ui,
    base,
    provisioned,
    inject.filesTouched,
    notes,
    plan.keyEnvVar,
    sessionUrl,
    keyWrite,
    cwd,
    plan.keyIsCompileTime,
    inject.outcome === "guidance" ||
      inject.outcome === "withheld" ||
      inject.outcome === "declined" ||
      plan.keyIsSourceLiteral === true,
    plan.keyIsSourceLiteral === true,
    { capture },
  );
  // The exit code follows the bar: a step still on the reader is a failure a
  // script can act on, and a wired app that has simply not been started yet is
  // not.
  return incomplete ? 1 : 0;
}

/**
 * A short, non-interactive pointer to the pluggable evidence sources (VISION.md
 * pillar 1). Crumbtrail's own SDK stands alone, but each ticket's bundle gets
 * more complete when it also folds in the tools a team already runs — the six
 * built-in adapters (crumbtrail-node descriptors, surfaced on the dashboard's
 * Settings › Evidence sources card). Copy is deliberately limited to adapters
 * that actually exist so it can't over-promise.
 */
/**
 * What this deployment has said its dashboard origin is: anything it reported
 * during this run first, then a saved login for the SAME endpoint.
 *
 * The token's source is deliberately not part of this. It used to be, by
 * accident: only the login path recorded an appBaseUrl, so a run authenticated
 * by CRUMBTRAIL_TOKEN fell through to the guess and finished by printing
 * `Dashboard: http://127.0.0.1:19890/...` — the API port — which 404s on every
 * split-origin deployment, local stacks included.
 */
function reportedAppBaseFor(
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const runReported = reportedAppBase(base);
  if (runReported) return runReported;
  const stored = loadAuth(env);
  return stored && stored.endpoint === base ? stored.appBaseUrl : undefined;
}

/**
 * The dashboard origin for `base`, preferring what the deployment reported.
 * Falls back to the hosted guess, which is right for the hosted default and a
 * guess everywhere else — see `dashboardGuessCaveat`.
 */
function appBaseFor(
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return dashboardBase(base, reportedAppBaseFor(base, env), env);
}

/**
 * One line when the dashboard link is a GUESS rather than something the
 * deployment reported, and the guess is the kind that 404s: a split-origin
 * self-host or local stack. Silence would leave the user clicking a dead link
 * with nothing naming the fix.
 */
function dashboardGuessCaveat(
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env[APP_URL_ENV_VAR]?.trim()) return undefined;
  if (reportedAppBaseFor(base, env)) return undefined;
  if (appBaseFor(base, env) !== base) return undefined;
  return (
    `${base} did not report a dashboard origin, so the links above assume it ` +
    `serves the dashboard itself. If they 404, set ${APP_URL_ENV_VAR} to your ` +
    `dashboard origin (locally that is usually port 19892) and run this again.`
  );
}

/**
 * A dashboard URL that lands where it says it lands.
 *
 * Every route naming a record lives under /p/:projectId. A bare
 * `/sessions/<id>` misses that and hits the dashboard's catch-all, which drops
 * the id and resolves the project from whatever that browser looked at last —
 * so the link printed on success opened some other project's session list, and
 * the "mint a key here" link opened some other project's key card, which is how
 * a valid key ends up capturing into the wrong project with nothing on either
 * side able to notice.
 */
function appUrl(appBase: string, path: string, projectId?: string): string {
  return projectId
    ? `${appBase}/p/${encodeURIComponent(projectId)}${path}`
    : `${appBase}${path}`;
}

function printEvidenceSourcesPointer(
  ui: Ui,
  base: string,
  projectId?: string,
): void {
  ui.out("");
  ui.out(`  ${rule(caps().width - 4)}`);
  ui.out(
    `  ${color.bold("Next")}  ${color.dim("make each ticket's evidence more complete")}`,
  );
  ui.out(
    color.dim(
      "  Crumbtrail's SDK stands alone, but it can also fold in evidence from tools",
    ),
  );
  ui.out(
    color.dim(
      "  you already run — Sentry, CloudWatch, Splunk, Datadog, PostHog, Cloudflare —",
    ),
  );
  ui.out(
    color.dim("  queried at incident time and added to each bug's bundle."),
  );
  ui.out(
    `  ${color.dim("Evidence sources:")}  ${color.brand(
      appUrl(appBaseFor(base), "/integrations", projectId),
    )}`,
  );
}

// ── Batch wizard (monorepo root) ─────────────────────────────────────────────

export type ServiceStatus =
  | "wired" // files written
  | "guidance" // OTLP guide written, or the AI-fallback snippet printed
  | "skipped-already-wired" // pre-existing wiring; no service minted
  | "withheld" // SDK install failed, so wiring was deliberately not applied
  | "declined" // target had uncommitted changes and the edit was declined
  | "failed"; // provision / plan / execute threw

export interface ServiceOutcome {
  name: string;
  relDir: string;
  recipe: Recipe;
  status: ServiceStatus;
  serviceId?: string;
  /** Env var the injected code reads its key from. */
  keyEnvVar?: string;
  /** That variable is supplied at build time, so it has no env file to go in. */
  keyIsCompileTime?: boolean;
  /** True when the service has a key available for the configured variable. */
  keyReady?: boolean;
  /**
   * The key this service carries was presented to the endpoint and refused.
   *
   * Separate from `keyReady`, which only says a value reached the env file. A
   * rejected key is a service that will not report a single event, so it must
   * not wear the same tick, or sit in the same "wired" count, as one that will.
   */
  keyRejected?: boolean;
  filesTouched: string[];
  notes: string[];
  error?: string;
  errorKind?: "project-access";
  sessionUrl?: string;
}

/** Human label for the stack column: the detected OTLP stack beats the recipe. */
function stackLabel(c: ServiceCandidate): string {
  if (c.recipe == null) return "—";
  if (c.recipe === "otlp") return c.detected.otlpStack ?? "otlp";
  return c.recipe;
}

/** The trailing hint that explains why a row is unchecked (or unselectable). */
function candidateHint(c: ServiceCandidate): string {
  const stack = stackLabel(c);
  if (c.flags.includes("no-recipe")) {
    const detail = c.detected.reasons[0];
    return detail
      ? `no supported framework (${detail})`
      : "no supported framework";
  }
  if (c.flags.includes("likely-library"))
    return `${stack} · shared library, select only if it runs as a service`;
  if (c.flags.includes("otlp"))
    return c.flags.includes("already-wired")
      ? `${stack} · guide exists, skipped`
      : `${stack} · guidance writes a setup file`;
  if (c.flags.includes("already-wired"))
    return `${stack} · complete for this endpoint, skipped`;
  if (c.flags.includes("ambiguous")) {
    // A wrapper refusal is not "entry unclear" — the entry was found and
    // rejected for a reason the reader can act on, and saying so is what stops
    // them from wiring the wrapper by hand afterwards.
    if (c.detected.reasons.some((r) => r.startsWith(PROCESS_WRAPPER_REASON))) {
      return `${stack} · starts through a shared process wrapper, so selecting shows the snippet for its real entry`;
    }
    return `${stack} · entry unclear, selecting shows the setup guidance`;
  }
  if (c.integration?.found && !c.integration.complete)
    return `${stack} · setup incomplete, selecting shows what is missing`;
  return `${stack} · selecting installs and wires it`;
}

/**
 * What the run did about frontend to backend correlation, in the service's own
 * notes. Silence here is what made this the longest lived gap in setup: the
 * emitted list is the only thing that turns the shared_request_id join on, and
 * a wizard that never mentions it leaves the user with two unrelated piles of
 * evidence and no reason to suspect a setting.
 */
export function correlationNotes(
  recipe: Recipe,
  origins: readonly string[],
  backendCount: number,
  outcome: ServiceStatus = "wired",
): string[] {
  if (isBackendRecipe(recipe)) return [];
  // The init these recipes write carries no networkCorrelationAllowedOrigins
  // field at all, so any note here describes a setting the reader cannot find
  // in their own code — and, worse, certifies a join that nothing performs.
  if (NO_CORRELATION_FIELD_RECIPES.has(recipe)) return [];
  // Nothing about correlation reached this repo. `withheld` touched no file,
  // and an already-complete service was not re-read for origins this run, so
  // whatever its init lists is not something this run may speak for.
  if (
    outcome === "withheld" ||
    outcome === "failed" ||
    outcome === "skipped-already-wired"
  )
    return [];
  // The init exists only in the terminal: injection fell back to a snippet, or
  // the edit was declined. The snippet DOES carry the computed origins, so the
  // honest tense is future — what pasting it will turn on, not what is on.
  const pending = outcome === "guidance" || outcome === "declined";
  const cors =
    "Each of those must allow x-crumbtrail-session-id, x-crumbtrail-request-id and traceparent in its CORS allowed headers, or the browser blocks the preflight.";
  if (origins.length > 0) {
    return [
      pending
        ? `The snippet above sets frontend to backend correlation for ${origins.join(", ")}; it is not enabled until you paste it in. ${cors} Calls to any other origin stay unjoined until you add it to networkCorrelationAllowedOrigins.`
        : `Frontend to backend correlation enabled for ${origins.join(", ")}. ${cors} Calls to any other origin stay unjoined until you add it to networkCorrelationAllowedOrigins.`,
    ];
  }
  if (backendCount > 0) {
    // Never say "add the origin" without saying what the origin must then
    // allow: the SDK starts stamping three headers on those calls, and a
    // backend whose CORS allowlist predates them blocks the app's own
    // requests at the preflight.
    const where = pending ? "the snippet above" : "the injected init";
    return [
      `No backend origin could be read from this app's config, so networkCorrelationAllowedOrigins is empty and its calls to the backend will not join the same session. Add the API origin to that list in ${where}, and add x-crumbtrail-session-id, x-crumbtrail-request-id and traceparent to that backend's CORS allowed headers at the same time, or the browser blocks the preflight.`,
    ];
  }
  return [];
}

/**
 * Recipes whose injected init has no `networkCorrelationAllowedOrigins` field.
 *
 * Tauri initialises with a `transportInstance` and nothing else; Flutter's Dart
 * init carries no origin list either. Emitting a correlation note for them told
 * the user a join was on, over a snippet that has no such setting anywhere in
 * it.
 */
const NO_CORRELATION_FIELD_RECIPES = new Set<Recipe>(["tauri", "flutter"]);

function toMultiSelectItems(candidates: ServiceCandidate[]): MultiSelectItem[] {
  return candidates.map((c) => ({
    label: c.relDir,
    hint: candidateHint(c),
    checked: c.defaultChecked,
    selectable: c.selectable,
  }));
}

/**
 * Why `--all` left a package alone, in the package's own terms.
 *
 * A library that gets wired is worse than one that is skipped: the app that
 * imports it runs the library's capture first, and every session from that
 * process is then filed under the library's name while the real service reports
 * nothing at all. So `--all` means every service, not every directory — and the
 * ones it passed over are named here rather than silently dropped.
 */
export function skippedByAllNote(c: ServiceCandidate): string {
  return `${c.relDir}: nothing runs this package (no start or dev script, no bin, no server or worker entry, no deploy manifest), so it reads as a library and was left unwired. Wire it with --only ${c.relDir} if it really does run as a service.`;
}

/**
 * Selected packages that one of the other selected packages imports.
 *
 * Two capture inits in one process is one capture: the first call wins and the
 * second is ignored, so every session from that process is filed under whichever
 * name loaded first. When a library and the app that imports it are both wired,
 * that name is the library's, and the app the user cares about reports nothing.
 * The wizard is the only thing in the room that can see both halves, so it says
 * so instead of leaving a silent misfiling to be discovered in the dashboard.
 */
export function importedSelectionWarnings(
  selected: readonly ServiceCandidate[],
  readPkg: (dir: string) => { name?: string; dependencies?: unknown } | null,
): string[] {
  const pkgs = selected.map((c) => ({ candidate: c, pkg: readPkg(c.dir) }));
  const out: string[] = [];
  for (const { candidate, pkg } of pkgs) {
    const name = pkg?.name;
    if (!name) continue;
    const importers = pkgs.filter(({ candidate: other, pkg: otherPkg }) => {
      if (other === candidate) return false;
      const deps = otherPkg?.dependencies;
      return !!deps && typeof deps === "object" && name in (deps as object);
    });
    if (importers.length === 0) continue;
    out.push(
      `${candidate.relDir} is imported by ${importers.map((i) => i.candidate.relDir).join(", ")}, and both were wired. Capture starts once per process, so whichever loads first names the session, and it will be ${candidate.relDir}. Wire the app and leave ${candidate.relDir} out unless it runs as its own process.`,
    );
  }
  return out;
}

/**
 * Resolve --only/--all into indices, or null when we should prompt.
 * Returns a string on a user error (unknown --only value).
 *
 * `--only` is explicit and always honoured; `--all` is a judgement call the user
 * delegated, so it declines the packages that look like libraries and reports
 * them in `skipped`.
 */
export function resolveSelection(
  parsed: ParsedArgs,
  candidates: ServiceCandidate[],
):
  | { indices: number[]; skipped?: ServiceCandidate[] }
  | { error: string }
  | null {
  if (parsed.only && parsed.only.length > 0) {
    const indices: number[] = [];
    for (const want of parsed.only) {
      const needle = want.toLowerCase();
      const i = candidates.findIndex(
        (c) =>
          c.name.toLowerCase() === needle || c.relDir.toLowerCase() === needle,
      );
      if (i < 0) {
        return {
          error: `--only ${want}: no such service. Found: ${candidates.map((c) => c.relDir).join(", ")}`,
        };
      }
      if (!candidates[i].selectable) {
        return {
          error: `--only ${want}: looked in ${candidates[i].dir}; no supported framework${candidates[i].detected.reasons.length ? ` (${candidates[i].detected.reasons.join("; ")})` : ""}. It cannot be wired.`,
        };
      }
      if (!indices.includes(i)) indices.push(i);
    }
    return { indices };
  }
  if (parsed.all) {
    const indices: number[] = [];
    const skipped: ServiceCandidate[] = [];
    candidates.forEach((c, i) => {
      if (!c.selectable) return;
      if (c.flags.includes("likely-library")) {
        skipped.push(c);
        return;
      }
      indices.push(i);
    });
    return { indices, skipped };
  }
  return null;
}

interface BatchContext {
  base: string;
  wizardStart: number;
  root: DetectResult;
  /** Root holds unlinked sibling services rather than declared workspaces. */
  includeUnlinkedApps?: boolean;
}

/**
 * The monorepo path: scan → pick → one login → one project → wire each selected
 * service → one shared wait → summary.
 *
 * A failure on one service never sinks the batch (each is try/caught and
 * recorded), because a half-wired repo with a clear report is strictly better
 * than an abort that leaves the user guessing which services made it.
 */
export async function runBatchWizard(
  parsed: ParsedArgs,
  deps: WizardDeps,
  ctx: BatchContext,
): Promise<number> {
  const { ui } = deps;
  const { base, wizardStart } = ctx;
  const root = deps.cwd;

  // 1. Scan.
  const candidates = deps.discoverServices(root, ctx.root, undefined, {
    endpoint: base,
    includeUnlinkedApps: ctx.includeUnlinkedApps,
  });
  const selectableCount = candidates.filter((c) => c.selectable).length;
  ui.out(
    ok(
      ctx.includeUnlinkedApps
        ? `Repo root — found ${color.bold(String(candidates.length))} service(s), ${color.bold(color.brand(String(selectableCount)))} wireable.`
        : `Monorepo — found ${color.bold(String(candidates.length))} package(s), ${color.bold(color.brand(String(selectableCount)))} wireable.`,
    ),
  );
  if (selectableCount === 0) {
    ui.err("");
    ui.err(color.red(`Nothing in ${root} can be wired.`));
    for (const c of candidates) {
      ui.err(note(`${c.relDir} — ${candidateHint(c)}`));
    }
    ui.err(
      "Supported: Next.js, SvelteKit, Nuxt, Remix, Astro, Angular, Vite SPA, Create React App, NestJS, Express, Hono, Fastify, a Node server, or a non-JS backend that speaks OpenTelemetry (Django, Flask, FastAPI, Go, Rails, .NET).",
    );
    return 1;
  }

  // 2. Select.
  const preset = resolveSelection(parsed, candidates);
  if (preset && "error" in preset) {
    ui.err(color.red(preset.error));
    return 1;
  }
  let indices: number[];
  if (preset) {
    indices = preset.indices;
    for (const c of preset.skipped ?? []) {
      ui.out(alert(color.yellow(skippedByAllNote(c))));
    }
  } else if (!deps.isTTY) {
    // No prompt available and no explicit selection: refuse rather than guess
    // which of someone's services should start reporting.
    ui.err("");
    ui.err(
      color.red(
        `${ctx.includeUnlinkedApps ? "Several services under" : "Monorepo at"} ${root}, but this shell is not interactive. Pass --only <service> (repeatable) or --all.`,
      ),
    );
    for (const c of candidates) {
      if (c.selectable) ui.err(note(c.relDir));
    }
    return 1;
  } else {
    ui.out("");
    indices = await deps.prompter.multiSelect(
      "Which services should Crumbtrail wire?",
      toMultiSelectItems(candidates),
    );
  }
  const selected = indices.map((i) => candidates[i]);
  // The backend halves of this run. A browser app whose init does not name them
  // stamps no correlation headers on its calls to them, so the frontend and
  // backend evidence for one click never joins — which is the whole point of
  // wiring both in a single pass.
  const backendSiblings = selected
    .filter((c) => isBackendRecipe(c.recipe))
    .map((c) => ({ dir: c.dir, detected: c.detected }));
  if (selected.length === 0) {
    // "Nothing selected" covers two opposite situations, and the reader cannot
    // tell them apart from the sentence: a rerun in a repository that is
    // already wired opens the list with every box unchecked, which reads as
    // "the CLI found nothing" when it means "there is nothing left to do".
    const wireable = candidates.filter((c) => c.selectable);
    const wired = wireable.filter((c) => c.flags.includes("already-wired"));
    if (wireable.length > 0 && wired.length === wireable.length) {
      ui.out(
        ok(
          `All ${wireable.length} application(s) here are already wired for ${base}. Nothing to do.`,
        ),
      );
      for (const c of wired) ui.out(note(`${c.relDir}: already wired`));
      // No project is resolved on this path (login has not run), so there is
      // no project scoped dashboard link to offer.
      return 0;
    }
    ui.out(
      alert(
        color.yellow(
          wired.length > 0
            ? `Nothing selected, so no changes were made. ${wired.length} of ${wireable.length} application(s) here are already wired for ${base}; the rest were left unchecked.`
            : "Nothing selected, so no changes were made. Run it again and check the applications you want wired.",
        ),
      ),
    );
    return 0;
  }
  for (const warning of importedSelectionWarnings(selected, readPkgDeps)) {
    ui.out(alert(color.yellow(warning)));
  }

  // 3. Login (once for the whole batch).
  let token: string;
  try {
    token = await deps.ensureToken({
      base,
      ui,
      noBrowser: parsed.noBrowser,
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      allowInteractiveLogin: deps.isTTY,
    });
  } catch (err) {
    ui.err(color.red(`Login failed: ${errMessage(err)}`));
    return 1;
  }
  const identityLabel = describeIdentity(
    await fetchIdentity(base, token, deps.fetchImpl),
  );

  // 4. Project (once — every service reports into the same project).
  const defaultProjectName = inferProjectName(
    readPkgName(root),
    path.basename(root),
  );
  let project;
  try {
    project = await deps.resolveProject({
      base,
      token,
      ui,
      prompter: deps.prompter,
      assumeYes: parsed.yes,
      projectId: parsed.project,
      defaultProjectName,
      identityLabel,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    if (err instanceof UpgradeRequiredError) {
      ui.err("");
      ui.err(color.yellow(err.message));
      if (err.upgradeUrl) ui.err(`  Upgrade: ${color.brand(err.upgradeUrl)}`);
      return 1;
    }
    ui.err(color.red(`Provisioning failed: ${errMessage(err)}`));
    return 1;
  }

  // Names are inferred, not prompted — asking N times is hostile — but two
  // frontends both inferring to "web" would be indistinguishable in the
  // dashboard, so de-collide before minting anything.
  const serviceNames = uniqueServiceNames(
    selected.map((c) => ({
      name: inferServiceName(c.recipe as Recipe, c.name),
      relDir: c.relDir,
    })),
  );

  // 5. Wire each service.
  const outcomes: ServiceOutcome[] = [];
  for (const [i, c] of selected.entries()) {
    const recipe = c.recipe as Recipe;
    const name = serviceNames[i];
    ui.out("");
    ui.out(
      `  ${color.brand(glyphs().pointer)} ${color.brand(`${i + 1}/${selected.length}`)}  ${color.bold(c.relDir)}${color.dim(` — ${stackLabel(c)}`)}`,
    );

    if (c.flags.includes("already-wired")) {
      // Don't mint a key for a service whose plan would self-cancel anyway.
      ui.out(ok("Complete for this endpoint. Leaving it untouched."));
      outcomes.push({
        name,
        relDir: c.relDir,
        recipe,
        status: "skipped-already-wired",
        filesTouched: [],
        notes: [],
      });
      continue;
    }

    // What this app declares for itself, plus the dev origins of the backends
    // being wired beside it. Empty for a backend (it is the thing being called)
    // and for a lone frontend whose repo names no backend origin anywhere.
    const backendOrigins = isBackendRecipe(recipe)
      ? []
      : resolveBackendOrigins(c.dir, localFsReader(c.dir), backendSiblings);

    try {
      const svc = await deps.provisionService({
        base,
        token,
        projectId: project.id,
        recipe,
        stack: c.detected.otlpStack,
        serviceName: name,
        identity: serviceIdentity(c.dir),
        ui,
        identityLabel,
        fetchImpl: deps.fetchImpl,
      });

      // buildPlan BEFORE installSdk — see the single-package path: the plan's
      // idempotency check keys off package.json referencing crumbtrail-core, so
      // installing first would self-cancel injection.
      const plan = deps.buildPlan(
        {
          cwd: c.dir,
          recipe,
          endpoint: base,
          entryFile: c.detected.entryFile,
          nextVersion: c.detected.nextVersion,
          stack: c.detected.otlpStack ?? undefined,
          // One key covers the whole project, so the injected code is what says
          // which app sent a session. Without this a repository of Express
          // services would arrive as five anonymous senders.
          //
          // The PROVISIONED name, never the raw package.json name: `@acme/web`
          // is provisioned as `web`, and the cloud may de-dup again. Injecting
          // the raw name files sessions under a label no service has, and the
          // verify below polls the provisioned service ids, so it would report
          // "No event yet" for every service while events were landing.
          serviceName: svc.serviceName,
          backendOrigins,
          sdkVersion: readVersion(),
          mintUrl: appUrl(appBaseFor(base, deps.env), "/setup", project.id),
          options: { force: parsed.yes },
        },
        defaultInjectIO,
      );

      // Ask about the complete local transaction before installing dependencies
      // or touching an env file. A decline of the entry-file edit must not
      // leave package.json or a live key behind.
      const injectionDecision = await confirmInjection(plan, parsed, deps, {
        projectName: project.name,
        serviceName: svc.serviceName,
      });
      const install: InstallSdkResult = injectionDecision.approved
        ? await deps.installSdk({
            cwd: c.dir,
            packageManager:
              c.detected.packageManager ?? ctx.root.packageManager,
            recipe,
            base,
            ui,
            fetchImpl: deps.fetchImpl,
          })
        : { installed: false, packages: [] };
      if (install.installed) {
        ui.out(ok(`Installed ${color.bold(install.packages.join(", "))}.`));
        if (install.note) ui.out(color.yellow(`! ${install.note}`));
      } else if (install.note) {
        ui.out(color.yellow(`! ${install.note}`));
      }

      const applied = await applyBatchInjection(plan, c, svc.serviceName, {
        parsed,
        deps,
        base,
        sdkInstall: {
          installed: install.installed,
          packages: install.packages,
        },
        dirtyDecision: injectionDecision.approved,
        warningsPrinted: true,
        mintUrl: appUrl(appBaseFor(base, deps.env), "/setup", project.id),
      });
      outcomes.push({
        name: svc.serviceName,
        relDir: c.relDir,
        recipe,
        status: applied.status,
        serviceId: svc.serviceId,
        keyEnvVar: plan.keyEnvVar,
        keyIsCompileTime: plan.keyIsCompileTime,
        filesTouched: applied.filesTouched,
        notes: [
          ...(install.note ? [install.note] : []),
          // Which application row this service was filed under, when reusing an
          // existing one could have been the wrong call.
          ...(svc.adoptionNote ? [svc.adoptionNote] : []),
          ...applied.notes,
          // The APPLIED status, not the plan's intent: a service whose wiring
          // fell back to a snippet must not be told its correlation is live.
          ...correlationNotes(
            recipe,
            backendOrigins,
            backendSiblings.length,
            applied.status,
          ),
        ],
      });
    } catch (err) {
      // executePlan throws (and rolls back), so this dir is byte-identical to
      // how we found it. Record and keep going.
      const message = errMessage(err);
      ui.err(color.red(`✗ ${c.relDir}: ${message}`));
      outcomes.push({
        name,
        relDir: c.relDir,
        recipe,
        status: "failed",
        filesTouched: [],
        notes: [],
        error: message,
        ...(err instanceof ProjectAccessError
          ? { errorKind: "project-access" as const }
          : {}),
      });
    }
  }

  const reporting = outcomes.filter(
    (o) => o.status === "wired" || o.status === "guidance",
  );
  const cloudReporting = reporting.filter((o) => o.recipe !== "tauri");
  const batchNotes: string[] = [];

  // 6. The ingest key: one for the project, written into every wired service's
  // env file. Runs before the shared wait, so that wait is now a wait on
  // services starting rather than on a manual step nobody was told to do.
  const keyWrites = await writeIngestKeys({
    base,
    token,
    projectId: project.id,
    projectName: project.name,
    identityLabel,
    repoRoot: root,
    targets: reporting.map((o) => ({
      label: o.name,
      appDir: path.resolve(root, o.relDir),
      varName: o.keyIsCompileTime ? undefined : o.keyEnvVar,
    })),
    parsed,
    deps,
  });
  for (const outcome of reporting) {
    const write = keyWrites.get(outcome.name);
    if (write?.note) outcome.notes.push(write.note);
    outcome.keyReady =
      write?.status === "written" || write?.status === "already-set";
  }
  // One question for the project, not one per service: replay is a project
  // setting, and asking it five times in a monorepo is five ways to say the
  // same yes. Skipped entirely when nothing reports to the cloud, because a
  // run with no reporting service has a more urgent thing to say.
  if (cloudReporting.some((o) => o.keyReady)) {
    batchNotes.push(
      await offerSessionReplay({
        base,
        token,
        projectId: project.id,
        parsed,
        deps,
        identityLabel,
      }),
    );
  }

  if (parsed.skipVerify) {
    // One note for the run, not one per service — the same line repeated N
    // times is noise, not information.
    batchNotes.push("Verification skipped (--skip-verify).");
  } else if (cloudReporting.length > 0) {
    // User-facing links point at the app host (the SPA), not the API host.
    const appBase = appBaseFor(base, deps.env);
    for (const o of reporting) {
      // Only the services whose key did NOT land still carry a manual step.
      // Telling someone to set a variable this run just wrote for them is how
      // they end up pasting a second key over a working one.
      if (o.keyEnvVar && !o.keyReady) {
        o.notes.push(
          o.keyIsCompileTime
            ? `Pass --dart-define=${o.keyEnvVar}=<your-ingest-key> to flutter run and flutter build (mint at ${appUrl(appBase, "/setup", project.id)}).`
            : `Set ${o.keyEnvVar} in this service's .env (mint at ${appUrl(appBase, "/setup", project.id)}).`,
        );
      }
    }

    // Probe each service's OWN key, one probe per distinct key value, and let
    // a rejection speak only for the services carrying that key.
    const keyProbes = await probeServiceKeys(
      cloudReporting.map((o) => ({
        name: o.name,
        write: keyWrites.get(o.name),
        where: keyWrites.get(o.name)?.file
          ? rel(root, keyWrites.get(o.name)!.file!)
          : undefined,
        mintUrl: appUrl(appBase, "/setup", project.id),
      })),
      (key) =>
        deps.runPreflight({
          endpoint: base,
          probe: { kind: "ingestKey", key },
          fetchImpl: deps.fetchImpl,
        }),
    );
    for (const o of cloudReporting) {
      const probe = keyProbes.get(o.name);
      if (probe && !probe.ok) {
        o.notes.push(probe.note);
        // Recorded on the outcome, not only in the notes block: the summary row
        // is where a reader decides whether a service is done, and a tick there
        // outranks a warning twenty lines below it.
        o.keyRejected = true;
      }
    }
    const waitable = cloudReporting.filter(
      (o) => keyProbes.get(o.name)?.ok !== false,
    );
    const byServiceId = new Map(
      waitable
        .filter((o) => o.serviceId)
        .map((o) => [o.serviceId as string, o]),
    );
    if (byServiceId.size === 0) {
      // Every service that could report has a key the cloud will not accept,
      // so there is nothing to wait for. Each already carries its own reason.
    } else {
      const poll = await pollServicesWithSigint(
        {
          base,
          token,
          projectId: project.id,
          ui,
          wizardStart,
          serviceIds: [...byServiceId.keys()],
          onFound: (serviceId, sessionId) => {
            const o = byServiceId.get(serviceId);
            if (!o) return;
            o.sessionUrl = appUrl(
              appBase,
              `/sessions/${encodeURIComponent(sessionId)}`,
              project.id,
            );
            ui.out(ok(`${color.bold(o.name)}: first event received.`));
          },
          fetchImpl: deps.fetchImpl,
        },
        deps,
      );
      if (poll.outcome !== "found") {
        // Stragglers are expected — the user hasn't started every service. This is
        // information, not a failure.
        for (const o of byServiceId.values()) {
          // A guidance service was never wired: its snippet is the outstanding
          // step, and in a monorepo that snippet scrolled off many services ago.
          if (!o.sessionUrl)
            o.notes.push(
              o.status === "guidance"
                ? "No event yet — this service was not wired for you. Add the snippet printed for it above, then start it."
                : "No event yet — start this service.",
            );
        }
      }
    }
  } else if (reporting.some((o) => o.recipe === "tauri")) {
    batchNotes.push(
      "Tauri stores events locally through its Rust plugin; it does not send a cloud event for this wizard to wait for. Complete the Rust plugin and permission steps above, then inspect the local session store.",
    );
  }
  if (
    !parsed.skipVerify &&
    cloudReporting.length > 0 &&
    reporting.some((o) => o.recipe === "tauri")
  ) {
    batchNotes.push(
      "Tauri stores events locally and was not included in the cloud first-event wait.",
    );
  }

  // Same onboarding pointer as the single-package path — once for the batch,
  // only when a verify actually ran (something is wired and reporting).
  if (!parsed.skipVerify && cloudReporting.length > 0) {
    printEvidenceSourcesPointer(ui, base, project.id);
  }

  const incomplete = printBatchSummary(
    ui,
    base,
    root,
    project.id,
    project.name,
    outcomes,
    batchNotes,
    !parsed.skipVerify,
  );

  // The exit code says the same thing the bar says. It used to report success
  // for a batch that had just printed "Setup incomplete. 1 of 2 applications
  // still need you", so a CI step that wires a repository passed while half of
  // it reported nothing. Partial is not success here: the services that were
  // not wired need a person, and a script is how that person finds out.
  return incomplete ? 1 : 0;
}

/** Apply one service's plan; OTLP writes a guide file instead of injecting. */
async function applyBatchInjection(
  plan: Plan,
  candidate: ServiceCandidate,
  serviceName: string,
  ctx: {
    parsed: ParsedArgs;
    deps: WizardDeps;
    base: string;
    sdkInstall?: SdkInstallState;
    dirtyDecision?: boolean;
    warningsPrinted?: boolean;
    /** Project scoped /setup URL, for the OTLP guide's key line. */
    mintUrl?: string;
  },
): Promise<{
  status: ServiceStatus;
  filesTouched: string[];
  notes: string[];
}> {
  const { parsed, deps, base } = ctx;

  if (plan.kind === "otlp-guidance") {
    // The one place the batch diverges from the single-package path: rather than
    // printing guidance that scrolls away behind nine other services, drop it in
    // the service's own directory where it'll still be there tomorrow.
    const body = renderOtlpGuide({
      stack: candidate.detected.otlpStack ?? RECIPE_REGISTRY.otlp.stack,
      serviceName,
      endpoint: base,
      snippet: plan.snippet ?? "",
      agentPrompt: plan.agentPrompt ?? "",
      // The snippet carries a placeholder, never a minted key, so the guide has
      // to say where the real one comes from.
      ...(ctx.mintUrl ? { mintUrl: ctx.mintUrl } : {}),
    });
    const res = deps.executePlan(otlpGuidePlan(candidate.dir, body));
    deps.ui.out(
      ok(
        `Speaks OpenTelemetry — no SDK needed. Wrote ${color.brand(res.written.join(", "))}.`,
      ),
    );
    return {
      status: "guidance",
      filesTouched: res.written,
      // The summary already prefixes each note with the service name.
      notes: ["add the OTLP exporter from the guide file to start reporting."],
    };
  }

  const applied = await applyInjection(plan, parsed, deps, ctx.sdkInstall, {
    dirtyDecision: ctx.dirtyDecision,
    warningsPrinted: ctx.warningsPrinted,
  });
  // Straight from what injection reported. Inferring the status from
  // `filesTouched.length` read a withheld install and a declined edit as
  // "already wired", so the summary told the user a service was set up when
  // nothing had been done to it.
  return {
    status: applied.outcome,
    filesTouched: applied.filesTouched,
    notes: applied.notes,
  };
}

export function printBatchSummary(
  ui: Ui,
  base: string,
  root: string,
  projectId: string,
  projectName: string,
  outcomes: ServiceOutcome[],
  batchNotes: string[] = [],
  /** False when no first-event wait ran (`--skip-verify`), so nothing was seen. */
  verified = true,
): boolean {
  const g = glyphs();
  const mark: Record<ServiceStatus, string> = {
    wired: chip(` ${g.tick} `, "success"),
    guidance: chip(` ${g.warn} `, "warn"),
    "skipped-already-wired": chip(` ${g.bullet} `, "muted"),
    // Nothing was wired in either case, and the user has something to do about
    // it — so neither reads as a quiet skip.
    withheld: chip(` ${g.cross} `, "warn"),
    declined: chip(` ${g.cross} `, "warn"),
    failed: chip(` ${g.cross} `, "danger"),
  };
  // A wired service whose key the endpoint refused reports nothing at all, so
  // it does not get the success tick — it reads like the other rows that still
  // need the user.
  const markFor = (o: ServiceOutcome) =>
    o.status === "wired" && o.keyRejected === true
      ? chip(` ${g.warn} `, "warn")
      : mark[o.status];
  const width = Math.max(...outcomes.map((o) => o.name.length), 4);
  // Absolute temp/monorepo paths make the summary unreadable; the user already
  // knows where their repo is.
  const rel = (p: string) => path.relative(root, p) || p;

  const ready = (o: ServiceOutcome) =>
    o.status === "skipped-already-wired" ||
    (o.status === "wired" && o.keyReady === true && o.keyRejected !== true);
  const readyCount = outcomes.filter(ready).length;
  const wiredCount = outcomes.filter(
    (o) =>
      o.status === "wired" && o.keyReady === true && o.keyRejected !== true,
  ).length;
  const needsKeyCount = outcomes.filter(
    (o) => o.status === "wired" && o.keyReady !== true,
  ).length;
  const rejectedKeyCount = outcomes.filter(
    (o) =>
      o.status === "wired" && o.keyReady === true && o.keyRejected === true,
  ).length;
  // What the run can say about capture, on the same rule as the single package
  // path: only services that could ever send a cloud event count, and only a
  // session URL recorded by the poll is evidence one arrived.
  const cloudReporting = outcomes.filter(
    (o) =>
      o.recipe !== "tauri" &&
      (o.status === "wired" || o.status === "guidance"),
  );
  const reported = cloudReporting.filter((o) => o.sessionUrl);
  const incomplete = readyCount !== outcomes.length;
  ui.out("");
  // The bar states the outcome only. The project name used to ride on the end
  // of this line, where a narrow terminal clipped it: a project called kartbug
  // was reported back as "kartbu".
  ui.out(
    incomplete
      ? outcomeBar(
          `${g.warn}  Setup incomplete. ${outcomes.length - readyCount} of ${outcomes.length} applications still need you`,
          "warn",
        )
      : !verified || cloudReporting.length === 0
        ? outcomeBar(`${g.warn}  Wiring complete. First event not verified.`, "warn")
        : reported.length === cloudReporting.length
          ? outcomeBar(`${g.tick}  Setup complete. First event received.`)
          : reported.length === 0
            ? outcomeBar(`${g.warn}  Wiring complete. No event captured yet.`, "warn")
            : outcomeBar(
                `${g.warn}  Wiring complete. ${reported.length} of ${cloudReporting.length} applications have reported an event.`,
                "warn",
              ),
  );
  ui.out("");
  ui.out(field("Project", color.bold(projectName)));
  for (const o of outcomes) {
    const detail =
      o.status === "failed"
        ? color.red(`failed: ${o.error}`)
        : o.status === "withheld"
          ? color.yellow("not wired. The SDK could not be installed")
          : o.status === "declined"
            ? color.yellow("not wired. You declined the edit")
            : o.status === "wired" && o.keyReady !== true
              ? color.yellow("needs ingest key")
              : o.status === "wired" && o.keyRejected === true
                ? // Adjacent to the row, not only in the notes block: this
                  // service is wired and still reports nothing.
                  color.yellow("wired, but its ingest key was rejected")
                : o.status === "guidance"
                  ? color.yellow("manual setup needed")
                  : o.status === "skipped-already-wired"
                    ? color.dim("complete for this endpoint · skipped")
                    : o.sessionUrl
                      ? color.brand(o.sessionUrl)
                      : o.filesTouched.length > 0
                        ? color.dim(o.filesTouched.map(rel).join(", "))
                        : "";
    ui.out(
      `  ${markFor(o)} ${o.name.padEnd(width)}  ${color.dim(o.relDir.padEnd(24))} ${detail}`,
    );
  }

  const count = (s: ServiceStatus) =>
    outcomes.filter((o) => o.status === s).length;
  const parts = [
    `${wiredCount} wired`,
    ...(needsKeyCount > 0 ? [`${needsKeyCount} need a key`] : []),
    // Its own bucket. Folding it into "wired" certified a service the endpoint
    // had just refused; folding it into "need a key" would be wrong too, since
    // the key is present — it is the wrong one.
    ...(rejectedKeyCount > 0 ? [`${rejectedKeyCount} key rejected`] : []),
    ...(count("guidance") > 0 ? [`${count("guidance")} guidance`] : []),
    ...(count("failed") > 0 ? [`${count("failed")} failed`] : []),
    // Counted apart from "skipped": nothing was wired and the user has a next
    // step, which a skip does not carry.
    ...(count("withheld") + count("declined") > 0
      ? [`${count("withheld") + count("declined")} not wired`]
      : []),
    ...(count("skipped-already-wired") > 0
      ? [`${count("skipped-already-wired")} skipped`]
      : []),
  ];
  ui.out("");
  ui.out(`  ${color.dim(parts.join(caps().unicode ? " · " : " | "))}`);
  ui.out(
    field(
      "Dashboard",
      color.brand(appUrl(appBaseFor(base), "/issues", projectId)),
    ),
  );

  const guessCaveat = dashboardGuessCaveat(base);
  const notes = [
    ...outcomes.flatMap((o) => o.notes.map((n) => `${o.name}: ${n}`)),
    ...batchNotes,
    ...(guessCaveat ? [guessCaveat] : []),
  ];
  const projectAccessFailure = outcomes.some(
    (o) => o.errorKind === "project-access",
  );
  const retryableFailure = outcomes.some(
    (o) =>
      (o.status === "failed" ||
        o.status === "withheld" ||
        o.status === "declined") &&
      o.errorKind !== "project-access",
  );
  if (projectAccessFailure) {
    notes.push(
      "Run `crumbtrail logout`, then `npx crumbtrail` again to sign in as the owner of this project.",
    );
  }
  if (retryableFailure) {
    notes.push("Run `crumbtrail` again to retry. Wired services are skipped.");
  }
  if (notes.length > 0) {
    ui.out("");
    for (const n of notes) ui.out(note(n));
  }
  ui.out("");
  return incomplete;
}

/**
 * What injection DID, stated rather than inferred.
 *
 * "No files touched" covers four different outcomes — already wired, wiring
 * withheld because the SDK install failed, an edit the user declined, and
 * printed guidance — and the batch summary used to read them all as "already
 * wired — skipped", telling the user a service was set up when nothing had
 * happened to it.
 */
type InjectionOutcome =
  "wired" | "skipped-already-wired" | "withheld" | "declined" | "guidance";

interface InjectionResult {
  outcome: InjectionOutcome;
  filesTouched: string[];
  notes: string[];
}

interface InjectionApplyOptions {
  /** Set before SDK install so a decline cannot leave package/env edits behind. */
  dirtyDecision?: boolean;
  /** The plan warnings were printed while asking for the decision. */
  warningsPrinted?: boolean;
}

/**
 * Ask for the one local-change decision before any repo-mutating step.
 *
 * The prompt deliberately names the whole transaction: entry file, dependency
 * manifests/lockfile, and env file/gitignore. A "No" therefore means all local
 * files stay byte-for-byte unchanged.
 *
 * It also names what is ALREADY in the dashboard. The project and the
 * application are created before this question is reached, because the plan
 * this prompt describes is built from the provisioned application name and the
 * project scoped mint URL, so provisioning cannot simply be moved after the
 * consent without building the plan twice against different names. Deleting
 * them on a No would be worse: the CLI would be issuing destructive calls
 * against a project it was merely pointed at, and a No is often "not in this
 * checkout", not "undo everything". So the remaining honest option, and the
 * smallest one, is to stop calling it a decision with no side effects and say
 * what already exists. The summary then prints the same two names with a
 * dashboard link.
 */
async function confirmInjection(
  plan: Plan,
  parsed: ParsedArgs,
  deps: WizardDeps,
  provisioned?: { projectName: string; serviceName: string },
): Promise<{ approved: boolean }> {
  for (const w of plan.warnings) deps.ui.out(color.dim(`  · ${w}`));
  if (plan.kind !== "needs-confirm-dirty") return { approved: true };
  if (RECIPE_REGISTRY[plan.recipe].sdkUnpublished) return { approved: true };
  if (parsed.yes) return { approved: true };

  const packages = sdkPackagesFor(plan.recipe);
  const writes = [
    plan.targetPath ? `edit ${plan.targetPath}` : null,
    packages.length > 0
      ? `install ${packages.join(", ")} (updates package manifests/lockfiles)`
      : null,
    plan.keyEnvVar && !plan.keyIsCompileTime
      ? `write ${plan.keyEnvVar} to the app env file and update .gitignore`
      : null,
    ...(plan.extraEdits ?? []).map((extra) => `edit ${extra.path}`),
  ].filter((item): item is string => item !== null);
  // Said before the question, so it cannot be missed in the tail of a long
  // prompt line.
  if (provisioned) {
    deps.ui.out(
      color.dim(
        `  Already created in your dashboard, whichever way you answer: project ${provisioned.projectName}, application ${provisioned.serviceName}. Answering No changes nothing locally and leaves those two in place.`,
      ),
    );
  }
  const approved = await deps.prompter.confirm(
    `${writes.join(", ")}. Continue? No leaves all local files unchanged.`,
    false,
  );
  return { approved };
}

/** What installSdk did just before injection, so failed installs can withhold wiring. */
interface SdkInstallState {
  installed: boolean;
  packages: string[];
}

// ── Ingest key ───────────────────────────────────────────────────────────────

export interface KeyWriteOutcome {
  status:
    | "written"
    | "already-set"
    | "refused-tracked"
    | "no-variable"
    | "skipped-flag"
    | "skipped-no-wiring"
    | "failed";
  /** The env file involved, when there is one. */
  file?: string;
  varName?: string;
  /** Extra line for the end-of-run summary's notes. */
  note?: string;
  /** In-memory only; lets the wizard probe the key without printing it. */
  probeKey?: string;
}

/**
 * The step that finishes the job: mint the project's ingest key and put it in
 * the app's env file.
 *
 * Sequenced deliberately. env-file.ts decides where the key would go and
 * whether that is safe BEFORE anything is minted, so the refusal paths
 * (`--no-write-key`, a git-tracked env file, a variable already pointed at a
 * key) cost no credential at all. Only a decision of "ready" reaches the
 * network. See env-file.ts for the rules the write itself follows.
 */
export interface KeyTarget {
  /** Names the service in batch output; empty on the single-package path. */
  label: string;
  /** The package being wired — where its env file lives. */
  appDir: string;
  varName: string | undefined;
}

/**
 * Write the project's ingest key into every target's env file, minting AT MOST
 * ONE key for the whole run.
 *
 * One key per project is the model (`POST /api/projects/:id/keys`), so a
 * monorepo of nine services shares one credential and nine env files receive
 * the same value. Minting per service would leave eight redundant live keys on
 * a plan that counts them, and would make revoking one a partial revocation.
 */
async function writeIngestKeys(args: {
  base: string;
  token: string;
  projectId: string;
  /** Named in the "left as it is" line, so a key from another project shows. */
  projectName: string;
  identityLabel: string;
  /** The git work tree this run is in, which owns the .gitignore. */
  repoRoot: string;
  targets: KeyTarget[];
  parsed: ParsedArgs;
  deps: WizardDeps;
}): Promise<Map<string, KeyWriteOutcome>> {
  const { ui } = args.deps;
  const results = new Map<string, KeyWriteOutcome>();
  const named = (label: string) => (label ? `${label}: ` : "");

  // 1. Decide everything first. No credential exists yet, so every refusal
  // below costs nothing and leaves nothing behind.
  const plans = new Map<string, EnvKeyPlan>();
  for (const target of args.targets) {
    if (!target.varName) {
      results.set(target.label, { status: "no-variable" });
      continue;
    }
    if (args.parsed.noWriteKey) {
      results.set(target.label, {
        status: "skipped-flag",
        varName: target.varName,
        note: `Key not written (--no-write-key). Set ${target.varName} yourself.`,
      });
      continue;
    }
    try {
      plans.set(
        target.label,
        planEnvKeyWrite({
          appDir: target.appDir,
          repoRoot: args.repoRoot,
          varName: target.varName,
          io: args.deps.envFileIO,
        }),
      );
    } catch (err) {
      results.set(target.label, {
        status: "failed",
        varName: target.varName,
        note: `Could not work out where to put the ingest key (${errMessage(err)}). Set ${target.varName} yourself.`,
      });
    }
  }

  // 2. Report the decisions that need no key.
  for (const [label, plan] of plans) {
    if (plan.kind === "already-set") {
      ui.out(
        ok(
          // Naming the project is the whole point. The value is never
          // inspected — an ingest key cannot be resolved to its project
          // without a read credential — so the one way a second project's key
          // becomes visible is saying which project this run wired.
          `${named(label)}${color.bold(plan.varName)} is already set in ${color.brand(rel(args.repoRoot, plan.file))} — left as it is. Events from this app go wherever that key points, which is only ${color.bold(args.projectName)} if it was minted there.`,
        ),
      );
      // The key in that file is live and the file is not excluded from git, so
      // it is one `git add` away from being published — by a run that wrote
      // nothing and would otherwise have said nothing. The entry is added here
      // for exactly the same reason it is added next to a key this run wrote.
      let ignoreNote: string | undefined;
      if (plan.ignore) {
        try {
          const applied = applyEnvEdits([plan.ignore], args.deps.envFileIO);
          if (applied.ignoreEntriesAdded.length > 0) {
            ui.out(
              color.dim(
                `  Added ${rel(args.repoRoot, plan.file)} to .gitignore — it holds a live key and git was not excluding it.`,
              ),
            );
          }
        } catch (err) {
          ignoreNote = `${rel(args.repoRoot, plan.file)} holds a live ingest key and is not in .gitignore, and Crumbtrail could not add it (${errMessage(err)}). Add it yourself before committing.`;
          ui.out(alert(color.yellow(ignoreNote)));
        }
      }
      results.set(label, {
        status: "already-set",
        file: plan.file,
        varName: plan.varName,
        ...(ignoreNote ? { note: ignoreNote } : {}),
        probeKey: readEnvVar(
          args.deps.envFileIO.readFile(plan.file) ?? "",
          plan.varName,
        ),
      });
    } else if (plan.kind === "refused-tracked") {
      // Adding it to .gitignore now would not untrack it, so the next commit
      // would publish the key. Nothing is minted and nothing is written.
      const where = rel(args.repoRoot, plan.file);
      ui.out(
        alert(
          `${named(label)}${color.brand(where)} is tracked by git, so Crumbtrail will not write a key into it.`,
        ),
      );
      results.set(label, {
        status: "refused-tracked",
        file: plan.file,
        varName: plan.varName,
        note: `${where} is committed to git, so no key was written there. Move it out of version control, or set ${plan.varName} from your own secret store.`,
      });
    } else if (plan.kind === "no-variable") {
      results.set(label, { status: "no-variable" });
    }
  }

  const ready = [...plans].filter(([, p]) => p.kind === "ready");
  if (ready.length === 0) return results;

  // 3. One key for the run.
  let key: { apiKey: string; keyId?: string };
  try {
    key = await args.deps.createIngestKey(
      args.base,
      args.token,
      args.projectId,
      args.deps.fetchImpl,
      args.identityLabel,
    );
  } catch (err) {
    for (const [label, plan] of ready) {
      results.set(label, {
        status: "failed",
        varName: plan.kind === "ready" ? plan.varName : undefined,
        note:
          err instanceof ProjectAccessError
            ? errMessage(err)
            : `Could not mint an ingest key (${errMessage(err)}). Mint one in the dashboard and set it yourself.`,
      });
    }
    return results;
  }

  // 4. Write. Each target applies all-or-nothing on its own, so one service's
  // unwritable env file does not undo the eight that worked.
  for (const [label, plan] of ready) {
    if (plan.kind !== "ready") continue;
    const where = rel(args.repoRoot, plan.file);
    try {
      const applied = applyEnvEdits(
        buildEnvKeyEdits(plan, key.apiKey),
        args.deps.envFileIO,
      );
      ui.out(
        ok(
          `${named(label)}wrote ${color.bold(plan.varName)} to ${color.brand(where)}${keyLabel(key)}.`,
        ),
      );
      // A dev server that was already running holds the old environment, so it
      // sends events with no key and gets a 401 for every one of them. Nothing
      // downstream can tell that apart from an app nobody has opened, which is
      // how "I set the key and nothing arrives" became the commonest question
      // about this wizard.
      ui.out(
        color.dim(
          `  Restart your dev server if it is running — it reads ${plan.varName} at startup.`,
        ),
      );
      // Reported from what the apply actually appended, never from the plan:
      // a plan can want an entry the file turns out to list already, and a
      // claim that .gitignore now covers this file has to be true.
      if (applied.ignoreEntriesAdded.length > 0) {
        // Saying this is not optional. A file that was about to be committed
        // silently is not any more, and someone who does not know that will go
        // looking for why their env file stopped showing up in `git status`.
        ui.out(
          color.dim(
            `  Added ${where} to .gitignore — it holds a live key now.`,
          ),
        );
      }
      results.set(label, {
        status: "written",
        file: plan.file,
        varName: plan.varName,
        probeKey: key.apiKey,
      });
    } catch (err) {
      // The key exists on the server but reached this file. Say so plainly: a
      // key minted and lost is worse than one never minted, because nothing on
      // the dashboard shows which run created it.
      results.set(label, {
        status: "failed",
        file: plan.file,
        varName: plan.varName,
        note: `Minted an ingest key but could not write it to ${where} (${errMessage(err)}). Set ${plan.varName} from the dashboard instead.`,
      });
    }
  }
  return results;
}

/** The single-package path's one target. */
async function writeIngestKey(args: {
  base: string;
  token: string;
  projectId: string;
  projectName: string;
  identityLabel: string;
  appDir: string;
  repoRoot: string;
  varName: string | undefined;
  parsed: ParsedArgs;
  deps: WizardDeps;
}): Promise<KeyWriteOutcome> {
  const results = await writeIngestKeys({
    ...args,
    targets: [{ label: "", appDir: args.appDir, varName: args.varName }],
  });
  return results.get("") ?? { status: "no-variable" };
}

/**
 * Ask once, at setup, whether this project should record session replay.
 *
 * Replay is the only capture setting whose absence is invisible from the
 * product: a session without a recording renders as an explanation, not as a
 * missing feature, so a team that never opened the settings page waits for a
 * player that was never going to arrive. Asking here puts the question in
 * front of the person who owns the project on the one run where they are
 * already answering questions about it.
 *
 * It is never assumed. Replay records what a customer's own end users see, so
 * an unattended run leaves it alone and says where the switch lives; only a
 * person at a TTY, or an explicit `--replay` / `--no-replay`, decides it.
 * A failure here is reported and never fatal: the app is wired either way, and
 * the setting is one click away in the dashboard.
 */
async function offerSessionReplay(args: {
  base: string;
  token: string;
  projectId: string;
  parsed: ParsedArgs;
  deps: WizardDeps;
  identityLabel: string;
}): Promise<string> {
  const { base, token, projectId, parsed, deps, identityLabel } = args;
  // A link a person clicks, so it points at the dashboard rather than the
  // ingest host the SDK talks to.
  const settingsUrl = appUrl(
    appBaseFor(base, deps.env),
    "/settings/capture",
    projectId,
  );

  const asked =
    parsed.replay ??
    (parsed.yes || !deps.isTTY
      ? undefined
      : await deps.prompter.confirm(
          "Record session replay for this project? It replays what your end users saw, and you can change it later in capture settings.",
          false,
        ));

  // Declining writes nothing. Replay is already off unless someone turned it
  // on, so the only thing a "no" could change is a project that already
  // records — and silently switching that off is not what a person answering a
  // question about this app meant. `--no-replay` is different: that is an
  // instruction about the project, so it is carried out.
  if (asked !== true && parsed.replay === undefined) {
    return `Session replay is off unless this project already records it. Change it in capture settings: ${settingsUrl}`;
  }

  const enabled = asked === true;
  try {
    await deps.setSessionReplay(
      base,
      token,
      projectId,
      enabled,
      deps.fetchImpl,
      identityLabel,
    );
  } catch (err) {
    return `Session replay was left unchanged: ${errMessage(err)}. Set it in capture settings: ${settingsUrl}`;
  }

  return enabled
    ? "Session replay is on. New sessions from this app will be watchable once it has sent one."
    : `Session replay is off. Turn it on in capture settings: ${settingsUrl}`;
}

function skippedKeyWrite(
  varName: string | undefined,
  note: string,
): KeyWriteOutcome {
  return {
    status: "skipped-no-wiring",
    ...(varName ? { varName } : {}),
    note,
  };
}

/**
 * Validate a key the wizard just placed before starting a long event wait.
 * The probe uses the same synthetic, non-persisting session as `crumbtrail
 * verify`, so a 401/404 or transport failure can be reported immediately.
 */
async function probeWrittenKey(
  base: string,
  keyWrite: KeyWriteOutcome,
  deps: WizardDeps,
): Promise<PreflightResult | undefined> {
  if (!keyWrite.probeKey) return undefined;
  return deps.runPreflight({
    endpoint: base,
    probe: { kind: "ingestKey", key: keyWrite.probeKey },
    fetchImpl: deps.fetchImpl,
  });
}

/** One service's key, as the run left it, for `probeServiceKeys`. */
export interface KeyProbeTarget {
  /** Service name, and the key of the returned map. */
  name: string;
  write: KeyWriteOutcome | undefined;
  /** Repo-relative env file holding the key, when there is one. */
  where?: string;
  /** Where a replacement key is minted, named in the stale-key note. */
  mintUrl?: string;
}

export interface KeyProbeVerdict {
  ok: true;
}
export interface KeyProbeRejection {
  ok: false;
  note: string;
}

/**
 * Probe the ingest key each service actually carries, one probe per DISTINCT
 * key, and attribute every verdict only to the services carrying that key.
 *
 * Both halves are the fix for the same defect. The wizard mints ONE key and
 * writes it into every service it wired, but a service whose env file already
 * held a key keeps that one untouched — and a leftover from an older install is
 * exactly the key that fails. Probing "the first key found across the run"
 * therefore tested a credential this run never wrote, and then broadcast that
 * one rejection to every service, so a single stale line in a single .env made
 * a nine service install report itself as nine broken services.
 *
 * Services with no key to probe are absent from the result: unknown is not a
 * rejection, and the event wait is what decides those.
 */
export async function probeServiceKeys(
  targets: KeyProbeTarget[],
  probe: (key: string) => Promise<PreflightResult>,
): Promise<Map<string, KeyProbeVerdict | KeyProbeRejection>> {
  const seen = new Map<string, PreflightResult>();
  const out = new Map<string, KeyProbeVerdict | KeyProbeRejection>();
  for (const target of targets) {
    const key = target.write?.probeKey;
    if (!key) continue;
    let result = seen.get(key);
    if (!result) {
      result = await probe(key);
      seen.set(key, result);
    }
    out.set(
      target.name,
      result.ok
        ? { ok: true }
        : { ok: false, note: keyRejectionNote(target, result) },
    );
  }
  return out;
}

/**
 * Say whose key was rejected. A key this run wrote failing is a broken install;
 * a key that was already in the file failing is a leftover pointing nowhere,
 * and the two need completely different sentences.
 */
function keyRejectionNote(
  target: KeyProbeTarget,
  result: PreflightResult,
): string {
  const reason = preflightFailureReason(result);
  if (target.write?.status !== "already-set") {
    return `First-event wait skipped — ${reason}.`;
  }
  const varName = target.write.varName ?? "the ingest key";
  const where = target.where ? ` in ${target.where}` : "";
  const mint = target.mintUrl
    ? ` Mint a replacement at ${target.mintUrl}.`
    : "";
  return `The ${varName} already set${where} was left as it was found, and Crumbtrail rejected it — ${reason}. This service will not report until that value is replaced.${mint}`;
}

function preflightFailureReason(result: PreflightResult): string {
  const failed = result.stages.find((stage) => stage.status === "fail");
  return failed?.reason ?? "the endpoint or ingest key could not be validated";
}

/**
 * Name the key that was just written, so it can be told apart from the others.
 *
 * Minting is additive on purpose — rotating would kill the key an already
 * deployed app is using — so every run leaves one more live key on the project,
 * and the dashboard's key list gives no clue which one is in this app's env
 * file. The id is what that list is keyed by, and the last characters are what
 * a reader can match against the file in front of them.
 */
function keyLabel(key: { apiKey: string }): string {
  // The tail, and only the tail: it is the half a reader can match, because it
  // is in the env file in front of them and in the dashboard's key list. The
  // id the API returns beside it is a database row id that neither of those
  // places prints, so it was an identifier the reader could not look up
  // anywhere, dressed as one they could.
  return color.dim(` (new key ending ${key.apiKey.slice(-6)})`);
}

/** A path as the reader would type it, falling back to absolute off-tree. */
function rel(from: string, target: string): string {
  const relative = path.relative(from, target);
  return relative && !relative.startsWith("..") ? relative : target;
}

/** Announce + apply the injection plan, handling dirty-confirm and AI fallback. */
async function applyInjection(
  plan: Plan,
  parsed: ParsedArgs,
  deps: WizardDeps,
  sdkInstall?: SdkInstallState,
  options: InjectionApplyOptions = {},
): Promise<InjectionResult> {
  const { ui } = deps;
  const filesTouched: string[] = [];
  const notes: string[] = [];
  if (!options.warningsPrinted) {
    for (const w of plan.warnings) ui.out(color.dim(`  · ${w}`));
  }

  // Files the plan touches BESIDES the entry — a second process this package
  // starts, or the Docker build arg the bundler needs. They are applied even on
  // the branches that leave the entry alone, because neither question is
  // answered by the entry already being wired or being too ambiguous to edit.
  const announceExtras = () => {
    for (const extra of plan.extraEdits ?? []) {
      ui.out(color.dim(`  · ${extra.label}`));
    }
  };

  if (plan.kind === "skip-already-wired") {
    announceExtras();
    const res = deps.executePlan(plan);
    filesTouched.push(...res.written);
    if (res.written.length > 0) {
      ui.out(
        ok(
          `Your entry file was already wired — wired ${res.written.join(", ")} beside it.`,
        ),
      );
      return { outcome: "wired", filesTouched, notes };
    }
    ui.out(ok("Complete for this endpoint. Leaving your code untouched."));
    return { outcome: "skipped-already-wired", filesTouched, notes };
  }

  // An import for a package that is not installed does not fail softly: it
  // fails the build. When the SDK could not be added, the honest outcome is an
  // untouched repo plus a note — not a wired app that no longer compiles and an
  // edit the user has to find and revert by hand. `otlp` is unaffected: it has
  // no SDK packages, so `installSdk` reports a skip rather than a failure.
  if (sdkInstall && !sdkInstall.installed && sdkInstall.packages.length > 0) {
    const pkgs = sdkInstall.packages.join(", ");
    ui.out(
      color.yellow(`Left your code untouched — ${pkgs} is not installed.`),
    );
    // The wiring is withheld, but the wiring is still the thing the user came
    // for. Returning here skipped the snippet and the agent prompt the
    // fallback-ai branch below prints, so the one run that most needed a
    // paste-this ending was the only run that never showed one.
    if (plan.snippet || plan.agentPrompt) {
      ui.out(
        color.dim(`Once ${pkgs} is installed, this is the wiring it needs:`),
      );
      if (plan.snippet) {
        ui.out(color.dim("Paste this into your entry file:"));
        ui.out(plan.snippet);
      }
      if (plan.agentPrompt) {
        ui.out(color.dim("\nOr hand this to your coding agent:"));
        ui.out(plan.agentPrompt);
      }
    }
    notes.push(
      `Skipped wiring ${plan.targetPath ?? "your entry file"}: install ${pkgs}, then run \`npx crumbtrail\` again.`,
    );
    return { outcome: "withheld", filesTouched, notes };
  }

  if (plan.kind === "fallback-ai") {
    announceExtras();
    const extras = deps.executePlan(plan);
    filesTouched.push(...extras.written);
    if (extras.written.length > 0) {
      ui.out(ok(`Wired ${extras.written.join(", ")}.`));
    }
    ui.out(color.yellow("Couldn't safely edit your entry file automatically."));
    if (plan.snippet) {
      ui.out(color.dim("Paste this into your entry file:"));
      ui.out(plan.snippet);
    }
    if (plan.agentPrompt) {
      ui.out(color.dim("\nOr hand this to your coding agent:"));
      ui.out(plan.agentPrompt);
    }
    notes.push("Injection fell back to a manual snippet / AI prompt.");
    return { outcome: "guidance", filesTouched, notes };
  }

  if (plan.kind === "otlp-guidance") {
    // Intentional path (not an apology): a non-JS backend that already speaks
    // OpenTelemetry. Print the OTLP setup guidance + agent prompt; touch nothing.
    ui.out(
      ok(
        "Detected a non-JS backend that already speaks OpenTelemetry — no SDK needed.",
      ),
    );
    ui.out(color.dim("Point your existing OTLP exporter at Crumbtrail:"));
    if (plan.snippet) ui.out(plan.snippet);
    if (plan.agentPrompt) {
      ui.out(color.dim("\nOr hand this to your coding agent:"));
      ui.out(plan.agentPrompt);
    }
    notes.push(
      "OTLP backend — printed OpenTelemetry setup guidance; no files were changed.",
    );
    return { outcome: "guidance", filesTouched, notes };
  }

  if (plan.kind === "needs-confirm-dirty") {
    const approved = Object.hasOwn(options, "dirtyDecision")
      ? options.dirtyDecision === true
      : parsed.yes
        ? true
        : await deps.prompter.confirm(
            `${plan.targetPath} has uncommitted changes — edit it and apply the complete local setup anyway?`,
            false,
          );
    if (!approved) {
      ui.out(
        color.yellow("Left your file untouched. Add this to the top yourself:"),
      );
      if (plan.content) ui.out(plan.content);
      notes.push(
        `Skipped editing ${plan.targetPath} (uncommitted changes) — paste the snippet above into it manually.`,
      );
      return { outcome: "declined", filesTouched, notes };
    }
    announceExtras();
    const res = deps.executePlan(plan, undefined, { confirmDirty: true });
    filesTouched.push(...res.written);
    ui.out(ok(describeWrites(res)));
    return { outcome: "wired", filesTouched, notes };
  }

  if (plan.kind === "amend-init") {
    announceExtras();
    ui.out(
      color.dim(
        `  Completing the Crumbtrail setup you already have in ${plan.targetPath}…`,
      ),
    );
    const res = deps.executePlan(plan);
    filesTouched.push(...res.written);
    ui.out(
      ok(
        `Added ${(plan.amendedFields ?? []).join(", ")} to the Crumbtrail init you already had in ${plan.targetPath}. Nothing else in that file changed.`,
      ),
    );
    return { outcome: "wired", filesTouched, notes };
  }

  // create / prepend
  announceExtras();
  if (plan.targetPath) {
    ui.out(
      color.dim(
        `  ${plan.kind === "create" ? "Creating" : "Editing"} ${plan.targetPath}…`,
      ),
    );
  }
  const res = deps.executePlan(plan);
  filesTouched.push(...res.written);
  ui.out(ok(describeWrites(res)));
  return { outcome: "wired", filesTouched, notes };
}

/** Name the files a write touched — "Wrote 2 file(s)." is nobody's payoff. */
function describeWrites(res: { written: string[]; message: string }): string {
  if (res.written.length === 0) return res.message;
  return `Crumbtrail wired in — wrote ${res.written.join(", ")}.`;
}

/** Poll for the first real event, aborting cleanly on Ctrl-C. */
async function pollWithSigint(
  base: string,
  token: string,
  projectId: string,
  deps: WizardDeps,
  wizardStart: number,
): Promise<PollRealEventResult> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    return await deps.pollForRealEvent({
      base,
      token,
      projectId,
      ui: deps.ui,
      wizardStart,
      signal: controller.signal,
      fetchImpl: deps.fetchImpl,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/** Same Ctrl-C contract as pollWithSigint, for the batch's one shared wait. */
async function pollServicesWithSigint(
  opts: Omit<Parameters<typeof pollForServices>[0], "signal">,
  deps: WizardDeps,
): Promise<PollServicesResult> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    return await deps.pollForServices({ ...opts, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * Whether this run saw the app report.
 *
 *   confirmed   the first event arrived while the wizard waited
 *   none        the wizard waited and nothing arrived
 *   unverified  no wait ran (`--skip-verify`, or a recipe that sends no cloud
 *               event), so the run has no evidence either way
 */
export type CaptureState = "confirmed" | "none" | "unverified";

/**
 * The verdict the summary bar prints, and the exit code that goes with it.
 *
 * "Setup complete" used to be decided by the ingest key alone, so a run that
 * printed "No event yet, start your app" three lines earlier still certified
 * itself as done. The README's promise is a confirmed first event, so the bar
 * now says which of the three things happened, and only a confirmed event is
 * allowed to be called complete.
 */
export function summaryVerdict(input: {
  stepsOutstanding: boolean;
  capture: CaptureState;
}): { line: string; tone: "success" | "warn"; incomplete: boolean } {
  const g = glyphs();
  if (input.stepsOutstanding) {
    return {
      line: `${g.warn}  Setup incomplete. One step remains.`,
      tone: "warn",
      incomplete: true,
    };
  }
  if (input.capture === "confirmed") {
    return {
      line: `${g.tick}  Setup complete. First event received.`,
      tone: "success",
      incomplete: false,
    };
  }
  // Wiring is done and the key is in place, so there is nothing left for the
  // reader to fix. What is missing is the proof, and saying so is the
  // difference between "we are done" and "we are done as far as we can see".
  return {
    line:
      input.capture === "none"
        ? `${g.warn}  Wiring complete. No event captured yet.`
        : `${g.warn}  Wiring complete. First event not verified.`,
    tone: "warn",
    incomplete: false,
  };
}

function printSummary(
  ui: Ui,
  base: string,
  p: ProvisionResult,
  filesTouched: string[],
  notes: string[],
  keyEnvVar?: string,
  sessionUrl?: string,
  keyWrite?: KeyWriteOutcome,
  repoRoot?: string,
  keyIsCompileTime?: boolean,
  setupIncomplete = false,
  /** The injected code holds the key as a literal placeholder (static pages). */
  keyIsSourceLiteral = false,
  opts: { capture?: CaptureState; keyRejected?: boolean } = {},
): boolean {
  // User-facing links point at the app host (the SPA), not the API host.
  const appBase = appBaseFor(base);
  // A key the wizard could not write is a step the user still has to do, and
  // this bar was printing "Setup complete" directly above the line asking them
  // to do it.
  const keyOutstanding =
    keyEnvVar !== undefined &&
    keyWrite?.status !== "written" &&
    keyWrite?.status !== "already-set";
  const verdict = summaryVerdict({
    // A key the endpoint refused is a step too: the value on disk has to be
    // replaced before anything reports.
    stepsOutstanding:
      keyOutstanding || setupIncomplete || opts.keyRejected === true,
    capture: opts.capture ?? "unverified",
  });
  ui.out("");
  ui.out(outcomeBar(verdict.line, verdict.tone));
  ui.out("");
  ui.out(field("Project", color.bold(p.projectName)));
  // "Application" is the dashboard's word for this object.
  ui.out(field("Application", color.bold(p.serviceName)));
  // A page with no bundler has no variable to name, so the "Ingest key" line
  // points at the file instead. Printing nothing here is what let a run finish
  // silently with a placeholder where the credential goes.
  if (!keyEnvVar && keyIsSourceLiteral) {
    ui.out(
      field(
        "Ingest key",
        `replace ${color.bold("<your-ingest-key>")} in the page ${color.dim(`(mint at ${appUrl(appBase, "/setup", p.projectId)})`)}`,
      ),
    );
  }
  if (keyEnvVar) {
    // The one line that used to say the setup was not finished. It now reports
    // what happened to the key rather than handing the job back by default.
    const where =
      keyWrite?.file && repoRoot ? rel(repoRoot, keyWrite.file) : ".env";
    if (keyWrite?.status === "written") {
      ui.out(
        field(
          "Ingest key",
          `wrote ${color.bold(keyEnvVar)} to ${color.brand(where)}`,
        ),
      );
    } else if (keyWrite?.status === "already-set") {
      ui.out(
        field(
          "Ingest key",
          `${color.bold(keyEnvVar)} was already set in ${color.brand(where)}`,
        ),
      );
    } else if (keyIsCompileTime) {
      // Dart bakes the value in at build time, so there is no file to point at.
      ui.out(
        field(
          "Ingest key",
          `build with ${color.bold(`--dart-define=${keyEnvVar}=<your-ingest-key>`)} ${color.dim(`(mint at ${appUrl(appBase, "/setup", p.projectId)})`)}`,
        ),
      );
    } else {
      ui.out(
        field(
          "Ingest key",
          `set ${color.bold(keyEnvVar)} in .env ${color.dim(`(mint at ${appUrl(appBase, "/setup", p.projectId)})`)}`,
        ),
      );
    }
  }
  if (filesTouched.length > 0) {
    ui.out(field("Files", filesTouched.join(`\n${" ".repeat(14)}`)));
  }
  if (sessionUrl) {
    ui.out(field("Session", color.brand(sessionUrl)));
  }
  ui.out(
    field("Dashboard", color.brand(appUrl(appBase, "/issues", p.projectId))),
  );
  const caveat = dashboardGuessCaveat(base);
  const allNotes = caveat ? [...notes, caveat] : notes;
  if (allNotes.length > 0) {
    ui.out("");
    for (const n of allNotes) ui.out(note(n));
  }
  ui.out("");
  // The caller turns this into the exit code, so a script reads the same
  // verdict the person at the terminal just read.
  return verdict.incomplete;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── login / logout subcommands ───────────────────────────────────────────────

async function runLogin(parsed: ParsedArgs, deps: WizardDeps): Promise<number> {
  const base = resolveEndpoint(parsed.endpoint, deps.env);
  try {
    await deps.ensureToken({
      base,
      ui: deps.ui,
      noBrowser: parsed.noBrowser,
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      allowInteractiveLogin: deps.isTTY,
    });
    return 0;
  } catch (err) {
    deps.ui.err(color.red(`Login failed: ${errMessage(err)}`));
    return 1;
  }
}

/**
 * Print the cached CLI token so it can be pasted into CI as CRUMBTRAIL_TOKEN.
 *
 * This is the ONLY way to get a credential the CLI accepts non-interactively.
 * The dashboard mints ingest keys and agent tokens; neither authenticates the
 * CLI, and the wizard used to send CI users to look for a "CLI token" there
 * that does not exist. The value goes to stdout alone (everything else goes to
 * stderr) so `crumbtrail token` can be piped straight into a secret store.
 */
function runPrintToken(parsed: ParsedArgs, deps: WizardDeps): number {
  const base = resolveEndpoint(parsed.endpoint, deps.env);
  const stored = loadAuth(deps.env);
  if (!stored || !stored.token || stored.endpoint !== base) {
    deps.ui.err(
      color.red(
        `No saved login for ${base}. Run \`crumbtrail login\` first (add --endpoint <url> for a self-hosted deployment).`,
      ),
    );
    return 1;
  }
  deps.ui.err(
    color.dim(
      `CLI token for ${base}${stored.expiresAt ? `, valid until ${stored.expiresAt}` : ""}. Set it as CRUMBTRAIL_TOKEN in CI.`,
    ),
  );
  deps.ui.out(stored.token);
  return 0;
}

function runLogout(deps: WizardDeps): number {
  const cleared = clearStoredAuth(deps.env);
  deps.ui.out(cleared ? "Logged out." : "No saved login to clear.");
  return 0;
}

// ── verify subcommand (synthetic preflight) ──────────────────────────────────

/**
 * Pick the credential the preflight auth stage probes with. An explicit --key
 * (or $CRUMBTRAIL_KEY) is the primary CI path — it exercises the SDK's ingest
 * path. Absent a key we fall back to the cached login token, but only if it was
 * minted for THIS endpoint (a token is only reused for its base). Nothing → the
 * auth stage reports a clear "no credential" failure.
 */
export function resolveAuthProbe(
  base: string,
  key: string | undefined,
  projectId: string | undefined,
  env: NodeJS.ProcessEnv,
): AuthProbe {
  const explicit =
    (key && key.trim()) || (env.CRUMBTRAIL_KEY && env.CRUMBTRAIL_KEY.trim());
  if (explicit) return { kind: "ingestKey", key: explicit };
  const stored = loadAuth(env);
  if (stored && stored.token && stored.endpoint === base) {
    return { kind: "bearer", token: stored.token, projectId };
  }
  return { kind: "none" };
}

// Built per call, not as a module constant: a constant would freeze the colour
// depth at import time, before the terminal has been probed.
function stageGlyph(status: StageResult["status"]): string {
  const g = glyphs();
  if (status === "pass") return chip(` ${g.tick} `, "success");
  if (status === "fail") return chip(` ${g.cross} `, "danger");
  return chip(` ${caps().unicode ? "○" : "-"} `, "muted");
}

const STAGE_LABEL: Record<StageResult["stage"], string> = {
  dns: "DNS ",
  tls: "TLS ",
  auth: "Auth",
};

function renderPreflight(result: PreflightResult, ui: Ui): void {
  ui.out("");
  ui.out(
    `  ${chip(" PREFLIGHT ", "brandDeep")}  ${color.bold(result.endpoint)}`,
  );
  ui.out("");
  for (const s of result.stages) {
    const ms = s.status === "skipped" ? "" : color.dim(`(${s.ms}ms)`);
    ui.out(
      `  ${stageGlyph(s.status)} ${STAGE_LABEL[s.stage]}  ${s.reason} ${ms}`.trimEnd(),
    );
  }
  ui.out("");
  ui.out(
    result.ok
      ? headline(
          "PASS",
          "endpoint and key are reachable and authenticated",
          "success",
        )
      : headline(
          "FAIL",
          "fix the failing stage above before deploying",
          "danger",
        ),
  );
}

async function runVerify(
  parsed: ParsedArgs,
  deps: WizardDeps,
): Promise<number> {
  const base = resolveEndpoint(parsed.endpoint, deps.env);
  const probe = resolveAuthProbe(base, parsed.key, parsed.project, deps.env);
  const result = await deps.runPreflight({
    endpoint: base,
    probe,
    fetchImpl: deps.fetchImpl,
  });
  if (parsed.json) {
    deps.ui.out(JSON.stringify(toJson(result)));
  } else {
    renderPreflight(result, deps.ui);
  }
  return exitCodeFor(result);
}

// ── Entry ────────────────────────────────────────────────────────────────────

/** The floor the package's `engines` field declares. */
const MIN_NODE = [22, 15, 0] as const;

/**
 * npm treats an unmet `engines` range as a warning unless the user has set
 * `engine-strict=true`, so the README's promise that an old Node stops the
 * install before anything runs was not true for most people. On Node 20 the
 * wizard started, edited files, and failed somewhere in the middle. This is
 * the check that makes the promise true, and it says the version it found.
 */
function nodeTooOld(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  for (const [index, floor] of MIN_NODE.entries()) {
    const part = parts[index];
    if (!Number.isFinite(part)) return false;
    if ((part as number) !== floor) return (part as number) < floor;
  }
  return false;
}

/**
 * Words people type expecting a setup subcommand. The wizard is the bare
 * command, so each of these has exactly one answer, and it is one line long.
 */
const WIZARD_ALIASES = new Set([
  "setup",
  "init",
  "install",
  "start",
  "wizard",
  "configure",
  "config",
  "onboard",
  "add",
  "connect",
]);

export function wizardAliasHint(arg: string): string | undefined {
  const word = arg.trim().replace(/^-+/, "").toLowerCase();
  if (!WIZARD_ALIASES.has(word)) return undefined;
  return (
    `There is no \`${word}\` subcommand — the setup wizard is just ` +
    `\`crumbtrail\`, run inside the app you want to wire up. ` +
    `Run it with no arguments (\`npx crumbtrail\`).`
  );
}

export async function runCli(
  argv: string[],
  deps: WizardDeps = defaultDeps(),
  nodeVersion: string = process.version,
): Promise<number> {
  const parsed = parseArgs(argv);

  // Before anything reads the repo or writes to it.
  if (parsed.command !== "version" && nodeTooOld(nodeVersion)) {
    deps.ui.err(
      `Crumbtrail needs Node ${MIN_NODE.join(".")} or newer. This is Node ${nodeVersion.replace(/^v/, "")}.`,
    );
    deps.ui.err(
      "Upgrade Node, then run `npx crumbtrail` again. Nothing has been changed in this repo.",
    );
    return 1;
  }

  if (parsed.command === "version") {
    deps.ui.out(readVersion());
    return 0;
  }
  if (parsed.command === "help") {
    deps.ui.out(usage());
    return 0;
  }
  if (parsed.parseError) {
    // `--project --yes` used to set the project id to the literal "--yes" and
    // carry on, and `--only` with nothing after it threw a TypeError out of the
    // parser. Both are typos, and a typo deserves the usage text, not a wrong
    // project or an internal stack trace.
    deps.ui.err(`${parsed.parseError}\n`);
    deps.ui.err(usage());
    return 1;
  }
  if (parsed.unknown) {
    // A word someone reasonably expected to be a subcommand is not an unknown
    // argument to them — it is the command they came to run. `crumbtrail setup`
    // answering "Unknown argument: setup" plus thirty lines of help reads as a
    // broken install, when the only thing wrong is that the wizard has no
    // subcommand: it IS the bare command.
    const hint = wizardAliasHint(parsed.unknown);
    if (hint) {
      deps.ui.err(hint);
      deps.ui.err(color.dim("Run `crumbtrail --help` for everything else."));
      return 1;
    }
    deps.ui.err(`Unknown argument: ${parsed.unknown}\n`);
    deps.ui.err(usage());
    return 1;
  }
  if (parsed.command === "login") return runLogin(parsed, deps);
  if (parsed.command === "logout") return runLogout(deps);
  if (parsed.command === "token") return runPrintToken(parsed, deps);
  // `verify` is non-interactive by design (no prompts, no browser) so it runs
  // before the TTY guard — pointing it at prod from CI is the whole point.
  if (parsed.command === "verify") return runVerify(parsed, deps);

  // Non-TTY guard — BEFORE any prompt. CI must pass --yes AND --project.
  if (!deps.isTTY && !(parsed.yes && parsed.project)) {
    // Naming --project alone read as a circle: the wizard is what creates the
    // project, so a first-time user has no id to pass and no way to get one
    // from this message. Say where an id comes from, and that a first run
    // belongs in a real terminal.
    // Name only what is actually missing. Listing both flags unconditionally
    // told a reader who had just passed --project to pass --project, which
    // reads as the flag having been rejected rather than accepted.
    const missing = [
      parsed.yes ? null : "--yes",
      parsed.project ? null : "--project <id>",
    ].filter(Boolean);
    deps.ui.err(
      color.red(
        `Non-interactive shell detected. Pass ${missing.join(" and ")} to run without prompts.`,
      ),
    );
    deps.ui.err(
      color.dim(
        "Setting up for the first time? Run `npx crumbtrail` in an interactive terminal — it creates the project for you. In CI, take the id from an existing project's dashboard URL and set CRUMBTRAIL_TOKEN as well.",
      ),
    );
    deps.ui.err("");
    deps.ui.err(usage());
    return 1;
  }

  return runWizard(parsed, deps);
}

// Auto-run only when invoked directly as the bin (not when imported in tests).
// npm installs POSIX bins as a symlink NAMED AFTER THE BIN KEY (`crumbtrail`, not
// `cli.cjs`) and Node does not realpath process.argv[1], so the check must match
// the bin name too — mirrors packages/node/src/cli.ts's isCliEntrypoint.
export function isCliEntrypoint(argv1: string | undefined): boolean {
  if (!argv1) return false;
  return ["cli.ts", "cli.js", "cli.cjs", "cli.mjs", "crumbtrail"].includes(
    path.basename(argv1),
  );
}

if (isCliEntrypoint(process.argv[1])) {
  runCli(process.argv)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`crumbtrail: ${errMessage(err)}\n`);
      process.exit(1);
    });
}
