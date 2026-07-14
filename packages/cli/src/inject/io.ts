// The read-only I/O boundary the plan-builders depend on. Splitting it out lets
// the bulk of the recipe tests run against an in-memory fake with zero disk I/O,
// while the golden-file / fixture tests use the real filesystem + git.
//
// NOTE: this module intentionally uses only node:fs, node:path and node:child_process
// (git). No HTTP client and no network egress of any kind — networking is CP4's job.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export interface GitTargetStatus {
  /** false when `cwd` is not inside a git work tree. */
  isRepo: boolean;
  /** false for an untracked (never-committed) file. */
  tracked: boolean;
  /** true when the target has uncommitted changes or is untracked. */
  dirty: boolean;
}

/** Read-only inspection surface consumed by the injection plan-builders. */
export interface InjectIO {
  exists(p: string): boolean;
  /** File contents, or null when it does not exist / cannot be read. */
  readFile(p: string): string | null;
  /** git porcelain status for a single target path. */
  gitStatus(cwd: string, target: string): GitTargetStatus;
  /** `.gitignore` contents at `cwd`, or null when absent. */
  readGitignore(cwd: string): string | null;
}

function realGitStatus(cwd: string, target: string): GitTargetStatus {
  let out: string;
  try {
    // Ask about the repo at `cwd`, never the one a surrounding git hook points
    // at: hooks export GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE for THEIR repo,
    // and inheriting them makes this status query answer for the wrong tree
    // (e.g. wizard run from husky, or the test suite under pre-push).
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    out = execFileSync("git", ["status", "--porcelain", "--", target], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
  } catch {
    // git missing, or not a work tree.
    return { isRepo: false, tracked: false, dirty: false };
  }
  const line = out.split("\n").find((l) => l.trim().length > 0);
  if (!line) {
    // No status line: committed-clean, or the file does not exist yet.
    return { isRepo: true, tracked: true, dirty: false };
  }
  const code = line.slice(0, 2);
  const untracked = code === "??";
  return { isRepo: true, tracked: !untracked, dirty: true };
}

/** The default real-filesystem + git implementation. */
export const defaultInjectIO: InjectIO = {
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  gitStatus: realGitStatus,
  /**
   * Every .gitignore from `cwd` up to (and including) the git root, concatenated.
   *
   * Walking up is what makes this correct in a monorepo: `.env` is almost always
   * ignored by the ROOT .gitignore, not by `packages/api/.gitignore` — and a
   * package-local-only read would tell every service in the repo that its ingest
   * key is about to be committed when it isn't.
   */
  readGitignore: (cwd) => {
    const parts: string[] = [];
    let dir = path.resolve(cwd);
    while (true) {
      try {
        parts.push(readFileSync(path.join(dir, ".gitignore"), "utf8"));
      } catch {
        // No .gitignore at this level — keep climbing.
      }
      // Stop at the repo root; beyond it, ignore rules no longer apply to us.
      if (existsSync(path.join(dir, ".git"))) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return parts.length > 0 ? parts.join("\n") : null;
  },
};
