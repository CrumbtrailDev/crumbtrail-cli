import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, type BugEvent } from "../../types";
import { heartbeatCollector } from "../heartbeat";

describe("heartbeatCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = heartbeatCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("emits an hb event after 30 seconds", () => {
    vi.advanceTimersByTime(30_000);
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("hb");
  });

  it("emits dom count in the payload", () => {
    vi.advanceTimersByTime(30_000);
    bus.flush();

    expect(typeof events[0].d.dom).toBe("number");
  });

  it("stamps the interval it used on the payload", () => {
    vi.advanceTimersByTime(30_000);
    bus.flush();

    expect(events[0].d.intervalMs).toBe(30_000);
  });

  it("stops emitting after cleanup", () => {
    // Fire once first so cleanup runs against the recursively re-armed timer
    // set up by fire() at heartbeat.ts:56, not just the original setTimeout.
    vi.advanceTimersByTime(30_000);
    bus.flush();
    expect(events).toHaveLength(1);

    cleanup();
    vi.advanceTimersByTime(120_000);
    bus.flush();

    expect(events).toHaveLength(1);
    // reassign so afterEach cleanup doesn't error on double-call
    cleanup = () => {};
  });

  it("doubles the interval on a quiet session, capped at 120 seconds", () => {
    // No application events emitted anywhere in this test: every heartbeat
    // after the first should see no activity and back off.
    vi.advanceTimersByTime(30_000); // hb #1 at 30s, interval was 30s
    vi.advanceTimersByTime(60_000); // hb #2 at 90s, interval was 60s
    vi.advanceTimersByTime(120_000); // hb #3 at 210s, interval was 120s
    vi.advanceTimersByTime(120_000); // hb #4 at 330s, interval stays capped at 120s
    bus.flush();

    expect(events.map((e) => e.d.intervalMs)).toEqual([
      30_000, 60_000, 120_000, 120_000,
    ]);
  });

  it("resets to the base interval on the next application event", () => {
    vi.advanceTimersByTime(30_000); // hb #1, interval 30s -> backs off to 60s
    vi.advanceTimersByTime(60_000); // hb #2, interval 60s, no activity since #1

    // An application event lands during the third (backed off) window.
    bus.emit({ t: 0, k: "click", d: {} });

    vi.advanceTimersByTime(120_000); // hb #3, interval 120s, but activity seen
    bus.flush();

    const heartbeats = () => events.filter((e) => e.k === "hb");
    expect(heartbeats().map((e) => e.d.intervalMs)).toEqual([
      30_000, 60_000, 120_000,
    ]);

    // The next heartbeat is back at the base cadence.
    vi.advanceTimersByTime(30_000); // hb #4
    bus.flush();

    expect(heartbeats()[3].d.intervalMs).toBe(30_000);
  });

  it("does not re-arm when a tap stops the collector synchronously during emit", () => {
    // bus.tap handlers run synchronously inside bus.emit. If one of them
    // calls cleanup() on seeing the hb event, fire() must not re-arm a
    // timer after emit returns (heartbeat.ts:49-56).
    const stopOnHeartbeat = bus.tap((event) => {
      if (event.k === "hb") cleanup();
    });

    vi.advanceTimersByTime(30_000);
    bus.flush();
    expect(events).toHaveLength(1);

    vi.advanceTimersByTime(120_000);
    bus.flush();

    expect(events).toHaveLength(1);
    stopOnHeartbeat();
    // reassign so afterEach cleanup doesn't error on double-call
    cleanup = () => {};
  });

  it("does not count its own heartbeats as activity", () => {
    // Advance across several heartbeats with zero application events; the
    // interval must keep backing off rather than staying pinned at the base
    // because the heartbeat's own emit was mistaken for activity.
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(60_000);
    bus.flush();

    expect(events.map((e) => e.d.intervalMs)).toEqual([30_000, 60_000]);
  });
});
