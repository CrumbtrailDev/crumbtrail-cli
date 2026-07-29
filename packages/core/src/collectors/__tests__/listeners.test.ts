import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, UI_LISTENERS_EVENT_KIND } from "../../types";
import type { BugEvent } from "../../types";
import {
  LISTENER_GROWTH_THRESHOLD,
  LISTENER_SETTLE_MS,
  listenerCollector,
} from "../listeners";

/**
 * The gauge counts every registration in the realm, including ones the test
 * runner makes, so assertions read counts per type and relative growth rather
 * than exact totals.
 */
describe("listenerCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  function gauges(): BugEvent[] {
    bus.flush();
    return events.filter((event) => event.k === UI_LISTENERS_EVENT_KIND);
  }

  function latest(): BugEvent {
    const all = gauges();
    return all[all.length - 1];
  }

  function countFor(gauge: BugEvent, type: string): number | undefined {
    const byType = gauge.d.byType as Array<[string, number]>;
    return byType.find((entry) => entry[0] === type)?.[1];
  }

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = listenerCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  it("emits a baseline gauge on start", () => {
    const gauge = gauges()[0];
    expect(gauge.k).toBe(UI_LISTENERS_EVENT_KIND);
    expect(gauge.d.total).toBeTypeOf("number");
    expect(gauge.d.byType).toBeInstanceOf(Array);
    expect(gauge.d.url).toBe(window.location.href);
  });

  it("counts additions and removals per event type", () => {
    const before = latest().d.total as number;
    const el = document.createElement("div");
    const handler = () => {};
    el.addEventListener("click", handler);
    el.addEventListener("click", handler);
    el.addEventListener("keydown", handler);

    history.pushState({}, "", "/counted");
    const afterAdds = latest();
    expect(afterAdds.d.total as number).toBeGreaterThanOrEqual(before + 3);
    expect(countFor(afterAdds, "click")).toBe(2);
    expect(countFor(afterAdds, "keydown")).toBe(1);

    el.removeEventListener("click", handler);
    el.removeEventListener("keydown", handler);
    history.pushState({}, "", "/removed");
    const afterRemovals = latest();
    expect(countFor(afterRemovals, "click")).toBe(1);
    expect(countFor(afterRemovals, "keydown")).toBeUndefined();
  });

  it("emits on every navigation commit", () => {
    const before = gauges().length;
    history.pushState({}, "", "/one");
    history.replaceState({}, "", "/two");
    window.dispatchEvent(new Event("popstate"));

    expect(gauges().length).toBe(before + 3);
  });

  it("emits a settled gauge after route effects register listeners", async () => {
    const before = gauges().length;
    history.pushState({}, "", "/with-effect");
    window.addEventListener("route-effect", () => {});

    await new Promise((resolve) => setTimeout(resolve, LISTENER_SETTLE_MS + 20));

    expect(gauges().length).toBe(before + 2);
    expect(countFor(latest(), "route-effect")).toBe(1);
  });

  it("emits once the total grows past the threshold between navigations", () => {
    const before = gauges().length;
    const el = document.createElement("div");
    for (let i = 0; i < LISTENER_GROWTH_THRESHOLD; i += 1) {
      el.addEventListener(`custom-${i}`, () => {});
    }

    const after = gauges();
    expect(after.length).toBeGreaterThan(before);
    expect(after[after.length - 1].d.total as number).toBeGreaterThanOrEqual(
      LISTENER_GROWTH_THRESHOLD,
    );
  });

  it("does not emit for growth well below the threshold", () => {
    const before = gauges().length;
    const el = document.createElement("div");
    for (let i = 0; i < LISTENER_GROWTH_THRESHOLD - 10; i += 1) {
      el.addEventListener(`quiet-${i}`, () => {});
    }

    expect(gauges().length).toBe(before);
  });

  it("reports at most the top eight types by count", () => {
    const el = document.createElement("div");
    for (let type = 0; type < 12; type += 1) {
      for (let i = 0; i <= type; i += 1) {
        el.addEventListener(`type-${type}`, () => {});
      }
    }

    history.pushState({}, "", "/top-types");
    const byType = latest().d.byType as Array<[string, number]>;
    expect(byType).toHaveLength(8);
    expect(byType[0]).toEqual(["type-11", 12]);
    expect(byType[1][1]).toBeLessThanOrEqual(byType[0][1]);
  });

  it("counts a listener registered on window", () => {
    const handler = () => {};
    window.addEventListener("resize", handler);
    history.pushState({}, "", "/window-listener");

    expect(countFor(latest(), "resize")).toBe(1);
    window.removeEventListener("resize", handler);
  });

  it("restores the native methods on cleanup and stops emitting", () => {
    const patchedAdd = document.createElement("div").addEventListener;
    cleanup();
    expect(document.createElement("div").addEventListener).not.toBe(patchedAdd);

    const before = gauges().length;
    const el = document.createElement("div");
    for (let i = 0; i < LISTENER_GROWTH_THRESHOLD + 5; i += 1) {
      el.addEventListener(`after-cleanup-${i}`, () => {});
    }
    history.pushState({}, "", "/after-cleanup");

    expect(gauges().length).toBe(before);
    cleanup = listenerCollector(bus, DEFAULT_CONFIG);
  });

  it("leaves a frozen listener prototype alone instead of throwing", () => {
    cleanup();
    const isFrozen = Object.isFrozen;
    Object.isFrozen = (() => true) as typeof Object.isFrozen;

    try {
      const nativeAdd = document.createElement("div").addEventListener;
      const localEvents: BugEvent[] = [];
      const localBus = new EventBus();
      localBus.subscribe((batch) => localEvents.push(...batch));
      const localCleanup = listenerCollector(localBus, DEFAULT_CONFIG);
      localBus.flush();

      expect(document.createElement("div").addEventListener).toBe(nativeAdd);
      expect(localEvents).toHaveLength(0);
      localCleanup();
    } finally {
      Object.isFrozen = isFrozen;
    }

    cleanup = listenerCollector(bus, DEFAULT_CONFIG);
  });
});
