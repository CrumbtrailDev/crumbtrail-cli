// A cross-origin call that goes out unstamped is the difference between a
// product that joins frontend and backend evidence and one that does not, and
// the allowlist that decides it is empty by default. Nothing else in the SDK
// says so, so the one hint line is asserted here: once per origin, only when the
// request would otherwise have been stamped, and never when it was.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import {
  networkCollector,
  __resetCorrelationHintsForTests,
} from "../collectors/network";
import { CRUMBTRAIL_SESSION_HEADER } from "../correlation";

function collect(config: Partial<CrumbtrailConfig> = {}, sessionId = "sess_1") {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((batch) => events.push(...batch));
  const cleanup = networkCollector(
    bus,
    { ...DEFAULT_CONFIG, ...config },
    { sessionId },
  );
  return { events, bus, cleanup };
}

function outgoingHeaders(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [input, init] = fetchMock.mock.calls[index] as [
    RequestInfo | URL,
    RequestInit | undefined,
  ];
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

const originalFetch = globalThis.fetch;
let info: ReturnType<typeof vi.spyOn>;
// The collector replaces globalThis.fetch, so the underlying mock is kept here
// to read what actually went over the wire.
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetCorrelationHintsForTests();
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  info.mockRestore();
  globalThis.fetch = originalFetch;
});

describe("cross-origin correlation is diagnosable", () => {
  it("stamps an allowlisted backend origin and says nothing", async () => {
    const { cleanup } = collect({
      networkCorrelationAllowedOrigins: ["https://api.example.com"],
    });

    await globalThis.fetch("https://api.example.com/orders");

    const headers = outgoingHeaders(fetchMock);
    expect(headers.get(CRUMBTRAIL_SESSION_HEADER)).toBe("sess_1");
    expect(info).not.toHaveBeenCalled();

    cleanup();
  });

  it("names the origin once when the default empty allowlist skips it", async () => {
    const { cleanup } = collect();

    await globalThis.fetch("https://api.example.com/orders");

    const headers = outgoingHeaders(fetchMock);
    expect(headers.get(CRUMBTRAIL_SESSION_HEADER)).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    const message = String(info.mock.calls[0]?.[0]);
    expect(message).toContain("https://api.example.com");
    expect(message).toContain("networkCorrelationAllowedOrigins");

    cleanup();
  });

  it("hints once per origin, not once per request", async () => {
    const { cleanup } = collect();

    await globalThis.fetch("https://api.example.com/orders");
    await globalThis.fetch("https://api.example.com/invoices");
    await globalThis.fetch("https://payments.example.com/charges");

    expect(info).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("names the origin on the XHR path too", async () => {
    class MockXHR {
      static last: MockXHR | undefined;
      url = "";
      requestHeaders: Record<string, string> = {};
      status = 200;
      responseText = "";
      readyState = 0;
      open(_method: string, url: string) {
        this.url = url;
        MockXHR.last = this;
      }
      setRequestHeader(name: string, value: string) {
        this.requestHeaders[name] = value;
      }
      send() {}
      addEventListener() {}
      removeEventListener() {}
      getAllResponseHeaders() {
        return "";
      }
      getResponseHeader() {
        return null;
      }
    }
    const originalXHR = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;

    const { cleanup } = collect();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/orders");
    xhr.send();

    expect(MockXHR.last?.requestHeaders[CRUMBTRAIL_SESSION_HEADER]).toBe(
      undefined,
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain(
      "https://api.example.com",
    );

    cleanup();
    globalThis.XMLHttpRequest = originalXHR;
  });

  it("stays silent when correlation headers are switched off entirely", async () => {
    const { cleanup } = collect({ networkCorrelationHeaders: false });

    await globalThis.fetch("https://api.example.com/orders");

    expect(info).not.toHaveBeenCalled();

    cleanup();
  });
});
