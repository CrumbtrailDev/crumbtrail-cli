#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Crumbtrail } from "../../packages/core/dist/index.js";
import { createServer, McpServer } from "../../packages/node/dist/index.js";
import { startOtelDemoServer } from "./server.mjs";

const __filename = fileURLToPath(import.meta.url);
const REQUIRED_ARTIFACTS = [
  "events.ndjson",
  "index.json",
  "llm.json",
  "llm.md",
];

class VerificationError extends Error {
  constructor(phase, message, context = {}) {
    super(`${phase}: ${message}`);
    this.name = "VerificationError";
    this.phase = phase;
    this.context = context;
  }
}

class AwaitableHttpTransport {
  constructor(endpoint, { fetchImpl = globalThis.fetch } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.sessionId = "";
    this.pending = new Set();
    this.failures = [];
    this.startPromise = undefined;
    this.lastFinalization = undefined;
  }

  async startSession(sessionId, metadata) {
    this.sessionId = sessionId;
    this.startPromise = this.track(
      "start-session",
      this.postJson("/api/session/start", { sessionId, metadata }),
    );
    await this.startPromise;
  }

  async sendEvents(events) {
    await this.track(
      "send-events",
      this.postJson("/api/events", { sessionId: this.sessionId, events }),
    );
  }

  async sendBlob() {
    /* unused in this example */
  }
  async sendBugReport() {
    /* unused in this example */
  }

  async endSession(sessionId) {
    await this.waitForIdle({ phase: "client-intake-before-finalize" });
    const response = await this.checkedFetch("/api/session/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    try {
      this.lastFinalization = await response.json();
    } catch {
      throw new VerificationError(
        "finalize-session",
        "malformed finalization response",
        { status: response.status },
      );
    }
    if (!this.lastFinalization?.ok) {
      throw new VerificationError(
        "finalize-session",
        "finalization response was not ok",
        { status: response.status },
      );
    }
  }

  async waitForSessionStart(timeoutMs = 3_000) {
    if (!this.startPromise)
      throw new VerificationError(
        "start-session",
        "Crumbtrail did not call transport.startSession",
      );
    await withTimeout(
      this.startPromise,
      timeoutMs,
      () =>
        new VerificationError(
          "start-session",
          "timed out waiting for session start",
        ),
    );
  }

  async waitForIdle({ timeoutMs = 3_000, phase = "client-intake" } = {}) {
    const startedAt = Date.now();
    while (this.pending.size > 0) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new VerificationError(
          phase,
          "timed out waiting for client intake",
          { pending: this.pending.size, failures: this.failures.length },
        );
      }
      await Promise.race([...this.pending, delay(25)]).catch(() => undefined);
    }
    if (this.failures.length > 0) {
      throw new VerificationError(phase, "client intake failed", {
        failure: this.failures[0],
      });
    }
  }

  async postJson(pathname, body) {
    return this.checkedFetch(pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async checkedFetch(pathname, init) {
    const response = await this.fetchImpl(`${this.endpoint}${pathname}`, init);
    if (!response.ok) {
      throw new VerificationError(
        "crumbtrail-server",
        "Crumbtrail intake returned an HTTP error",
        { pathname, status: response.status },
      );
    }
    return response;
  }

  track(phase, promise) {
    const tracked = Promise.resolve(promise)
      .catch((error) => {
        this.failures.push({ phase, error: safeErrorName(error) });
        throw error;
      })
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }
}

export async function runFullStackOtelVerification(options = {}) {
  const rawFetch = options.fetchImpl ?? globalThis.fetch;
  const outputDir =
    options.outputDir ??
    process.env.CRUMBTRAIL_EXAMPLE_OUTPUT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-otlp-"));
  const crumbtrailServer = createServer({ port: 0, outputDir });
  let demo;
  let client;
  let sessionId;
  let traceId;

  try {
    await listen(crumbtrailServer, "127.0.0.1");
    const crumbtrailUrl = serverUrl(crumbtrailServer);

    const transport = new AwaitableHttpTransport(crumbtrailUrl, {
      fetchImpl: rawFetch,
    });
    demo = await startOtelDemoServer({
      port: 0,
      host: "127.0.0.1",
      endpoint: crumbtrailUrl,
      sessionId: () => sessionId,
      fetch: rawFetch,
    });

    // Browser SDK: network on, correlation headers on → traceparent is auto-injected on fetch.
    client = Crumbtrail.init({
      console: false,
      errors: false,
      interactions: false,
      keystrokes: false,
      scroll: false,
      visibility: false,
      clipboard: false,
      cookies: false,
      storage: false,
      performance: false,
      video: false,
      audio: false,
      heartbeat: false,
      widget: false,
      network: true,
      networkCorrelationHeaders: true,
      networkCorrelationAllowedOrigins: [demo.url],
      flushIntervalMs: 60_000,
      flushBufferSize: 100,
      httpEndpoint: crumbtrailUrl,
      transportInstance: transport,
    });
    sessionId = client.getSessionId();
    await transport.waitForSessionStart();

    // A single instrumented front-end fetch — the SDK stamps `traceparent` automatically.
    const response = await fetch(`${demo.url}/api/demo-bug`);
    const responseJson = await safeJson(response);
    if (response.status !== 500 || responseJson?.ok !== false) {
      throw new VerificationError(
        "otel-demo",
        "demo route did not return the expected safe 500 JSON response",
        { status: response.status },
      );
    }
    traceId = responseJson.traceId;
    if (!traceId || !/^[0-9a-f]{32}$/.test(traceId)) {
      throw new VerificationError(
        "otel-demo",
        "demo response did not carry a W3C trace id",
        { traceId },
      );
    }

    await client.stop();
    client = undefined;

    const sessionDir =
      transport.lastFinalization?.sessionDir ?? path.join(outputDir, sessionId);
    const artifacts = assertArtifacts(sessionDir);
    const events = readEvents(artifacts["events.ndjson"]);
    const eventCounts = assertCorrelatedEvents(events, { sessionId, traceId });
    const index = readJson(artifacts["index.json"], "index");
    const linkedEntry = assertIndex(index, { sessionId, traceId });
    const llmJson = readJson(artifacts["llm.json"], "llm-json");
    assertLlmArtifacts({
      llmJson,
      llmMarkdownPath: artifacts["llm.md"],
      traceId,
    });
    const mcp = await assertMcp({ outputDir, sessionId, traceId });

    const result = {
      sessionId,
      traceId,
      outputDir,
      sessionDir,
      artifacts,
      eventCounts,
      linkedCounts: {
        index: index.fullStackRequests.summary.linked,
        llm: llmJson.fullStackEvidence.summary.linked,
      },
      frontendStatus: linkedEntry.frontend.status,
      backendStatus: linkedEntry.backend.statusCode,
      backendRequestIdSource: linkedEntry.backend.correlation?.requestIdSource,
      mcpStatus: mcp.parsed.status,
    };

    if (options.print !== false) printBoundedResult(result);
    return result;
  } finally {
    if (client) await client.stop().catch(() => undefined);
    if (demo?.server) await closeServer(demo.server).catch(() => undefined);
    await closeServer(crumbtrailServer).catch(() => undefined);
  }
}

function assertArtifacts(sessionDir) {
  const artifacts = {};
  for (const name of REQUIRED_ARTIFACTS) {
    const artifactPath = path.join(sessionDir, name);
    if (!fs.existsSync(artifactPath)) {
      throw new VerificationError(
        "artifacts",
        `missing generated artifact ${name}`,
        { sessionDir, artifactPath },
      );
    }
    artifacts[name] = artifactPath;
  }
  return artifacts;
}

function assertCorrelatedEvents(events, { sessionId, traceId }) {
  const frontend = events.filter(
    (e) =>
      (e.k === "net.req" || e.k === "net.res") &&
      e.d?.requestId === traceId &&
      e.d?.sessionId === sessionId,
  );
  const spans = events.filter(
    (e) => e.k === "backend.otel.span" && e.d?.requestId === traceId,
  );
  if (frontend.length === 0) {
    throw new VerificationError(
      "events",
      "no front-end net.req/net.res carried the trace id",
      { traceId, observed: countKinds(events) },
    );
  }
  if (spans.length === 0) {
    throw new VerificationError(
      "events",
      "no backend.otel.span carried the trace id",
      { traceId, observed: countKinds(events) },
    );
  }
  // The front-end stamped a spec-valid traceparent (trace id == request id).
  const req = events.find(
    (e) => e.k === "net.req" && e.d?.requestId === traceId,
  );
  if (req?.d?.traceId !== traceId) {
    throw new VerificationError(
      "events",
      "net.req did not record the W3C trace id",
      { traceId, recorded: req?.d?.traceId },
    );
  }
  if (spans[0].d?.statusCode !== "ERROR") {
    throw new VerificationError("events", "OTLP span was not an ERROR span", {
      statusCode: spans[0].d?.statusCode,
    });
  }
  return { frontend: frontend.length, "backend.otel.span": spans.length };
}

function assertIndex(index, { sessionId, traceId }) {
  const section = index.fullStackRequests;
  if (!section?.summary || !Array.isArray(section.linked)) {
    throw new VerificationError(
      "index",
      "index.fullStackRequests is missing linked evidence",
      { sessionId, traceId },
    );
  }
  if (!(section.summary.linked >= 1)) {
    throw new VerificationError(
      "index",
      "index.fullStackRequests.summary.linked is below 1",
      { linked: section.summary.linked },
    );
  }
  const linked = section.linked.find(
    (entry) => entry.sessionId === sessionId && entry.requestId === traceId,
  );
  if (!linked)
    throw new VerificationError(
      "index",
      "linked request entry not found for the trace id",
      { sessionId, traceId },
    );
  if (linked.frontend?.status !== 500) {
    throw new VerificationError(
      "index",
      "linked front-end status was not 500",
      { frontendStatus: linked.frontend?.status },
    );
  }
  if (linked.backend?.statusCode !== 500) {
    throw new VerificationError(
      "index",
      "linked backend OTLP status was not 500",
      { backendStatus: linked.backend?.statusCode },
    );
  }
  if (linked.backend?.correlation?.requestIdSource !== "otlp-trace-id") {
    throw new VerificationError(
      "index",
      "backend correlation provenance was not the OTLP trace id",
      {
        requestIdSource: linked.backend?.correlation?.requestIdSource,
      },
    );
  }
  if (!linked.backend?.start || !linked.backend?.errorRef) {
    throw new VerificationError(
      "index",
      "OTLP backend evidence missing start/error refs",
      { sessionId, traceId },
    );
  }
  return linked;
}

function assertLlmArtifacts({ llmJson, llmMarkdownPath, traceId }) {
  const linked = llmJson.fullStackEvidence?.linked;
  if (
    !Array.isArray(linked) ||
    !linked.some((entry) => entry.requestId === traceId)
  ) {
    throw new VerificationError(
      "llm-json",
      "llm.json did not include linked full-stack evidence for the trace id",
      { traceId },
    );
  }
  const markdown = fs.readFileSync(llmMarkdownPath, "utf-8");
  if (
    !markdown.includes("## Full-Stack Request Evidence") ||
    !markdown.includes("### Linked Request Moments")
  ) {
    throw new VerificationError(
      "llm-md",
      "llm.md did not include the linked full-stack request evidence section",
      { llmMarkdownPath },
    );
  }
  // The 32-hex trace id must survive redaction (it is a correlation key, not a secret).
  if (!markdown.includes(traceId)) {
    throw new VerificationError(
      "llm-md",
      "llm.md did not include the linked trace id (was it redacted?)",
      { traceId },
    );
  }
}

async function assertMcp({ outputDir, sessionId, traceId }) {
  const server = new McpServer({ outputDir });
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "getLinkedRequestContext",
      arguments: { sessionId, requestId: traceId },
    },
  });
  const result = response?.result;
  if (!result || result.isError) {
    throw new VerificationError("mcp", "MCP lookup returned an error result", {
      sessionId,
      traceId,
    });
  }
  const text = result.content?.[0]?.text;
  const parsed = JSON.parse(text);
  if (parsed.status !== "linked") {
    throw new VerificationError(
      "mcp",
      "MCP lookup did not return linked status",
      { status: parsed.status },
    );
  }
  if (
    parsed.linked?.frontend?.status !== 500 ||
    parsed.linked?.backend?.statusCode !== 500
  ) {
    throw new VerificationError(
      "mcp",
      "MCP lookup did not preserve frontend/backend status evidence",
      {
        frontendStatus: parsed.linked?.frontend?.status,
        backendStatus: parsed.linked?.backend?.statusCode,
      },
    );
  }
  return { parsed, text };
}

function printBoundedResult(result) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionId: result.sessionId,
        traceId: result.traceId,
        sessionDir: result.sessionDir,
        eventCounts: result.eventCounts,
        linkedCounts: result.linkedCounts,
        statuses: {
          frontend: result.frontendStatus,
          backend: result.backendStatus,
          mcp: result.mcpStatus,
        },
        backendRequestIdSource: result.backendRequestIdSource,
      },
      null,
      2,
    ),
  );
}

function readEvents(eventsPath) {
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJson(filePath, phase) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new VerificationError(phase, "artifact JSON was malformed", {
      filePath,
      error: safeErrorName(error),
    });
  }
}

function countKinds(events) {
  const counts = {};
  for (const event of events) counts[event.k] = (counts[event.k] ?? 0) + 1;
  return counts;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    throw new VerificationError(
      "otel-demo",
      "demo route returned malformed JSON",
      { status: response.status },
    );
  }
}

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new VerificationError(
      "server-start",
      "server did not expose an address",
    );
  const host = address.address === "::" ? "localhost" : address.address;
  return `http://${host}:${address.port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, createError) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createError()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeErrorName(error) {
  return error instanceof VerificationError
    ? { name: error.name, phase: error.phase, context: error.context }
    : { name: error?.name ?? "Error" };
}

if (process.argv[1] === __filename) {
  runFullStackOtelVerification().catch((error) => {
    const payload =
      error instanceof VerificationError
        ? {
            ok: false,
            phase: error.phase,
            message: error.message,
            context: error.context,
          }
        : {
            ok: false,
            phase: "unknown",
            message: error?.message ?? String(error),
          };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  });
}
