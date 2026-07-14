import { describe, it, expect } from "vitest";
import { checkEvidenceSources } from "../doctor";
import { FakeEvidenceSource } from "../evidence-sources/fake-source";

describe("checkEvidenceSources", () => {
  it("warns when no evidence sources are configured", async () => {
    const checks = await checkEvidenceSources({ sources: [] });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "evidence-sources",
      status: "warn",
    });
  });

  it("lists each source, its auth validity, and declared join keys", async () => {
    const healthy = new FakeEvidenceSource({
      provider: "sentry",
      displayName: "Sentry",
      descriptor: { joinKeys: ["traceId", "time", "release"] },
      health: { ok: true, provider: "sentry", checkedAt: 0 },
    });
    const broken = new FakeEvidenceSource({
      provider: "splunk",
      displayName: "Splunk",
      descriptor: { joinKeys: ["time"] },
      health: {
        ok: false,
        provider: "splunk",
        checkedAt: 0,
        error: "401 unauthorized",
      },
    });

    const checks = await checkEvidenceSources({ sources: [healthy, broken] });
    expect(checks).toHaveLength(2);

    const sentry = checks.find((c) => c.name === "evidence-source:sentry")!;
    expect(sentry.status).toBe("pass");
    expect(sentry.detail).toContain("traceId, time, release");

    const splunk = checks.find((c) => c.name === "evidence-source:splunk")!;
    expect(splunk.status).toBe("fail");
    expect(splunk.detail).toContain("401 unauthorized");
    expect(splunk.detail).toContain("join keys: time");
  });

  it("treats a thrown health() as a fail rather than crashing the run", async () => {
    const throwing = new FakeEvidenceSource({
      provider: "boom",
      health: () => {
        throw new Error("network down");
      },
    });
    const checks = await checkEvidenceSources({ sources: [throwing] });
    expect(checks[0].status).toBe("fail");
    expect(checks[0].detail).toContain("network down");
  });
});
