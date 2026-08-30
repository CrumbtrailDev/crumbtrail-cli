import { describe, expect, it, vi } from "vitest";
import {
  SERVERLESS_INVOCATION_ERROR_EVENT,
  SERVERLESS_INVOCATION_START_EVENT,
  SERVERLESS_INVOCATION_SUCCESS_EVENT,
  SERVERLESS_LIMITS,
  runServerlessInvocation,
  type ServerlessInvocationEvent,
  type ServerlessInvocationTransport,
} from "../index";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

function collectingTransport() {
  const events: ServerlessInvocationEvent[] = [];
  const transport: ServerlessInvocationTransport = {
    capture(event) {
      events.push(event);
    },
    flush: vi.fn().mockResolvedValue(undefined),
  };
  return { events, transport };
}

function eventOf(
  events: ServerlessInvocationEvent[],
  kind: ServerlessInvocationEvent["k"],
): ServerlessInvocationEvent {
  const event = events.find((candidate) => candidate.k === kind);
  expect(event).toBeDefined();
  return event as ServerlessInvocationEvent;
}

describe("runServerlessInvocation", () => {
  it("captures one cold successful invocation and preserves its return value", async () => {
    const { events, transport } = collectingTransport();
    const times = [100, 125];

    const result = await runServerlessInvocation(
      {
        transport,
        method: "post",
        route: "/orders/:id",
        headers: {
          "X-Crumbtrail-Session-Id": "ses_cold",
          "X-Crumbtrail-Request-Id": "req_cold",
        },
        now: () => times.shift() ?? 125,
      },
      (context) => {
        context.setStatusCode(201);
        return { created: true };
      },
    );

    expect(result).toEqual({ created: true });
    expect(events.map((event) => event.k)).toEqual([
      SERVERLESS_INVOCATION_START_EVENT,
      SERVERLESS_INVOCATION_SUCCESS_EVENT,
    ]);
    expect(events[0]).toMatchObject({
      t: 100,
      sessionId: "ses_cold",
      d: {
        status: "started",
        durationMs: 0,
        method: "POST",
        route: "/orders/:id",
        requestId: "req_cold",
      },
    });
    expect(events[1]).toMatchObject({
      t: 125,
      sessionId: "ses_cold",
      d: {
        status: "success",
        durationMs: 25,
        statusCode: 201,
        route: "/orders/:id",
        requestId: "req_cold",
      },
    });
    expect(transport.flush).toHaveBeenCalledOnce();
  });

  it("does not reuse route, status, or error state across sequential warm calls", async () => {
    const { events, transport } = collectingTransport();
    const firstError = new TypeError("first failed");

    await expect(
      runServerlessInvocation(
        {
          transport,
          route: "/first",
          headers: {
            "x-crumbtrail-session-id": "ses_first",
            "x-crumbtrail-request-id": "req_first",
          },
        },
        (context) => {
          context.setRoute("/first/:id");
          context.setStatusCode(503);
          throw firstError;
        },
      ),
    ).rejects.toBe(firstError);

    await expect(
      runServerlessInvocation(
        {
          transport,
          headers: {
            "x-crumbtrail-session-id": "ses_second",
            "x-crumbtrail-request-id": "req_second",
          },
        },
        () => "second ok",
      ),
    ).resolves.toBe("second ok");

    const secondSuccess = events.find(
      (event) =>
        event.k === SERVERLESS_INVOCATION_SUCCESS_EVENT &&
        event.d.requestId === "req_second",
    );
    expect(secondSuccess).toMatchObject({
      sessionId: "ses_second",
      d: { status: "success", requestId: "req_second" },
    });
    expect(secondSuccess?.d).not.toHaveProperty("route");
    expect(secondSuccess?.d).not.toHaveProperty("statusCode");
    expect(secondSuccess?.d).not.toHaveProperty("error");
  });

  it("isolates deferred overlapping invocations that settle out of order", async () => {
    const { events, transport } = collectingTransport();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = runServerlessInvocation(
      {
        transport,
        route: "/first",
        headers: {
          "x-crumbtrail-session-id": "ses_first",
          "x-crumbtrail-request-id": "req_first",
        },
      },
      async (context) => {
        context.setRoute("/first/:id");
        context.setStatusCode(202);
        await firstGate;
        return "first";
      },
    );
    const second = runServerlessInvocation(
      {
        transport,
        route: "/second",
        headers: {
          "x-crumbtrail-session-id": "ses_second",
          "x-crumbtrail-request-id": "req_second",
        },
      },
      async (context) => {
        context.setRoute("/second/:slug");
        context.setStatusCode(204);
        await secondGate;
        return "second";
      },
    );

    releaseSecond();
    await expect(second).resolves.toBe("second");
    releaseFirst();
    await expect(first).resolves.toBe("first");

    const successes = events.filter(
      (event) => event.k === SERVERLESS_INVOCATION_SUCCESS_EVENT,
    );
    expect(successes).toHaveLength(2);
    expect(
      successes.find((event) => event.d.requestId === "req_first"),
    ).toMatchObject({
      sessionId: "ses_first",
      d: { route: "/first/:id", statusCode: 202 },
    });
    expect(
      successes.find((event) => event.d.requestId === "req_second"),
    ).toMatchObject({
      sessionId: "ses_second",
      d: { route: "/second/:slug", statusCode: 204 },
    });
  });

  it("preserves thrown error identity while emitting a bounded error event", async () => {
    const { events, transport } = collectingTransport();
    const error = Object.assign(
      new Error("m".repeat(SERVERLESS_LIMITS.errorMessageLength + 20)),
      {
        name: "N".repeat(SERVERLESS_LIMITS.errorNameLength + 20),
        code: "C".repeat(SERVERLESS_LIMITS.errorCodeLength + 20),
        stack: "secret stack must not be captured",
      },
    );

    await expect(
      runServerlessInvocation({ transport, route: "/failure" }, () => {
        throw error;
      }),
    ).rejects.toBe(error);

    const event = eventOf(events, SERVERLESS_INVOCATION_ERROR_EVENT);
    const captured = event.d.error as Record<string, unknown>;
    expect(event.d.status).toBe("error");
    expect(typeof event.d.durationMs).toBe("number");
    expect(String(captured.name)).toHaveLength(
      SERVERLESS_LIMITS.errorNameLength,
    );
    expect(String(captured.message)).toHaveLength(
      SERVERLESS_LIMITS.errorMessageLength,
    );
    expect(String(captured.code)).toHaveLength(
      SERVERLESS_LIMITS.errorCodeLength,
    );
    expect(captured).not.toHaveProperty("stack");
  });

  it("contains capture and flush rejection on a successful handler", async () => {
    const handler = vi.fn().mockResolvedValue("host result");
    const transport: ServerlessInvocationTransport = {
      capture: vi.fn().mockRejectedValue(new Error("capture failed")),
      flush: vi.fn().mockRejectedValue(new Error("flush failed")),
    };

    await expect(runServerlessInvocation({ transport }, handler)).resolves.toBe(
      "host result",
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(transport.capture).toHaveBeenCalledTimes(2);
    expect(transport.flush).toHaveBeenCalledOnce();
  });

  it("contains flush rejection and rethrows the original handler error", async () => {
    const original = new Error("handler failed");
    Object.defineProperty(original, "name", {
      get() {
        throw new Error("hostile error getter");
      },
    });
    const transport: ServerlessInvocationTransport = {
      capture: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error("flush failed")),
    };

    await expect(
      runServerlessInvocation({ transport }, () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(transport.flush).toHaveBeenCalledOnce();
  });

  it("bounds method, route, metadata, and status while excluding request and response bodies", async () => {
    const { events, transport } = collectingTransport();
    const metadata = {
      body: "request-body-secret",
      requestBody: "request-body-secret",
      responseBody: "response-body-secret",
      nested: { body: "nested-body-secret" },
      ...Object.fromEntries(
        Array.from(
          { length: SERVERLESS_LIMITS.metadataEntries + 8 },
          (_, index) => [
            `key-${index}`,
            `value-${index}-${"x".repeat(SERVERLESS_LIMITS.metadataValueLength + 20)}`,
          ],
        ),
      ),
    };

    await runServerlessInvocation(
      {
        transport,
        method: `post${"x".repeat(SERVERLESS_LIMITS.methodLength + 10)}`,
        route: `/${"r".repeat(SERVERLESS_LIMITS.routeLength + 20)}`,
        metadata,
        requestBody: "ignored request body",
        responseBody: "ignored response body",
      } as Parameters<typeof runServerlessInvocation>[0] & {
        requestBody: string;
        responseBody: string;
      },
      (context) => {
        context.setStatusCode(999);
        return { body: "ignored handler response" };
      },
    );

    const event = eventOf(events, SERVERLESS_INVOCATION_SUCCESS_EVENT);
    expect(String(event.d.method).length).toBeLessThanOrEqual(
      SERVERLESS_LIMITS.methodLength,
    );
    expect(String(event.d.route)).toHaveLength(SERVERLESS_LIMITS.routeLength);
    expect(event.d).not.toHaveProperty("statusCode");
    const capturedMetadata = event.d.metadata as Record<string, unknown>;
    expect(Object.keys(capturedMetadata)).toHaveLength(
      SERVERLESS_LIMITS.metadataEntries,
    );
    expect(
      Object.values(capturedMetadata).every(
        (value) =>
          String(value).length <= SERVERLESS_LIMITS.metadataValueLength,
      ),
    ).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("request-body-secret");
    expect(serialized).not.toContain("response-body-secret");
    expect(serialized).not.toContain("nested-body-secret");
    expect(serialized).not.toContain("ignored request body");
    expect(serialized).not.toContain("ignored handler response");
  });

  it("adopts valid Crumbtrail headers and W3C trace context", async () => {
    const { events, transport } = collectingTransport();

    await runServerlessInvocation(
      {
        transport,
        headers: new Headers({
          "X-Crumbtrail-Session-Id": " ses_valid ",
          "X-Crumbtrail-Request-Id": "req_valid",
          traceparent: TRACEPARENT,
        }),
      },
      () => undefined,
    );

    const event = eventOf(events, SERVERLESS_INVOCATION_START_EVENT);
    expect(event).toMatchObject({
      sessionId: "ses_valid",
      d: {
        requestId: "req_valid",
        correlation: {
          status: "linked",
          sessionIdSource: "header",
          requestIdSource: "header",
          traceId: TRACE_ID,
          spanId: "00f067aa0ba902b7",
          flags: 1,
        },
      },
    });
  });

  it("replaces invalid or oversized correlation and adopts a valid traceparent fallback", async () => {
    const first = collectingTransport();
    await runServerlessInvocation(
      {
        transport: first.transport,
        headers: {
          "x-crumbtrail-session-id": "s".repeat(
            SERVERLESS_LIMITS.sessionIdLength + 1,
          ),
          "x-crumbtrail-request-id": "r".repeat(
            SERVERLESS_LIMITS.requestIdLength + 1,
          ),
          traceparent: TRACEPARENT,
        },
      },
      () => undefined,
    );
    const fallback = eventOf(first.events, SERVERLESS_INVOCATION_START_EVENT);
    expect(fallback.sessionId).toBeUndefined();
    expect(fallback.d.requestId).toBe(TRACE_ID);
    expect(fallback.d.correlation).toMatchObject({
      status: "missing-session",
      sessionIdSource: "missing",
      requestIdSource: "traceparent",
      traceId: TRACE_ID,
    });

    const second = collectingTransport();
    await runServerlessInvocation(
      {
        transport: second.transport,
        headers: {
          "x-crumbtrail-session-id": "bad\nvalue",
          "x-crumbtrail-request-id": "bad\nvalue",
          traceparent: "invalid",
        },
      },
      () => undefined,
    );
    const generated = eventOf(second.events, SERVERLESS_INVOCATION_START_EVENT);
    expect(generated.sessionId).toBeUndefined();
    expect(generated.d.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(generated.d.correlation).toEqual({
      status: "missing-session-and-request-id",
      sessionIdSource: "missing",
      requestIdSource: "generated",
    });
  });
});
