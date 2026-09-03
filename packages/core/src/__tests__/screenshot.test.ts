import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Crumbtrail,
  PAGEHIDE_PENDING_SEND_TIMEOUT_MS,
} from "../crumbtrail";
import {
  REPORT_SCREENSHOT_MAX_BYTES,
  REPORT_SCREENSHOT_MAX_EDGE,
} from "../index";

function png(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function imageBlob(bytes: Uint8Array, type = "image/png"): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer as ArrayBuffer], { type });
}

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

function init(transport: ReturnType<typeof makeTransport>) {
  return Crumbtrail.init({
    transportInstance: transport,
    console: false,
    network: false,
    interactions: false,
    errors: false,
    performance: false,
    environment: false,
    domSnapshot: false,
    flushIntervalMs: 100_000,
    flushBufferSize: 100_000,
    reportScreenshotsEnabled: true,
  });
}

describe("report screenshot API", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads a generated PNG name through the active transport", async () => {
    const transport = makeTransport();
    const logger = init(transport);
    const blob = imageBlob(png());

    const result = await logger.captureScreenshot(blob);

    expect(result.artifactName).toMatch(
      /^report-screenshot-[0-9a-f]{32}\.png$/,
    );
    expect(transport.sendBlob).toHaveBeenCalledWith(
      result.artifactName,
      blob,
      undefined,
      expect.any(String),
    );
    await logger.stop();
  });

  it("waits for settled session admission before uploading", async () => {
    const order: string[] = [];
    const transport = makeTransport();
    transport.startSession.mockImplementationOnce(async () => {
      order.push("start");
      await Promise.resolve();
      order.push("start-done");
    });
    transport.sendBlob.mockImplementationOnce(async () => {
      order.push("blob");
    });
    const logger = init(transport);

    await logger.captureScreenshot(imageBlob(png()));

    expect(order).toEqual(["start", "start-done", "blob"]);
    await logger.stop();
  });

  it("stays disabled until the project policy enables report screenshots", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...initConfig(),
      transportInstance: transport,
    });

    await expect(logger.captureScreenshot(imageBlob(png()))).rejects.toThrow(
      "not enabled",
    );
    expect(transport.sendBlob).not.toHaveBeenCalled();

    (
      logger as unknown as {
        applyRemoteConfig: (settings: Record<string, unknown>) => void;
      }
    ).applyRemoteConfig({ reportScreenshotsEnabled: true });
    await expect(logger.captureScreenshot(imageBlob(png()))).resolves.toEqual(
      expect.objectContaining({ artifactName: expect.any(String) }),
    );
    await logger.stop();
  });

  it("rejects locally when session admission fails before uploading", async () => {
    const transport = makeTransport();
    transport.startSession.mockRejectedValueOnce(new Error("session refused"));
    const logger = init(transport);

    await expect(logger.captureScreenshot(imageBlob(png()))).rejects.toThrow(
      "active session",
    );
    expect(transport.sendBlob).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("rejects when there is no active session or after stop", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...initConfig(),
      transportInstance: transport,
      flightRecorder: true,
      baselineSampleRate: 0,
    });
    const blob = imageBlob(png());

    await expect(logger.captureScreenshot(blob)).rejects.toThrow(
      "active session",
    );
    await logger.stop();
    await expect(logger.captureScreenshot(blob)).rejects.toThrow(
      "active session",
    );
  });

  it("rejects non PNG Blob MIME types before transport", async () => {
    const transport = makeTransport();
    const logger = init(transport);

    await expect(
      logger.captureScreenshot(imageBlob(png(), "image/jpeg")),
    ).rejects.toThrow("image/png");
    expect(transport.sendBlob).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("rejects falsely typed PNG bytes before transport", async () => {
    const transport = makeTransport();
    const logger = init(transport);

    await expect(
      logger.captureScreenshot(imageBlob(new Uint8Array([1, 2, 3]))),
    ).rejects.toThrow("valid PNG bytes");
    expect(transport.sendBlob).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("rejects a Blob over the five MiB limit", async () => {
    const transport = makeTransport();
    const logger = init(transport);
    const bytes = new Uint8Array(REPORT_SCREENSHOT_MAX_BYTES + 1);

    await expect(logger.captureScreenshot(imageBlob(bytes))).rejects.toThrow(
      "bytes",
    );
    expect(transport.sendBlob).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("rejects a PNG wider than the edge limit", async () => {
    const transport = makeTransport();
    const logger = init(transport);

    await expect(
      logger.captureScreenshot(
        imageBlob(png(REPORT_SCREENSHOT_MAX_EDGE + 1, 1)),
      ),
    ).rejects.toThrow("4096");
    expect(transport.sendBlob).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("encodes an application canvas as PNG without requesting display media", async () => {
    const transport = makeTransport();
    const logger = init(transport);
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 20;
    const blob = imageBlob(png(40, 20));
    const toBlob = vi.fn((callback: BlobCallback) => callback(blob));
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: toBlob,
    });

    const result = await logger.captureScreenshot(canvas);

    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(transport.sendBlob).toHaveBeenCalledWith(
      result.artifactName,
      blob,
      undefined,
      expect.any(String),
    );
    expect(
      (globalThis as { getDisplayMedia?: unknown }).getDisplayMedia,
    ).toBeUndefined();
    await logger.stop();
  });

  it("rejects an oversized canvas before encoding", async () => {
    const transport = makeTransport();
    const logger = init(transport);
    const canvas = document.createElement("canvas");
    canvas.width = REPORT_SCREENSHOT_MAX_EDGE + 1;
    canvas.height = 1;
    const toBlob = vi.fn();
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: toBlob,
    });

    await expect(logger.captureScreenshot(canvas)).rejects.toThrow("4096");
    expect(toBlob).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("associates only an artifact successfully returned by captureScreenshot", async () => {
    const transport = makeTransport();
    const logger = init(transport);
    const blob = imageBlob(png());
    const { artifactName } = await logger.captureScreenshot(blob);

    await logger.flagBug({ visualArtifactName: artifactName });
    const reportEvents = transport.sendBugReport.mock.calls[0][1] as Array<{
      k: string;
      d: Record<string, unknown>;
    }>;
    expect(
      reportEvents.find((event) => event.k === "bug.flag")?.d,
    ).toMatchObject({
      visualArtifactName: artifactName,
    });

    await logger.flagBug({
      visualArtifactName:
        "report-screenshot-0123456789abcdef0123456789abcdef.png",
    });
    const secondEvents = transport.sendBugReport.mock.calls[1][1] as Array<{
      k: string;
      d: Record<string, unknown>;
    }>;
    const secondFlag = secondEvents
      .filter((event) => event.k === "bug.flag")
      .at(-1);
    expect("visualArtifactName" in (secondFlag?.d ?? {})).toBe(false);
    await logger.stop();
  });

  it("does not associate an artifact when its upload fails", async () => {
    const transport = makeTransport();
    transport.sendBlob.mockRejectedValueOnce(new Error("upload failed"));
    const logger = init(transport);
    const blob = imageBlob(png());

    await expect(logger.captureScreenshot(blob)).rejects.toThrow(
      "upload failed",
    );
    const attemptedName = transport.sendBlob.mock.calls[0][0] as string;
    await logger.flagBug({ visualArtifactName: attemptedName });
    const events = transport.sendBugReport.mock.calls[0][1] as Array<{
      k: string;
      d: Record<string, unknown>;
    }>;
    expect(
      "visualArtifactName" in
        (events.find((event) => event.k === "bug.flag")?.d ?? {}),
    ).toBe(false);
    await logger.stop();
  });

  it("does not associate an old upload when lifecycle rollover happens", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    let finishUpload!: () => void;
    const uploadFinished = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    transport.sendBlob.mockImplementationOnce(async () => uploadFinished);
    const logger = init(transport);
    const oldSessionId = logger.getSessionId();
    const capture = logger.captureScreenshot(imageBlob(png()));

    // Let the session admission, PNG validation, and transport invocation reach the pending
    // upload without resolving it.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(transport.sendBlob).toHaveBeenCalledOnce();
    const oldArtifactName = transport.sendBlob.mock.calls[0][0] as string;
    expect(transport.sendBlob.mock.calls[0][3]).toBe(oldSessionId);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.endSession).not.toHaveBeenCalled();
    await logger.flagBug({ visualArtifactName: oldArtifactName });
    expect(transport.sendBugReport).not.toHaveBeenCalled();
    const lifecycleClose = (
      logger as unknown as {
        lifecycleClosePromise?: Promise<void>;
      }
    ).lifecycleClosePromise;
    expect(lifecycleClose).toBeDefined();

    finishUpload();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await expect(capture).rejects.toThrow("active session");
    await lifecycleClose;

    // The lifecycle close waited for the pending upload. Visibility then starts a fresh session,
    // and the old name must not become eligible in that new session.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.getSessionId()).not.toBe(oldSessionId);

    await logger.flagBug({ visualArtifactName: oldArtifactName });
    const events = transport.sendBugReport.mock.calls.at(-1)?.[1] as Array<{
      k: string;
      d: Record<string, unknown>;
    }>;
    expect(
      "visualArtifactName" in
        (events.find((event) => event.k === "bug.flag")?.d ?? {}),
    ).toBe(false);
    await logger.stop();
    vi.useRealTimers();
  });

  it("orders a nonpersisted pagehide after a completed screenshot upload", async () => {
    const order: string[] = [];
    const transport = makeTransport();
    let finishUpload!: () => void;
    const uploadFinished = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    transport.sendBlob.mockImplementationOnce(async () => {
      order.push("blob-start");
      await uploadFinished;
      order.push("blob-done");
    });
    transport.endSession.mockImplementationOnce(async () => {
      order.push("endSession");
    });
    const logger = init(transport);
    const capture = logger.captureScreenshot(imageBlob(png()));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(["blob-start"]);

    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(order).toEqual(["blob-start"]);

    finishUpload();
    await expect(capture).rejects.toThrow("active session");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(["blob-start", "blob-done", "endSession"]);
    await logger.stop();
  });

  it("ends after a pagehide upload fails", async () => {
    const order: string[] = [];
    const transport = makeTransport();
    transport.sendBlob.mockImplementationOnce(async () => {
      order.push("blob-start");
      order.push("blob-done");
      throw new Error("upload failed");
    });
    transport.endSession.mockImplementationOnce(async () => {
      order.push("endSession");
    });
    const logger = init(transport);
    const capture = logger.captureScreenshot(imageBlob(png()));
    await expect(capture).rejects.toThrow("upload failed");

    window.dispatchEvent(new Event("pagehide"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(["blob-start", "blob-done", "endSession"]);
    await logger.stop();
  });

  it("bounds a never settling pagehide upload without sending session end", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    transport.sendBlob.mockImplementationOnce(async () => {
      await new Promise<void>(() => {});
    });
    const logger = init(transport);
    const capture = logger.captureScreenshot(imageBlob(png()));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(transport.sendBlob).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(PAGEHIDE_PENDING_SEND_TIMEOUT_MS);
    expect(transport.endSession).not.toHaveBeenCalled();
    await expect(logger.captureScreenshot(imageBlob(png()))).rejects.toThrow(
      "active session",
    );
    // The timed out pending send is removed from shutdown tracking, so stop remains bounded too.
    await expect(logger.stop()).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(transport.endSession).not.toHaveBeenCalled();
    void capture.catch(() => {});
    vi.useRealTimers();
  });

  it("bounds pagehide while session admission never settles", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    transport.startSession.mockImplementationOnce(
      async () => new Promise<void>(() => {}),
    );
    const logger = init(transport);

    window.dispatchEvent(new Event("pagehide"));
    const lifecycleClose = (
      logger as unknown as { lifecycleClosePromise?: Promise<void> }
    ).lifecycleClosePromise;
    expect(lifecycleClose).toBeDefined();

    await vi.advanceTimersByTimeAsync(PAGEHIDE_PENDING_SEND_TIMEOUT_MS);
    await expect(lifecycleClose).resolves.toBeUndefined();
    expect(transport.endSession).not.toHaveBeenCalled();
    await expect(logger.captureScreenshot(imageBlob(png()))).rejects.toThrow(
      "active session",
    );
    vi.useRealTimers();
    await logger.stop();
  });

  it("uses one pagehide deadline for admission and a pending send", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    let finishStart!: () => void;
    const sessionStarted = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    transport.startSession.mockImplementationOnce(() => sessionStarted);
    transport.sendEvents.mockImplementationOnce(
      async () => new Promise<void>(() => {}),
    );
    const logger = init(transport);
    const flag = logger.flag();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(transport.sendEvents).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("pagehide"));
    const lifecycleClose = (
      logger as unknown as { lifecycleClosePromise?: Promise<void> }
    ).lifecycleClosePromise;
    expect(lifecycleClose).toBeDefined();

    await vi.advanceTimersByTimeAsync(PAGEHIDE_PENDING_SEND_TIMEOUT_MS - 1);
    finishStart();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1);
    await expect(lifecycleClose).resolves.toBeUndefined();
    expect(transport.endSession).not.toHaveBeenCalled();
    await expect(flag).resolves.toMatchObject({ bugId: expect.any(String) });
    vi.useRealTimers();
    await logger.stop();
  });

  it("bounds explicit stop while session admission never settles", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    transport.startSession.mockImplementationOnce(
      async () => new Promise<void>(() => {}),
    );
    const logger = init(transport);

    const stopping = logger.stop();
    await vi.advanceTimersByTimeAsync(PAGEHIDE_PENDING_SEND_TIMEOUT_MS);

    await expect(stopping).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(transport.endSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("bounds explicit stop while a screenshot upload never settles", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    transport.sendBlob.mockImplementationOnce(
      async () => new Promise<void>(() => {}),
    );
    const logger = init(transport);
    const capture = logger.captureScreenshot(imageBlob(png()));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(transport.sendBlob).toHaveBeenCalledOnce();

    const stopping = logger.stop();
    await vi.advanceTimersByTimeAsync(PAGEHIDE_PENDING_SEND_TIMEOUT_MS);

    await expect(stopping).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(transport.endSession).not.toHaveBeenCalled();
    void capture.catch(() => {});
    vi.useRealTimers();
  });

  it("waits for a hidden pending upload when stop races its lifecycle timer", async () => {
    const order: string[] = [];
    const transport = makeTransport();
    let finishUpload!: () => void;
    const uploadFinished = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    transport.sendBlob.mockImplementationOnce(async () => {
      order.push("blob-start");
      await uploadFinished;
      order.push("blob-done");
    });
    transport.endSession.mockImplementationOnce(async () => {
      order.push("endSession");
    });
    const logger = init(transport);
    const capture = logger.captureScreenshot(imageBlob(png()));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(["blob-start"]);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const stopping = logger.stop();
    expect(order).toEqual(["blob-start"]);

    finishUpload();
    await expect(capture).resolves.toMatchObject({
      artifactName: expect.stringMatching(/\.png$/),
    });
    await expect(stopping).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(order).toEqual(["blob-start", "blob-done", "endSession"]);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });
});

function initConfig() {
  return {
    console: false,
    network: false,
    interactions: false,
    errors: false,
    performance: false,
    environment: false,
    domSnapshot: false,
    flushIntervalMs: 100_000,
    flushBufferSize: 100_000,
  };
}
