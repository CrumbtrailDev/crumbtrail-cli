import type {
  ServerlessInvocationEvent,
  ServerlessInvocationTransport,
} from "crumbtrail-core/serverless";
import { describe, expect, it, vi } from "vitest";
import {
  withCrumbtrailAwsLambda,
  withCrumbtrailNetlify,
  withCrumbtrailVercel,
} from "../index";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function recordingTransport(flush?: () => void | Promise<void>) {
  const events: ServerlessInvocationEvent[] = [];
  const transport: ServerlessInvocationTransport = {
    startSession: vi.fn(),
    capture(event) {
      events.push(event);
    },
    endSession: vi.fn(),
    flush,
  };
  return { events, transport };
}

function terminalEvents(events: readonly ServerlessInvocationEvent[]) {
  return events.filter((event) => event.d.status !== "started");
}

describe("Node serverless adapters", () => {
  it("uses endpoint only configuration for AWS, Vercel, and Netlify lifecycles", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = {
      instanceId: "ri_runtime_adapters",
      instanceProof: `proof_adapters_${"x".repeat(40)}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("/api/runtime/register"))
        return new Response(JSON.stringify(runtime), { status: 201 });
      return new Response("{}", { status: 200 });
    };
    const options = {
      endpoint: "https://capture.example",
      authToken: "ingest-key",
      service: "orders-api",
      fetchImpl,
    };

    await withCrumbtrailAwsLambda(async () => ({ statusCode: 201 }), options)(
      { httpMethod: "POST", path: "/lambda" },
      {},
    );
    await withCrumbtrailVercel(async () => "vercel", options)(
      { method: "GET", url: "/vercel" },
      { statusCode: 202 },
    );
    await withCrumbtrailNetlify(async () => ({ statusCode: 203 }), options)(
      { httpMethod: "PATCH", path: "/netlify" },
      {},
    );

    expect(
      calls.filter((call) => call.url.endsWith("/api/session/start")),
    ).toHaveLength(3);
    expect(
      calls.filter((call) => call.url.endsWith("/api/events")),
    ).toHaveLength(6);
    expect(
      calls.filter((call) => call.url.endsWith("/api/session/end")),
    ).toHaveLength(3);
    expect(
      calls.filter((call) => call.url.includes("/api/runtime/register")),
    ).toHaveLength(1);
    const starts = calls.filter((call) =>
      call.url.endsWith("/api/session/start"),
    );
    expect(starts.map((call) => JSON.parse(String(call.init?.body)))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instanceId: runtime.instanceId,
          instanceProof: runtime.instanceProof,
        }),
      ]),
    );
    expect(
      starts.map((call) => JSON.parse(String(call.init?.body)).instanceId),
    ).toEqual([runtime.instanceId, runtime.instanceId, runtime.instanceId]);
  });

  it("normalizes API Gateway v1, v2, and compatible HTTP events", async () => {
    const v1 = recordingTransport();
    const v1Result = { statusCode: 201, body: "v1" };
    const v1Handler = withCrumbtrailAwsLambda(async () => v1Result, {
      transport: v1.transport,
    });

    await expect(
      v1Handler(
        {
          httpMethod: "POST",
          resource: "/users/{id}",
          path: "/users/123",
          headers: { "X-Crumbtrail-Session-Id": "session-v1" },
        },
        {},
      ),
    ).resolves.toBe(v1Result);
    expect(terminalEvents(v1.events)[0]?.d).toMatchObject({
      method: "POST",
      route: "/users/{id}",
      statusCode: 201,
      sessionId: "session-v1",
    });

    const v2 = recordingTransport();
    const v2Handler = withCrumbtrailAwsLambda(
      async () => ({ statusCode: 202 }),
      { transport: v2.transport },
    );
    await v2Handler(
      {
        version: "2.0",
        rawPath: "/orders/42",
        routeKey: "GET /orders/{id}",
        headers: { "X-Crumbtrail-Session-Id": "session-v2" },
        requestContext: { http: { method: "GET", path: "/orders/42" } },
      },
      {},
    );
    expect(terminalEvents(v2.events)[0]?.d).toMatchObject({
      method: "GET",
      route: "/orders/{id}",
      statusCode: 202,
      sessionId: "session-v2",
    });

    const compatible = recordingTransport();
    const compatibleHandler = withCrumbtrailAwsLambda(
      async () => ({ statusCode: 204 }),
      { transport: compatible.transport },
    );
    await compatibleHandler(
      {
        method: "PATCH",
        path: "/compatible",
        headers: { "X-Crumbtrail-Session-Id": "session-compatible" },
      },
      {},
    );
    expect(terminalEvents(compatible.events)[0]?.d).toMatchObject({
      method: "PATCH",
      route: "/compatible",
      statusCode: 204,
      sessionId: "session-compatible",
    });
  });

  it("rejects non HTTP Lambda events before calling the host handler", async () => {
    const { events, transport } = recordingTransport();
    const hostHandler = vi.fn();
    const handler = withCrumbtrailAwsLambda(hostHandler, { transport });

    await expect(
      (handler as (event: unknown, context: unknown) => Promise<unknown>)(
        { source: "aws.events", detail: {} },
        {},
      ),
    ).rejects.toThrow("HTTP event");
    expect(hostHandler).not.toHaveBeenCalled();
    expect(terminalEvents(events)[0]?.d.status).toBe("error");
  });

  it("reads Vercel's final response status after the handler settles", async () => {
    const { events, transport } = recordingTransport();
    const response = { statusCode: 200 };
    const result = { host: "vercel" };
    const handler = withCrumbtrailVercel(
      async (_request, res) => {
        await Promise.resolve();
        res.statusCode = 207;
        return result;
      },
      { transport },
    );

    await expect(
      handler(
        {
          method: "POST",
          url: "/api/import?dryRun=true",
          headers: { "X-Crumbtrail-Session-Id": "session-vercel" },
        },
        response,
      ),
    ).resolves.toBe(result);
    expect(response.statusCode).toBe(207);
    expect(terminalEvents(events)[0]?.d).toMatchObject({
      method: "POST",
      route: "/api/import",
      statusCode: 207,
      sessionId: "session-vercel",
    });
  });

  it("preserves a synchronously thrown Vercel error and its final status", async () => {
    const { events, transport } = recordingTransport();
    const response = { statusCode: 200 };
    const hostError = new TypeError("sync failure");
    const handler = withCrumbtrailVercel(
      (_request, res) => {
        res.statusCode = 503;
        throw hostError;
      },
      { transport },
    );

    await expect(
      handler({ method: "GET", url: "/api/failure" }, response),
    ).rejects.toBe(hostError);
    expect(terminalEvents(events)[0]?.d).toMatchObject({
      status: "error",
      statusCode: 503,
    });
  });

  it("reads Netlify's returned status without replacing the result", async () => {
    const { events, transport } = recordingTransport();
    const result = { statusCode: 206, body: "partial" };
    const handler = withCrumbtrailNetlify(async () => result, { transport });

    await expect(
      handler(
        {
          httpMethod: "GET",
          path: "/.netlify/functions/report",
          headers: { "X-Crumbtrail-Session-Id": "session-netlify" },
        },
        {},
      ),
    ).resolves.toBe(result);
    expect(terminalEvents(events)[0]?.d).toMatchObject({
      method: "GET",
      route: "/.netlify/functions/report",
      statusCode: 206,
      sessionId: "session-netlify",
    });
  });

  it("waits for flush before resolving or rejecting with the host value", async () => {
    const successFlush = deferred();
    const success = recordingTransport(() => successFlush.promise);
    const successResult = { statusCode: 200, body: "ok" };
    const netlify = withCrumbtrailNetlify(async () => successResult, {
      transport: success.transport,
    });
    const successInvocation = netlify(
      { httpMethod: "GET", path: "/success" },
      {},
    );
    let successSettled = false;
    void successInvocation.finally(() => {
      successSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(successSettled).toBe(false);
    successFlush.resolve();
    await expect(successInvocation).resolves.toBe(successResult);

    const failureFlush = deferred();
    const failure = recordingTransport(() => failureFlush.promise);
    const hostError = new Error("host failed");
    const lambda = withCrumbtrailAwsLambda(
      async () => {
        throw hostError;
      },
      { transport: failure.transport },
    );
    const failureInvocation = lambda(
      { httpMethod: "GET", path: "/failure" },
      {},
    );
    let failureSettled = false;
    void failureInvocation.catch(() => {
      failureSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(failureSettled).toBe(false);
    failureFlush.resolve();
    await expect(failureInvocation).rejects.toBe(hostError);
  });

  it("keeps sequential and overlapping warm Lambda invocations isolated", async () => {
    const { events, transport } = recordingTransport();
    const gates = new Map<string, Deferred<void>>();
    const handler = withCrumbtrailAwsLambda(
      async (event) => {
        const path =
          event.path ?? event.rawPath ?? event.requestContext?.http?.path;
        if (!path) throw new Error("test event has no path");
        const gate = deferred();
        gates.set(path, gate);
        await gate.promise;
        return { statusCode: path === "/first" ? 201 : 202 };
      },
      { transport },
    );

    const first = handler(
      {
        httpMethod: "GET",
        path: "/first",
        headers: { "X-Crumbtrail-Session-Id": "session-first" },
      },
      {},
    );
    const second = handler(
      {
        httpMethod: "POST",
        path: "/second",
        headers: { "X-Crumbtrail-Session-Id": "session-second" },
      },
      {},
    );
    await vi.waitFor(() => expect(gates.size).toBe(2));
    gates.get("/second")?.resolve(undefined);
    await second;
    gates.get("/first")?.resolve(undefined);
    await first;

    const third = handler(
      {
        httpMethod: "DELETE",
        path: "/third",
        headers: { "X-Crumbtrail-Session-Id": "session-third" },
      },
      {},
    );
    await vi.waitFor(() => expect(gates.has("/third")).toBe(true));
    gates.get("/third")?.resolve(undefined);
    await third;

    const completed = terminalEvents(events).map((event) => event.d);
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          route: "/first",
          statusCode: 201,
          sessionId: "session-first",
        }),
        expect.objectContaining({
          method: "POST",
          route: "/second",
          statusCode: 202,
          sessionId: "session-second",
        }),
        expect.objectContaining({
          method: "DELETE",
          route: "/third",
          statusCode: 202,
          sessionId: "session-third",
        }),
      ]),
    );
  });

  it("rejects callback style invocation instead of silently accepting it", async () => {
    const { events, transport } = recordingTransport();
    const hostHandler = vi.fn(async () => ({ statusCode: 200 }));
    const handler = withCrumbtrailNetlify(hostHandler, { transport });

    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)(
        { httpMethod: "GET", path: "/callback" },
        {},
        vi.fn(),
      ),
    ).rejects.toThrow("callback");
    expect(hostHandler).not.toHaveBeenCalled();
    expect(terminalEvents(events)[0]?.d.status).toBe("error");
  });
});
