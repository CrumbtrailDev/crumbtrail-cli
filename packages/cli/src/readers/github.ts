// A FileReader backed by a GitHub repository.
//
// Detection is synchronous by design: making it async would cascade through
// every recipe matcher and plan builder. So this reader is HYDRATED first
// (async, bounded) and then read synchronously from the resulting snapshot.
//
// Hydration is two phases:
//   1. One recursive git-trees call gives every path in the repo, which is
//      enough to answer isFile / isDir / readDir for the whole tree.
//   2. File CONTENT is fetched only for an enumerable manifest of paths that
//      detection is known to read. Two rounds, because workspace globs are not
//      known until the root package.json has been read.
//
// This module performs no network I/O itself. The caller injects a fetch-like
// client, which keeps the package free of an HTTP dependency and keeps the
// egress policy with the cloud service that owns credentials.

import type { FileReader } from "./types";

/** Thrown when detection reads a path hydration did not prefetch. */
export class UnhydratedPathError extends Error {
  constructor(readonly path: string) {
    // Loud on purpose. A silent null here would look like "file absent" and
    // silently change which recipe matches, producing a wrong pull request.
    super(
      `${path} was read but never hydrated. Add it to the hydration manifest.`,
    );
    this.name = "UnhydratedPathError";
  }
}

export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

export interface GithubRepoSource {
  /** Recursive tree for the commit being inspected. */
  listTree(): Promise<{ entries: GithubTreeEntry[]; truncated: boolean }>;
  /** UTF-8 contents, or null when the path is absent or unreadable. */
  readFile(path: string): Promise<string | null>;
  /** Immediate children of one directory. Used only when the tree truncated. */
  listDir?(path: string): Promise<GithubTreeEntry[]>;
}

const ROOT = "/";

/**
 * Manifests detection reads inside ONE directory, independent of what the repo
 * holds. Applied at the repo root, at every workspace member, and at every
 * directory the discover.ts scan pass classifies.
 */
const DIR_MANIFEST = [
  "package.json",
  "pnpm-workspace.yaml",
  "nx.json",
  "project.json",
  "index.html",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
];

// Injection targets that a recipe may prepend into. They are not returned by
// detection as the entry file, so they have to be prefetched by name. Each is
// tried at the package root and under src/, matching the plan builders' own
// baseDir handling.
const TARGET_CANDIDATES = [
  "instrumentation-client.ts",
  "pages/_app.tsx",
  "pages/_app.jsx",
  "app/layout.tsx",
  "app/layout.jsx",
].flatMap((p) => [p, `src/${p}`]);

/** Normalise to a POSIX absolute path rooted at "/". */
function norm(p: string): string {
  const withRoot = p.startsWith(ROOT) ? p : `${ROOT}${p}`;
  const parts: string[] = [];
  for (const seg of withRoot.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return ROOT + parts.join("/");
}

function parentOf(p: string): string {
  const n = norm(p);
  const cut = n.lastIndexOf("/");
  return cut <= 0 ? ROOT : n.slice(0, cut);
}

interface Snapshot {
  files: Set<string>;
  dirs: Set<string>;
  children: Map<string, Set<string>>;
  contents: Map<string, string | null>;
  truncated: boolean;
}

function emptySnapshot(): Snapshot {
  return {
    files: new Set(),
    dirs: new Set([ROOT]),
    children: new Map(),
    contents: new Map(),
    truncated: false,
  };
}

function addPath(snap: Snapshot, rawPath: string, isFile: boolean): void {
  const full = norm(rawPath);
  if (isFile) snap.files.add(full);
  else snap.dirs.add(full);

  // Register every ancestor directory. The trees API lists them explicitly,
  // but the truncated fallback does not, so deriving them keeps both paths
  // answering isDir identically.
  let child = full;
  let parent = parentOf(child);
  for (;;) {
    snap.dirs.add(parent);
    const bucket = snap.children.get(parent) ?? new Set<string>();
    bucket.add(child.slice(parent === ROOT ? 1 : parent.length + 1));
    snap.children.set(parent, bucket);
    if (parent === ROOT) break;
    child = parent;
    parent = parentOf(child);
  }
}

/**
 * Workspace globs from a package.json, in the only two shapes detection
 * supports: a bare array, or the pnpm/yarn `{ packages: [...] }` object.
 */
function workspaceGlobs(pkgJson: string | null): string[] {
  if (!pkgJson) return [];
  try {
    const parsed = JSON.parse(pkgJson) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = parsed.workspaces;
    if (Array.isArray(ws)) return ws;
    if (ws && Array.isArray(ws.packages)) return ws.packages;
  } catch {
    // A malformed root manifest is the repo's problem, not a hydration failure.
  }
  return [];
}

/**
 * Expand a workspace entry against the tree. Only trailing /* and /** occur as
 * wildcards; a literal entry ("website") resolves to that one directory, which
 * is how detect.ts expandWorkspaceGlobs reads it. Treating a literal as a glob
 * would yield its CHILDREN and skip the directory itself, leaving the member's
 * package.json unhydrated and throwing UnhydratedPathError on first read.
 */
function expandGlob(snap: Snapshot, glob: string): string[] {
  if (glob.startsWith("!")) return []; // exclusion, same as detect.ts
  if (!glob.includes("*")) {
    const literal = norm(glob);
    return snap.dirs.has(literal) ? [literal] : [];
  }
  const cleaned = glob.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  const base = norm(cleaned);
  const deep = glob.endsWith("/**");
  const out: string[] = [];
  for (const dir of snap.dirs) {
    if (dir === base) continue;
    if (!dir.startsWith(base === ROOT ? ROOT : `${base}/`)) continue;
    const rest = dir.slice(base === ROOT ? 1 : base.length + 1);
    if (!deep && rest.includes("/")) continue;
    out.push(dir);
  }
  return out;
}

// Mirrors discover.ts: the scan pass re-runs detect() on the children of these
// parents plus the repo root, so those directories' manifests must be hydrated
// even when nothing declares them as workspaces.
const SCAN_PARENTS = ["apps", "services", "packages"];
const SCAN_SKIP_DIRS = new Set([
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
const MAX_SCAN_DIRS = 200;

/** The directories discover.ts would classify in its scan pass. */
function scanDirs(snap: Snapshot): string[] {
  const parents = [
    ...SCAN_PARENTS.map((p) => norm(p)).filter((d) => snap.dirs.has(d)),
    ROOT,
  ];
  const out: string[] = [];
  for (const parent of parents) {
    for (const entry of snap.children.get(parent) ?? []) {
      if (out.length >= MAX_SCAN_DIRS) return out;
      if (entry.startsWith(".") || SCAN_SKIP_DIRS.has(entry)) continue;
      const dir = parent === ROOT ? `${ROOT}${entry}` : `${parent}/${entry}`;
      if (snap.dirs.has(dir)) out.push(dir);
    }
  }
  return out;
}

async function fetchInto(
  snap: Snapshot,
  source: GithubRepoSource,
  paths: string[],
): Promise<void> {
  const wanted = [...new Set(paths.map(norm))].filter(
    (p) => !snap.contents.has(p),
  );
  const results = await Promise.all(
    wanted.map(async (p) => {
      // Never request a path the tree says is absent: that is a wasted round
      // trip per candidate, and detection probes far more paths than exist.
      if (!snap.files.has(p)) return [p, null] as const;
      return [p, await source.readFile(p.slice(1))] as const;
    }),
  );
  for (const [p, body] of results) snap.contents.set(p, body);
}

export interface HydrateOptions {
  /** Extra paths to prefetch, e.g. a recipe's resolved target candidates. */
  extraPaths?: string[];
}

/**
 * A hydrated reader, plus the ability to fetch more content.
 *
 * `prefetch` exists because the injection target is not knowable up front: it
 * comes out of `detect()`. The caller runs detection against the snapshot, then
 * prefetches the resolved entry file, then builds the plan. That keeps the
 * round trips bounded and explicit instead of letting plan building fault in
 * one blob at a time.
 */
export interface HydratedGithubReader extends FileReader {
  prefetch(paths: (string | null | undefined)[]): Promise<void>;
}

/**
 * Fetch everything detection will read, then hand back a synchronous reader.
 * Round trips are O(1) in repository size: one tree call plus two content
 * rounds, regardless of how many candidate paths detection probes.
 */
export async function hydrateGithubReader(
  source: GithubRepoSource,
  options: HydrateOptions = {},
): Promise<HydratedGithubReader> {
  const snap = emptySnapshot();
  const { entries, truncated } = await source.listTree();
  snap.truncated = truncated;

  for (const entry of entries) {
    // node_modules is never committed in practice, and skipping it keeps a
    // vendored copy from dominating the snapshot.
    if (entry.path === "node_modules" || entry.path.startsWith("node_modules/"))
      continue;
    if (entry.type === "commit") continue; // submodule pointer, not readable
    addPath(snap, entry.path, entry.type === "blob");
  }

  // Round one: fixed manifest at the repository root.
  await fetchInto(snap, source, [
    ...DIR_MANIFEST,
    ...TARGET_CANDIDATES,
    ...(options.extraPaths ?? []),
  ]);

  // Round two: per-workspace manifests, which depend on round one.
  const globs = workspaceGlobs(snap.contents.get(norm("package.json")) ?? null);
  const pnpmWs = snap.contents.get(norm("pnpm-workspace.yaml"));
  if (pnpmWs) {
    for (const line of pnpmWs.split("\n")) {
      const m = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (m) globs.push(m[1]);
    }
  }
  // Every directory detection will classify: declared workspace members, plus
  // the conventional dirs discover.ts scans for non-JS services.
  const dirs = new Set<string>(scanDirs(snap));
  for (const glob of globs) for (const d of expandGlob(snap, glob)) dirs.add(d);

  const memberPaths: string[] = [];
  for (const dir of dirs) {
    for (const file of DIR_MANIFEST) memberPaths.push(`${dir}/${file}`);
  }
  if (memberPaths.length) await fetchInto(snap, source, memberPaths);

  return {
    root: ROOT,
    async prefetch(paths) {
      await fetchInto(
        snap,
        source,
        paths.filter((p): p is string => typeof p === "string" && p.length > 0),
      );
    },
    readFile(file) {
      const p = norm(file);
      if (!snap.contents.has(p)) {
        // Absent per the tree is a legitimate null; only an unprobed path is
        // a hydration bug worth failing on.
        if (!snap.files.has(p)) return null;
        throw new UnhydratedPathError(p);
      }
      return snap.contents.get(p) ?? null;
    },
    isFile: (file) => snap.files.has(norm(file)),
    isDir: (dir) => snap.dirs.has(norm(dir)),
    readDir: (dir) => [...(snap.children.get(norm(dir)) ?? [])],
  };
}

/**
 * InjectIO over a hydrated reader.
 *
 * gitStatus is clean unconditionally: an API read has no working tree, so
 * there is nothing to be dirty. This makes needs-confirm-dirty unreachable
 * remotely, which is correct rather than a limitation, and it is why this must
 * never fall through to the filesystem implementation.
 */
export function githubInjectIO(reader: FileReader) {
  return {
    exists: (p: string) => reader.isFile(p) || reader.isDir(p),
    readFile: (p: string) => reader.readFile(p),
    gitStatus: () => ({ isRepo: true, tracked: true, dirty: false }),
  };
}
