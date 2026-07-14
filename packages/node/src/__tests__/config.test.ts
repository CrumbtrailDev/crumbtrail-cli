import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CliConfigError,
  defaultCliConfig,
  isLoopbackHost,
  parseCliConfig,
  resolveCliConfig,
  validateCliConfig,
} from "../config";

const tempPaths: string[] = [];

describe("auth token precedence (--auth-token vs CRUMBTRAIL_AUTH_TOKEN)", () => {
  const ENV = "CRUMBTRAIL_AUTH_TOKEN";
  const original = process.env[ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("reads the auth token from the env var when no flag is passed (env-only)", () => {
    process.env[ENV] = "env-token";
    expect(parseCliConfig([]).authToken).toBe("env-token");
  });

  it("uses the flag when no env var is set (arg-only)", () => {
    delete process.env[ENV];
    expect(parseCliConfig(["--auth-token", "arg-token"]).authToken).toBe(
      "arg-token",
    );
  });

  it("prefers the flag over the env var when both are present (arg wins)", () => {
    process.env[ENV] = "env-token";
    expect(parseCliConfig(["--auth-token", "arg-token"]).authToken).toBe(
      "arg-token",
    );
  });

  it("leaves auth disabled when neither is provided", () => {
    delete process.env[ENV];
    expect(parseCliConfig([]).authToken).toBeUndefined();
  });

  it("treats a blank env var as unset", () => {
    process.env[ENV] = "   ";
    expect(parseCliConfig([]).authToken).toBeUndefined();
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-config-test-"));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("CLI config normalization", () => {
  it.each(["localhost", "127.0.0.1", "127.10.20.30", "::1", "[::1]"])(
    "treats %s as loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "crumbtrail.local",
    "127.0.0.1.evil.example",
  ])("treats %s as non-loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it("returns local self-host defaults", () => {
    const config = defaultCliConfig();

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9898);
    expect(config.output).toContain(path.join(".crumbtrail", "sessions"));
    expect(config.whisperModel).toBe("base");
    expect(config.mcp).toBe(false);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.ai).toBe(false);
    expect(config.aiAllowAutoModel).toBe(false);
  });

  it("parses explicit HTTP runtime config", () => {
    const config = parseCliConfig([
      "--host",
      "0.0.0.0",
      "--port",
      "49152",
      "--output",
      "/tmp/crumbtrail-sessions",
      "--static",
      "/tmp/crumbtrail-static",
      "--allow-origin",
      "https://app.example.com",
      "--allow-origin",
      "http://localhost:5173",
      "--auth-token",
      "test-token",
      "--whisper-model",
      "tiny",
    ]);

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 49152,
      output: "/tmp/crumbtrail-sessions",
      staticDir: "/tmp/crumbtrail-static",
      authToken: "test-token",
      whisperModel: "tiny",
      allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
      mcp: false,
      ai: false,
    });
  });

  it("parses MCP and AI runtime config", () => {
    const config = parseCliConfig([
      "--mcp",
      "--output",
      "/tmp/mcp-sessions",
      "--ai",
      "--ai-model",
      "openai/gpt-4.1-mini",
      "--ai-allow-auto-model",
    ]);

    expect(config.mcp).toBe(true);
    expect(config.output).toBe("/tmp/mcp-sessions");
    expect(config.ai).toBe(true);
    expect(config.aiModel).toBe("openai/gpt-4.1-mini");
    expect(config.aiAllowAutoModel).toBe(true);
  });

  it("validates explicit local runtime config", () => {
    const staticDir = makeTempDir();
    const config = resolveCliConfig([
      "--host",
      "127.0.0.1",
      "--port",
      "9899",
      "--output",
      path.join(staticDir, "sessions"),
      "--static",
      staticDir,
      "--allow-origin",
      "https://app.example.com",
    ]);

    expect(config.staticDir).toBe(staticDir);
    expect(config.allowedOrigins).toEqual(["https://app.example.com"]);
  });

  it.each([
    ["invalid_port", { port: 0 }],
    ["invalid_port", { port: 65_536 }],
    ["invalid_port", { port: Number.NaN }],
    ["invalid_host", { host: "   " }],
    ["invalid_output", { output: "   " }],
    ["invalid_output", { output: "bad\0path" }],
  ])("rejects malformed scalar config with %s", (code, patch) => {
    expect(() =>
      validateCliConfig({ ...defaultCliConfig(), ...patch }),
    ).toThrowError(CliConfigError);
    expect(() =>
      validateCliConfig({ ...defaultCliConfig(), ...patch }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it("rejects missing static directories", () => {
    expect(() =>
      validateCliConfig({
        ...defaultCliConfig(),
        staticDir: path.join(os.tmpdir(), "missing-crumbtrail-static-dir"),
      }),
    ).toThrow(expect.objectContaining({ code: "static_dir_not_found" }));
  });

  it("rejects static paths that are not directories", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "index.html");
    fs.writeFileSync(filePath, "<!doctype html>");

    expect(() =>
      validateCliConfig({ ...defaultCliConfig(), staticDir: filePath }),
    ).toThrow(expect.objectContaining({ code: "static_dir_not_directory" }));
  });

  it.each([
    "not-a-url",
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?token=secret",
  ])("rejects malformed allowed origin %s", (origin) => {
    expect(() =>
      validateCliConfig({ ...defaultCliConfig(), allowedOrigins: [origin] }),
    ).toThrow(expect.objectContaining({ code: "invalid_origin" }));
  });
});
