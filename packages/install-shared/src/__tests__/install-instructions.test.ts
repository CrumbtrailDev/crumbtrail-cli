import { describe, expect, it } from "vitest";
import { STACK_IDS, type Stack } from "crumbtrail-core";
import {
  BACKEND_JS_STACKS,
  INFRA_STACKS,
  JS_STACKS,
  OTLP_STACKS,
  allStackInstalls,
  buildAgentPrompt,
  buildBackendJsNote,
  buildOtlpSnippets,
  getInstallVariant,
  keyEnvRef,
} from "../index";

const keys = { endpoint: "https://app.crumbtrail.com", apiKey: "bl_live_xyz" };

describe("install-instructions routing", () => {
  it("classifies all 18 stacks with no gaps or overlaps", () => {
    // The four sets partition the full stack list exactly.
    const union = new Set<Stack>([
      ...JS_STACKS,
      ...OTLP_STACKS,
      ...INFRA_STACKS,
    ]);
    expect(union.size).toBe(STACK_IDS.length);
    for (const id of STACK_IDS) expect(union.has(id)).toBe(true);
  });

  it("routes each JS stack to the js variant", () => {
    for (const s of JS_STACKS) {
      expect(getInstallVariant(s).kind).toBe("js");
    }
  });

  it("routes each OTLP stack to the otlp variant", () => {
    for (const s of OTLP_STACKS) {
      const v = getInstallVariant(s);
      expect(v.kind).toBe("otlp");
      expect(v.backendJs).toBe(false);
      expect(v.comingSoon).toBe(false);
    }
  });

  it("flags every infra stack as coming-soon", () => {
    for (const s of INFRA_STACKS) {
      const v = getInstallVariant(s);
      expect(v.kind).toBe("infra");
      expect(v.comingSoon).toBe(true);
    }
  });

  it("marks only express/hono/node as backend-JS (middleware note)", () => {
    const backend = allStackInstalls()
      .filter((v) => v.backendJs)
      .map((v) => v.stack)
      .sort();
    expect(backend).toEqual([...BACKEND_JS_STACKS].sort());
    // Frontend JS stacks are js but not backend.
    expect(getInstallVariant("react").backendJs).toBe(false);
    expect(getInstallVariant("nextjs").backendJs).toBe(false);
  });

  it("covers exactly the 18 known stacks in the table", () => {
    expect(allStackInstalls()).toHaveLength(18);
  });
});

describe("install-instructions snippets", () => {
  it("OTLP snippets use only the real, documented names", () => {
    const s = buildOtlpSnippets(keys);
    expect(s.env).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://app.crumbtrail.com",
    );
    expect(s.authHeader).toContain("X-Crumbtrail-Auth=bl_live_xyz");
    // The Bearer form must percent-encode the space so OTEL's name=value header
    // parsing doesn't silently drop auth (a plain space breaks it).
    expect(s.authHeader).toContain("Authorization=Bearer%20bl_live_xyz");
    expect(s.authHeader).not.toContain("Authorization=Bearer bl_live_xyz");
    expect(s.sessionAttr).toContain("crumbtrail.session.id");
    expect(s.note).toContain("/v1/traces");
    expect(s.note).toContain("/v1/logs");
  });

  it("Express backend note references the real Express middleware exports", () => {
    const note = buildBackendJsNote("express");
    expect(note).toContain("crumbtrail-node");
    expect(note).toContain("createCrumbtrailExpressMiddleware");
    expect(note).toContain("createCrumbtrailExpressErrorMiddleware");
    // No invented names.
    expect(note).not.toContain("attachCrumbtrail");
    expect(note).not.toContain("crumbtrailErrorMiddleware(");
  });

  it("Hono/Node backend note uses the headless session — no framework middleware", () => {
    for (const stack of ["hono", "node"] as const) {
      const note = buildBackendJsNote(stack);
      expect(note).toContain("crumbtrail-node");
      expect(note).toContain("startHeadlessSession");
      expect(note).not.toContain("createCrumbtrailExpressMiddleware");
      expect(note).not.toContain("attachCrumbtrail");
    }
  });

  it("agent prompt is hands-off for JS stacks — env var, never the literal key", () => {
    const p = buildAgentPrompt("react", keys);
    expect(p).toContain("https://app.crumbtrail.com");
    expect(p).toContain("PRESET_PASSIVE");
    // Hands-off: the live key is NEVER baked into the JS prompt; it references
    // the framework-correct env var instead (react → Vite).
    expect(p).not.toContain("bl_live_xyz");
    expect(p).toContain("VITE_CRUMBTRAIL_KEY");
    expect(p).toContain("import.meta.env.VITE_CRUMBTRAIL_KEY");
    // Frontend-only JS stack gets no middleware line.
    expect(p).not.toContain("crumbtrail-node");
  });

  it("agent prompt uses Next's public env var for the nextjs stack", () => {
    const p = buildAgentPrompt("nextjs", keys);
    expect(p).not.toContain("bl_live_xyz");
    expect(p).toContain("process.env.NEXT_PUBLIC_CRUMBTRAIL_KEY");
  });

  it("agent prompt wires the real Express middleware for the express stack", () => {
    const p = buildAgentPrompt("express", keys);
    expect(p).toContain("PRESET_PASSIVE");
    expect(p).toContain("crumbtrail-node");
    expect(p).toContain("createCrumbtrailExpressMiddleware");
    expect(p).toContain("createCrumbtrailExpressErrorMiddleware");
    // Hands-off: backend reads the key from the environment, not a literal.
    expect(p).not.toContain("bl_live_xyz");
    expect(p).toContain("process.env.CRUMBTRAIL_KEY");
    // No invented names.
    expect(p).not.toContain("attachCrumbtrail");
  });

  it("agent prompt uses the headless session for non-express backend-JS stacks", () => {
    for (const stack of ["hono", "node"] as const) {
      const p = buildAgentPrompt(stack, keys);
      expect(p).toContain("PRESET_PASSIVE");
      expect(p).toContain("crumbtrail-node");
      expect(p).toContain("startHeadlessSession");
      expect(p).not.toContain("bl_live_xyz");
      expect(p).toContain("process.env.CRUMBTRAIL_KEY");
      // Express-only middleware must not leak into non-express stacks.
      expect(p).not.toContain("createCrumbtrailExpressMiddleware");
      expect(p).not.toContain("attachCrumbtrail");
    }
  });

  it("agent prompt uses the OTLP path (no SDK) for non-JS backends", () => {
    const p = buildAgentPrompt("django", keys);
    expect(p).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://app.crumbtrail.com",
    );
    // OTLP auth is an env-var header (OTEL_EXPORTER_OTLP_HEADERS), not source, so
    // it legitimately carries the key value.
    expect(p).toContain("X-Crumbtrail-Auth: bl_live_xyz");
    expect(p).toContain("crumbtrail.session.id");
    expect(p).not.toContain("PRESET_PASSIVE");
  });

  it("keyEnvRef maps stacks to the framework-correct public env var", () => {
    expect(keyEnvRef("nextjs")).toEqual({
      envVar: "NEXT_PUBLIC_CRUMBTRAIL_KEY",
      expr: "process.env.NEXT_PUBLIC_CRUMBTRAIL_KEY",
    });
    for (const s of ["react", "vue", "svelte", "vite"] as const) {
      expect(keyEnvRef(s).expr).toBe("import.meta.env.VITE_CRUMBTRAIL_KEY");
    }
    for (const s of ["express", "hono", "node"] as const) {
      expect(keyEnvRef(s).expr).toBe("process.env.CRUMBTRAIL_KEY");
    }
  });
});
