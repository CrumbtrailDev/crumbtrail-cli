import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, type BugEvent } from "../../types";
import { SSE_REOPEN_WINDOW_MS, eventSourceCollector } from "../eventsource";

/**
 * happy-dom has no EventSource, so a stub stands in for the host
 * implementation. The collector subclasses whatever is on the global, which is
 * exactly what it does in a browser.
 */
class StubEventSource extends EventTarget {
  static instances: StubEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  url: string;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    StubEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

describe("eventSourceCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;
  let originalEventSource: typeof globalThis.EventSource | undefined;

  function sse(): BugEvent[] {
    bus.flush();
    return events.filter((event) => event.k === "net.sse");
  }

  beforeEach(() => {
    originalEventSource = globalThis.EventSource;
    globalThis.EventSource =
      StubEventSource as unknown as typeof globalThis.EventSource;
    StubEventSource.instances = [];
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = eventSourceCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
    if (originalEventSource === undefined) {
      delete (globalThis as Partial<typeof globalThis>).EventSource;
    } else {
      globalThis.EventSource = originalEventSource;
    }
    vi.useRealTimers();
  });

  it("emits net.sse open when the stream opens", () => {
    const stream = new EventSource("/api/updates");
    stream.dispatchEvent(new Event("open"));

    expect(sse()).toHaveLength(1);
    expect(sse()[0].d).toEqual({ url: "/api/updates", op: "open" });
  });

  it("reports the message count on error", () => {
    const stream = new EventSource("/api/updates");
    stream.dispatchEvent(new Event("open"));
    stream.dispatchEvent(new Event("message"));
    stream.dispatchEvent(new Event("message"));
    stream.dispatchEvent(new Event("error"));

    const errorEvent = sse().find((event) => event.d.op === "error");
    expect(errorEvent?.d.count).toBe(2);
    expect(errorEvent?.d.url).toBe("/api/updates");
  });

  it("reports the message count when the app closes the stream", () => {
    const stream = new EventSource("/api/updates");
    stream.dispatchEvent(new Event("message"));
    stream.close();

    const closeEvent = sse().find((event) => event.d.op === "close");
    expect(closeEvent?.d.count).toBe(1);
    expect((StubEventSource.instances[0] as StubEventSource).closed).toBe(true);
  });

  it("marks a stream reopened after a recent failure", () => {
    const first = new EventSource("/api/updates");
    first.dispatchEvent(new Event("error"));

    const second = new EventSource("/api/updates");
    second.dispatchEvent(new Event("open"));

    const openEvent = sse().find((event) => event.d.op === "open");
    expect(openEvent?.d.reopen).toBe(true);
  });

  it("does not mark a reopen outside the reconnect window", () => {
    vi.useFakeTimers();
    const first = new EventSource("/api/updates");
    first.dispatchEvent(new Event("error"));

    vi.advanceTimersByTime(SSE_REOPEN_WINDOW_MS + 1_000);
    const second = new EventSource("/api/updates");
    second.dispatchEvent(new Event("open"));

    const openEvent = sse().find((event) => event.d.op === "open");
    expect(openEvent?.d.reopen).toBeUndefined();
  });

  it("does not mark a different URL as a reopen", () => {
    const first = new EventSource("/api/updates");
    first.dispatchEvent(new Event("error"));

    const second = new EventSource("/api/other");
    second.dispatchEvent(new Event("open"));

    const openEvent = sse().find((event) => event.d.op === "open");
    expect(openEvent?.d.reopen).toBeUndefined();
  });

  it("never captures message payloads", () => {
    const stream = new EventSource("/api/updates");
    const message = new Event("message") as Event & { data?: string };
    message.data = "account balance 12345";
    stream.dispatchEvent(message);
    stream.close();

    expect(JSON.stringify(sse())).not.toContain("12345");
  });

  it("leaves the app's own listeners working", () => {
    const stream = new EventSource("/api/updates");
    const seen: string[] = [];
    stream.addEventListener("message", () => seen.push("message"));
    stream.dispatchEvent(new Event("message"));

    expect(seen).toEqual(["message"]);
  });

  it("restores the native constructor on cleanup", () => {
    const patched = globalThis.EventSource;
    cleanup();

    expect(globalThis.EventSource).not.toBe(patched);
    expect(globalThis.EventSource).toBe(
      StubEventSource as unknown as typeof globalThis.EventSource,
    );
    cleanup = eventSourceCollector(bus, DEFAULT_CONFIG);
  });

  it("no-ops when the runtime has no EventSource", () => {
    cleanup();
    delete (globalThis as Partial<typeof globalThis>).EventSource;

    const localCleanup = eventSourceCollector(bus, DEFAULT_CONFIG);
    expect(globalThis.EventSource).toBeUndefined();
    localCleanup();

    globalThis.EventSource =
      StubEventSource as unknown as typeof globalThis.EventSource;
    cleanup = eventSourceCollector(bus, DEFAULT_CONFIG);
  });
});
