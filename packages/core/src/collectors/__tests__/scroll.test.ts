import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../event-bus";
import {
  DEFAULT_CONFIG,
  type BugEvent,
  type CrumbtrailConfig,
} from "../../types";
import { scrollCollector } from "../scroll";

describe("scrollCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("captures scroll events on document", () => {
    cleanup = scrollCollector(bus, { ...DEFAULT_CONFIG, scrollThrottleMs: 0 });

    Object.defineProperty(window, "scrollX", {
      value: 0,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "scrollY", {
      value: 200,
      writable: true,
      configurable: true,
    });

    document.dispatchEvent(new Event("scroll"));
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("scr");
    expect(events[0].d.el).toBe("document");
    expect(events[0].d.pos).toEqual([0, 200]);
  });

  it("derives scroll direction from position change", () => {
    cleanup = scrollCollector(bus, { ...DEFAULT_CONFIG, scrollThrottleMs: 0 });

    Object.defineProperty(window, "scrollX", { value: 0, configurable: true });
    Object.defineProperty(window, "scrollY", {
      value: 100,
      configurable: true,
    });
    document.dispatchEvent(new Event("scroll"));

    Object.defineProperty(window, "scrollY", {
      value: 300,
      configurable: true,
    });
    document.dispatchEvent(new Event("scroll"));
    bus.flush();

    expect(events[1].d.dir).toBe("dn");
  });

  it("derives upward direction", () => {
    cleanup = scrollCollector(bus, { ...DEFAULT_CONFIG, scrollThrottleMs: 0 });

    Object.defineProperty(window, "scrollX", { value: 0, configurable: true });
    Object.defineProperty(window, "scrollY", {
      value: 300,
      configurable: true,
    });
    document.dispatchEvent(new Event("scroll"));

    Object.defineProperty(window, "scrollY", {
      value: 100,
      configurable: true,
    });
    document.dispatchEvent(new Event("scroll"));
    bus.flush();

    expect(events[1].d.dir).toBe("up");
  });

  it("throttles scroll events", () => {
    cleanup = scrollCollector(bus, {
      ...DEFAULT_CONFIG,
      scrollThrottleMs: 500,
    });

    Object.defineProperty(window, "scrollX", { value: 0, configurable: true });
    Object.defineProperty(window, "scrollY", {
      value: 100,
      configurable: true,
    });
    document.dispatchEvent(new Event("scroll"));

    vi.advanceTimersByTime(100);
    Object.defineProperty(window, "scrollY", {
      value: 200,
      configurable: true,
    });
    document.dispatchEvent(new Event("scroll"));

    bus.flush();
    expect(events).toHaveLength(1);

    vi.advanceTimersByTime(500);
    Object.defineProperty(window, "scrollY", {
      value: 300,
      configurable: true,
    });
    document.dispatchEvent(new Event("scroll"));

    bus.flush();
    expect(events).toHaveLength(2);
  });

  it("stops capturing after cleanup", () => {
    cleanup = scrollCollector(bus, { ...DEFAULT_CONFIG, scrollThrottleMs: 0 });
    cleanup();

    document.dispatchEvent(new Event("scroll"));
    bus.flush();
    expect(events).toHaveLength(0);

    cleanup = scrollCollector(bus, DEFAULT_CONFIG);
  });
});
