import { describe, it, expect } from "vitest";
import path from "node:path";
import { detectTelemetry, buildInitPlan } from "../init-plan";

describe("detectTelemetry", () => {
  it("detects OpenTelemetry deps", () => {
    const d = detectTelemetry({
      cwd: "/nonexistent",
      pkg: { dependencies: { "@opentelemetry/api": "1.0.0" } },
      env: {},
    });
    expect(d.detected).toBe(true);
    expect(d.signals).toContain("opentelemetry");
  });
  it("detects Sentry, Datadog, and OTLP env together", () => {
    const d = detectTelemetry({
      cwd: "/nonexistent",
      pkg: { dependencies: { "@sentry/node": "7", "dd-trace": "4" } },
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
    });
    expect(d.signals).toEqual(
      expect.arrayContaining(["sentry", "datadog", "otlp-env"]),
    );
  });
  it("returns detected=false for a greenfield project", () => {
    expect(detectTelemetry({ cwd: "/nonexistent", pkg: {}, env: {} })).toEqual({
      detected: false,
      signals: [],
    });
  });
  it("detects Splunk from a @splunk/* dependency", () => {
    const d = detectTelemetry({
      cwd: "/nonexistent",
      pkg: { dependencies: { "@splunk/otel": "0.1.0" } },
      env: {},
    });
    expect(d.detected).toBe(true);
    expect(d.signals).toContain("splunk");
  });
  it("detects Splunk from the splunk-otel-js dependency", () => {
    const d = detectTelemetry({
      cwd: "/nonexistent",
      pkg: { devDependencies: { "splunk-otel-js": "2" } },
      env: {},
    });
    expect(d.signals).toContain("splunk");
  });
  it("detects Splunk from env (SPLUNK_ACCESS_TOKEN) without regressing other signals", () => {
    const d = detectTelemetry({
      cwd: "/nonexistent",
      pkg: { dependencies: { "@opentelemetry/api": "1" } },
      env: {
        SPLUNK_ACCESS_TOKEN: "tok",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      },
    });
    expect(d.signals).toEqual(
      expect.arrayContaining(["opentelemetry", "otlp-env", "splunk"]),
    );
  });
  it("does not flag Splunk for a greenfield project", () => {
    expect(
      detectTelemetry({ cwd: "/nonexistent", pkg: {}, env: {} }).signals,
    ).not.toContain("splunk");
  });
});

describe("buildInitPlan telemetry branch", () => {
  it("emits a telemetry recipe and NO express server helper when telemetry is detected", () => {
    const plan = buildInitPlan({
      cwd: "/proj",
      pkg: { dependencies: { express: "5", "@opentelemetry/api": "1" } },
      packageManager: "npm",
      env: {},
    });
    const names = plan.files.map((f) => path.basename(f.path));
    expect(names).toContain("crumbtrail.client.js");
    expect(names).toContain("crumbtrail.telemetry.md");
    expect(names).not.toContain("crumbtrail.server.js");
    expect(plan.telemetryDetected).toBe(true);
    expect(plan.nextSteps.join("\n")).toContain("/v1/traces");
  });
  it("emits the express server helper for a greenfield express project", () => {
    const plan = buildInitPlan({
      cwd: "/proj",
      pkg: { dependencies: { express: "5" } },
      packageManager: "npm",
      env: {},
    });
    const names = plan.files.map((f) => path.basename(f.path));
    expect(names).toContain("crumbtrail.server.js");
    expect(names).not.toContain("crumbtrail.telemetry.md");
    expect(plan.telemetryDetected).toBe(false);
  });
});
