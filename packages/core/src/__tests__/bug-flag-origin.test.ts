import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crumbtrail } from "../crumbtrail";

/**
 * An automatic capture is not a bug report somebody filed.
 *
 * The phantom this file pins down: an app with no flag button, nobody typing anything,
 * an ordinary button click that happened to fail. The session came back carrying a
 * `bug.flag` whose `note` was a run of asterisks, because the auto-flag controller put
 * the detector's own sentence in the note field and the capture path masked it as if a
 * person had written it. Downstream that reads as "a capture with a note attached was
 * recorded, and its text was masked in the browser before capture" — two claims that
 * were both false.
 */

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

function flagEvents(transport: ReturnType<typeof makeTransport>) {
  const fromReports = transport.sendBugReport.mock.calls.flatMap(
    (call) => (call[1] as Array<{ k: string; d: Record<string, unknown> }>) ?? [],
  );
  const fromStream = transport.sendEvents.mock.calls.flatMap(
    (call) => (call[0] as Array<{ k: string; d: Record<string, unknown> }>) ?? [],
  );
  // The same event reaches both the report bundle and the live stream; identity is the
  // bug id, so one flag counts once however many places carried it.
  const byBugId = new Map<string, { k: string; d: Record<string, unknown> }>();
  for (const event of [...fromReports, ...fromStream]) {
    if (event.k !== "bug.flag") continue;
    byBugId.set(String(event.d.bugId), event);
  }
  return [...byBugId.values()];
}

describe("bug.flag provenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("an automatic capture carries no note and states origin auto", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      autoFlagOnError: true,
      autoFlagDebounceMs: 10,
      environment: false,
      domSnapshot: false,
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.addEvent({
      type: "err",
      data: { msg: "Checkout failed", stk: "Error: Checkout failed\n  at checkout.ts:1:1" },
    });
    await vi.advanceTimersByTimeAsync(50);

    const flags = flagEvents(transport);
    expect(flags).toHaveLength(1);
    const d = flags[0].d;
    expect(d.origin).toBe("auto");
    // The phantom: no note field at all, so nothing downstream can report one as
    // present, and nothing can report it as masked.
    expect("note" in d).toBe(false);
    expect(d.reason).toContain("Checkout failed");
    // …and the reason is the SDK's own words, so it is legible rather than starred out.
    expect(String(d.reason)).not.toMatch(/\*/);

    await logger.stop();
  });

  it("a report a person filed keeps its masked note and states origin user", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      environment: false,
      domSnapshot: false,
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    await logger.flagBug({ note: "the total is wrong" });

    const flags = flagEvents(transport);
    expect(flags).toHaveLength(1);
    const d = flags[0].d;
    expect(d.origin).toBe("user");
    expect(d.note).toBe("*** ***** ** *****");
    expect("reason" in d).toBe(false);

    await logger.stop();
  });

  it("a caller cannot claim automatic provenance through the public entry point", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      environment: false,
      domSnapshot: false,
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    await logger.flagBug({
      note: "hi",
      ...({ origin: "auto", autoReason: "not mine to say" } as Record<string, unknown>),
    });

    const d = flagEvents(transport)[0].d;
    expect(d.origin).toBe("user");
    expect("reason" in d).toBe(false);

    await logger.stop();
  });
});
