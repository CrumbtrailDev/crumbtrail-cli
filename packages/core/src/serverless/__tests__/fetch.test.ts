import { describe, expect, it, vi } from "vitest";
import {
  SERVERLESS_INVOCATION_START_EVENT,
  SERVERLESS_INVOCATION_SUCCESS_EVENT,
  withCrumbtrailFetch,
  type ServerlessInvocationEvent,
  type ServerlessInvocationTransport,
} from "../index";

function collectingTransport(
  overrides: Partial<ServerlessInvocationTransport> = {},
) {
  const events: ServerlessInvocationEvent[] = [];
  const transport: ServerlessInvocationTransport = {
    capture(event) {
      events.push(event);
    },
    flush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { events, transport };
}

describe("withCrumbtrailFetch", () => {
  it("derives safe request and response metadata and preserves the response", async () => {
    const { events, transport } = collectingTransport();
    const request = new Request(
      "https://worker.example/orders/ord_123?access_token=secret",
      {
        method: "patch",
        headers: {
          authorization: "Bearer must-not-be-captured",
          "x-crumbtrail-session-id": "ses_fetch",
          "x-crumbtrail-request-id": "req_fetch",
        },
      },
    );
    const response = new Response("accepted", { status: 202 });

    const handler = withCrumbtrailFetch(() => response, { transport });

    const result = await handler(request);

    expect(result).toBe(response);
    expect(events.map((event) => event.k)).toEqual([
      SERVERLESS_INVOCATION_START_EVENT,
      SERVERLESS_INVOCATION_SUCCESS_EVENT,
    ]);
    expect(events[0]).toMatchObject({
      sessionId: "ses_fetch",
      d: {
        requestId: "req_fetch",
        method: "PATCH",
        route: "/orders/ord_123",
        metadata: { requestAborted: false },
      },
    });
    expect(events[1]).toMatchObject({
      d: { status: "success", statusCode: 202 },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("must-not-be-captured");
  });

  it("preserves thrown error identity", async () => {
    const { transport } = collectingTransport({
      flush: vi.fn().mockRejectedValue(new Error("flush failed")),
    });
    const original = new Error("handler failed");

    await expect(
      withCrumbtrailFetch(
        () => {
          throw original;
        },
        { transport },
      )(new Request("https://worker.example/failure")),
    ).rejects.toBe(original);
    expect(transport.flush).toHaveBeenCalledOnce();
  });

  it("contains capture and flush rejection without changing host success", async () => {
    const response = new Response(null, { status: 204 });
    const transport: ServerlessInvocationTransport = {
      capture: vi.fn().mockRejectedValue(new Error("capture failed")),
      flush: vi.fn().mockRejectedValue(new Error("flush failed")),
    };

    await expect(
      withCrumbtrailFetch(() => response, { transport })(
        new Request("https://worker.example/success"),
      ),
    ).resolves.toBe(response);
    expect(transport.capture).toHaveBeenCalledTimes(2);
    expect(transport.flush).toHaveBeenCalledOnce();
  });

  it("records a request that was already aborted and still calls the handler", async () => {
    const { events, transport } = collectingTransport();
    const controller = new AbortController();
    controller.abort("deadline exceeded");
    const request = new Request("https://worker.example/aborted", {
      signal: controller.signal,
    });
    const handler = vi.fn(() => new Response("host decides", { status: 408 }));

    const result = await withCrumbtrailFetch(handler, { transport })(request);

    expect(handler).toHaveBeenCalledOnce();
    expect(result.status).toBe(408);
    expect(events[0]).toMatchObject({
      d: { metadata: { requestAborted: true } },
    });
  });

  it("awaits flush before returning when waitUntil is absent", async () => {
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const flushStarted = new Promise<void>((resolve) => {
      markFlushStarted = resolve;
    });
    const response = new Response("complete");
    const { transport } = collectingTransport({
      flush: vi.fn(() => {
        markFlushStarted();
        return flushGate;
      }),
    });
    let invocationSettled = false;

    const invocation = withCrumbtrailFetch(() => response, { transport })(
      new Request("https://worker.example/awaited"),
    ).finally(() => {
      invocationSettled = true;
    });

    await flushStarted;
    expect(invocationSettled).toBe(false);
    releaseFlush();
    await expect(invocation).resolves.toBe(response);
  });

  it("schedules a contained flush promise and returns without waiting", async () => {
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const scheduled: Promise<void>[] = [];
    const response = new Response("scheduled");
    const { transport } = collectingTransport({
      flush: vi.fn(() => flushGate),
    });

    await expect(
      withCrumbtrailFetch(
        () => response,
        {
          transport,
          waitUntil(promise) {
            scheduled.push(promise);
          },
        },
      )(new Request("https://worker.example/scheduled")),
    ).resolves.toBe(response);
    expect(scheduled).toHaveLength(1);

    let scheduledSettled = false;
    void scheduled[0].then(() => {
      scheduledSettled = true;
    });
    await Promise.resolve();
    expect(scheduledSettled).toBe(false);
    releaseFlush();
    await expect(scheduled[0]).resolves.toBeUndefined();
  });

  it("contains a scheduled flush rejection", async () => {
    const scheduled: Promise<void>[] = [];
    const response = new Response("host result");
    const { transport } = collectingTransport({
      flush: vi.fn().mockRejectedValue(new Error("flush failed")),
    });

    await expect(
      withCrumbtrailFetch(
        () => response,
        {
          transport,
          waitUntil(promise) {
            scheduled.push(promise);
          },
        },
      )(new Request("https://worker.example/flush-failure")),
    ).resolves.toBe(response);
    await expect(scheduled[0]).resolves.toBeUndefined();
  });

  it("does not read, clone, or consume request and response bodies", async () => {
    const { transport } = collectingTransport();
    const request = new Request("https://worker.example/body", {
      method: "POST",
      body: "request secret",
    });
    const response = new Response("response secret");
    const requestClone = vi.spyOn(request, "clone");
    const responseClone = vi.spyOn(response, "clone");

    const result = await withCrumbtrailFetch(
      (receivedRequest) => {
        expect(receivedRequest).toBe(request);
        expect(request.bodyUsed).toBe(false);
        return response;
      },
      { transport },
    )(request);

    expect(result).toBe(response);
    expect(request.bodyUsed).toBe(false);
    expect(response.bodyUsed).toBe(false);
    expect(requestClone).not.toHaveBeenCalled();
    expect(responseClone).not.toHaveBeenCalled();
  });
});
