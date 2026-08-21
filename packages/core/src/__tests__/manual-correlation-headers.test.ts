// One correlation vocabulary on the wire, whether Crumbtrail stamped the
// request or the application did.
//
// The automatic path sets `X-Crumbtrail-Request-Id` to the 32 hex W3C trace id
// and emits `traceparent` beside it, which is what the OTLP `traceId →
// requestId` bridge joins on. The manual helper minted `req_<base36>_<random>`
// and no traceparent at all, so a request an app stamped itself carried a key
// no span will ever contain and no context for the backend to continue: client
// and backend evidence for it could never be joined.

import { describe, expect, it } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER,
  CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  W3C_TRACEPARENT_HEADER,
  parseTraceparent,
} from "../correlation";

function makeLogger() {
  return Crumbtrail.init({
    transportInstance: {
      sendEvents: async () => {},
      sendBlob: async () => {},
      startSession: async () => {},
      endSession: async () => {},
      sendBugReport: async () => {},
    },
    network: false,
    environment: false,
    domSnapshot: false,
    sessionPersistence: "memory",
    flushIntervalMs: 100_000,
    flushBufferSize: 1_000,
  });
}

describe("createRequestHeaders()", () => {
  it("mints the same key shape the automatic path uses, with a traceparent to join on", async () => {
    const logger = makeLogger();
    const headers = logger.createRequestHeaders();

    expect(headers[CRUMBTRAIL_SESSION_HEADER]).toBe(logger.getSessionId());
    const traceparent = parseTraceparent(headers[W3C_TRACEPARENT_HEADER]);
    expect(traceparent).toBeDefined();
    expect(headers[CRUMBTRAIL_REQUEST_HEADER]).toBe(traceparent?.traceId);
    expect(headers[CRUMBTRAIL_REQUEST_HEADER]).toMatch(/^[0-9a-f]{32}$/);

    await logger.stop();
  });

  it("still honors a request id the caller pinned, and still emits a traceparent", async () => {
    const logger = makeLogger();
    const headers = logger.createRequestHeaders("caller-request-1");

    expect(headers[CRUMBTRAIL_REQUEST_HEADER]).toBe("caller-request-1");
    expect(parseTraceparent(headers[W3C_TRACEPARENT_HEADER])).toBeDefined();

    await logger.stop();
  });

  it("falls back to the trace id, not to a second vocabulary, for an unusable caller id", async () => {
    const logger = makeLogger();
    const oversized = "x".repeat(CRUMBTRAIL_REQUEST_ID_MAX_LENGTH + 1);
    const headers = logger.createRequestHeaders(oversized);

    const traceparent = parseTraceparent(headers[W3C_TRACEPARENT_HEADER]);
    expect(headers[CRUMBTRAIL_REQUEST_HEADER]).toBe(traceparent?.traceId);

    await logger.stop();
  });
});
