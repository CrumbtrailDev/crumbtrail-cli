import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHealthPayload } from "../health";
import type { ServerConfig } from "../server";

const tempPaths: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-health-test-"));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

function baseConfig(outputDir: string): ServerConfig {
  return {
    port: 9898,
    outputDir,
    staticDir: undefined,
    authToken: undefined,
    allowedOrigins: [],
    ai: { enabled: false },
  };
}

describe("buildHealthPayload", () => {
  it("reports ready local runtime diagnostics", () => {
    const outputDir = makeTempDir();
    const staticDir = makeTempDir();
    const payload = buildHealthPayload(
      {
        ...baseConfig(outputDir),
        staticDir,
        authToken: "secret-token",
        allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
        ai: { enabled: true, model: "openai/gpt-4.1-mini" },
      },
      { startedAt: 1_000, now: new Date(2_500), host: "127.0.0.1" },
    );

    expect(payload).toMatchObject({
      ok: true,
      status: "ready",
      service: "crumbtrail-node",
      timestamp: "1970-01-01T00:00:02.500Z",
      uptimeMs: 1_500,
      config: {
        host: "127.0.0.1",
        port: 9898,
        outputDir,
        staticDir,
        authEnabled: true,
        allowedOriginCount: 2,
        aiEnabled: true,
        mcpMode: false,
      },
      checks: {
        outputDir: {
          path: outputDir,
          exists: true,
          writable: true,
        },
        staticDir: {
          configured: true,
          path: staticDir,
          exists: true,
        },
      },
    });
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("does not expose auth token content or allowed origin values", () => {
    const payload = buildHealthPayload(
      {
        ...baseConfig(makeTempDir()),
        authToken: "super-secret-token",
        allowedOrigins: ["https://tenant.example.com"],
      },
      { startedAt: Date.now(), now: new Date(), host: "127.0.0.1" },
    );

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("tenant.example.com");
    expect(payload.config.authEnabled).toBe(true);
    expect(payload.config.allowedOriginCount).toBe(1);
  });

  it("reports degraded output directory diagnostics when path is not a directory", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "sessions-file");
    fs.writeFileSync(filePath, "not a directory");

    const payload = buildHealthPayload(baseConfig(filePath), {
      startedAt: 1_000,
      now: new Date(1_100),
      host: "127.0.0.1",
    });

    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("degraded");
    expect(payload.checks.outputDir).toMatchObject({
      path: filePath,
      exists: true,
      writable: false,
    });
    expect(payload.checks.outputDir.error?.code).toBeTruthy();
    expect(payload.checks.outputDir.error?.message).toBeTruthy();
  });

  it("reports unconfigured static directory as safe metadata", () => {
    const payload = buildHealthPayload(baseConfig(makeTempDir()), {
      startedAt: 1_000,
      now: new Date(1_000),
      host: "127.0.0.1",
    });

    expect(payload.checks.staticDir).toEqual({ configured: false });
  });
});
