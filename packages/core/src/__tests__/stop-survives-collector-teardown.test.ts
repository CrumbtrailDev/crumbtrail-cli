import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COLLECTOR_MAP, Crumbtrail } from "../bug-logger";
import type { BugEvent } from "../types";

/**
 * `stop()` runs the collector cleanups, and everything after that loop is load
 * bearing: a second `bus.flush()` that ships the scores the performance
 * finalizers emit from inside the loop, the `stopped` flag, the flight recorder
 * abort that settles a pending `flag()` tail promise, `bus.stop()`, and the
 * end-of-session call.
 *
 * While the loop was unguarded, one collector throwing on teardown skipped all
 * of it — losing the vitals and leaving the tail promise unsettled forever.
 * These tests put a throwing collector ahead of every real one and check that
 * the rest of the shutdown still happens.
 */

class MockPerformanceObserver {
  static instances: MockPerformanceObserver[] = [];

  callback: (list: { getEntries: () => any[] }) => void;
  observeOptions: any = null;

  constructor(callback: (list: { getEntries: () => any[] }) => void) {
    this.callback = callback;
    MockPerformanceObserver.instances.push(this);
  }

  observe(options: any) {
    this.observeOptions = options;
  }

  disconnect() {}

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

const THROWING_KEY = "__teardownThrower";

/**
 * Register a collector whose cleanup throws, ordered ahead of every real one.
 *
 * Order matters: appended, it would tear down last and prove nothing about what
 * a throw skips. `COLLECTOR_MAP` iterates in insertion order, so the map is
 * rebuilt with the thrower first.
 */
function installThrowingCollectorFirst(): () => void {
  const original = Object.entries(COLLECTOR_MAP);
  for (const key of Object.keys(COLLECTOR_MAP)) delete COLLECTOR_MAP[key];
  COLLECTOR_MAP[THROWING_KEY] = () => () => {
    throw new Error("collector teardown blew up");
  };
  for (const [key, collector] of original) COLLECTOR_MAP[key] = collector;

  return () => {
    for (const key of Object.keys(COLLECTOR_MAP)) delete COLLECTOR_MAP[key];
    for (const [key, collector] of original) COLLECTOR_MAP[key] = collector;
  };
}

function initWithThrower(transport: ReturnType<typeof makeTransport>) {
  return Crumbtrail.init({
    transportInstance: transport.transport,
    // Long enough that nothing is shipped by the interval: everything the
    // transport sees was shipped by stop() itself.
    flushIntervalMs: 100_000,
    flushBufferSize: 1_000,
    performance: true,
    [THROWING_KEY]: true,
  } as any);
}

describe("stop() survives a collector that throws on teardown", () => {
  let restoreCollectors: () => void;

  beforeEach(() => {
    MockPerformanceObserver.instances = [];
    globalThis.PerformanceObserver = MockPerformanceObserver as any;
    restoreCollectors = installThrowingCollectorFirst();
  });

  afterEach(() => {
    restoreCollectors();
    delete (globalThis as any).PerformanceObserver;
    delete (document as any).visibilityState;
    vi.restoreAllMocks();
  });

  it("resolves rather than rejecting", async () => {
    const transport = makeTransport();
    const logger = initWithThrower(transport);

    await expect(logger.stop()).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
  });

  it("still ships the finalized vitals emitted by a later collector's cleanup", async () => {
    const transport = makeTransport();
    const logger = initWithThrower(transport);

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
      },
    ]);

    await logger.stop();

    const metrics = transport.sent
      .filter((event) => event.k === "perf")
      .map((event) => String((event.d as Record<string, unknown>).metric));
    expect(metrics).toContain("cls.score");
    expect(metrics).toContain("lcp.final");
    expect(metrics).toContain("inp");
  });

  it("still finalizes the session", async () => {
    const transport = makeTransport();
    const logger = initWithThrower(transport);

    await logger.stop();

    // `endSession` is the last thing stop() does. Reaching it means the flag,
    // the flight recorder abort and the bus stop all ran too.
    expect(transport.transport.endSession).toHaveBeenCalledTimes(1);
  });
});
