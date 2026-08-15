import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent } from "../types";
import { DEFAULT_CONFIG } from "../types";

// Mock PerformanceObserver
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

  // Helper to simulate entries
  simulateEntries(entries: any[]) {
    this.callback({ getEntries: () => entries });
  }
}

describe("performanceCollector", () => {
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
    // Visibility is stubbed per test; leaving a document hidden would leak into
    // the next one.
    delete (document as any).visibilityState;
  });

  // Lazy import so PerformanceObserver is available when the module evaluates
  async function loadCollector() {
    const mod = await import("../collectors/performance");
    return mod.performanceCollector;
  }

  it("emits perf event with metric=res for resource entries", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const resourceObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "resource",
    );
    expect(resourceObserver).toBeDefined();

    resourceObserver!.simulateEntries([
      {
        entryType: "resource",
        name: "https://example.com/api/data",
        duration: 150,
        transferSize: 2048,
        initiatorType: "fetch",
      },
    ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("perf");
    expect(events[0].d.metric).toBe("res");
    expect(events[0].d.name).toBe("https://example.com/api/data");
    expect(events[0].d.duration).toBe(150);
    expect(events[0].d.transferSize).toBe(2048);
    expect(events[0].d.initiatorType).toBe("fetch");
  });

  it("caps perf events per session and records the shedding as a capture gap", async () => {
    // A page that polls or loops emits without bound. Observed for real at
    // 10,299 entries in one session, which buried the network requests that
    // were the actual evidence.
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const resourceObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "resource",
    );
    const entry = (i: number) => ({
      entryType: "resource",
      name: `https://example.com/api/poll/${i}`,
      duration: 1,
      transferSize: 1,
      initiatorType: "fetch",
    });

    resourceObserver!.simulateEntries(
      Array.from({ length: 1_200 }, (_, i) => entry(i)),
    );
    bus.flush();

    const perf = events.filter((e) => e.k === "perf");
    expect(perf).toHaveLength(1_000);

    const gaps = events.filter((e) => e.k === "capture_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].d.reason).toBe("scan_budget_exceeded");
    expect(gaps[0].d.surface).toBe("browser");

    // The gap is reported once, not once per shed entry, and observation stops.
    resourceObserver!.simulateEntries([entry(9_999)]);
    bus.flush();
    expect(events.filter((e) => e.k === "capture_gap")).toHaveLength(1);
    expect(events.filter((e) => e.k === "perf")).toHaveLength(1_000);
    expect(resourceObserver!.disconnected).toBe(true);
  });

  it("keeps a score event after a resource storm exhausts the bulk budget", async () => {
    // The bug this guards: one shared counter meant a runaway page shed the
    // largest-contentful-paint entry too, and disconnected its observer, so the
    // metric went absent in exactly the sessions that needed it.
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const resourceObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "resource",
    )!;
    const lcpObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "largest-contentful-paint",
    )!;

    resourceObserver.simulateEntries(
      Array.from({ length: 1_200 }, (_, i) => ({
        entryType: "resource",
        name: `https://example.com/api/poll/${i}`,
        duration: 1,
        transferSize: 1,
        initiatorType: "fetch",
      })),
    );
    lcpObserver.simulateEntries([
      {
        entryType: "largest-contentful-paint",
        startTime: 4321,
        size: 90_000,
        element: { tagName: "IMG" },
      },
    ]);
    bus.flush();

    // The score event survives.
    const lcp = events.filter((e) => e.k === "perf" && e.d.metric === "lcp");
    expect(lcp).toHaveLength(1);
    expect(lcp[0].d.startTime).toBe(4321);

    // The bulk budget is exhausted and reported once, and only its observer
    // stopped.
    expect(
      events.filter((e) => e.k === "perf" && e.d.metric === "res"),
    ).toHaveLength(1_000);
    expect(events.filter((e) => e.k === "capture_gap")).toHaveLength(1);
    expect(resourceObserver.disconnected).toBe(true);
    expect(lcpObserver.disconnected).toBe(false);
  });

  it("caps the vitals reserve separately and stops only the vitals observers", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const resourceObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "resource",
    )!;
    const clsObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "layout-shift",
    )!;
    const lcpObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "largest-contentful-paint",
    )!;

    clsObserver.simulateEntries(
      Array.from({ length: 300 }, () => ({
        entryType: "layout-shift",
        value: 0.01,
        hadRecentInput: false,
      })),
    );
    bus.flush();

    expect(events.filter((e) => e.k === "perf")).toHaveLength(250);
    const gaps = events.filter((e) => e.k === "capture_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].d.reason).toBe("scan_budget_exceeded");
    expect(gaps[0].d.surface).toBe("browser");
    // `buildCaptureGapEvent` keeps only classifications, so free-text detail is
    // dropped here exactly as it is for the bulk budget's gap.
    expect(gaps[0].d.detail).toBeUndefined();

    // Vitals observers stop; the bulk ones keep going and keep their own budget.
    expect(clsObserver.disconnected).toBe(true);
    expect(lcpObserver.disconnected).toBe(true);
    expect(resourceObserver.disconnected).toBe(false);

    resourceObserver.simulateEntries([
      {
        entryType: "resource",
        name: "https://example.com/after",
        duration: 5,
        transferSize: 5,
        initiatorType: "fetch",
      },
    ]);
    bus.flush();
    expect(
      events.filter((e) => e.k === "perf" && e.d.metric === "res"),
    ).toHaveLength(1);
    expect(events.filter((e) => e.k === "capture_gap")).toHaveLength(1);
  });

  it("redacts query values from resource timing URLs", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const resourceObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "resource",
    );
    expect(resourceObserver).toBeDefined();

    resourceObserver!.simulateEntries([
      {
        entryType: "resource",
        name: "https://example.com/api/data?token=sk_demo_12345678901234567890#frag",
        duration: 25,
        transferSize: 512,
        initiatorType: "fetch",
      },
    ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].d.name).toBe(
      "https://example.com/api/data?token=%5BREDACTED%5D",
    );
    expect(JSON.stringify(events[0].d)).not.toContain(
      "sk_demo_12345678901234567890",
    );
    expect(events[0].d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
      fields: [
        {
          path: "name.query.token",
          reason: "url_query_value",
          action: "redacted",
        },
        { path: "name.hash", reason: "url_hash", action: "dropped" },
      ],
    });
  });

  it("emits perf event with metric=longtask for long task entries", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "longtask",
    );
    expect(observer).toBeDefined();

    observer!.simulateEntries([
      {
        entryType: "longtask",
        duration: 120,
        name: "self",
      },
    ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("perf");
    expect(events[0].d.metric).toBe("longtask");
    expect(events[0].d.duration).toBe(120);
    expect(events[0].d.name).toBe("self");
  });

  it("emits perf event with metric=cls for layout-shift entries", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "layout-shift",
    );
    expect(observer).toBeDefined();

    observer!.simulateEntries([
      {
        entryType: "layout-shift",
        value: 0.15,
        hadRecentInput: false,
      },
    ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("perf");
    expect(events[0].d.metric).toBe("cls");
    expect(events[0].d.value).toBe(0.15);
    expect(events[0].d.hadRecentInput).toBe(false);
  });

  it("emits perf event with metric=lcp for largest-contentful-paint entries", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "largest-contentful-paint",
    );
    expect(observer).toBeDefined();

    observer!.simulateEntries([
      {
        entryType: "largest-contentful-paint",
        startTime: 1234.5,
        size: 50000,
        element: { tagName: "IMG" },
      },
    ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("perf");
    expect(events[0].d.metric).toBe("lcp");
    expect(events[0].d.startTime).toBe(1234.5);
    expect(events[0].d.size).toBe(50000);
    expect(events[0].d.element).toBe("IMG");
  });

  it("emits perf event with metric=lcp without element tag when element is null", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "largest-contentful-paint",
    );

    observer!.simulateEntries([
      {
        entryType: "largest-contentful-paint",
        startTime: 500,
        size: 10000,
        element: null,
      },
    ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].d.element).toBeUndefined();
  });

  it("emits perf event with metric=fid and calculated delay for first-input entries", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "first-input",
    );
    expect(observer).toBeDefined();

    observer!.simulateEntries([
      {
        entryType: "first-input",
        startTime: 1000,
        processingStart: 1050,
        name: "pointerdown",
      },
    ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("perf");
    expect(events[0].d.metric).toBe("fid");
    expect(events[0].d.delay).toBe(50);
    expect(events[0].d.name).toBe("pointerdown");
  });

  it("cleanup disconnects all observers", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    expect(MockPerformanceObserver.instances.length).toBeGreaterThan(0);
    const allConnected = MockPerformanceObserver.instances.every(
      (o) => !o.disconnected,
    );
    expect(allConnected).toBe(true);

    cleanup();

    const allDisconnected = MockPerformanceObserver.instances.every(
      (o) => o.disconnected,
    );
    expect(allDisconnected).toBe(true);
  });

  it("does not throw when PerformanceObserver is not available", async () => {
    delete (globalThis as any).PerformanceObserver;

    const performanceCollector = await loadCollector();
    expect(() => performanceCollector(bus, DEFAULT_CONFIG)).not.toThrow();
  });

  it("uses buffered: true option on observers", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    for (const observer of MockPerformanceObserver.instances) {
      expect(observer.observeOptions?.buffered).toBe(true);
    }
  });

  it("handles unsupported entry types gracefully", async () => {
    // Restrict supported types to only 'resource'
    MockPerformanceObserver.supportedEntryTypes = ["resource"];

    // Make observe throw for unsupported types
    const origObserve = MockPerformanceObserver.prototype.observe;
    MockPerformanceObserver.prototype.observe = function (options: any) {
      if (
        options.type &&
        !(MockPerformanceObserver as any).supportedEntryTypes.includes(
          options.type,
        )
      ) {
        throw new DOMException(
          `${options.type} is not supported`,
          "NotSupportedError",
        );
      }
      origObserve.call(this, options);
    };

    const performanceCollector = await loadCollector();
    expect(() => performanceCollector(bus, DEFAULT_CONFIG)).not.toThrow();

    // Restore
    MockPerformanceObserver.prototype.observe = origObserve;
    MockPerformanceObserver.supportedEntryTypes = [
      "resource",
      "longtask",
      "layout-shift",
      "largest-contentful-paint",
      "first-input",
      "navigation",
      "paint",
    ];
  });

  it("emits perf event with metric=ttfb for navigation entries", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "navigation",
    );
    expect(observer).toBeDefined();

    observer!.simulateEntries([
      {
        entryType: "navigation",
        name: "https://example.com/",
        startTime: 0,
        responseStart: 210,
        domContentLoadedEventEnd: 640,
        loadEventEnd: 1180,
      },
    ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("perf");
    expect(events[0].d.metric).toBe("ttfb");
    expect(events[0].d.value).toBe(210);
    expect(events[0].d.domContentLoadedEventEnd).toBe(640);
    expect(events[0].d.loadEventEnd).toBe(1180);
  });

  it("measures ttfb from startTime, not from zero", async () => {
    // A prerendered or restored navigation does not start at zero, so a raw
    // `responseStart` would overstate the server's share of the wait.
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    MockPerformanceObserver.instances
      .find((o) => o.observeOptions?.type === "navigation")!
      .simulateEntries([
        {
          entryType: "navigation",
          startTime: 40,
          responseStart: 210,
          domContentLoadedEventEnd: 640,
          loadEventEnd: 1180,
        },
      ]);

    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].d.value).toBe(170);
  });

  it("emits perf event with metric=fcp only for the contentful paint entry", async () => {
    // The `paint` entry type also carries `first-paint`, which fires for a
    // background fill and is not FCP. Emitting on it would report a vital the
    // page never reached.
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "paint",
    );
    expect(observer).toBeDefined();

    observer!.simulateEntries([
      { entryType: "paint", name: "first-paint", startTime: 300 },
    ]);
    bus.flush();
    expect(events).toHaveLength(0);

    observer!.simulateEntries([
      { entryType: "paint", name: "first-contentful-paint", startTime: 812.5 },
    ]);
    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("perf");
    expect(events[0].d.metric).toBe("fcp");
    expect(events[0].d.value).toBe(812.5);
  });

  it("does not spend the vitals budget on a rejected paint entry", async () => {
    // A skipped entry must be skipped before the budget is touched, otherwise a
    // repeated non-FCP paint could shed a real vital.
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    const paintObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "paint",
    )!;
    const clsObserver = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "layout-shift",
    )!;

    paintObserver.simulateEntries(
      Array.from({ length: 300 }, () => ({
        entryType: "paint",
        name: "first-paint",
        startTime: 300,
      })),
    );
    clsObserver.simulateEntries([
      { entryType: "layout-shift", value: 0.2, hadRecentInput: false },
    ]);
    bus.flush();

    expect(events.filter((e) => e.k === "capture_gap")).toHaveLength(0);
    expect(
      events.filter((e) => e.k === "perf" && e.d.metric === "cls"),
    ).toHaveLength(1);
  });

  it("observes navigation and paint with buffered: true", async () => {
    // Both happen before any SDK could plausibly have loaded, so without the
    // buffer replay a late init() misses them permanently.
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    for (const type of ["navigation", "paint"]) {
      const observer = MockPerformanceObserver.instances.find(
        (o) => o.observeOptions?.type === type,
      );
      expect(observer, `no observer registered for ${type}`).toBeDefined();
      expect(observer!.observeOptions.buffered).toBe(true);
    }
  });

  // --- Interaction to next paint --------------------------------------------

  /** The `event` observer, which carries the interaction entries INP is built from. */
  function eventObserver(): MockPerformanceObserver {
    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "event",
    );
    expect(
      observer,
      "no observer registered for the event entry type",
    ).toBeDefined();
    return observer!;
  }

  function interaction(
    interactionId: number,
    duration: number,
    name = "pointerdown",
  ) {
    return { entryType: "event", name, duration, interactionId };
  }

  /** Simulate the page being hidden, which is what finalizes a closed session. */
  function hidePage() {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  function showPage() {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  function inpEvents() {
    return events.filter((e) => e.k === "perf" && e.d.metric === "inp");
  }

  it("reports the worst interaction as inp on finalization", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    eventObserver().simulateEntries([
      interaction(1, 40),
      interaction(2, 120, "click"),
      interaction(3, 80),
    ]);
    bus.flush();
    // Nothing is knowable until the session stops accumulating.
    expect(inpEvents()).toHaveLength(0);

    cleanup();
    bus.flush();

    // 3 interactions: floor(3 / 50) = 0 candidates dropped, so the worst wins.
    expect(inpEvents()).toHaveLength(1);
    expect(inpEvents()[0].d.value).toBe(120);
    expect(inpEvents()[0].d.eventType).toBe("click");
    expect(inpEvents()[0].d.interactionCount).toBe(3);
  });

  it("collapses entries sharing an interactionId to that interaction's worst duration", async () => {
    // One interaction fans out into pointerdown, pointerup and click entries.
    // Counting them separately would both inflate the interaction count and let
    // three views of one slow tap outrank three genuinely distinct ones.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    eventObserver().simulateEntries([
      interaction(7, 60, "pointerdown"),
      interaction(7, 210, "click"),
      interaction(7, 90, "pointerup"),
    ]);
    cleanup();
    bus.flush();

    expect(inpEvents()).toHaveLength(1);
    expect(inpEvents()[0].d.value).toBe(210);
    expect(inpEvents()[0].d.eventType).toBe("click");
    expect(inpEvents()[0].d.interactionCount).toBe(1);
  });

  it("excludes entries with interactionId 0 entirely", async () => {
    // `interactionId: 0` means the platform did not attribute the event to a
    // user interaction, so scoring it would report latency nobody waited on.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    eventObserver().simulateEntries([
      interaction(0, 5_000, "pointermove"),
      interaction(0, 4_000, "pointermove"),
      interaction(4, 70, "keydown"),
    ]);
    cleanup();
    bus.flush();

    expect(inpEvents()).toHaveLength(1);
    expect(inpEvents()[0].d.value).toBe(70);
    expect(inpEvents()[0].d.eventType).toBe("keydown");
    expect(inpEvents()[0].d.interactionCount).toBe(1);
  });

  it("emits no inp at all when every entry is unattributed", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    eventObserver().simulateEntries([interaction(0, 900, "pointermove")]);
    cleanup();
    bus.flush();

    expect(inpEvents()).toHaveLength(0);
  });

  it("drops one candidate per 50 interactions", async () => {
    // The specification, worked by hand:
    //   60 interactions, ids 1..60, durations 40, 50, 60, ... 630
    //   (duration of interaction i = 40 + (i - 1) * 10).
    //   Ranked worst first: 630, 620, 610, ...
    //   Candidates dropped = floor(60 / 50) = 1.
    //   Reported = the 2nd worst = 620, from interaction 59.
    // Reporting the plain maximum here would give 630; reporting the median or
    // a fixed percentile would give neither.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    eventObserver().simulateEntries(
      Array.from({ length: 60 }, (_, i) =>
        interaction(i + 1, 40 + i * 10, `evt-${i + 1}`),
      ),
    );
    cleanup();
    bus.flush();

    expect(inpEvents()).toHaveLength(1);
    expect(inpEvents()[0].d.value).toBe(620);
    expect(inpEvents()[0].d.eventType).toBe("evt-59");
    expect(inpEvents()[0].d.interactionCount).toBe(60);
  });

  it("keeps reporting the maximum just below the first drop boundary", async () => {
    // 49 interactions: floor(49 / 50) = 0, so nothing is dropped and the worst
    // interaction is the score. This pins the boundary the previous test moves
    // past, so an off-by-one in the divisor cannot pass both.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    eventObserver().simulateEntries(
      Array.from({ length: 49 }, (_, i) => interaction(i + 1, 40 + i * 10)),
    );
    cleanup();
    bus.flush();

    // Worst = 40 + 48 * 10 = 520.
    expect(inpEvents()[0].d.value).toBe(520);
    expect(inpEvents()[0].d.interactionCount).toBe(49);
  });

  it("observes the event entry type with a 40ms duration threshold", async () => {
    const performanceCollector = await loadCollector();
    performanceCollector(bus, DEFAULT_CONFIG);

    expect(eventObserver().observeOptions).toEqual({
      type: "event",
      buffered: true,
      durationThreshold: 40,
    });
  });

  it("degrades silently when the event entry type is unsupported", async () => {
    MockPerformanceObserver.supportedEntryTypes = [
      "resource",
      "longtask",
      "layout-shift",
      "largest-contentful-paint",
      "first-input",
      "navigation",
      "paint",
    ];
    const origObserve = MockPerformanceObserver.prototype.observe;
    MockPerformanceObserver.prototype.observe = function (options: any) {
      if (
        !(MockPerformanceObserver as any).supportedEntryTypes.includes(
          options.type,
        )
      ) {
        throw new DOMException(
          `${options.type} is not supported`,
          "NotSupportedError",
        );
      }
      origObserve.call(this, options);
    };

    try {
      const performanceCollector = await loadCollector();
      let cleanup!: () => void;
      expect(() => {
        cleanup = performanceCollector(bus, DEFAULT_CONFIG);
      }).not.toThrow();

      expect(
        MockPerformanceObserver.instances.find(
          (o) => o.observeOptions?.type === "event",
        ),
      ).toBeUndefined();

      // Every other observer still works, and finalizing emits no INP.
      const lcpObserver = MockPerformanceObserver.instances.find(
        (o) => o.observeOptions?.type === "largest-contentful-paint",
      );
      expect(lcpObserver).toBeDefined();
      lcpObserver!.simulateEntries([
        {
          entryType: "largest-contentful-paint",
          startTime: 900,
          size: 100,
          element: null,
        },
      ]);
      cleanup();
      bus.flush();

      expect(
        events.filter((e) => e.k === "perf" && e.d.metric === "lcp"),
      ).toHaveLength(1);
      expect(inpEvents()).toHaveLength(0);
    } finally {
      MockPerformanceObserver.prototype.observe = origObserve;
    }
  });

  it("emits inp when the page is hidden, and never a second time", async () => {
    // A session that is closed rather than finalized still has to report, and a
    // tab that is hidden and shown repeatedly must not report the same score
    // over and over.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    eventObserver().simulateEntries([interaction(1, 150, "click")]);

    hidePage();
    bus.flush();
    expect(inpEvents()).toHaveLength(1);
    expect(inpEvents()[0].d.value).toBe(150);

    showPage();
    hidePage();
    bus.flush();
    expect(inpEvents()).toHaveLength(1);

    // Finalization after a visibility change must not duplicate it either.
    cleanup();
    bus.flush();
    expect(inpEvents()).toHaveLength(1);
  });

  it("stops listening for visibility changes after cleanup", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    const observer = eventObserver();
    cleanup();
    bus.flush();
    expect(inpEvents()).toHaveLength(0);

    // A second collector must own the next session's score, not this one.
    observer.simulateEntries([interaction(1, 300)]);
    hidePage();
    bus.flush();
    expect(inpEvents()).toHaveLength(0);
  });

  it("keeps the other observers when paint is unsupported", async () => {
    MockPerformanceObserver.supportedEntryTypes = [
      "resource",
      "longtask",
      "layout-shift",
      "largest-contentful-paint",
      "first-input",
      "navigation",
    ];
    const origObserve = MockPerformanceObserver.prototype.observe;
    MockPerformanceObserver.prototype.observe = function (options: any) {
      if (
        !(MockPerformanceObserver as any).supportedEntryTypes.includes(
          options.type,
        )
      ) {
        throw new DOMException(
          `${options.type} is not supported`,
          "NotSupportedError",
        );
      }
      origObserve.call(this, options);
    };

    try {
      const performanceCollector = await loadCollector();
      expect(() => performanceCollector(bus, DEFAULT_CONFIG)).not.toThrow();

      expect(
        MockPerformanceObserver.instances.find(
          (o) => o.observeOptions?.type === "paint",
        ),
      ).toBeUndefined();

      const navObserver = MockPerformanceObserver.instances.find(
        (o) => o.observeOptions?.type === "navigation",
      );
      expect(navObserver).toBeDefined();
      navObserver!.simulateEntries([
        {
          entryType: "navigation",
          startTime: 0,
          responseStart: 210,
          domContentLoadedEventEnd: 640,
          loadEventEnd: 1180,
        },
      ]);
      bus.flush();
      expect(events).toHaveLength(1);
      expect(events[0].d.metric).toBe("ttfb");
    } finally {
      MockPerformanceObserver.prototype.observe = origObserve;
      MockPerformanceObserver.supportedEntryTypes = [
        "resource",
        "longtask",
        "layout-shift",
        "largest-contentful-paint",
        "first-input",
        "navigation",
        "paint",
      ];
    }
  });

  // --- Session-windowed cumulative layout shift ------------------------------

  function clsObserver(): MockPerformanceObserver {
    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "layout-shift",
    );
    expect(
      observer,
      "no observer registered for the layout-shift entry type",
    ).toBeDefined();
    return observer!;
  }

  function shift(value: number, startTime: number, hadRecentInput = false) {
    return { entryType: "layout-shift", value, startTime, hadRecentInput };
  }

  function clsScores() {
    return events.filter((e) => e.k === "perf" && e.d.metric === "cls.score");
  }

  it("reports the worst session window as cls.score on finalization", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries([shift(0.1, 0), shift(0.2, 400)]);
    bus.flush();
    // A score is only knowable once the session stops accumulating.
    expect(clsScores()).toHaveLength(0);

    cleanup();
    bus.flush();

    expect(clsScores()).toHaveLength(1);
    expect(clsScores()[0].d.value).toBeCloseTo(0.3, 5);
    expect(clsScores()[0].d.shiftCount).toBe(2);
  });

  it("breaks a window on a gap longer than one second", async () => {
    // Two shifts 900ms apart belong together; the third arrives 1100ms after
    // the second and starts a new window. Summing the session instead would
    // report 0.5, and reporting the last window would report 0.3 only by
    // accident, so the value is chosen to make the largest window the middle
    // answer.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries([
      shift(0.1, 0),
      shift(0.1, 900),
      shift(0.3, 2_000),
    ]);
    cleanup();
    bus.flush();

    // Windows: [0.1 + 0.1] and [0.3]. Worst = 0.3.
    expect(clsScores()).toHaveLength(1);
    expect(clsScores()[0].d.value).toBeCloseTo(0.3, 5);
    expect(clsScores()[0].d.shiftCount).toBe(3);
  });

  it("breaks a window that spans more than five seconds, even without a gap", async () => {
    // Every gap here is 900ms, so the gap boundary never fires. Only the span
    // boundary separates these, which is why this fixture cannot pass with the
    // span check missing: without it the whole run is one window worth 1.4.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries([
      shift(0.1, 0),
      shift(0.1, 900),
      shift(0.1, 1_800),
      shift(0.1, 2_700),
      shift(0.1, 3_600),
      shift(0.1, 4_500),
      // 5400 - 0 = 5400 > 5000, so the window breaks here despite the 900ms gap.
      shift(0.4, 5_400),
      shift(0.4, 6_300),
    ]);
    cleanup();
    bus.flush();

    // Windows: [6 x 0.1 = 0.6] and [0.4 + 0.4 = 0.8]. Worst = 0.8.
    expect(clsScores()[0].d.value).toBeCloseTo(0.8, 5);
    expect(clsScores()[0].d.shiftCount).toBe(8);
  });

  it("keeps shifts exactly on both boundaries inside the same window", async () => {
    // Gaps of exactly 1000ms and a span of exactly 5000ms are within the
    // window, not past it. This pins the comparison as strictly greater than,
    // so an off-by-one that breaks early cannot pass alongside the two tests
    // above.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries([
      shift(0.1, 0),
      shift(0.1, 1_000),
      shift(0.1, 2_000),
      shift(0.1, 3_000),
      shift(0.1, 4_000),
      shift(0.1, 5_000),
    ]);
    cleanup();
    bus.flush();

    expect(clsScores()[0].d.value).toBeCloseTo(0.6, 5);
    expect(clsScores()[0].d.shiftCount).toBe(6);
  });

  it("reports an earlier window when it is the worst one", async () => {
    // The score is the maximum window, not the latest one.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries([shift(0.5, 0), shift(0.1, 9_000)]);
    cleanup();
    bus.flush();

    expect(clsScores()[0].d.value).toBeCloseTo(0.5, 5);
  });

  it("excludes shifts that followed a user interaction", async () => {
    // A shift the user caused by clicking is the page responding, not the page
    // moving under them, so it is not part of the score.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries([
      shift(0.9, 0, true),
      shift(0.2, 100),
      shift(0.8, 200, true),
    ]);
    cleanup();
    bus.flush();

    expect(clsScores()).toHaveLength(1);
    expect(clsScores()[0].d.value).toBeCloseTo(0.2, 5);
    expect(clsScores()[0].d.shiftCount).toBe(1);
  });

  it("emits no cls.score when the page never shifted", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    cleanup();
    bus.flush();
    expect(clsScores()).toHaveLength(0);
  });

  it("emits cls.score when the page is hidden, and never a second time", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries([shift(0.25, 0)]);

    hidePage();
    bus.flush();
    expect(clsScores()).toHaveLength(1);
    expect(clsScores()[0].d.value).toBeCloseTo(0.25, 5);

    showPage();
    hidePage();
    cleanup();
    bus.flush();
    expect(clsScores()).toHaveLength(1);
  });

  it("sheds cls.score as a capture gap rather than reporting a partial one", async () => {
    // The score answers to the same vitals budget as the per-shift events, so
    // a session that exhausts the budget loses the score too. What must not
    // happen is a number built from only the shifts that fitted: an
    // understated score reads as a calm page, and nothing tells the reader
    // otherwise. The capture gap is what makes the absence legible.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries(
      Array.from({ length: 300 }, (_, i) => shift(0.01, i)),
    );
    bus.flush();

    // 250 per-shift events emitted, the rest shed.
    expect(
      events.filter((e) => e.k === "perf" && e.d.metric === "cls"),
    ).toHaveLength(250);

    cleanup();
    bus.flush();

    expect(clsScores()).toHaveLength(0);
    expect(events.filter((e) => e.k === "capture_gap")).toHaveLength(1);
  });

  // --- Finalized largest contentful paint ------------------------------------

  function lcpObserverOf(): MockPerformanceObserver {
    const observer = MockPerformanceObserver.instances.find(
      (o) => o.observeOptions?.type === "largest-contentful-paint",
    );
    expect(
      observer,
      "no observer registered for the largest-contentful-paint entry type",
    ).toBeDefined();
    return observer!;
  }

  function candidate(startTime: number, size: number, tagName?: string) {
    return {
      entryType: "largest-contentful-paint",
      startTime,
      size,
      element: tagName ? { tagName } : null,
    };
  }

  function lcpFinals() {
    return events.filter((e) => e.k === "perf" && e.d.metric === "lcp.final");
  }

  function press(type: "keydown" | "pointerdown") {
    document.dispatchEvent(new Event(type));
  }

  it("reports the last candidate as lcp.final on finalization", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    lcpObserverOf().simulateEntries([
      candidate(500, 1_000, "P"),
      candidate(1_200, 20_000, "H1"),
      candidate(3_000, 90_000, "IMG"),
    ]);
    bus.flush();
    // Every candidate is a guess until nothing can replace it.
    expect(lcpFinals()).toHaveLength(0);

    cleanup();
    bus.flush();

    expect(lcpFinals()).toHaveLength(1);
    expect(lcpFinals()[0].d.value).toBe(3_000);
    expect(lcpFinals()[0].d.size).toBe(90_000);
    expect(lcpFinals()[0].d.element).toBe("IMG");
  });

  it("freezes lcp at the first keydown", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    lcpObserverOf().simulateEntries([candidate(500, 1_000, "P")]);
    press("keydown");
    // Content that arrives after the user has acted is a consequence of that
    // action, not part of the load they waited through.
    lcpObserverOf().simulateEntries([candidate(9_000, 500_000, "IMG")]);
    cleanup();
    bus.flush();

    expect(lcpFinals()).toHaveLength(1);
    expect(lcpFinals()[0].d.value).toBe(500);
    expect(lcpFinals()[0].d.element).toBe("P");
  });

  it("freezes lcp at the first pointerdown", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    lcpObserverOf().simulateEntries([candidate(640, 4_000, "H1")]);
    press("pointerdown");
    lcpObserverOf().simulateEntries([candidate(7_500, 300_000, "IMG")]);
    cleanup();
    bus.flush();

    expect(lcpFinals()).toHaveLength(1);
    expect(lcpFinals()[0].d.value).toBe(640);
    expect(lcpFinals()[0].d.element).toBe("H1");
  });

  it("omits element when the candidate has none", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    lcpObserverOf().simulateEntries([candidate(800, 2_000)]);
    cleanup();
    bus.flush();

    expect(lcpFinals()).toHaveLength(1);
    expect(lcpFinals()[0].d.element).toBeUndefined();
  });

  it("emits no lcp.final when no candidate was ever observed", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    cleanup();
    bus.flush();
    expect(lcpFinals()).toHaveLength(0);
  });

  it("emits lcp.final when the page is hidden, and never a second time", async () => {
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    lcpObserverOf().simulateEntries([candidate(1_100, 10_000, "IMG")]);

    hidePage();
    bus.flush();
    expect(lcpFinals()).toHaveLength(1);
    expect(lcpFinals()[0].d.value).toBe(1_100);

    // A candidate arriving after finalization cannot reopen the answer.
    lcpObserverOf().simulateEntries([candidate(8_000, 900_000, "VIDEO")]);
    showPage();
    hidePage();
    cleanup();
    bus.flush();

    expect(lcpFinals()).toHaveLength(1);
    expect(lcpFinals()[0].d.value).toBe(1_100);
  });

  it("removes the interaction listeners on cleanup", async () => {
    // The freeze listeners outlive the observers unless they are removed, and a
    // collector that keeps listening after cleanup holds the whole closure —
    // including every tracked interaction — alive on the document.
    const performanceCollector = await loadCollector();
    const removed = vi.spyOn(document, "removeEventListener");
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    cleanup();

    const types = removed.mock.calls.map((call) => call[0]);
    expect(types).toContain("keydown");
    expect(types).toContain("pointerdown");
    expect(types).toContain("visibilitychange");
    removed.mockRestore();
  });

  it("still emits the per-candidate lcp and per-shift cls events", async () => {
    // The scores are added alongside the raw entries, not in place of them: a
    // reader following a jumpy page still needs to see which shifts happened
    // and when, which a single number cannot carry.
    const performanceCollector = await loadCollector();
    const cleanup = performanceCollector(bus, DEFAULT_CONFIG);

    clsObserver().simulateEntries([shift(0.1, 0), shift(0.2, 400)]);
    lcpObserverOf().simulateEntries([candidate(500, 1_000, "P")]);
    cleanup();
    bus.flush();

    expect(
      events.filter((e) => e.k === "perf" && e.d.metric === "cls"),
    ).toHaveLength(2);
    expect(
      events.filter((e) => e.k === "perf" && e.d.metric === "lcp"),
    ).toHaveLength(1);
    expect(clsScores()).toHaveLength(1);
    expect(lcpFinals()).toHaveLength(1);
  });
});
