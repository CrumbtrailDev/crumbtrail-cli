import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import express from "express";
import type { BugEvent } from "crumbtrail-core";
import { autoCapture, type AutoCaptureHandle } from "../auto-capture";
import {
  createCrumbtrailExpressMiddleware,
  createCrumbtrailExpressErrorMiddleware,
} from "../express";
import {
  flushBackendEvents,
  resetBackendIntakeQueueForTest,
} from "../backend-intake";

/**
 * The regression this file exists for: a wizard install on any framework other
 * than Express recorded no inbound request at all, so a browser session that
 * sent `x-crumbtrail-session-id` on every fetch came back with zero backend
 * requests and nothing linked. These tests boot REAL servers — hono over
 * `@hono/node-server`, a hand-written `node:http` server, and express — and
 * assert the ids actually make the round trip.
 */

const ENDPOINT = "http://capture.test";
const SESSION = "sess_browser_1";
const REQUEST_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

interface Posted {
  url: string;
  sessionId?: string;
  events: BugEvent[];
}

function fakeIngest(): { posts: Posted[]; fetchImpl: typeof fetch } {
  const posts: Posted[] = [];
  const fetchImpl = (async (input: unknown, init?: unknown) => {
    const url = String(input);
    const body = (init as { body?: string } | undefined)?.body;
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    posts.push({
      url,
      sessionId:
        typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      events: Array.isArray(parsed.events) ? (parsed.events as BugEvent[]) : [],
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "{}",
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;
  return { posts, fetchImpl };
}

/** Every event posted to the ingest, flattened, filtered by kind prefix. */
function eventsOfKind(posts: Posted[], prefix: string): BugEvent[] {
  return posts
    .filter((post) => post.url.endsWith("/api/events"))
    .flatMap((post) => post.events)
    .filter((event) => event.k.startsWith(prefix));
}

/** The session each `backend.req.*` post was addressed to. */
function requestPostSessions(posts: Posted[]): string[] {
  return posts
    .filter(
      (post) =>
        post.url.endsWith("/api/events") &&
        post.events.some((event) => event.k.startsWith("backend.req.")),
    )
    .map((post) => post.sessionId ?? "");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const correlationHeaders: Record<string, string> = {
  "x-crumbtrail-session-id": SESSION,
  "x-crumbtrail-request-id": REQUEST_ID,
  traceparent: `00-${REQUEST_ID}-00f067aa0ba902b7-01`,
};

let capture: AutoCaptureHandle | undefined;
const servers: Server[] = [];

async function startCapture(fetchImpl: typeof fetch): Promise<void> {
  capture = await autoCapture({
    endpoint: ENDPOINT,
    authToken: "ctkey_test",
    fetchImpl,
    loadEnv: false,
    instrumentDatabases: false,
    captureLogs: false,
    captureRuntimeWarnings: false,
  });
}

afterEach(async () => {
  capture?.stop();
  capture = undefined;
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await close(server);
  }
  resetBackendIntakeQueueForTest();
});

describe("inbound request capture on a stock autoCapture install", () => {
  it("records a hono request carrying the browser's correlation headers", async () => {
    const { posts, fetchImpl } = fakeIngest();
    await startCapture(fetchImpl);

    const app = new Hono();
    app.get("/orders", (c) => c.json({ ok: true }));
    const server = serve({ fetch: app.fetch, port: 0 }) as unknown as Server;
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/orders?id=7`, {
      headers: correlationHeaders,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    await flushBackendEvents();

    const start = eventsOfKind(posts, "backend.req.start");
    const end = eventsOfKind(posts, "backend.req.end");
    expect(start).toHaveLength(1);
    expect(end).toHaveLength(1);

    expect(start[0].sessionId).toBe(SESSION);
    expect(start[0].d.requestId).toBe(REQUEST_ID);
    expect(start[0].d.method).toBe("GET");
    expect(start[0].d.pathname).toBe("/orders");
    expect(start[0].d.correlation).toMatchObject({
      status: "linked",
      sessionIdSource: "header",
      requestIdSource: "header",
    });

    expect(end[0].sessionId).toBe(SESSION);
    expect(end[0].d.requestId).toBe(REQUEST_ID);
    expect(end[0].d.statusCode).toBe(200);
    expect(typeof end[0].d.durationMs).toBe("number");

    // Addressed to the BROWSER's session, not autoCapture's headless one.
    expect(requestPostSessions(posts)).toEqual(
      requestPostSessions(posts).map(() => SESSION),
    );
    expect(requestPostSessions(posts).length).toBeGreaterThan(0);
  });

  it("records a plain node:http request and its error response body", async () => {
    const { posts, fetchImpl } = fakeIngest();
    await startCapture(fetchImpl);

    const server = createServer((req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "order lookup failed" }));
    });
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: "POST",
      headers: correlationHeaders,
    });
    expect(response.status).toBe(500);
    await response.text();

    await flushBackendEvents();

    const end = eventsOfKind(posts, "backend.req.end");
    expect(end).toHaveLength(1);
    expect(end[0].sessionId).toBe(SESSION);
    expect(end[0].d.requestId).toBe(REQUEST_ID);
    expect(end[0].d.method).toBe("POST");
    expect(end[0].d.statusCode).toBe(500);
    // The sentence that explains the failure, captured under the same redaction
    // policy as the browser plane.
    expect(String(end[0].d.responseBody)).toContain("order lookup failed");
    expect(end[0].d.responseHeaders).toMatchObject({
      "content-type": "application/json",
    });
  });

  it("correlates through traceparent alone when only that header survives", async () => {
    const { posts, fetchImpl } = fakeIngest();
    await startCapture(fetchImpl);

    const server = createServer((_req, res) => res.end("ok"));
    servers.push(server);
    const port = await listen(server);

    await fetch(`http://127.0.0.1:${port}/x`, {
      headers: {
        "x-crumbtrail-session-id": SESSION,
        traceparent: `00-${REQUEST_ID}-00f067aa0ba902b7-01`,
      },
    }).then((r) => r.text());

    await flushBackendEvents();

    const start = eventsOfKind(posts, "backend.req.start");
    expect(start).toHaveLength(1);
    expect(start[0].d.requestId).toBe(REQUEST_ID);
    expect(start[0].d.correlation).toMatchObject({
      status: "linked",
      requestIdSource: "traceparent",
    });
  });

  it("emits nothing for a request with no correlation headers", async () => {
    const { posts, fetchImpl } = fakeIngest();
    await startCapture(fetchImpl);

    const server = createServer((_req, res) => res.end("ok"));
    servers.push(server);
    const port = await listen(server);

    await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.text());
    await flushBackendEvents();

    expect(eventsOfKind(posts, "backend.req.")).toHaveLength(0);
  });

  it("does not double record an express request that the middleware already owns", async () => {
    const { posts, fetchImpl } = fakeIngest();
    await startCapture(fetchImpl);

    const app = express();
    app.use(
      createCrumbtrailExpressMiddleware({
        endpoint: ENDPOINT,
        authToken: "ctkey_test",
        fetch: fetchImpl as never,
        captureLogs: false,
        captureRuntimeWarnings: false,
      }),
    );
    app.get("/orders", (_req, res) => {
      res.json({ ok: true });
    });
    app.use(
      createCrumbtrailExpressErrorMiddleware({
        endpoint: ENDPOINT,
        authToken: "ctkey_test",
        fetch: fetchImpl as never,
      }),
    );

    const server = app.listen(0, "127.0.0.1") as unknown as Server;
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    await fetch(`http://127.0.0.1:${port}/orders`, {
      headers: correlationHeaders,
    }).then((r) => r.json());

    await flushBackendEvents();

    // One request, one pair of events — the express middleware's, which is the
    // recorder that can see the matched route and the thrown error.
    expect(eventsOfKind(posts, "backend.req.start")).toHaveLength(1);
    const end = eventsOfKind(posts, "backend.req.end");
    expect(end).toHaveLength(1);
    expect(end[0].sessionId).toBe(SESSION);
    expect(end[0].d.route).toBe("/orders");
    expect(end[0].d.statusCode).toBe(200);
  });

  it("leaves node:http untouched when the capture is stopped", async () => {
    const { posts, fetchImpl } = fakeIngest();
    await startCapture(fetchImpl);
    capture?.stop();
    capture = undefined;

    const server = createServer((_req, res) => res.end("ok"));
    servers.push(server);
    const port = await listen(server);

    await fetch(`http://127.0.0.1:${port}/orders`, {
      headers: correlationHeaders,
    }).then((r) => r.text());
    await flushBackendEvents();

    expect(eventsOfKind(posts, "backend.req.")).toHaveLength(0);
    expect(
      Object.prototype.hasOwnProperty.call(
        (await import("node:http")).Server.prototype,
        "emit",
      ),
    ).toBe(false);
  });
});
