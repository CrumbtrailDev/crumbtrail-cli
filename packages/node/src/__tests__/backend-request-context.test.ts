import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { BugEvent } from "crumbtrail-core";
import { autoCapture, type AutoCaptureHandle } from "../auto-capture";
import { createCrumbtrailExpressMiddleware } from "../express";
import {
  flushBackendEvents,
  resetBackendIntakeQueueForTest,
} from "../backend-intake";
import {
  getBackendRequestContext,
  readRequestCorrelation,
  runInBackendRequestContext,
  updateBackendRequestContext,
} from "../request-context";
import { installBackendLogCapture } from "../backend-logs";

/**
 * The regression this file exists for.
 *
 * A browser click that got a 500, and the backend log line that explains it,
 * ended up in two separate issues — each reporting that no counterpart could be
 * found — because they shared no join key. The request span carried the
 * browser's 32 hex trace id; the log line carried whatever id the application's
 * own logger had minted, or nothing at all. The id that would have joined them
 * was one stack frame away in the request recorder.
 *
 * These tests boot a REAL express server behind a stock `autoCapture` install,
 * write REAL structured log lines from inside the handler, and assert the two
 * halves come out sharing one request id and one session.
 */

const ENDPOINT = "http://capture.test";
const SESSION = "sess_browser_ctx";
const REQUEST_ID = "c70509ea9b1f4d3ea1d8b0f2c3a45671";
const OTHER_SESSION = "sess_browser_ctx_2";
const OTHER_REQUEST_ID = "aa11bb22cc33dd44ee55ff6677889900";

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

function eventsOfKind(posts: Posted[], prefix: string): BugEvent[] {
  return posts
    .filter((post) => post.url.endsWith("/api/events"))
    .flatMap((post) => post.events)
    .filter((event) => event.k.startsWith(prefix));
}

/** The session id each post carrying an event of this kind was addressed to. */
function postSessionsFor(posts: Posted[], kind: string): string[] {
  return posts
    .filter(
      (post) =>
        post.url.endsWith("/api/events") &&
        post.events.some((event) => event.k === kind),
    )
    .map((post) => post.sessionId ?? "");
}

/**
 * A stand-in for the stream a structured logger writes to.
 *
 * The log hub is keyed on the stdout object it was given, so handing the
 * capture this object instead of the process's own keeps a test's log lines out
 * of the real terminal — and keeps two tests from sharing one hub.
 */
function fakeStream(): NodeJS.WriteStream & { written: string[] } {
  const written: string[] = [];
  const stream = {
    written,
    write(chunk: unknown): boolean {
      written.push(String(chunk));
      return true;
    },
  };
  return stream as unknown as NodeJS.WriteStream & { written: string[] };
}

/** One pino-shaped NDJSON line, as pino would serialize it. */
function logLine(
  level: number,
  msg: string,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    level,
    time: Date.now(),
    pid: 1,
    hostname: "test",
    msg,
    ...extra,
  })}\n`;
}

let capture: AutoCaptureHandle | undefined;
const servers: Server[] = [];

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function listen(app: express.Express): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
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

describe("request context primitives", () => {
  it("reports no context outside a request", () => {
    expect(getBackendRequestContext()).toBeUndefined();
    expect(readRequestCorrelation()).toBeUndefined();
  });

  it("updating outside a request is a no-op rather than a throw", () => {
    expect(() =>
      updateBackendRequestContext({ requestId: "orphan" }),
    ).not.toThrow();
    expect(getBackendRequestContext()).toBeUndefined();
  });

  it("carries the correlation across awaits", async () => {
    const seen = await runInBackendRequestContext(
      { requestId: REQUEST_ID, sessionId: SESSION, sessionIdSource: "header" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await Promise.resolve();
        return readRequestCorrelation();
      },
    );
    expect(seen).toEqual({ requestId: REQUEST_ID, sessionId: SESSION });
  });

  it("gives two concurrent contexts distinct ids", async () => {
    const run = (requestId: string, sessionId: string, delay: number) =>
      runInBackendRequestContext(
        { requestId, sessionId, sessionIdSource: "header" },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return readRequestCorrelation();
        },
      );

    const [first, second] = await Promise.all([
      run(REQUEST_ID, SESSION, 8),
      run(OTHER_REQUEST_ID, OTHER_SESSION, 1),
    ]);
    expect(first).toEqual({ requestId: REQUEST_ID, sessionId: SESSION });
    expect(second).toEqual({
      requestId: OTHER_REQUEST_ID,
      sessionId: OTHER_SESSION,
    });
  });

  it("an inner context shadows the outer one and the outer survives it", () => {
    runInBackendRequestContext(
      { requestId: "outer", sessionId: SESSION, sessionIdSource: "header" },
      () => {
        runInBackendRequestContext(
          { requestId: "inner", sessionId: SESSION, sessionIdSource: "header" },
          () => {
            expect(readRequestCorrelation()?.requestId).toBe("inner");
          },
        );
        expect(readRequestCorrelation()?.requestId).toBe("outer");
      },
    );
  });

  it("updates the ambient context in place", () => {
    runInBackendRequestContext({}, () => {
      updateBackendRequestContext({
        requestId: REQUEST_ID,
        sessionId: SESSION,
        sessionIdSource: "header",
      });
      // A later recorder that knows only the id must not erase the session.
      updateBackendRequestContext({ requestId: "upgraded" });
      expect(readRequestCorrelation()).toEqual({
        requestId: "upgraded",
        sessionId: SESSION,
      });
    });
  });

  it("withholds a session nothing correlated", () => {
    runInBackendRequestContext(
      { requestId: REQUEST_ID, sessionId: "sess_proc", sessionIdSource: "process" },
      () => {
        // The id still joins the request's own events; the session does not
        // travel, because presenting a process owned request as a joined one
        // would invent a correlation.
        expect(readRequestCorrelation()).toEqual({ requestId: REQUEST_ID });
      },
    );
  });

  it("re-entrancy: a sink that logs cannot recurse or double count", () => {
    const stdout = fakeStream();
    const events: BugEvent[] = [];
    const handle = installBackendLogCapture({
      stdout,
      stderr: stdout,
      minLevel: "warn",
      sessionId: SESSION,
      emit: (event) => {
        events.push(event);
        // A sink whose own logging goes back through the patched write.
        stdout.write(logLine(50, "sink wrote this"));
      },
    });
    try {
      stdout.write(logLine(50, "handler failure"));
    } finally {
      handle.stop();
    }
    expect(events).toHaveLength(1);
    expect(events[0].d.message).toBe("handler failure");
  });
});

describe("log lines written inside a request", () => {
  it("stamps the browser's request id and files the line to the browser's session", async () => {
    const { posts, fetchImpl } = fakeIngest();
    const stdout = fakeStream();
    capture = await autoCapture({
      endpoint: ENDPOINT,
      authToken: "ctkey_test",
      fetchImpl,
      loadEnv: false,
      instrumentDatabases: false,
      captureRuntimeWarnings: false,
      logStreams: { stdout, stderr: stdout },
    });
    const processSession = capture.sessionId;
    expect(typeof processSession).toBe("string");

    const app = express();
    app.get("/orders", async (_req, res) => {
      // An ordinary handled failure: caught, logged with the stack through a
      // structured logger, answered with a status. It reaches no console.
      await new Promise((resolve) => setTimeout(resolve, 2));
      stdout.write(
        logLine(50, "order lookup failed", {
          reqId: "070e8640-1c2d-4f0a-9a58-9b7ff2f7a0e1",
          err: {
            type: "DatabaseError",
            message: 'relation "public.marginary_events" does not exist',
            stack: "Error: relation does not exist\n    at listOrders (db.ts:14:3)",
          },
        }),
      );
      res.status(500).json({ error: "order lookup failed" });
    });
    const { port } = await listen(app);

    const response = await fetch(`http://127.0.0.1:${port}/orders`, {
      headers: {
        "x-crumbtrail-session-id": SESSION,
        "x-crumbtrail-request-id": REQUEST_ID,
        traceparent: `00-${REQUEST_ID}-00f067aa0ba902b7-01`,
      },
    });
    expect(response.status).toBe(500);
    await response.text();
    await flushBackendEvents();

    const logs = eventsOfKind(posts, "backend.log");
    const starts = eventsOfKind(posts, "backend.req.start");
    expect(logs).toHaveLength(1);
    expect(starts).toHaveLength(1);

    // The join: one id on both halves, and it is the browser's.
    expect(starts[0].d.requestId).toBe(REQUEST_ID);
    expect(logs[0].d.requestId).toBe(REQUEST_ID);
    expect(logs[0].d.requestId).toBe(starts[0].d.requestId);

    // And both halves land in the browser's session, not the process's.
    expect(logs[0].sessionId).toBe(SESSION);
    expect(postSessionsFor(posts, "backend.log")).toEqual([SESSION]);
    expect(logs[0].sessionId).not.toBe(processSession);

    // The application's own logger id is still preserved as context, so a
    // reader can still grep the app's logs for it.
    expect((logs[0].d.fields as Record<string, unknown>).reqId).toBe(
      "070e8640-1c2d-4f0a-9a58-9b7ff2f7a0e1",
    );
  });

  it("joins a process-session request's log to that request too", async () => {
    const { posts, fetchImpl } = fakeIngest();
    const stdout = fakeStream();
    capture = await autoCapture({
      endpoint: ENDPOINT,
      authToken: "ctkey_test",
      fetchImpl,
      loadEnv: false,
      instrumentDatabases: false,
      captureRuntimeWarnings: false,
      logStreams: { stdout, stderr: stdout },
    });

    const app = express();
    app.get("/jobs", (_req, res) => {
      stdout.write(logLine(50, "job failed"));
      res.status(500).end();
    });
    const { port } = await listen(app);

    // No correlation headers at all: the ordinary backend with no browser in
    // front of it.
    await (await fetch(`http://127.0.0.1:${port}/jobs`)).text();
    await flushBackendEvents();

    const logs = eventsOfKind(posts, "backend.log");
    const starts = eventsOfKind(posts, "backend.req.start");
    expect(starts).toHaveLength(1);
    expect(logs).toHaveLength(1);
    // The id the request minted for itself is the id the log carries, so the
    // two still join inside the process's own session.
    expect(logs[0].d.requestId).toBe(starts[0].d.requestId);
    expect(typeof logs[0].d.requestId).toBe("string");
    expect(logs[0].sessionId).toBe(capture.sessionId);
    expect(starts[0].sessionId).toBe(capture.sessionId);
  });

  it("keeps two concurrent requests' log lines on their own request ids", async () => {
    const { posts, fetchImpl } = fakeIngest();
    const stdout = fakeStream();
    capture = await autoCapture({
      endpoint: ENDPOINT,
      authToken: "ctkey_test",
      fetchImpl,
      loadEnv: false,
      instrumentDatabases: false,
      captureRuntimeWarnings: false,
      logStreams: { stdout, stderr: stdout },
    });

    const app = express();
    app.get("/slow", async (req, res) => {
      const delay = Number(req.query.delay ?? 0);
      await new Promise((resolve) => setTimeout(resolve, delay));
      stdout.write(logLine(50, `failed ${String(req.query.tag)}`));
      res.status(500).end();
    });
    const { port } = await listen(app);

    const call = (session: string, requestId: string, tag: string, delay: number) =>
      fetch(`http://127.0.0.1:${port}/slow?tag=${tag}&delay=${delay}`, {
        headers: {
          "x-crumbtrail-session-id": session,
          "x-crumbtrail-request-id": requestId,
        },
      }).then((response) => response.text());

    await Promise.all([
      call(SESSION, REQUEST_ID, "alpha", 25),
      call(OTHER_SESSION, OTHER_REQUEST_ID, "beta", 1),
    ]);
    await flushBackendEvents();

    const logs = eventsOfKind(posts, "backend.log");
    expect(logs).toHaveLength(2);
    const byMessage = new Map(
      logs.map((event) => [String(event.d.message), event]),
    );
    const alpha = byMessage.get("failed alpha");
    const beta = byMessage.get("failed beta");
    expect(alpha?.d.requestId).toBe(REQUEST_ID);
    expect(alpha?.sessionId).toBe(SESSION);
    expect(beta?.d.requestId).toBe(OTHER_REQUEST_ID);
    expect(beta?.sessionId).toBe(OTHER_SESSION);
  });

  it("leaves a line written outside every request exactly as it was", async () => {
    const { posts, fetchImpl } = fakeIngest();
    const stdout = fakeStream();
    capture = await autoCapture({
      endpoint: ENDPOINT,
      authToken: "ctkey_test",
      fetchImpl,
      loadEnv: false,
      instrumentDatabases: false,
      captureRuntimeWarnings: false,
      logStreams: { stdout, stderr: stdout },
    });

    stdout.write(logLine(50, "startup: cache warm failed"));
    await flushBackendEvents();

    const logs = eventsOfKind(posts, "backend.log");
    expect(logs).toHaveLength(1);
    expect(logs[0].d.requestId).toBeUndefined();
    expect(logs[0].sessionId).toBe(capture.sessionId);
    expect(postSessionsFor(posts, "backend.log")).toEqual([capture.sessionId]);
  });
});

describe("console.error raised inside a request", () => {
  it("carries the request id and lands in the browser's session", async () => {
    const { posts, fetchImpl } = fakeIngest();
    // A console of the test's own, so the capture patches THAT rather than the
    // real one — and so the handler's error never reaches the terminal.
    const consoleImpl = { error: () => {} } as Pick<Console, "error">;
    capture = await autoCapture({
      endpoint: ENDPOINT,
      authToken: "ctkey_test",
      fetchImpl,
      loadEnv: false,
      instrumentDatabases: false,
      captureRuntimeWarnings: false,
      captureLogs: false,
      consoleImpl,
    });

    const app = express();
    app.get("/orders", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      consoleImpl.error("order lookup failed: relation does not exist");
      res.status(500).end();
    });
    const { port } = await listen(app);

    await (
      await fetch(`http://127.0.0.1:${port}/orders`, {
        headers: {
          "x-crumbtrail-session-id": SESSION,
          "x-crumbtrail-request-id": REQUEST_ID,
        },
      })
    ).text();
    await flushBackendEvents();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const uncaught = eventsOfKind(posts, "backend.uncaught").filter(
      (event) =>
        typeof (event.d.error as { message?: unknown })?.message === "string" &&
        String((event.d.error as { message?: string }).message).includes(
          "order lookup failed",
        ),
    );
    expect(uncaught).toHaveLength(1);
    expect(uncaught[0].d.requestId).toBe(REQUEST_ID);
    expect(uncaught[0].sessionId).toBe(SESSION);
    // Addressed to the browser's session, not autoCapture's headless one.
    expect(
      posts
        .filter((post) => post.events.some((event) => event === uncaught[0]))
        .map((post) => post.sessionId),
    ).toEqual([SESSION]);
  });

  it("leaves a console.error outside every request on the process session", async () => {
    const { posts, fetchImpl } = fakeIngest();
    const consoleImpl = { error: () => {} } as Pick<Console, "error">;
    capture = await autoCapture({
      endpoint: ENDPOINT,
      authToken: "ctkey_test",
      fetchImpl,
      loadEnv: false,
      instrumentDatabases: false,
      captureRuntimeWarnings: false,
      captureLogs: false,
      consoleImpl,
    });
    consoleImpl.error("startup failed");
    await flushBackendEvents();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const uncaught = eventsOfKind(posts, "backend.uncaught");
    expect(uncaught.length).toBeGreaterThan(0);
    for (const event of uncaught) {
      expect(event.d.requestId).toBeUndefined();
      expect(event.sessionId).toBeUndefined();
    }
  });
});

describe("the express middleware's own context", () => {
  it("stamps its request id on a log line with no autoCapture installed", async () => {
    const { posts, fetchImpl } = fakeIngest();
    const stdout = fakeStream();

    const app = express();
    const middleware = createCrumbtrailExpressMiddleware({
      endpoint: ENDPOINT,
      fetch: fetchImpl,
      logStreams: { stdout, stderr: stdout },
      captureRuntimeWarnings: false,
    });
    app.use(middleware);
    app.get("/orders/:id", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      stdout.write(logLine(50, "handler failed"));
      res.status(500).end();
    });
    const { port } = await listen(app);

    try {
      await (
        await fetch(`http://127.0.0.1:${port}/orders/7`, {
          headers: {
            "x-crumbtrail-session-id": SESSION,
            "x-crumbtrail-request-id": REQUEST_ID,
          },
        })
      ).text();
      await flushBackendEvents();

      const logs = eventsOfKind(posts, "backend.log");
      const starts = eventsOfKind(posts, "backend.req.start");
      expect(starts).toHaveLength(1);
      expect(logs).toHaveLength(1);
      expect(logs[0].d.requestId).toBe(REQUEST_ID);
      expect(logs[0].d.requestId).toBe(starts[0].d.requestId);
      expect(logs[0].sessionId).toBe(SESSION);
      expect(postSessionsFor(posts, "backend.log")).toEqual([SESSION]);
    } finally {
      middleware.crumbtrailLogCapture?.stop();
    }
  });
});
