import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, type BugEvent } from "../../types";
import { networkCollector } from "../network";

// Minimal fetch mock factory
function makeFetchMock(body: string, contentType = "application/json") {
  return vi.fn().mockResolvedValue(
    new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    }),
  );
}

describe("networkCollector – body deduplication", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    cleanup?.();
    events = [];
  });

  function resEvents() {
    bus.flush();
    return events.filter((e) => e.k === "net.res");
  }

  it("stores full body on first response", async () => {
    globalThis.fetch = makeFetchMock('{"status":"ok"}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch("https://api.example.com/poll");
    const [res] = resEvents();

    expect(res.d.body).toBe('{"status":"ok"}');
    expect(res.d.dedup).toBeUndefined();
  });

  it("deduplicates identical response body for same URL on second call", async () => {
    globalThis.fetch = makeFetchMock('{"status":"ok"}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch("https://api.example.com/poll");
    await globalThis.fetch("https://api.example.com/poll");

    const res = resEvents();
    expect(res).toHaveLength(2);

    // First: full body
    expect(typeof res[0].d.body).toBe("string");
    expect(res[0].d.dedup).toBeUndefined();

    // Second: deduplicated reference
    expect(res[1].d.dedup).toBe(true);
    expect((res[1].d.body as Record<string, unknown>).ref).toBeDefined();
  });

  it("does NOT deduplicate when response bodies differ", async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve(
        new Response(call === 1 ? '{"count":1}' : '{"count":2}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch("https://api.example.com/counter");
    await globalThis.fetch("https://api.example.com/counter");

    const res = resEvents();
    expect(res).toHaveLength(2);
    expect(res[0].d.dedup).toBeUndefined();
    expect(res[1].d.dedup).toBeUndefined();
    expect(res[0].d.body).toBe('{"count":1}');
    expect(res[1].d.body).toBe('{"count":2}');
  });

  it("does NOT deduplicate same body for different URLs", async () => {
    const body = '{"value":42}';
    globalThis.fetch = makeFetchMock(body);
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch("https://api.example.com/a");
    await globalThis.fetch("https://api.example.com/b");

    const res = resEvents();
    expect(res).toHaveLength(2);
    expect(res[0].d.dedup).toBeUndefined();
    expect(res[1].d.dedup).toBeUndefined();
  });

  it("clears dedup map on cleanup so subsequent collector instances start fresh", async () => {
    globalThis.fetch = makeFetchMock('{"ping":true}');
    const c1 = networkCollector(bus, DEFAULT_CONFIG);
    await globalThis.fetch("https://api.example.com/ping");
    c1(); // cleanup — clears dedup map

    events = [];
    const c2 = networkCollector(bus, DEFAULT_CONFIG);
    await globalThis.fetch("https://api.example.com/ping");
    cleanup = c2;

    const res = resEvents();
    // After reset the first call should be treated as new, not a dup
    expect(res[0].d.dedup).toBeUndefined();
    expect(res[0].d.body).toBe('{"ping":true}');
  });
});

/**
 * `body: new FormData(form)` and `body: new URLSearchParams(form)` are how a form submission is
 * normally written. Both were discarded whole as "non-text", so every field the user filled in went
 * missing from the capture because of the container it arrived in.
 */
describe("networkCollector – form-shaped request bodies", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    globalThis.fetch = makeFetchMock('{"ok":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup?.();
    events = [];
  });

  function reqEvent() {
    bus.flush();
    return events.filter((e) => e.k === "net.req")[0];
  }

  it("reads a URLSearchParams body", async () => {
    await globalThis.fetch("https://api.example.com/cart", {
      method: "POST",
      body: new URLSearchParams({ sku: "ABC", qty: "3" }),
    });

    expect(String(reqEvent().d.body)).toContain("qty=3");
  });

  it("reads the fields of a FormData body", async () => {
    const form = new FormData();
    form.append("sku", "ABC");
    form.append("qty", "3");

    await globalThis.fetch("https://api.example.com/cart", {
      method: "POST",
      body: form,
    });

    const body = String(reqEvent().d.body);
    expect(body).toContain("sku");
    expect(body).toContain("ABC");
    expect(body).toContain("3");
  });

  // Reading a file part would put a document's contents in a bug report. The form FIELD name is
  // what a reader needs - the upload was attached to `invoice` - and it survives as the key.
  it("describes a file part and never reads it", async () => {
    const form = new FormData();
    form.append(
      "invoice",
      new File(["SECRET-DOCUMENT-BODY"], "invoice.pdf", {
        type: "application/pdf",
      }),
    );

    await globalThis.fetch("https://api.example.com/upload", {
      method: "POST",
      body: form,
    });

    const body = String(reqEvent().d.body);
    expect(body).toContain("invoice");
    expect(body).toContain('"file":true');
    expect(body).toContain('"bytes":20');
    expect(body).not.toContain("SECRET-DOCUMENT-BODY");
  });

  // Same policy as any other body: the container it arrived in changes nothing.
  it("redacts a form field the policy denies", async () => {
    await globalThis.fetch("https://api.example.com/login", {
      method: "POST",
      body: new URLSearchParams({
        user: "ada",
        password: "hunter2-should-not-appear",
      }),
    });

    expect(String(reqEvent().d.body)).not.toContain(
      "hunter2-should-not-appear",
    );
  });

  it("still reports a truly unreadable body as non-text", async () => {
    await globalThis.fetch("https://api.example.com/blob", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });

    expect(reqEvent().d.body).not.toBe("[1,2,3]");
  });
});

/**
 * `Response.text()` resolves when the stream CLOSES, which for a streaming response may be never.
 * The collector awaited that before emitting `net.res`, so a streamed request - progress updates,
 * model tokens, a log tail, a large export - was recorded as a request that never came back.
 */
describe("networkCollector – streaming responses", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    cleanup?.();
    events = [];
  });

  function resEvents() {
    bus.flush();
    return events.filter((e) => e.k === "net.res");
  }

  /** A body that emits one chunk and then stays open forever. */
  function openStreamResponse(first: string) {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(first));
          // Deliberately never closed.
        },
      }),
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    );
  }

  it(
    "reports a response whose body is still open, with what arrived so far",
    { timeout: 20_000 },
    async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(openStreamResponse('{"tick":1}\n'));
      cleanup = networkCollector(bus, DEFAULT_CONFIG);

      await globalThis.fetch("https://api.example.com/stream");
      const [res] = resEvents();

      expect(res).toBeDefined();
      expect(res.d.st).toBe(200);
      expect(res.d.streaming).toBe(true);
      expect(String(res.d.body)).toContain("tick");
    },
  );

  it("does not mark an ordinary response as streaming", async () => {
    globalThis.fetch = makeFetchMock('{"done":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch("https://api.example.com/once");
    const [res] = resEvents();

    expect(res.d.streaming).toBeUndefined();
    expect(res.d.body).toBe('{"done":true}');
  });
});

/**
 * Which line of the application asked for the request.
 *
 * The frontend half of a linked full-stack request carried no callsite, so a
 * bundle for a client-plane defect named server files and nothing else. These
 * pin BOTH directions: the caller is present, and the SDK is not.
 */
describe("networkCollector – request callsite", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    cleanup?.();
    events = [];
  });

  async function saveAddressFromApplicationCode() {
    await globalThis.fetch("https://api.example.com/addresses", {
      method: "POST",
      body: '{"city":"Toronto"}',
    });
  }

  it("records the application frame that issued the request", async () => {
    globalThis.fetch = makeFetchMock('{"ok":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await saveAddressFromApplicationCode();
    bus.flush();

    const [req] = events.filter((e) => e.k === "net.req");
    expect(req.d.stk).toBeTypeOf("string");
    const frames = String(req.d.stk).split("\n").slice(1);
    expect(frames[0]).toContain("saveAddressFromApplicationCode");
  });

  it("does not name the collector itself as the callsite", async () => {
    globalThis.fetch = makeFetchMock('{"ok":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await saveAddressFromApplicationCode();
    bus.flush();

    const [req] = events.filter((e) => e.k === "net.req");
    // `network.ts` appearing anywhere in the stack would mean the wrapper's own
    // frames survived — the failure mode that made the existing console capture
    // point a reader at the SDK's bundle.
    expect(String(req.d.stk)).not.toContain("collectors/network.ts");
    expect(String(req.d.stk)).not.toContain("instrumentedFetch");
  });

  it("captures the callsite on a request that succeeds", async () => {
    // The whole point. A 200 produces no error, no console entry and no ranked
    // failure — and is exactly the shape of a defect where the server did as it
    // was told and the client asked for the wrong thing.
    globalThis.fetch = makeFetchMock('{"ok":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await saveAddressFromApplicationCode();
    bus.flush();

    const [req] = events.filter((e) => e.k === "net.req");
    const [res] = events.filter((e) => e.k === "net.res");
    expect(res.d.st).toBe(200);
    expect(req.d.stk).toBeTypeOf("string");
  });
});

// `net.res` used to carry `id` alone, so learning WHICH request failed meant
// finding the paired `net.req` — and the pair is not guaranteed to survive. A
// request that started before the retained window, or before a truncated
// upload's cut, left its failing response standing alone, and the session index
// recorded it as `{m:"", url:"", st:500}`. `net.err` has always carried method
// and url; the response carries them for the same reason.
describe("networkCollector – a response names its own request", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    cleanup?.();
    events = [];
  });

  it("stamps method and url on a fetch response", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"boom"}', {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch("https://api.example.com/api/orders?limit=200", {
      method: "POST",
    });
    bus.flush();

    const [res] = events.filter((e) => e.k === "net.res");
    expect(res.d.st).toBe(500);
    expect(res.d.method).toBe("POST");
    expect(String(res.d.url)).toContain("/api/orders");
  });

  it("redacts the response url with the same policy the request url gets", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch(
      "https://api.example.com/api/auth/whoami?token=abcdef0123456789",
    );
    bus.flush();

    const [req] = events.filter((e) => e.k === "net.req");
    const [res] = events.filter((e) => e.k === "net.res");
    expect(res.d.url).toBe(req.d.url);
    // Route redaction keeps the endpoint; the credential still goes.
    expect(String(res.d.url)).toContain("/api/auth/whoami");
    expect(String(res.d.url)).not.toContain("abcdef0123456789");
  });
});
