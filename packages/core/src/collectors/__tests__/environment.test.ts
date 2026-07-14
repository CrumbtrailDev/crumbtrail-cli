import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBus } from "../../event-bus";
import {
  DEFAULT_CONFIG,
  type BugEvent,
  type CollectorContext,
  type EnvSnapshot,
} from "../../types";
import {
  environmentCollector,
  buildEnvSnapshot,
  buildEnvDelta,
} from "../environment";

function ctx(overrides: Partial<CollectorContext> = {}): CollectorContext {
  return { sessionId: "ses_env", ...overrides };
}

describe("environmentCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    bus.stop();
  });

  it("emits exactly one k:env snapshot event at session start", () => {
    const cleanup = environmentCollector(bus, DEFAULT_CONFIG, ctx());
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("env");
    expect((events[0].d as unknown as EnvSnapshot).kind).toBe("snapshot");
    cleanup();
  });

  it("captures locale/timezone from Intl and does not throw", () => {
    expect(() =>
      environmentCollector(bus, DEFAULT_CONFIG, ctx()),
    ).not.toThrow();
    bus.flush();

    const snap = events[0].d as unknown as EnvSnapshot;
    // Intl exists in every runtime (browser + Node), so locale/timezone are always resolvable.
    expect(typeof snap.locale).toBe("string");
    expect(typeof snap.timezone).toBe("string");
  });

  it("stays a no-op-safe minimal snapshot when navigator/window are absent (SSR guard)", () => {
    // Simulate a non-browser/SSR runtime; vi.unstubAllGlobals restores happy-dom afterward.
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);
    try {
      const snap = buildEnvSnapshot();
      expect(snap.kind).toBe("snapshot");
      expect(snap.userAgent).toBeUndefined();
      expect(snap.viewport).toBeUndefined();
      // Intl-derived fields survive without a browser.
      expect(typeof snap.locale).toBe("string");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("folds env declared before the snapshot into the snapshot (before-merge path)", () => {
    const cleanup = environmentCollector(
      bus,
      DEFAULT_CONFIG,
      ctx({
        getDeclaredEnv: () => ({
          flags: { newCheckout: true },
          config: { region: "eu" },
        }),
      }),
    );
    bus.flush();

    const snap = events[0].d as unknown as EnvSnapshot;
    expect(snap.flags).toEqual({ newCheckout: true });
    expect(snap.config).toEqual({ region: "eu" });
    cleanup();
  });

  it("invokes onEnvEmitted after emitting the snapshot", () => {
    let emitted = false;
    environmentCollector(
      bus,
      DEFAULT_CONFIG,
      ctx({
        onEnvEmitted: () => {
          emitted = true;
        },
      }),
    );
    expect(emitted).toBe(true);
  });
});

describe("buildEnvSnapshot redaction", () => {
  it("redacts secret-looking flag/config values before they rest", () => {
    const snap = buildEnvSnapshot(
      { apiKey: "sk_fake_abcdefghijklmnopqrstuvwx", betaUi: true },
      { password: "hunter2-very-secret", region: "us" },
    );

    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("sk_fake_abcdefghijklmnopqrstuvwx");
    expect(serialized).not.toContain("hunter2-very-secret");
    // Non-secret values are preserved.
    expect(snap.flags?.betaUi).toBe(true);
    expect(snap.config?.region).toBe("us");
    // Redaction evidence is attached.
    expect(snap.redaction).toBeDefined();
  });
});

describe("buildEnvDelta", () => {
  it("produces a redacted delta payload", () => {
    const delta = buildEnvDelta(
      { token: "secrettokenvalue1234567890abcd" },
      undefined,
    );
    expect(delta.kind).toBe("delta");
    expect(JSON.stringify(delta)).not.toContain(
      "secrettokenvalue1234567890abcd",
    );
  });
});
