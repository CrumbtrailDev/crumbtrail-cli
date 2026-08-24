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

import path from "node:path";
import { detect, type DetectResult, type Recipe } from "./detect";
import {
  inspectIntegration,
  type InjectIO,
  type IntegrationCheckInput,
  type IntegrationStatus,
} from "./inject";
import { OTLP_GUIDE_FILENAME } from "./otlp";
import { inferServiceName } from "./provision";
import { localFsReader } from "./readers/local-fs";
import type { FileReader } from "./readers/types";
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
  "ambiguous" | "otlp" | "likely-library" | "already-wired" | "no-recipe";

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
  /** Shared completeness evidence used by the prompt and the plan builder. */
  integration?: IntegrationStatus;
}

export interface DiscoverDeps {
  detect?: (cwd: string, reader?: FileReader) => DetectResult;
  /** Endpoint this run is installing for. Missing means completeness is unproven. */
  endpoint?: string;
  /** Override the shared completeness check for tests and hosted readers. */
  integration?: (input: IntegrationCheckInput) => IntegrationStatus;
  /** Legacy override retained for callers that supply their own detection. */
  alreadyWired?: (dir: string) => boolean;
  /**
   * Keep JS apps found by the scan even though no workspace file declares them.
   *
   * Set ONLY when the root itself declares no workspaces and matched no recipe
   * — the "plain sibling directories" layout (`admin/` + `api/` with nothing
   * linking them). Without it the scan drops every JS candidate, so a repo root
   * that had already identified both services told the user to cd into each one
   * and run the wizard again. With it, those dirs are wireable targets from the
   * root, exactly like real workspace packages.
   */
  includeUnlinkedApps?: boolean;
}

function injectIOFromReader(reader: FileReader): InjectIO {
  return {
    exists: (p) => reader.isFile(p) || reader.isDir(p),
    // Bound, not passed by reference: a future class based reader would lose
    // `this` if this were `readFile: reader.readFile`.
    readFile: (p) => reader.readFile(p),
    // A FileReader has no working tree, so there is no honest answer here.
    // Throwing rather than returning a plausible "clean" keeps a future caller
    // from silently getting a wrong answer. Completeness inspection is read only
    // and never asks for git status.
    gitStatus: () => {
      throw new Error("gitStatus is unavailable through a FileReader");
    },
  };
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
  reader: FileReader,
): { name?: string; scripts?: Record<string, string>; bin?: unknown } | null {
  const file = path.join(dir, "package.json");
  if (!reader.isFile(file)) return null;
  try {
    return JSON.parse(reader.readFile(file) ?? "") as {
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
  reader: FileReader,
  deps: Required<Pick<DiscoverDeps, "detect" | "integration">> &
    Pick<DiscoverDeps, "endpoint" | "alreadyWired" | "includeUnlinkedApps">,
): ServiceCandidate {
  const detected = deps.detect(dir, reader);
  const recipe = detected.recipe;
  const pkg = readPkg(dir, reader);
  const flags: CandidateFlag[] = [];

  const isOtlp = recipe === "otlp";
  // An OTLP service has no package.json to inspect, so "already wired" for it
  // means the guide file is already sitting there from a previous run.
  const integration =
    recipe != null && !isOtlp && deps.endpoint
      ? deps.integration({
          cwd: dir,
          recipe,
          endpoint: deps.endpoint,
          entryFile: detected.entryFile,
          serviceName: inferServiceName(recipe, pkg?.name ?? fallbackName),
          io: injectIOFromReader(reader),
        })
      : undefined;
  const wired = isOtlp
    ? reader.isFile(path.join(dir, OTLP_GUIDE_FILENAME))
    : integration?.complete ?? deps.alreadyWired?.(dir) ?? false;

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
    (source === "workspace" ||
      (source === "scan" && deps.includeUnlinkedApps === true)) &&
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
    integration,
  };
}

/**
 * Every service Crumbtrail can see from the repo root: real workspaces first (by
 * path), then non-JS services found by the conventional-dir scan.
 */
export function discoverServices(
  root: string,
  rootResult: DetectResult,
  reader: FileReader = localFsReader(root),
  overrides: DiscoverDeps = {},
): ServiceCandidate[] {
  const deps = {
    detect: overrides.detect ?? detect,
    endpoint: overrides.endpoint,
    integration: overrides.integration ?? inspectIntegration,
    alreadyWired: overrides.alreadyWired,
    includeUnlinkedApps: overrides.includeUnlinkedApps,
  };

  const byDir = new Map<string, ServiceCandidate>();

  for (const ws of rootResult.workspaces) {
    const dir = path.resolve(ws.dir);
    if (byDir.has(dir)) continue;
    byDir.set(dir, classify(root, dir, "workspace", ws.name, reader, deps));
  }

  // Scan pass. Workspaces already claimed win — a dir under packages/* that is
  // also a workspace must appear once, as a workspace.
  let scanned = 0;
  const parents = [
    ...SCAN_PARENTS.map((p) => path.join(root, p)).filter((dir) =>
      reader.isDir(dir),
    ),
    root,
  ];
  for (const parent of parents) {
    for (const entry of reader.readDir(parent)) {
      if (scanned >= MAX_SCAN_DIRS) break;
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const dir = path.join(parent, entry);
      if (!reader.isDir(dir) || byDir.has(dir)) continue;
      scanned += 1;
      const candidate = classify(root, dir, "scan", entry, reader, deps);
      // In a declared monorepo the scan exists solely to surface non-JS
      // services: a JS package the workspace file does not list is not ours to
      // wire, and keeping it out avoids picking up examples/ and fixtures/.
      //
      // With `includeUnlinkedApps` there IS no workspace file to be
      // authoritative, so that rule would discard the only apps in the repo.
      const keep =
        candidate.recipe === "otlp" ||
        (deps.includeUnlinkedApps === true && candidate.recipe != null);
      if (keep) byDir.set(dir, candidate);
    }
  }

  return [...byDir.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "workspace" ? -1 : 1;
    return a.relDir.localeCompare(b.relDir);
  });
}
