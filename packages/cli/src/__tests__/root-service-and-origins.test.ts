// Two interlocking defect classes, both from the "root API + nested frontend"
// layout (a Hono/Express server at the repo root, the web app as the only
// declared workspace):
//
//   1. The root package is itself the backend, but a monorepo root was forced
//      ambiguous and never listed by the batch scan — so full stack capture was
//      unreachable from setup on that layout.
//   2. Every wizard install emitted `networkCorrelationAllowedOrigins: []`,
//      because nothing ever passed the origins the builders already accepted.
//      With the list empty the SDK stamps correlation headers on same origin
//      calls only, so the shared_request_id join never happens.

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { detect } from "../detect";
import { discoverServices } from "../discover";
import { buildPlan } from "../inject";
import {
  declaredBackendOrigins,
  isBackendRecipe,
  resolveBackendOrigins,
  resolveServicePort,
} from "../backend-origins";
import { localFsReader } from "../readers/local-fs";
import { cleanup, makeTmpRepo } from "./helpers";

const pkg = (o: Record<string, unknown>) => JSON.stringify(o);
const ENDPOINT = "https://ingest.example.com";

let repo: string | undefined;
afterEach(() => {
  if (repo) cleanup(repo);
  repo = undefined;
});

/** The marginary shape: root Hono API with `dev: tsx watch api/src/index.ts`. */
function makeRootApiRepo(extra: Record<string, string> = {}): string {
  return makeTmpRepo({
    "package.json": pkg({
      name: "marginary",
      private: true,
      type: "module",
      scripts: { dev: "tsx watch api/src/index.ts" },
      dependencies: { hono: "^4.0.0", "@hono/node-server": "^2.0.0" },
    }),
    "pnpm-workspace.yaml": "packages:\n  - frontend\n",
    "api/src/index.ts": "import { serve } from '@hono/node-server'\nserve({})",

    "frontend/package.json": pkg({
      name: "marginary-frontend",
      dependencies: { react: "^19.0.0" },
      devDependencies: { vite: "^7.0.0" },
      scripts: { dev: "vite" },
    }),
    "frontend/index.html":
      '<div id=root></div><script type="module" src="/src/main.tsx"></script>',
    "frontend/src/main.tsx": "console.log('hi')",
    "frontend/vite.config.ts": [
      "export default {",
      "  server: {",
      "    port: 19410,",
      "    proxy: { '/api': { target: 'http://127.0.0.1:19870', changeOrigin: true } },",
      "  },",
      "}",
    ].join("\n"),
    ...extra,
  });
}

describe("a monorepo root that is itself a service", () => {
  it("keeps the root's own recipe and entry instead of forcing ambiguity", () => {
    repo = makeRootApiRepo();
    const result = detect(repo);
    expect(result.isMonorepo).toBe(true);
    expect(result.recipe).toBe("hono");
    expect(result.ambiguous).toBe(false);
    expect(result.entryFile).toBe(path.join(repo, "api", "src", "index.ts"));
  });

  it("offers the root for wiring alongside the nested workspace", () => {
    repo = makeRootApiRepo();
    const candidates = discoverServices(repo, detect(repo), undefined, {
      endpoint: ENDPOINT,
    });
    const rows = candidates.map((c) => [c.relDir, c.recipe, c.defaultChecked]);
    expect(rows).toEqual([
      [".", "hono", true],
      ["frontend", "vite-spa", true],
    ]);
  });

  it("plans a real prepend into the root service's source entry", () => {
    repo = makeRootApiRepo();
    const root = detect(repo);
    const plan = buildPlan(
      {
        cwd: repo,
        recipe: root.recipe!,
        endpoint: ENDPOINT,
        entryFile: root.entryFile,
        serviceName: "api",
        options: { force: true },
      },
      undefined,
    );
    expect(plan.targetPath).toBe(path.join(repo, "api", "src", "index.ts"));
    expect(plan.content).toContain("crumbtrail-node");
  });

  it("still refuses to guess when the root only carries framework deps", () => {
    // No dev/start script and no resolvable entry: the root is a workspace
    // shell that happens to depend on hono, not a service.
    repo = makeTmpRepo({
      "package.json": pkg({
        name: "shell",
        private: true,
        dependencies: { hono: "^4.0.0" },
      }),
      "pnpm-workspace.yaml": "packages:\n  - frontend\n",
      "frontend/package.json": pkg({
        name: "web",
        devDependencies: { vite: "^7.0.0" },
        scripts: { dev: "vite" },
      }),
      "frontend/index.html":
        '<div id=root></div><script type="module" src="/src/main.tsx"></script>',
      "frontend/src/main.tsx": "console.log('hi')",
    });
    const result = detect(repo);
    expect(result.ambiguous).toBe(true);
    expect(result.entryFile).toBeNull();
    const candidates = discoverServices(repo, result, undefined, {
      endpoint: ENDPOINT,
    });
    expect(candidates.map((c) => c.relDir)).toEqual(["frontend"]);
  });
});

describe("backend origin resolution", () => {
  it("reads a dev proxy target as an origin this app calls", () => {
    repo = makeRootApiRepo();
    const frontend = path.join(repo, "frontend");
    expect(declaredBackendOrigins(frontend, localFsReader(frontend))).toEqual([
      "http://127.0.0.1:19870",
    ]);
  });

  it("reads an absolute API base URL out of the app's own env file", () => {
    repo = makeRootApiRepo({
      "frontend/.env": [
        "# comment",
        "VITE_API_ORIGIN=https://api.example.com/v1",
        "VITE_TITLE=Marginary",
        "VITE_API_PATH=/api",
      ].join("\n"),
    });
    const frontend = path.join(repo, "frontend");
    const origins = declaredBackendOrigins(frontend, localFsReader(frontend));
    // Path stripped to the origin; the relative path var and the non-API var
    // contribute nothing.
    expect(origins).toEqual([
      "http://127.0.0.1:19870",
      "https://api.example.com",
    ]);
  });

  it("takes a sibling backend's declared PORT, both loopback spellings", () => {
    repo = makeRootApiRepo({ ".env": "PORT=19870\nDATABASE_URL=postgres://x\n" });
    expect(resolveServicePort(repo, null, localFsReader(repo))).toBe(19870);

    const frontend = path.join(repo, "frontend");
    const origins = resolveBackendOrigins(frontend, localFsReader(repo), [
      { dir: repo, detected: { entryFile: null } },
    ]);
    expect(origins).toEqual([
      "http://127.0.0.1:19870",
      "http://localhost:19870",
    ]);
  });

  it("reads a port literal out of the entry when no env file declares one", () => {
    repo = makeRootApiRepo({
      "api/src/index.ts": "serve({ fetch: app.fetch, port: 8123 })\n",
    });
    const entry = path.join(repo, "api", "src", "index.ts");
    expect(resolveServicePort(repo, entry, localFsReader(repo))).toBe(8123);
  });

  it("reads the fallback from a validated PORT ternary", () => {
    repo = makeRootApiRepo({
      "api/src/index.ts": [
        "const raw = (process.env.PORT ?? '').trim()",
        "const parsed = Number.parseInt(raw, 10)",
        "const port = Number.isInteger(parsed) ? parsed : 8765",
        "serve({ fetch: app.fetch, port })",
      ].join("\n"),
    });
    const entry = path.join(repo, "api", "src", "index.ts");
    expect(resolveServicePort(repo, entry, localFsReader(repo))).toBe(8765);
  });

  it("does not mistake an unrelated cache port ternary for the HTTP port", () => {
    repo = makeRootApiRepo({
      "api/src/index.ts": [
        "const cachePort = tls ? 6380 : 6379",
        "serve({ fetch: app.fetch, port: process.env.PORT })",
      ].join("\n"),
    });
    const entry = path.join(repo, "api", "src", "index.ts");
    expect(resolveServicePort(repo, entry, localFsReader(repo))).toBeNull();
  });

  it("returns nothing rather than a framework default when the repo is silent", () => {
    repo = makeTmpRepo({
      "package.json": pkg({
        name: "api",
        scripts: { start: "node index.js" },
        dependencies: { express: "^4.0.0" },
      }),
      "index.js": "require('express')().listen(process.env.PORT)",
    });
    expect(
      resolveServicePort(repo, path.join(repo, "index.js"), localFsReader(repo)),
    ).toBeNull();
    expect(resolveBackendOrigins(repo, localFsReader(repo))).toEqual([]);
  });

  it("never lists an app's own directory as one of its backends", () => {
    repo = makeRootApiRepo({ ".env": "PORT=19870\n" });
    expect(
      resolveBackendOrigins(repo, localFsReader(repo), [
        { dir: repo, detected: { entryFile: null } },
      ]),
    ).toEqual([]);
  });

  it("classifies which recipes can contribute an origin", () => {
    expect(isBackendRecipe("hono")).toBe(true);
    expect(isBackendRecipe("express")).toBe(true);
    expect(isBackendRecipe("otlp")).toBe(true);
    expect(isBackendRecipe("vite-spa")).toBe(false);
    expect(isBackendRecipe("next")).toBe(false);
    expect(isBackendRecipe(null)).toBe(false);
  });
});

describe("the emitted frontend init", () => {
  it("carries the resolved backend origins, not an empty list", () => {
    repo = makeRootApiRepo();
    const root = detect(repo);
    const candidates = discoverServices(repo, root, undefined, {
      endpoint: ENDPOINT,
    });
    const backends = candidates
      .filter((c) => isBackendRecipe(c.recipe))
      .map((c) => ({ dir: c.dir, detected: c.detected }));
    const web = candidates.find((c) => c.relDir === "frontend")!;
    const origins = resolveBackendOrigins(
      web.dir,
      localFsReader(web.dir),
      backends,
    );
    expect(origins).toContain("http://127.0.0.1:19870");

    const plan = buildPlan(
      {
        cwd: web.dir,
        recipe: web.recipe!,
        endpoint: ENDPOINT,
        entryFile: web.detected.entryFile,
        serviceName: "web",
        backendOrigins: origins,
        options: { force: true },
      },
      undefined,
    );
    expect(plan.content).toContain(
      'networkCorrelationAllowedOrigins: ["http://127.0.0.1:19870"],',
    );
    // The empty-list comment, which told the user their evidence stays
    // separate, must be gone once real origins are listed.
    expect(plan.content).not.toContain("frontend and backend evidence stay");
  });
});
