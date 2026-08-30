import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "crumbtrail-cloud-parity-"));

try {
  const packed = path.join(temporary, "packed");
  const extracted = path.join(temporary, "extracted");
  mkdirSync(packed);
  mkdirSync(extracted);
  execFileSync(
    "pnpm",
    ["pack", "--pack-destination", packed],
    { cwd: path.join(root, "packages/cli"), stdio: "pipe" },
  );
  const tarballs = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1)
    throw new Error(`expected one CLI tarball, found ${tarballs.length}`);
  execFileSync(
    "tar",
    ["-xzf", path.join(packed, tarballs[0]), "-C", extracted],
    { stdio: "pipe" },
  );
  execFileSync(
    "pnpm",
    ["install", "--offline", "--ignore-scripts", "--frozen-lockfile=false"],
    { cwd: path.join(extracted, "package"), stdio: "pipe" },
  );

  const require = createRequire(import.meta.url);
  const cli = require(path.join(extracted, "package/dist/index.cjs"));
  const files = {
    "package.json": JSON.stringify({ workspaces: ["apps/web", "services/api"] }),
    "apps/web/package.json": JSON.stringify({
      name: "web",
      devDependencies: { vite: "^7.0.0" },
    }),
    "apps/web/index.html":
      '<script type="module" src="/src/main.tsx"></script>',
    "apps/web/src/main.tsx":
      'import { mount } from "./mount.js"; mount(document.body)',
    "apps/web/src/mount.ts": "export const mount = (target) => target",
    "services/api/package.json": JSON.stringify({
      name: "api",
      dependencies: { hono: "^4.0.0" },
      scripts: { start: "tsx src/index.ts" },
    }),
    "services/api/src/index.ts": "Bun.serve({ fetch: app.fetch })",
    "services/api/Dockerfile": '["node", "src/index.ts"]',
  };
  const directories = [
    "apps",
    "apps/web",
    "apps/web/src",
    "services",
    "services/api",
    "services/api/src",
  ];
  const source = {
    async listTree() {
      return {
        truncated: false,
        entries: [
          ...directories.map((entryPath) => ({ path: entryPath, type: "tree" })),
          ...Object.keys(files).map((entryPath) => ({ path: entryPath, type: "blob" })),
        ],
      };
    },
    async readFile(file) {
      return files[file] ?? null;
    },
  };

  const reader = await cli.hydrateGithubReader(source);
  if (!reader.readFile("/apps/web/src/main.tsx")?.includes("mount"))
    throw new Error("packed reader did not hydrate the Vite entry");
  if (!reader.readFile("/services/api/Dockerfile")?.includes("src/index"))
    throw new Error("packed reader did not hydrate the deploy manifest");
  await cli.prefetchImportClosure(reader, ["/apps/web/src/main.tsx"]);
  if (!reader.readFile("/apps/web/src/mount.ts")?.includes("mount"))
    throw new Error("packed reader did not hydrate the emitted extension import");
  const services = cli.discoverServices("/", cli.detect("/", reader), reader, {
    alreadyWired: () => false,
  });
  for (const expected of ["apps/web", "services/api"]) {
    if (!services.some((service) => service.relDir === expected))
      throw new Error(`packed discovery omitted ${expected}`);
  }
  console.log(
    "PACKED_CLOUD_PARITY_PASS vite-entry,deploy-manifest,import-closure,discovery",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
