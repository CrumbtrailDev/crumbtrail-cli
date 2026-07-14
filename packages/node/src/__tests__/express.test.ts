import { EventEmitter } from "node:events";
import type { BugEvent } from "crumbtrail-core";
import { BROWSER_REDACTION_POLICY, REDACTED_VALUE } from "crumbtrail-core";
import { describe, expect, it, vi } from "vitest";
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

  constructor(statusCode?: number) {
    super();
    this.statusCode = statusCode;
  }
}

describe("Crumbtrail Express-compatible middleware", () => {
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
      now: sequenceClock(10, 15),
    })(req, res, next);
    res.emit("finish");

    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([
      expect.objectContaining({
        kind: "fetch-rejected",
        message: "Error",
        sessionId: "ses_warn",
        requestId: "req_warn",
      }),
      expect.objectContaining({
        kind: "fetch-rejected",
        message: "Error",
        sessionId: "ses_warn",
        requestId: "req_warn",
      }),
    ]);
    expect(JSON.stringify(warnings)).not.toContain("local-secret-token");
    expect(JSON.stringify(warnings)).not.toContain("network failed");
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
      `/api/search?q=${encodeURIComponent(REDACTED_VALUE)}&access_token=${encodeURIComponent(REDACTED_VALUE)}`,
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

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}
