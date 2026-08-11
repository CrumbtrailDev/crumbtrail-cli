import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ORIGIN_FRAMES,
  MAX_ORIGIN_FRAME_LENGTH,
  captureCodeOrigin,
} from "../code-origin";
import { EventBus } from "../event-bus";
import { networkCollector } from "../collectors/network";
import { installEarlyCapture, uninstallEarlyCapture } from "../early-capture";
import { DEFAULT_CONFIG, type BugEvent, type CrumbtrailConfig } from "../types";

/**
 * Replaces the global `Error` with one whose `stack` is a fixture, so a frame
 * shape this engine would never produce can still be exercised. Everything
 * else about `Error` is left alone.
 */
function withStack<T>(stack: string | undefined, run: () => T): T {
  const RealError = globalThis.Error;
  class StubError extends RealError {
    constructor(...args: ConstructorParameters<typeof RealError>) {
      super(...args);
      Object.defineProperty(this, "stack", { value: stack, configurable: true });
    }
  }
  globalThis.Error = StubError as unknown as ErrorConstructor;
  try {
    return run();
  } finally {
    globalThis.Error = RealError;
  }
}

const APP_STACK = [
  "Error",
  "    at captureCodeOrigin (http://localhost:5637/@fs/sdk/code-origin.js:80:19)",
  "    at earlyFetch (http://localhost:5637/@fs/sdk/early-capture.js:390:22)",
  "    at saveAddress (http://localhost:5637/src/pages/Account.jsx:118:11)",
  "    at onSubmit (http://localhost:5637/src/pages/Account.jsx:142:5)",
].join("\n");

describe("captureCodeOrigin", () => {
  it("returns the app frames above the caller, innermost first", () => {
    const frames = withStack(APP_STACK, () => captureCodeOrigin(1));
    expect(frames).toEqual([
      "http://localhost:5637/src/pages/Account.jsx:118:11",
      "http://localhost:5637/src/pages/Account.jsx:142:5",
    ]);
  });

  it("counts skipped frames rather than matching names, so minification cannot break it", () => {
    const frames = withStack(APP_STACK, () => captureCodeOrigin(0));
    // One fewer frame skipped: the wrapper itself is now reported.
    expect(frames?.[0]).toBe(
      "http://localhost:5637/@fs/sdk/early-capture.js:390:22",
    );
  });

  it("drops vendor frames a reader cannot fix", () => {
    const stack = [
      "Error",
      "    at captureCodeOrigin (http://x/sdk.js:1:1)",
      "    at wrapper (http://x/sdk.js:2:2)",
      "    at fetchJson (http://x/node_modules/axios/index.js:900:12)",
      "    at useQuery (http://x/node_modules/.vite/deps/react-query.js:44:9)",
      "    at Search (http://x/src/pages/Search.jsx:61:7)",
    ].join("\n");
    expect(withStack(stack, () => captureCodeOrigin(1))).toEqual([
      "http://x/src/pages/Search.jsx:61:7",
    ]);
  });

  it("refuses a frame with no line number", () => {
    const stack = [
      "Error",
      "    at captureCodeOrigin (http://x/sdk.js:1:1)",
      "    at wrapper (http://x/sdk.js:2:2)",
      "    at bootstrap (http://x/src/main.jsx)",
      "    at native code",
    ].join("\n");
    expect(withStack(stack, () => captureCodeOrigin(1))).toBeUndefined();
  });

  it("caps the frames it keeps", () => {
    const stack = [
      "Error",
      "    at captureCodeOrigin (http://x/sdk.js:1:1)",
      ...Array.from(
        { length: MAX_ORIGIN_FRAMES + 5 },
        (_, i) => `    at f${i} (http://x/src/f${i}.js:${i + 1}:1)`,
      ),
    ].join("\n");
    expect(withStack(stack, () => captureCodeOrigin(0))).toHaveLength(
      MAX_ORIGIN_FRAMES,
    );
  });

  it("drops an over-long frame rather than truncating it into a wrong location", () => {
    const long = `http://x/${"a".repeat(MAX_ORIGIN_FRAME_LENGTH)}.js:4:2`;
    const stack = [
      "Error",
      "    at captureCodeOrigin (http://x/sdk.js:1:1)",
      `    at huge (${long})`,
      "    at ok (http://x/src/a.js:9:3)",
    ].join("\n");
    expect(withStack(stack, () => captureCodeOrigin(0))).toEqual([
      "http://x/src/a.js:9:3",
    ]);
  });

  /* ---- degrade to today's behaviour ---- */

  it("returns undefined when the engine gives no stack", () => {
    expect(withStack(undefined, () => captureCodeOrigin(1))).toBeUndefined();
  });

  it("returns undefined for a stack with no recognizable frames", () => {
    expect(
      withStack("Error\n    at <anonymous>", () => captureCodeOrigin(1)),
    ).toBeUndefined();
  });

  it("never throws when Error itself is hostile", () => {
    const RealError = globalThis.Error;
    globalThis.Error = function HostileError() {
      throw new RealError("no stacks here");
    } as unknown as ErrorConstructor;
    try {
      expect(captureCodeOrigin(1)).toBeUndefined();
    } finally {
      globalThis.Error = RealError;
    }
  });
});

/* ------------------------------------------------------------------ */
/* Live collector                                                      */
/* ------------------------------------------------------------------ */

describe("networkCollector – d.origin", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: (() => void) | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    globalThis.fetch = realFetch;
  });

  function reqEvents(): BugEvent[] {
    bus.flush();
    return events.filter((event) => event.k === "net.req");
  }

  async function fetchFrom(config: CrumbtrailConfig): Promise<BugEvent> {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    cleanup = networkCollector(bus, config);
    // A named wrapper stands in for app code: its frame is what should be
    // reported, and it lives in this test file — not in node_modules.
    async function saveAddress() {
      await globalThis.fetch("https://api.example.com/addresses");
    }
    await saveAddress();
    const [req] = reqEvents();
    return req;
  }

  it("records the app frame that issued the request", async () => {
    const req = await fetchFrom(DEFAULT_CONFIG);
    const origin = req.d.origin as string[];
    expect(Array.isArray(origin)).toBe(true);
    expect(origin[0]).toMatch(/code-origin\.test\.ts:\d+:\d+$/);
  });

  it("emits nothing when the app opted out", async () => {
    const req = await fetchFrom({
      ...DEFAULT_CONFIG,
      networkCaptureOrigin: false,
    });
    expect(req.d.origin).toBeUndefined();
    // And the rest of the event is exactly what it was before.
    expect(req.d.url).toBe("https://api.example.com/addresses");
  });
});

/* ------------------------------------------------------------------ */
/* Early capture and the drain                                         */
/* ------------------------------------------------------------------ */

describe("early capture – origin survives the drain", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: (() => void) | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    uninstallEarlyCapture();
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    uninstallEarlyCapture();
    globalThis.fetch = realFetch;
  });

  /** The blind window: a request issued before the SDK ever initialized. */
  async function requestBeforeInit(): Promise<void> {
    installEarlyCapture();
    async function saveAddress() {
      await globalThis.fetch("https://api.example.com/addresses?token=abc123");
    }
    await saveAddress();
  }

  it("carries the app frame from the blind window into net.req", async () => {
    await requestBeforeInit();
    cleanup = networkCollector(bus, DEFAULT_CONFIG);
    bus.flush();

    const req = events.find(
      (event) => event.k === "net.req" && event.d.early === true,
    );
    expect(req).toBeDefined();
    const origin = req!.d.origin as string[];
    expect(origin[0]).toMatch(/code-origin\.test\.ts:\d+:\d+$/);
  });

  it("redacts a query string on the frame URL and keeps the position", async () => {
    const bus2 = new EventBus();
    const seen: BugEvent[] = [];
    bus2.subscribe((batch) => seen.push(...batch));
    installEarlyCapture();
    const capture = (
      globalThis as unknown as {
        __crumbtrailEarly: { entries: Array<Record<string, unknown>> };
      }
    ).__crumbtrailEarly;
    capture.entries.push({
      method: "GET",
      url: "https://api.example.com/x",
      t: Date.now(),
      dur: 1,
      transport: "fetch",
      sessionId: "ses_test",
      requestId: "req_test",
      origin: ["https://cdn.example.com/app.js?sig=SECRET:42:7"],
    });
    cleanup = networkCollector(bus2, DEFAULT_CONFIG);
    bus2.flush();

    const req = seen.find((event) => event.k === "net.req");
    const origin = req?.d.origin as string[];
    expect(origin).toHaveLength(1);
    expect(origin[0]).not.toContain("SECRET");
    expect(origin[0]).toMatch(/:42:7$/);
  });

  it("drops the origin at the drain when the app opted out", async () => {
    await requestBeforeInit();
    cleanup = networkCollector(bus, {
      ...DEFAULT_CONFIG,
      networkCaptureOrigin: false,
    });
    bus.flush();

    const early = events.filter(
      (event) => event.k === "net.req" && event.d.early === true,
    );
    expect(early.length).toBeGreaterThan(0);
    for (const req of early) expect(req.d.origin).toBeUndefined();
  });
});
