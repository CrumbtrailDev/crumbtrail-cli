import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  autoCapture,
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
  installHttpRequestCapture,
  instrumentDatabaseClient,
} from "../index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");

function readPackageJson(): {
  name?: string;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  scripts?: Record<string, string>;
} {
  return JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
}

describe("package runtime boundary", () => {
  it("ships a library and no executable", () => {
    const packageJson = readPackageJson();

    expect(packageJson.name).toBe("crumbtrail-node");
    expect(packageJson.type).toBe("module");
    // The `crumbtrail-server` binary and the analysis it drove moved to the
    // cloud. Nothing here is meant to be run; this package is imported by the
    // customer's own process and nothing else.
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.main).toBe("./dist/index.cjs");
    expect(packageJson.module).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs",
    });
    expect(packageJson.files).toContain("dist");
  });

  it("builds one dual-format library entry", () => {
    const tsupConfig = fs.readFileSync(
      path.join(packageRoot, "tsup.config.ts"),
      "utf8",
    );

    expect(tsupConfig).toContain('entry: ["src/index.ts"]');
    expect(tsupConfig).toContain('format: ["esm", "cjs"]');
    expect(tsupConfig).toContain("dts: true");
    // No second build: there is no CLI entry left to special-case.
    expect(tsupConfig).not.toContain("src/cli.ts");
  });

  it("exports the capture primitives the setup wizard injects", () => {
    expect(typeof autoCapture).toBe("function");
    expect(typeof createCrumbtrailExpressMiddleware).toBe("function");
    expect(typeof createCrumbtrailExpressErrorMiddleware).toBe("function");
    expect(typeof installHttpRequestCapture).toBe("function");
    expect(typeof instrumentDatabaseClient).toBe("function");
  });

  it("exports nothing that analyses a session", async () => {
    const api = await import("../index");
    const analysis = [
      "createServer",
      "McpServer",
      "SessionManager",
      "postProcess",
      "computeDistinctBugSignatures",
      "buildLlmBundle",
    ];

    for (const name of analysis) {
      expect(name in api).toBe(false);
    }
  });
});
