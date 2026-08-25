import { EventEmitter } from "node:events";
import type { BugEvent } from "crumbtrail-core";
import {
  BROWSER_REDACTION_POLICY,
  CAPTURE_GAP_EVENT_KIND,
  REDACTED_VALUE,
} from "crumbtrail-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushBackendEvents,
  resetBackendIntakeQueueForTest,
} from "../backend-intake";
import {
  BACKEND_REQUEST_END_EVENT,
  BACKEND_REQUEST_ERROR_EVENT,
  BACKEND_REQUEST_START_EVENT,
} from "../backend-events";
import {
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
  type CrumbtrailExpressRequest,
  type CrumbtrailExpressResponse,
  type CrumbtrailExpressWarning,
} from "../express";

class FakeResponse extends EventEmitter implements CrumbtrailExpressResponse {
  statusCode?: number;
  writableEnded?: boolean;

  constructor(statusCode?: number, writableEnded?: boolean) {
    super();
    this.statusCode = statusCode;
    this.writableEnded = writableEnded;
  }
}

describe("Crumbtrail Express-compatible middleware", () => {
  // The intake queue is process-wide, so a test that leaves entries in flight
  // would otherwise spend the next test's concurrency budget.
  beforeEach(() => resetBackendIntakeQueueForTest());

  it("emits start immediately, calls next synchronously, and emits one end event on finish", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "get",
      originalUrl: "/api/widgets?token=super-secret",
      headers: {
        "x-crumbtrail-session-id": "ses_123",
        "x-crumbtrail-request-id": "req_123",
      },
      route: { path: "/api/widgets" },
    });
    const res = new FakeResponse(204);
    const next = vi.fn();
    const now = sequenceClock(1_000, 1_037);

    const middleware = createCrumbtrailExpressMiddleware({ fetch, now });
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(extractEvent(fetch, 0)).toMatchObject({
      k: BACKEND_REQUEST_START_EVENT,
      sessionId: "ses_123",
      t: 1_000,
      d: {
        sessionId: "ses_123",
        requestId: "req_123",
        method: "GET",
        pathname: "/api/widgets",
        route: "/api/widgets",
      },
    });
    expect(res.listenerCount("finish")).toBe(1);

    res.emit("finish");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(extractEvent(fetch, 1)).toMatchObject({
      k: BACKEND_REQUEST_END_EVENT,
      sessionId: "ses_123",
      t: 1_037,
      d: {
        sessionId: "ses_123",
        requestId: "req_123",
        statusCode: 204,
        durationMs: 37,
      },
    });
    await flushPromises();
  });

  it("swallows rejected intake attempts and reports bounded warnings without affecting response flow", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error("network failed with local-secret-token"));
    const warnings: CrumbtrailExpressWarning[] = [];
    const req = fakeRequest({
      method: "POST",
      url: "/api/save",
      headers: {
        "x-crumbtrail-session-id": "ses_warn",
        "x-crumbtrail-request-id": "req_warn",
      },
    });
    const res = new FakeResponse(201);
    const next = vi.fn();

    createCrumbtrailExpressMiddleware({
      fetch,
      authToken: "local-secret-token",
      onWarning: (warning) => warnings.push(warning),
      retries: 0,
      now: sequenceClock(10, 15),
    })(req, res, next);
    res.emit("finish");

    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);
    // Start, end, and the capture_gap that stands in for the end that never landed.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warnings).toEqual([
      expect.objectContaining({
        kind: "fetch-rejected",
        message:
          "Backend events could not reach the capture endpoint; nothing was captured",
        sessionId: "ses_warn",
        requestId: "req_warn",
      }),
      expect.objectContaining({
        kind: "fetch-rejected",
        message:
          "Backend events could not reach the capture endpoint; nothing was captured",
        sessionId: "ses_warn",
        requestId: "req_warn",
      }),
      expect.objectContaining({
        kind: "fetch-rejected",
        message:
          "Backend events could not reach the capture endpoint; nothing was captured",
        sessionId: "ses_warn",
        eventKind: CAPTURE_GAP_EVENT_KIND,
      }),
    ]);
    expect(JSON.stringify(warnings)).not.toContain("local-secret-token");
    expect(JSON.stringify(warnings)).not.toContain("network failed");
  });

  it("emits exactly one end when finish and close both fire for the same response", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "GET",
      url: "/api/calcs/runs",
      headers: {
        "x-crumbtrail-session-id": "ses_once",
        "x-crumbtrail-request-id": "req_once",
      },
    });
    const res = new FakeResponse(200, true);

    createCrumbtrailExpressMiddleware({ fetch, retries: 0 })(req, res, vi.fn());
    res.emit("finish");
    res.emit("close");
    await flushPromises();

    const kinds = sentKinds(fetch);
    expect(kinds.filter((kind) => kind === BACKEND_REQUEST_END_EVENT)).toEqual([
      BACKEND_REQUEST_END_EVENT,
    ]);
    expect(kinds).not.toContain(CAPTURE_GAP_EVENT_KIND);
  });

  it("emits an end when close arrives on a response that already ended, without a gap", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "POST",
      url: "/api/calcs/run",
      headers: {
        "x-crumbtrail-session-id": "ses_ended",
        "x-crumbtrail-request-id": "req_ended",
      },
    });
    const res = new FakeResponse(200, true);

    createCrumbtrailExpressMiddleware({ fetch, retries: 0 })(req, res, vi.fn());
    res.emit("close");
    await flushPromises();

    expect(sentKinds(fetch)).toEqual([
      BACKEND_REQUEST_START_EVENT,
      BACKEND_REQUEST_END_EVENT,
    ]);
  });

  it("records a capture gap naming the request when the response closes before it finished", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "POST",
      url: "/api/imports/7/run",
      headers: {
        "x-crumbtrail-session-id": "ses_abort",
        "x-crumbtrail-request-id": "req_abort",
      },
    });
    const res = new FakeResponse(200, false);

    createCrumbtrailExpressMiddleware({ fetch, retries: 0 })(req, res, vi.fn());
    res.emit("close");
    await flushPromises();

    expect(sentKinds(fetch)).toEqual([
      BACKEND_REQUEST_START_EVENT,
      CAPTURE_GAP_EVENT_KIND,
    ]);
    expect(extractEvent(fetch, 1)).toMatchObject({
      k: CAPTURE_GAP_EVENT_KIND,
      sessionId: "ses_abort",
      d: {
        kind: "capture_gap",
        surface: "backend_request",
        reason: "request_unterminated",
        requestId: "req_abort",
      },
    });
  });

  it("never emits both an end and an unterminated gap for one request", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "GET",
      url: "/api/tables/3/rows",
      headers: {
        "x-crumbtrail-session-id": "ses_guard",
        "x-crumbtrail-request-id": "req_guard",
      },
    });
    const res = new FakeResponse(200, false);

    createCrumbtrailExpressMiddleware({ fetch, retries: 0 })(req, res, vi.fn());
    // A close that beats finish must own the terminal record outright: the later
    // finish is ignored rather than adding a second one.
    res.emit("close");
    res.emit("finish");
    res.emit("close");
    await flushPromises();

    const kinds = sentKinds(fetch);
    expect(
      kinds.filter((kind) => kind === CAPTURE_GAP_EVENT_KIND),
    ).toHaveLength(1);
    expect(kinds).not.toContain(BACKEND_REQUEST_END_EVENT);
  });

  it("marks the request with a capture gap when the end event never reaches the endpoint", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "POST",
      url: "/api/admin/reseed",
      headers: {
        "x-crumbtrail-session-id": "ses_drop",
        "x-crumbtrail-request-id": "req_drop",
      },
    });
    const res = new FakeResponse(200, true);

    createCrumbtrailExpressMiddleware({ fetch, retries: 0 })(req, res, vi.fn());
    res.emit("finish");
    await settleSends();

    expect(extractEvent(fetch, 2)).toMatchObject({
      k: CAPTURE_GAP_EVENT_KIND,
      sessionId: "ses_drop",
      d: {
        surface: "backend_request",
        reason: "delivery_failed",
        requestId: "req_drop",
      },
    });
  });

  it("error middleware emits an error event with existing request state and passes the same error object through", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "PATCH",
      url: "/api/widgets/1",
      headers: {
        "x-crumbtrail-session-id": "ses_error",
        "x-crumbtrail-request-id": "req_error",
      },
    });
    const res = new FakeResponse(500);
    const error = Object.assign(new Error("boom"), { statusCode: 503 });
    const next = vi.fn();
    const errorNext = vi.fn();
    const now = sequenceClock(100, 145);

    createCrumbtrailExpressMiddleware({ fetch, now })(req, res, next);
    createCrumbtrailExpressErrorMiddleware({ fetch, now })(
      error,
      req,
      res,
      errorNext,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(errorNext).toHaveBeenCalledTimes(1);
    expect(errorNext).toHaveBeenCalledWith(error);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(extractEvent(fetch, 1)).toMatchObject({
      k: BACKEND_REQUEST_ERROR_EVENT,
      sessionId: "ses_error",
      t: 145,
      d: {
        sessionId: "ses_error",
        requestId: "req_error",
        statusCode: 500,
        durationMs: 45,
        error: {
          name: "Error",
          message: "boom",
          statusCode: 503,
        },
      },
    });
    await flushPromises();
  });

  it("error middleware works without request middleware and reports missing-session warnings with generated request IDs", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const warnings: CrumbtrailExpressWarning[] = [];
    const req = fakeRequest({
      method: "GET",
      url: "/api/no-session?secret=token-value",
    });
    const res = new FakeResponse(undefined);
    const error = new TypeError("standalone failure");
    const next = vi.fn();

    createCrumbtrailExpressErrorMiddleware({
      fetch,
      onWarning: (warning) => warnings.push(warning),
      now: sequenceClock(500),
    })(error, req, res, next);

    await flushPromises();

    expect(next).toHaveBeenCalledWith(error);
    expect(fetch).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "missing-session",
      eventKind: BACKEND_REQUEST_ERROR_EVENT,
      requestId: expect.stringMatching(/^backend_req_/),
    });
  });

  it("generates a stable per-request ID when only the session is available", () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "GET",
      path: "/health",
      headers: { "x-crumbtrail-session-id": "ses_generated" },
    });
    const res = new FakeResponse(200);

    createCrumbtrailExpressMiddleware({ fetch, now: sequenceClock(1, 2) })(
      req,
      res,
      vi.fn(),
    );
    res.emit("finish");

    const start = extractEvent(fetch, 0);
    const end = extractEvent(fetch, 1);
    expect(start.d.requestId).toEqual(expect.stringMatching(/^backend_req_/));
    expect(end.d.requestId).toBe(start.d.requestId);
    expect(req.headers?.["x-crumbtrail-request-id"]).toBe(start.d.requestId);
    expect(start.d.correlation).toMatchObject({
      status: "generated-request-id",
      sessionIdSource: "header",
      requestIdSource: "generated",
    });
    expect(end.d.correlation).toMatchObject({
      status: "linked",
      sessionIdSource: "option",
      requestIdSource: "option",
    });
  });

  it("captures a runtime warning into the session the middleware last saw", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "GET",
      path: "/api/health",
      headers: {
        "x-crumbtrail-session-id": "ses_warned",
        "x-crumbtrail-request-id": "req_warned",
      },
    });
    const res = new FakeResponse(200);

    const middleware = createCrumbtrailExpressMiddleware({
      fetch,
      // Date.now-scale timestamps so the freshness window uses real arithmetic.
      now: sequenceClock(1_700_000_000_000, 1_700_000_000_004),
    });
    try {
      middleware(req, res, vi.fn());

      const warning = Object.assign(
        new Error(
          "Possible EventEmitter memory leak detected. 11 flush listeners added.",
        ),
        { name: "MaxListenersExceededWarning" },
      );
      process.emitWarning(warning);
      // `process.emitWarning` delivers on a later tick, not synchronously.
      await new Promise((resolve) => setImmediate(resolve));
      await flushPromises();

      const warningCalls = fetch.mock.calls
        .map((call) => JSON.parse(String(call[1]?.body)).events[0] as BugEvent)
        .filter((event) => event.k === "backend.warning");
      expect(warningCalls).toHaveLength(1);
      expect(warningCalls[0]).toMatchObject({
        sessionId: "ses_warned",
        d: {
          name: "MaxListenersExceededWarning",
          message: expect.stringContaining("11 flush listeners"),
        },
      });
    } finally {
      middleware.crumbtrailWarningCapture?.stop();
    }
  });

  it("drops a runtime warning observed before any session-bearing request", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const middleware = createCrumbtrailExpressMiddleware({ fetch });
    try {
      process.emitWarning(new Error("orphan warning"));
      await new Promise((resolve) => setImmediate(resolve));
      await flushPromises();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      middleware.crumbtrailWarningCapture?.stop();
    }
  });

  it("does not leak raw query values, headers, body fields, or auth tokens into captured payloads", () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "POST",
      originalUrl: "/api/search?q=visible&access_token=secret-token",
      headers: {
        "x-crumbtrail-session-id": "ses_redact",
        "x-crumbtrail-request-id": "req_redact",
        authorization: "Bearer should-not-leak",
        cookie: "sid=also-secret",
      },
      route: { path: "/api/sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      body: { token: "body-secret" },
    });
    const res = new FakeResponse(200);

    createCrumbtrailExpressMiddleware({
      fetch,
      authToken: "intake-auth-token",
      now: sequenceClock(1, 2),
    })(req, res, vi.fn());
    res.emit("finish");

    const start = extractEvent(fetch, 0);
    const serializedPayloads = JSON.stringify(
      fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    );

    expect(start.d.url).toBe(
      `/api/search?q=${REDACTED_VALUE}&access_token=${REDACTED_VALUE}`,
    );
    expect(start.d.redaction).toMatchObject({
      policy: BROWSER_REDACTION_POLICY,
      fields: expect.arrayContaining([
        expect.objectContaining({ path: "url.query.q", action: "redacted" }),
        expect.objectContaining({
          path: "url.query.access_token",
          action: "redacted",
        }),
        expect.objectContaining({ path: "route", action: "redacted" }),
      ]),
    });
    expect(serializedPayloads).not.toContain("visible");
    expect(serializedPayloads).not.toContain("secret-token");
    expect(serializedPayloads).not.toContain("should-not-leak");
    expect(serializedPayloads).not.toContain("also-secret");
    expect(serializedPayloads).not.toContain("body-secret");
    expect(serializedPayloads).not.toContain("intake-auth-token");
  });
});

function fakeRequest(
  input: CrumbtrailExpressRequest & Record<string, unknown>,
): CrumbtrailExpressRequest {
  return input;
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue('{"ok":true}'),
  };
}

function extractEvent(
  fetch: ReturnType<typeof vi.fn>,
  index: number,
): BugEvent {
  const body = JSON.parse(String(fetch.mock.calls[index]?.[1]?.body));
  return body.events[0] as BugEvent;
}

function sequenceClock(...values: number[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

/**
 * Settles the send chain.
 *
 * Sends go through the intake queue, so a post is issued a turn or more after
 * the call that asked for it, and a failed delivery schedules a follow-up event
 * only once it has failed. Draining repeatedly reaches the fixed point rather
 * than guessing a tick count.
 */
async function flushPromises() {
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve();
    await flushBackendEvents();
  }
}

/** Drains the send chain, including the follow-up a failed delivery schedules. */
async function settleSends() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function sentKinds(fetch: ReturnType<typeof vi.fn>): string[] {
  return fetch.mock.calls.map(
    (_call, index) => extractEvent(fetch, index).k as string,
  );
}
