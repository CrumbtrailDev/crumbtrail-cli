import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildCorePackage } from "./build-package.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "../../..");
const esmPath = path.join(packageRoot, "dist/serverless/index.js");
const cjsPath = path.join(packageRoot, "dist/serverless/index.cjs");
const declarationPath = path.join(packageRoot, "dist/serverless/index.d.ts");

beforeAll(() => {
  buildCorePackage(packageRoot);
});

describe("crumbtrail-core/serverless package boundary", () => {
  it("declares one ESM, CJS, and types export backed by the serverless entry", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const tsupConfig = fs.readFileSync(
      path.join(packageRoot, "tsup.config.ts"),
      "utf8",
    );

    expect(packageJson.exports?.["./serverless"]).toEqual({
      types: "./dist/serverless/index.d.ts",
      import: "./dist/serverless/index.js",
      require: "./dist/serverless/index.cjs",
    });
    expect(tsupConfig).toContain("src/serverless/index.ts");
  });

  it("resolves the generated declarations and built ESM and CJS entrypoints", async () => {
    expect(fs.existsSync(declarationPath)).toBe(true);
    expect(fs.existsSync(esmPath)).toBe(true);
    expect(fs.existsSync(cjsPath)).toBe(true);
    expect(fs.readFileSync(declarationPath, "utf8")).toContain(
      "runServerlessInvocation",
    );
    expect(fs.readFileSync(declarationPath, "utf8")).toContain(
      "createServerlessHttpTransport",
    );
    expect(fs.readFileSync(declarationPath, "utf8")).toContain(
      "ServerlessTransportConfig",
    );

    const esm = (await import(
      `${pathToFileURL(esmPath).href}?boundary=${Date.now()}`
    )) as Record<string, unknown>;
    const cjs = createRequire(import.meta.url)(cjsPath) as Record<
      string,
      unknown
    >;
    expect(typeof esm.runServerlessInvocation).toBe("function");
    expect(typeof cjs.runServerlessInvocation).toBe("function");
    expect(typeof esm.createServerlessHttpTransport).toBe("function");
    expect(typeof cjs.createServerlessHttpTransport).toBe("function");
    expect(typeof esm.withCrumbtrailFetch).toBe("function");
    expect(typeof cjs.withCrumbtrailFetch).toBe("function");
  });

  it("imports without Node builtins or browser collector initialization", async () => {
    const windowListener = vi.spyOn(window, "addEventListener");
    const documentListener = vi.spyOn(document, "addEventListener");
    const esmSource = fs.readFileSync(esmPath, "utf8");
    const cjsSource = fs.readFileSync(cjsPath, "utf8");
    const directChunks = Array.from(
      esmSource.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g),
      (match) =>
        fs.readFileSync(path.resolve(path.dirname(esmPath), match[1]), "utf8"),
    );

    for (const source of [esmSource, cjsSource, ...directChunks]) {
      expect(source).not.toMatch(/(?:from\s+["']node:|require\(["']node:)/);
      expect(source).not.toContain("collectors/");
    }

    await import(`${pathToFileURL(esmPath).href}?collectors=${Date.now()}`);
    const require = createRequire(import.meta.url);
    delete require.cache[require.resolve(cjsPath)];
    require(cjsPath);
    expect(windowListener).not.toHaveBeenCalled();
    expect(documentListener).not.toHaveBeenCalled();

    windowListener.mockRestore();
    documentListener.mockRestore();
  });
});
