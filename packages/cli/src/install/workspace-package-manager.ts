// Which package manager the wizard installs the SDK with.
//
// The package manager is a property of the WORKSPACE, not of the directory the
// SDK happens to be added to. Deciding it per directory is what let one wizard
// run add the SDK with `pnpm add` in five services and `npm install` in two
// others of the same pnpm monorepo: the two had a stale `package-lock.json`
// sitting in their own directory, the nearest-lockfile-wins walk stopped there,
// and npm then rewrote that lock, removed packages pnpm had linked, and left a
// broken `node_modules/.bin` behind. Nothing in the run said so.
//
// So: climb to the nearest declared workspace root (what pnpm, npm and yarn all
// do themselves), decide there, and use that one answer for every package in the
// run. A lockfile inside a workspace member is evidence of a past mistake, never
// an instruction — it is reported, not obeyed.

import path from "node:path";
import type { FileReader } from "../readers/types.js";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/** How the manager was decided — surfaced so the CLI can explain the choice. */
export type PackageManagerSource =
  /** `packageManager` field in the workspace root's package.json (corepack). */
  | "package-manager-field"
  /** `pnpm-workspace.yaml` at the workspace root. */
  | "workspace-file"
  /** A lockfile. */
  | "lockfile"
  /** Nothing found anywhere; the caller defaults to npm. */
  | "none";

export interface PackageManagerResolution {
  /** null when no evidence was found at all — callers default to npm. */
  manager: PackageManager | null;
  source: PackageManagerSource;
  /** Directory the decision was made from, when there was any evidence. */
  decidedIn: string | null;
  /** Absolute path to the nearest declared workspace root, when there is one. */
  workspaceRoot: string | null;
  /**
   * Lockfiles found strictly below `workspaceRoot` that were deliberately
   * ignored. Each entry is an absolute path. A non-empty list means the repo
   * disagrees with itself and the user should be told which file was ignored.
   */
  ignoredNestedLockfiles: string[];
}

/** Lockfiles, in the order a single directory's evidence is read. */
const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
];

/**
 * Workspace markers that declare no member list we can read. A directory under
 * one of these is treated as a member by containment — these tools always sit on
 * top of a single root install, and their members do not carry own lockfiles.
 */
const CONTAINMENT_MARKERS = ["nx.json", "turbo.json"] as const;

function lockfileIn(
  dir: string,
  reader: FileReader,
): { file: string; manager: PackageManager } | null {
  for (const entry of LOCKFILES) {
    const file = path.join(dir, entry.file);
    if (reader.isFile(file)) return { file, manager: entry.manager };
  }
  return null;
}

interface RootPackageJson {
  workspaces?: unknown;
  packageManager?: unknown;
}

/**
 * Match one workspace pattern against a member path relative to the root.
 * `packages/*` matches one segment, `packages/**` matches any depth, and a
 * pattern with no wildcard matches that exact directory.
 */
export function patternMatches(pattern: string, relPath: string): boolean {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  return segmentsMatch(clean.split("/"), relPath.split("/"));
}

/** One path segment against one pattern segment: `*` and `?` inside a segment. */
function segmentMatches(pattern: string, segment: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(segment);
}

/** Segment lists, with `**` consuming any number of segments, including none. */
function segmentsMatch(patterns: string[], segments: string[]): boolean {
  if (patterns.length === 0) return segments.length === 0;
  const [head, ...rest] = patterns;
  if (head === "**") {
    for (let i = 0; i <= segments.length; i += 1) {
      if (segmentsMatch(rest, segments.slice(i))) return true;
    }
    return false;
  }
  if (segments.length === 0) return false;
  return (
    segmentMatches(head, segments[0]) && segmentsMatch(rest, segments.slice(1))
  );
}

/** Read a root's declared member patterns, or null when it declares none. */
export function workspacePatterns(
  dir: string,
  reader: Pick<FileReader, "readFile">,
): string[] | null {
  const yaml = reader.readFile(path.join(dir, "pnpm-workspace.yaml"));
  if (yaml != null) return parsePnpmWorkspace(yaml);
  const pkg = readRootPackageJson(dir, reader);
  const ws = pkg?.workspaces;
  if (Array.isArray(ws))
    return ws.filter((p): p is string => typeof p === "string");
  if (ws && typeof ws === "object") {
    const packages = (ws as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((p): p is string => typeof p === "string");
    }
  }
  const lerna = reader.readFile(path.join(dir, "lerna.json"));
  if (lerna != null) {
    try {
      const parsed = JSON.parse(lerna) as { packages?: unknown };
      if (Array.isArray(parsed.packages)) {
        return parsed.packages.filter(
          (p): p is string => typeof p === "string",
        );
      }
      // A lerna.json with no `packages` defers to the package.json workspaces
      // field, which was already read above and found nothing.
      return [];
    } catch {
      return [];
    }
  }
  return null;
}

/**
 * Extract the `packages:` list from a pnpm-workspace.yaml without a YAML dep.
 *
 * Canonical home: detect.ts re-exports this rather than keeping a second copy,
 * because membership and workspace expansion must read the same list or they
 * disagree about which packages the root owns.
 */
export function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
    if (item) {
      out.push(item[1].trim());
      continue;
    }
    // A new, non-indented top-level key ends the packages block.
    if (/^\S/.test(line)) inPackages = false;
  }
  return out;
}

function readRootPackageJson(
  dir: string,
  reader: Pick<FileReader, "readFile">,
): RootPackageJson | null {
  const text = reader.readFile(path.join(dir, "package.json"));
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as RootPackageJson)
      : null;
  } catch {
    return null;
  }
}

/**
 * Is `dir` the workspace root that owns `memberDir`?
 *
 * Membership is checked against the root's declared patterns rather than by
 * containment alone. An unrelated project that merely sits inside someone
 * else's monorepo — a fixture, a vendored example, a scratch app — is not a
 * member, and taking that repo's package manager away from it would be the same
 * class of mistake in the other direction.
 */
function ownsMember(
  dir: string,
  memberDir: string,
  reader: FileReader,
): boolean {
  if (dir === memberDir) {
    // A workspace root can also be the app being wired (a single-package repo
    // that still declares workspaces). It owns itself.
    return workspacePatterns(dir, reader) !== null;
  }
  const rel = path.relative(dir, memberDir).split(path.sep).join("/");
  if (rel === "" || rel.startsWith("..")) return false;

  const patterns = workspacePatterns(dir, reader);
  if (patterns !== null) {
    const excluded = patterns
      .filter((p) => p.startsWith("!"))
      .some((p) => patternMatches(p.slice(1), rel));
    if (excluded) return false;
    return patterns
      .filter((p) => !p.startsWith("!"))
      .some((p) => patternMatches(p, rel));
  }

  return CONTAINMENT_MARKERS.some((marker) =>
    reader.isFile(path.join(dir, marker)),
  );
}

/** `"pnpm@9.1.0"` / `"yarn@4.2.2+sha…"` → the manager, when it is one we run. */
export function parsePackageManagerField(
  value: unknown,
): PackageManager | null {
  if (typeof value !== "string") return null;
  const name = value.trim().split("@")[0].toLowerCase();
  return name === "pnpm" || name === "yarn" || name === "bun" || name === "npm"
    ? name
    : null;
}

/** Every directory from `startDir` up to the reader's boundary, innermost first. */
function ancestors(startDir: string, reader: FileReader): string[] {
  const out: string[] = [];
  let dir = path.resolve(startDir);
  while (true) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (dir === reader.root || parent === dir) return out;
    dir = parent;
  }
}

/** Decide the manager from one directory's own evidence, strongest first. */
function evidenceIn(
  dir: string,
  reader: FileReader,
): { manager: PackageManager; source: PackageManagerSource } | null {
  const pkg = readRootPackageJson(dir, reader);
  const declared = parsePackageManagerField(pkg?.packageManager);
  if (declared) return { manager: declared, source: "package-manager-field" };
  if (reader.isFile(path.join(dir, "pnpm-workspace.yaml"))) {
    return { manager: "pnpm", source: "workspace-file" };
  }
  const lock = lockfileIn(dir, reader);
  if (lock) return { manager: lock.manager, source: "lockfile" };
  return null;
}

/**
 * Resolve the one package manager every install in this run must use.
 *
 * Climbs from `startDir` to the nearest declared workspace root and decides
 * there. With no workspace root anywhere, falls back to the nearest directory
 * with any evidence, which is the right answer for a standalone app.
 */
export function resolveWorkspacePackageManager(
  startDir: string,
  reader: FileReader,
): PackageManagerResolution {
  const chain = ancestors(startDir, reader);
  const member = path.resolve(startDir);
  const workspaceRootIndex = chain.findIndex((dir) =>
    ownsMember(dir, member, reader),
  );
  const workspaceRoot =
    workspaceRootIndex === -1 ? null : chain[workspaceRootIndex];

  // Lockfiles strictly inside the workspace are never the workspace's answer.
  // They are reported so a run can say which file it ignored.
  const ignoredNestedLockfiles: string[] = [];
  if (workspaceRootIndex > 0) {
    for (const dir of chain.slice(0, workspaceRootIndex)) {
      const lock = lockfileIn(dir, reader);
      if (lock) ignoredNestedLockfiles.push(lock.file);
    }
  }

  // Search from the workspace root outwards when there is one (a workspace can
  // sit inside a larger repo that owns the lockfile), and from startDir
  // outwards when there is not.
  const searchFrom = workspaceRootIndex === -1 ? 0 : workspaceRootIndex;
  for (const dir of chain.slice(searchFrom)) {
    const found = evidenceIn(dir, reader);
    if (found) {
      return {
        manager: found.manager,
        source: found.source,
        decidedIn: dir,
        workspaceRoot,
        ignoredNestedLockfiles,
      };
    }
  }

  return {
    manager: null,
    source: "none",
    decidedIn: null,
    workspaceRoot,
    ignoredNestedLockfiles,
  };
}
