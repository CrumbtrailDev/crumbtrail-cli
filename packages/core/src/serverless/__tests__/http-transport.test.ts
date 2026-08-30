import { describe, expect, it, vi } from "vitest";
import {
  HeadlessRequestError,
  HeadlessTimeoutError,
  createServerlessHttpTransport,
  startHeadlessSession,
  type ServerlessInvocationEvent,
} from "../index";

function event(sessionId: string): ServerlessInvocationEvent {
  return {
    t: 1,
    k: "serverless.invocation.start",
    sessionId,
    d: {
      requestId: "req_1",
      sessionId,
      correlation: {
        status: "missing-session-and-request-id",
        sessionIdSource: "generated",
        requestIdSource: "generated",
      },
      status: "started",
      durationMs: 0,
    },
  };
}

describe("createServerlessHttpTransport", () => {
  it("posts start, events, and end with the ingest key and supplied session", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    });
    const transport = createServerlessHttpTransport({
      endpoint: "https://capture.example/",
      authToken: "ingest-key",
      fetchImpl,
    });

    await transport.startSession({
      sessionId: "ses_owned",
      metadata: { service: "checkout" },
    });
    await transport.capture(event("ses_owned"));
    await transport.endSession("ses_owned");

    expect(calls.map(({ url }) => url)).toEqual([
      "https://capture.example/api/session/start",
      "https://capture.example/api/events",
      "https://capture.example/api/session/end",
    ]);
    for (const { init } of calls) {
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        "x-crumbtrail-auth": "ingest-key",
      });
    }
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      sessionId: "ses_owned",
      metadata: { service: "checkout" },
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      sessionId: "ses_owned",
      events: [event("ses_owned")],
    });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      sessionId: "ses_owned",
    });
  });

  it("bounds stalled requests with an injectable Fetch implementation", async () => {
    const transport = createServerlessHttpTransport({
      endpoint: "https://capture.example",
      requestTimeoutMs: 5,
      fetchImpl: vi.fn((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        });
      }),
    });

    await expect(
      transport.startSession({ sessionId: "ses_timeout" }),
    ).rejects.toBeInstanceOf(HeadlessTimeoutError);
  });

  it("rejects non successful intake responses with their status", async () => {
    const transport = createServerlessHttpTransport({
      endpoint: "https://capture.example",
      fetchImpl: vi.fn(async () =>
        Promise.resolve(
          new Response('{"error":"revoked key"}', { status: 401 }),
        ),
      ),
    });

    const rejection = transport.startSession({ sessionId: "ses_refused" });
    await expect(rejection).rejects.toBeInstanceOf(HeadlessRequestError);
    await expect(rejection).rejects.toMatchObject({
      status: 401,
      serverMessage: "revoked key",
    });
  });

  it("preserves the headless session API for events without envelope session IDs", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('{"closed":true}', { status: 200 });
    };
    const session = await startHeadlessSession({
      endpoint: "https://capture.example",
      sessionId: "ses_headless",
      metadata: { service: "worker" },
      fetchImpl,
    });

    await session.record({ t: 1, k: "test", d: {} });
    await expect(session.end()).resolves.toEqual({ closed: true });
    expect(bodies).toEqual([
      {
        sessionId: "ses_headless",
        metadata: { service: "worker", source: "headless" },
      },
      {
        sessionId: "ses_headless",
        events: [{ t: 1, k: "test", d: {} }],
      },
      { sessionId: "ses_headless" },
    ]);
  });
});
