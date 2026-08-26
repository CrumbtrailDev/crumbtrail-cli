import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const QUIET = {
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
  storage: false,
  environment: false,
  domSnapshot: true,
  heartbeat: false,
  uiNumbers: false,
  listeners: false,
  eventSource: false,
  webSocket: false,
  workers: false,
  remoteConfig: false,
  flushIntervalMs: 100_000,
  flushBufferSize: 1_000,
} as const;

const realSetTimeout = setTimeout;

async function settle(debounceMs: number): Promise<void> {
  await new Promise((resolve) => realSetTimeout(resolve, 5));
  await vi.advanceTimersByTimeAsync(debounceMs);
  await new Promise((resolve) => realSetTimeout(resolve, 5));
}

describe("rendered error auto-flag", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("captures when an alert role enters the document", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: transport,
      autoFlagOnRenderedError: true,
      autoFlagDebounceMs: 100,
    });

    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.textContent = "Invalid postal code";
    document.body.append(alert);

    await settle(100);

    expect(transport.sendBugReport).toHaveBeenCalledTimes(1);
    const events = transport.sendBugReport.mock.calls[0][1];
    expect(events.some((event: any) => event.k === "ui.error")).toBe(true);
    expect(events.find((event: any) => event.k === "bug.flag")?.d.reason).toBe(
      "Auto captured after rendered error state appeared",
    );
    expect(
      events.find((event: any) => event.k === "dom.snap")?.d.html,
    ).toContain('role="alert"');

    await logger.stop();
  });

  it("captures when a control becomes aria-invalid", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: transport,
      autoFlagOnRenderedError: true,
      autoFlagDebounceMs: 100,
    });

    const input = document.createElement("input");
    document.body.append(input);
    input.setAttribute("aria-invalid", "true");

    await settle(100);

    expect(transport.sendBugReport).toHaveBeenCalledTimes(1);
    const event = transport.sendBugReport.mock.calls[0][1].find(
      (entry: any) => entry.k === "ui.error",
    );
    expect(event.d.kind).toBe("aria-invalid");

    await logger.stop();
  });

  it("does not capture an aria-invalid flip that clears in the same typing turn", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: transport,
      autoFlagOnRenderedError: true,
      autoFlagDebounceMs: 100,
    });

    const input = document.createElement("input");
    document.body.append(input);
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-invalid", "false");

    await settle(100);

    expect(transport.sendBugReport).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("shares the existing per-session auto-flag cap", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: transport,
      autoFlagOnRenderedError: true,
      autoFlagDebounceMs: 0,
      autoFlagMaxPerSession: 1,
    });

    const first = document.createElement("div");
    first.setAttribute("role", "alert");
    document.body.append(first);
    await settle(0);

    const second = document.createElement("div");
    second.setAttribute("role", "alert");
    document.body.append(second);
    await settle(0);

    expect(transport.sendBugReport).toHaveBeenCalledTimes(1);
    await logger.stop();
  });
});
