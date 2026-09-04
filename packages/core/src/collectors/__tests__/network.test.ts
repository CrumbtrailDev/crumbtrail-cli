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

describe("networkCollector – independent response evidence", () => {
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

  it("retains repeated bodies when earlier events fall outside the evidence window", async () => {
    globalThis.fetch = makeFetchMock('{"status":"ok"}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch("https://api.example.com/poll");
    await globalThis.fetch("https://api.example.com/poll");

    const res = resEvents();
    expect(res).toHaveLength(2);

    expect(typeof res[0].d.body).toBe("string");
    expect(res[0].d.dedup).toBeUndefined();

    const retained = res.slice(1);
    expect(retained[0].d.body).toBe('{"status":"ok"}');
    expect(retained[0].d.dedup).toBeUndefined();
  });

  it("keeps repeated text evidence even without a parsed body summary", async () => {
    globalThis.fetch = makeFetchMock("upstream unavailable", "text/plain");
    cleanup = networkCollector(bus, DEFAULT_CONFIG);
    await globalThis.fetch("https://api.example.com/health");
    await globalThis.fetch("https://api.example.com/health");
    const res = resEvents();
    expect(res[1].d.body).toBe(res[0].d.body);
    expect(typeof res[1].d.body).toBe("string");
    expect(res[1].d.dedup).toBeUndefined();
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

  it("retains response bodies across collector lifecycles", async () => {
    globalThis.fetch = makeFetchMock('{"ping":true}');
    const c1 = networkCollector(bus, DEFAULT_CONFIG);
    await globalThis.fetch("https://api.example.com/ping");
    c1();

    events = [];
    const c2 = networkCollector(bus, DEFAULT_CONFIG);
    await globalThis.fetch("https://api.example.com/ping");
    cleanup = c2;

    const res = resEvents();
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
    expect(body).toContain('"ext":"pdf"');
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
 * `nameShape` and `declaredType` cannot ride inside the redacted JSON body (a MIME type's `/` fails
 * the enum-shaped keep rule and gets redacted as free text), so they and the byte-sniffed fields ride
 * a separate `net.req.file` event instead, joined to `net.req` by id/field/index. Exactly one such
 * event is emitted per file part: it is written once the sniff settles (or fails), carrying the sync
 * and sniffed fields together, so no consumer ever has to merge two records for one upload.
 */
describe("networkCollector – file part description (net.req.file)", () => {
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

  async function flushMicrotasks() {
    // Lets the un-awaited sniff promise settle before assertions read the bus.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it("emits exactly one net.req.file event per part, carrying both sync and sniffed fields", async () => {
    globalThis.fetch = makeFetchMock('{"ok":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    // A minimal PNG header: signature + IHDR carrying width=10, height=5.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 10, 0, 0, 0, 5,
    ]);
    const form = new FormData();
    form.append("avatar", new File([png], "pic.png", { type: "image/png" }));

    await globalThis.fetch("https://api.example.com/upload", {
      method: "POST",
      body: form,
    });
    await flushMicrotasks();

    bus.flush();
    const fileEvents = events.filter((e) => e.k === "net.req.file");
    expect(fileEvents).toHaveLength(1);

    const [event] = fileEvents;
    expect(event.d.field).toBe("avatar");
    expect(event.d.index).toBe(0);
    expect(event.d.declaredType).toBe("image/png");
    expect((event.d.nameShape as { len: number }).len).toBe("pic.png".length);
    expect(event.d.sniffedType).toBe("image/png");
    expect(event.d.width).toBe(10);
    expect(event.d.height).toBe(5);

    // Sorts beside its net.req: same timestamp as the request, not whenever the sniff settled.
    const reqEventRecord = events.find((e) => e.k === "net.req");
    expect(event.t).toBe(reqEventRecord!.t);
  });

  it("drops a declaredType that fails the MIME grammar, still emitting one event", async () => {
    globalThis.fetch = makeFetchMock('{"ok":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    const form = new FormData();
    form.append(
      "avatar",
      new File(["x"], "pic.png", { type: "not a mime; at all" }),
    );

    await globalThis.fetch("https://api.example.com/upload", {
      method: "POST",
      body: form,
    });
    await flushMicrotasks();

    bus.flush();
    const fileEvents = events.filter(
      (e) => e.k === "net.req.file" && e.d.field === "avatar",
    );
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0].d.declaredType).toBeUndefined();
  });

  it("emits one event per file, indexed, when two files share a field name", async () => {
    globalThis.fetch = makeFetchMock('{"ok":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    const form = new FormData();
    form.append("photos", new File(["a"], "one.jpg", { type: "image/jpeg" }));
    form.append("photos", new File(["b"], "two.jpg", { type: "image/jpeg" }));

    await globalThis.fetch("https://api.example.com/upload", {
      method: "POST",
      body: form,
    });
    await flushMicrotasks();

    bus.flush();
    const fileEvents = events.filter(
      (e) => e.k === "net.req.file" && e.d.field === "photos",
    );
    expect(fileEvents).toHaveLength(2);
    expect(fileEvents.map((e) => e.d.index).sort()).toEqual([0, 1]);
  });

  it("still emits the sync fields alone when the sniff itself rejects", async () => {
    globalThis.fetch = makeFetchMock('{"ok":true}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    vi.spyOn(file, "slice").mockReturnValue({
      arrayBuffer: () => Promise.reject(new Error("boom")),
    } as unknown as Blob);

    const form = new FormData();
    form.append("doc", file);

    await globalThis.fetch("https://api.example.com/upload", {
      method: "POST",
      body: form,
    });
    await flushMicrotasks();

    bus.flush();
    const fileEvents = events.filter((e) => e.k === "net.req.file");
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0].d.declaredType).toBe("text/plain");
    expect(fileEvents[0].d.sniffedType).toBeUndefined();
  });

  // The whole point of not awaiting the sniff: the real request goes out on its normal schedule,
  // never waiting on a single byte of its own upload being read back.
  it("dispatches the underlying fetch before the sniff's byte read resolves", async () => {
    const realFetch = vi.fn().mockResolvedValue(new Response("{}"));
    globalThis.fetch = realFetch;
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    let resolveArrayBuffer: (buf: ArrayBuffer) => void = () => {};
    const arrayBufferPromise = new Promise<ArrayBuffer>((resolve) => {
      resolveArrayBuffer = resolve;
    });

    const file = new File(["hello world"], "note.txt", { type: "text/plain" });
    vi.spyOn(file, "slice").mockReturnValue({
      arrayBuffer: () => arrayBufferPromise,
    } as unknown as Blob);

    const form = new FormData();
    form.append("doc", file);

    const fetchPromise = globalThis.fetch("https://api.example.com/upload", {
      method: "POST",
      body: form,
    });

    // No await between dispatch and this assertion: the sniff's arrayBuffer() is still
    // pending (so no net.req.file event exists yet), but the real fetch has already been
    // invoked synchronously.
    expect(realFetch).toHaveBeenCalledTimes(1);
    bus.flush();
    expect(events.filter((e) => e.k === "net.req.file")).toHaveLength(0);

    resolveArrayBuffer(new TextEncoder().encode("hello world").buffer);
    await fetchPromise;
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
