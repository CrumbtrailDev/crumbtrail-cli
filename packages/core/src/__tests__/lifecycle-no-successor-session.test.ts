import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";

/**
 * A page that is going away opens no successor session.
 *
 * Production reloads produced two sessions a second apart on different runtime
 * instances. The outgoing instance minted a second session while its teardown
 * close was still in flight, sent `startSession` for it, then died before
 * `endSession`, so the server finalized it by empty session sweep minutes
 * later and an operator had to pick the real session by event count.
 */

function makeTransport() {
  return {
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendSessionEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

function setVisibility(value: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

function pageEvent(
  kind: "pagehide" | "pageshow",
  persisted: boolean,
): Event & { persisted?: boolean } {
  const event = new Event(kind) as Event & { persisted?: boolean };
  event.persisted = persisted;
  return event;
}

type BusEvent = { k?: string; d?: { label?: string } };

function batchEvents(call: unknown[]): BusEvent[] {
  return call[0] as BusEvent[];
}

function isAppSwitchMark(event: BusEvent): boolean {
  return event.k === "mark" && event.d?.label === "after app switch";
}

function startedIds(transport: ReturnType<typeof makeTransport>): string[] {
  return transport.startSession.mock.calls.map((call) => call[0] as string);
}

function endedIds(transport: ReturnType<typeof makeTransport>): string[] {
  return transport.endSession.mock.calls.map((call) => call[0] as string);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  sessionStorage.clear();
  setVisibility("visible");
});

afterEach(() => {
  setVisibility("visible");
  vi.restoreAllMocks();
});

describe("teardown opens no successor session", () => {
  it("starts and ends exactly one session across a reload", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport as never,
      flushIntervalMs: 100_000,
      sessionPersistence: "memory",
    });
    await settle();
    const visit = logger.getSessionId();
    logger.mark("work");

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(pageEvent("pagehide", false));
    // The tab is still the frontmost tab, so the replacing document's
    // visibility can be reported to the outgoing one before it is torn down.
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();

    expect(startedIds(transport)).toEqual([visit]);
    expect(endedIds(transport)).toEqual([visit]);
    await logger.stop();
  });

  it("opens no successor when a send outlives the teardown close", async () => {
    const transport = makeTransport();
    let release!: () => void;
    transport.sendEvents.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const logger = Crumbtrail.init({
      transportInstance: transport as never,
      flushIntervalMs: 100_000,
      sessionPersistence: "memory",
    });
    await settle();
    const visit = logger.getSessionId();
    logger.mark("work");

    window.dispatchEvent(pageEvent("pagehide", false));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    release();
    await settle();

    expect(startedIds(transport)).toEqual([visit]);
    expect(endedIds(transport)).toEqual([visit]);
    await logger.stop();
  });

  it("does not rotate into a successor after the teardown close", async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport();
      const logger = Crumbtrail.init({
        transportInstance: transport as never,
        flushIntervalMs: 100_000,
        sessionPersistence: "memory",
        maxSessionDurationMs: 300_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      const visit = logger.getSessionId();

      window.dispatchEvent(pageEvent("pagehide", false));
      await vi.advanceTimersByTimeAsync(0);
      // The rotation cadence itself is unchanged; a page that is going away
      // simply has no rotation timer left to fire.
      await vi.advanceTimersByTimeAsync(600_000);

      expect(startedIds(transport)).toEqual([visit]);
      expect(endedIds(transport)).toEqual([visit]);
      expect(logger.getSessionId()).toBe(visit);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still resumes after a back forward cache restore", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport as never,
      flushIntervalMs: 100_000,
      sessionPersistence: "memory",
    });
    await settle();
    const visit = logger.getSessionId();

    // A persisted pagehide keeps the visit open: the document is frozen, not
    // destroyed, so nothing about it is terminal.
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(pageEvent("pagehide", true));
    await settle();
    expect(endedIds(transport)).toEqual([]);
    expect(startedIds(transport)).toEqual([visit]);

    setVisibility("visible");
    window.dispatchEvent(pageEvent("pageshow", true));
    await settle();

    expect(startedIds(transport)).toEqual([visit]);
    logger.mark("after restore");
    await settle();
    expect(logger.getSessionId()).toBe(visit);
    await logger.stop();
    expect(endedIds(transport)).toEqual([visit]);
  });

  it("resumes when a persisted pageshow follows a nonpersisted pagehide", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport as never,
      flushIntervalMs: 100_000,
      sessionPersistence: "memory",
    });
    await settle();
    const visit = logger.getSessionId();

    // iOS Safari announces teardown with a nonpersisted pagehide on documents
    // that survive, then shows the same document again. A latch that never
    // cleared would leave the SDK dark for the rest of the visit.
    window.dispatchEvent(pageEvent("pagehide", false));
    await settle();
    expect(endedIds(transport)).toEqual([visit]);

    window.dispatchEvent(pageEvent("pageshow", true));
    await settle();
    logger.mark("after app switch");
    await settle();

    const resumed = logger.getSessionId();
    expect(resumed).not.toBe(visit);
    expect(startedIds(transport)).toEqual([visit, resumed]);
    await logger.stop();
    expect(endedIds(transport)).toEqual([visit, resumed]);

    // `sendEvents` carries no session id: the transport is bound to whichever
    // session is current, so the mark belongs to the resumed one exactly when
    // its batch leaves after that session started and does not go out on the
    // `sendSessionEvents` path, which is how a late event reaches the session
    // it was recorded under instead.
    const resumeOrder =
      transport.startSession.mock.invocationCallOrder[
        startedIds(transport).indexOf(resumed)
      ];
    const markBatchOrder = transport.sendEvents.mock.calls
      .map((call, index) => ({ events: batchEvents(call), index }))
      .filter(({ events }) => events.some(isAppSwitchMark))
      .map(({ index }) => transport.sendEvents.mock.invocationCallOrder[index]);
    expect(markBatchOrder).toHaveLength(1);
    expect(markBatchOrder[0]).toBeGreaterThan(resumeOrder);
    expect(
      transport.sendSessionEvents.mock.calls.some((call) =>
        (call[1] as BusEvent[]).some(isAppSwitchMark),
      ),
    ).toBe(false);
  });

  it("resumes when a nonpersisted pageshow follows a nonpersisted pagehide", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport as never,
      flushIntervalMs: 100_000,
      sessionPersistence: "memory",
    });
    await settle();
    const visit = logger.getSessionId();

    // WebKit restores a backgrounded document with `persisted` false, so the
    // flag cannot decide whether the page is alive. Being shown at all does.
    window.dispatchEvent(pageEvent("pagehide", false));
    await settle();
    window.dispatchEvent(pageEvent("pageshow", false));
    await settle();
    logger.mark("after app switch");
    await settle();

    const resumed = logger.getSessionId();
    expect(resumed).not.toBe(visit);
    expect(startedIds(transport)).toEqual([visit, resumed]);
    await logger.stop();
  });

  it("starts a fresh visit when a hidden page returns", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport as never,
      flushIntervalMs: 100_000,
      sessionPersistence: "memory",
    });
    await settle();
    const visit = logger.getSessionId();

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(endedIds(transport)).toEqual([visit]);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();

    const resumed = logger.getSessionId();
    expect(resumed).not.toBe(visit);
    expect(startedIds(transport)).toEqual([visit, resumed]);
    await logger.stop();
  });
});
