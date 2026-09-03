import { describe, expect, it, vi } from "vitest";
import {
  SERVERLESS_INVOCATION_START_EVENT,
  SERVERLESS_INVOCATION_SUCCESS_EVENT,
  withCrumbtrailFetch,
  type FetchServerlessAdapterOptions,
  type ServerlessInvocationEvent,
  type ServerlessInvocationTransport,
} from "../index";

function collectingTransport(
  overrides: Partial<ServerlessInvocationTransport> = {},
) {
  const events: ServerlessInvocationEvent[] = [];
  const transport: ServerlessInvocationTransport = {
    startSession: overrides.startSession ?? vi.fn(),
    capture:
      overrides.capture ??
      ((event) => {
        events.push(event);
      }),
    endSession: overrides.endSession ?? vi.fn(),
    flush: overrides.flush ?? vi.fn().mockResolvedValue(undefined),
  };
  return { events, transport };
}

describe("withCrumbtrailFetch", () => {
  it("accepts diagnosticFields in the public Fetch adapter options type", () => {
    const options: FetchServerlessAdapterOptions = {
      endpoint: "https://capture.example",
      diagnosticFields: ["checkout.status", "attempts[0].code"],
    };

    expect(options.diagnosticFields).toEqual([
      "checkout.status",
      "attempts[0].code",
    ]);
  });

  it("requires exactly one delivery configuration in TypeScript", () => {
    // @ts-expect-error An endpoint or custom transport is required.
    const missing = withCrumbtrailFetch(() => new Response(), {});
    const { transport } = collectingTransport();
    // @ts-expect-error Endpoint and custom transport are mutually exclusive.
    const ambiguous = withCrumbtrailFetch(() => new Response(), {
      endpoint: "https://capture.example",
      transport,
    });

    expect(typeof missing).toBe("function");
    expect(typeof ambiguous).toBe("function");
  });

  it("uses endpoint only configuration for an owned delivery lifecycle", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    };
    const response = new Response("created", { status: 201 });

    const result = await withCrumbtrailFetch(() => response, {
      endpoint: "https://capture.example",
      authToken: "ingest-key",
      service: "checkout-worker",
      metadata: { environment: "test" },
      fetchImpl,
    })(new Request("https://worker.example/orders", { method: "POST" }));

    expect(result).toBe(response);
    expect(calls.map((call) => call.url)).toEqual([
      "https://capture.example/api/session/start",
      "https://capture.example/api/events",
      "https://capture.example/api/events",
      "https://capture.example/api/session/end",
    ]);
    const bodies = calls.map(
      (call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>,
    );
    const sessionId = String(bodies[0].sessionId);
    expect(sessionId).toMatch(/^ses_/);
    expect(bodies.every((body) => body.sessionId === sessionId)).toBe(true);
    expect(bodies[0].metadata).toMatchObject({
      source: "serverless",
      service: "checkout-worker",
      environment: "test",
    });
    for (const call of calls) {
      expect(call.init?.headers).toMatchObject({
        "x-crumbtrail-auth": "ingest-key",
      });
    }
  });

  it("defers every endpoint request until the waitUntil cleanup runs", async () => {
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const scheduled: Promise<void>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response("{}", { status: 200 });
    };
    const response = new Response("host response", { status: 202 });

    await expect(
      withCrumbtrailFetch(() => response, {
        endpoint: "https://capture.example",
        fetchImpl,
        waitUntil(promise) {
          scheduled.push(promise);
        },
      })(new Request("https://worker.example/deferred")),
    ).resolves.toBe(response);

    expect(scheduled).toHaveLength(1);
    expect(calls).toEqual([]);

    await expect(scheduled[0]).resolves.toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      "https://capture.example/api/session/start",
      "https://capture.example/api/events",
      "https://capture.example/api/events",
      "https://capture.example/api/session/end",
    ]);
    expect(
      calls.slice(1, 3).map((call) => {
        const events = call.body.events as ServerlessInvocationEvent[];
        return events[0]?.k;
      }),
    ).toEqual([
      SERVERLESS_INVOCATION_START_EVENT,
      SERVERLESS_INVOCATION_SUCCESS_EVENT,
    ]);
  });

  it("contains deferred endpoint failures with their operation phases", async () => {
    const calls: string[] = [];
    const scheduled: Promise<void>[] = [];
    const onError = vi.fn();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith("/api/session/start")
        ? new Response("{}", { status: 200 })
        : new Response('{"error":"intake refused"}', { status: 503 });
    };
    const response = new Response("host response");

    await expect(
      withCrumbtrailFetch(() => response, {
        endpoint: "https://capture.example",
        fetchImpl,
        onError,
        waitUntil(promise) {
          scheduled.push(promise);
        },
      })(new Request("https://worker.example/deferred-failure")),
    ).resolves.toBe(response);
    expect(calls).toEqual([]);

    await expect(scheduled[0]).resolves.toBeUndefined();
    expect(onError.mock.calls.map((call) => call[1].phase)).toEqual([
      "capture",
      "capture",
      "session-end",
    ]);
  });

  it("awaits the complete endpoint queue when waitUntil is absent", async () => {
    let releaseRequests!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      await requestGate;
      return new Response("{}", { status: 200 });
    };
    const response = new Response("awaited response");
    let invocationSettled = false;

    const invocation = withCrumbtrailFetch(() => response, {
      endpoint: "https://capture.example",
      fetchImpl,
    })(new Request("https://worker.example/awaited-endpoint")).finally(() => {
      invocationSettled = true;
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(invocationSettled).toBe(false);
    releaseRequests();
    await expect(invocation).resolves.toBe(response);
    expect(calls).toHaveLength(4);
  });

  it("reuses a linked session without starting or ending it", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const response = new Response("linked", { status: 200 });

    await expect(
      withCrumbtrailFetch(() => response, {
        endpoint: "https://capture.example",
        fetchImpl,
      })(
        new Request("https://worker.example/linked", {
          headers: { "X-Crumbtrail-Session-Id": "ses_linked" },
        }),
      ),
    ).resolves.toBe(response);

    expect(calls).toEqual([
      "https://capture.example/api/events",
      "https://capture.example/api/events",
    ]);
  });

  it("contains a session start timeout without replacing host success", async () => {
    const response = new Response("host success", { status: 200 });
    const onError = vi.fn();
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });

    await expect(
      withCrumbtrailFetch(() => response, {
        endpoint: "https://capture.example",
        fetchImpl,
        onError,
        requestTimeoutMs: 5,
      })(new Request("https://worker.example/timeout")),
    ).resolves.toBe(response);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][1]).toMatchObject({ phase: "session-start" });
  });

  it("contains event refusal without replacing the original host error", async () => {
    const hostError = new TypeError("host failed");
    const calls: string[] = [];
    const onError = vi.fn();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/events")) {
        return new Response('{"error":"intake unavailable"}', { status: 503 });
      }
      return new Response("{}", { status: 200 });
    };

    await expect(
      withCrumbtrailFetch(
        () => {
          throw hostError;
        },
        {
          endpoint: "https://capture.example",
          fetchImpl,
          onError,
        },
      )(new Request("https://worker.example/refused")),
    ).rejects.toBe(hostError);
    expect(calls.at(-1)).toBe("https://capture.example/api/session/end");
    expect(onError.mock.calls.map((call) => call[1].phase)).toEqual([
      "capture",
      "capture",
    ]);
  });

  it("contains session end refusal without replacing host success or error", async () => {
    const hostResponse = new Response("host success");
    const hostError = new TypeError("host error");
    const onError = vi.fn();
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith("/api/session/end")
        ? new Response('{"error":"end refused"}', { status: 503 })
        : new Response("{}", { status: 200 });
    const options = {
      endpoint: "https://capture.example",
      fetchImpl,
      onError,
    };

    await expect(
      withCrumbtrailFetch(() => hostResponse, options)(
        new Request("https://worker.example/success"),
      ),
    ).resolves.toBe(hostResponse);
    await expect(
      withCrumbtrailFetch(
        () => {
          throw hostError;
        },
        options,
      )(new Request("https://worker.example/error")),
    ).rejects.toBe(hostError);
    expect(onError.mock.calls.map((call) => call[1].phase)).toEqual([
      "session-end",
      "session-end",
    ]);
  });

  it("keeps overlapping endpoint only calls on distinct owned sessions", async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const gates = new Map<string, () => void>();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { sessionId: string };
      if (url.endsWith("/api/session/start")) starts.push(body.sessionId);
      if (url.endsWith("/api/session/end")) ends.push(body.sessionId);
      return new Response("{}", { status: 200 });
    };
    const handler = withCrumbtrailFetch(
      async (request) => {
        await new Promise<void>((resolve) => {
          gates.set(new URL(request.url).pathname, resolve);
        });
        return new Response("done");
      },
      { endpoint: "https://capture.example", fetchImpl },
    );

    const first = handler(new Request("https://worker.example/first"));
    const second = handler(new Request("https://worker.example/second"));
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(starts).toEqual([]);
    gates.get("/second")?.();
    await second;
    gates.get("/first")?.();
    await first;

    expect(new Set(starts).size).toBe(2);
    expect(new Set(ends)).toEqual(new Set(starts));
  });

  it("runs the host and reports invalid JavaScript delivery configurations", async () => {
    const response = new Response("host result");
    const host = vi.fn(() => response);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      withCrumbtrailFetch(
        host,
        {} as never,
      )(new Request("https://worker.example/misconfigured")),
    ).resolves.toBe(response);
    expect(host).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("configuration failed"),
      expect.any(Error),
    );
    consoleError.mockRestore();

    const onError = vi.fn();
    const { transport } = collectingTransport();
    await expect(
      withCrumbtrailFetch(host, {
        endpoint: "https://capture.example",
        transport,
        onError,
      } as never)(new Request("https://worker.example/ambiguous")),
    ).resolves.toBe(response);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      phase: "configuration",
      sessionId: expect.stringMatching(/^ses_/),
    });
  });

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
      startSession: vi.fn(),
      capture: vi.fn().mockRejectedValue(new Error("capture failed")),
      endSession: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error("flush failed")),
    };

    await expect(
      withCrumbtrailFetch(() => response, { transport, onError: vi.fn() })(
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
      withCrumbtrailFetch(() => response, {
        transport,
        waitUntil(promise) {
          scheduled.push(promise);
        },
      })(new Request("https://worker.example/scheduled")),
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
      withCrumbtrailFetch(() => response, {
        transport,
        waitUntil(promise) {
          scheduled.push(promise);
        },
      })(new Request("https://worker.example/flush-failure")),
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
