import { describe, expect, it } from "vitest";
import { BACKEND_REDACTION_POLICY } from "crumbtrail-core";
import {
  buildBackendJobEndEvent,
  buildBackendJobErrorEvent,
  buildBackendRequestEndEvent,
} from "../backend-events";
import { buildCacheEvent } from "../cache/event";
import { buildDbReadEvent } from "../db/read-event";

/**
 * Nothing in this package runs in a browser. An event that says a browser
 * redacted it is telling the capture server the wrong thing about where the
 * body came from, which is the one fact the server's body-retention gate turns
 * on.
 */
function policyOf(payload: Record<string, unknown>): string | undefined {
  const redaction = payload.redaction as { policy?: string } | undefined;
  return redaction?.policy;
}

describe("backend events declare the backend plane", () => {
  it("stamps a redacted response body with the backend policy", () => {
    const event = buildBackendRequestEndEvent({
      now: 1000,
      sessionId: "ses_plane",
      requestId: "req_plane",
      url: "/api/checkout",
      statusCode: 500,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        password: "hunter2!",
        message: "constraint violated",
      }),
    });

    expect(policyOf(event.d)).toBe(BACKEND_REDACTION_POLICY);
    expect(JSON.parse(event.d.responseBody as string).password).not.toBe(
      "hunter2!",
    );
  });

  it("stamps a redacted job result with the backend policy", () => {
    const event = buildBackendJobEndEvent({
      now: 1000,
      sessionId: "ses_plane",
      requestId: "req_plane",
      name: "charge.capture",
      result: JSON.stringify({ apiKey: "sk_live_abcdef123456", captured: 1 }),
    });

    expect(policyOf(event.d)).toBe(BACKEND_REDACTION_POLICY);
  });

  it("stamps a long route, which used to hand-type the browser id", () => {
    const event = buildBackendRequestEndEvent({
      now: 1000,
      sessionId: "ses_plane",
      requestId: "req_plane",
      url: "/api/resource",
      route: `/api/${"segment/".repeat(80)}end`,
      statusCode: 200,
    });

    expect(event.d.routeTruncated).toBe(true);
    expect(policyOf(event.d)).toBe(BACKEND_REDACTION_POLICY);
  });

  it("stamps an error message truncation, the other hand-typed literal", () => {
    const event = buildBackendJobErrorEvent({
      now: 1000,
      sessionId: "ses_plane",
      requestId: "req_plane",
      name: "charge.capture",
      error: new Error("failure ".repeat(400)),
    });

    expect(policyOf(event.d)).toBe(BACKEND_REDACTION_POLICY);
  });

  it("stamps cache events", () => {
    const event = buildCacheEvent({
      driver: "ioredis",
      op: "get",
      keys: ["session:alice@example.com:cart"],
      requestId: "req_plane",
      value: { token: "sk_live_abcdef123456" },
      now: 1000,
    });

    expect(policyOf(event.d)).toBe(BACKEND_REDACTION_POLICY);
  });

  it("stamps database read events", () => {
    const event = buildDbReadEvent({
      table: "users",
      requestId: "req_plane",
      pk: { id: 7 },
      row: { id: 7, email: "alice@example.com" },
      now: 1000,
    });

    expect(policyOf(event.d)).toBe(BACKEND_REDACTION_POLICY);
  });
});
