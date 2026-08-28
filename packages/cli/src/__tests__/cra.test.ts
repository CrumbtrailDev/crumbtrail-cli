// Create React App / craco: detection, entry resolution, and the injected plan.
//
// CRA was the gap that let a two-app repository open a pull request wiring one
// app and dropping the other as `unsupported_framework`, so the cases below are
// written from that repository's actual shape: react-scripts under
// `dependencies`, `@craco/craco` under `devDependencies`, and the entry at
// `src/index.js`.

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { detect, resolveCraEntry } from "../detect";
import { buildPlan } from "../inject/recipes";
import { RECIPE_REGISTRY } from "../recipe-registry";
import { cleanup, fakeInjectIO, makeTmpRepo } from "./helpers";

const CWD = "/proj";
const ENDPOINT = "https://ingest.example.com";
const p = (...parts: string[]) => path.join(CWD, ...parts);

describe("cra detection", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });
  const tmp = (files: Record<string, string>) => {
    const r = makeTmpRepo(files);
    roots.push(r);
    return r;
  };

  it("matches on react-scripts and resolves src/index.js", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", "react-scripts": "5.0.1" },
      }),
      "public/index.html": "<div id=root></div>",
      "src/index.js": "createRoot();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("cra");
    expect(r.entryFile).toBe(path.join(root, "src", "index.js"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found `react-scripts` dependency");
  });

  it("matches a craco project that never declares react-scripts itself", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0" },
        devDependencies: { "@craco/craco": "7.1.0" },
        scripts: { build: "craco build" },
      }),
      "craco.config.js": "module.exports = {};",
      "src/index.jsx": "createRoot();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("cra");
    expect(r.entryFile).toBe(path.join(root, "src", "index.jsx"));
    expect(r.reasons).toContain("found `@craco/craco` dependency");
  });

  it("prefers the tsx entry over the js one", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "react-scripts": "5.0.1" },
      }),
      "src/index.tsx": "createRoot();",
      "src/index.js": "// stale",
    });
    expect(resolveCraEntry(root)).toBe(path.join(root, "src", "index.tsx"));
  });

  it("marks a CRA app with no resolvable entry ambiguous rather than guessing", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "react-scripts": "5.0.1" },
      }),
      "public/index.html": "<div id=root></div>",
    });
    const r = detect(root);
    expect(r.recipe).toBe("cra");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.reasons).toContain(
      "could not resolve src/index.{tsx,jsx,ts,js}",
    );
  });

  it("does not claim a CRA app as `static` on the strength of public/index.html", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "react-scripts": "5.0.1" },
      }),
      "public/index.html": "<div id=root></div>",
      "src/index.js": "createRoot();",
    });
    expect(detect(root).recipe).toBe("cra");
  });

  it("loses to vite-spa's more specific signal only when react-scripts is absent", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        devDependencies: { vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.tsx"></script>',
      "src/main.tsx": "createRoot();",
    });
    expect(detect(root).recipe).toBe("vite-spa");
  });

  it("wins over vite-spa mid-migration, when a project carries both", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "react-scripts": "5.0.1" },
        devDependencies: { vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.tsx"></script>',
      "src/main.tsx": "createRoot();",
      "src/index.js": "createRoot();",
    });
    expect(detect(root).recipe).toBe("cra");
  });
});

describe("cra plan", () => {
  it("prepends the client init into the resolved entry, reading REACT_APP_*", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "index.js")]: "createRoot();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "cra",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.js"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.targetPath).toBe(p("src", "index.js"));
    expect(plan.content).toContain(`httpEndpoint: "${ENDPOINT}"`);
    // Webpack's DefinePlugin only substitutes the REACT_APP_ prefix; any other
    // name compiles to undefined and the app captures nothing.
    expect(plan.content).toContain(
      "httpAuthToken: process.env.REACT_APP_CRUMBTRAIL_KEY",
    );
    expect(plan.content).not.toContain("import.meta.env");
    expect(plan.keyEnvVar).toBe("REACT_APP_CRUMBTRAIL_KEY");
    expect(plan.content ?? "").not.toMatch(/ctkey_|bgk_|bl_ingest_/);
  });

  it("falls back to guidance with a filled snippet when the entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      { cwd: CWD, recipe: "cra", endpoint: ENDPOINT, entryFile: null },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(ENDPOINT);
    expect(plan.warnings.join(" ")).toContain("src/index.");
  });

  it("registers the recipe with a bundler-inlined public key", () => {
    const meta = RECIPE_REGISTRY.cra;
    expect(meta.kind).toBe("inject");
    expect(meta.sdkPackages).toEqual(["crumbtrail-core"]);
    expect(meta.keyRef?.envVar).toBe("REACT_APP_CRUMBTRAIL_KEY");
    expect(meta.keyRef?.bundlerInlined).toBe(true);
  });
});
