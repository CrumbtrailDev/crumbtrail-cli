// Root-level service discovery for the batch installer.
//
// `detect()` classifies ONE directory. This module turns a monorepo root into
// the full candidate list by looping it — which is safe because detect is pure:
// no module state, no process.cwd(), no process.exit, no network, no subprocess.
//
// Two sources feed the list:
//   1. Real workspaces (pnpm-workspace.yaml / package.json#workspaces / Nx),
//      already resolved by detect() into `DetectResult.workspaces`.
//   2. A bounded scan of conventional service dirs. This exists because
//      workspace discovery only yields directories that contain a package.json
//      (detect.ts expandWorkspaceGlobs), so a Rails/Django/Go service is
//      invisible to it. We re-run detect() on those dirs and keep only the ones
//      that land on the `otlp` recipe — going through detect() rather than
//      calling resolveOtlpStack() directly keeps `otlpStack` correct and cannot
//      drift from the matcher order.

import fs from "node:fs";
import path from "node:path";
import { detect, type DetectResult, type Recipe } from "./detect";
import { defaultInjectIO, projectAlreadyWired } from "./inject";
import { OTLP_GUIDE_FILENAME } from "./otlp-guide";
import { RECIPE_REGISTRY } from "./recipe-registry";

/** Conventional parents scanned (one level deep) for non-JS services. */
const SCAN_PARENTS = ["apps", "services", "packages"] as const;

/** Never descend into these — build output, vendored deps, VCS. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  ".next",
  ".git",
]);

/** Hard cap on directories classified, so a pathological repo can't hang the CLI. */
const MAX_SCAN_DIRS = 200;

export type CandidateSource = "workspace" | "scan";

export type CandidateFlag =
  | "ambiguous"
  | "otlp"
  | "likely-library"
  | "already-wired"
  | "no-recipe";

export interface ServiceCandidate {
  /** Absolute path to the service directory. */
  dir: string;
  /** package.json name, falling back to the directory basename. */
  name: string;
  /** Path relative to the repo root — used for labels and `--only` matching. */
  relDir: string;
  source: CandidateSource;
  /** The real detect() output for this dir, not a synthesized one. */
  detected: DetectResult;
  recipe: Recipe | null;
  flags: CandidateFlag[];
  /** Pre-checked in the multi-select list. */
  defaultChecked: boolean;
  /** False when nothing can be wired here (no recipe matched). */
  selectable: boolean;
}

export interface DiscoverDeps {
  detect?: (cwd: string) => DetectResult;
  /** True when this dir already depends on a Crumbtrail SDK. */
  alreadyWired?: (dir: string) => boolean;
  readDir?: (dir: string) => string[];
  isDir?: (p: string) => boolean;
  isFile?: (p: string) => boolean;
}

function defaultReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function defaultIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Narrow guard against a false-positive "app".
 *
 * The `node` matcher in detect.ts fires on ANY package.json whose main/bin/start
 * resolves to a real file — so a BUILT shared-types package (`main:
 * dist/index.js` with dist/ present) classifies as recipe "node", ambiguous:
 * false, and looks perfectly wireable. Wiring a library is useless: nothing runs
 * it, so it never emits a session.
 *
 * Deliberately applies ONLY to `node`, the sole false-positive source — a real
 * Node server almost always has a start/dev script or a bin. Never downgrades
 * next/express/vite-spa/etc.
 */
export function looksLikeLibrary(
  recipe: Recipe | null,
  pkg: { scripts?: Record<string, string>; bin?: unknown } | null,
): boolean {
  if (recipe !== "node" || !pkg) return false;
  if (pkg.bin) return false;
  const scripts = pkg.scripts ?? {};
  return !["start", "dev", "serve", "start:prod"].some((s) => scripts[s]);
}

function readPkg(
  dir: string,
  isFile: (p: string) => boolean,
): { name?: string; scripts?: Record<string, string>; bin?: unknown } | null {
  const file = path.join(dir, "package.json");
  if (!isFile(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

function classify(
  root: string,
  dir: string,
  source: CandidateSource,
  fallbackName: string,
  deps: Required<Pick<DiscoverDeps, "detect" | "alreadyWired" | "isFile">>,
): ServiceCandidate {
  const detected = deps.detect(dir);
  const recipe = detected.recipe;
  const pkg = readPkg(dir, deps.isFile);
  const flags: CandidateFlag[] = [];

  const isOtlp = recipe === "otlp";
  // An OTLP service has no package.json to inspect, so "already wired" for it
  // means the guide file is already sitting there from a previous run.
  const wired = isOtlp
    ? deps.isFile(path.join(dir, OTLP_GUIDE_FILENAME))
    : recipe != null && deps.alreadyWired(dir);

  if (recipe == null) flags.push("no-recipe");
  if (isOtlp) flags.push("otlp");
  if (looksLikeLibrary(recipe, pkg)) flags.push("likely-library");
  if (detected.ambiguous && recipe != null) flags.push("ambiguous");
  if (wired) flags.push("already-wired");

  const selectable = recipe != null;
  // Check only what we are confident is a real, unwired app we can inject into.
  // Everything else stays listed and selectable, just off by default.
  const defaultChecked =
    selectable &&
    source === "workspace" &&
    RECIPE_REGISTRY[recipe].kind === "inject" &&
    !detected.ambiguous &&
    !flags.includes("likely-library") &&
    !wired;

  return {
    dir,
    name: pkg?.name?.split("/").pop() ?? fallbackName,
    relDir: path.relative(root, dir) || ".",
    source,
    detected,
    recipe,
    flags,
    defaultChecked,
    selectable,
  };
}

/**
 * Every service Crumbtrail can see from the repo root: real workspaces first (by
 * path), then non-JS services found by the conventional-dir scan.
 */
export function discoverServices(
  root: string,
  rootResult: DetectResult,
  overrides: DiscoverDeps = {},
): ServiceCandidate[] {
  const isFile = overrides.isFile ?? defaultIsFile;
  const isDir = overrides.isDir ?? defaultIsDir;
  const readDir = overrides.readDir ?? defaultReadDir;
  const deps = {
    detect: overrides.detect ?? detect,
    alreadyWired:
      overrides.alreadyWired ??
      ((dir: string) => projectAlreadyWired(dir, defaultInjectIO)),
    isFile,
  };

  const byDir = new Map<string, ServiceCandidate>();

  for (const ws of rootResult.workspaces) {
    const dir = path.resolve(ws.dir);
    if (byDir.has(dir)) continue;
    byDir.set(dir, classify(root, dir, "workspace", ws.name, deps));
  }

  // Scan pass. Workspaces already claimed win — a dir under packages/* that is
  // also a workspace must appear once, as a workspace.
  let scanned = 0;
  const parents = [
    ...SCAN_PARENTS.map((p) => path.join(root, p)).filter(isDir),
    root,
  ];
  for (const parent of parents) {
    for (const entry of readDir(parent)) {
      if (scanned >= MAX_SCAN_DIRS) break;
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const dir = path.join(parent, entry);
      if (!isDir(dir) || byDir.has(dir)) continue;
      scanned += 1;
      const candidate = classify(root, dir, "scan", entry, deps);
      // The scan exists solely to surface non-JS services. A JS package that
      // isn't a declared workspace is not ours to wire — leaving it out keeps
      // the list honest and avoids picking up examples/ and fixtures/.
      if (candidate.recipe === "otlp") byDir.set(dir, candidate);
    }
  }

  return [...byDir.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "workspace" ? -1 : 1;
    return a.relDir.localeCompare(b.relDir);
  });
}
