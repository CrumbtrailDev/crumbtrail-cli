// The bus sits inside the host application's own call stack: `flush()` runs
// from `emit()`, which runs from a patched `fetch`, a `console.error`, or a
// click handler. Two things follow, and neither held before:
//
//   - a subscriber that throws must not throw into the customer's app. `tap()`
//     already guards for exactly this reason; `flush()` did not, and the
//     transport subscriber is a caller-supplied `transportInstance` whose
//     `sendEvents` may be a plain function that throws synchronously.
//   - the buffer must have a ceiling. While the host holds `pause()` nothing
//     flushes, and this was the only unbounded buffer in the SDK: the ring
//     buffer, the early queue, the probes and the delivery gaps all cap.

import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus";
import { Crumbtrail } from "../crumbtrail";
import { CAPTURE_GAP_EVENT_KIND, type BugEvent } from "../types";

function makeEvent(k = "test"): BugEvent {
  return { t: Date.now(), k, d: {} };
}

describe("EventBus containment", () => {
  it("does not let a throwing subscriber escape into the caller", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    bus.subscribe(() => {
      throw new Error("transport blew up");
    });
    bus.subscribe((events) => received.push(...events));

    bus.emit(makeEvent());
    expect(() => bus.flush()).not.toThrow();
    // And the batch still reaches every other subscriber, including the ring
    // buffer registered after the transport.
    expect(received).toHaveLength(1);
  });

  it("caps the buffer while paused and counts what it dropped", () => {
    const bus = new EventBus();
    const received: BugEvent[] = [];
    bus.subscribe((events) => received.push(...events));
    bus.setMaxBufferedEvents(5);
    bus.pause();

    for (let i = 0; i < 12; i++) bus.emit(makeEvent(`e${i}`));
    bus.resume();

    expect(received).toHaveLength(5);
    // Oldest go first: what a reader needs after a long pause is the events
    // nearest the failure.
    expect(received.map((event) => event.k)).toEqual([
      "e7",
      "e8",
      "e9",
      "e10",
      "e11",
    ]);
    expect(bus.takeDroppedEventCount()).toBe(7);
    expect(bus.takeDroppedEventCount()).toBe(0);
  });
});

describe("Crumbtrail.resume()", () => {
  it("declares the events a long pause cost", async () => {
    const transport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: transport,
      network: false,
      environment: false,
      domSnapshot: false,
      heartbeat: false,
      performance: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
      ringBufferMaxEvents: 4,
      sessionPersistence: "memory",
    });

    logger.pause();
    for (let i = 0; i < 10; i++) logger.mark(`m${i}`);
    logger.resume();
    await logger.stop();

    const events = transport.sendEvents.mock.calls.flatMap(
      (call) => call[0] as BugEvent[],
    );
    const gap = events.find(
      (event) =>
        event.k === CAPTURE_GAP_EVENT_KIND &&
        event.d?.reason === "buffer_overflow",
    );
    expect(gap).toBeDefined();
    // Ten marks against a four event ceiling: at least six had to go, and the
    // record names how many rather than leaving the hole unexplained.
    expect(Number(gap?.d?.droppedEventCount)).toBeGreaterThanOrEqual(6);
  });
});
