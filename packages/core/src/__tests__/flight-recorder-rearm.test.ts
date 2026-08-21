// A flight recorder session that reported once used to go deaf for good: the
// state stayed "finalized" for the life of the instance, and admission refused
// every event after it — no events, no ring buffer, and no `capture_gap` saying
// capture had stopped. Meanwhile the auto flag controller keeps raising signals
// (`autoFlagMaxPerSession` defaults to 10), so the session goes on asking for
// reports it can no longer produce.
//
// Finalization ends a WINDOW, not the session. Once the report is away the
// recorder re-arms and buffers the next one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("flight recorder after a report", () => {
  it("re-arms, so a second failure in the same session is still captured", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flightRecorder: true,
      flightRecorderTailMs: 10,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
      sessionPersistence: "memory",
    });

    logger.addEvent({ type: "first-window", data: { safe: true } });
    const first = logger.flag();
    await vi.advanceTimersByTimeAsync(10);
    await first;

    expect((logger as unknown as { flightRecorderState: string })
      .flightRecorderState).toBe("buffering");

    logger.addEvent({ type: "second-window", data: { safe: true } });
    const second = logger.flag();
    await vi.advanceTimersByTimeAsync(10);
    await second;

    expect(transport.sendBugReport).toHaveBeenCalledTimes(2);
    const secondReportEvents = transport.sendBugReport.mock.calls[1][1];
    expect(secondReportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ k: "second-window" }),
      ]),
    );
    // The second window is its own window: the first one's events were cleared
    // with the report that carried them.
    expect(secondReportEvents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ k: "first-window" })]),
    );

    await logger.stop();
  });
});
