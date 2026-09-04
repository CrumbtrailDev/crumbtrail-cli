import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { BACKEND_REDACTION_POLICY, type BugEvent } from "crumbtrail-core";
import { installHttpRequestCapture } from "../http-server";
import { createCrumbtrailExpressMiddleware } from "../express";
import { setProcessSessionId, clearProcessSessionId } from "../process-session";
import { flushBackendEvents } from "../backend-intake";

/**
 * Request bodies are the operands a backend was ASKED for. The response
 * recorder already says what came back; without this half a session
 * investigating "the API returned the wrong total" holds the total and none of
 * the numbers it was computed from.
 *
 * The load-bearing assertions here are the non-interference ones. The request
 * stream belongs to the application, so every capture test also checks that the
 * handler received the exact bytes the client sent, including a chunked request
 * with no `Content-Length`.
 */

const SESSION = "sess_request_body";

const running: Server[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  clearProcessSessionId();
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  running.push(server);
  return (server.address() as AddressInfo).port;
}

/** Collects the events the recorder emits, in order. */
function sink(): { events: BugEvent[]; emit: (event: BugEvent) => void } {
  const events: BugEvent[] = [];
  return {
    events,
    emit: (event) => {
      events.push(event);
    },
  };
}

function endEvent(events: BugEvent[]): BugEvent | undefined {
  return events.find((event) => event.k === "backend.req.end");
}

/**
 * POST with the body written in separate frames and NO `Content-Length`, so
 * Node sends `Transfer-Encoding: chunked`. Resolves with what the server
 * answered.
 */
function postChunked(
  port: number,
  path: string,
  frames: readonly string[],
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    for (const frame of frames) req.write(frame);
    req.end();
  });
}

/** An echo server: the handler consumes the stream and answers with what it read. */
function echoServer(status = 200): Server {
  return createServer((req, res) => {
    const received: Buffer[] = [];
    req.on("data", (chunk: Buffer) => received.push(chunk));
    req.on("end", () => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(Buffer.concat(received));
    });
  });
}

describe("http request body capture (node:http)", () => {
  it("captures nothing by default", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({ emit });
    stops.push(() => install.stop());
    const port = await listen(echoServer());

    const payload = JSON.stringify({ total: 12, coupon: "SPRING" });
    const echoed = await postChunked(port, "/orders", [payload]);

    expect(echoed.body).toBe(payload);
    expect(endEvent(events)?.d.requestBody).toBeUndefined();
  });

  it("records the operands, redacted, on the terminal event", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({
      emit,
      request: { captureRequestBody: "all" },
    });
    stops.push(() => install.stop());
    const port = await listen(echoServer());

    const payload = JSON.stringify({
      quantity: 3,
      unitPrice: 4.5,
      password: "hunter2!",
    });
    const echoed = await postChunked(port, "/orders", [payload]);

    // Non-interference: the handler read every byte the client sent.
    expect(echoed.body).toBe(payload);

    const end = endEvent(events);
    const raw = String(end?.d.requestBody);
    const captured = JSON.parse(raw) as Record<string, unknown>;
    // The operands survive; the credential does not.
    expect(captured.quantity).toBe(3);
    expect(captured.unitPrice).toBe(4.5);
    expect(raw).not.toContain("hunter2!");
    expect(JSON.stringify(captured.password)).toContain("REDACTED");
  });

  it("stamps the backend plane on the request body's redaction", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({
      emit,
      request: { captureRequestBody: "all" },
    });
    stops.push(() => install.stop());
    const port = await listen(echoServer());

    await postChunked(port, "/orders", [JSON.stringify({ ssn: "123456789" })]);

    const redaction = endEvent(events)?.d.redaction as
      | { policy?: string }
      | undefined;
    expect(redaction?.policy).toBe(BACKEND_REDACTION_POLICY);
  });

  it("keeps both bodies in one redaction declaration", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({
      emit,
      request: { captureRequestBody: "all" },
      response: { captureResponseBody: "all" },
    });
    stops.push(() => install.stop());
    const port = await listen(echoServer());

    await postChunked(port, "/orders", [
      JSON.stringify({ email: "buyer@example.com" }),
    ]);

    const end = endEvent(events);
    const paths = (
      (end?.d.redaction as { fields?: Array<{ path?: string }> } | undefined)
        ?.fields ?? []
    ).map((field) => field.path);
    expect(paths).toContain("requestBody.email");
    expect(paths).toContain("responseBody.email");
  });

  it("reports the payload summary and the truncation flag", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({
      emit,
      request: { captureRequestBody: "all", requestBodyMaxBytes: 24 },
    });
    stops.push(() => install.stop());
    const port = await listen(echoServer());

    const payload = JSON.stringify({ note: "x".repeat(200) });
    const echoed = await postChunked(port, "/notes", [payload]);

    expect(echoed.body).toBe(payload);
    const end = endEvent(events);
    expect(end?.d.requestBodyTruncated).toBe(true);
    expect(end?.d.requestBodySummary).toBeDefined();
  });

  it("leaves the bytes intact across a chunked request with no content-length", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({
      emit,
      request: { captureRequestBody: "all" },
    });
    stops.push(() => install.stop());

    let hadContentLength = true;
    let wasChunked = false;
    const server = createServer((req, res) => {
      hadContentLength = req.headers["content-length"] !== undefined;
      wasChunked = req.headers["transfer-encoding"] === "chunked";
      const received: Buffer[] = [];
      req.on("data", (chunk: Buffer) => received.push(chunk));
      req.on("end", () => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(Buffer.concat(received));
      });
    });
    const port = await listen(server);

    const first = '{"items":[{"sku":"A-1","qty":2},';
    const second = '{"sku":"B-9","qty":40}],"note":"split across frames"}';
    const echoed = await postChunked(port, "/cart", [first, second]);

    expect(hadContentLength).toBe(false);
    expect(wasChunked).toBe(true);
    // The exact original bytes, both frames, in order.
    expect(echoed.body).toBe(first + second);

    const captured = JSON.parse(
      String(endEvent(events)?.d.requestBody),
    ) as Record<string, unknown>;
    expect(captured.items).toHaveLength(2);
  });

  it("does not disturb a handler that never reads the request stream", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({
      emit,
      request: { captureRequestBody: "all" },
    });
    stops.push(() => install.stop());

    const server = createServer((_req, res) => {
      res.statusCode = 202;
      res.end("accepted");
    });
    const port = await listen(server);

    const answered = await postChunked(port, "/ignore", [
      JSON.stringify({ ignored: true }),
    ]);
    expect(answered.status).toBe(202);
    expect(answered.body).toBe("accepted");
    expect(endEvent(events)?.d.statusCode).toBe(202);
  });

  it("captures only failures in error mode", async () => {
    setProcessSessionId(SESSION);
    const ok = sink();
    const okInstall = installHttpRequestCapture({
      emit: ok.emit,
      request: { captureRequestBody: "error" },
    });
    stops.push(() => okInstall.stop());
    const okPort = await listen(echoServer(200));
    await postChunked(okPort, "/ok", [JSON.stringify({ qty: 1 })]);
    expect(endEvent(ok.events)?.d.requestBody).toBeUndefined();
    okInstall.stop();

    const failed = sink();
    const failInstall = installHttpRequestCapture({
      emit: failed.emit,
      request: { captureRequestBody: "error" },
    });
    stops.push(() => failInstall.stop());
    const failPort = await listen(echoServer(500));
    await postChunked(failPort, "/fail", [JSON.stringify({ qty: 1 })]);
    expect(String(endEvent(failed.events)?.d.requestBody)).toContain("qty");
  });

  it("skips a binary request body", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({
      emit,
      request: { captureRequestBody: "all" },
    });
    stops.push(() => install.stop());
    const port = await listen(echoServer());

    await postChunked(port, "/upload", ["not really a png"], {
      "content-type": "image/png",
    });
    expect(endEvent(events)?.d.requestBody).toBeUndefined();
  });

  it("skips a content-encoded body, which the stream carries compressed", async () => {
    setProcessSessionId(SESSION);
    const { events, emit } = sink();
    const install = installHttpRequestCapture({
      emit,
      request: { captureRequestBody: "all" },
    });
    stops.push(() => install.stop());
    const port = await listen(echoServer());

    await postChunked(port, "/gz", ["not really gzip"], {
      "content-type": "application/json",
      "content-encoding": "gzip",
    });
    expect(endEvent(events)?.d.requestBody).toBeUndefined();
  });
});

/** The events the express middleware posted to its intake, flattened. */
function expressIntake(): {
  events: BugEvent[];
  fetchImpl: typeof fetch;
} {
  const events: BugEvent[] = [];
  const fetchImpl = (async (_input: unknown, init?: unknown) => {
    const body = (init as { body?: string } | undefined)?.body;
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    if (Array.isArray(parsed.events)) events.push(...(parsed.events as BugEvent[]));
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "{}",
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;
  return { events, fetchImpl };
}

describe("express request body capture", () => {
  it("records what arrived when mounted before the body parser", async () => {
    const { events, fetchImpl } = expressIntake();
    const app = express();
    app.use(
      createCrumbtrailExpressMiddleware({
        sessionId: () => SESSION,
        endpoint: "http://capture.test",
        fetch: fetchImpl,
        captureRequestBody: "all",
        captureLogs: false,
        captureRuntimeWarnings: false,
      }),
    );
    app.use(express.json());
    let parsedByApp: unknown;
    app.post("/orders", (req, res) => {
      parsedByApp = req.body;
      res.status(200).json({ ok: true });
    });
    const port = await listen(createServer(app));

    const answered = await postChunked(port, "/orders", [
      JSON.stringify({ quantity: 7, sku: "A-1" }),
    ]);
    await flushBackendEvents();

    expect(answered.status).toBe(200);
    // Non-interference: express's own parser still saw the whole body.
    expect(parsedByApp).toEqual({ quantity: 7, sku: "A-1" });

    const captured = JSON.parse(
      String(endEvent(events)?.d.requestBody),
    ) as Record<string, unknown>;
    expect(captured).toMatchObject({ quantity: 7, sku: "A-1" });
  });

  it("falls back to the parser's own body when mounted after it", async () => {
    const { events, fetchImpl } = expressIntake();
    const app = express();
    app.use(express.json());
    app.use(
      createCrumbtrailExpressMiddleware({
        sessionId: () => SESSION,
        endpoint: "http://capture.test",
        fetch: fetchImpl,
        captureRequestBody: "all",
        captureLogs: false,
        captureRuntimeWarnings: false,
      }),
    );
    let parsedByApp: unknown;
    app.post("/orders", (req, res) => {
      parsedByApp = req.body;
      res.status(200).json({ ok: true });
    });
    const port = await listen(createServer(app));

    const answered = await postChunked(port, "/orders", [
      JSON.stringify({ quantity: 7, password: "hunter2!" }),
    ]);
    await flushBackendEvents();

    expect(answered.status).toBe(200);
    expect(parsedByApp).toEqual({ quantity: 7, password: "hunter2!" });

    const raw = String(endEvent(events)?.d.requestBody);
    expect(JSON.parse(raw)).toMatchObject({ quantity: 7 });
    expect(raw).not.toContain("hunter2!");
  });

  it("records nothing by default", async () => {
    const { events, fetchImpl } = expressIntake();
    const app = express();
    app.use(
      createCrumbtrailExpressMiddleware({
        sessionId: () => SESSION,
        endpoint: "http://capture.test",
        fetch: fetchImpl,
        captureLogs: false,
        captureRuntimeWarnings: false,
      }),
    );
    app.use(express.json());
    app.post("/orders", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const port = await listen(createServer(app));

    await postChunked(port, "/orders", [JSON.stringify({ quantity: 7 })]);
    await flushBackendEvents();

    expect(endEvent(events)?.d.requestBody).toBeUndefined();
  });
});
