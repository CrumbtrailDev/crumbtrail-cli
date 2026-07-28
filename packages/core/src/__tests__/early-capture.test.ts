import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EARLY_IDLE_TIMEOUT_MS,
  EARLY_MAX_BODY_BYTES,
  EARLY_MAX_ENTRIES,
  drainEarlyCapture,
  installEarlyCapture,
  readEarlyCapture,
  readEarlySessionId,
  uninstallEarlyCapture,
} from "../early-capture";
import {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER,
  W3C_TRACEPARENT_HEADER,
  parseTraceparent,
} from "../correlation";
import { EventBus } from "../event-bus";
import { networkCollector } from "../collectors/network";
import { DEFAULT_CONFIG, type BugEvent } from "../types";
import { Crumbtrail } from "../bug-logger";
import { DEFAULT_SESSION_STORAGE_KEY } from "../session-store";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchMock(body = '{"ok":true}', status = 200) {
  return vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
}

function headersOf(mock: ReturnType<typeof vi.fn>, callIndex = 0): Headers {
  const [input, init] = mock.mock.calls[callIndex] as [
    RequestInfo | URL,
    RequestInit | undefined,
  ];
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

/** Lets the floating response-body clone read settle. */
async function settleBodies(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

class MockXHR {
  static instances: MockXHR[] = [];

  method = "";
  url = "";
  status = 200;
  responseText = '{"ok":true}';
  requestHeaders: Record<string, string> = {};
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
    for (const fn of this.listeners.loadend ?? []) fn();
  }
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("early capture", () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records the first fetch with method, url, status and duration", async () => {
    globalThis.fetch = fetchMock();
    installEarlyCapture();

    await globalThis.fetch("/api/cart", { method: "POST", body: "{}" });

    const entries = readEarlyCapture()?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("POST");
    expect(entries[0].url).toBe("/api/cart");
    expect(entries[0].status).toBe(200);
    expect(entries[0].transport).toBe("fetch");
    expect(entries[0].dur).toBeGreaterThanOrEqual(0);
    expect(entries[0].t).toBeGreaterThan(0);
  });

  it("stamps the same correlation headers the SDK network patch stamps", async () => {
    const mock = fetchMock();
    globalThis.fetch = mock;
    const capture = installEarlyCapture();

    await globalThis.fetch("/api/cart");

    const headers = headersOf(mock);
    expect(headers.get(CRUMBTRAIL_SESSION_HEADER)).toBe(capture?.sessionId);
    const requestId = headers.get(CRUMBTRAIL_REQUEST_HEADER);
    const traceparent = parseTraceparent(
      headers.get(W3C_TRACEPARENT_HEADER) ?? undefined,
    );
    expect(traceparent).toBeDefined();
    expect(requestId).toBe(traceparent?.traceId);

    const entry = readEarlyCapture()?.entries[0];
    expect(entry?.requestId).toBe(requestId);
    expect(entry?.traceId).toBe(traceparent?.traceId);
    expect(entry?.spanId).toBe(traceparent?.spanId);
    expect(entry?.sessionId).toBe(capture?.sessionId);
  });

  it("does not stamp correlation headers on cross-origin requests", async () => {
    const mock = fetchMock();
    globalThis.fetch = mock;
    installEarlyCapture();

    await globalThis.fetch("https://third-party.example.com/track");

    const headers = headersOf(mock);
    expect(headers.get(CRUMBTRAIL_SESSION_HEADER)).toBeNull();
    expect(headers.get(W3C_TRACEPARENT_HEADER)).toBeNull();
    expect(readEarlyCapture()?.entries[0].url).toBe(
      "https://third-party.example.com/track",
    );
  });

  it("preserves a correlation header the caller already set", async () => {
    const mock = fetchMock();
    globalThis.fetch = mock;
    installEarlyCapture();

    await globalThis.fetch("/api/cart", {
      headers: { [CRUMBTRAIL_SESSION_HEADER]: "ses_caller_owned" },
    });

    expect(headersOf(mock).get(CRUMBTRAIL_SESSION_HEADER)).toBe(
      "ses_caller_owned",
    );
  });

  it("continues a fresh persisted session instead of minting a rival id", () => {
    sessionStorage.setItem(
      DEFAULT_SESSION_STORAGE_KEY,
      JSON.stringify({ id: "ses_persisted_1", lastActivity: Date.now() }),
    );
    globalThis.fetch = fetchMock();

    expect(installEarlyCapture()?.sessionId).toBe("ses_persisted_1");
    expect(readEarlySessionId()).toBe("ses_persisted_1");
  });

  it("mints a session id when the persisted session is stale", () => {
    sessionStorage.setItem(
      DEFAULT_SESSION_STORAGE_KEY,
      JSON.stringify({ id: "ses_stale_1", lastActivity: 0 }),
    );
    globalThis.fetch = fetchMock();

    expect(installEarlyCapture()?.sessionId).toMatch(
      /^ses_\d{8}_\d{6}_[0-9a-f]{12}$/,
    );
  });

  it("drops the oldest entry past the queue cap", async () => {
    globalThis.fetch = fetchMock();
    installEarlyCapture();

    for (let i = 0; i < EARLY_MAX_ENTRIES + 5; i += 1) {
      await globalThis.fetch(`/api/item/${i}`);
    }

    const entries = readEarlyCapture()?.entries ?? [];
    expect(entries).toHaveLength(EARLY_MAX_ENTRIES);
    expect(entries[0].url).toBe("/api/item/5");
    expect(entries[entries.length - 1].url).toBe(
      `/api/item/${EARLY_MAX_ENTRIES + 4}`,
    );
  });

  it("keeps recording metadata but stops storing bodies at the byte cap", async () => {
    const big = "x".repeat(EARLY_MAX_BODY_BYTES);
    globalThis.fetch = fetchMock(big);
    installEarlyCapture();

    // 32 request+response pairs of 32KB each exactly fill the 2MB ceiling.
    for (let i = 0; i < 34; i += 1) {
      await globalThis.fetch(`/api/bulk/${i}`, {
        method: "POST",
        body: big,
        headers: { "content-type": "application/json" },
      });
    }
    await settleBodies();

    const capture = readEarlyCapture();
    const entries = capture?.entries ?? [];
    expect(entries).toHaveLength(34);
    expect(capture?.bytes).toBeLessThanOrEqual(2_097_152);
    expect(entries[0].reqBody).toHaveLength(EARLY_MAX_BODY_BYTES);
    expect(entries[0].resBody).toHaveLength(EARLY_MAX_BODY_BYTES);
    const last = entries[entries.length - 1];
    expect(last.reqBody).toBeUndefined();
    expect(last.resBody).toBeUndefined();
    expect(last.status).toBe(200);
    expect(last.url).toBe("/api/bulk/33");
  });

  it("clears the queue and stops recording when init never arrives", async () => {
    vi.useFakeTimers();
    globalThis.fetch = fetchMock();
    installEarlyCapture();

    await globalThis.fetch("/api/first");
    expect(readEarlyCapture()?.entries).toHaveLength(1);

    vi.advanceTimersByTime(EARLY_IDLE_TIMEOUT_MS);
    expect(readEarlyCapture()?.entries).toHaveLength(0);
    expect(readEarlyCapture()?.stopped).toBe(true);

    await globalThis.fetch("/api/second");
    expect(readEarlyCapture()?.entries).toHaveLength(0);
    // The pass-through patch stays installed and the request still goes out.
    expect(globalThis.fetch).not.toBe(originalFetch);
  });

  it("is safe to import twice", async () => {
    const mock = fetchMock();
    globalThis.fetch = mock;
    const first = installEarlyCapture();
    const patchedOnce = globalThis.fetch;
    const second = installEarlyCapture();

    expect(second).toBe(first);
    expect(globalThis.fetch).toBe(patchedOnce);

    await globalThis.fetch("/api/cart");
    expect(readEarlyCapture()?.entries).toHaveLength(1);
  });

  it("records a network-level failure and rethrows it unchanged", async () => {
    const failure = new Error("offline");
    globalThis.fetch = vi.fn().mockRejectedValue(failure);
    installEarlyCapture();

    await expect(globalThis.fetch("/api/cart")).rejects.toBe(failure);

    const entry = readEarlyCapture()?.entries[0];
    expect(entry?.err).toBe("offline");
    expect(entry?.status).toBeUndefined();
  });

  it("records XHR requests and stamps their correlation headers", () => {
    globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;
    globalThis.fetch = fetchMock();
    const capture = installEarlyCapture();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/orders");
    xhr.send();

    const sent = MockXHR.instances[0];
    expect(sent.requestHeaders[CRUMBTRAIL_SESSION_HEADER]).toBe(
      capture?.sessionId,
    );
    expect(
      parseTraceparent(sent.requestHeaders[W3C_TRACEPARENT_HEADER]),
    ).toBeDefined();

    const entry = readEarlyCapture()?.entries[0];
    expect(entry?.transport).toBe("xhr");
    expect(entry?.url).toBe("/api/orders");
    expect(entry?.status).toBe(200);
    expect(entry?.resBody).toBe('{"ok":true}');
  });

  it("does not record after the SDK has drained", async () => {
    globalThis.fetch = fetchMock();
    installEarlyCapture();

    await globalThis.fetch("/api/first");
    expect(drainEarlyCapture()).toHaveLength(1);

    await globalThis.fetch("/api/second");
    expect(readEarlyCapture()?.entries).toHaveLength(0);
    expect(readEarlyCapture()?.deferred).toBe(true);
  });
});

describe("early capture drain", () => {
  let originalFetch: typeof globalThis.fetch;

  function collect(config = DEFAULT_CONFIG) {
    const events: BugEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((batch) => events.push(...batch));
    const cleanup = networkCollector(bus, config, {
      sessionId: "ses_live_1",
    });
    bus.flush();
    return { events, bus, cleanup };
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sessionStorage.clear();
  });

  afterEach(() => {
    uninstallEarlyCapture();
    globalThis.fetch = originalFetch;
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("emits net.req/net.res pairs at their original timestamps", async () => {
    globalThis.fetch = fetchMock('{"total":42}');
    const capture = installEarlyCapture();
    await globalThis.fetch("/api/cart");
    await settleBodies();
    const queued = readEarlyCapture()?.entries[0];

    const { events, cleanup } = collect();
    cleanup();

    const req = events.find((event) => event.k === "net.req");
    const res = events.find((event) => event.k === "net.res");
    expect(req?.t).toBe(queued?.t);
    expect(res?.t).toBe((queued?.t ?? 0) + (queued?.dur ?? 0));
    expect(req?.d.id).toBe(res?.d.id);
    expect(req?.d.early).toBe(true);
    expect(res?.d.early).toBe(true);
    expect(req?.d.url).toBe("/api/cart");
    expect(res?.d.st).toBe(200);
    expect(res?.d.body).toBe('{"total":42}');
    expect(res?.d.bodyMeta).toEqual({
      ct: "json",
      bytes: 12,
      data: { total: 42 },
    });
    expect(req?.d.sessionId).toBe(capture?.sessionId);
    expect(req?.d.requestId).toBe(queued?.requestId);
    expect(req?.d.traceId).toBe(queued?.traceId);
    expect(req?.d.spanId).toBe(queued?.spanId);
  });

  it("redacts a queued body through the live redaction policy", async () => {
    globalThis.fetch = fetchMock('{"sessionToken":"tok_live_abcdef123456"}');
    installEarlyCapture();
    await globalThis.fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "hunter2" }),
      headers: { "content-type": "application/json" },
    });
    await settleBodies();

    const { events, cleanup } = collect();
    cleanup();

    const req = events.find((event) => event.k === "net.req");
    const res = events.find((event) => event.k === "net.res");
    expect(String(req?.d.body)).not.toContain("hunter2");
    expect(String(res?.d.body)).not.toContain("tok_live_abcdef123456");
    expect(req?.d.redaction).toBeDefined();
  });

  it("emits net.err for a queued network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    installEarlyCapture();
    await expect(globalThis.fetch("/api/cart")).rejects.toThrow("offline");

    const { events, cleanup } = collect();
    cleanup();

    const err = events.find((event) => event.k === "net.err");
    expect(err?.d.msg).toBe("offline");
    expect(err?.d.early).toBe(true);
    expect(events.some((event) => event.k === "net.res")).toBe(false);
  });

  it("skips queued requests the config excludes", async () => {
    globalThis.fetch = fetchMock();
    installEarlyCapture();
    await globalThis.fetch("/api/cart");

    const { events, cleanup } = collect({
      ...DEFAULT_CONFIG,
      networkExcludeUrls: ["/api/cart"],
    });
    cleanup();

    expect(events.filter((event) => event.k === "net.req")).toHaveLength(0);
  });

  it("records a post-init request exactly once", async () => {
    globalThis.fetch = fetchMock();
    installEarlyCapture();

    const { events, bus, cleanup } = collect();
    await globalThis.fetch("/api/after-init");
    bus.flush();
    cleanup();

    expect(events.filter((event) => event.k === "net.req")).toHaveLength(1);
    expect(readEarlyCapture()?.entries).toHaveLength(0);
  });
});

describe("Crumbtrail.init session adoption", () => {
  let originalFetch: typeof globalThis.fetch;

  const transport = () => ({
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sessionStorage.clear();
  });

  afterEach(() => {
    uninstallEarlyCapture();
    globalThis.fetch = originalFetch;
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("adopts the session id early capture already put on the wire", async () => {
    globalThis.fetch = fetchMock();
    const capture = installEarlyCapture();

    const logger = Crumbtrail.init({
      transportInstance: transport(),
      sessionPersistence: "memory",
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    expect(logger.getSessionId()).toBe(capture?.sessionId);
    await logger.stop();
  });

  it("keeps the session id already sent on early requests over an explicit id", async () => {
    globalThis.fetch = fetchMock();
    const capture = installEarlyCapture();
    await globalThis.fetch("/api/cart");

    const logger = Crumbtrail.init({
      transportInstance: transport(),
      sessionId: "ses_explicit_1",
      sessionPersistence: "memory",
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    expect(logger.getSessionId()).toBe(capture?.sessionId);
    expect(readEarlyCapture()?.entries).toHaveLength(0);
    expect(readEarlyCapture()?.deferred).toBe(true);
    await logger.stop();
  });
});
