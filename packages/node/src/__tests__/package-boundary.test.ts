import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
  createServer,
  McpServer,
  SessionManager,
} from "../index";
import { parseArgs } from "../cli";

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
  it("declares the built local server binary as the package runtime entrypoint", () => {
    const packageJson = readPackageJson();

    expect(packageJson.name).toBe("crumbtrail-node");
    expect(packageJson.type).toBe("module");
    // `crumbtrail` is reserved for the packages/cli setup wizard bin — this
    // package only exposes the server runtime under `crumbtrail-server` to
    // avoid a bin collision when both packages are installed together.
    expect(packageJson.bin).toEqual({
      "crumbtrail-server": "./dist/cli.cjs",
    });
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

  it("build config emits both the public API and CLI entrypoints", () => {
    const tsupConfig = fs.readFileSync(
      path.join(packageRoot, "tsup.config.ts"),
      "utf8",
    );

    expect(tsupConfig).toContain('entry: ["src/index.ts", "src/cli.ts"]');
    expect(tsupConfig).toContain('format: ["esm", "cjs"]');
    expect(tsupConfig).toContain("dts: true");
  });

  it("exports the runtime primitives consumed by self-host integrations", () => {
    expect(typeof createServer).toBe("function");
    expect(typeof SessionManager).toBe("function");
    expect(typeof McpServer).toBe("function");
    expect(typeof createCrumbtrailExpressMiddleware).toBe("function");
    expect(typeof createCrumbtrailExpressErrorMiddleware).toBe("function");
  });

  it("keeps CLI defaults suitable for local self-host startup", () => {
    const parsed = parseArgs([]);

    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(9898);
    expect(parsed.output).toContain(path.join(".crumbtrail", "sessions"));
    expect(parsed.allowedOrigins).toEqual([]);
    expect(parsed.mcp).toBe(false);
    expect(parsed.ai).toBe(false);
  });
});
