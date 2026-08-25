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
  /** How many matches were found beyond MAX_EXTRA_ENTRIES and left unwired. */
  truncated: number;
}

/**
 * Every runnable file this package's scripts start, other than `mainEntry`.
 * Deterministic: results are sorted by path so a re-run plans the same edits.
 */
export function findExtraBackendEntries(
  cwd: string,
  io: InjectIO,
  mainEntry: string | null | undefined,
): ExtraEntriesResult {
  const scripts = readScripts(cwd, io);
  if (!scripts) return { entries: [], truncated: 0 };

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

  const sorted = [...found.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    entries: sorted.slice(0, MAX_EXTRA_ENTRIES),
    truncated: Math.max(0, sorted.length - MAX_EXTRA_ENTRIES),
  };
}
