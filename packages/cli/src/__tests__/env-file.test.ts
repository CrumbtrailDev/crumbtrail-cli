// The rules that decide whether a live ingest key goes on disk.
//
// These are the tests worth having: every case here is one where getting it
// wrong either publishes a credential or silently repoints someone's app at a
// different one.

import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  appendIgnoreEntry,
  applyEnvEdits,
  buildEnvKeyEdits,
  chooseEnvFile,
  isSafeEnvValue,
  planEnvKeyWrite,
  readEnvVar,
  upsertEnvVar,
  type EnvFileIO,
} from "../env-file";

function fakeIO(
  seed: Record<string, string> = {},
  opts: { tracked?: string[]; ignored?: string[] } = {},
): EnvFileIO & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const matches = (list: string[] | undefined, target: string) =>
    (list ?? []).some((t) => target === t || target.endsWith(`/${t}`));
  return {
    files,
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, content) => {
      files.set(p, content);
    },
    remove: (p) => {
      files.delete(p);
    },
    isTracked: (_cwd, target) => matches(opts.tracked, target),
    isIgnored: (_cwd, target) => matches(opts.ignored, target),
  };
}

const ROOT = "/repo";
const VAR = "VITE_CRUMBTRAIL_KEY";
const KEY = "ctkey_abc123";

describe("upsertEnvVar", () => {
  it("appends to a file that does not mention the variable", () => {
    const res = upsertEnvVar("EXISTING=1\n", VAR, KEY);
    expect(res.changed).toBe(true);
    expect(res.conflict).toBe(false);
    expect(res.content).toBe(`EXISTING=1\n${VAR}=${KEY}\n`);
  });

  it("does not weld the variable onto a file with no trailing newline", () => {
    const res = upsertEnvVar("EXISTING=1", VAR, KEY);
    expect(res.content).toBe(`EXISTING=1\n${VAR}=${KEY}\n`);
  });

  it("fills a declared but empty variable in place", () => {
    const res = upsertEnvVar(`A=1\n${VAR}=\nB=2\n`, VAR, KEY);
    expect(res.changed).toBe(true);
    expect(res.content).toBe(`A=1\n${VAR}=${KEY}\nB=2\n`);
  });

  it("treats an empty quoted value as empty, not as a value", () => {
    const res = upsertEnvVar(`${VAR}=""\n`, VAR, KEY);
    expect(res.conflict).toBe(false);
    expect(res.content).toBe(`${VAR}=${KEY}\n`);
  });

  // The one that matters: someone pointing an app at a specific key means it,
  // and a rerun of the wizard must not silently repoint their app.
  it("never overwrites a variable that already holds a value", () => {
    const before = `${VAR}=ctkey_theirs\n`;
    const res = upsertEnvVar(before, VAR, KEY);
    expect(res.conflict).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.content).toBe(before);
  });

  it("is a no-op when the same value is already set", () => {
    const res = upsertEnvVar(`${VAR}=${KEY}\n`, VAR, KEY);
    expect(res.changed).toBe(false);
    expect(res.conflict).toBe(false);
  });

  // `export FOO=` is real in env files that a shell also sources. Missing it
  // would append a second assignment, and dotenv's last-wins and a shell's
  // export would then disagree about which one is live.
  it("matches an exported assignment rather than appending a rival one", () => {
    const res = upsertEnvVar(`export ${VAR}=\n`, VAR, KEY);
    expect(res.content).toBe(`export ${VAR}=${KEY}\n`);
  });

  it("ignores a commented-out assignment", () => {
    const res = upsertEnvVar(`# ${VAR}=old\n`, VAR, KEY);
    expect(res.content).toBe(`# ${VAR}=old\n${VAR}=${KEY}\n`);
  });

  it("does not match a variable whose name merely shares a prefix", () => {
    const res = upsertEnvVar(`${VAR}_EXTRA=x\n`, VAR, KEY);
    expect(res.conflict).toBe(false);
    expect(res.content).toBe(`${VAR}_EXTRA=x\n${VAR}=${KEY}\n`);
  });
});

describe("isSafeEnvValue", () => {
  it("accepts an ingest key", () => {
    expect(isSafeEnvValue("ctkey_aZ09")).toBe(true);
  });

  it.each([["a b"], ['a"b'], ["a\nb"], ["a'b"], ["a$b"], [""]])(
    "rejects %j, which would need quoting to be written safely",
    (value) => {
      expect(isSafeEnvValue(value)).toBe(false);
    },
  );
});

describe("readEnvVar", () => {
  it("reads an existing value without exposing unrelated assignments", () => {
    expect(
      readEnvVar(
        "OTHER=1\nexport CRUMBTRAIL_KEY=ctkey_existing\n",
        "CRUMBTRAIL_KEY",
      ),
    ).toBe("ctkey_existing");
    expect(readEnvVar("CRUMBTRAIL_KEY=\n", "CRUMBTRAIL_KEY")).toBeUndefined();
  });
});

describe("chooseEnvFile", () => {
  it("prefers an existing .env.local", () => {
    const io = fakeIO({ "/app/.env.local": "", "/app/.env": "" });
    expect(chooseEnvFile("/app", VAR, io)).toBe("/app/.env.local");
  });

  it("prefers .env for a server key when both env files exist", () => {
    const io = fakeIO({ "/app/.env.local": "", "/app/.env": "" });
    expect(chooseEnvFile("/app", "CRUMBTRAIL_KEY", io)).toBe("/app/.env");
  });

  it("keeps a server key already present in the fallback file", () => {
    const io = fakeIO({
      "/app/.env.local": "CRUMBTRAIL_KEY=ctkey_existing\n",
      "/app/.env": "OTHER=1\n",
    });
    expect(chooseEnvFile("/app", "CRUMBTRAIL_KEY", io)).toBe("/app/.env.local");
  });

  it("uses an existing .env rather than creating a second file", () => {
    const io = fakeIO({ "/app/.env": "" });
    expect(chooseEnvFile("/app", VAR, io)).toBe("/app/.env");
  });

  it("creates .env.local for a bundled variable and .env for a server one", () => {
    const io = fakeIO();
    expect(chooseEnvFile("/app", "VITE_CRUMBTRAIL_KEY", io)).toBe(
      "/app/.env.local",
    );
    expect(chooseEnvFile("/app", "CRUMBTRAIL_KEY", io)).toBe("/app/.env");
  });
});

describe("planEnvKeyWrite", () => {
  it("has nothing to do when the recipe reads no variable", () => {
    const plan = planEnvKeyWrite({
      appDir: "/repo",
      repoRoot: ROOT,
      varName: undefined,
      io: fakeIO(),
    });
    expect(plan.kind).toBe("no-variable");
  });

  // The whole reason this module exists. Adding the file to .gitignore now
  // would NOT untrack it, so the next commit would publish the key.
  it("refuses a file git already tracks", () => {
    const io = fakeIO({ "/repo/.env": "" }, { tracked: [".env"] });
    const plan = planEnvKeyWrite({
      appDir: ROOT,
      repoRoot: ROOT,
      varName: VAR,
      io,
    });
    expect(plan.kind).toBe("refused-tracked");
  });

  it("reports an already configured variable rather than planning a write", () => {
    const io = fakeIO({ "/repo/.env.local": `${VAR}=ctkey_theirs\n` });
    const plan = planEnvKeyWrite({
      appDir: ROOT,
      repoRoot: ROOT,
      varName: VAR,
      io,
    });
    expect(plan.kind).toBe("already-set");
  });

  // A key from an older install is still a live key. The run writes nothing, but
  // the file it found is one `git add` away from publishing that credential, so
  // the missing .gitignore entry has to come back with the decision.
  it("carries the missing .gitignore entry for an already configured file", () => {
    const io = fakeIO({ "/repo/.env.local": `${VAR}=ctkey_theirs\n` });
    const plan = planEnvKeyWrite({
      appDir: ROOT,
      repoRoot: ROOT,
      varName: VAR,
      io,
    });
    if (plan.kind !== "already-set")
      throw new Error(`expected already-set, got ${plan.kind}`);
    expect(plan.ignore?.entry).toBe(".env.local");
    expect(plan.ignore?.path).toBe(path.join(ROOT, ".gitignore"));
  });

  it("carries no entry when the already configured file is ignored already", () => {
    const io = fakeIO(
      { "/repo/.env.local": `${VAR}=ctkey_theirs\n` },
      { ignored: [".env.local"] },
    );
    const plan = planEnvKeyWrite({
      appDir: ROOT,
      repoRoot: ROOT,
      varName: VAR,
      io,
    });
    if (plan.kind !== "already-set")
      throw new Error(`expected already-set, got ${plan.kind}`);
    expect(plan.ignore).toBeNull();
  });

  it("adds a .gitignore entry when the env file is not excluded yet", () => {
    const io = fakeIO();
    const plan = planEnvKeyWrite({
      appDir: ROOT,
      repoRoot: ROOT,
      varName: VAR,
      io,
    });
    if (plan.kind !== "ready")
      throw new Error(`expected ready, got ${plan.kind}`);
    expect(plan.ignore?.path).toBe(path.join(ROOT, ".gitignore"));
    expect(plan.ignore?.entry).toBe(".env.local");
  });

  it("adds no .gitignore entry when the file is already excluded", () => {
    const io = fakeIO({}, { ignored: [".env.local"] });
    const plan = planEnvKeyWrite({
      appDir: ROOT,
      repoRoot: ROOT,
      varName: VAR,
      io,
    });
    if (plan.kind !== "ready")
      throw new Error(`expected ready, got ${plan.kind}`);
    expect(plan.ignore).toBeNull();
  });

  it("ignores the env file of the package being wired, not the repo root", () => {
    const io = fakeIO({}, { ignored: [] });
    const plan = planEnvKeyWrite({
      appDir: "/repo/apps/web",
      repoRoot: ROOT,
      varName: VAR,
      io,
    });
    if (plan.kind !== "ready")
      throw new Error(`expected ready, got ${plan.kind}`);
    expect(plan.file).toBe("/repo/apps/web/.env.local");
    // The entry is the path FROM the repo root, since that is the .gitignore
    // it lands in — "apps/web/.env.local", never a bare ".env.local" that
    // would also swallow other packages' files.
    expect(plan.ignore?.entry).toBe("apps/web/.env.local");
  });
});

describe("buildEnvKeyEdits", () => {
  it("writes the key and the ignore entry together", () => {
    const io = fakeIO();
    const plan = planEnvKeyWrite({
      appDir: ROOT,
      repoRoot: ROOT,
      varName: VAR,
      io,
    });
    const edits = buildEnvKeyEdits(plan, KEY);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ kind: "write" });
    if (edits[0].kind !== "write") throw new Error("expected a write edit");
    expect(edits[0].content).toContain(`${VAR}=${KEY}`);
    expect(edits[1]).toEqual({
      kind: "ignore-entry",
      path: path.join(ROOT, ".gitignore"),
      entry: ".env.local",
    });
  });

  it("refuses a value that could not be written unquoted", () => {
    const plan = planEnvKeyWrite({
      appDir: ROOT,
      repoRoot: ROOT,
      varName: VAR,
      io: fakeIO(),
    });
    expect(() => buildEnvKeyEdits(plan, 'oops"\nEVIL=1')).toThrow(
      /unexpected characters/i,
    );
  });

  it("produces nothing for a plan that is not ready", () => {
    expect(buildEnvKeyEdits({ kind: "no-variable" }, KEY)).toEqual([]);
  });
});

describe("appendIgnoreEntry", () => {
  it("does not list an entry twice", () => {
    const once = appendIgnoreEntry("", ".env.local");
    expect(appendIgnoreEntry(once, ".env.local")).toBe(once);
  });

  it("treats a leading slash as the same rule", () => {
    expect(appendIgnoreEntry("/.env.local\n", ".env.local")).toBe(
      "/.env.local\n",
    );
  });
});

describe("applyEnvEdits", () => {
  it("writes every edit", () => {
    const io = fakeIO();
    const { written, ignoreEntriesAdded } = applyEnvEdits(
      [
        { kind: "write", path: "/repo/.env", mode: "create", content: "A=1\n" },
        { kind: "ignore-entry", path: "/repo/.gitignore", entry: ".env" },
      ],
      io,
    );
    expect(written).toHaveLength(2);
    expect(ignoreEntriesAdded).toEqual([".env"]);
    expect(io.files.get("/repo/.gitignore")).toContain(".env");
    expect(io.files.get("/repo/.env")).toBe("A=1\n");
  });

  // A half-applied key write leaves a .gitignore claiming to protect a file
  // that holds nothing, or a key in a file nothing excludes.
  it("restores every pre-image when a later write fails", () => {
    const io = fakeIO({ "/repo/.env": "ORIGINAL=1\n" });
    const failing: EnvFileIO = {
      ...io,
      writeFile: (p, content) => {
        if (p.endsWith(".gitignore")) throw new Error("disk full");
        io.writeFile(p, content);
      },
    };
    expect(() =>
      applyEnvEdits(
        [
          {
            kind: "write",
            path: "/repo/.env",
            mode: "update",
            content: "CHANGED=1\n",
          },
          { kind: "ignore-entry", path: "/repo/.gitignore", entry: ".env" },
        ],
        failing,
      ),
    ).toThrow(/disk full/);
    expect(io.files.get("/repo/.env")).toBe("ORIGINAL=1\n");
    expect(io.files.has("/repo/.gitignore")).toBe(false);
  });

  // The multi-service clobber: several services in one repo share one root
  // .gitignore, and an entry rendered while planning is rendered from the same
  // pre-image for all of them.
  it("keeps every service's entry when several target one .gitignore", () => {
    const io = fakeIO();
    const services = ["services/api", "services/web", "services/worker"];
    const plans = services.map((dir) =>
      planEnvKeyWrite({
        appDir: path.join(ROOT, dir),
        repoRoot: ROOT,
        varName: "CRUMBTRAIL_KEY",
        io,
      }),
    );

    const added: string[] = [];
    for (const plan of plans) {
      added.push(
        ...applyEnvEdits(buildEnvKeyEdits(plan, KEY), io).ignoreEntriesAdded,
      );
    }

    const ignore = io.files.get(path.join(ROOT, ".gitignore")) ?? "";
    for (const dir of services) {
      expect(io.files.get(path.join(ROOT, dir, ".env"))).toContain(KEY);
      expect(ignore).toContain(`${dir}/.env`);
    }
    // And every entry announced is an entry that landed.
    expect(added).toEqual(services.map((dir) => `${dir}/.env`));
  });

  it("reports no addition for an entry the file already lists", () => {
    const io = fakeIO({ "/repo/.gitignore": ".env\n" });
    const { written, ignoreEntriesAdded } = applyEnvEdits(
      [{ kind: "ignore-entry", path: "/repo/.gitignore", entry: ".env" }],
      io,
    );
    expect(written).toEqual([]);
    expect(ignoreEntriesAdded).toEqual([]);
    expect(io.files.get("/repo/.gitignore")).toBe(".env\n");
  });
});
