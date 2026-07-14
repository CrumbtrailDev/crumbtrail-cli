import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { defaultInjectIO } from "../inject/io";
import { cleanup, gitInit, makeTmpRepo } from "./helpers";

let repo: string | undefined;
afterEach(() => {
  if (repo) cleanup(repo);
  repo = undefined;
});

describe("defaultInjectIO.readGitignore", () => {
  it("finds the ROOT .gitignore from inside a workspace package", () => {
    // The monorepo case: `.env` is ignored at the repo root, and nothing in
    // packages/api/ mentions it. Reading only the package's own .gitignore would
    // wrongly warn that the service's ingest key is about to be committed.
    repo = makeTmpRepo({
      ".gitignore": "node_modules\n.env\n",
      "packages/api/package.json": "{}",
    });
    gitInit(repo);

    const text = defaultInjectIO.readGitignore(path.join(repo, "packages/api"));
    expect(text).not.toBeNull();
    expect(/^\s*\.env\b/m.test(text as string)).toBe(true);
  });

  it("still reads a package-local .gitignore, and merges it with the root", () => {
    repo = makeTmpRepo({
      ".gitignore": "node_modules\n",
      "packages/api/.gitignore": ".env\n",
      "packages/api/package.json": "{}",
    });
    gitInit(repo);

    const text = defaultInjectIO.readGitignore(
      path.join(repo, "packages/api"),
    ) as string;
    expect(/^\s*\.env\b/m.test(text)).toBe(true);
    expect(text).toContain("node_modules");
  });

  it("reports nothing ignored when no .gitignore covers the package", () => {
    repo = makeTmpRepo({
      ".gitignore": "node_modules\n",
      "packages/api/package.json": "{}",
    });
    gitInit(repo);

    const text = defaultInjectIO.readGitignore(
      path.join(repo, "packages/api"),
    ) as string;
    // Found a .gitignore, but it does NOT cover .env — the warning must fire.
    expect(/^\s*\.env\b/m.test(text)).toBe(false);
  });

  it("stops climbing at the git root", () => {
    // A .gitignore ABOVE the repo root belongs to some unrelated parent
    // directory and has no authority over this repo.
    const outer = makeTmpRepo({
      ".gitignore": ".env\n",
      "inner/package.json": "{}",
    });
    repo = outer;
    gitInit(path.join(outer, "inner"));

    const text = defaultInjectIO.readGitignore(path.join(outer, "inner"));
    // No .gitignore inside the inner repo → nothing found, despite the parent's.
    expect(text).toBeNull();
  });
});
