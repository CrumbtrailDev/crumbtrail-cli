import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crumbtrail } from "../bug-logger";
import { CAPTURE_GAP_EVENT_KIND, type BugEvent } from "../types";

// A batch the endpoint refuses used to be discarded as if it had been
// delivered, so the session reported itself complete while the evidence was
// gone. A reader could not tell "nothing went wrong" from "the evidence was
// thrown away", which is the one failure mode a capture product cannot have.

/** Counts gap records without retaining every batch: the collectors are chatty. */
function refusingTransport(counters: { sends: number; gaps: number }) {
  return {
    sendEvents: vi.fn(async (events: BugEvent[]) => {
      counters.sends += 1;
      counters.gaps += events.filter(
        (event) => event.k === CAPTURE_GAP_EVENT_KIND,
      ).length;
      throw Object.assign(new Error("refused"), { status: 413 });
    }),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

function capturedGaps(transport: { sendEvents: ReturnType<typeof vi.fn> }) {
  return transport.sendEvents.mock.calls
    .flatMap((call) => call[0] as BugEvent[])
    .filter((event) => event.k === CAPTURE_GAP_EVENT_KIND);
}

describe("a refused batch is declared, not swallowed", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"ok":true}')),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("emits a delivery_failed capture gap naming how many events were lost", async () => {
    const counters = { sends: 0, gaps: 0 };
    const transport = refusingTransport(counters);
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.addEvent({ type: "con", data: { lv: "err", args: ["boom"] } });
    // The gap is recorded from the failed send's rejection handler, which runs
    // after that flush; it rides the next flush, or stop()'s direct drain when
    // the refusal happened on the session's last one.
    await logger.stop();
    expect(counters.sends).toBeGreaterThan(0);

    const gap = capturedGaps(transport)[0];
    expect(gap?.d).toMatchObject({
      surface: "browser",
      reason: "delivery_failed",
    });
    // `detail` is a classification field, so the size rides a structured count.
    expect((gap.d as { droppedEventCount?: number }).droppedEventCount)
      .toBeGreaterThan(0);
  });

  it("stays bounded when the endpoint refuses everything", async () => {
    const counters = { sends: 0, gaps: 0 };
    const logger = Crumbtrail.init({
      transportInstance: refusingTransport(counters),
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    for (let i = 0; i < 25; i += 1) {
      logger.addEvent({ type: "con", data: { lv: "err", args: [`e${i}`] } });
      await Promise.resolve();
    }
    await logger.stop();

    // A gap about a batch of gaps would recurse for as long as the endpoint is
    // down, so the record is capped rather than proportional to the failures.
    // The closing summary makes it at most one more than the cap.
    expect(counters.gaps).toBeGreaterThan(0);
    expect(counters.gaps).toBeLessThanOrEqual(4);
  });

  it("declares the events the capped records could not name", async () => {
    const counters = { sends: 0, gaps: 0 };
    const transport = refusingTransport(counters);
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });

    for (let i = 0; i < 40; i += 1) {
      logger.addEvent({ type: "con", data: { lv: "err", args: [`e${i}`] } });
      await Promise.resolve();
    }
    await logger.stop();

    const total = capturedGaps(transport).reduce(
      (sum, gap) => sum + ((gap.d as { droppedEventCount?: number }).droppedEventCount ?? 0),
      0,
    );
    // Three per-batch records could only speak for three batches; the total has
    // to reflect every failed send, not the first few.
    expect(total).toBeGreaterThan(counters.sends / 2);
  });

  it("emits nothing when delivery succeeds", async () => {
    const transport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.addEvent({ type: "con", data: { lv: "err", args: ["fine"] } });
    await logger.stop();

    expect(capturedGaps(transport)).toHaveLength(0);
  });
});
