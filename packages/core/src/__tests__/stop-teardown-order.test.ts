import { describe, it, expect, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import type { BugEvent } from "../types";

/**
 * The ordering constraints inside `stop()`, which three review waves and one
 * merge have now each had a chance to destroy quietly.
 *
 * `stop()` is a sequence whose steps are only correct relative to
 * `this.stopped`, and nothing about reading it top to bottom says so. Two
 * separate features settle their teardown on opposite sides of that flag on
 * purpose, and both look equally movable:
 *
 * - The flight recorder is aborted AFTER the flag, because
 *   `updateFlightRecorderState()` derives a non terminal recorder's state from
 *   `canCapture()`, and `canCapture()` is false only once `stopped` is set.
 * - Session replay is torn down BEFORE it, while the session is still live and
 *   well ahead of `endSession()` finalizing the log it uploads against.
 *
 * Neither ordering has a test that fails loudly when it is reversed, which is
 * how a merge silently reintroduces the defect. These are those tests.
 */

function makeTransport() {
  const sent: BugEvent[] = [];
  const order: string[] = [];
  return {
    sent,
    order,
    transport: {
      sendEvents: vi.fn(async (events: BugEvent[]) => {
        sent.push(...events);
      }),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn(async () => {
        order.push("endSession");
      }),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function init(
  transport: ReturnType<typeof makeTransport>,
  extra: Record<string, unknown> = {},
) {
  return Crumbtrail.init({
    transportInstance: transport.transport,
    widget: false,
    environment: false,
    domSnapshot: false,
    flushIntervalMs: 100_000,
    flushBufferSize: 1_000,
    ...extra,
  } as any);
}

describe("an armed flight recorder settles to armed, not buffering", () => {
  it("is buffering while the session is live and armed once stop() has run", async () => {
    const transport = makeTransport();
    const logger = init(transport, {
      flightRecorder: true,
      flightRecorderTailMs: 10_000,
    });

    // The premise the assertion below depends on: while the session is live,
    // `canCapture()` is true and a never triggered recorder sits in
    // "buffering". Without this the "armed" check would pass on a recorder
    // that was never buffering in the first place.
    expect((logger as any).flightRecorderState).toBe("buffering");

    await logger.stop();

    // `abortFlightRecorder()` runs after `stopped = true`, so `canCapture()` is
    // false and the recorder closes as "armed". Move that call above the flag
    // and it reopens as "buffering" on the way out.
    expect((logger as any).flightRecorderState).toBe("armed");
  });

  it("stays armed even when a replay recorder is torn down in the same stop()", async () => {
    // The merge case specifically: replay teardown was inserted into this
    // sequence, and it must not drag `abortFlightRecorder()` across the flag
    // with it.
    const transport = makeTransport();
    const logger = init(transport, {
      flightRecorder: true,
      flightRecorderTailMs: 10_000,
    });
    (logger as any).replay = { stop: vi.fn().mockResolvedValue(undefined) };

    await logger.stop();

    expect((logger as any).flightRecorderState).toBe("armed");
  });
});

describe("session replay teardown fits into the stop() sequence", () => {
  it("finishes its upload before the session is ended", async () => {
    const transport = makeTransport();
    const logger = init(transport);
    const replayStop = vi.fn(async () => {
      // A real recorder gzips and uploads here. The point of awaiting it is
      // that this work lands against a session the server still has open.
      await new Promise((resolve) => setTimeout(resolve, 5));
      transport.order.push("replay.stop");
    });
    (logger as any).replay = { stop: replayStop };

    await logger.stop();

    expect(replayStop).toHaveBeenCalledTimes(1);
    expect(transport.order).toEqual(["replay.stop", "endSession"]);
  });

  it("runs while the session is still live", async () => {
    const transport = makeTransport();
    const logger = init(transport);
    let stoppedDuringReplayTeardown: boolean | undefined;
    (logger as any).replay = {
      stop: vi.fn(async () => {
        stoppedDuringReplayTeardown = (logger as any).stopped;
      }),
    };

    await logger.stop();

    // The recorder reaches the transport directly rather than through the bus,
    // so nothing it does today is dropped by `canTransport()`. It is torn down
    // on the live side of the flag anyway, so that it cannot start depending on
    // a flag that has already flipped.
    expect(stoppedDuringReplayTeardown).toBe(false);
  });

  it("is dropped from the instance so a second stop() cannot re-run it", async () => {
    const transport = makeTransport();
    const logger = init(transport);
    const replayStop = vi.fn().mockResolvedValue(undefined);
    (logger as any).replay = { stop: replayStop };

    await logger.stop();
    await logger.stop();

    expect(replayStop).toHaveBeenCalledTimes(1);
    expect((logger as any).replay).toBeUndefined();
  });

  it("does not strand the rest of shutdown when it rejects", async () => {
    const transport = makeTransport();
    const logger = init(transport, {
      flightRecorder: true,
      flightRecorderTailMs: 10_000,
    });
    (logger as any).replay = {
      stop: vi.fn().mockRejectedValue(new Error("chunk upload blew up")),
    };

    const pending = logger.flag();
    await expect(logger.stop()).resolves.toMatchObject({
      sessionId: expect.any(String),
    });

    // The recorder here was flagged, so it is terminal and legitimately closes
    // as "finalized". The never triggered case — the one finding 2 is actually
    // about — is asserted in the suite above.
    await expect(pending).resolves.toMatchObject({ bugId: expect.any(String) });
    expect(transport.transport.endSession).toHaveBeenCalledTimes(1);
  });
});
