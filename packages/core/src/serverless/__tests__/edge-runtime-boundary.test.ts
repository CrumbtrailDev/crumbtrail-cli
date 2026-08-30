import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "../../..");
const serverlessDist = path.join(packageRoot, "dist/serverless");

beforeAll(() => {
  execFileSync("pnpm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "pipe",
  });
});

describe("serverless edge runtime boundary", () => {
  it("builds without Node runtime references", () => {
    const runtimeFiles = fs
      .readdirSync(serverlessDist)
      .filter((file) => file.endsWith(".js") || file.endsWith(".cjs"));

    expect(runtimeFiles.length).toBeGreaterThan(0);
    for (const file of runtimeFiles) {
      const source = fs.readFileSync(path.join(serverlessDist, file), "utf8");
      expect(source).not.toMatch(/(?:from\s*|require\()\s*["']node:/);
      expect(source).not.toMatch(
        /AsyncLocalStorage|node:http|\bBuffer\b|\bprocess\.|crumbtrail-node/,
      );
    }
  });
});
