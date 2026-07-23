import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent } from "../types";
import { DEFAULT_CONFIG, UI_NUM_EVENT_KIND } from "../types";
import { subscribeNavCommit } from "../nav-signal";
import { interactionCollector } from "../collectors/interaction";
import {
  uiNumbersCollector,
  UI_NUM_SETTLE_MS,
} from "../collectors/ui-numbers";

describe("nav-signal", () => {
  const nativePushState = history.pushState;
  const nativeReplaceState = history.replaceState;

  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  it("fans a push commit out to multiple subscribers after the URL changes", () => {
    const seen: Array<{ kind: string; href: string }> = [];
    const unsubA = subscribeNavCommit((kind) =>
      seen.push({ kind, href: window.location.href }),
    );
    const unsubB = subscribeNavCommit((kind) =>
      seen.push({ kind, href: window.location.href }),
    );

    history.pushState(null, "", "/checkout");
    expect(seen).toEqual([
      { kind: "push", href: "http://localhost:3000/checkout" },
      { kind: "push", href: "http://localhost:3000/checkout" },
    ]);

    unsubA();
    unsubB();
    expect(history.pushState).toBe(nativePushState);
    expect(history.replaceState).toBe(nativeReplaceState);
  });

  it("keeps notifying remaining subscribers when one unsubscribes, and a throwing subscriber does not break peers", () => {
    const seen: string[] = [];
    const unsubThrow = subscribeNavCommit(() => {
      throw new Error("subscriber exploded");
    });
    const unsubOk = subscribeNavCommit((kind) => seen.push(kind));

    expect(() => history.pushState(null, "", "/a")).not.toThrow();
    expect(seen).toEqual(["push"]);

    unsubThrow();
    history.replaceState(null, "", "/b");
    expect(seen).toEqual(["push", "replace"]);

    unsubOk();
    expect(history.pushState).toBe(nativePushState);
  });

  it("does not restore over a third-party wrapper installed after ours", () => {
    const unsub = subscribeNavCommit(() => {});
    const ourWrapper = history.pushState;
    const thirdParty = function (
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      ourWrapper.apply(history, args);
    };
    history.pushState = thirdParty;

    unsub();
    // pushState left alone (third party owns the top of the chain);
    // replaceState was still ours, so it is restored.
    expect(history.pushState).toBe(thirdParty);
    expect(history.replaceState).toBe(nativeReplaceState);

    history.pushState = nativePushState;
  });

  it("leaked wrapper keeps delegating after restore instead of throwing", () => {
    const unsub = subscribeNavCommit(() => {});
    const ourWrapper = history.pushState;
    let thirdPartyCalls = 0;
    const thirdParty = function (
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      thirdPartyCalls++;
      ourWrapper.apply(history, args);
    };
    history.pushState = thirdParty;

    // Restore is skipped for pushState (third party owns the chain), so our
    // wrapper leaks. It must keep delegating to the captured original.
    unsub();
    expect(() => history.pushState(null, "", "/leaked")).not.toThrow();
    expect(thirdPartyCalls).toBe(1);
    expect(window.location.pathname).toBe("/leaked");

    history.pushState = nativePushState;
  });

  it("leaked wrapper from an old generation does not notify subscribers of a new cycle", () => {
    const unsub = subscribeNavCommit(() => {});
    const leakedWrapper = history.pushState;
    const thirdParty = function (
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      leakedWrapper.apply(history, args);
    };
    history.pushState = thirdParty;
    unsub(); // restore skipped for pushState; leakedWrapper is stale now

    // New subscribe cycle wraps over the third-party chain.
    const seen: string[] = [];
    const unsub2 = subscribeNavCommit((kind) => seen.push(kind));

    history.pushState(null, "", "/second-cycle");
    // Exactly one notification (from the current wrapper), not a duplicate
    // from the stale leaked wrapper further down the chain.
    expect(seen).toEqual(["push"]);
    expect(window.location.pathname).toBe("/second-cycle");

    unsub2();
    history.pushState = nativePushState;
  });

  describe("combined collector teardown", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function initBoth() {
      const events: BugEvent[] = [];
      const bus = new EventBus();
      bus.subscribe((batch) => events.push(...batch));
      // Registration order matches bug-logger's COLLECTOR_MAP:
      // interactions before uiNumbers.
      const interactionCleanup = interactionCollector(bus, DEFAULT_CONFIG);
      const uiNumbersCleanup = uiNumbersCollector(bus, DEFAULT_CONFIG);
      const stop = () => {
        // bug-logger stop() runs cleanups in registration order.
        interactionCleanup();
        uiNumbersCleanup();
      };
      return { events, bus, stop };
    }

    it("restores native pushState/replaceState after stop with both collectors registered", () => {
      const { stop } = initBoth();
      expect(history.pushState).not.toBe(nativePushState);

      stop();
      expect(history.pushState).toBe(nativePushState);
      expect(history.replaceState).toBe(nativeReplaceState);

      // The restored functions are live, not dead closures.
      expect(() => history.pushState(null, "", "/after-stop")).not.toThrow();
      expect(window.location.pathname).toBe("/after-stop");
    });

    it("init→stop→init→stop does not grow a wrapper chain or leak dead subscribers", () => {
      const first = initBoth();
      first.stop();
      expect(history.pushState).toBe(nativePushState);

      const second = initBoth();
      second.bus.flush();
      second.events.length = 0;

      document.body.innerHTML =
        '<dl class="totals"><dt>Total</dt><dd>$9.99</dd></dl>';
      history.pushState(null, "", "/checkout");
      vi.advanceTimersByTime(UI_NUM_SETTLE_MS);
      second.bus.flush();

      // Exactly one nav event and one ui.num snapshot: no duplicate delivery
      // through stale wrappers from the first init cycle.
      const navEvents = second.events.filter(
        (event) => event.k === "nav" && event.d.tr === "push",
      );
      expect(navEvents).toHaveLength(1);
      expect(
        second.events.filter((event) => event.k === UI_NUM_EVENT_KIND),
      ).toHaveLength(1);

      second.stop();
      expect(history.pushState).toBe(nativePushState);
      expect(history.replaceState).toBe(nativeReplaceState);
    });
  });
});
