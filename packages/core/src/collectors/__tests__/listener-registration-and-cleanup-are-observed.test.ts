import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, UI_LISTENERS_EVENT_KIND } from "../../types";
import type { BugEvent } from "../../types";
import {
  LISTENER_SITES_PER_GAUGE,
  LISTENER_SITE_MAX_CHARS,
  LISTENER_SITE_MAX_FRAMES,
  listenerCollector,
} from "../listeners";

/**
 * The live count alone cannot tell "N registered, none removed" from
 * "N + M registered, M removed" — both leave the same rising gauge. A consumer
 * that reads the gauge and states which one happened is stating an unobserved
 * mechanism. These tests pin the observable that makes the difference visible:
 * cumulative, monotone registration and removal counters emitted alongside the
 * live counts, on the same aggregation, so a row and its churn correspond.
 *
 * As elsewhere in this suite the realm is shared with the test runner, so every
 * assertion is scoped to event types this file invents.
 */
describe("listener registration and removal are recorded, not just the live count", () => {
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

  function liveFor(gauge: BugEvent, type: string): number | undefined {
    const byType = gauge.d.byType as Array<[string, number]>;
    return byType.find((entry) => entry[0] === type)?.[1];
  }

  function churnFor(
    gauge: BugEvent,
    type: string,
  ): { added: number; removed: number } | undefined {
    const rows = gauge.d.churnByType as Array<[string, number, number]>;
    const row = rows?.find((entry) => entry[0] === type);
    return row ? { added: row[1], removed: row[2] } : undefined;
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

  it("emits churn rows for exactly the types in byType, in the same order", () => {
    const el = document.createElement("div");
    el.addEventListener("churn-a", () => {});
    history.pushState({}, "", "/churn-rows");

    const gauge = latest();
    const byType = gauge.d.byType as Array<[string, number]>;
    const churnByType = gauge.d.churnByType as Array<[string, number, number]>;
    expect(churnByType).toBeInstanceOf(Array);
    expect(churnByType.map((row) => row[0])).toEqual(
      byType.map((row) => row[0]),
    );
    for (const row of churnByType) expect(row).toHaveLength(3);
  });

  it("distinguishes add-N-remove-M from add-(N-M) at the same live count", () => {
    const el = document.createElement("div");
    const handlers = [0, 1, 2, 3, 4].map(() => () => {});
    for (const handler of handlers) el.addEventListener("churn-mixed", handler);
    for (const handler of handlers.slice(0, 3))
      el.removeEventListener("churn-mixed", handler);

    const other = document.createElement("div");
    other.addEventListener("churn-quiet", () => {});
    other.addEventListener("churn-quiet", () => {});

    history.pushState({}, "", "/churn-mixed");
    const gauge = latest();

    // Same live count, and only the churn tells the two histories apart.
    expect(liveFor(gauge, "churn-mixed")).toBe(2);
    expect(liveFor(gauge, "churn-quiet")).toBe(2);
    expect(churnFor(gauge, "churn-mixed")).toEqual({ added: 5, removed: 3 });
    expect(churnFor(gauge, "churn-quiet")).toEqual({ added: 2, removed: 0 });
  });

  it("keeps the counters cumulative and monotone across readings", () => {
    const el = document.createElement("div");
    const handler = () => {};
    el.addEventListener("churn-monotone", handler);
    el.addEventListener("churn-monotone", () => {});
    history.pushState({}, "", "/churn-first");
    const first = churnFor(latest(), "churn-monotone");

    el.removeEventListener("churn-monotone", handler);
    history.pushState({}, "", "/churn-second");
    const second = churnFor(latest(), "churn-monotone");

    expect(first).toEqual({ added: 2, removed: 0 });
    // A removal decrements the live count; it must never decrement `added`.
    expect(second).toEqual({ added: 2, removed: 1 });
    expect(liveFor(latest(), "churn-monotone")).toBe(1);
  });

  it("holds added - removed equal to the live count for a type", () => {
    const el = document.createElement("div");
    const handlers = [0, 1, 2, 3].map(() => () => {});
    for (const handler of handlers)
      el.addEventListener("churn-invariant", handler);
    el.removeEventListener("churn-invariant", handlers[0]);
    history.pushState({}, "", "/churn-invariant");

    const gauge = latest();
    const churn = churnFor(gauge, "churn-invariant");
    expect(churn).toBeDefined();
    expect(
      (churn as { added: number }).added -
        (churn as { removed: number }).removed,
    ).toBe(liveFor(gauge, "churn-invariant"));
  });

  it("aggregates churn across target kinds, matching how byType aggregates", () => {
    const el = document.createElement("div");
    el.addEventListener("churn-kinds", () => {});
    window.addEventListener("churn-kinds", () => {});
    history.pushState({}, "", "/churn-kinds");

    const gauge = latest();
    expect(liveFor(gauge, "churn-kinds")).toBe(2);
    expect(churnFor(gauge, "churn-kinds")).toEqual({ added: 2, removed: 0 });
  });

  it("starts a second init in the same page from zero, not from stale totals", () => {
    const el = document.createElement("div");
    el.addEventListener("churn-reset", () => {});
    history.pushState({}, "", "/churn-before-reset");
    expect(churnFor(latest(), "churn-reset")).toEqual({ added: 1, removed: 0 });

    cleanup();
    const restartedEvents: BugEvent[] = [];
    const restartedBus = new EventBus();
    restartedBus.subscribe((batch) => restartedEvents.push(...batch));
    cleanup = listenerCollector(restartedBus, DEFAULT_CONFIG);
    restartedBus.flush();

    const baseline = restartedEvents.filter(
      (event) => event.k === UI_LISTENERS_EVENT_KIND,
    )[0];
    const rows = baseline.d.churnByType as Array<[string, number, number]>;
    expect(rows.find((row) => row[0] === "churn-reset")).toBeUndefined();
  });

  /**
   * The census said HOW MANY listeners were live and never WHERE any of them
   * was registered, so a reader holding the repo still had to guess which file
   * to open. These pin the callsite and, just as hard, the bounds on it: a
   * string per registration on the hottest path in the DOM is not affordable.
   */
  describe("registration callsites", () => {
    function sitesIn(gauge: BugEvent): Array<[string, string]> {
      return (gauge.d.stk as Array<[string, string]>) ?? [];
    }

    function allSites(): Array<[string, string]> {
      return gauges().flatMap(sitesIn);
    }

    function registerFromNamedFunction(): void {
      const el = document.createElement("div");
      for (let i = 0; i < 6; i += 1)
        el.addEventListener("site-probe", () => {});
    }

    it("names the application function that registered a listener", () => {
      registerFromNamedFunction();
      for (const path of ["/site-a", "/site-b", "/site-c", "/site-d"])
        history.pushState({}, "", path);

      const site = allSites().find(([type]) => type === "site-probe");
      expect(site).toBeDefined();
      const frames = (site as [string, string])[1].split("\n");
      // The familiar `Error\n    at …` shape the frame parser already reads.
      expect(frames[0]).toMatch(/^Error/);
      // The first frame after the header is the caller, never this collector.
      expect(frames[1]).toContain("registerFromNamedFunction");
      expect(frames[1]).not.toContain("listeners.ts");
    });

    it("bounds the frames, the characters and the sites per gauge", () => {
      registerFromNamedFunction();
      const el = document.createElement("div");
      for (let i = 0; i < 6; i += 1) {
        el.addEventListener("site-second", () => {});
        el.addEventListener("site-third", () => {});
      }
      for (const path of ["/bound-a", "/bound-b", "/bound-c"])
        history.pushState({}, "", path);

      for (const gauge of gauges()) {
        expect(sitesIn(gauge).length).toBeLessThanOrEqual(
          LISTENER_SITES_PER_GAUGE,
        );
        for (const [, stack] of sitesIn(gauge)) {
          expect(stack.split("\n").length).toBeLessThanOrEqual(
            LISTENER_SITE_MAX_FRAMES + 1,
          );
          expect(stack.length).toBeLessThanOrEqual(LISTENER_SITE_MAX_CHARS);
        }
      }
    });

    it("reports a site once instead of on every gauge", () => {
      registerFromNamedFunction();
      for (const path of ["/once-a", "/once-b", "/once-c", "/once-d"])
        history.pushState({}, "", path);

      const stacks = allSites().map(([, stack]) => stack);
      expect(new Set(stacks).size).toBe(stacks.length);
    });

    it("forgets captured sites when the collector is restored", () => {
      registerFromNamedFunction();
      for (const path of ["/forget-a", "/forget-b"])
        history.pushState({}, "", path);

      cleanup();
      const restartedEvents: BugEvent[] = [];
      const restartedBus = new EventBus();
      restartedBus.subscribe((batch) => restartedEvents.push(...batch));
      cleanup = listenerCollector(restartedBus, DEFAULT_CONFIG);
      restartedBus.flush();

      const carried = restartedEvents
        .filter((event) => event.k === UI_LISTENERS_EVENT_KIND)
        .flatMap((event) => (event.d.stk as Array<[string, string]>) ?? []);
      expect(carried.find(([type]) => type === "site-probe")).toBeUndefined();
    });
  });
});
