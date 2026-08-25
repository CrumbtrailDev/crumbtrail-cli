// Discovery of the backend entry files a project runs BESIDES the one detection
// picked. Read-only: it resolves paths and never writes.
//
// Detection resolves a single entry, which is the process that serves HTTP. A
// real deployment usually runs more than one process from the same package —
// a queue consumer, a scheduler, a batch worker — and those are where the
// failures that matter most happen, unattended and with nobody watching. Wiring
// only the HTTP entry leaves them reporting nothing at all, and the wizard
// reports success anyway.
//
// package.json `scripts` is the evidence used, rather than a guess at
// conventional filenames: a script is the project itself stating that this file
// is a process it starts.

import path from "node:path";
import { isBuildOutputPath } from "../detect";
import type { InjectIO } from "./io";

/** A second process this package starts, and the service name it should report under. */
export interface ExtraEntry {
  /** Absolute path of the entry file. */
  path: string;
  /** Appended to the app's service name, e.g. `marginary` -> `marginary-worker`. */
  serviceSuffix: string;
  /** The package.json script that named it, for the wizard's summary line. */
  script: string;
}

/**
 * Wiring every match in a large package would turn one confirmation into
 * twenty. Anything past this is reported rather than written — see the
 * `truncated` count on the result.
 */
export const MAX_EXTRA_ENTRIES = 4;

const RUNNABLE_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
]);

/**
 * Scripts that never start a long-lived process. A `.ts` path inside one of
 * these is a config or a codemod, not a service — wiring capture into it would
 * open an ingest session for the duration of a lint run.
 */
const NON_RUNTIME_SCRIPT_PREFIXES = [
  "build",
  "bundle",
  "clean",
  "compile",
  "coverage",
  "format",
  "lint",
  "postinstall",
  "prepare",
  "prepublish",
  "release",
  "test",
  "typecheck",
  "types",
];

/** `foo.config.ts`, `foo.test.ts`, `foo.spec.ts` and friends are never services. */
const NON_RUNTIME_FILE = /\.(config|test|spec|d)\.[cm]?[jt]s$/i;

function isNonRuntimeScript(name: string): boolean {
  const normalized = name.toLowerCase();
  return NON_RUNTIME_SCRIPT_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}:`),
  );
}

/**
 * The service name suffix for an entry. A file named for its job (`worker.ts`)
 * names itself; a generic `index`/`main`/`server` takes the directory it sits
 * in, because a project with `queue/index.ts` and `cron/index.ts` would
 * otherwise produce two services called the same thing.
 */
export function serviceSuffixFor(entryPath: string): string {
  const base = path.basename(entryPath, path.extname(entryPath));
  const generic = base === "index" || base === "main" || base === "server";
  const raw = generic ? path.basename(path.dirname(entryPath)) : base;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "worker";
}

function readScripts(cwd: string, io: InjectIO): Record<string, string> | null {
  const raw = io.readFile(path.join(cwd, "package.json"));
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return null;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      scripts as Record<string, unknown>,
    )) {
      if (typeof value === "string") out[name] = value;
    }
    return out;
  } catch {
    // Unparseable package.json: the caller still wires the main entry.
    return null;
  }
}

export interface ExtraEntriesResult {
  entries: ExtraEntry[];
  /**
   * The matches that did not fit in MAX_EXTRA_ENTRIES, lowest ranked first.
   * Named rather than counted: "2 were left unwired" tells a user there is a
   * hole without telling them where it is.
   */
  unwired: ExtraEntry[];
}

/**
 * Deploy manifests at the package root. A process named in one of these is a
 * process the platform keeps running, which is the single strongest signal
 * available that it is not a one shot script.
 *
 * Matched by name because the wizard has no glob: Railway allows any
 * `railway*.json` / `railway*.toml` (a monorepo commonly has
 * `railway.worker.json` beside `railway.json`), and the rest are fixed names.
 */
export const DEPLOY_CONFIG_RE =
  /^(railway.*\.(json|toml)|procfile|dockerfile|.*\.dockerfile|fly\.toml|render\.yaml|ecosystem\.config\.(js|cjs|json)|docker-compose(\..+)?\.ya?ml)$/i;

/** Script names that start something and keep it running. */
function isLongRunningScriptName(name: string): boolean {
  const n = name.toLowerCase();
  return ["start", "dev", "serve", "worker"].some(
    (p) => n === p || n.startsWith(`${p}:`),
  );
}

/** File and directory names that describe a process, not a task. */
const LONG_RUNNING_NAME_RE = /(worker|server|daemon|consumer|listener)/i;

/**
 * One shot work: it runs, it finishes, and capture wrapped around it opens an
 * ingest session for the length of a migration. These rank last, so a package
 * with more runnable scripts than slots spends its slots on processes.
 */
const ONE_SHOT_NAME_RE =
  /(migrat|seed|bootstrap|backfill|codegen|provision|teardown|reset|fixture|scaffold)/i;

/**
 * The deploy manifest at the package root that names this entry file, or null.
 *
 * Said back to the user in the wired output ("worker.ts matched
 * railway.worker.json"), because a wizard that names the manifest it read is a
 * wizard that visibly looked, and the alternative — picking one of several
 * runnable files with no stated reason — reads as a guess.
 */
export function deployManifestNaming(
  cwd: string,
  io: InjectIO,
  entryPath: string,
): string | null {
  if (!io.listFiles) return null;
  const rel = path.relative(cwd, entryPath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(rel);
  if (!base) return null;
  for (const name of io.listFiles(cwd)) {
    if (!DEPLOY_CONFIG_RE.test(name)) continue;
    const text = io.readFile(path.join(cwd, name))?.toLowerCase();
    if (!text) continue;
    if (text.includes(rel) || text.includes(base)) return name;
  }
  return null;
}

function readDeployConfigText(cwd: string, io: InjectIO): string {
  if (!io.listFiles) return "";
  const parts: string[] = [];
  for (const name of io.listFiles(cwd)) {
    if (!DEPLOY_CONFIG_RE.test(name)) continue;
    const text = io.readFile(path.join(cwd, name));
    if (text) parts.push(text);
  }
  return parts.join("\n").toLowerCase();
}

/**
 * How likely this entry is to be a process that stays up. Higher wins a slot.
 *
 * The wizard can wire MAX_EXTRA_ENTRIES processes, and which ones it picks used
 * to be alphabetical: a package with `migrate.ts`, `seedSim.ts`,
 * `stripeBootstrap.ts`, `sim/server.ts` and a real `worker.ts` spent all four
 * slots on scripts that exit, and left the always on worker reporting nothing.
 */
export function longRunningScore(
  entry: ExtraEntry,
  relPath: string,
  deployConfigText: string,
): number {
  let score = 0;
  const rel = relPath.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(rel);
  const dir = path.dirname(rel);

  if (deployConfigText) {
    const named =
      deployConfigText.includes(rel) ||
      deployConfigText.includes(base) ||
      new RegExp(String.raw`run\s+${escapeRe(entry.script.toLowerCase())}\b`).test(
        deployConfigText,
      );
    if (named) score += 3;
  }
  if (isLongRunningScriptName(entry.script)) score += 2;
  if (LONG_RUNNING_NAME_RE.test(base) || LONG_RUNNING_NAME_RE.test(dir)) {
    score += 2;
  }
  if (ONE_SHOT_NAME_RE.test(base) || ONE_SHOT_NAME_RE.test(entry.script)) {
    score -= 3;
  }
  if (/(^|\/)scripts\//.test(rel)) score -= 2;
  return score;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every runnable file this package's scripts start, other than `mainEntry`.
 *
 * Deterministic: candidates are ranked by how likely they are to be a process
 * that stays up, and ties break on path, so a re-run plans the same edits.
 */
export function findExtraBackendEntries(
  cwd: string,
  io: InjectIO,
  mainEntry: string | null | undefined,
): ExtraEntriesResult {
  const scripts = readScripts(cwd, io);
  if (!scripts) return { entries: [], unwired: [] };

  const main = mainEntry ? path.resolve(mainEntry) : null;
  const found = new Map<string, ExtraEntry>();

  for (const [name, command] of Object.entries(scripts)) {
    if (isNonRuntimeScript(name)) continue;
    for (const rawToken of command.split(/\s+/)) {
      // Strip shell quoting; skip flags and anything that is not a path.
      const token = rawToken.replace(/^["']|["']$/g, "");
      if (!token || token.startsWith("-")) continue;
      if (!RUNNABLE_EXTENSIONS.has(path.extname(token))) continue;
      if (NON_RUNTIME_FILE.test(token)) continue;
      if (token.includes("node_modules")) continue;

      const abs = path.resolve(cwd, token);
      // Path shape only here — the tsconfig `outDir` half of this check reads
      // the real filesystem, and a miss just means one more candidate reaches
      // the `io.exists` gate below.
      if (isBuildOutputPath(cwd, abs)) continue;
      if (main && abs === main) continue;
      if (found.has(abs)) continue;
      if (!io.exists(abs)) continue;

      found.set(abs, {
        path: abs,
        serviceSuffix: serviceSuffixFor(abs),
        script: name,
      });
    }
  }

  const deployConfigText = readDeployConfigText(cwd, io);
  const scored = new Map<string, number>();
  for (const entry of found.values()) {
    scored.set(
      entry.path,
      longRunningScore(entry, path.relative(cwd, entry.path), deployConfigText),
    );
  }
  const sorted = [...found.values()].sort((a, b) => {
    const byScore = (scored.get(b.path) ?? 0) - (scored.get(a.path) ?? 0);
    if (byScore !== 0) return byScore;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return {
    entries: sorted.slice(0, MAX_EXTRA_ENTRIES),
    unwired: sorted.slice(MAX_EXTRA_ENTRIES),
  };
}
