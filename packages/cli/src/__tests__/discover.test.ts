import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { detect } from "../detect";
// memoryReader is test-only and deliberately absent from the public barrel.
import { memoryReader } from "../testing";
import { discoverServices, looksLikeLibrary } from "../discover";
import { cleanup, makeTmpRepo } from "./helpers";

let repo: string | undefined;
afterEach(() => {
  if (repo) cleanup(repo);
  repo = undefined;
});

const pkg = (o: Record<string, unknown>) => JSON.stringify(o);
const ENDPOINT = "https://ingest.example.com";

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

    // An UNBUILT shared library. main → a source file that exists, so detect()
    // lands on the `node` recipe and it looks perfectly wireable. It isn't:
    // nothing runs it, so it would never emit a session.
    "packages/shared-types/package.json": pkg({
      name: "shared-types",
      main: "index.js",
    }),
    "packages/shared-types/index.js": "module.exports = {}",

    // A library whose ONLY entry is build output. Injecting into dist is
    // erased by the next build, so there is nothing here to wire at all.
    "packages/built-only/package.json": pkg({
      name: "built-only",
      main: "dist/index.js",
    }),
    "packages/built-only/dist/index.js": "module.exports = {}",

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
      "packages/built-only",
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

  it("refuses a package whose only entry is build output", () => {
    repo = makeMonorepo();
    const built = discoverServices(repo, detect(repo)).find(
      (c) => c.relDir === "packages/built-only",
    );
    // `main: dist/index.js` used to resolve and looked wireable. Injecting
    // there is erased by the next build, so it is not an entry at all.
    expect(built?.recipe).toBeNull();
    expect(built?.selectable).toBe(false);
    expect(built?.detected.reasons.join(" ")).toMatch(/build output/);
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
      "apps/web/src/main.ts": [
        'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
        "Crumbtrail.init({",
        "  ...PRESET_PASSIVE,",
        `  httpEndpoint: "${ENDPOINT}",`,
        "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,",
        "  remoteConfig: true,",
        '  service: "web",',
        "});",
      ].join("\n"),
      "apps/web/.env.local": "VITE_CRUMBTRAIL_KEY=ctkey_test\n",
      // Declared AND installed. A declaration on its own is a stale range, not
      // a wired app.
      "node_modules/crumbtrail-core/package.json": pkg({
        name: "crumbtrail-core",
      }),
    });
    const web = discoverServices(repo, detect(repo), undefined, {
      endpoint: ENDPOINT,
    })[0];
    expect(web.flags).toContain("already-wired");
    expect(web.defaultChecked).toBe(false);
  });

  it("does not mark a package whose SDK range was never installed", () => {
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
    expect(web.flags).not.toContain("already-wired");
    expect(web.defaultChecked).toBe(true);
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

  it("finds the same services through memoryReader", () => {
    const files = {
      "package.json": pkg({ name: "shop", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "apps/web/package.json": pkg({
        name: "web",
        dependencies: { vite: "^5.0.0" },
      }),
      "apps/web/index.html":
        '<script type="module" src="/src/main.ts"></script>',
      "apps/web/src/main.ts": "",
      "services/payments/Gemfile": "gem 'rails'",
    };
    repo = makeTmpRepo(files);
    const reader = memoryReader(
      Object.fromEntries(
        Object.entries(files).map(([file, content]) => [
          path.join(repo!, file),
          content,
        ]),
      ),
    );

    expect(discoverServices(repo, detect(repo))).toEqual(
      discoverServices(reader.root, detect(reader.root, reader), reader),
    );
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

  it("counts a build-only dev script as a library, not a service", () => {
    expect(looksLikeLibrary("node", { scripts: { dev: "tsc --watch" } })).toBe(
      true,
    );
    expect(looksLikeLibrary("node", { scripts: { dev: "tsup --watch" } })).toBe(
      true,
    );
    expect(
      looksLikeLibrary("node", { scripts: { dev: "pnpm exec tsc -w" } }),
    ).toBe(true);
  });

  it("clears the flag when the entry runs a process or a manifest deploys it", () => {
    const pkg = { main: "dist/index.js" } as never;
    expect(looksLikeLibrary("node", pkg)).toBe(true);
    expect(
      looksLikeLibrary("node", pkg, {
        entrySource: "setInterval(() => tick(), 1000);",
      }),
    ).toBe(false);
    expect(
      looksLikeLibrary("node", pkg, {
        entrySource: "server.listen(3000);",
      }),
    ).toBe(false);
    expect(
      looksLikeLibrary("node", pkg, {
        deployManifests: '{ "deploy": { "startCommand": "node index.js" } }',
      }),
    ).toBe(false);
    // A library body is still a library.
    expect(
      looksLikeLibrary("node", pkg, { entrySource: "export const x = 1;" }),
    ).toBe(true);
  });
});

// Defect class: a repo root whose services are plain sibling directories with
// no workspace file linking them. Detection can already name them, so they are
// wireable from the root — not a reason to send the user to cd into each one.
describe("unlinked sibling services", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) cleanup(root);
    root = undefined;
  });

  const makeSiblingRepo = () =>
    makeTmpRepo({
      // Root manifest carries no framework deps and links nothing.
      "package.json": pkg({ name: "asiniq", private: true }),
      "admin/package.json": pkg({
        name: "admin",
        devDependencies: { vite: "^5.0.0" },
        scripts: { dev: "vite" },
      }),
      "admin/index.html":
        '<div id=root></div><script type="module" src="/src/main.tsx"></script>',
      "admin/src/main.tsx": "",
      "api/package.json": pkg({
        name: "api",
        main: "dist/index.js",
        dependencies: { hono: "^4.0.0" },
        scripts: { dev: "tsx watch src/index.ts", build: "tsc" },
      }),
      "api/tsconfig.json": JSON.stringify({
        compilerOptions: { rootDir: "src", outDir: "dist" },
      }),
      "api/src/index.ts": "import { Hono } from 'hono'",
      "api/dist/index.js": "// built",
      "chrome-extension/manifest.json": "{}",
    });

  it("is invisible without the flag, since a workspace file is authoritative", () => {
    root = makeSiblingRepo();
    const found = discoverServices(root, detect(root), undefined, {
      endpoint: ENDPOINT,
    });
    expect(found.map((c) => c.relDir)).toEqual([]);
  });

  it("offers both services from the root, pre-checked, wired at the source", () => {
    root = makeSiblingRepo();
    const found = discoverServices(root, detect(root), undefined, {
      endpoint: ENDPOINT,
      includeUnlinkedApps: true,
    });
    const byRel = Object.fromEntries(found.map((c) => [c.relDir, c]));
    expect(Object.keys(byRel).sort()).toEqual(["admin", "api"]);
    expect(byRel.admin.recipe).toBe("vite-spa");
    expect(byRel.api.recipe).toBe("hono");
    expect(found.filter((c) => c.defaultChecked).map((c) => c.relDir).sort()).toEqual(
      ["admin", "api"],
    );
    // Never the build output that `main` points at.
    expect(byRel.api.detected.entryFile).toBe(
      path.join(root!, "api", "src", "index.ts"),
    );
  });
});
