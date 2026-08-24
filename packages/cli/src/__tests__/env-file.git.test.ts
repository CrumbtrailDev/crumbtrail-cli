// The real filesystem + real git half of the env writer.
//
// env-file.test.ts fakes `isTracked` / `isIgnored`, which is the right shape for
// testing the RULES but proves nothing about the two git queries those rules
// hang off. Getting either backwards is the difference between a key that is
// safely ignored and a key that is committed, so they are exercised here against
// an actual repository.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyEnvEdits,
  buildEnvKeyEdits,
  defaultEnvFileIO,
  planEnvKeyWrite,
} from "../env-file";

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "crumbtrail-envgit-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const VAR = "VITE_CRUMBTRAIL_KEY";
const KEY = "ctkey_realgit123";

describe("env key writing against a real git repository", () => {
  it("writes the key, adds the ignore entry, and git then ignores the file", () => {
    const plan = planEnvKeyWrite({
      appDir: repo,
      repoRoot: repo,
      varName: VAR,
      io: defaultEnvFileIO,
    });
    if (plan.kind !== "ready")
      throw new Error(`expected ready, got ${plan.kind}`);

    applyEnvEdits(buildEnvKeyEdits(plan, KEY), defaultEnvFileIO);

    // The end state that matters: git itself now excludes the file holding the
    // key, checked by asking git rather than by re-reading our own .gitignore.
    expect(defaultEnvFileIO.isIgnored(repo, ".env.local")).toBe(true);
    expect(defaultEnvFileIO.readFile(path.join(repo, ".env.local"))).toContain(
      `${VAR}=${KEY}`,
    );
    // A file holding a live credential is not left world readable.
    expect(statSync(path.join(repo, ".env.local")).mode & 0o777).toBe(0o600);
  });

  it("refuses a committed env file, so the key is never staged", () => {
    writeFileSync(path.join(repo, ".env"), "EXISTING=1\n");
    git("add", ".env");
    git("commit", "-qm", "add env");

    expect(defaultEnvFileIO.isTracked(repo, ".env")).toBe(true);
    const plan = planEnvKeyWrite({
      appDir: repo,
      repoRoot: repo,
      varName: "CRUMBTRAIL_KEY",
      io: defaultEnvFileIO,
    });
    expect(plan.kind).toBe("refused-tracked");
    expect(buildEnvKeyEdits(plan, KEY)).toEqual([]);
  });

  it("adds no entry when .gitignore already covers the file", () => {
    writeFileSync(path.join(repo, ".gitignore"), ".env*\n");
    const plan = planEnvKeyWrite({
      appDir: repo,
      repoRoot: repo,
      varName: VAR,
      io: defaultEnvFileIO,
    });
    if (plan.kind !== "ready")
      throw new Error(`expected ready, got ${plan.kind}`);
    // `.env*` already matches, and appending an exact `.env.local` line on top
    // of a working wildcard is noise in someone else's file.
    expect(plan.ignore).toBeNull();
  });

  it("ignores a nested package's env file by its path from the repo root", () => {
    const appDir = path.join(repo, "apps", "web");
    mkdirSync(appDir, { recursive: true });

    const plan = planEnvKeyWrite({
      appDir,
      repoRoot: repo,
      varName: VAR,
      io: defaultEnvFileIO,
    });
    if (plan.kind !== "ready")
      throw new Error(`expected ready, got ${plan.kind}`);
    applyEnvEdits(buildEnvKeyEdits(plan, KEY), defaultEnvFileIO);

    // A bare ".env.local" rule would also swallow every other package's file.
    expect(defaultEnvFileIO.isIgnored(repo, "apps/web/.env.local")).toBe(true);
    expect(defaultEnvFileIO.readFile(path.join(repo, ".gitignore"))).toContain(
      "apps/web/.env.local",
    );
  });

  // Three services, one root .gitignore, one run. The reported failure was
  // that only the last service's entry survived, so the other two env files
  // held a live key and showed up untracked-and-unignored in `git status`.
  it("ignores every service's env file when one run wires three of them", () => {
    const services = ["services/api", "services/web", "services/worker"];
    for (const dir of services) {
      mkdirSync(path.join(repo, dir), { recursive: true });
    }

    // Every decision is taken before any write, which is the order the wizard
    // uses so that a refusal costs no minted credential — and the order that
    // made plan-time .gitignore content clobber itself.
    const plans = services.map((dir) => {
      const plan = planEnvKeyWrite({
        appDir: path.join(repo, dir),
        repoRoot: repo,
        varName: "CRUMBTRAIL_KEY",
        io: defaultEnvFileIO,
      });
      if (plan.kind !== "ready")
        throw new Error(`expected ready for ${dir}, got ${plan.kind}`);
      return plan;
    });

    const announced: string[] = [];
    for (const plan of plans) {
      announced.push(
        ...applyEnvEdits(buildEnvKeyEdits(plan, KEY), defaultEnvFileIO)
          .ignoreEntriesAdded,
      );
    }

    for (const dir of services) {
      expect(
        defaultEnvFileIO.readFile(path.join(repo, dir, ".env")),
      ).toContain(KEY);
      // Asked of git, not of our own file: this is the property that matters.
      expect(defaultEnvFileIO.isIgnored(repo, `${dir}/.env`)).toBe(true);
    }
    expect(announced).toEqual(services.map((dir) => `${dir}/.env`));

    // Nothing holding a key is left visible to `git add .`.
    const untracked = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(untracked).not.toMatch(/\.env$/m);
  });

  it("treats a directory that is not a git repository as nothing tracked", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "crumbtrail-nogit-"));
    try {
      expect(defaultEnvFileIO.isTracked(plain, ".env")).toBe(false);
      // Not a repo means nothing is ignored either, so the plan still adds an
      // entry — harmless in a plain directory, and correct the moment someone
      // runs `git init` in it.
      expect(defaultEnvFileIO.isIgnored(plain, ".env")).toBe(false);
      const plan = planEnvKeyWrite({
        appDir: plain,
        repoRoot: plain,
        varName: VAR,
        io: defaultEnvFileIO,
      });
      expect(plan.kind).toBe("ready");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
