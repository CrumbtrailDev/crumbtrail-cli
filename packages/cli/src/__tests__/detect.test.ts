import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  detect,
  detectPackageManager,
  findNearbyProjectDirs,
  isBuildOutputPath,
  isProcessWrapperSource,
  localFsReader,
  nodeEntryCandidatePaths,
  parseNodeInvocation,
} from "../detect";
// memoryReader is test-only and deliberately absent from the public barrel.
import { memoryReader } from "../testing";
import { cleanup, makeTmpRepo } from "./helpers";

describe("FileReader root bounds the upward lockfile walk", () => {
  // The parity tests elsewhere pass only incidentally: the fixtures they use
  // happen to carry their own lockfile, so neither reader ever walks far
  // enough for the boundary to matter. This asserts the bound directly, since
  // it is the whole reason `root` exists — a GitHub reader has nothing above
  // the repository root, and an unbounded walk would escape the repo.
  const files = {
    "/virtual/repo/apps/web/package.json": "{}",
    "/virtual/repo/package.json": "{}",
  };

  it("ignores a lockfile above the root", () => {
    const reader = memoryReader(
      { ...files, "/virtual/yarn.lock": "" },
      "/virtual/repo",
    );
    expect(detectPackageManager("/virtual/repo/apps/web", reader)).toBeNull();
  });

  it("finds a lockfile at the root itself, which is inclusive", () => {
    const reader = memoryReader(
      { ...files, "/virtual/repo/yarn.lock": "" },
      "/virtual/repo",
    );
    expect(detectPackageManager("/virtual/repo/apps/web", reader)).toBe("yarn");
  });

  it("walks upward from a subdirectory until it reaches the root", () => {
    const reader = memoryReader(
      { ...files, "/virtual/repo/pnpm-lock.yaml": "" },
      "/virtual/repo",
    );
    expect(detectPackageManager("/virtual/repo/apps/web", reader)).toBe("pnpm");
  });

  it("roots an empty file set at the filesystem root, never process.cwd()", () => {
    expect(memoryReader({}).root).toBe(path.parse(path.resolve(".")).root);
  });
});

describe("detect", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });
  const tmp = (files: Record<string, string>) => {
    const r = makeTmpRepo(files);
    roots.push(r);
    return r;
  };

  it("detects Next.js and captures the version, most-specific-first", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { next: "15.4.0", react: "19.0.0" },
      }),
      "pnpm-lock.yaml": "",
    });
    const r = detect(root);
    expect(r.recipe).toBe("next");
    expect(r.nextVersion).toBe("15.4.0");
    expect(r.packageManager).toBe("pnpm");
    expect(r.ambiguous).toBe(false);
  });

  it("matches fixture detection with localFsReader and memoryReader", () => {
    const fixture = path.resolve(
      __dirname,
      "../../../../test-fixtures/installers/vite-react",
    );
    const files: Record<string, string> = {};
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collect(full);
        else files[full] = readFileSync(full, "utf8");
      }
    };
    collect(fixture);

    const inMemory = memoryReader(files);
    expect(detect(fixture, localFsReader(fixture))).toEqual(
      detect(inMemory.root, inMemory),
    );
  });

  it("detects SvelteKit over a bare vite entry", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        devDependencies: { "@sveltejs/kit": "2.0.0", vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "",
    });
    expect(detect(root).recipe).toBe("sveltekit");
  });

  it("detects Nuxt", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { nuxt: "3.0.0" } }),
    });
    expect(detect(root).recipe).toBe("nuxt");
  });

  it("resolves the Vite entry from index.html's module script", () => {
    const root = tmp({
      "package.json": JSON.stringify({ devDependencies: { vite: "5.0.0" } }),
      "index.html":
        '<!doctype html><html><body><script type="module" src="/src/main.tsx"></script></body></html>',
      "src/main.tsx": "createRoot();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("vite-spa");
    expect(r.entryFile).toBe(path.join(root, "src", "main.tsx"));
    expect(r.ambiguous).toBe(false);
  });

  // Relaxed vite-spa matcher (CP3): a Vite project whose index.html isn't at the
  // repo root (or is missing) must still detect as vite-spa (guided fallback),
  // not "no recipe matched". The relaxed matcher sits AFTER the node/backend
  // matcher, so a backend project that merely carries vite as a devDep still
  // detects the backend framework.
  it("detects vite-spa (guided fallback) for a Vite project with no root index.html", () => {
    const root = tmp({
      "package.json": JSON.stringify({ devDependencies: { vite: "5.0.0" } }),
      "src/main.tsx": "createRoot();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("vite-spa");
    // No root index.html → no resolvable entry → guided fallback, ambiguous.
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("keeps detecting the backend when express and vite (devDep) coexist", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { express: "4.19.0" },
        devDependencies: { vite: "5.0.0" },
        main: "server.js",
      }),
      "server.js": "const app = require('express')()",
    });
    const r = detect(root);
    expect(r.recipe).toBe("express");
    expect(r.entryFile).toBe(path.join(root, "server.js"));
    expect(r.ambiguous).toBe(false);
  });

  it("is ambiguous when the vite entry cannot be resolved", () => {
    const root = tmp({
      "package.json": JSON.stringify({ devDependencies: { vite: "5.0.0" } }),
      "index.html": '<script type="module" src="/src/missing.tsx"></script>',
    });
    const r = detect(root);
    expect(r.recipe).toBe("vite-spa");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("resolves a Node server entry from package.json main", () => {
    const root = tmp({
      "package.json": JSON.stringify({ main: "server.js" }),
      "server.js": "require('http')",
    });
    const r = detect(root);
    expect(r.recipe).toBe("node");
    expect(r.entryFile).toBe(path.join(root, "server.js"));
  });

  it("resolves a Node server entry from a start script", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        scripts: { start: "node --enable-source-maps src/index.mjs" },
      }),
      "src/index.mjs": "",
    });
    expect(detect(root).entryFile).toBe(path.join(root, "src", "index.mjs"));
  });

  it("detects Express over the generic node fallback and resolves the entry", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { express: "4.19.0" },
        main: "server.js",
      }),
      "server.js": "const app = require('express')()",
    });
    const r = detect(root);
    expect(r.recipe).toBe("express");
    expect(r.entryFile).toBe(path.join(root, "server.js"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found `express` dependency");
  });

  it("detects Hono over the generic node fallback", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { hono: "4.0.0" },
        scripts: { start: "node src/index.mjs" },
      }),
      "src/index.mjs": "",
    });
    const r = detect(root);
    expect(r.recipe).toBe("hono");
    expect(r.entryFile).toBe(path.join(root, "src", "index.mjs"));
  });

  it("detects Fastify over the generic node fallback", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { fastify: "4.0.0" },
        main: "app.js",
      }),
      "app.js": "",
    });
    const r = detect(root);
    expect(r.recipe).toBe("fastify");
    expect(r.entryFile).toBe(path.join(root, "app.js"));
  });

  it("is ambiguous when a backend recipe's entry cannot be resolved", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { express: "4.19.0" } }),
    });
    const r = detect(root);
    expect(r.recipe).toBe("express");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("detects Tauri over its incidental Vite frontend and resolves the entry", () => {
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
  });

  it("does not detect Tauri without the src-tauri/ directory", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@tauri-apps/api": "2.0.0", vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "",
    });
    expect(detect(root).recipe).toBe("vite-spa");
  });

  it("is ambiguous when the Tauri frontend entry cannot be resolved", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        devDependencies: { "@tauri-apps/cli": "2.0.0" },
      }),
      "src-tauri/tauri.conf.json": "{}",
    });
    const r = detect(root);
    expect(r.recipe).toBe("tauri");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("detects an Ionic React (Vite) Capacitor app and resolves the web entry", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@capacitor/core": "6.0.0", react: "18.0.0" },
        devDependencies: { vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.tsx"></script>',
      "src/main.tsx": "createRoot(document.getElementById('root'));",
      "capacitor.config.ts": "export default { appId: 'ai.crumbtrail.demo' };",
    });
    const r = detect(root);
    expect(r.recipe).toBe("capacitor");
    expect(r.entryFile).toBe(path.join(root, "src", "main.tsx"));
    expect(r.ambiguous).toBe(false);
  });

  it("detects an Ionic Angular Capacitor app via src/main.ts", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: {
          "@capacitor/core": "6.0.0",
          "@angular/core": "18.0.0",
        },
      }),
      "src/main.ts": "platformBrowserDynamic().bootstrapModule(AppModule);",
    });
    const r = detect(root);
    expect(r.recipe).toBe("capacitor");
    expect(r.entryFile).toBe(path.join(root, "src", "main.ts"));
  });

  it("wins over vite-spa, because the phone build is the more specific fact", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@capacitor/core": "6.0.0" },
        devDependencies: { vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "console.log('app');",
    });
    expect(detect(root).recipe).toBe("capacitor");
  });

  it("falls through to the frontend recipe when no web entry resolves", () => {
    // A Next + Capacitor project. Claiming `capacitor` here would trade a
    // working injection for guidance, so detection declines and `next` wins.
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@capacitor/core": "6.0.0", next: "15.0.0" },
      }),
      "app/layout.tsx": "export default function Layout() {}",
    });
    expect(detect(root).recipe).toBe("next");
  });

  it("does not claim a plain web app that merely mentions capacitor", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        devDependencies: { vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "console.log('app');",
    });
    expect(detect(root).recipe).toBe("vite-spa");
  });

  it("detects an Expo app via the expo-router root layout", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { expo: "51.0.0" } }),
      "app/_layout.tsx": "export default function Layout() {}",
    });
    const r = detect(root);
    expect(r.recipe).toBe("react-native");
    expect(r.entryFile).toBe(path.join(root, "app", "_layout.tsx"));
    expect(r.ambiguous).toBe(false);
  });

  it("detects a bare React Native app via index.js", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "react-native": "0.74.0" },
        main: "index.js",
      }),
      "index.js": "AppRegistry.registerComponent();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("react-native");
    expect(r.entryFile).toBe(path.join(root, "index.js"));
  });

  it("prefers App.tsx over index.js for React Native", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { expo: "51.0.0" } }),
      "App.tsx": "export default function App() {}",
      "index.js": "AppRegistry.registerComponent();",
    });
    expect(detect(root).entryFile).toBe(path.join(root, "App.tsx"));
  });

  it("detects an Expo app via the src/app router layout (create-expo-app default)", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { expo: "51.0.0" } }),
      "src/app/_layout.tsx": "export default function Layout() {}",
    });
    const r = detect(root);
    expect(r.recipe).toBe("react-native");
    expect(r.entryFile).toBe(path.join(root, "src", "app", "_layout.tsx"));
    expect(r.ambiguous).toBe(false);
  });

  it("prefers app/_layout over src/app/_layout when both exist", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { expo: "51.0.0" } }),
      "app/_layout.tsx": "export default function Layout() {}",
      "src/app/_layout.tsx": "export default function Layout() {}",
    });
    expect(detect(root).entryFile).toBe(path.join(root, "app", "_layout.tsx"));
  });

  it("prefers src/app/_layout over App.tsx for React Native", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { expo: "51.0.0" } }),
      "src/app/_layout.tsx": "export default function Layout() {}",
      "App.tsx": "export default function App() {}",
    });
    expect(detect(root).entryFile).toBe(
      path.join(root, "src", "app", "_layout.tsx"),
    );
  });

  it("is ambiguous when the React Native entry cannot be resolved", () => {
    const root = tmp({
      "package.json": JSON.stringify({ dependencies: { expo: "51.0.0" } }),
    });
    const r = detect(root);
    expect(r.recipe).toBe("react-native");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("detects classic Remix over vite-spa and resolves the client entry", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@remix-run/react": "2.0.0", vite: "5.0.0" },
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

  it("detects React Router v7 framework mode via the @react-router/dev pair", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "react-router": "7.0.0" },
        devDependencies: { "@react-router/dev": "7.0.0", vite: "5.0.0" },
      }),
      "app/entry.client.jsx": "hydrateRoot();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("remix");
    expect(r.entryFile).toBe(path.join(root, "app", "entry.client.jsx"));
  });

  it("does not treat a plain react-router-dom SPA as Remix", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "react-router-dom": "6.0.0", vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.tsx"></script>',
      "src/main.tsx": "createRoot();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("vite-spa");
    expect(r.entryFile).toBe(path.join(root, "src", "main.tsx"));
  });

  it("is ambiguous when the Remix client entry cannot be resolved", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@remix-run/node": "2.0.0" },
      }),
    });
    const r = detect(root);
    expect(r.recipe).toBe("remix");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("detects Astro over vite-spa with a null entry that is not ambiguous", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { astro: "4.0.0", vite: "5.0.0" },
      }),
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "",
    });
    const r = detect(root);
    expect(r.recipe).toBe("astro");
    expect(r.entryFile).toBeNull();
    // Astro's null entry is a guided fallback by design, not ambiguity.
    expect(r.ambiguous).toBe(false);
  });

  it("detects Angular via @angular/core and resolves src/main.ts", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@angular/core": "18.0.0" },
      }),
      "angular.json": "{}",
      "src/main.ts": "bootstrapApplication(AppComponent);",
    });
    const r = detect(root);
    expect(r.recipe).toBe("angular");
    expect(r.entryFile).toBe(path.join(root, "src", "main.ts"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toContain("found angular.json");
  });

  it("is ambiguous when the Angular entry cannot be resolved", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@angular/core": "18.0.0" },
      }),
    });
    const r = detect(root);
    expect(r.recipe).toBe("angular");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("detects NestJS over its express platform adapter and resolves src/main.ts", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: {
          "@nestjs/core": "10.0.0",
          "@nestjs/platform-express": "10.0.0",
          express: "4.19.0",
        },
        scripts: { start: "nest start" },
        main: "dist/main.js",
      }),
      "src/main.ts": "bootstrap();",
    });
    const r = detect(root);
    expect(r.recipe).toBe("nestjs");
    expect(r.entryFile).toBe(path.join(root, "src", "main.ts"));
    expect(r.ambiguous).toBe(false);
  });

  it("detects NestJS over its fastify platform adapter", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: {
          "@nestjs/core": "10.0.0",
          "@nestjs/platform-fastify": "10.0.0",
          fastify: "4.0.0",
        },
      }),
      "src/main.ts": "bootstrap();",
    });
    expect(detect(root).recipe).toBe("nestjs");
  });

  it("is ambiguous when the NestJS entry cannot be resolved", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        dependencies: { "@nestjs/core": "10.0.0" },
      }),
    });
    const r = detect(root);
    expect(r.recipe).toBe("nestjs");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("detects package managers from each lockfile", () => {
    expect(
      detect(tmp({ "package.json": "{}", "yarn.lock": "" })).packageManager,
    ).toBe("yarn");
    expect(
      detect(tmp({ "package.json": "{}", "bun.lockb": "" })).packageManager,
    ).toBe("bun");
    expect(
      detect(tmp({ "package.json": "{}", "package-lock.json": "" }))
        .packageManager,
    ).toBe("npm");
  });

  it("lists workspace packages and short-circuits at a pnpm monorepo root", () => {
    const root = tmp({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/web/package.json": JSON.stringify({ name: "web" }),
      "packages/api/package.json": JSON.stringify({ name: "api" }),
    });
    const r = detect(root);
    expect(r.isMonorepo).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.entryFile).toBeNull();
    expect(r.workspaces.map((w) => w.name).sort()).toEqual(["api", "web"]);
  });

  it("detects a monorepo from a package.json workspaces field", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["apps/*"],
      }),
      "apps/site/package.json": JSON.stringify({ name: "site" }),
    });
    const r = detect(root);
    expect(r.isMonorepo).toBe(true);
    expect(r.workspaces.map((w) => w.name)).toEqual(["site"]);
  });

  it("expands nested workspace patterns and applies exclusions", () => {
    const root = tmp({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": [
        "packages:",
        "  - 'apps/*/*'",
        "  - 'apps/**'",
        "  - 'packages/**'",
        "  - '!apps/legacy'",
      ].join("\n"),
      "apps/team/web/package.json": JSON.stringify({ name: "@team/web" }),
      "apps/team/docs/package.json": JSON.stringify({ name: "@team/docs" }),
      "apps/legacy/package.json": JSON.stringify({ name: "legacy" }),
      "packages/group/api/package.json": JSON.stringify({ name: "@group/api" }),
      "packages/top/package.json": JSON.stringify({ name: "top" }),
      "unlisted/package.json": JSON.stringify({ name: "unlisted" }),
    });

    const r = detect(root);
    expect(r.workspaces.map((w) => path.relative(root, w.dir)).sort()).toEqual([
      "apps/team/docs",
      "apps/team/web",
      "packages/group/api",
      "packages/top",
    ]);
  });

  it("is ambiguous with no recipe match", () => {
    const root = tmp({ "package.json": JSON.stringify({ name: "lib" }) });
    const r = detect(root);
    expect(r.recipe).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  // ── Nx workspace discovery (fallback source, filesystem-only) ───────────────

  it("discovers Nx projects from apps/libs via project.json/package.json", () => {
    const root = tmp({
      "nx.json": JSON.stringify({}),
      "apps/web/project.json": JSON.stringify({ name: "web-app" }),
      "apps/api/package.json": JSON.stringify({ name: "api-svc" }),
      "libs/ui/project.json": JSON.stringify({ name: "ui-lib" }),
    });
    const r = detect(root);
    expect(r.isMonorepo).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.entryFile).toBeNull();
    expect(r.workspaces.map((w) => w.name).sort()).toEqual([
      "api-svc",
      "ui-lib",
      "web-app",
    ]);
    expect(r.reasons.some((x) => /monorepo root/.test(x))).toBe(true);
  });

  it("honors nx.json workspaceLayout appsDir/libsDir overrides", () => {
    const root = tmp({
      "nx.json": JSON.stringify({
        workspaceLayout: { appsDir: "packages", libsDir: "modules" },
      }),
      "packages/site/project.json": JSON.stringify({ name: "site" }),
      "modules/shared/project.json": JSON.stringify({ name: "shared" }),
      // Default apps/ dir must be ignored once overridden.
      "apps/ignored/project.json": JSON.stringify({ name: "ignored" }),
    });
    const r = detect(root);
    expect(r.isMonorepo).toBe(true);
    expect(r.workspaces.map((w) => w.name).sort()).toEqual(["shared", "site"]);
  });

  it("treats a standalone root project.json as a single Nx project", () => {
    const root = tmp({
      "nx.json": JSON.stringify({}),
      "project.json": JSON.stringify({ name: "standalone" }),
    });
    const r = detect(root);
    expect(r.isMonorepo).toBe(true);
    expect(r.workspaces.map((w) => w.name)).toEqual(["standalone"]);
  });

  it("does NOT run the Nx fallback when pnpm/pkg workspaces already resolve", () => {
    const root = tmp({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/web/package.json": JSON.stringify({ name: "web" }),
      // An nx.json + apps/ project that must be ignored (pnpm source wins).
      "nx.json": JSON.stringify({}),
      "apps/nx-app/project.json": JSON.stringify({ name: "nx-app" }),
    });
    const r = detect(root);
    expect(r.workspaces.map((w) => w.name)).toEqual(["web"]);
  });

  it("falls back to non-monorepo when nx.json has no discoverable projects", () => {
    const root = tmp({ "nx.json": JSON.stringify({}) });
    const r = detect(root);
    expect(r.isMonorepo).toBe(false);
    expect(r.workspaces).toEqual([]);
  });

  it("does not crash on a malformed nx.json and reports non-monorepo", () => {
    const root = tmp({ "nx.json": "{ this is not valid json," });
    let r: ReturnType<typeof detect>;
    expect(() => {
      r = detect(root);
    }).not.toThrow();
    expect(r!.isMonorepo).toBe(false);
    expect(r!.workspaces).toEqual([]);
  });

  it("is not a monorepo when apps/ subdirs carry no project.json/package.json", () => {
    const root = tmp({
      "nx.json": JSON.stringify({}),
      // Directories exist but hold no Nx/npm project manifest → not projects.
      "apps/web/README.md": "# not a project\n",
      "libs/ui/notes.txt": "just a folder",
    });
    const r = detect(root);
    expect(r.isMonorepo).toBe(false);
    expect(r.workspaces).toEqual([]);
  });

  // ── Deno (unsupported, distinct reason) ─────────────────────────────────────

  it("flags a Deno project (no package.json) with a distinct reason", () => {
    const root = tmp({ "deno.json": JSON.stringify({ tasks: {} }) });
    const r = detect(root);
    expect(r.recipe).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.reasons).toContain("Deno projects aren't supported yet");
    expect(r.reasons).not.toContain("no recipe matched");
  });

  it("supports deno.jsonc (presence only) for the Deno reason", () => {
    const root = tmp({ "deno.jsonc": "// comment\n{}\n" });
    const r = detect(root);
    expect(r.reasons).toContain("Deno projects aren't supported yet");
  });

  it("treats a deno.json + package.json hybrid as a normal JS project", () => {
    // A package.json present means the repo runs on npm tooling; the Deno
    // reason is gated on the absence of package.json, so it must NOT fire.
    const root = tmp({
      "deno.json": JSON.stringify({ tasks: {} }),
      "package.json": JSON.stringify({ dependencies: { next: "15.4.0" } }),
    });
    const r = detect(root);
    expect(r.recipe).toBe("next");
    expect(r.reasons).not.toContain("Deno projects aren't supported yet");
  });

  // ── Docker sniff (informational note, never changes outcomes) ───────────────

  it("adds a docker note alongside a real recipe without changing its outcome", () => {
    const files = {
      "package.json": JSON.stringify({
        dependencies: { next: "15.4.0" },
      }),
    };
    const withoutDocker = detect(tmp({ ...files }));
    const withDocker = detect(tmp({ ...files, Dockerfile: "FROM node:20\n" }));
    // The docker file must not alter recipe/ambiguity/entry.
    expect(withDocker.recipe).toBe(withoutDocker.recipe);
    expect(withDocker.ambiguous).toBe(withoutDocker.ambiguous);
    expect(withDocker.entryFile).toBe(withoutDocker.entryFile);
    expect(withDocker.isMonorepo).toBe(withoutDocker.isMonorepo);
    // Only the note differs.
    expect(withoutDocker.notes).toEqual([]);
    expect(withDocker.notes.some((n) => /Docker/.test(n))).toBe(true);
  });

  it("emits a docker note on the no-recipe path (compose file)", () => {
    const root = tmp({ "docker-compose.yml": "services: {}\n" });
    const r = detect(root);
    expect(r.recipe).toBeNull();
    expect(r.notes.some((n) => /Docker/.test(n))).toBe(true);
  });

  // ── OTLP guidance path (non-JS backends, no package.json required) ──────────

  it("detects a Django backend from manage.py with no package.json", () => {
    const root = tmp({ "manage.py": "#!/usr/bin/env python\n" });
    const r = detect(root);
    expect(r.recipe).toBe("otlp");
    expect(r.otlpStack).toBe("django");
    expect(r.entryFile).toBeNull();
    // otlp has no entry by design — a null entry is NOT ambiguity here.
    expect(r.ambiguous).toBe(false);
  });

  it("detects a FastAPI backend from a requirements.txt dependency", () => {
    const root = tmp({ "requirements.txt": "uvicorn==0.30\nfastapi==0.111\n" });
    const r = detect(root);
    expect(r.recipe).toBe("otlp");
    expect(r.otlpStack).toBe("fastapi");
    expect(r.ambiguous).toBe(false);
  });

  it("detects a Flask backend from pyproject.toml", () => {
    const root = tmp({
      "pyproject.toml": '[project]\ndependencies = ["Flask>=3.0"]\n',
    });
    const r = detect(root);
    expect(r.recipe).toBe("otlp");
    expect(r.otlpStack).toBe("flask");
  });

  it("prefers FastAPI over Flask when both tokens appear", () => {
    const root = tmp({
      "requirements.txt": "flask==3.0\nfastapi==0.111\n",
    });
    expect(detect(root).otlpStack).toBe("fastapi");
  });

  it("detects a Go backend from go.mod", () => {
    const root = tmp({ "go.mod": "module example.com/app\n\ngo 1.22\n" });
    const r = detect(root);
    expect(r.recipe).toBe("otlp");
    expect(r.otlpStack).toBe("go");
  });

  it("detects a Rails backend from a Gemfile referencing rails", () => {
    const root = tmp({
      Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
    });
    const r = detect(root);
    expect(r.recipe).toBe("otlp");
    expect(r.otlpStack).toBe("rails");
  });

  it("does not treat a non-rails Gemfile as an OTLP backend", () => {
    const root = tmp({
      Gemfile: 'source "https://rubygems.org"\ngem "sinatra"\n',
    });
    const r = detect(root);
    expect(r.recipe).toBeNull();
    expect(r.otlpStack).toBeNull();
  });

  it("detects a .NET backend from a *.csproj file", () => {
    const root = tmp({
      "Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web" />\n',
    });
    const r = detect(root);
    expect(r.recipe).toBe("otlp");
    expect(r.otlpStack).toBe("dotnet");
  });

  it("lets a JS recipe win even when an OTLP marker is also present", () => {
    // A Node app that also carries a go.mod / manage.py must still resolve node,
    // never otlp — the otlp matchers sit strictly AFTER the node matcher.
    const root = tmp({
      "package.json": JSON.stringify({ main: "server.js" }),
      "server.js": "require('http')",
      "go.mod": "module x\n",
      "manage.py": "#!/usr/bin/env python\n",
    });
    const r = detect(root);
    expect(r.recipe).toBe("node");
    expect(r.otlpStack).toBeNull();
  });

  it("detects a Flutter app with no package.json anywhere", () => {
    const root = tmp({
      "pubspec.yaml": [
        "name: my_app",
        "environment:",
        "  sdk: '>=3.4.0 <4.0.0'",
        "dependencies:",
        "  flutter:",
        "    sdk: flutter",
        "",
      ].join("\n"),
      "lib/main.dart": "void main() {\n  runApp(const MyApp());\n}\n",
    });
    const r = detect(root);
    expect(r.recipe).toBe("flutter");
    expect(r.entryFile).toBe(path.join(root, "lib", "main.dart"));
    expect(r.ambiguous).toBe(false);
    expect(r.packageJsonPath).toBeNull();
  });

  it("is ambiguous when lib/main.dart is missing", () => {
    const root = tmp({
      "pubspec.yaml":
        "name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    });
    const r = detect(root);
    expect(r.recipe).toBe("flutter");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("ignores a pure Dart package, which has no widget bindings to wire", () => {
    // A Dart CLI or server has a pubspec too. Claiming the Flutter recipe there
    // would inject against bindings the project does not have.
    const root = tmp({
      "pubspec.yaml": "name: my_cli\ndependencies:\n  args: ^2.0.0\n",
      "lib/main.dart": "void main() {}\n",
    });
    expect(detect(root).recipe).toBeNull();
  });

  it("wins over a JS toolchain sharing the same root", () => {
    // A Flutter app whose repo also carries a package.json for tooling. The app
    // that ships to a phone is the one worth wiring.
    const root = tmp({
      "pubspec.yaml":
        "name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "lib/main.dart": "void main() {\n  runApp(const MyApp());\n}\n",
      "package.json": JSON.stringify({ devDependencies: { vite: "5.0.0" } }),
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "console.log('tooling');",
    });
    expect(detect(root).recipe).toBe("flutter");
  });
});

describe("no-recipe reasons name what was inspected", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });
  const tmp = (files: Record<string, string>) => {
    const r = makeTmpRepo(files);
    roots.push(r);
    return r;
  };

  it("says there is no package.json and names the directory", () => {
    const root = tmp({});
    const r = detect(root);
    expect(r.recipe).toBeNull();
    expect(
      r.reasons.some((x) => x.includes(root) && x.includes("no package.json")),
    ).toBe(true);
    expect(r.reasons).not.toContain("no recipe matched");
  });

  it("says package.json has no matching dependency", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        name: "utils",
        dependencies: { lodash: "4.17.21" },
      }),
    });
    const r = detect(root);
    expect(r.recipe).toBeNull();
    const trail = r.reasons.join("\n");
    expect(trail).toContain(root);
    expect(trail).toContain("package.json");
    expect(trail).toContain("lodash");
    expect(r.reasons).not.toContain("no recipe matched");
  });

  it("still names the directory for a Deno project", () => {
    const root = tmp({ "deno.json": JSON.stringify({ tasks: {} }) });
    const r = detect(root);
    expect(r.reasons).toContain("Deno projects aren't supported yet");
    expect(
      r.reasons.some((x) => x.includes(root) && x.includes("deno.json")),
    ).toBe(true);
  });

  it("lists nearby app folders under conventional parents", () => {
    const root = tmp({
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/api/package.json": JSON.stringify({ name: "api" }),
    });
    const nearby = findNearbyProjectDirs(root, localFsReader(root));
    expect(nearby).toContain("apps/web");
    expect(nearby).toContain("apps/api");
  });
});

// Defect class: injecting into build output is silent zero capture. `tsc` wipes
// the edit and the dev command (`tsx watch src/index.ts`) never loads it, so the
// run reports success and the app reports nothing.
describe("build output is never an injection target", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });
  const tmp = (files: Record<string, string>) => {
    const r = makeTmpRepo(files);
    roots.push(r);
    return r;
  };

  const honoPkg = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: "api",
      main: "dist/index.js",
      dependencies: { hono: "^4.0.0" },
      scripts: {
        dev: "tsx watch src/index.ts",
        build: "tsc",
        start: "node dist/index.js",
      },
      ...extra,
    });

  it("wires the tsx-watched source entry, not the tsc output", () => {
    const root = tmp({
      "package.json": honoPkg(),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { rootDir: "src", outDir: "dist" },
      }),
      "src/index.ts": "import { Hono } from 'hono'",
      "dist/index.js": "// built",
    });
    const r = detect(root);
    expect(r.recipe).toBe("hono");
    expect(r.entryFile).toBe(path.join(root, "src", "index.ts"));
    expect(r.ambiguous).toBe(false);
  });

  it("parses a runner invocation with non-flag words before the file", () => {
    expect(parseNodeInvocation("tsx watch src/index.ts")).toBe("src/index.ts");
    expect(parseNodeInvocation("nodemon --exec ts-node src/server.ts")).toBe(
      "src/server.ts",
    );
    expect(parseNodeInvocation("node --enable-source-maps src/index.mjs")).toBe(
      "src/index.mjs",
    );
    // The build half of a chained script is not an entry.
    expect(parseNodeInvocation("tsc && node dist/index.js")).toBeNull();
    expect(parseNodeInvocation("vite build")).toBeNull();
  });

  it("falls back to the manual path when only build output exists", () => {
    const root = tmp({
      "package.json": honoPkg({ scripts: { start: "node dist/index.js" } }),
      "dist/index.js": "// built",
    });
    const r = detect(root);
    expect(r.recipe).toBe("hono");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.reasons.join("\n")).toMatch(/refused build output/);
  });

  it("treats a declared tsconfig outDir as build output even when unnamed", () => {
    const root = tmp({
      "package.json": JSON.stringify({
        name: "api",
        main: "lib/index.js",
        dependencies: { hono: "^4.0.0" },
      }),
      "tsconfig.json":
        '{\n  // generated\n  "compilerOptions": { "outDir": "lib" }\n}',
      "lib/index.js": "// built",
    });
    expect(detect(root).entryFile).toBeNull();
    expect(isBuildOutputPath(root, path.join(root, "lib", "index.js"))).toBe(
      true,
    );
    expect(isBuildOutputPath(root, path.join(root, "src", "index.ts"))).toBe(
      false,
    );
  });
});

describe("Cloudflare Workers runtime detection", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });

  it("routes a Hono Worker away from the Node Hono recipe", () => {
    const root = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "edge-api",
        dependencies: { hono: "^4.0.0" },
        devDependencies: { wrangler: "^4.0.0" },
      }),
      "wrangler.jsonc": JSON.stringify({
        name: "edge-api",
        main: "src/index.ts",
        compatibility_date: "2026-08-01",
      }),
      "src/index.ts":
        "import { Hono } from 'hono';\nexport default new Hono();\n",
    });
    roots.push(root);

    const result = detect(root);

    expect(result.recipe).toBe("cloudflare-workers");
    expect(result.entryFile).toBeNull();
    expect(result.ambiguous).toBe(false);
    expect(result.reasons.join("\n")).toContain("wrangler.jsonc");
  });
});

describe("a process wrapper is never an injection target", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });

  // The shape found in the wild: one shared script loads env and re-execs
  // whatever it was handed, and every service in the repo starts through it.
  const WRAPPER = [
    'const { spawn } = require("node:child_process");',
    "const args = process.argv.slice(2);",
    'const child = spawn(args[0], args.slice(1), { stdio: "inherit" });',
    'child.on("exit", (code) => process.exit(code ?? 0));',
  ].join("\n");

  /** A monorepo with the wrapper at the root and one service under it. */
  const monorepo = (
    scripts: Record<string, string>,
    extra: Record<string, unknown>,
    serviceFiles: Record<string, string>,
  ) => {
    const root = makeTmpRepo({
      "shared/scripts/with-shared-env.js": WRAPPER,
      "services/job-server/package.json": JSON.stringify({
        name: "job-server",
        dependencies: { hono: "^4.0.0" },
        scripts,
        ...extra,
      }),
      ...Object.fromEntries(
        Object.entries(serviceFiles).map(([k, v]) => [
          `services/job-server/${k}`,
          v,
        ]),
      ),
    });
    roots.push(root);
    return path.join(root, "services", "job-server");
  };

  it("recognises a spawn-from-argv wrapper and not an app that shells out", () => {
    expect(isProcessWrapperSource(WRAPPER)).toBe(true);
    expect(
      isProcessWrapperSource(
        'const { execFile } = require("child_process");\nexecFile("git", ["rev-parse"], cb);\nserver.listen(3000);',
      ),
    ).toBe(false);
    // cluster.fork() is not child_process at all.
    expect(
      isProcessWrapperSource(
        'const cluster = require("cluster");\ncluster.fork();\nconsole.log(process.argv);',
      ),
    ).toBe(false);
  });

  it("follows the wrapper's argv to the entry it launches", () => {
    const dir = monorepo(
      {
        dev: "node ../../shared/scripts/with-shared-env.js node src/server.js",
      },
      {},
      { "src/server.js": "const { Hono } = require('hono')" },
    );
    const r = detect(dir);
    expect(r.entryFile).toBe(path.join(dir, "src", "server.js"));
    expect(r.reasons.join("\n")).toMatch(/process wrapper/);
  });

  it("wires the package's own source entry when the command names only the wrapper", () => {
    const dir = monorepo(
      { dev: "node ../../shared/scripts/with-shared-env.js job-server" },
      {},
      { "src/index.js": "const { Hono } = require('hono')" },
    );
    expect(detect(dir).entryFile).toBe(path.join(dir, "src", "index.js"));
  });

  it("refuses the wrapper and says so when no real entry can be found", () => {
    const dir = monorepo(
      { dev: "node ../../shared/scripts/with-shared-env.js job-server" },
      { main: "../../shared/scripts/with-shared-env.js" },
      {},
    );
    const r = detect(dir);
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.reasons.join("\n")).toMatch(
      /This entry is a process wrapper: .*spawns the real command/,
    );
  });
});

// Defect class: a project whose framework is already known from its dependencies
// still punted to ~90 lines of manual instructions whenever package.json named
// no entry at all — the shape of every Docker CMD app, Procfile app, monorepo
// child package, and Express tutorial.
describe("a known framework resolves its conventional entry without a manifest pointer", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });
  const tmp = (files: Record<string, string>) => {
    const r = makeTmpRepo(files);
    roots.push(r);
    return r;
  };

  const APP = [
    'const express = require("express");',
    "const app = express();",
    "app.listen(3000);",
  ].join("\n");
  const barePkg = JSON.stringify({
    name: "api",
    version: "1.0.0",
    dependencies: { express: "^4.19.2" },
  });

  it("wires src/server.js when package.json has no main and no scripts", () => {
    const root = tmp({ "package.json": barePkg, "src/server.js": APP });
    const r = detect(root);
    expect(r.recipe).toBe("express");
    expect(r.entryFile).toBe(path.join(root, "src", "server.js"));
    expect(r.ambiguous).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/package.json names no entry/);
  });

  it("wires an entry beside package.json, the Docker CMD / Procfile shape", () => {
    const root = tmp({ "package.json": barePkg, "app.js": APP });
    expect(detect(root).entryFile).toBe(path.join(root, "app.js"));
  });

  it("prefers src/ over the package root when both exist", () => {
    const root = tmp({
      "package.json": barePkg,
      "src/index.js": APP,
      "index.js": APP,
    });
    expect(detect(root).entryFile).toBe(path.join(root, "src", "index.js"));
  });

  it("does not resurrect a process wrapper the resolver refuses", () => {
    const wrapper = [
      'const { spawn } = require("node:child_process");',
      "const args = process.argv.slice(2);",
      'spawn(args[0], args.slice(1), { stdio: "inherit" });',
    ].join("\n");
    const root = tmp({
      "package.json": barePkg,
      "src/index.js": wrapper,
      "src/server.js": APP,
    });
    expect(detect(root).entryFile).toBe(path.join(root, "src", "server.js"));
  });

  it("does not resurrect build output the resolver refuses", () => {
    const root = tmp({
      "package.json": barePkg,
      "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "dist" } }),
      "dist/index.js": "// built",
    });
    const r = detect(root);
    expect(r.recipe).toBe("express");
    expect(r.entryFile).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.reasons.join("\n")).toMatch(/no index\/main\/server\/app source/);
  });

  // The guard this fallback relaxes exists to stop the bare `node` matcher
  // claiming any package.json that happens to sit beside a src/index.js. Only a
  // matcher that already identified the framework may fall back.
  it("still punts when no framework dependency identified the project", () => {
    const root = tmp({
      "package.json": JSON.stringify({ name: "lib", version: "1.0.0" }),
      "src/index.js": "module.exports = {};",
    });
    const r = detect(root);
    expect(r.recipe).toBeNull();
    expect(r.entryFile).toBeNull();
  });

  // The GitHub reader hydrates exactly this list before the resolver runs, and
  // throws on any path the resolver reads that it did not fetch.
  it("keeps the hydration manifest in step with what the resolver reads", () => {
    const paths = nodeEntryCandidatePaths(barePkg);
    expect(paths).toContain("src/server.js");
    expect(paths).toContain("server.js");
    expect(paths).toContain("app.js");
    expect(paths.every((p) => !p.startsWith("./"))).toBe(true);
  });
});
