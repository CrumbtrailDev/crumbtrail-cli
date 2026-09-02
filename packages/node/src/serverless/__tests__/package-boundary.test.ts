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

// This hook builds two packages before it can assert anything. Vitest's default
// hook timeout is 10 seconds, which a loaded CI runner cannot meet, so the
// release workflow failed here rather than on anything about the code being
// released. The core copy of this test was given the same budget in #129.
beforeAll(() => {
  execFileSync("pnpm", ["run", "build"], {
    cwd: coreRoot,
    stdio: "pipe",
  });
  execFileSync("pnpm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "pipe",
  });
}, 120_000);

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
      "withCrumbtrailBullMqProducer",
      "withCrumbtrailBullMqProcessor",
      "withCrumbtrailAwsSqsProducer",
      "withCrumbtrailAwsSnsProducer",
      "withCrumbtrailAwsEventBridgeProducer",
      "withCrumbtrailAwsSchedulerProducer",
      "withCrumbtrailAwsSqsProcessor",
      "withCrumbtrailAwsSqsBatchProcessor",
      "withCrumbtrailAwsSnsProcessor",
      "withCrumbtrailAwsEventBridgeProcessor",
      "withCrumbtrailAwsSchedulerProcessor",
    ]) {
      expect(typeof esm[name]).toBe("function");
      expect(typeof cjs[name]).toBe("function");
      expect(declaration).toContain(name);
    }
    expect(declaration).toContain("NodeServerlessAdapterOptions");
    expect(declaration).toContain("ServerlessTransportConfig");
  });
});
