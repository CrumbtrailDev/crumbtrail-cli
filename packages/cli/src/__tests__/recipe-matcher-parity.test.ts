// CP1 parity guard: the ordered recipe matcher must reproduce the exact
// recipe / entryFile / ambiguous / reasons outcomes of the pre-refactor
// if/else ladder for each of the five recipes. The expected values below are
// the pre-refactor behavior encoded as literals — they must not drift.

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { detect } from "../detect";
import { RECIPE_REGISTRY } from "../recipe-registry";
import { cleanup, makeTmpRepo } from "./helpers";

describe("recipe matcher parity", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });
  const tmp = (files: Record<string, string>) => {
    const r = makeTmpRepo(files);
    roots.push(r);
    return r;
  };

  it("next: matches on the `next` dep, most-specific-first", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: {
          next: "15.4.0",
          "@sveltejs/kit": "2.0.0",
          nuxt: "3.0.0",
        },
      }),
    });
    const r = detect(root);
    expect(r.recipe).toBe("next");
    expect(r.nextVersion).toBe("15.4.0");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found `next` dependency");
  });

  it("sveltekit: wins over a bare vite+index.html project", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        devDependencies: {
          "@sveltejs/kit": "2.0.0",
          vite: "5.0.0",
          nuxt: "3.0.0",
        },
      }),
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "",
    });
    const r = detect(root);
    expect(r.recipe).toBe("sveltekit");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found `@sveltejs/kit` dependency");
  });

  it("nuxt: matches on the `nuxt` dep ahead of the vite fallback", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { nuxt: "3.0.0", vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "",
    });
    const r = detect(root);
    expect(r.recipe).toBe("nuxt");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found `nuxt` dependency");
  });

  it("vite-spa: wins over the generic node fallback and resolves the entry", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        devDependencies: { vite: "5.0.0" },
        main: "server.js",
      }),
      "server.js": "require('http')",
      "index.html": '<script type="module" src="/src/main.tsx"></script>',
      "src/main.tsx": "createRoot();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("vite-spa");
    expect(r.entryFile).toBe(path.join(root, "src", "main.tsx"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found `vite` dependency + index.html");
  });

  it("vite-spa: unresolved entry pushes the reason and marks ambiguous", () => {
    const root = tmp({
      "package.json": JSON.stringify({ devDependencies: { vite: "5.0.0" } }),
      "index.html": '<script type="module" src="/src/missing.tsx"></script>',
    });
    const r = detect(root);
    expect(r.recipe).toBe("vite-spa");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.reasons).toContain(
      "could not resolve a local module entry from index.html",
    );
  });

  it("node: generic fallback resolves a server entry from package.json", () => {
    const root = tmp({
      "package.json": JSON.stringify({ main: "server.js" }),
      "server.js": "require('http')",
    });
    const r = detect(root);
    expect(r.recipe).toBe("node");
    expect(r.entryFile).toBe(path.join(root, "server.js"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain(
      "resolved a Node server entry from package.json",
    );
  });

  it("express/hono/fastify each win over the generic node matcher", () => {
    for (const dep of ["express", "hono", "fastify"] as const) {
      const root = tmp({
        "package.json": JSON.stringify({
          dependencies: { [dep]: "1.0.0" },
          main: "server.js",
        }),
        "server.js": "require('http')",
      });
      const r = detect(root);
      expect(r.recipe).toBe(dep);
      expect(r.entryFile).toBe(path.join(root, "server.js"));
      expect(r.ambiguous).toBe(false);
      expect(r.reasons).toContain(`found \`${dep}\` dependency`);
    }
  });

  it("backend recipe with an unresolved entry is ambiguous", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { hono: "4.0.0" } }),
    });
    const r = detect(root);
    expect(r.recipe).toBe("hono");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("tauri: wins over its incidental vite frontend (ordered first)", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@tauri-apps/api": "2.0.0", vite: "5.0.0" },
      }),
      "src-tauri/tauri.conf.json": "{}",
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "",
    });
    const r = detect(root);
    expect(r.recipe).toBe("tauri");
    expect(r.entryFile).toBe(path.join(root, "src", "main.ts"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain(
      "found `@tauri-apps/*` dependency + src-tauri/ directory",
    );
  });

  it("react-native: wins over the generic node fallback via app/_layout", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { expo: "51.0.0" },
        main: "index.js",
      }),
      "app/_layout.tsx": "export default function Layout() {}",
      "index.js": "AppRegistry.registerComponent();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("react-native");
    expect(r.entryFile).toBe(path.join(root, "app", "_layout.tsx"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found `expo` or `react-native` dependency");
  });

  it("nestjs: wins over express, fastify adapter deps, and the node fallback", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: {
          "@nestjs/core": "10.0.0",
          "@nestjs/platform-express": "10.0.0",
          "@nestjs/platform-fastify": "10.0.0",
          express: "4.19.0",
          fastify: "4.0.0",
        },
        main: "dist/main.js",
      }),
      "src/main.ts": "bootstrap();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("nestjs");
    expect(r.entryFile).toBe(path.join(root, "src", "main.ts"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found `@nestjs/core` dependency");
  });

  it("remix: wins over both vite-spa and express", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: {
          "@remix-run/node": "2.0.0",
          "@remix-run/serve": "2.0.0",
          express: "4.19.0",
          vite: "5.0.0",
        },
      }),
      "index.html": '<script type="module" src="/src/main.tsx"></script>',
      "src/main.tsx": "",
      "app/entry.client.tsx": "hydrateRoot();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("remix");
    expect(r.entryFile).toBe(path.join(root, "app", "entry.client.tsx"));
    expect(r.ambiguous).toBe(false);
  });

  it("registry carries stack/sdkPackages/serviceName/kind for all recipes", () => {
    expect(RECIPE_REGISTRY).toMatchObject({
      tauri: {
        stack: "vite",
        sdkPackages: ["crumbtrail-core", "crumbtrail-tauri"],
        serviceName: "app",
        kind: "inject",
      },
      "react-native": {
        stack: "react",
        sdkPackages: ["crumbtrail-core", "crumbtrail-react-native"],
        serviceName: "app",
        kind: "inject",
      },
      next: {
        stack: "nextjs",
        sdkPackages: ["crumbtrail-core"],
        serviceName: "web",
        kind: "inject",
      },
      sveltekit: {
        stack: "svelte",
        sdkPackages: ["crumbtrail-core"],
        serviceName: "web",
        kind: "inject",
      },
      nuxt: {
        stack: "vue",
        sdkPackages: ["crumbtrail-core"],
        serviceName: "web",
        kind: "inject",
      },
      remix: {
        stack: "react",
        sdkPackages: ["crumbtrail-core"],
        serviceName: "web",
        kind: "inject",
      },
      astro: {
        stack: "vite",
        sdkPackages: ["crumbtrail-core"],
        serviceName: "web",
        kind: "inject",
      },
      angular: {
        stack: "vite",
        sdkPackages: ["crumbtrail-core"],
        serviceName: "web",
        kind: "inject",
      },
      "vite-spa": {
        stack: "vite",
        sdkPackages: ["crumbtrail-core"],
        serviceName: "web",
        kind: "inject",
      },
      nestjs: {
        stack: "node",
        sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
        serviceName: "api",
        kind: "inject",
      },
      express: {
        stack: "express",
        sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
        serviceName: "api",
        kind: "inject",
      },
      hono: {
        stack: "hono",
        sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
        serviceName: "api",
        kind: "inject",
      },
      fastify: {
        stack: "node",
        sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
        serviceName: "api",
        kind: "inject",
      },
      node: {
        stack: "node",
        sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
        serviceName: "api",
        kind: "inject",
      },
    });
  });
});
