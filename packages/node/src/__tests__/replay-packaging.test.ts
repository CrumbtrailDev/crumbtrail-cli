import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/**
 * `crumbtrail-node` is published to npm. Playwright pulls browser binaries, so
 * it must stay an OPTIONAL peer: present for consumers who want the replay
 * adapter, absent (and harmless) for everyone else. These assertions fail loudly
 * if someone promotes it to a hard dependency.
 */
describe("playwright packaging", () => {
  it("is not a runtime dependency", () => {
    expect(manifest.dependencies ?? {}).not.toHaveProperty("playwright");
  });

  it("is declared as an optional peer dependency", () => {
    expect(manifest.peerDependencies?.playwright).toBeTruthy();
    expect(manifest.peerDependenciesMeta?.playwright?.optional).toBe(true);
  });

  it("is never imported statically from source", () => {
    const offenders: string[] = [];
    const staticImport = /(?:from|import)\s*\(?\s*["']playwright["']/;

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const code = fs
          .readFileSync(full, "utf-8")
          // Comments discuss the specifier on purpose; only real code counts.
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (staticImport.test(code)) {
          offenders.push(path.relative(packageRoot, full));
        }
      }
    };

    walk(path.join(packageRoot, "src"));
    expect(offenders).toEqual([]);
  });
});
