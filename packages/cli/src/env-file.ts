// The one module that puts a live ingest key on disk.
//
// The wizard used to stop one step short of working: it wired the code, then
// printed "set VITE_CRUMBTRAIL_KEY in .env" and left. Nothing reached Crumbtrail
// until a person did that by hand, so "one command" ended in a manual step and
// the first-event wait it started could never finish on its own.
//
// Writing a live credential to disk is the part that has to be right, so the
// rules here are conservative and stated rather than inferred:
//
//   1. A file git already tracks is never written to. Adding it to .gitignore
//      afterwards would not untrack it, so the very next commit would publish
//      the key. This case refuses and hands the job back, which is the old
//      behaviour and the correct one here.
//   2. A file git does not ignore yet gets an ignore entry in the SAME atomic
//      apply as the key. A secret written to a file that would be committed on
//      the next `git add .` is the failure this whole module exists to avoid.
//   3. A variable that already holds a value is never overwritten. Someone
//      pointing an app at a specific key means it, and a rerun of the wizard
//      must not silently repoint their app.
//   4. Only a value that is unambiguously safe unquoted is written. Ingest keys
//      are `ctkey_` + base62, so anything else means something upstream is not
//      what this module thinks it is, and guessing at quoting a surprise value
//      is how you corrupt someone's env file.
//
// Uses only node:fs / node:path / node:child_process (git). No networking: the
// key arrives as an argument, from provision.ts.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Write boundary for the env writer — swappable in tests. */
export interface EnvFileIO {
  exists(p: string): boolean;
  readFile(p: string): string | null;
  writeFile(p: string, content: string): void;
  remove(p: string): void;
  /** Whether git already follows this path, relative to `cwd`. */
  isTracked(cwd: string, target: string): boolean;
  /** Whether an ignore rule already excludes this path, relative to `cwd`. */
  isIgnored(cwd: string, target: string): boolean;
}

// Ask about the repo at `cwd`, never the one a surrounding git hook points at,
// and never let machine level config change the answer. Same reasoning as
// detect-core's inject/io.ts, which this deliberately mirrors.
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

/**
 * Neither query here compares the working tree against the index, so neither
 * makes git hash a working-tree file, so neither can run a repository's clean
 * filter. That is the property that makes them safe to run in a repository this
 * process did not create; see the SECURITY note in detect-core's inject/io.ts
 * for what goes wrong when that property is lost.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
  });
}

export const defaultEnvFileIO: EnvFileIO = {
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  // 0600 on create: this file now holds a live credential, and an env file's
  // usual 0644 would widen it to every account on the machine. `mode` is
  // ignored for a file that already exists, which is correct — inheriting
  // whatever the project chose beats silently tightening a file we did not
  // create.
  writeFile: (p, content) => writeFileSync(p, content, { mode: 0o600 }),
  remove: (p) => {
    rmSync(p, { force: true });
  },
  isTracked: (cwd, target) => {
    try {
      return git(cwd, ["ls-files", "--", target]).trim().length > 0;
    } catch {
      // git missing, or not a work tree. Nothing is tracked, so nothing can be
      // published by committing it.
      return false;
    }
  },
  isIgnored: (cwd, target) => {
    try {
      git(cwd, ["check-ignore", "-q", "--", target]);
      return true;
    } catch {
      // Exit 1 means "not ignored", and any other failure (no git, no work
      // tree) has to read the same way: assuming "ignored" on an unknown is how
      // a key ends up in a file nobody excluded.
      return false;
    }
  },
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** What may be written unquoted. Ingest keys are `ctkey_` + base62. */
const SAFE_VALUE = /^[A-Za-z0-9_\-.:]+$/;

export function isSafeEnvValue(value: string): boolean {
  return value.length > 0 && SAFE_VALUE.test(value);
}

/**
 * A variable's assignment line, ignoring comments.
 *
 * `export FOO=` is a real and common shape in env files that are also sourced
 * by a shell, and missing it would append a second FOO below the first, where
 * dotenv's last-wins and a shell's export disagree about which is live.
 */
function assignmentAt(line: string, name: string): RegExpMatchArray | null {
  if (/^\s*#/.test(line)) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return line.match(new RegExp(`^(\\s*(?:export\\s+)?${escaped}\\s*=)(.*)$`));
}

/** Strip one layer of matching quotes, so `FOO=""` reads as empty, not as `""`. */
function unquote(raw: string): string {
  const value = raw.trim();
  const quoted =
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.endsWith(value[0]);
  return quoted ? value.slice(1, -1) : value;
}

export interface UpsertResult {
  content: string;
  /** True when `content` differs from the input. */
  changed: boolean;
  /** True when the variable was already set to something and was left alone. */
  conflict: boolean;
}

/**
 * Set `name` to `value` in an env file's text.
 *
 * Idempotent in both directions that matter: setting the same value twice
 * changes nothing, and a variable that already holds a DIFFERENT value is
 * reported as a conflict and left exactly as it was.
 */
export function upsertEnvVar(
  content: string,
  name: string,
  value: string,
): UpsertResult {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = assignmentAt(lines[i], name);
    if (!match) continue;
    const existing = unquote(match[2]);
    if (existing === value) {
      return { content, changed: false, conflict: false };
    }
    if (existing.length > 0) {
      return { content, changed: false, conflict: true };
    }
    // Declared but empty — a placeholder someone left for exactly this.
    lines[i] = `${match[1]}${value}`;
    return { content: lines.join("\n"), changed: true, conflict: false };
  }
  // Append. A file that does not end in a newline would otherwise get the new
  // variable welded onto its last line.
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  const prefix = `${content}${needsNewline ? "\n" : ""}`;
  return {
    content: `${prefix}${name}=${value}\n`,
    changed: true,
    conflict: false,
  };
}

/** Read a variable from env-file text without exposing the whole file. */
export function readEnvVar(content: string, name: string): string | undefined {
  for (const line of content.split("\n")) {
    const match = assignmentAt(line, name);
    if (!match) continue;
    const value = unquote(match[2]);
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * The env file this app's key belongs in.
 *
 * The order follows the loader the generated SDK code actually uses. A bundled
 * variable prefers `.env.local`; a server variable prefers `.env`, because
 * `crumbtrail-node` loads `.env` at startup. An existing file in that order
 * wins over creating a new one, so the wizard does not split one app's config
 * across two env files.
 */
export function chooseEnvFile(
  appDir: string,
  varName: string,
  io: EnvFileIO,
): string {
  const bundled =
    /^(VITE_|NEXT_PUBLIC_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_)/.test(varName);
  const candidates = bundled ? [".env.local", ".env"] : [".env", ".env.local"];
  // Preserve a value already present in either candidate, even when the
  // loader-preferred file is the other one. Otherwise a repo with CRUMBTRAIL_KEY
  // in .env.local and an unrelated .env would receive a second live key.
  for (const candidate of candidates) {
    const full = path.join(appDir, candidate);
    if (
      io.exists(full) &&
      readEnvVar(io.readFile(full) ?? "", varName) !== undefined
    ) {
      return full;
    }
  }
  for (const candidate of candidates) {
    const full = path.join(appDir, candidate);
    if (io.exists(full)) return full;
  }
  return path.join(appDir, bundled ? ".env.local" : ".env");
}

/** Add one path to a .gitignore's text, if it is not already listed verbatim. */
export function appendIgnoreEntry(content: string, entry: string): string {
  const listed = content
    .split("\n")
    .some((line) => line.trim().replace(/^\/+/, "") === entry);
  if (listed) return content;
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  const lead = content.length > 0 ? `${needsNewline ? "\n" : ""}` : "";
  return `${content}${lead}\n# Added by crumbtrail: holds a live ingest key\n${entry}\n`;
}

// ── Decision + edits ─────────────────────────────────────────────────────────

/** A whole-file write of content decided before the apply. */
export interface EnvWriteEdit {
  kind: "write";
  path: string;
  mode: "create" | "update";
  content: string;
}

/**
 * "Make sure this .gitignore lists this path", resolved against the file's
 * CONTENT AT WRITE TIME rather than at plan time.
 *
 * Declarative on purpose. One wizard run wires every service in a monorepo
 * from one root .gitignore, so several edits target the same file. Content
 * computed while planning is content computed from the same pre-image for all
 * of them, and applying those in sequence keeps only the last entry — every
 * earlier service's env file is left holding a live key that nothing excludes.
 * An entry to ensure composes; a rendered file does not.
 */
export interface IgnoreEntryEdit {
  kind: "ignore-entry";
  path: string;
  entry: string;
}

export type EnvEdit = EnvWriteEdit | IgnoreEntryEdit;

export type EnvKeyPlan =
  /** The recipe reads no key variable (OTLP guidance, or a manual fallback). */
  | { kind: "no-variable" }
  /**
   * Already pointed at a key. Nothing to mint, nothing to write — but the file
   * still holds a live credential, so `ignore` carries the .gitignore entry it
   * is missing. A key from an older install used to get no entry and no warning
   * at all, which is a live key one `git add` away from being published.
   */
  | {
      kind: "already-set";
      file: string;
      varName: string;
      ignore: IgnoreEntryEdit | null;
    }
  /** git follows this file, so a key written here would be committed. */
  | { kind: "refused-tracked"; file: string; varName: string }
  /** Ready to mint. `edits` is completed by {@link buildEnvKeyEdits}. */
  | {
      kind: "ready";
      file: string;
      varName: string;
      mode: "create" | "update";
      prior: string;
      /** Set when the file is not ignored yet and an entry has to be added. */
      ignore: IgnoreEntryEdit | null;
    };

export interface PlanEnvKeyInput {
  /** The package being wired — where its env file lives. */
  appDir: string;
  /** The git work tree root, which owns the .gitignore an entry is added to. */
  repoRoot: string;
  /** The variable the injected code reads, from the injection plan. */
  varName: string | undefined;
  io: EnvFileIO;
}

/**
 * Decide what writing the key would mean, WITHOUT a key in hand.
 *
 * Deciding first is what stops the wizard minting a credential it then turns
 * out to have nowhere to put: a rerun against an already configured app would
 * otherwise leave a live unused key behind on every pass.
 */
export function planEnvKeyWrite(input: PlanEnvKeyInput): EnvKeyPlan {
  const { appDir, repoRoot, varName, io } = input;
  if (!varName) return { kind: "no-variable" };

  const file = chooseEnvFile(appDir, varName, io);
  const relToRepo = path.relative(repoRoot, file) || path.basename(file);

  if (io.isTracked(repoRoot, relToRepo)) {
    return { kind: "refused-tracked", file, varName };
  }

  const prior = io.exists(file) ? (io.readFile(file) ?? "") : "";
  // A probe value only: upsertEnvVar reports a conflict for any existing
  // non-empty value regardless of what it is compared against, and this never
  // reaches disk.
  // Resolved before the already-set branch, not after it: whether this file is
  // excluded from git is a fact about the file, not about whether THIS run put
  // the key there.
  let ignore: IgnoreEntryEdit | null = null;
  if (!io.isIgnored(repoRoot, relToRepo)) {
    ignore = {
      kind: "ignore-entry",
      path: path.join(repoRoot, ".gitignore"),
      entry: relToRepo,
    };
  }

  const probe = upsertEnvVar(prior, varName, "probe");
  if (probe.conflict) return { kind: "already-set", file, varName, ignore };

  return {
    kind: "ready",
    file,
    varName,
    mode: io.exists(file) ? "update" : "create",
    prior,
    ignore,
  };
}

/**
 * Turn a ready plan plus a freshly minted key into the exact files to write.
 * Throws on a value that cannot be written unquoted, rather than guessing.
 */
export function buildEnvKeyEdits(plan: EnvKeyPlan, key: string): EnvEdit[] {
  if (plan.kind !== "ready") return [];
  if (!isSafeEnvValue(key)) {
    throw new Error(
      "Refusing to write an ingest key with unexpected characters into an env file.",
    );
  }
  const next = upsertEnvVar(plan.prior, plan.varName, key);
  const edits: EnvEdit[] = [
    { kind: "write", path: plan.file, mode: plan.mode, content: next.content },
  ];
  if (plan.ignore) edits.push(plan.ignore);
  return edits;
}

export interface ApplyEnvEditsResult {
  /** Paths actually written, in apply order. */
  written: string[];
  /**
   * Ignore entries this apply really appended. An entry the file already
   * listed is absent, so a caller cannot announce protection it did not add.
   */
  ignoreEntriesAdded: string[];
}

/**
 * Apply env edits all-or-nothing, restoring every pre-image if any write fails.
 *
 * Deliberately separate from the injection executor's apply rather than folded
 * into it: if the key write fails, the wiring it accompanies is still correct
 * and worth keeping, and undoing someone's working injection over a failed
 * `.env` write would be a worse outcome than telling them to set one variable.
 */
export function applyEnvEdits(
  edits: EnvEdit[],
  io: EnvFileIO,
): ApplyEnvEditsResult {
  const preimages: {
    path: string;
    existed: boolean;
    content: string | null;
  }[] = [];
  const written: string[] = [];
  const ignoreEntriesAdded: string[] = [];
  try {
    for (const edit of edits) {
      const existed = io.exists(edit.path);
      const prior = existed ? io.readFile(edit.path) : null;
      let content: string;
      if (edit.kind === "ignore-entry") {
        // Re-read here, not at plan time: an earlier edit in this same apply
        // may have already appended another service's entry to this file.
        content = appendIgnoreEntry(prior ?? "", edit.entry);
        // Already listed — by a rule this run added, or by one that was
        // already there. Writing an identical file would report an addition
        // that did not happen.
        if (existed && content === prior) continue;
        ignoreEntriesAdded.push(edit.entry);
      } else {
        content = edit.content;
      }
      preimages.push({ path: edit.path, existed, content: prior });
      io.writeFile(edit.path, content);
      written.push(edit.path);
    }
    return { written, ignoreEntriesAdded };
  } catch (err) {
    for (const pre of preimages.reverse()) {
      if (!pre.existed) io.remove(pre.path);
      else if (pre.content != null) io.writeFile(pre.path, pre.content);
    }
    throw err;
  }
}
