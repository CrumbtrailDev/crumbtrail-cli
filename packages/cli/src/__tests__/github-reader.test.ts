// Direct tests for the GitHub-backed reader.
//
// The fixture parity gate does not reach these: none of the installer fixtures
// is a monorepo, so readDir and the workspace glob rounds go unexercised there.
// A mutation that made readDir always return an empty array left that suite
// entirely green, which is why these exist.

import { describe, expect, it } from "vitest";
import {
  hydrateGithubReader,
  githubInjectIO,
  prefetchImportClosure,
  UnhydratedPathError,
  type GithubRepoSource,
  type GithubTreeEntry,
} from "../readers/github";
import { detect } from "../detect";
import { discoverServices } from "../discover";

function source(
  files: Record<string, string>,
  dirs: string[] = [],
  truncated = false,
) {
  const entries: GithubTreeEntry[] = [
    ...dirs.map((path) => ({ path, type: "tree" as const })),
    ...Object.keys(files).map((path) => ({ path, type: "blob" as const })),
  ];
  const calls = { tree: 0, blob: 0, paths: [] as string[] };
  const src: GithubRepoSource = {
    async listTree() {
      calls.tree += 1;
      return { entries, truncated };
    },
    async readFile(p) {
      calls.blob += 1;
      calls.paths.push(p);
      return files[p] ?? null;
    },
  };
  return { src, calls };
}

describe("hydrateGithubReader", () => {
  it("answers isFile, isDir and readDir from one tree call", async () => {
    const { src, calls } = source(
      {
        "package.json": "{}",
        "src/main.ts": "x",
        "src/lib/util.ts": "y",
      },
      ["src", "src/lib"],
    );
    const r = await hydrateGithubReader(src);

    expect(calls.tree).toBe(1);
    expect(r.isFile("/src/main.ts")).toBe(true);
    expect(r.isFile("/src")).toBe(false);
    expect(r.isDir("/src")).toBe(true);
    expect(r.isDir("/src/lib")).toBe(true);
    expect(r.isDir("/nope")).toBe(false);
    expect(r.readDir("/src").sort()).toEqual(["lib", "main.ts"]);
    expect(r.readDir("/").sort()).toEqual(["package.json", "src"]);
    expect(r.readDir("/nope")).toEqual([]);
  });

  it("derives ancestor directories the tree never listed", async () => {
    // The truncated fallback yields blobs without their parent tree entries.
    const { src } = source({ "a/b/c/file.ts": "x" }, []);
    const r = await hydrateGithubReader(src);
    expect(r.isDir("/a")).toBe(true);
    expect(r.isDir("/a/b")).toBe(true);
    expect(r.readDir("/a")).toEqual(["b"]);
  });

  it("excludes node_modules from the snapshot", async () => {
    const { src } = source(
      { "package.json": "{}", "node_modules/next/package.json": "{}" },
      ["node_modules", "node_modules/next"],
    );
    const r = await hydrateGithubReader(src);
    expect(r.isDir("/node_modules")).toBe(false);
    expect(r.isFile("/node_modules/next/package.json")).toBe(false);
    expect(r.readDir("/")).toEqual(["package.json"]);
  });

  it("never requests content for a path the tree says is absent", async () => {
    const { src, calls } = source({ "package.json": "{}" });
    await hydrateGithubReader(src);
    // The manifest lists a dozen paths; only the one that exists is fetched.
    expect(calls.paths).toEqual(["package.json"]);
  });

  it("hydrates workspace member manifests in a second round", async () => {
    const { src, calls } = source(
      {
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "packages/app/package.json": '{"name":"app"}',
        "packages/lib/package.json": '{"name":"lib"}',
      },
      ["packages", "packages/app", "packages/lib"],
    );
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/packages/app/package.json")).toBe('{"name":"app"}');
    expect(r.readFile("/packages/lib/package.json")).toBe('{"name":"lib"}');
    expect(calls.tree).toBe(1);
  });

  it("reads pnpm workspace globs too", async () => {
    const { src } = source(
      {
        "package.json": "{}",
        "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
        "apps/web/package.json": '{"name":"web"}',
      },
      ["apps", "apps/web"],
    );
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/apps/web/package.json")).toBe('{"name":"web"}');
  });

  it("hydrates literal workspace entries, not their children", async () => {
    // Regression: expanding "website" as a glob skipped the directory itself,
    // so every member manifest stayed unhydrated and the first read threw.
    const { src } = source(
      {
        "package.json": JSON.stringify({
          workspaces: ["website", "job-server"],
        }),
        "website/package.json": '{"name":"website"}',
        "job-server/package.json": '{"name":"job-server"}',
      },
      ["website", "job-server"],
    );
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/website/package.json")).toBe('{"name":"website"}');
    expect(r.readFile("/job-server/package.json")).toBe(
      '{"name":"job-server"}',
    );
  });

  it("hydrates literal pnpm workspace entries", async () => {
    const { src } = source(
      {
        "package.json": "{}",
        "pnpm-workspace.yaml": 'packages:\n  - "website"\n',
        "website/package.json": '{"name":"website"}',
      },
      ["website"],
    );
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/website/package.json")).toBe('{"name":"website"}');
  });

  it("hydrates the directories the discovery scan classifies", async () => {
    // No workspaces at all: these dirs are reachable only via the scan pass.
    const { src } = source(
      {
        "package.json": "{}",
        "api/pyproject.toml": "[project]\nname='api'\n",
        "services/billing/Gemfile": "source 'x'\n",
        "apps/web/index.html": "<html></html>",
        "packages/ui/package.json": '{"name":"ui"}',
      },
      [
        "api",
        "services",
        "services/billing",
        "apps",
        "apps/web",
        "packages",
        "packages/ui",
      ],
    );
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/api/pyproject.toml")).toContain("api");
    expect(r.readFile("/services/billing/Gemfile")).toContain("source");
    expect(r.readFile("/apps/web/index.html")).toBe("<html></html>");
    expect(r.readFile("/packages/ui/package.json")).toBe('{"name":"ui"}');
  });

  it("hydrates a Vite entry resolved from index.html for discovery evidence", async () => {
    const { src } = source(
      {
        "package.json": JSON.stringify({ workspaces: ["apps/web"] }),
        "apps/web/package.json": JSON.stringify({
          name: "web",
          devDependencies: { vite: "^7.0.0" },
        }),
        "apps/web/index.html":
          '<script type="module" src="/src/main.tsx"></script>',
        "apps/web/src/main.tsx": "createRoot(document.body).render(<App />)",
      },
      ["apps", "apps/web", "apps/web/src"],
    );
    const reader = await hydrateGithubReader(src);
    expect(reader.readFile("/apps/web/src/main.tsx")).toContain("createRoot");
    expect(() =>
      discoverServices("/", detect("/", reader), reader, {
        alreadyWired: () => false,
      }),
    ).not.toThrow();
  });

  it("hydrates default recipe entries in workspace members", async () => {
    const { src } = source(
      {
        "package.json": JSON.stringify({ workspaces: ["website"] }),
        "website/package.json": JSON.stringify({
          dependencies: { next: "^15.0.0" },
        }),
        "website/instrumentation-client.js":
          'import { consent } from "./src/consent.js"; register(consent)',
        "website/src/consent.js": "export const consent = true",
      },
      ["website", "website/src"],
    );
    const reader = await hydrateGithubReader(src);
    expect(reader.readFile("/website/instrumentation-client.js")).toContain(
      "register",
    );
    expect(reader.readFile("/website/src/consent.js")).toContain("consent");
  });

  it("records an unreadable hydrated file as unavailable", async () => {
    const { src } = source(
      {
        "package.json": JSON.stringify({ workspaces: ["broken"] }),
        "broken/package.json": JSON.stringify({
          scripts: { start: "node index.js" },
        }),
        "broken/index.js": "listen()",
      },
      ["broken"],
    );
    const read = src.readFile.bind(src);
    src.readFile = async (file) => {
      if (file === "broken/index.js") throw new Error("read failed");
      return read(file);
    };
    const reader = await hydrateGithubReader(src);
    expect(reader.readFile("/broken/index.js")).toBeNull();
    expect(reader.unavailablePaths()).toEqual(["/broken/index.js"]);
  });

  it("prefetches emitted extension imports through the full inspection bound", async () => {
    const files: Record<string, string> = {
      "package.json": "{}",
    };
    const count = 80;
    for (let index = 0; index < count; index++) {
      files[`src/file${index}.ts`] =
        index === count - 1
          ? "export const done = true"
          : `import "./file${index + 1}.js"`;
    }
    const { src } = source(files, ["src"]);
    const reader = await hydrateGithubReader(src);
    await prefetchImportClosure(reader, ["/src/file0.ts"]);
    expect(reader.readFile(`/src/file${count - 1}.ts`)).toContain("done");
  });

  it("does not prefetch local paths mentioned only in comments or strings", async () => {
    const { src } = source(
      {
        "package.json": "{}",
        "src/index.ts": [
          '// import "./commented.ts";',
          'const note = "import ./quoted.ts";',
        ].join("\n"),
        "src/commented.ts": "commented()",
        "src/quoted.ts": "quoted()",
      },
      ["src"],
    );
    const reader = await hydrateGithubReader(src);
    await prefetchImportClosure(reader, ["/src/index.ts"]);
    expect(() => reader.readFile("/src/commented.ts")).toThrow(
      UnhydratedPathError,
    );
    expect(() => reader.readFile("/src/quoted.ts")).toThrow(
      UnhydratedPathError,
    );
  });

  it("hydrates every ambiguous emitted source before refusing resolution", async () => {
    const { src } = source(
      {
        "package.json": "{}",
        "src/index.ts": 'import "./view.js"',
        "src/view.ts": "export const view = 1",
        "src/view.tsx": "export const view = <main />",
      },
      ["src"],
    );
    const reader = await hydrateGithubReader(src);
    await prefetchImportClosure(reader, ["/src/index.ts"]);
    expect(reader.readFile("/src/view.ts")).toContain("view");
    expect(reader.readFile("/src/view.tsx")).toContain("view");
  });

  it("hydrates dependent entries for caller-provided service manifests", async () => {
    const files: Record<string, string> = { "package.json": "{}" };
    const dirs: string[] = ["packages"];
    for (let index = 0; index < 205; index++) {
      const dir = `packages/pad${String(index).padStart(3, "0")}`;
      dirs.push(dir);
      files[`${dir}/README.md`] = "padding";
    }
    dirs.push("packages/late", "packages/late/src");
    files["packages/late/package.json"] = JSON.stringify({
      dependencies: { vite: "^7.0.0" },
    });
    files["packages/late/index.html"] =
      '<script type="module" src="/src/main.tsx"></script>';
    files["packages/late/src/main.tsx"] = "render()";
    const { src } = source(files, dirs);
    const reader = await hydrateGithubReader(src, {
      extraPaths: ["/packages/late/package.json", "/packages/late/index.html"],
    });
    expect(reader.readFile("/packages/late/src/main.tsx")).toBe("render()");
  });

  it("hydrates every deploy manifest read by discovery evidence", async () => {
    const { src } = source(
      {
        "package.json": JSON.stringify({ workspaces: ["services/api"] }),
        "railway.worker.toml": 'startCommand = "node root-worker.js"',
        "services/api/package.json": JSON.stringify({
          name: "api",
          dependencies: { hono: "^4.0.0" },
          scripts: { start: "tsx src/index.ts" },
        }),
        "services/api/src/index.ts": "Bun.serve({ fetch: app.fetch })",
        "services/api/Dockerfile": '["node", "src/index.ts"]',
        "services/api/docker-compose.prod.yaml":
          "services:\n  api:\n    command: [node, src/index.ts]\n",
      },
      ["services", "services/api", "services/api/src"],
    );
    const reader = await hydrateGithubReader(src);
    expect(reader.readFile("/railway.worker.toml")).toContain("startCommand");
    expect(reader.readFile("/services/api/Dockerfile")).toContain("src/index");
    expect(reader.readFile("/services/api/docker-compose.prod.yaml")).toContain(
      "command",
    );
    expect(() =>
      discoverServices("/", detect("/", reader), reader, {
        alreadyWired: () => false,
      }),
    ).not.toThrow();
  });

  it("hydrates every serverless config and source candidate detection reads", async () => {
    const files = {
      "deno.json": '{"tasks":{"start":"deno run src/deploy.ts"}}',
      "deno.jsonc": "{}",
      "serverless.yml": "provider: gcp",
      "serverless.yaml": "provider: gcp",
      "serverless.ts": 'export default { provider: "gcp" }',
      "template.yml": "Resources: {}",
      "template.yaml": "Resources: {}",
      "template.json": '{"Resources":{}}',
      "vercel.json": "{}",
      "netlify.toml": "",
      "main.ts": "console.log('main')",
      "src/deploy.ts": "Deno.serve(() => new Response('ok'))",
      "api/hello.ts": "export default () => new Response('ok')",
      "netlify/functions/hello.ts": "export const handler = async () => ({})",
      "netlify/edge-functions/hello.ts":
        "export default () => new Response('ok')",
    };
    const { src } = source(files, [
      "src",
      "api",
      "netlify",
      "netlify/functions",
      "netlify/edge-functions",
    ]);

    const reader = await hydrateGithubReader(src);

    // Goes red when detection adds a serverless config variant or source scan
    // without adding the same reachable content to GitHub hydration.
    for (const [file, content] of Object.entries(files)) {
      expect(reader.readFile(`/${file}`), file).toBe(content);
    }
  });

  it("keeps hydration to three rounds and skips absent manifests", async () => {
    const { src, calls } = source(
      {
        "package.json": JSON.stringify({ workspaces: ["website"] }),
        "website/package.json": '{"name":"website"}',
        "docs/readme.md": "x",
      },
      ["website", "docs"],
    );
    await hydrateGithubReader(src);
    expect(calls.tree).toBe(1);
    // Only manifests that actually exist cost a blob fetch.
    expect(calls.paths.sort()).toEqual([
      "package.json",
      "website/package.json",
    ]);
  });

  it("returns null for a file the repository does not have", async () => {
    const { src } = source({ "package.json": "{}" });
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/nope.ts")).toBeNull();
  });

  it("throws UnhydratedPathError for a present but unfetched file", async () => {
    // This is the N+1 guard: the file exists, so a null would be a lie.
    const { src } = source({ "package.json": "{}", "src/deep.ts": "x" }, [
      "src",
    ]);
    const r = await hydrateGithubReader(src);
    expect(() => r.readFile("/src/deep.ts")).toThrow(UnhydratedPathError);
  });

  it("prefetch makes a previously unhydrated file readable", async () => {
    const { src } = source({ "package.json": "{}", "src/deep.ts": "body" }, [
      "src",
    ]);
    const r = await hydrateGithubReader(src);
    await r.prefetch(["/src/deep.ts", null, undefined]);
    expect(r.readFile("/src/deep.ts")).toBe("body");
  });
});

describe("hydration covers what detection actually reads", () => {
  it("discovers a literal-workspace repo without an unhydrated read", async () => {
    // The cloud-onboarding regression, end to end: hydrate → detect → discover.
    const { src } = source(
      {
        "package.json": JSON.stringify({
          name: "root",
          workspaces: ["website", "job-server"],
        }),
        "website/package.json": JSON.stringify({
          name: "website",
          dependencies: { next: "15.0.0" },
          scripts: { dev: "next dev" },
        }),
        "website/app/layout.tsx": "export default function L() {}",
        "job-server/package.json": JSON.stringify({
          name: "job-server",
          scripts: { start: "node index.js" },
          main: "index.js",
        }),
        "job-server/index.js": "run()",
        "api/pyproject.toml": "[project]\nname='api'\n",
      },
      ["website", "website/app", "job-server", "api"],
    );
    const reader = await hydrateGithubReader(src);
    const root = detect("/", reader);
    const found = discoverServices("/", root, reader, {
      alreadyWired: () => false,
    });
    expect(found.map((c) => c.relDir).sort()).toEqual(
      expect.arrayContaining(["job-server", "website"]),
    );
    expect(found.find((c) => c.relDir === "website")?.recipe).toBe("next");
  });
});

describe("githubInjectIO", () => {
  it("reports every target as clean, so needs-confirm-dirty is unreachable", async () => {
    // An API read has no working tree. This must never fall through to the
    // filesystem implementation, which would inspect the SERVER's disk.
    const { src } = source({ "package.json": "{}" });
    const io = githubInjectIO(await hydrateGithubReader(src));
    expect(io.gitStatus()).toEqual({
      isRepo: true,
      tracked: true,
      dirty: false,
    });
  });

  it("exists covers both files and directories", async () => {
    const { src } = source({ "package.json": "{}", "src/a.ts": "x" }, ["src"]);
    const io = githubInjectIO(await hydrateGithubReader(src));
    expect(io.exists("/package.json")).toBe(true);
    expect(io.exists("/src")).toBe(true);
    expect(io.exists("/missing")).toBe(false);
  });
});
