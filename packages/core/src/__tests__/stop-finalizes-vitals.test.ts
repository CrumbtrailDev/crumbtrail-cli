import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crumbtrail } from "../bug-logger";
import type { BugEvent } from "../types";

/**
 * The finalized vitals — INP, the CLS score and the final LCP — exist only as
 * finalizers the performance collector runs on cleanup. `stop()` runs those
 * cleanups, so the only question these tests can usefully ask is whether the
 * scores actually reached the transport. Asserting on collector or logger
 * internals would pass even while the session shipped nothing.
 */

class MockPerformanceObserver {
  static instances: MockPerformanceObserver[] = [];
  static supportedEntryTypes = [
    "resource",
    "longtask",
    "layout-shift",
    "largest-contentful-paint",
    "first-input",
    "navigation",
    "paint",
    "event",
  ];

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

function makeTransport() {
  const sent: BugEvent[] = [];
  return {
    sent,
    transport: {
      sendEvents: vi.fn(async (events: BugEvent[]) => {
        sent.push(...events);
      }),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/** Feed one scoring entry to each of the three finalized vitals. */
function produceVitals(): void {
  MockPerformanceObserver.byType("layout-shift").simulateEntries([
    {
      entryType: "layout-shift",
      value: 0.25,
      startTime: 120,
      hadRecentInput: false,
    },
  ]);
  MockPerformanceObserver.byType("largest-contentful-paint").simulateEntries([
    {
      entryType: "largest-contentful-paint",
      startTime: 1_200,
      size: 40_000,
      element: { tagName: "IMG" },
    },
  ]);
  MockPerformanceObserver.byType("event").simulateEntries([
    {
      entryType: "event",
      name: "pointerdown",
      duration: 320,
      interactionId: 7,
      startTime: 500,
    },
  ]);
}

function transportedMetrics(events: BugEvent[]): string[] {
  return events
    .filter((event) => event.k === "perf")
    .map((event) => String((event.d as Record<string, unknown>).metric));
}

describe("Crumbtrail.stop() and the finalized vitals", () => {
  beforeEach(() => {
    MockPerformanceObserver.instances = [];
    globalThis.PerformanceObserver = MockPerformanceObserver as any;
  });

  afterEach(() => {
    delete (globalThis as any).PerformanceObserver;
    delete (document as any).visibilityState;
    vi.restoreAllMocks();
  });

  it("ships cls.score, lcp.final and inp to the transport on an explicit stop()", async () => {
    const { sent, transport } = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      // Long enough that nothing is flushed by the interval: every event the
      // transport sees was shipped by stop() itself.
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
      performance: true,
    });

    produceVitals();
    await logger.stop();

    const metrics = transportedMetrics(sent);
    expect(metrics).toContain("cls.score");
    expect(metrics).toContain("lcp.final");
    expect(metrics).toContain("inp");
  });

  it("carries the scored values, not just the metric names", async () => {
    const { sent, transport } = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
      performance: true,
    });

    produceVitals();
    await logger.stop();

    const byMetric = new Map(
      sent
        .filter((event) => event.k === "perf")
        .map((event) => [
          String((event.d as Record<string, unknown>).metric),
          event.d as Record<string, unknown>,
        ]),
    );

    expect(byMetric.get("cls.score")).toMatchObject({
      value: 0.25,
      shiftCount: 1,
    });
    expect(byMetric.get("lcp.final")).toMatchObject({
      value: 1_200,
      element: "IMG",
    });
    expect(byMetric.get("inp")).toMatchObject({
      value: 320,
      eventType: "pointerdown",
      interactionCount: 1,
    });
  });

  it("does not double-report a score already finalized by the page going hidden", async () => {
    const { sent, transport } = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
      performance: true,
    });

    produceVitals();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await logger.stop();

    const metrics = transportedMetrics(sent);
    for (const metric of ["cls.score", "lcp.final", "inp"]) {
      expect(metrics.filter((m) => m === metric)).toHaveLength(1);
    }
  });
});
