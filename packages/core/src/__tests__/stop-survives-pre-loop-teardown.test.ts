import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import type { BugEvent } from "../types";

/**
 * Three teardown calls run BEFORE the collector cleanup loop in `stop()`:
 * `widgetCleanup()`, `autoFlagCleanup?.()` and `stopConfigPolling()`. Guarding
 * the loop left them unguarded, so a throw there still skipped everything below
 * it — both flushes, the `stopped` flag, `abortFlightRecorder()`, `bus.stop()`
 * and the end-of-session call — and stranded a pending `flag()` tail promise
 * exactly as an unguarded loop did.
 *
 * `widgetCleanup` is the realistic thrower of the three: it is DOM teardown
 * against nodes the host page owns and is free to have moved or removed. These
 * tests mount a widget whose cleanup throws and check the rest of shutdown still
 * happens.
 */

const widgetCleanup = vi.fn(() => {
  throw new Error("widget teardown blew up");
});

vi.mock("../widget/bug-widget", () => ({
  mountWidget: () => widgetCleanup,
}));

function makeTransport() {
  const sent: BugEvent[] = [];
  return {
    sent,
    transport: {
      sendEvents: vi.fn(async (events: BugEvent[]) => {
        sent.push(...events);
      }),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/**
 * The widget mounts through a dynamic import, so `widgetCleanup` is assigned a
 * microtask or two after `init()` returns. Nothing here is worth testing until
 * it is: without the wait the throwing cleanup is simply never installed.
 */
async function initWithThrowingWidget(
  transport: ReturnType<typeof makeTransport>,
  extra: Record<string, unknown> = {},
) {
  const logger = Crumbtrail.init({
    transportInstance: transport.transport,
    widget: true,
    environment: false,
    domSnapshot: false,
    flushIntervalMs: 100_000,
    flushBufferSize: 1_000,
    ...extra,
  } as any);
  for (let tick = 0; tick < 50; tick += 1) {
    if (typeof (logger as any).widgetCleanup === "function") break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect((logger as any).widgetCleanup).toBeTypeOf("function");
  return logger;
}

describe("stop() survives a throw from the teardown ahead of the cleanup loop", () => {
  beforeEach(() => {
    widgetCleanup.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves rather than rejecting", async () => {
    const transport = makeTransport();
    const logger = await initWithThrowingWidget(transport);

    await expect(logger.stop()).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(widgetCleanup).toHaveBeenCalledTimes(1);
  });

  it("still settles a pending flag() tail promise", async () => {
    // This is the one that hurts: `abortFlightRecorder()` is what settles the
    // tail, and it sits below the throw. Unguarded, the caller awaiting flag()
    // waits forever.
    const transport = makeTransport();
    const logger = await initWithThrowingWidget(transport, {
      flightRecorder: true,
      flightRecorderTailMs: 10_000,
    });

    const pending = logger.flag();
    await logger.stop();

    await expect(pending).resolves.toMatchObject({ bugId: expect.any(String) });
  });

  it("still finalizes the session", async () => {
    const transport = makeTransport();
    const logger = await initWithThrowingWidget(transport);

    await logger.stop();

    // `endSession` is the last thing stop() does, so reaching it means the
    // collector loop, both flushes, the flag and the bus stop all ran too.
    expect(transport.transport.endSession).toHaveBeenCalledTimes(1);
  });

  it("empties the collector cleanup list once every cleanup has run", async () => {
    const transport = makeTransport();
    const logger = await initWithThrowingWidget(transport, {
      performance: true,
      interaction: true,
    });

    expect((logger as any).cleanups.length).toBeGreaterThan(0);
    await logger.stop();

    // Retained garbage otherwise: each entry is a closure over collector state
    // the teardown has already released.
    expect((logger as any).cleanups).toEqual([]);
  });
});
