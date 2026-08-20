import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";

/**
 * Every transport an application talks over, exercised through `init()` rather than through the
 * collectors directly.
 *
 * The individual collectors have their own tests. What those cannot catch is a wiring fault: a
 * collector that is written, tested and documented but never registered, or registered under a
 * config key nothing turns on. That failure looks exactly like success from inside the collector's
 * own test file, and it is the one that costs a whole capture.
 *
 * The assertion here is deliberately shallow - the event kind reached the bus - because depth is
 * the per-collector tests' job. This file only answers "is it plugged in".
 */
describe("transport coverage through init()", () => {
  const sent: Array<{ k: string; d: Record<string, unknown> }> = [];
  let logger: Crumbtrail;
  let originalWebSocket: unknown;
  let originalWorker: unknown;

  class StubWebSocket extends EventTarget {
    constructor(public url: string | URL) {
      super();
    }
    send(): void {}
  }

  class StubWorker extends EventTarget {
    constructor(public script: string | URL) {
      super();
    }
    postMessage(): void {}
  }

  beforeEach(() => {
    sent.length = 0;
    originalWebSocket = globalThis.WebSocket;
    originalWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
    (globalThis as { Worker?: unknown }).Worker = StubWorker;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    logger = Crumbtrail.init({
      flushIntervalMs: 100_000,
      flushBufferSize: 100_000,
      transportInstance: {
        sendEvents: vi.fn().mockImplementation((events: unknown) => {
          for (const event of events as Array<{
            k: string;
            d: Record<string, unknown>;
          }>) {
            sent.push(event);
          }
          return Promise.resolve();
        }),
        sendBlob: vi.fn().mockResolvedValue(undefined),
        startSession: vi.fn().mockResolvedValue(undefined),
        endSession: vi.fn().mockResolvedValue(undefined),
        sendBugReport: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(async () => {
    await logger.stop();
    vi.restoreAllMocks();
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    (globalThis as { Worker?: unknown }).Worker = originalWorker;
  });

  async function kinds(): Promise<Set<string>> {
    await logger.stop();
    return new Set(sent.map((event) => event.k));
  }

  it("records a socket the application opened", async () => {
    const socket = new globalThis.WebSocket("wss://api.example.test/live");
    socket.dispatchEvent(new Event("open"));

    expect(await kinds()).toContain("net.ws");
  });

  it("records a worker the application started", async () => {
    new globalThis.Worker("/pricing.worker.js");

    expect(await kinds()).toContain("worker.msg");
  });

  it("records the GraphQL operation a request carried", async () => {
    await globalThis.fetch("https://api.example.test/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "mutation Pay { pay { id } }" }),
    });
    await logger.stop();

    const request = sent.find((event) => event.k === "net.req");
    expect(request?.d.gql).toMatchObject({ op: "mutation", name: "Pay" });
  });

  it("records a form submission sent as URLSearchParams", async () => {
    await globalThis.fetch("https://api.example.test/cart", {
      method: "POST",
      body: new URLSearchParams({ sku: "ABC", qty: "3" }),
    });
    await logger.stop();

    const request = sent.find((event) => event.k === "net.req");
    expect(String(request?.d.body)).toContain("qty=3");
  });
});
