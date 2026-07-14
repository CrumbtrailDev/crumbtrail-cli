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
    ];
  });
});
