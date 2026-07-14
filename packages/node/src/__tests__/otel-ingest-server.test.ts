import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import type http from "node:http";
import { parse } from "protobufjs";
import { createServer } from "../server";
import { convertOtlpTraceToEvents } from "../otel-adapter";

const OTLP_TEST_PROTO = `
syntax = "proto3";
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  uint64 start_time_unix_nano = 7;
  uint64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  Status status = 15;
}
message Status { string message = 2; int32 code = 3; }
message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; }
message LogRecord {
  uint64 time_unix_nano = 1;
  int32 severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  bytes trace_id = 9;
  bytes span_id = 10;
  uint64 observed_time_unix_nano = 11;
}
message Resource { repeated KeyValue attributes = 1; }
message InstrumentationScope { string name = 1; string version = 2; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue {
  string string_value = 1;
  bool bool_value = 2;
  int64 int_value = 3;
  double double_value = 4;
  ArrayValue array_value = 5;
  KeyValueList kvlist_value = 6;
  bytes bytes_value = 7;
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
`;

const otlpTestRoot = parse(OTLP_TEST_PROTO).root;

function hexBytes(value: string): Uint8Array {
  return Buffer.from(value, "hex");
}

function encodeTraceProtobuf(sessionId: string): Uint8Array {
  const type = otlpTestRoot.lookupType("ExportTraceServiceRequest");
  return type
    .encode(
      type.create({
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
                    traceId: hexBytes("4bf92f3577b34da6a3ce929d0e0e4736"),
                    spanId: hexBytes("00f067aa0ba902b7"),
                    name: "POST /protobuf-status",
                    kind: 2,
                    startTimeUnixNano: "1700000000000000000",
                    endTimeUnixNano: "1700000000050000000",
                    status: { code: 2, message: "upstream error" },
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
      }),
    )
    .finish();
}

function encodeLogProtobuf(sessionId: string): Uint8Array {
  const type = otlpTestRoot.lookupType("ExportLogsServiceRequest");
  return type
    .encode(
      type.create({
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "api" } },
                {
                  key: "crumbtrail.session.id",
                  value: { stringValue: sessionId },
                },
              ],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1700000000050000000",
                    severityText: "ERROR",
                    severityNumber: 17,
                    body: { stringValue: "worker ready" },
                    traceId: hexBytes("4bf92f3577b34da6a3ce929d0e0e4736"),
                    spanId: hexBytes("00f067aa0ba902b7"),
                    attributes: [
                      {
                        key: "http.route",
                        value: { stringValue: "/inventory" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    )
    .finish();
}

describe("OTLP ingest endpoints", () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;
  const authHeaders = {
    "X-Crumbtrail-Auth": "test-token",
    "Content-Type": "application/json",
  };
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-otlp-"));
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

  function tracePayload(sessionId: string) {
    return {
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
                  spanId,
                  name: "POST /checkout",
                  kind: 2,
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000050000000",
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
    };
  }

  function logPayload(sessionId?: string) {
    return {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "worker" } },
              { key: "service.version", value: { stringValue: "R182" } },
              ...(sessionId
                ? [
                    {
                      key: "crumbtrail.session.id",
                      value: { stringValue: sessionId },
                    },
                  ]
                : []),
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000050000000",
                  severityText: "ERROR",
                  severityNumber: 17,
                  body: { stringValue: "worker failed" },
                  traceId,
                  spanId,
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  function multiSpanTracePayload(sessionId: string) {
    const payload = tracePayload(sessionId);
    payload.resourceSpans[0].scopeSpans[0].spans.push({
      ...payload.resourceSpans[0].scopeSpans[0].spans[0],
      spanId: "1111111111111111",
      name: `POST /checkout/${"x".repeat(5000)}`,
    });
    return payload;
  }

  function findSessionDir(sessionId: string): string {
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

  it("ingests OTLP traces, creating the session and writing the span event", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(tracePayload("sess-otlp")),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });

    const eventsPath = path.join(findSessionDir("sess-otlp"), "events.ndjson");
    const lines = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const span = lines.find((e) => e.k === "backend.otel.span");
    expect(span.d.traceId).toBe(traceId);
    expect(span.d.requestId).toBe(traceId);
  });

  it("ingests protobuf OTLP traces", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/x-protobuf",
      },
      // Node's fetch (undici) accepts a Uint8Array body at runtime; mixing the
      // DOM and Node global `fetch`/`BodyInit` lib declarations makes the
      // static type of `body` resolve too narrowly here.
      body: encodeTraceProtobuf(
        "sess-otlp-protobuf-trace",
      ) as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });

    const eventsPath = path.join(
      findSessionDir("sess-otlp-protobuf-trace"),
      "events.ndjson",
    );
    const [span] = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(span.k).toBe("backend.otel.span");
    expect(span.d.traceId).toBe(traceId);
    expect(span.d.name).toBe("POST /protobuf-status");
    expect(span.d.statusMessage).toBe("upstream error");
  });

  it("accepts protobuf subtype content types", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/vnd.otlp+protobuf",
      },
      body: encodeTraceProtobuf(
        "sess-otlp-protobuf-subtype",
      ) as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });
  });

  it("ingests protobuf OTLP logs", async () => {
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/x-protobuf",
      },
      body: encodeLogProtobuf("sess-otlp-protobuf-log") as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });

    const eventsPath = path.join(
      findSessionDir("sess-otlp-protobuf-log"),
      "events.ndjson",
    );
    const [log] = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.k).toBe("backend.otel.log");
    expect(log.d.traceId).toBe(traceId);
    expect(log.d.body).toBe("[REDACTED]");
    expect(log.d.attributes["http.route"]).toBe("/inventory");
  });

  it("rejects unsupported OTLP media types", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "text/plain",
      },
      body: "not otlp",
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ code: "invalid_content_type" });
  });

  it("explains when OTLP gRPC framing hits the HTTP listener", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/grpc",
      },
      body: new Uint8Array([0, 0, 0, 0, 0]) as unknown as BodyInit,
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({
      code: "otlp_grpc_to_http",
      error: expect.stringContaining("change `otlp` to `otlphttp`"),
    });
  });

  it("rejects malformed protobuf OTLP payloads", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/x-protobuf",
      },
      body: new Uint8Array([0xff]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_protobuf" });
  });

  function findAutoSessionDirs(): string[] {
    const found: string[] = [];
    const stack = [tmpDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(dir, entry.name);
        if (
          entry.name.startsWith("auto.") &&
          fs.existsSync(path.join(candidate, "meta.json"))
        ) {
          found.push(candidate);
        }
        stack.push(candidate);
      }
    }
    return found;
  }

  it("auto-creates a session for traces with no crumbtrail.session.id", async () => {
    const payload = tracePayload("ignored");
    payload.resourceSpans[0].resource.attributes.push(
      { key: "service.version", value: { stringValue: "R182" } },
      { key: "deployment.environment", value: { stringValue: "staging" } },
      { key: "git.commit.sha", value: { stringValue: "abc123" } },
    );
    payload.resourceSpans[0].scopeSpans[0].spans[0].attributes = [];
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });

    const [sessionDir] = findAutoSessionDirs();
    expect(path.basename(sessionDir)).toMatch(/^auto\.api\.staging\.\d+$/);
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta).toMatchObject({
      source: "otlp",
      otlpAutoSession: true,
      app: "api",
      release: "R182",
      environment: "staging",
      build: "abc123",
    });
    const eventsPath = path.join(sessionDir, "events.ndjson");
    const [span] = fs
      .readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(span.d.requestId).toBe(traceId);
  });

  it("auto-creates a session for logs with no crumbtrail.session.id", async () => {
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(logPayload()),
    });
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });

    const [sessionDir] = findAutoSessionDirs();
    expect(path.basename(sessionDir)).toMatch(
      /^auto\.worker\.unknown-env\.\d+$/,
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta).toMatchObject({
      source: "otlp",
      otlpAutoSession: true,
      app: "worker",
      release: "R182",
    });
    expect(
      fs.readFileSync(path.join(sessionDir, "events.ndjson"), "utf-8"),
    ).toContain("backend.otel.log");
  });

  it("keeps the first auto-session window for later events with the same trace id", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      otlpAutoSessionWindowMs: 1,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;

    const first = tracePayload("ignored-a");
    first.resourceSpans[0].scopeSpans[0].spans[0].attributes = [];
    const second = tracePayload("ignored-b");
    second.resourceSpans[0].scopeSpans[0].spans[0].attributes = [];
    second.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano =
      "1700000060000000000";
    second.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano =
      "1700000060050000000";
    second.resourceSpans[0].scopeSpans[0].spans[0].name =
      "POST /checkout/later";

    await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(first),
    });
    await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(second),
    });

    const autoDirs = findAutoSessionDirs();
    expect(autoDirs).toHaveLength(1);
    const events = fs
      .readFileSync(path.join(autoDirs[0], "events.ndjson"), "utf-8")
      .trim()
      .split("\n");
    expect(events).toHaveLength(2);
  });

  it("skips events whose crumbtrail.session.id is an invalid/unsafe id", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(tracePayload("../etc")),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 0, skipped: 1 });
  });

  it("reports accepted, dropped, and truncated session counts when OTLP ingest hits the session cap", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const payload = multiSpanTracePayload("sess-otlp-cap");
    const firstEventBytes = Buffer.byteLength(
      `${JSON.stringify(convertOtlpTraceToEvents(payload)[0])}\n`,
      "utf-8",
    );
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      maxSessionEventBytes: firstEventBytes + 1,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;

    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ingested: 1,
      skipped: 1,
      truncatedSessions: 1,
    });
    const sessionDir = findSessionDir("sess-otlp-cap");
    const eventsPath = path.join(sessionDir, "events.ndjson");
    const markerPath = path.join(sessionDir, "capture-truncated.json");
    expect(
      fs.readFileSync(eventsPath, "utf-8").trim().split("\n"),
    ).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(markerPath, "utf-8"))).toMatchObject({
      truncated: true,
      reason: "session_event_bytes_cap",
      maxEventBytes: firstEventBytes + 1,
      eventsAccepted: 1,
      eventsDropped: 1,
    });
  });

  it("rejects unauthorized OTLP posts", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tracePayload("sess-otlp")),
    });
    expect(res.status).toBe(401);
  });

  it("ingests gzipped OTLP JSON traces (Content-Encoding: gzip)", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: zlib.gzipSync(
        Buffer.from(JSON.stringify(tracePayload("sess-otlp-gzip-json"))),
      ) as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });
    expect(
      fs.existsSync(
        path.join(findSessionDir("sess-otlp-gzip-json"), "events.ndjson"),
      ),
    ).toBe(true);
  });

  it("ingests gzipped protobuf OTLP traces", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "gzip",
      },
      body: zlib.gzipSync(
        Buffer.from(encodeTraceProtobuf("sess-otlp-gzip-proto")),
      ) as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });
    const [span] = fs
      .readFileSync(
        path.join(findSessionDir("sess-otlp-gzip-proto"), "events.ndjson"),
        "utf-8",
      )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(span.k).toBe("backend.otel.span");
    expect(span.d.name).toBe("POST /protobuf-status");
  });

  it("ingests gzipped protobuf OTLP logs", async () => {
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "gzip",
      },
      body: zlib.gzipSync(
        Buffer.from(encodeLogProtobuf("sess-otlp-gzip-log")),
      ) as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });
  });

  it("rejects a gzip zip-bomb past the inflated-size cap with 413", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      maxJsonBodyBytes: 4096,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;

    // A highly-compressible payload that inflates well past the 4096-byte cap
    // but stays tiny on the wire — the classic gzip amplification shape.
    const bomb = JSON.stringify({
      resourceSpans: [],
      pad: "A".repeat(200_000),
    });
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": "test-token",
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: zlib.gzipSync(Buffer.from(bomb)) as unknown as BodyInit,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "request_too_large" });
  });

  it("accepts Authorization: Bearer <token> equivalently to x-crumbtrail-auth", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tracePayload("sess-otlp-bearer")),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 1, skipped: 0 });
    expect(
      fs.existsSync(
        path.join(findSessionDir("sess-otlp-bearer"), "events.ndjson"),
      ),
    ).toBe(true);
  });

  it("rejects a wrong Bearer token with 401", async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tracePayload("sess-otlp")),
    });
    expect(res.status).toBe(401);
  });
});
