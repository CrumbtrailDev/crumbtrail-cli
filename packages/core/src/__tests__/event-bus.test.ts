import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent } from "../types";

function makeEvent(k = "test"): BugEvent {
  return { t: Date.now(), k, d: {} };
}

describe("EventBus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers events until flush", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    bus.subscribe((events) => received.push(...events));

    bus.emit(makeEvent());
    expect(received).toHaveLength(0);

    bus.flush();
    expect(received).toHaveLength(1);
  });

  it("auto-flushes when buffer reaches flushBufferSize", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    bus.subscribe((events) => received.push(...events));
    bus.start(60_000, 3);

    bus.emit(makeEvent());
    bus.emit(makeEvent());
    expect(received).toHaveLength(0);

    bus.emit(makeEvent());
    expect(received).toHaveLength(3);

    bus.stop();
  });

  it("flushes on timer interval", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    bus.subscribe((events) => received.push(...events));
    bus.start(1000, 999);

    bus.emit(makeEvent());
    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    expect(received).toHaveLength(1);

    bus.stop();
  });

  it("does not flush when paused (timer fires but skips)", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    bus.subscribe((events) => received.push(...events));
    bus.start(1000, 999);

    bus.pause();
    bus.emit(makeEvent());
    vi.advanceTimersByTime(1000);
    expect(received).toHaveLength(0);

    bus.resume();
    expect(received).toHaveLength(1);

    bus.stop();
  });

  it("does not auto-flush on emit when paused", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    bus.subscribe((events) => received.push(...events));
    bus.start(60_000, 2);

    bus.pause();
    bus.emit(makeEvent());
    bus.emit(makeEvent());
    bus.emit(makeEvent());
    expect(received).toHaveLength(0);

    bus.resume();
    expect(received).toHaveLength(3);

    bus.stop();
  });

  it("flushes remaining events on stop", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    bus.subscribe((events) => received.push(...events));
    bus.start(60_000, 999);

    bus.emit(makeEvent());
    bus.stop();
    expect(received).toHaveLength(1);
  });

  it("returns unsubscribe function", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    const unsub = bus.subscribe((events) => received.push(...events));

    bus.emit(makeEvent());
    bus.flush();
    expect(received).toHaveLength(1);

    unsub();
    bus.emit(makeEvent());
    bus.flush();
    expect(received).toHaveLength(1);
  });

  it("no-ops flush on empty buffer", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.subscribe(fn);

    bus.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("tap() observes events immediately on emit, before any flush", () => {
    const bus = new EventBus();
    const tapped: BugEvent[] = [];
    const batched: BugEvent[] = [];
    bus.subscribe((events) => batched.push(...events));
    bus.tap((event) => tapped.push(event));

    bus.emit(makeEvent("err"));
    expect(tapped).toHaveLength(1);
    expect(tapped[0].k).toBe("err");
    expect(batched).toHaveLength(0);
  });

  it("tap() returns an unsubscribe function", () => {
    const bus = new EventBus();
    const tapped: BugEvent[] = [];
    const untap = bus.tap((event) => tapped.push(event));

    bus.emit(makeEvent());
    expect(tapped).toHaveLength(1);

    untap();
    bus.emit(makeEvent());
    expect(tapped).toHaveLength(1);
  });

  it("a throwing tap does not break emit", () => {
    const bus = new EventBus();
    bus.tap(() => {
      throw new Error("tap failure");
    });
    expect(() => bus.emit(makeEvent())).not.toThrow();
  });

  it("delivers to multiple subscribers", () => {
    const bus = new EventBus();
    const a: BugEvent[] = [];
    const b: BugEvent[] = [];
    bus.subscribe((events) => a.push(...events));
    bus.subscribe((events) => b.push(...events));

    bus.emit(makeEvent());
    bus.flush();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
