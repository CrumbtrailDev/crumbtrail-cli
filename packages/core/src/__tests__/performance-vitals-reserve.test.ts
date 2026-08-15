import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent } from "../types";
import { DEFAULT_CONFIG } from "../types";

/**
 * The finalized scores — `cls.score`, `lcp.final`, `inp` — are the only vitals
 * anything downstream reads. The raw per-entry stream is an optional complement
 * to them.
 *
 * These tests drive the case that made that ordering matter: a page that
 * produces more raw vitals entries than the raw budget allows. That is the janky
 * page, which is precisely the session whose score is worth having, and while
 * the scores answered to the same counter as the raw entries it was the session
 * that reported nothing. A test that finalizes on a quiet page cannot tell the
 * difference.
 */

class MockPerformanceObserver {
  static instances: MockPerformanceObserver[] = [];

  callback: (list: { getEntries: () => any[] }) => void;
  observeOptions: any = null;
  disconnected = false;

  constructor(callback: (list: { getEntries: () => any[] }) => void) {
    this.callback = callback;
    MockPerformanceObserver.instances.push(this);
  }

  observe(options: any) {
    this.observeOptions = options;
  }

  disconnect() {
    this.disconnected = true;
  }

  simulateEntries(entries: any[]) {
    this.callback({ getEntries: () => entries });
  }

  static byType(type: string): MockPerformanceObserver {
    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === type,
    );
    if (!observer) throw new Error(`no observer registered for ${type}`);
    return observer;
  }
}

/** The raw vitals budget, which these tests deliberately exhaust. */
const RAW_VITALS_LIMIT = 250;

describe("finalized vitals survive an exhausted raw vitals budget", () => {
  let bus: EventBus;
  let events: BugEvent[];

  beforeEach(() => {
    MockPerformanceObserver.instances = [];
    globalThis.PerformanceObserver = MockPerformanceObserver as any;
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    delete (globalThis as any).PerformanceObserver;
    delete (document as any).visibilityState;
  });

  async function loadCollector() {
    const mod = await import("../collectors/performance");
    return mod.performanceCollector;
  }

  function metric(name: string) {
    return events.filter((e) => e.k === "perf" && e.d.metric === name);
  }

  function shift(value: number, startTime: number) {
    return {
      entryType: "layout-shift",
      value,
      startTime,
      hadRecentInput: false,
    };
  }

  it("still reports cls.score after more layout shifts than the raw budget", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    // 400 shifts, all inside one window, against a raw budget of 250.
    MockPerformanceObserver.byType("layout-shift").simulateEntries(
      Array.from({ length: 400 }, (_, i) => shift(0.01, i)),
    );
    bus.flush();

    // The raw stream sheds, exactly as designed, and says so once.
    expect(metric("cls")).toHaveLength(RAW_VITALS_LIMIT);
    expect(events.filter((e) => e.k === "capture_gap")).toHaveLength(1);

    cleanup();
    bus.flush();

    // The score, which is the only thing anything downstream reads, arrives.
    const score = metric("cls.score");
    expect(score).toHaveLength(1);
    // And it is scored from all 400 shifts, not the 250 the raw budget paid
    // for: a shed entry still moved the page, so observation continues past the
    // point where emission stops.
    expect(score[0].d.shiftCount).toBe(400);
    expect(score[0].d.value).toBeCloseTo(4, 5);
  });

  it("still reports lcp.final after the raw budget is exhausted", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    MockPerformanceObserver.byType("layout-shift").simulateEntries(
      Array.from({ length: 300 }, (_, i) => shift(0.01, i)),
    );
    // The last candidate arrives after the raw budget is already gone.
    MockPerformanceObserver.byType("largest-contentful-paint").simulateEntries([
      {
        entryType: "largest-contentful-paint",
        startTime: 8_100,
        size: 40_000,
        element: { tagName: "IMG" },
      },
    ]);
    bus.flush();

    cleanup();
    bus.flush();

    const final = metric("lcp.final");
    expect(final).toHaveLength(1);
    expect(final[0].d.value).toBe(8_100);
    expect(final[0].d.element).toBe("IMG");
  });

  it("still reports inp after the raw budget is exhausted", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    MockPerformanceObserver.byType("layout-shift").simulateEntries(
      Array.from({ length: 300 }, (_, i) => shift(0.01, i)),
    );
    MockPerformanceObserver.byType("event").simulateEntries([
      { entryType: "event", name: "click", duration: 640, interactionId: 7 },
    ]);
    bus.flush();

    cleanup();
    bus.flush();

    const inp = metric("inp");
    expect(inp).toHaveLength(1);
    expect(inp[0].d.value).toBe(640);
  });

  it("keeps the interaction observer running past the raw budget", async () => {
    // The `event` observer emits nothing itself, so stopping it when the raw
    // budget runs out would have starved INP of input rather than of allowance.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    MockPerformanceObserver.byType("layout-shift").simulateEntries(
      Array.from({ length: 300 }, (_, i) => shift(0.01, i)),
    );
    bus.flush();

    expect(MockPerformanceObserver.byType("event").disconnected).toBe(false);
    expect(MockPerformanceObserver.byType("layout-shift").disconnected).toBe(
      false,
    );

    cleanup();
    bus.flush();
    // Everything stops on teardown regardless.
    expect(MockPerformanceObserver.byType("event").disconnected).toBe(true);
  });

  it("still stops the observers that only emit", async () => {
    // `first-input`, `navigation` and `paint` feed no score, so once the raw
    // budget is gone there is nothing left for them to contribute.
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    MockPerformanceObserver.byType("layout-shift").simulateEntries(
      Array.from({ length: 300 }, (_, i) => shift(0.01, i)),
    );
    bus.flush();

    expect(MockPerformanceObserver.byType("first-input").disconnected).toBe(
      true,
    );
    expect(MockPerformanceObserver.byType("paint").disconnected).toBe(true);
    // The bulk budget is untouched and its observers keep running.
    expect(MockPerformanceObserver.byType("resource").disconnected).toBe(false);
  });
});

describe("inp keeps the worst interactions, not the first ones", () => {
  let bus: EventBus;
  let events: BugEvent[];

  beforeEach(() => {
    MockPerformanceObserver.instances = [];
    globalThis.PerformanceObserver = MockPerformanceObserver as any;
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    delete (globalThis as any).PerformanceObserver;
  });

  async function loadCollector() {
    const mod = await import("../collectors/performance");
    return mod.performanceCollector;
  }

  it("reports a slow tail that arrives after the tracking ceiling", async () => {
    // 2,000 interactions. The first 1,500 are at the 40ms threshold floor; the
    // last 500 are genuinely slow. Holding the first 1,000 ids would rank into
    // a prefix of nothing but 40ms records and report `good` for an app that is
    // anything but.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.byType("event");
    observer.simulateEntries(
      Array.from({ length: 1_500 }, (_, i) => ({
        entryType: "event",
        name: "pointerdown",
        duration: 40,
        interactionId: i + 1,
      })),
    );
    observer.simulateEntries(
      Array.from({ length: 500 }, (_, i) => ({
        entryType: "event",
        name: "click",
        duration: 500 + i,
        interactionId: 2_000 + i,
      })),
    );

    cleanup();
    bus.flush();

    const inp = events.filter((e) => e.k === "perf" && e.d.metric === "inp");
    expect(inp).toHaveLength(1);
    expect(inp[0].d.interactionCount).toBe(2_000);
    // rank = min(floor(2000 / 50), size - 1) = 40, so the 41st worst. Over the
    // whole session that is drawn from the slow tail (500..999 descending), so
    // the true answer is 999 - 40 = 959 — which is what the retained worst-N
    // set reports. Holding the first N reported the 40ms floor instead.
    expect(inp[0].d.value).toBe(959);
    expect(inp[0].d.eventType).toBe("click");
  });

  it("clamps upward, not downward, past the tracking ceiling", async () => {
    // 100,000 interactions with strictly increasing durations, so the rank the
    // estimator asks for (2,000) sits far past anything that can be retained
    // and the score has to clamp. Clamping into the retained worst-N lands
    // above the true value: the score over-reports latency rather than hiding
    // it, which is the safe direction for a metric read as a health signal.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.byType("event");
    for (let batch = 0; batch < 100; batch++) {
      observer.simulateEntries(
        Array.from({ length: 1_000 }, (_, i) => {
          const n = batch * 1_000 + i;
          return {
            entryType: "event",
            name: "click",
            duration: 40 + n,
            interactionId: n + 1,
          };
        }),
      );
    }

    cleanup();
    bus.flush();

    const inp = events.filter((e) => e.k === "perf" && e.d.metric === "inp");
    expect(inp).toHaveLength(1);
    expect(inp[0].d.interactionCount).toBe(100_000);
    // Worst duration is 100,039; the k-th worst is 100,040 - k. The true
    // estimator wants the 2,001st worst, 98,039. The clamped answer is the
    // deepest retained record, which is at most the 1,250th worst.
    expect(inp[0].d.value).toBeGreaterThanOrEqual(98_039);
    expect(inp[0].d.value).toBeLessThan(100_040);
  });
});
