import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { isHighSeverityEvent } from "../fast-finalize";
import { buildBackendLogEvent, parseStructuredLogLine } from "../backend-logs";

/** The pino line the persona's Hono API actually wrote, captured verbatim. */
const PINO_503_LINE = JSON.stringify({
  level: 50,
  time: 1_700_000_000_500,
  pid: 7,
  hostname: "api",
  reqId: "req-9",
  status: 503,
  err: {
    type: "UpstreamError",
    message: "keepa product lookup failed: upstream returned 429",
    stack:
      "UpstreamError: keepa product lookup failed: upstream returned 429\n    at fetchKeepaProduct (/app/src/services/keepa/fetchProduct.ts:68:11)\n    at async getProduct (/app/src/routes/product.ts:22:20)",
  },
  msg: "request failed",
});

function logEvent(line: string, t = 10): BugEvent {
  return buildBackendLogEvent(parseStructuredLogLine(line)!, { now: t });
}

function candidatesFor(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (candidate) => candidate.detector === "backend_log_error",
  );
}

describe("backend_log_error", () => {
  it("surfaces the logged cause of a 503 the process handled and survived", () => {
    const [candidate] = candidatesFor([logEvent(PINO_503_LINE)]);
    expect(candidate).toBeDefined();
    expect(candidate.severity).toBe("high");
    expect(candidate.title).toContain("request failed");
    expect(candidate.title).toContain("upstream returned 429");
    expect(candidate.anchor.requestId).toBe("req-9");
    expect(candidate.anchor.status).toBe(503);
    expect(candidate.anchor.errorCode).toBe("UpstreamError");
  });

  it("prefers the SDK's stamped request id over the logger's own field", () => {
    const event = buildBackendLogEvent(parseStructuredLogLine(PINO_503_LINE)!, {
      now: 10,
      requestId: "c70509ea9b1f4d3ea1d8b0f2c3a45671",
    });
    const [candidate] = candidatesFor([event]);
    expect(candidate.anchor.requestId).toBe("c70509ea9b1f4d3ea1d8b0f2c3a45671");
  });

  it("keeps a warn-level line, but under anything that names a fault", () => {
    const [warn] = candidatesFor([
      logEvent('{"level":40,"msg":"retrying upstream"}'),
    ]);
    const [error] = candidatesFor([logEvent(PINO_503_LINE)]);
    expect(warn.severity).toBe("medium");
    expect(warn.score).toBeLessThan(error.score);
  });

  it("ignores info and debug lines entirely", () => {
    expect(
      candidatesFor([
        logEvent('{"level":30,"msg":"listening on 3000"}'),
        logEvent('{"level":20,"msg":"cache hit"}'),
      ]),
    ).toEqual([]);
  });

  it("collapses one upstream outage logged per request into a single finding", () => {
    const candidates = candidatesFor([
      logEvent(PINO_503_LINE, 10),
      logEvent(PINO_503_LINE, 20),
      logEvent(PINO_503_LINE, 30),
    ]);
    expect(candidates).toHaveLength(1);
  });

  it("treats a logged error as high severity for fast finalize, a warn as not", () => {
    expect(isHighSeverityEvent(logEvent(PINO_503_LINE))).toBe(true);
    expect(
      isHighSeverityEvent(logEvent('{"level":60,"msg":"shutting down"}')),
    ).toBe(true);
    expect(
      isHighSeverityEvent(logEvent('{"level":40,"msg":"retrying upstream"}')),
    ).toBe(false);
  });
});
