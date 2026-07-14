import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { createServer } from "../server";
import {
  evaluateDoctor,
  probeRoundTrip,
  resolveDoctorConfig,
  runDoctor,
  type DoctorCheck,
} from "../doctor";

describe("evaluateDoctor", () => {
  const check = (status: DoctorCheck["status"]): DoctorCheck => ({
    name: "x",
    status,
    detail: "d",
  });

  it("is ok when every check passes", () => {
    const report = evaluateDoctor([check("pass"), check("pass")]);
    expect(report.ok).toBe(true);
  });

  it("is ok when checks only warn", () => {
    const report = evaluateDoctor([check("pass"), check("warn")]);
    expect(report.ok).toBe(true);
  });

  it("is not ok when any check fails", () => {
    const report = evaluateDoctor([check("pass"), check("fail")]);
    expect(report.ok).toBe(false);
  });

  it("summarises pass/warn/fail counts", () => {
    const report = evaluateDoctor([
      check("pass"),
      check("warn"),
      check("fail"),
    ]);
    expect(report.summary).toContain("1 passed");
    expect(report.summary).toContain("1 warning");
    expect(report.summary).toContain("1 failed");
  });
});

describe("probeRoundTrip", () => {
  let tmpDir: string;
  let server: http.Server;
  let endpoint: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-doctor-"));
    server = createServer({ port: 0, outputDir: tmpDir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    endpoint = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends a correlated front+back round-trip and reads it back linked via MCP", async () => {
    const result = await probeRoundTrip({ endpoint, outputDir: tmpDir });

    expect(result.linked).toBe(true);
    expect(result.correlationStatus).toBe("linked");
    expect(result.frontendStatus).toBe(500);
    expect(result.backendStatus).toBe(500);
    expect(result.sessionId).toBeTruthy();
    expect(result.requestId).toBeTruthy();
  });
});

describe("resolveDoctorConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-doctor-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to local self-host defaults when no config file exists", () => {
    const config = resolveDoctorConfig(tmpDir);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9898);
    expect(config.output).toBe(path.join(tmpDir, ".crumbtrail", "sessions"));
  });

  it("reads port and output from crumbtrail.config.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "crumbtrail.config.json"),
      JSON.stringify({ host: "127.0.0.1", port: 4321, output: "/custom/out" }),
    );
    const config = resolveDoctorConfig(tmpDir);
    expect(config.port).toBe(4321);
    expect(config.output).toBe("/custom/out");
  });

  it("lets an override port win over the config file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "crumbtrail.config.json"),
      JSON.stringify({ port: 4321 }),
    );
    expect(resolveDoctorConfig(tmpDir, 5000).port).toBe(5000);
  });
});

describe("runDoctor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-rundoctor-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts its own server when none is running and reports a passing round-trip", async () => {
    const { report, startedServer } = await runDoctor({
      config: {
        host: "127.0.0.1",
        port: 0,
        output: path.join(tmpDir, "sessions"),
      },
    });

    expect(startedServer).toBe(true);
    expect(report.ok).toBe(true);
    expect(
      report.checks.find((c) => c.name === "capture+correlation")?.status,
    ).toBe("pass");
  });
});
