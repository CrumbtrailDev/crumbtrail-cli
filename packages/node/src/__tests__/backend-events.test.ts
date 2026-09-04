import { describe, expect, it } from "vitest";
import {
  CAPTURE_GAP_EVENT_KIND,
  BACKEND_REDACTION_POLICY,
  REDACTED_VALUE,
  createCrumbtrailRequestHeaders,
  type BugEvent,
} from "crumbtrail-core";
import {
  BACKEND_REQUEST_END_EVENT,
  BACKEND_REQUEST_ERROR_EVENT,
  BACKEND_REQUEST_START_EVENT,
  buildBackendRequestEndEvent,
  buildBackendRequestErrorEvent,
  buildBackendRequestStartEvent,
} from "../backend-events";
import { instrumentPgClient, resolveDbRequestContext } from "../db";

/**
 * `db.statement` is emitted for EVERY instrumented statement, whatever it returned, so it appears
 * in every stream in this file and is evidence about neither row reads nor row diffs — which is
 * what these suites bind. Its own behaviour, including that it survives when nothing else is
 * captured, is bound in `db-successful-statement.test.ts`.
 */
const notStatement = (event: BugEvent): boolean => event.k !== "db.statement";

describe("backend event contract helpers", () => {
  it("links backend start events from core-created Crumbtrail request headers", () => {
    const headers = createCrumbtrailRequestHeaders(
      "ses_core_helper",
      "req_core_helper",
    );
    const event = buildBackendRequestStartEvent({
      now: 1_700_000_000_200,
      sessionStartedAt: 1_700_000_000_000,
      method: "POST",
      url: "/api/linked-contract",
      headers,
    });

    expect(event).toMatchObject({
      k: BACKEND_REQUEST_START_EVENT,
      t: 1_700_000_000_200,
      sessionId: "ses_core_helper",
      offsetMs: 200,
      d: {
        sessionId: "ses_core_helper",
        requestId: "req_core_helper",
        method: "POST",
        pathname: "/api/linked-contract",
        correlation: {
          status: "linked",
          sessionIdSource: "header",
          requestIdSource: "header",
        },
      },
    });
  });

  it("builds linked start events from Crumbtrail correlation headers", () => {
    const event = buildBackendRequestStartEvent({
      now: 1_700_000_000_100,
      sessionStartedAt: 1_700_000_000_000,
      method: "get",
      url: "/api/widgets?token=secret#fragment",
      headers: {
        "X-Crumbtrail-Session-Id": " ses_123 ",
        "x-crumbtrail-request-id": " req_456 ",
        authorization: "Bearer should-never-appear",
        cookie: "sid=should-never-appear",
      },
    });

    expect(event).toMatchObject({
      k: BACKEND_REQUEST_START_EVENT,
      t: 1_700_000_000_100,
      sessionId: "ses_123",
      offsetMs: 100,
      d: {
        sessionId: "ses_123",
        requestId: "req_456",
        method: "GET",
        pathname: "/api/widgets",
        url: "/api/widgets?token=[REDACTED;len=6;charset=alpha]",
        correlation: {
          status: "linked",
          sessionIdSource: "header",
          requestIdSource: "header",
        },
      },
    });
    expect(JSON.stringify(event.d)).not.toContain("should-never-appear");
  });

  it("allows option-provided IDs to override structural headers", () => {
    const event = buildBackendRequestEndEvent({
      now: 200,
      sessionStartedAt: 50,
      method: "POST",
      url: "https://example.test/submit?email=a@example.test",
      headers: {
        "x-crumbtrail-session-id": "ses_header",
        "x-crumbtrail-request-id": "req_header",
      },
      sessionId: "ses_option",
      requestId: "req_option",
      statusCode: 201,
      durationMs: 14.6,
    });

    expect(event).toMatchObject({
      k: BACKEND_REQUEST_END_EVENT,
      sessionId: "ses_option",
      offsetMs: 150,
      d: {
        sessionId: "ses_option",
        requestId: "req_option",
        statusCode: 201,
        durationMs: 15,
        pathname: "/submit",
        correlation: {
          status: "linked",
          sessionIdSource: "option",
          requestIdSource: "option",
        },
      },
    });
  });

  it("generates a bounded backend-local request ID when the request ID is missing", () => {
    const event = buildBackendRequestStartEvent({
      now: 1000,
      sessionId: "ses_only",
      method: "GET",
      path: "/health",
    });

    expect(event.sessionId).toBe("ses_only");
    expect(event.d.requestId).toEqual(
      expect.stringMatching(/^backend_req_[a-z0-9]+_[a-z0-9]+$/),
    );
    expect(String(event.d.requestId).length).toBeLessThanOrEqual(128);
    expect(event.d.correlation).toMatchObject({
      status: "generated-request-id",
      sessionIdSource: "option",
      requestIdSource: "generated",
    });
  });

  it("marks missing session without dropping the request ID", () => {
    const event = buildBackendRequestStartEvent({
      now: 1000,
      requestId: "req_without_session",
      method: "GET",
      url: "/api/no-session",
    });

    expect(event.sessionId).toBeUndefined();
    expect(event.offsetMs).toBeUndefined();
    expect(event.d).toMatchObject({
      requestId: "req_without_session",
      correlation: {
        status: "missing-session",
        sessionIdSource: "missing",
        requestIdSource: "option",
      },
    });
  });

  it("marks missing session and missing request ID while still emitting a generated request ID", () => {
    const event = buildBackendRequestStartEvent({
      now: 1000,
      method: "GET",
      url: "/api/unlinked",
    });

    expect(event.sessionId).toBeUndefined();
    expect(event.d.requestId).toEqual(expect.stringMatching(/^backend_req_/));
    expect(event.d.correlation).toMatchObject({
      status: "missing-session-and-request-id",
      sessionIdSource: "missing",
      requestIdSource: "generated",
    });
  });

  it("redacts query values and attaches backend redaction metadata", () => {
    const event = buildBackendRequestStartEvent({
      now: 1000,
      sessionId: "ses_redact",
      requestId: "req_redact",
      url: "/api/search?q=visible&access_token=secret-token&empty=",
    });

    expect(event.d.url).toBe(
      "/api/search?q=[REDACTED;len=7;charset=alpha]" +
        "&access_token=[REDACTED;len=12;charset=mixed]&empty=",
    );
    expect(event.d.pathname).toBe("/api/search");
    expect(event.d.redaction).toMatchObject({
      policy: BACKEND_REDACTION_POLICY,
      fields: expect.arrayContaining([
        expect.objectContaining({
          path: "url.query.q",
          reason: "url_query_value",
          action: "redacted",
        }),
        expect.objectContaining({
          path: "url.query.access_token",
          reason: "url_query_value",
          action: "redacted",
        }),
      ]),
    });
  });

  it("bounds route values and redacts token-like route content", () => {
    const tokenLike = "sk_" + "a".repeat(44);
    const longRoute =
      `/api/${tokenLike}/` +
      Array.from({ length: 80 }, (_, index) => `segment${index}`).join("/");
    const event = buildBackendRequestStartEvent({
      now: 1000,
      sessionId: "ses_route",
      requestId: "req_route",
      route: longRoute,
      url: "/api/resource",
    });

    expect(event.d.route).toContain(REDACTED_VALUE);
    expect(String(event.d.route)).not.toContain(tokenLike);
    expect(String(event.d.route).length).toBeLessThanOrEqual(257);
    expect(event.d.routeTruncated).toBe(true);
    expect(event.d.redaction).toMatchObject({
      policy: BACKEND_REDACTION_POLICY,
      fields: expect.arrayContaining([
        expect.objectContaining({ path: "route", action: "redacted" }),
        expect.objectContaining({
          path: "route",
          reason: "route_too_long",
          action: "summarized",
        }),
      ]),
    });
  });

  it("classifies errors without exposing stack or arbitrary properties", () => {
    const error = Object.assign(new TypeError("Request failed safely"), {
      code: "E_SAFE",
      statusCode: 502,
      stack: "STACK SHOULD NOT BE SERIALIZED",
      authorization: "Bearer SHOULD_NOT_LEAK",
    });

    const event = buildBackendRequestErrorEvent({
      now: 1000,
      sessionId: "ses_error",
      requestId: "req_error",
      method: "GET",
      url: "/api/error",
      statusCode: 502,
      durationMs: 3,
      error,
    });

    expect(event).toMatchObject({
      k: BACKEND_REQUEST_ERROR_EVENT,
      d: {
        statusCode: 502,
        durationMs: 3,
        error: {
          name: "TypeError",
          message: "Request failed safely",
          code: "E_SAFE",
          statusCode: 502,
        },
      },
    });
    expect(JSON.stringify(event.d)).not.toContain(
      "STACK SHOULD NOT BE SERIALIZED",
    );
    expect(JSON.stringify(event.d)).not.toContain("SHOULD_NOT_LEAK");
  });

  // A 500 tells a reader that something failed and the message tells them what.
  // Neither names the line to change, so the agent handed the bundle still goes
  // looking — the same problem `db.diff` callsites already solve for writes.
  // The frames are parsed out of the thrown error and reported structurally;
  // the raw stack text still never rests, which the sibling test above pins.
  it("reports the app frames of a thrown error without serializing its stack", () => {
    const error = new Error("checkout failed");
    error.stack = [
      "Error: checkout failed",
      `    at placeOrder (${process.cwd()}/server/src/services/order-service.js:118:11)`,
      `    at async postCheckout (${process.cwd()}/server/src/routes/checkout.js:41:20)`,
      "    at node:internal/process/task_queues:95:5",
      `    at Layer.handle (${process.cwd()}/node_modules/express/lib/router/layer.js:95:5)`,
    ].join("\n");

    const event = buildBackendRequestErrorEvent({
      now: 1000,
      sessionId: "ses_frames",
      requestId: "req_frames",
      method: "POST",
      url: "/api/checkout",
      statusCode: 500,
      error,
    });

    // Innermost app frame first, repo-relative, with the caller chain above it.
    expect(event.d.error).toMatchObject({
      frames: [
        {
          file: "server/src/services/order-service.js",
          line: 118,
          column: 11,
          fn: "placeOrder",
        },
        {
          file: "server/src/routes/checkout.js",
          line: 41,
          column: 20,
          fn: "postCheckout",
        },
      ],
    });
    // Node internals and dependency frames are never the answer.
    expect(JSON.stringify(event.d)).not.toContain("node:internal");
    expect(JSON.stringify(event.d)).not.toContain("node_modules");
    // The raw stack string itself still does not rest.
    expect(JSON.stringify(event.d)).not.toContain("Error: checkout failed\n");
  });

  it("omits frames when the error carries no recognizable app frame", () => {
    const event = buildBackendRequestErrorEvent({
      now: 1000,
      sessionId: "ses_no_frames",
      requestId: "req_no_frames",
      url: "/api/error",
      error: Object.assign(new Error("opaque"), { stack: "Error: opaque" }),
    });

    expect(event.d.error).not.toHaveProperty("frames");
  });

  it("redacts token-like error details and records redaction policy metadata", () => {
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz1234567890";
    const event = buildBackendRequestErrorEvent({
      now: 1000,
      sessionId: "ses_secret_error",
      requestId: "req_secret_error",
      url: "/api/error",
      error: new Error(`upstream rejected ${secret}`),
    });

    expect(event.d.error).toMatchObject({
      name: "Error",
      message: `upstream rejected ${REDACTED_VALUE}`,
    });
    expect(JSON.stringify(event.d)).not.toContain(secret);
    expect(event.d.redaction).toMatchObject({
      policy: BACKEND_REDACTION_POLICY,
      fields: expect.arrayContaining([
        expect.objectContaining({
          path: "error.message",
          reason: "auth_scheme_token",
          action: "redacted",
        }),
      ]),
    });
  });

  it("omits offsetMs when sessionStartedAt is invalid", () => {
    const event = buildBackendRequestStartEvent({
      now: 1000,
      sessionStartedAt: Number.NaN,
      sessionId: "ses_no_offset",
      requestId: "req_no_offset",
      url: "/api/no-offset",
    });

    expect(event.offsetMs).toBeUndefined();
    expect(event.t).toBe(1000);
  });

  it("uses traceparent as the request id and preserves the database join after custom headers are stripped", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const input = {
      now: 1_700_000_000_000,
      method: "POST",
      url: "/api/orders",
      headers: {
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      },
    };
    const completenessEvents: BugEvent[] = [];
    const requestEvent = buildBackendRequestStartEvent({
      ...input,
      emit: (event) => completenessEvents.push(event),
    });
    const context = resolveDbRequestContext(input);
    const dbEvents: BugEvent[] = [];
    const client = {
      query: async (_text?: unknown, _params?: unknown) => ({
        rows: [{ id: 42, status: "created" }],
        rowCount: 1,
      }),
    };
    const db = instrumentPgClient(client, {
      ...context,
      emit: (event) => {
        if (notStatement(event)) dbEvents.push(event);
      },
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      "created",
      42,
    ]);

    expect(requestEvent.d).toMatchObject({
      requestId: traceId,
      correlation: {
        status: "missing-session",
        requestIdSource: "traceparent",
      },
    });
    expect(completenessEvents).toHaveLength(1);
    expect(completenessEvents[0]).toMatchObject({
      k: CAPTURE_GAP_EVENT_KIND,
      d: { surface: "backend_request", reason: "header_stripped" },
    });
    expect(dbEvents).toHaveLength(1);
    expect(dbEvents[0].d).toMatchObject({ requestId: traceId });
  });
});
