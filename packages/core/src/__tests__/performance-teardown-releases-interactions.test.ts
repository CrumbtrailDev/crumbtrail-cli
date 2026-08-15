import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import { DEFAULT_CONFIG } from "../types";

/**
 * The INP estimator holds up to `MAX_TRACKED_INTERACTIONS` records so it can
 * rank them at finalization. Teardown ran the finalizers — which is every read
 * the ranking will ever get — and then left the map populated for the lifetime
 * of the instance that owned it. Bounded, so retained garbage rather than a
 * leak, and worth nothing once the score has been emitted.
 *
 * The map is closure-local by design, so the test reaches it the only honest way
 * available: `performanceCollector` builds exactly one `Map`, so capturing the
 * Maps constructed during the call identifies it unambiguously.
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

describe("performance teardown releases the interaction ranking", () => {
  let bus: EventBus;
  let events: any[];

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

  it("clears the tracked interactions, after the finalizers have read them", async () => {
    const { performanceCollector } = await import("../collectors/performance");

    const built: Map<unknown, unknown>[] = [];
    const RealMap = globalThis.Map;
    class CapturingMap<K, V> extends RealMap<K, V> {
      constructor(...args: any[]) {
        super(...(args as []));
        built.push(this as unknown as Map<unknown, unknown>);
      }
    }
    globalThis.Map = CapturingMap as unknown as MapConstructor;
    let cleanup: () => void;
    try {
      cleanup = performanceCollector(bus, DEFAULT_CONFIG);
    } finally {
      globalThis.Map = RealMap;
    }

    expect(built).toHaveLength(1);
    const interactions = built[0];

    MockPerformanceObserver.byType("event").simulateEntries(
      Array.from({ length: 40 }, (_, i) => ({
        entryType: "event",
        name: "pointerdown",
        duration: 100 + i,
        interactionId: i + 1,
      })),
    );
    expect(interactions.size).toBe(40);

    cleanup();
    bus.flush();

    // The score still lands: clearing happens after the finalizers run, not
    // instead of them.
    expect(
      events.filter((e) => e.k === "perf" && e.d.metric === "inp"),
    ).toHaveLength(1);
    expect(interactions.size).toBe(0);
  });
});
