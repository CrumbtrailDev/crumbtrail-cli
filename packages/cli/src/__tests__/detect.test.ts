import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { detect } from "../detect";
import { cleanup, makeTmpRepo } from "./helpers";

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
});
