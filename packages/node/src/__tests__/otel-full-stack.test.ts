import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { createServer } from "../server";
import { OTEL_SPAN_EVENT } from "../otel-adapter";

describe("OTLP full-stack correlation", () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;
  const headers = {
    "X-Crumbtrail-Auth": "test-token",
    "Content-Type": "application/json",
  };
  const sessionId = "sess-fullstack";
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-otlp-fs-"));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function post(urlPath: string, body: unknown) {
    return fetch(`${baseUrl}${urlPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  function findSessionDir(): string {
    const stack = [tmpDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(dir, entry.name);
        if (
          entry.name === sessionId &&
          fs.existsSync(path.join(candidate, "meta.json"))
        )
          return candidate;
        stack.push(candidate);
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }

  it("links a frontend fetch and a backend OTLP span by one trace id", async () => {
    // 1. Frontend starts a session.
    await post("/api/session/start", {
      sessionId,
      metadata: { url: "http://app.local" },
    });

    // 2. Frontend records a network event whose requestId is the W3C trace id it propagated.
    await post("/api/events", {
      sessionId,
      events: [
        {
          t: 1700000000000,
          k: "net",
          d: { method: "POST", url: "/checkout", requestId: traceId },
        },
      ],
    });

    // 3. Backend (OTel-instrumented, no Crumbtrail SDK) exports the matching span via OTLP.
    await post("/v1/traces", {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: "00f067aa0ba902b7",
                  name: "POST /checkout",
                  kind: 2,
                  startTimeUnixNano: "1700000000010000000",
                  endTimeUnixNano: "1700000000090000000",
                  status: { code: 2 },
                  attributes: [
                    {
                      key: "crumbtrail.session.id",
                      value: { stringValue: sessionId },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    // 4. Both pieces of evidence live in one session, joined by the trace id.
    const eventsPath = path.join(findSessionDir(), "events.ndjson");
    const events = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const frontend = events.find((e) => e.k === "net");
    const backend = events.find((e) => e.k === OTEL_SPAN_EVENT);

    expect(frontend).toBeDefined();
    expect(backend).toBeDefined();
    expect(frontend.d.requestId).toBe(traceId);
    expect(backend.d.requestId).toBe(traceId);
    expect(frontend.d.requestId).toBe(backend.d.requestId); // correlated FE <-> BE
    expect(backend.d.serviceName).toBe("api");
    expect(backend.d.statusCode).toBe("ERROR");
  });
});
