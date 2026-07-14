import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { detect } from "../detect";
import { discoverServices, looksLikeLibrary } from "../discover";
import { cleanup, makeTmpRepo } from "./helpers";

let repo: string | undefined;
afterEach(() => {
  if (repo) cleanup(repo);
  repo = undefined;
});

const pkg = (o: Record<string, unknown>) => JSON.stringify(o);

/**
 * A realistic polyglot monorepo: JS workspaces + non-JS services that have no
 * package.json at all (and so are invisible to workspace discovery).
 */
function makeMonorepo(): string {
  return makeTmpRepo({
    "package.json": pkg({ name: "shop", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",

    // A real frontend app.
    "apps/web/package.json": pkg({
      name: "web",
      dependencies: { vite: "^5.0.0" },
      scripts: { dev: "vite" },
    }),
    "apps/web/index.html":
      '<div id=root></div><script type="module" src="/src/main.ts"></script>',
    "apps/web/src/main.ts": "console.log('hi')",

    // A real backend.
    "packages/api/package.json": pkg({
      name: "api",
      main: "index.js",
      dependencies: { express: "^4.0.0" },
      scripts: { start: "node index.js" },
    }),
    "packages/api/index.js": "require('express')()",

    // A BUILT shared library. main → a file that exists, so detect() lands on
    // the `node` recipe and it looks perfectly wireable. It isn't: nothing runs
    // it, so it would never emit a session.
    "packages/shared-types/package.json": pkg({
      name: "shared-types",
      main: "dist/index.js",
    }),
    "packages/shared-types/dist/index.js": "module.exports = {}",

    // Config-only package: nothing to wire at all.
    "packages/tsconfig/package.json": pkg({ name: "tsconfig" }),

    // Non-JS services — no package.json, so pnpm workspaces cannot see them.
    "services/payments/Gemfile": "gem 'rails'",
    "services/etl/manage.py": "#!/usr/bin/env python",

    // Must never be scanned.
    "node_modules/evil/package.json": pkg({ name: "evil", main: "i.js" }),
    "node_modules/evil/i.js": "",
  });
}

describe("discoverServices", () => {
  it("finds JS workspaces AND non-JS services, and skips node_modules", () => {
    repo = makeMonorepo();
    const found = discoverServices(repo, detect(repo));
    const byRel = Object.fromEntries(found.map((c) => [c.relDir, c]));

    expect(Object.keys(byRel).sort()).toEqual([
      "apps/web",
      "packages/api",
      "packages/shared-types",
      "packages/tsconfig",
      "services/etl",
      "services/payments",
    ]);
    expect(found.some((c) => c.relDir.includes("node_modules"))).toBe(false);

    expect(byRel["apps/web"].recipe).toBe("vite-spa");
    expect(byRel["packages/api"].recipe).toBe("express");

    // The whole point of the extra scan: a Rails service with no package.json.
    expect(byRel["services/payments"].recipe).toBe("otlp");
    expect(byRel["services/payments"].detected.otlpStack).toBe("rails");
    expect(byRel["services/payments"].source).toBe("scan");
    expect(byRel["services/etl"].detected.otlpStack).toBe("django");
  });

  it("checks real apps by default, and only those", () => {
    repo = makeMonorepo();
    const found = discoverServices(repo, detect(repo));
    const checked = found.filter((c) => c.defaultChecked).map((c) => c.relDir);

    // Real apps in. Library, config package, and both OTLP services out —
    // they're listed and selectable, just not chosen for you.
    expect(checked.sort()).toEqual(["apps/web", "packages/api"]);
  });

  it("flags a built shared library rather than treating it as an app", () => {
    repo = makeMonorepo();
    const lib = discoverServices(repo, detect(repo)).find(
      (c) => c.relDir === "packages/shared-types",
    );
    // detect() confidently calls it a `node` app — this is the false positive
    // the guard exists for.
    expect(lib?.detected.recipe).toBe("node");
    expect(lib?.detected.ambiguous).toBe(false);
    expect(lib?.flags).toContain("likely-library");
    expect(lib?.defaultChecked).toBe(false);
    // Still selectable: if it really is a service, the user can check it.
    expect(lib?.selectable).toBe(true);
  });

  it("lists a package with no recipe but refuses to select it", () => {
    repo = makeMonorepo();
    const cfg = discoverServices(repo, detect(repo)).find(
      (c) => c.relDir === "packages/tsconfig",
    );
    expect(cfg?.recipe).toBeNull();
    expect(cfg?.selectable).toBe(false);
    expect(cfg?.flags).toContain("no-recipe");
  });

  it("marks an already-wired package and does not check it", () => {
    repo = makeTmpRepo({
      "package.json": pkg({ name: "shop", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "apps/web/package.json": pkg({
        name: "web",
        dependencies: { vite: "^5.0.0", "crumbtrail-core": "^0.1.0" },
        scripts: { dev: "vite" },
      }),
      "apps/web/index.html":
        '<div id=root></div><script type="module" src="/src/main.ts"></script>',
      "apps/web/src/main.ts": "",
    });
    const web = discoverServices(repo, detect(repo))[0];
    expect(web.flags).toContain("already-wired");
    expect(web.defaultChecked).toBe(false);
  });

  it("treats an OTLP service with an existing guide as already wired", () => {
    repo = makeTmpRepo({
      "package.json": pkg({ name: "shop", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "services/payments/Gemfile": "gem 'rails'",
      "services/payments/CRUMBTRAIL-OTLP.md": "# already here",
    });
    const svc = discoverServices(repo, detect(repo)).find(
      (c) => c.relDir === "services/payments",
    );
    expect(svc?.flags).toContain("already-wired");
    expect(svc?.defaultChecked).toBe(false);
  });

  it("lists a dir that is both a workspace and under packages/* exactly once", () => {
    repo = makeMonorepo();
    const api = discoverServices(repo, detect(repo)).filter(
      (c) => c.relDir === "packages/api",
    );
    expect(api).toHaveLength(1);
    expect(api[0].source).toBe("workspace");
  });

  it("does not report the root itself as a service", () => {
    repo = makeMonorepo();
    const found = discoverServices(repo, detect(repo));
    expect(found.map((c) => c.dir)).not.toContain(path.resolve(repo));
  });
});

describe("looksLikeLibrary", () => {
  it("only fires on `node`, and only without a start/dev script or bin", () => {
    expect(looksLikeLibrary("node", { main: "dist/index.js" } as never)).toBe(
      true,
    );
    expect(looksLikeLibrary("node", { scripts: { start: "node ." } })).toBe(
      false,
    );
    expect(looksLikeLibrary("node", { scripts: { dev: "tsx watch ." } })).toBe(
      false,
    );
    expect(looksLikeLibrary("node", { bin: "./cli.js" })).toBe(false);
    // Never downgrades a real framework.
    expect(looksLikeLibrary("express", {})).toBe(false);
    expect(looksLikeLibrary("next", {})).toBe(false);
    expect(looksLikeLibrary(null, {})).toBe(false);
  });
});
