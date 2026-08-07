import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, type BugEvent } from "../../types";
import { WORKER_MAX_MESSAGES, workerCollector } from "../worker";

/**
 * happy-dom's Worker does not run a script, so a stub stands in for the host implementation. The
 * collector subclasses whatever is on the global, which is exactly what it does in a browser.
 */
class StubWorker extends EventTarget {
  script: string;
  postedRaw: unknown[] = [];

  constructor(scriptURL: string | URL) {
    super();
    this.script = String(scriptURL);
  }

  postMessage(data: unknown): void {
    this.postedRaw.push(data);
  }

  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("workerCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;
  let original: unknown;

  function msgs(): Array<Record<string, unknown>> {
    bus.flush();
    return events
      .filter((event) => event.k === "worker.msg")
      .map((event) => event.d as Record<string, unknown>);
  }

  function spawn(script = "/pricing.worker.js"): StubWorker {
    return new globalThis.Worker(script) as unknown as StubWorker;
  }

  beforeEach(() => {
    original = globalThis.Worker;
    (globalThis as { Worker?: unknown }).Worker = StubWorker;
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = workerCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
    (globalThis as { Worker?: unknown }).Worker = original;
  });

  it("records that a worker was started and which script it ran", () => {
    spawn();

    expect(msgs()).toMatchObject([{ op: "start", script: "/pricing.worker.js" }]);
  });

  // The worker's own protocol names the inputs and outputs of a computation this SDK cannot see
  // from the inside.
  it("carries messages in both directions", () => {
    const worker = spawn();
    worker.postMessage({ op: "price", lines: 3 });
    worker.reply({ op: "priced", totalCents: 1250 });

    const conversation = msgs().filter((entry) => entry.op !== "start");
    expect(conversation).toHaveLength(2);
    expect(String(conversation[0].body)).toContain("price");
    expect(String(conversation[1].body)).toContain("1250");
  });

  it("passes the application through untouched", () => {
    const worker = spawn();
    worker.postMessage({ op: "price" });

    expect(worker.postedRaw).toEqual([{ op: "price" }]);
  });

  it("redacts a message under the same policy as a request body", () => {
    const worker = spawn();
    worker.reply({ token: "hunter2-should-not-appear" });

    const entry = msgs().find((item) => item.op === "recv");
    expect(String(entry?.body)).not.toContain("hunter2-should-not-appear");
  });

  // A worker error reaches no handler on the page, so without this the failure leaves no trace.
  it("reports an error the page would never have seen", () => {
    const worker = spawn();
    worker.dispatchEvent(
      Object.assign(new Event("error"), { message: "pricing table missing" }),
    );

    expect(msgs().at(-1)).toMatchObject({
      op: "error",
      msg: "pricing table missing",
    });
  });

  it("stops quoting past the cap", () => {
    const worker = spawn();
    for (let i = 0; i < WORKER_MAX_MESSAGES + 5; i += 1) worker.reply({ i });

    expect(msgs().filter((entry) => entry.op === "recv")).toHaveLength(
      WORKER_MAX_MESSAGES,
    );
  });

  // Reporting a transferred buffer as `{}` would be a fabrication, not a summary.
  it("calls an opaque payload opaque instead of inventing content for it", () => {
    const worker = spawn();
    worker.postMessage(new ArrayBuffer(8));

    const entry = msgs().find((item) => item.op === "post");
    expect(entry).toMatchObject({ opaque: true });
    expect(entry?.body).toBeUndefined();
  });

  it("restores the host constructor on cleanup", () => {
    cleanup();
    expect(globalThis.Worker).toBe(StubWorker as unknown);
  });
});
