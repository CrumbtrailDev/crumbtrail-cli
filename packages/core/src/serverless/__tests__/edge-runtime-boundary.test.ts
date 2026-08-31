import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCorePackage } from "./build-package.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "../../..");
const serverlessDist = path.join(packageRoot, "dist/serverless");

beforeAll(() => {
  buildCorePackage(packageRoot);
}, 30_000);

describe("serverless edge runtime boundary", () => {
  it("builds without Node runtime references", () => {
    const pending = [
      path.join(serverlessDist, "index.js"),
      path.join(serverlessDist, "index.cjs"),
    ];
    const runtimeFiles = new Set<string>();

    while (pending.length > 0) {
      const file = pending.pop();
      if (!file || runtimeFiles.has(file)) continue;
      runtimeFiles.add(file);
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /(?:from\s+|require\()\s*["'](\.\.?\/[^"']+)["']/g,
      )) {
        const dependency = path.resolve(path.dirname(file), match[1]);
        if (fs.existsSync(dependency)) pending.push(dependency);
      }
    }

    expect(runtimeFiles.size).toBeGreaterThan(1);
    for (const file of runtimeFiles) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/(?:from\s*|require\()\s*["']node:/);
      expect(source).not.toMatch(
        /AsyncLocalStorage|node:http|\bBuffer\b|\bprocess\.|crumbtrail-node/,
      );
    }
  });
});
