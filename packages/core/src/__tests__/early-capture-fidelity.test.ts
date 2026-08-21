// What the early queue records about a request that did NOT go well, and about
// a request whose body was still being read when the SDK arrived.
//
// The early snippet exists for the first data load: the request that renders
// the first screen, and the one most likely to be the reason someone is looking
// at the session at all. Three ways it used to be recorded wrongly:
//
//   - an XHR that failed at the network layer (DNS, CORS, offline, timeout)
//     replayed as a SUCCESSFUL response with status 0, so it was not counted as
//     a failed request and raised nothing.
//   - a form submission issued as URLSearchParams or FormData was recorded with
//     no request body, while the identical call after init kept one.
//   - a response body still being read when the drain ran was dropped, because
//     the record had already been handed over without it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installEarlyCapture,
  uninstallEarlyCapture,
} from "../early-capture";
import { EventBus } from "../event-bus";
import { networkCollector } from "../collectors/network";
import { DEFAULT_CONFIG, type BugEvent } from "../types";

class MockXHR {
  static instances: MockXHR[] = [];

  method = "";
  url = "";
  status = 200;
  responseText = '{"ok":true}';
  requestHeaders: Record<string, string> = {};
  /** Fired between send() and loadend, as a real XHR does. */
  settleAs: "load" | "error" | "timeout" | "abort" = "load";
  private listeners: Record<string, Array<() => void>> = {};

  constructor() {
    MockXHR.instances.push(this);
  }

  open(method: string, url: string | URL): void {
    this.method = method;
    this.url = typeof url === "string" ? url : String(url);
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === "content-type" ? "application/json" : null;
  }

  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  send(_body?: unknown): void {
    for (const fn of this.listeners[this.settleAs] ?? []) fn();
    for (const fn of this.listeners.loadend ?? []) fn();
  }
}

function collect(config = DEFAULT_CONFIG) {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((batch) => events.push(...batch));
  const cleanup = networkCollector(bus, config, { sessionId: "ses_live_1" });
  bus.flush();
  return { events, bus, cleanup };
}

function jsonFetchMock() {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("early capture fidelity", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalXHR: typeof globalThis.XMLHttpRequest;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalXHR = globalThis.XMLHttpRequest;
    sessionStorage.clear();
    MockXHR.instances = [];
  });

  afterEach(() => {
    uninstallEarlyCapture();
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXHR;
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  for (const settleAs of ["error", "timeout", "abort"] as const) {
    it(`replays an early XHR that ended in ${settleAs} as a failure, not a status 0 response`, () => {
      globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;
      installEarlyCapture();

      const xhr = new globalThis.XMLHttpRequest();
      (xhr as unknown as MockXHR).settleAs = settleAs;
      (xhr as unknown as MockXHR).status = 0;
      xhr.open("GET", "/api/orders");
      xhr.send();

      const { events, cleanup } = collect();
      cleanup();

      expect(events.filter((event) => event.k === "net.res")).toHaveLength(0);
      const failures = events.filter((event) => event.k === "net.err");
      expect(failures).toHaveLength(1);
      expect(String(failures[0]?.d?.msg)).not.toBe("");
      expect(failures[0]?.d?.early).toBe(true);
    });
  }

  it("keeps recording a successful early XHR as a response", () => {
    globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;
    installEarlyCapture();

    const xhr = new globalThis.XMLHttpRequest();
    xhr.open("GET", "/api/orders");
    xhr.send();

    const { events, cleanup } = collect();
    cleanup();

    expect(events.filter((event) => event.k === "net.err")).toHaveLength(0);
    expect(
      events.find((event) => event.k === "net.res")?.d?.st,
    ).toBe(200);
  });

  it("records an early form submission sent as URLSearchParams", async () => {
    globalThis.fetch = jsonFetchMock();
    installEarlyCapture();

    await globalThis.fetch("/api/checkout", {
      method: "POST",
      body: new URLSearchParams({ quantity: "12" }),
    });

    const { events, cleanup } = collect();
    cleanup();

    const request = events.find((event) => event.k === "net.req");
    expect(String(request?.d?.body)).toContain("quantity=12");
  });

  it("records an early form submission sent as FormData", async () => {
    globalThis.fetch = jsonFetchMock();
    installEarlyCapture();

    const form = new FormData();
    form.append("quantity", "12");
    await globalThis.fetch("/api/checkout", { method: "POST", body: form });

    const { events, cleanup } = collect();
    cleanup();

    const request = events.find((event) => event.k === "net.req");
    expect(String(request?.d?.body)).toContain("quantity");
  });

  it("keeps the response body of a request whose body read outlived the drain", async () => {
    let deliverBody: ((text: string) => void) | undefined;
    const bodyText = new Promise<string>((resolve) => {
      deliverBody = resolve;
    });
    const slowResponse = {
      status: 200,
      headers: { get: () => "application/json" },
      clone: () => ({ text: () => bodyText }),
    };
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(slowResponse as unknown as Response),
      ) as unknown as typeof globalThis.fetch;

    installEarlyCapture();
    await globalThis.fetch("/api/orders");

    // The SDK arrives while the body clone is still being read.
    const { events, bus, cleanup } = collect();
    deliverBody?.('{"orders":["ord_17"]}');
    await bodyText;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    bus.flush();
    cleanup();

    const response = events.find((event) => event.k === "net.res");
    expect(response).toBeDefined();
    expect(String(response?.d?.body)).toContain("ord_17");
  });
});
