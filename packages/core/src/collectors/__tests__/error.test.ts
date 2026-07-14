import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, type BugEvent } from "../../types";
import { errorCollector } from "../error";

// Polyfill PromiseRejectionEvent for happy-dom
if (typeof PromiseRejectionEvent === "undefined") {
  (globalThis as unknown as Record<string, unknown>).PromiseRejectionEvent =
    class PromiseRejectionEvent extends Event {
      reason: unknown;
      promise: Promise<unknown>;
      constructor(
        type: string,
        init: { reason: unknown; promise: Promise<unknown> },
      ) {
        super(type, { bubbles: true, cancelable: true });
        this.reason = init.reason;
        this.promise = init.promise;
      }
    };
}

describe("errorCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = errorCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
  });

  it("captures window error events", () => {
    const errorEvent = new ErrorEvent("error", {
      message: "test error",
      filename: "test.js",
      lineno: 42,
      colno: 10,
      error: new Error("test error"),
    });
    window.dispatchEvent(errorEvent);
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("err");
    expect(events[0].d.msg).toBe("test error");
    expect(events[0].d.file).toBe("test.js");
    expect(events[0].d.line).toBe(42);
    expect(events[0].d.col).toBe(10);
    expect(events[0].d.stk).toBeDefined();
  });

  it("redacts sensitive window error details by default", () => {
    const error = new Error("password=hunter2");
    error.stack =
      "Error: token=sk_fake_abcdefghijklmnopqrstuvwxyz\n  at Login (app.ts:1)";
    const errorEvent = new ErrorEvent("error", {
      message: "password=hunter2",
      filename: "https://app.example.test/reset?token=abc123",
      lineno: 42,
      colno: 10,
      error,
    });
    window.dispatchEvent(errorEvent);
    bus.flush();

    expect(events[0].d.msg).toContain("[REDACTED]");
    expect(events[0].d.msg).not.toContain("hunter2");
    expect(events[0].d.file).toBe(
      "https://app.example.test/reset?token=%5BREDACTED%5D",
    );
    expect(events[0].d.stk).not.toContain("sk_fake_abcdefghijklmnopqrstuvwxyz");
    expect(events[0].d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
    });
  });

  it("does not rest raw malformed JSON-like sensitive error strings by default", () => {
    window.dispatchEvent(
      new ErrorEvent("error", { message: '{"password":"hunter2",}' }),
    );
    bus.flush();

    expect(events[0].d.msg).toBe("[dropped:malformed_json_body]");
    expect(events[0].d.msg).not.toContain("hunter2");
    expect(events[0].d.msg).not.toContain("password");
    expect(events[0].d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
    });
  });

  it("captures raw error details only when explicitly opted in", () => {
    cleanup();
    cleanup = errorCollector(bus, {
      ...DEFAULT_CONFIG,
      captureRawErrors: true,
    });

    window.dispatchEvent(
      new ErrorEvent("error", { message: "password=hunter2" }),
    );
    bus.flush();

    expect(events[0].d.msg).toBe("password=hunter2");
    expect(events[0].d.redaction).toBeUndefined();
  });

  it("captures unhandled promise rejections with Error reason", () => {
    const event = new PromiseRejectionEvent("unhandledrejection", {
      reason: new Error("rejected"),
      promise: Promise.resolve(),
    });
    window.dispatchEvent(event);
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("rej");
    expect(events[0].d.msg).toBe("rejected");
    expect(events[0].d.stk).toBeDefined();
  });

  it("captures unhandled promise rejections with string reason", () => {
    const event = new PromiseRejectionEvent("unhandledrejection", {
      reason: "string rejection",
      promise: Promise.resolve(),
    });
    window.dispatchEvent(event);
    bus.flush();

    expect(events[0].d.msg).toBe("string rejection");
    expect(events[0].d.stk).toBeUndefined();
  });

  it("stops capturing after cleanup", () => {
    cleanup();
    window.dispatchEvent(new ErrorEvent("error", { message: "after cleanup" }));
    bus.flush();
    expect(events).toHaveLength(0);
    cleanup = errorCollector(bus, DEFAULT_CONFIG);
  });
});
