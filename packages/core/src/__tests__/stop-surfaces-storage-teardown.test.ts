import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";

function makeTransport(order: string[]) {
  return {
    sendEvents: vi.fn(async () => {
      order.push("events");
    }),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(async () => {
      order.push("endSession");
    }),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

describe("public stop() storage teardown failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects after all cleanup, evidence delivery, and session end work runs", async () => {
    const order: string[] = [];
    const transport = makeTransport(order);
    const cacheStorage = {
      open: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve(false)),
      has: vi.fn(() => Promise.resolve(false)),
      match: vi.fn(() => Promise.resolve(undefined)),
      keys: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("caches", cacheStorage);

    const logger = Crumbtrail.init({
      transportInstance: transport,
      console: false,
      network: false,
      interactions: false,
      keystrokes: false,
      scroll: false,
      visibility: false,
      clipboard: false,
      errors: false,
      performance: false,
      cookies: false,
      storage: true,
      environment: false,
      domSnapshot: false,
      heartbeat: false,
      uiNumbers: false,
      listeners: false,
      eventSource: false,
      webSocket: false,
      workers: false,
      captureIdb: false,
      captureCacheApi: true,
      autoFlagOnStorageFailure: true,
      remoteConfig: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const wrappedOpen = cacheStorage.open;
    const wrappedDelete = cacheStorage.delete;
    Object.defineProperty(cacheStorage, "open", {
      configurable: false,
      value: wrappedOpen,
      writable: false,
    });
    Object.defineProperty(cacheStorage, "delete", {
      configurable: false,
      value: wrappedDelete,
      writable: false,
    });

    const firstStop = logger.stop();
    const secondStop = logger.stop();
    let failure: unknown;
    await expect(firstStop).rejects.toMatchObject({
      message: "Crumbtrail.stop() completed with teardown failures",
    });
    await expect(secondStop).rejects.toMatchObject({
      message: "Crumbtrail.stop() completed with teardown failures",
    });
    try {
      await firstStop;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual(["collector:storage[0][0][0]", "collector:storage[0][0][1]"]);
    expect(order.indexOf("events")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("endSession")).toBeGreaterThan(
      order.indexOf("events"),
    );
    expect(transport.endSession).toHaveBeenCalledTimes(1);
  });
});
