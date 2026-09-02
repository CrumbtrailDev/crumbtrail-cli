import { describe, expect, it, vi } from "vitest";
import {
  captureToken,
  extractCrumbtrailContext,
  getBackendRequestContext,
  injectCrumbtrailContext,
  runInBackendRequestContext,
  validateCrumbtrailContextToken,
  withCausalContext,
  withCrumbtrailJob,
  type BackendEventSink,
  type CrumbtrailContextToken,
} from "../index";
import type { BugEvent } from "crumbtrail-core";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const PARENT_SPAN = "0123456789abcdef";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN}-01`;

function token(
  overrides: Partial<CrumbtrailContextToken> = {},
): CrumbtrailContextToken {
  return {
    v: 1,
    sessionId: "session_parent",
    requestId: "request_parent",
    traceparent: TRACEPARENT,
    enqueuedAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

describe("distributed context", () => {
  it("rejects malformed and zero W3C or carrier ids", () => {
    expect(
      validateCrumbtrailContextToken(
        token({ traceparent: `00-${"0".repeat(32)}-${PARENT_SPAN}-01` }),
        1_500,
      ),
    ).toBeUndefined();
    expect(
      validateCrumbtrailContextToken(
        token({ traceparent: `00-${TRACE_ID}-${"0".repeat(16)}-01` }),
        1_500,
      ),
    ).toBeUndefined();
    expect(
      validateCrumbtrailContextToken(token({ requestId: "0" }), 1_500),
    ).toBeUndefined();
    expect(
      validateCrumbtrailContextToken(token({ sessionId: "0" }), 1_500),
    ).toBeUndefined();
    expect(
      validateCrumbtrailContextToken(token({ v: 2 as unknown as 1 }), 1_500),
    ).toBeUndefined();
    expect(
      validateCrumbtrailContextToken({ ...token(), unexpected: true }, 1_500),
    ).toBeUndefined();
  });

  it("bounds trace state and rejects expired tokens", () => {
    expect(
      validateCrumbtrailContextToken(
        token({ tracestate: "vendor=value" }),
        1_500,
      ),
    ).toBeDefined();
    expect(
      validateCrumbtrailContextToken(
        token({ tracestate: "vendor=value=" }),
        1_500,
      ),
    ).toBeUndefined();
    expect(validateCrumbtrailContextToken(token(), 2_000)).toBeUndefined();
    expect(
      validateCrumbtrailContextToken(token({ expiresAt: 900 }), 1_500),
    ).toBeUndefined();
    expect(
      validateCrumbtrailContextToken(token({ tracestate: "x=" }), 1_500),
    ).toBeUndefined();
    expect(
      validateCrumbtrailContextToken(
        token({ tracestate: "x=one,x=two" }),
        1_500,
      ),
    ).toBeUndefined();
  });

  it("captures the active context and creates a child span across awaits", async () => {
    await runInBackendRequestContext(
      {
        sessionId: "session_parent",
        requestId: "request_parent",
        traceparent: TRACEPARENT,
        tracestate: "vendor=value",
      },
      async () => {
        const captured = captureToken({ now: 1_000 });
        expect(captured).toMatchObject({
          sessionId: "session_parent",
          requestId: "request_parent",
          traceparent: TRACEPARENT,
          enqueuedAt: 1_000,
          expiresAt: 901_000,
        });

        const seen = await withCausalContext(
          captured as CrumbtrailContextToken,
          async () => {
            await Promise.resolve();
            const context = getBackendRequestContext();
            return context;
          },
          { now: 1_001 },
        );
        expect(seen).toMatchObject({
          sessionId: "session_parent",
          requestId: "request_parent",
          tracestate: "vendor=value",
        });
        expect(seen?.traceparent).toMatch(
          new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`),
        );
        expect(seen?.traceparent).not.toBe(TRACEPARENT);
      },
    );
  });

  it("round trips a namespaced carrier without accepting untrusted fields", () => {
    const carrier: Record<string, unknown> = {};
    const now = Date.now();
    const original = token({ enqueuedAt: now - 1_000, expiresAt: now + 1_000 });
    injectCrumbtrailContext(carrier, original);
    expect(extractCrumbtrailContext(carrier)).toEqual(original);
    expect(
      extractCrumbtrailContext({
        __crumbtrail: { ...original, traceparent: "00-invalid" },
      }),
    ).toBeUndefined();
  });

  it("fails closed before user code for an invalid context", async () => {
    const handler = vi.fn();
    await expect(
      withCausalContext(token({ expiresAt: 10 }), handler, { now: 10 }),
    ).rejects.toThrow("Invalid or expired");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withCrumbtrailJob", () => {
  function sinkHarness(): {
    sink: BackendEventSink;
    order: string[];
    childEvents: BugEvent[];
    losses: Array<{ phase: string; error: unknown }>;
  } {
    const order: string[] = [];
    const childEvents: BugEvent[] = [];
    const losses: Array<{ phase: string; error: unknown }> = [];
    const child: BackendEventSink = {
      sessionId: "job_child",
      record: async (events) => {
        order.push("record");
        childEvents.push(...(Array.isArray(events) ? events : [events]));
      },
      flush: async () => {
        order.push("flush");
      },
      end: async () => {
        order.push("end");
      },
    };
    const sink: BackendEventSink = {
      sessionId: "session_parent",
      record: async () => undefined,
      startChildSession: async () => {
        order.push("start-session");
        return child;
      },
      linkSessions: async () => {
        order.push("link");
      },
    };
    return { sink, order, childEvents, losses };
  }

  it("links before execution and emits one start and one successful terminal event", async () => {
    const harness = sinkHarness();
    const result = await withCrumbtrailJob(
      {
        name: "record-payment",
        queue: "payments",
        jobId: "job_991",
        attempt: 2,
        context: token(),
        sink: harness.sink,
        now: () => 1_500,
        onCaptureLoss: (error, phase) => harness.losses.push({ error, phase }),
      },
      async (context) => {
        harness.order.push("handler");
        expect(context.sessionId).toBe("job_child");
        expect(getBackendRequestContext()).toMatchObject({
          sessionId: "job_child",
          requestId: "request_parent",
        });
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(harness.order).toEqual([
      "start-session",
      "link",
      "record",
      "handler",
      "record",
      "flush",
      "end",
    ]);
    expect(
      harness.childEvents.filter((event) => event.k === "backend.job.start"),
    ).toHaveLength(1);
    expect(
      harness.childEvents.filter((event) => event.k === "backend.job.end"),
    ).toHaveLength(1);
    expect(
      harness.childEvents.filter((event) => event.k === "backend.job.error"),
    ).toHaveLength(0);
    expect(harness.losses).toEqual([]);
  });

  it("preserves the original business error when link, terminal, or cleanup capture fails", async () => {
    const childEvents: BugEvent[] = [];
    const original = new Error("payment failed");
    const terminalFailure = new Error("capture endpoint unavailable");
    const sink: BackendEventSink = {
      sessionId: "session_parent",
      record: async () => undefined,
      startChildSession: async () => ({
        sessionId: "job_child",
        record: async (events) => {
          const eventList = Array.isArray(events) ? events : [events];
          childEvents.push(...eventList);
          if (eventList.some((event) => event.k === "backend.job.error"))
            throw terminalFailure;
        },
        end: async () => {
          throw new Error("cleanup failed");
        },
      }),
      linkSessions: async () => {
        throw new Error("link failed");
      },
    };
    const losses: string[] = [];
    await expect(
      withCrumbtrailJob(
        {
          name: "record-payment",
          context: token(),
          sink,
          now: () => 1_500,
          onCaptureLoss: (_error, phase) => losses.push(phase),
        },
        () => {
          throw original;
        },
      ),
    ).rejects.toBe(original);
    expect(
      childEvents.filter((event) => event.k === "backend.job.start"),
    ).toHaveLength(1);
    expect(
      childEvents.filter((event) => event.k === "backend.job.error"),
    ).toHaveLength(1);
    expect(losses).toEqual(["session-link", "terminal", "session-end"]);
  });

  it("uses the existing HTTP session, link, event, and end routes in order", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >,
        });
        return new Response("{}", { status: 200 });
      },
    );
    const result = await withCrumbtrailJob(
      {
        endpoint: "http://capture.test",
        authToken: "key_test",
        fetchImpl,
        name: "record-payment",
        queue: "payments",
        jobId: "job_1",
        context: token(),
        now: () => 1_500,
      },
      () => "ok",
    );
    expect(result).toBe("ok");
    expect(calls.map((call) => call.url)).toEqual([
      "http://capture.test/api/session/start",
      "http://capture.test/api/session/link",
      "http://capture.test/api/events",
      "http://capture.test/api/events",
      "http://capture.test/api/session/end",
    ]);
    expect(calls[1]?.body).toMatchObject({
      fromSessionId: "session_parent",
      relation: "caused",
      method: "trace_context",
      confidence: 1,
    });
    const eventCalls = calls.filter((call) => call.url.endsWith("/api/events"));
    expect(
      (eventCalls[0]?.body.events as Array<Record<string, unknown>>)[0]?.k,
    ).toBe("backend.job.start");
    expect(
      (eventCalls[1]?.body.events as Array<Record<string, unknown>>)[0]?.k,
    ).toBe("backend.job.end");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
