import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { createAutoFlagController } from "../auto-flag";
import { rageClickDetector, retryStormDetector } from "../signals";
import type { BugEvent, FlagBugOptions } from "../types";

function errEvent(msg: string, stk?: string): BugEvent {
  return { t: Date.now(), k: "err", d: { msg, stk } };
}

describe("createAutoFlagController", () => {
  let flag: Mock<(options: FlagBugOptions) => Promise<unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    flag = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function controller(overrides?: {
    debounceMs?: number;
    maxPerSession?: number;
  }) {
    return createAutoFlagController({
      debounceMs: overrides?.debounceMs ?? 2000,
      maxPerSession: overrides?.maxPerSession ?? 10,
      flag,
    });
  }

  it("flags once after the debounce window for an error event", () => {
    const c = controller();
    c.handleEvent(errEvent("boom", "Error: boom\n  at a.js:1"));

    expect(flag).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(flag).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flag).toHaveBeenCalledTimes(1);
    expect(flag.mock.calls[0][0].tags).toContain("auto:error");
    expect(flag.mock.calls[0][0].note).toContain("boom");
  });

  it("coalesces an error burst into a single flag", () => {
    const c = controller();
    for (let i = 0; i < 50; i++) {
      c.handleEvent(errEvent(`cascade ${i}`, `Error\n  at x.js:${i}`));
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(2000);
    expect(flag).toHaveBeenCalledTimes(1);
  });

  it("does not flag the same signature twice", () => {
    const c = controller();
    c.handleEvent(errEvent("boom", "Error: boom\n  at a.js:1"));
    vi.advanceTimersByTime(2000);
    c.handleEvent(errEvent("boom", "Error: boom\n  at a.js:1"));
    vi.advanceTimersByTime(2000);
    expect(flag).toHaveBeenCalledTimes(1);
  });

  it("flags distinct signatures separately once the previous burst settled", () => {
    const c = controller();
    c.handleEvent(errEvent("boom a", "Error\n  at a.js:1"));
    vi.advanceTimersByTime(2000);
    c.handleEvent(errEvent("boom b", "Error\n  at b.js:1"));
    vi.advanceTimersByTime(2000);
    expect(flag).toHaveBeenCalledTimes(2);
  });

  it("stops flagging after maxPerSession signatures", () => {
    const c = controller({ maxPerSession: 2 });
    c.handleEvent(errEvent("one"));
    vi.advanceTimersByTime(2000);
    c.handleEvent(errEvent("two"));
    vi.advanceTimersByTime(2000);
    c.handleEvent(errEvent("three"));
    vi.advanceTimersByTime(2000);
    expect(flag).toHaveBeenCalledTimes(2);
  });

  it("ignores non-error events", () => {
    const c = controller();
    c.handleEvent({ t: Date.now(), k: "net.req", d: { url: "/x" } });
    c.handleEvent({ t: Date.now(), k: "console", d: { msg: "hi" } });
    vi.advanceTimersByTime(2000);
    expect(flag).not.toHaveBeenCalled();
  });

  it("handles unhandled rejection events too", () => {
    const c = controller();
    c.handleEvent({ t: Date.now(), k: "rej", d: { msg: "rejected" } });
    vi.advanceTimersByTime(2000);
    expect(flag).toHaveBeenCalledTimes(1);
  });

  it("dispose() cancels a pending flag", () => {
    const c = controller();
    c.handleEvent(errEvent("boom"));
    c.dispose();
    vi.advanceTimersByTime(2000);
    expect(flag).not.toHaveBeenCalled();
  });

  describe("behavioral detectors (precognitive capture)", () => {
    it("auto-flags a rage-click cluster with no error present", () => {
      const c = createAutoFlagController({
        debounceMs: 2000,
        maxPerSession: 10,
        flag,
        detectors: [rageClickDetector({ threshold: 3, windowMs: 1000 })],
      });
      const el = { sig: "btn-checkout" };
      c.handleEvent({ t: 0, k: "clk", d: { el } });
      c.handleEvent({ t: 100, k: "clk", d: { el } });
      c.handleEvent({ t: 200, k: "clk", d: { el } });
      vi.advanceTimersByTime(2000);
      expect(flag).toHaveBeenCalledTimes(1);
      expect(flag.mock.calls[0][0].tags).toContain("auto:rage-click");
    });

    it("shares one per-session cap across every detector", () => {
      const c = createAutoFlagController({
        debounceMs: 2000,
        maxPerSession: 1,
        flag,
        detectors: [
          rageClickDetector({ threshold: 2, windowMs: 1000 }),
          retryStormDetector({ threshold: 2, windowMs: 2000 }),
        ],
      });
      const el = { sig: "btn" };
      c.handleEvent({ t: 0, k: "clk", d: { el } });
      c.handleEvent({ t: 100, k: "clk", d: { el } });
      vi.advanceTimersByTime(2000); // first flag consumes the cap
      c.handleEvent({
        t: 3000,
        k: "net.req",
        d: { id: 1, method: "GET", url: "/a" },
      });
      c.handleEvent({
        t: 3100,
        k: "net.req",
        d: { id: 2, method: "GET", url: "/a" },
      });
      vi.advanceTimersByTime(2000);
      expect(flag).toHaveBeenCalledTimes(1);
    });
  });
});
