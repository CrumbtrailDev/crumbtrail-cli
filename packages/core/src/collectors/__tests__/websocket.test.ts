import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, type BugEvent } from "../../types";
import {
  WS_MAX_FRAMES_PER_SOCKET,
  WS_REOPEN_WINDOW_MS,
  webSocketCollector,
} from "../websocket";

/**
 * happy-dom has no WebSocket, so a stub stands in for the host implementation. The collector
 * subclasses whatever is on the global, which is exactly what it does in a browser.
 */
class StubWebSocket extends EventTarget {
  static instances: StubWebSocket[] = [];
  url: string;
  sentRaw: unknown[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    StubWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sentRaw.push(data);
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

/**
 * happy-dom's `CloseEvent` drops the `code`/`wasClean` init, so the fields are set directly. A real
 * browser carries them on the event object exactly like this.
 */
function closeEvent(code: number, wasClean: boolean): Event {
  return Object.assign(new Event("close"), { code, wasClean });
}

describe("webSocketCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;
  let original: typeof globalThis.WebSocket | undefined;

  function ws(): Array<Record<string, unknown>> {
    bus.flush();
    return events
      .filter((event) => event.k === "net.ws")
      .map((event) => event.d as Record<string, unknown>);
  }

  function open(url = "wss://api.example.test/live"): StubWebSocket {
    const socket = new globalThis.WebSocket(url) as unknown as StubWebSocket;
    socket.dispatchEvent(new Event("open"));
    return socket;
  }

  beforeEach(() => {
    original = globalThis.WebSocket;
    globalThis.WebSocket =
      StubWebSocket as unknown as typeof globalThis.WebSocket;
    StubWebSocket.instances = [];
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = webSocketCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
    if (original === undefined) {
      delete (globalThis as Partial<typeof globalThis>).WebSocket;
    } else {
      globalThis.WebSocket = original;
    }
  });

  it("reports the lifecycle of a socket", () => {
    const socket = open();
    socket.dispatchEvent(closeEvent(1006, false));

    expect(ws()).toMatchObject([
      { op: "open", url: "wss://api.example.test/live" },
      { op: "close", code: 1006, clean: false, received: 0, sent: 0 },
    ]);
  });

  // The reason this collector quotes frames instead of counting them: an application's state
  // transitions arrive here, and a count of them answers no question anyone asks.
  it("carries the content of both directions", () => {
    const socket = open();
    socket.send(JSON.stringify({ op: "subscribe", room: "orders" }));
    socket.receive(JSON.stringify({ op: "priceChanged", cents: 1250 }));

    const frames = ws().filter((frame) => frame.op === "send" || frame.op === "msg");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ op: "send", seq: 1 });
    expect(String(frames[0].body)).toContain("subscribe");
    expect(frames[1]).toMatchObject({ op: "msg", seq: 1 });
    expect(String(frames[1].body)).toContain("1250");
  });

  it("passes the application through untouched", () => {
    const socket = open();
    socket.send("hello");

    expect(socket.sentRaw).toEqual(["hello"]);
  });

  // One policy across transports. A field the application denied on its HTTP bodies is not
  // published just because it arrived over a socket.
  it("redacts a frame under the same policy as a request body", () => {
    const socket = open();
    socket.receive(JSON.stringify({ token: "hunter2-should-not-appear" }));

    const frame = ws().find((entry) => entry.op === "msg");
    expect(String(frame?.body)).not.toContain("hunter2-should-not-appear");
  });

  // A chatty socket is a normal thing and must not be able to fill a session with itself. Counting
  // continues past the cap so the tail of a long conversation still reports its shape.
  it("stops quoting past the per-socket cap but keeps counting", () => {
    const socket = open();
    for (let i = 0; i < WS_MAX_FRAMES_PER_SOCKET + 5; i += 1) {
      socket.receive(JSON.stringify({ i }));
    }
    socket.dispatchEvent(closeEvent(1000, true));

    const frames = ws().filter((entry) => entry.op === "msg");
    expect(frames).toHaveLength(WS_MAX_FRAMES_PER_SOCKET);
    expect(ws().at(-1)).toMatchObject({
      op: "close",
      received: WS_MAX_FRAMES_PER_SOCKET + 5,
    });
  });

  // Decoding a binary frame means guessing an encoding, and a wrong guess publishes bytes nobody
  // reviewed. Shape only.
  it("reports a binary frame by shape and never by content", () => {
    const socket = open();
    socket.receive(new Uint8Array([1, 2, 3, 4]));

    const frame = ws().find((entry) => entry.op === "msg");
    expect(frame).toMatchObject({ binary: true, bytes: 4 });
    expect(frame?.body).toBeUndefined();
  });

  it("marks a fresh socket to the same url as a reconnect", () => {
    const first = open();
    first.dispatchEvent(closeEvent(1006, false));
    open();

    expect(ws().filter((entry) => entry.op === "open").at(-1)).toMatchObject({
      reopen: true,
    });
  });

  it("does not call an unrelated url a reconnect", () => {
    const first = open();
    first.dispatchEvent(closeEvent(1006, false));
    open("wss://api.example.test/other");

    expect(ws().filter((entry) => entry.op === "open").at(-1)?.reopen).toBeUndefined();
  });

  it("restores the host constructor on cleanup", () => {
    cleanup();
    expect(globalThis.WebSocket).toBe(
      StubWebSocket as unknown as typeof globalThis.WebSocket,
    );
  });

  it("keeps the reopen window a bounded claim", () => {
    expect(WS_REOPEN_WINDOW_MS).toBeGreaterThan(0);
  });
});
