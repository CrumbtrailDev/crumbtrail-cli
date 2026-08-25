// Turning on correlation must never take the customer's application down.
//
// A customer followed the snippet comment, added their backend origin to
// `networkCorrelationAllowedOrigins`, and their app broke: the backend's
// `cors({ allowedHeaders: ["Content-Type", "Authorization"] })` refused the
// preflight, so the browser blocked the real request with "Request header field
// traceparent is not allowed by Access-Control-Allow-Headers".
//
// These tests pin the degradation: retry once without the headers, and only
// when the unstamped attempt succeeds treat the origin as header-rejected, warn
// once, and stop stamping it. A body that cannot be replayed is never replayed,
// and a backend that is simply down never gets mistaken for a fussy one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import {
  networkCollector,
  __resetCorrelationHintsForTests,
} from "../collectors/network";
import {
  CRUMBTRAIL_SESSION_HEADER,
  W3C_TRACEPARENT_HEADER,
  __resetCorrelationHeaderRejectionsForTests,
  isCorrelationOriginHeaderRejected,
} from "../correlation";
import { __resetCorrelationFallbackForTests } from "../correlation-fallback";

const BACKEND = "http://backend.test";
const URL_UNDER_TEST = `${BACKEND}/api/order`;

function collect(config: Partial<CrumbtrailConfig> = {}) {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  bus.tap((event) => events.push(event));
  const cleanup = networkCollector(
    bus,
    {
      ...DEFAULT_CONFIG,
      networkCorrelationHeaders: true,
      networkCorrelationAllowedOrigins: [BACKEND],
      ...config,
    },
    { sessionId: "sess_1" },
  );
  return { events, cleanup };
}

function headersOf(call: unknown[]): Headers {
  const [input, init] = call as [RequestInfo | URL, RequestInit | undefined];
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

/** What the browser does when a preflight refuses a request header. */
function preflightRejection(): TypeError {
  return new TypeError("Failed to fetch");
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetCorrelationHintsForTests();
  __resetCorrelationHeaderRejectionsForTests();
  __resetCorrelationFallbackForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  warn.mockRestore();
  info.mockRestore();
  vi.restoreAllMocks();
});

/** Fails any request carrying `traceparent`; serves everything else. */
function corsFussyBackend() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = headersOf([input, init]);
    if (headers.has(W3C_TRACEPARENT_HEADER)) throw preflightRejection();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

describe("fetch: correlation headers rejected by CORS preflight", () => {
  it("retries without the headers and gives the app its response", async () => {
    fetchMock = corsFussyBackend();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { cleanup } = collect();

    const res = await fetch(URL_UNDER_TEST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qty: 2 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchMock.mock.calls[0]).has(W3C_TRACEPARENT_HEADER)).toBe(
      true,
    );
    expect(headersOf(fetchMock.mock.calls[1]).has(W3C_TRACEPARENT_HEADER)).toBe(
      false,
    );
    cleanup();
  });

  it("stops stamping the origin for the rest of the session", async () => {
    fetchMock = corsFussyBackend();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { cleanup } = collect();

    await fetch(URL_UNDER_TEST, { method: "POST", body: "{}" });
    expect(isCorrelationOriginHeaderRejected(URL_UNDER_TEST)).toBe(true);

    await fetch(URL_UNDER_TEST, { method: "POST", body: "{}" });

    // First attempt, its retry, then one clean attempt: no second rejection.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const third = headersOf(fetchMock.mock.calls[2]);
    expect(third.has(W3C_TRACEPARENT_HEADER)).toBe(false);
    expect(third.has(CRUMBTRAIL_SESSION_HEADER)).toBe(false);
    cleanup();
  });

  it("warns once, naming the three headers and the Express fix", async () => {
    fetchMock = corsFussyBackend();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { cleanup } = collect();

    await fetch(URL_UNDER_TEST, { method: "POST", body: "{}" });
    await fetch(URL_UNDER_TEST, { method: "POST", body: "{}" });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain(BACKEND);
    expect(message).toContain("x-crumbtrail-session-id");
    expect(message).toContain("x-crumbtrail-request-id");
    expect(message).toContain("traceparent");
    expect(message).toContain("Access-Control-Allow-Headers");
    expect(message).toContain("allowedHeaders");
    cleanup();
  });

  it("does not claim correlation ids on a response that carried none", async () => {
    fetchMock = corsFussyBackend();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { events, cleanup } = collect();

    await fetch(URL_UNDER_TEST, { method: "POST", body: "{}" });

    const res = events.find((e) => e.k === "net.res");
    expect(res).toBeDefined();
    expect(res?.d.requestId).toBeUndefined();
    expect(res?.d.traceId).toBeUndefined();
    cleanup();
  });

  it("stays silent and rethrows when the backend is simply down", async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { events, cleanup } = collect();

    await expect(
      fetch(URL_UNDER_TEST, { method: "POST", body: "{}" }),
    ).rejects.toThrow("Failed to fetch");

    expect(warn).not.toHaveBeenCalled();
    expect(isCorrelationOriginHeaderRejected(URL_UNDER_TEST)).toBe(false);
    expect(events.some((e) => e.k === "net.err")).toBe(true);
    cleanup();
  });

  it("gives up probing an unreachable origin instead of doubling its traffic forever", async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { cleanup } = collect();

    for (let i = 0; i < 6; i++) {
      await fetch(URL_UNDER_TEST, { method: "POST", body: "{}" }).catch(
        () => {},
      );
    }

    // Six requests, three of them probed once: nine, not twelve.
    expect(fetchMock).toHaveBeenCalledTimes(9);
    cleanup();
  });

  it("does not replay a streaming request body", async () => {
    fetchMock = corsFussyBackend();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { cleanup } = collect();

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });

    await expect(
      fetch(URL_UNDER_TEST, {
        method: "POST",
        body: body as unknown as BodyInit,
        // @ts-expect-error `duplex` is required for a stream body and is not in
        // every lib.dom version.
        duplex: "half",
      }),
    ).rejects.toThrow();

    // Exactly one attempt: replaying a consumed stream would send a truncated body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Still stops stamping, so the NEXT request is not broken by us either.
    expect(isCorrelationOriginHeaderRejected(URL_UNDER_TEST)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "could not be safely replayed",
    );
    cleanup();
  });

  it("never retries a request the application aborted", async () => {
    fetchMock = vi.fn(async () => {
      const error = new Error("The user aborted a request.");
      error.name = "AbortError";
      throw error;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { cleanup } = collect();

    await expect(
      fetch(URL_UNDER_TEST, { method: "POST", body: "{}" }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isCorrelationOriginHeaderRejected(URL_UNDER_TEST)).toBe(false);
    cleanup();
  });

  it("leaves same-origin failures alone", async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { cleanup } = collect();

    await expect(fetch("/api/local", { method: "POST" })).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    cleanup();
  });
});

/* ------------------------------------------------------------------ */
/* XHR                                                                 */
/* ------------------------------------------------------------------ */

type XhrListener = (event: Event) => void;

/**
 * The smallest XHR that can express this failure: header capture, an `error`
 * event with a stoppable propagation, and a reopen that clears the headers.
 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  static failWithTraceparent = true;
  static failAlways = false;

  status = 0;
  responseText = "";
  sentHeaders: Record<string, string> = {};
  sendCount = 0;
  private listeners = new Map<string, XhrListener[]>();

  constructor() {
    FakeXHR.instances.push(this);
  }

  open(_method: string, _url: string): void {
    this.sentHeaders = {};
    this.status = 0;
  }

  setRequestHeader(name: string, value: string): void {
    this.sentHeaders[name.toLowerCase()] = value;
  }

  addEventListener(type: string, fn: XhrListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  getAllResponseHeaders(): string {
    return "";
  }

  getResponseHeader(): string | null {
    return null;
  }

  send(_body?: unknown): void {
    this.sendCount++;
    const rejected =
      FakeXHR.failAlways ||
      (FakeXHR.failWithTraceparent && "traceparent" in this.sentHeaders);
    // Asynchronous, like the real thing.
    queueMicrotask(() => {
      if (rejected) {
        this.dispatch("error");
      } else {
        this.status = 200;
        this.responseText = '{"ok":true}';
        this.dispatch("load");
      }
      this.dispatch("loadend");
    });
  }

  private dispatch(type: string): void {
    let stopped = false;
    const event = {
      type,
      stopImmediatePropagation: () => {
        stopped = true;
      },
    } as unknown as Event;
    for (const fn of this.listeners.get(type) ?? []) {
      fn.call(this as unknown as XMLHttpRequest, event);
      if (stopped) return;
    }
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("XHR: correlation headers rejected by CORS preflight", () => {
  const realXHR = globalThis.XMLHttpRequest;

  beforeEach(() => {
    FakeXHR.instances = [];
    FakeXHR.failWithTraceparent = true;
    FakeXHR.failAlways = false;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    // The XHR tests do not exercise fetch; keep it inert.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("ok")) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = realXHR;
  });

  it("resends without the headers, hides the failure, and warns once", async () => {
    const { cleanup } = collect();

    const seen: string[] = [];
    const xhr = new XMLHttpRequest();
    xhr.open("POST", URL_UNDER_TEST);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onerror = () => seen.push("error");
    xhr.onload = () => seen.push(`load ${xhr.status}`);
    // `onerror`/`onload` are plain properties on the fake; wire them the way a
    // browser does, after `open()`, so the guard listener is ahead of them.
    xhr.addEventListener("error", () => seen.push("error"));
    xhr.addEventListener("load", () => seen.push(`load ${xhr.status}`));
    xhr.send(JSON.stringify({ qty: 2 }));

    await settle();

    const instance = FakeXHR.instances[0];
    expect(instance.sendCount).toBe(2);
    expect(seen).toEqual(["load 200"]);
    expect(instance.sentHeaders.traceparent).toBeUndefined();
    expect(instance.sentHeaders["content-type"]).toBe("application/json");
    expect(isCorrelationOriginHeaderRejected(URL_UNDER_TEST)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("stops stamping the origin for later XHRs", async () => {
    const { cleanup } = collect();

    const first = new XMLHttpRequest();
    first.open("POST", URL_UNDER_TEST);
    first.send("{}");
    await settle();

    const second = new XMLHttpRequest();
    second.open("POST", URL_UNDER_TEST);
    second.send("{}");
    await settle();

    const instance = FakeXHR.instances[1];
    expect(instance.sendCount).toBe(1);
    expect(instance.sentHeaders.traceparent).toBeUndefined();
    cleanup();
  });

  it("lets a genuinely failing request fail, without a warning", async () => {
    FakeXHR.failAlways = true;
    const { cleanup } = collect();
    const errors: string[] = [];

    const xhr = new XMLHttpRequest();
    xhr.open("POST", URL_UNDER_TEST);
    xhr.addEventListener("error", () => errors.push("error"));
    xhr.send("{}");
    await settle();

    // Attempted twice, failed twice, so nothing was proved: the app sees the
    // error it would have seen and no advice is printed.
    expect(FakeXHR.instances[0].sendCount).toBe(2);
    expect(errors.length).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(isCorrelationOriginHeaderRejected(URL_UNDER_TEST)).toBe(false);
    cleanup();
  });
});
