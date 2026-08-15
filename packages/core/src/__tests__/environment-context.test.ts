import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEnvSnapshot } from "../collectors/environment";
import type { RedactionMetadata } from "../redaction";

/**
 * D2: referrer plus device/connection context inside the existing `k:'env'`
 * snapshot. The environment collector runs before anything else in a session,
 * so absence of a capability must degrade to a missing key, never to a throw
 * and never to a fabricated empty value.
 */

/** Replaces `document` with a stub carrying the given referrer. */
function stubReferrer(referrer: string): void {
  vi.stubGlobal("document", {
    referrer,
    querySelector: () => null,
  });
}

const metadataOf = (redaction: unknown): RedactionMetadata =>
  redaction as RedactionMetadata;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("env snapshot: referrer", () => {
  it("omits the key entirely when document.referrer is empty", () => {
    stubReferrer("");
    const snapshot = buildEnvSnapshot();
    expect("referrer" in snapshot).toBe(false);
  });

  it("omits the key when document itself is unavailable", () => {
    vi.stubGlobal("document", undefined);
    expect("referrer" in buildEnvSnapshot()).toBe(false);
  });

  it("keeps an ordinary referrer intact", () => {
    stubReferrer("https://news.example.com/story/12345");
    expect(buildEnvSnapshot().referrer).toBe(
      "https://news.example.com/story/12345",
    );
  });

  it("redacts query values on the referrer and records the metadata", () => {
    stubReferrer("https://ref.example.com/landing?token=abc123def456ghi789");
    const snapshot = buildEnvSnapshot();

    expect(snapshot.referrer).toBeDefined();
    expect(snapshot.referrer).not.toContain("abc123def456ghi789");
    expect(metadataOf(snapshot.redaction).fields.length).toBeGreaterThan(0);
    expect(
      metadataOf(snapshot.redaction).fields.every((field) =>
        field.path.startsWith("env.referrer"),
      ),
    ).toBe(true);
  });

  it("merges referrer redaction metadata with flag/config metadata rather than replacing either", () => {
    stubReferrer("https://ref.example.com/landing?token=abc123def456ghi789");
    const snapshot = buildEnvSnapshot(
      { authToken: "sk_live_abcdefghijklmnopqrst" },
      { apiKey: "sk_live_zyxwvutsrqponmlkjihg" },
    );

    const paths = metadataOf(snapshot.redaction).fields.map(
      (field) => field.path,
    );
    // All three sources survive the merge. Before D2 the flag/config writer
    // assigned `redaction` outright, which dropped the referrer's fields.
    expect(paths.some((path) => path.startsWith("env.referrer"))).toBe(true);
    expect(paths.some((path) => path.startsWith("env.flags"))).toBe(true);
    expect(paths.some((path) => path.startsWith("env.config"))).toBe(true);
    expect(metadataOf(snapshot.redaction).policy).toBeDefined();
  });
});

describe("env snapshot: device", () => {
  it("reads dpr, screen size and orientation when the runtime exposes them", () => {
    vi.stubGlobal("window", {
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 3,
      screen: {
        width: 1440,
        height: 900,
        orientation: { type: "landscape-primary" },
      },
    });

    expect(buildEnvSnapshot().device).toEqual({
      dpr: 3,
      screen: { w: 1440, h: 900 },
      orientation: "landscape-primary",
    });
  });

  it("keeps dpr and screen when screen.orientation is absent", () => {
    vi.stubGlobal("window", {
      devicePixelRatio: 2,
      screen: { width: 1024, height: 768 },
    });

    expect(buildEnvSnapshot().device).toEqual({
      dpr: 2,
      screen: { w: 1024, h: 768 },
    });
  });

  it("omits the device key when window exposes nothing usable", () => {
    vi.stubGlobal("window", { devicePixelRatio: "2x", screen: undefined });
    expect("device" in buildEnvSnapshot()).toBe(false);
  });

  it("does not throw when reading screen throws", () => {
    vi.stubGlobal("window", {
      devicePixelRatio: 2,
      get screen(): never {
        throw new Error("blocked by sandbox");
      },
    });

    let snapshot!: ReturnType<typeof buildEnvSnapshot>;
    expect(() => {
      snapshot = buildEnvSnapshot();
    }).not.toThrow();
    expect(snapshot.device).toEqual({ dpr: 2 });
  });
});

describe("env snapshot: connection and hardware", () => {
  it("omits connection/deviceMemory/hardwareConcurrency when unsupported, without throwing", () => {
    // happy-dom does not implement the Network Information API, so this is the
    // default path rather than an edge case. The stub pins that: a navigator
    // that exists and answers userAgent, but exposes none of the three.
    vi.stubGlobal("navigator", { userAgent: "probe-ua", language: "en-GB" });

    const snapshot = buildEnvSnapshot();

    // Proof the collector actually ran against this navigator, so the absences
    // below are "unsupported", not "code never executed".
    expect(snapshot.userAgent).toBe("probe-ua");
    expect("connection" in snapshot).toBe(false);
    expect("deviceMemory" in snapshot).toBe(false);
    expect("hardwareConcurrency" in snapshot).toBe(false);
  });

  it("reads the Network Information API and the hardware counters when present", () => {
    vi.stubGlobal("navigator", {
      userAgent: "probe-ua",
      connection: {
        effectiveType: "3g",
        downlink: 1.55,
        rtt: 300,
        saveData: true,
      },
      deviceMemory: 8,
      hardwareConcurrency: 12,
    });

    const snapshot = buildEnvSnapshot();
    expect(snapshot.connection).toEqual({
      effectiveType: "3g",
      downlink: 1.55,
      rtt: 300,
      saveData: true,
    });
    expect(snapshot.deviceMemory).toBe(8);
    expect(snapshot.hardwareConcurrency).toBe(12);
  });

  it("keeps the fields the connection object does expose and drops the rest", () => {
    vi.stubGlobal("navigator", {
      userAgent: "probe-ua",
      connection: { effectiveType: "4g", downlink: null, saveData: "yes" },
      deviceMemory: 0,
      hardwareConcurrency: Number.NaN,
    });

    const snapshot = buildEnvSnapshot();
    expect(snapshot.connection).toEqual({ effectiveType: "4g" });
    expect("deviceMemory" in snapshot).toBe(false);
    expect("hardwareConcurrency" in snapshot).toBe(false);
  });

  it("does not throw when navigator.connection access throws", () => {
    vi.stubGlobal("navigator", {
      userAgent: "probe-ua",
      get connection(): never {
        throw new Error("blocked by sandbox");
      },
    });

    expect(() => buildEnvSnapshot()).not.toThrow();
    expect("connection" in buildEnvSnapshot()).toBe(false);
  });
});

describe("env snapshot: SSR contract", () => {
  it("returns only kind/locale/timezone with document, navigator and window undefined", () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);

    const snapshot = buildEnvSnapshot();

    expect(snapshot.kind).toBe("snapshot");
    expect(typeof snapshot.locale).toBe("string");
    expect(typeof snapshot.timezone).toBe("string");
    expect(Object.keys(snapshot).sort()).toEqual([
      "kind",
      "locale",
      "timezone",
    ]);
  });
});
