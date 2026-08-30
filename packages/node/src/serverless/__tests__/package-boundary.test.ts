import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "../../..");
const coreRoot = path.resolve(packageRoot, "../core");
const esmPath = path.join(packageRoot, "dist/index.js");
const cjsPath = path.join(packageRoot, "dist/index.cjs");
const declarationPath = path.join(packageRoot, "dist/index.d.ts");

beforeAll(() => {
  execFileSync("pnpm", ["run", "build"], {
    cwd: coreRoot,
    stdio: "pipe",
  });
  execFileSync("pnpm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "pipe",
  });
});

describe("crumbtrail-node serverless package boundary", () => {
  it("exposes all adapters from built ESM, CJS, and declarations", async () => {
    const declaration = fs.readFileSync(declarationPath, "utf8");
    const esm = (await import(
      `${pathToFileURL(esmPath).href}?serverless=${Date.now()}`
    )) as Record<string, unknown>;
    const cjs = createRequire(import.meta.url)(cjsPath) as Record<
      string,
      unknown
    >;

    for (const name of [
      "withCrumbtrailAwsLambda",
      "withCrumbtrailNetlify",
      "withCrumbtrailVercel",
    ]) {
      expect(typeof esm[name]).toBe("function");
      expect(typeof cjs[name]).toBe("function");
      expect(declaration).toContain(name);
    }
    expect(declaration).toContain("NodeServerlessAdapterOptions");
    expect(declaration).toContain("ServerlessTransportConfig");
  });
});
