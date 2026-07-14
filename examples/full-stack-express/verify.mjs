#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Crumbtrail } from "../../packages/core/dist/index.js";
import { createServer, McpServer } from "../../packages/node/dist/index.js";
import { startDemoServer } from "./server.mjs";

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_TOKEN = "verify-token-super-secret-1234567890";
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

class TrackedFetch {
  constructor(fetchImpl = globalThis.fetch, label = "fetch") {
    this.fetchImpl = fetchImpl;
    this.label = label;
    this.pending = new Set();
    this.settled = 0;
    this.rejections = [];
    this.fetch = this.fetch.bind(this);
  }

  fetch(input, init) {
    const promise = Promise.resolve()
      .then(() => this.fetchImpl(input, init))
      .catch((error) => {
        this.rejections.push(error);
        throw error;
      })
      .finally(() => {
        this.pending.delete(promise);
        this.settled += 1;
      });
    this.pending.add(promise);
    return promise;
  }

  async waitForIdle({ timeoutMs = 3_000, phase = this.label } = {}) {
    const startedAt = Date.now();
    while (this.pending.size > 0) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new VerificationError(
          phase,
          "timed out waiting for tracked fetches to settle",
          {
            pending: this.pending.size,
            settled: this.settled,
          },
        );
      }
      await Promise.race([...this.pending, delay(25)]).catch(() => undefined);
    }
    if (this.rejections.length > 0) {
      throw new VerificationError(phase, "tracked fetch rejected", {
        settled: this.settled,
        error: safeErrorName(this.rejections[0]),
      });
    }
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

  async sendBlob(name, blob, metadata) {
    const headers = {
      "Content-Type": "application/octet-stream",
      "X-Session-Id": this.sessionId,
    };
    if (metadata) headers["X-Metadata"] = JSON.stringify(metadata);
    await this.track(
      "send-blob",
      this.checkedFetch(`/api/blob/${name}`, {
        method: "POST",
        headers,
        body: blob,
      }),
    );
  }

  async sendBugReport(report, events, voiceBlob) {
    await this.track(
      "send-bug-report",
      this.postJson("/api/bug/flag", { report, events }),
    );
    if (voiceBlob) {
      await this.track(
        "send-bug-voice",
        this.checkedFetch(`/api/bug/${report.bugId}/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: voiceBlob,
        }),
      );
    }
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
          {
            pending: this.pending.size,
            failures: this.failures.length,
          },
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
        {
          pathname,
          status: response.status,
        },
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

export async function runFullStackExpressVerification(options = {}) {
  const rawFetch = options.fetchImpl ?? globalThis.fetch;
  const outputDir =
    options.outputDir ??
    process.env.CRUMBTRAIL_EXAMPLE_OUTPUT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-full-stack-"));
  const token = options.token ?? DEFAULT_TOKEN;
  const externalCrumbtrailUrl = options.crumbtrailUrl ?? options.endpoint;
  const crumbtrailServer = externalCrumbtrailUrl
    ? undefined
    : createServer({ port: 0, outputDir });
  let crumbtrailUrl = externalCrumbtrailUrl
    ? normalizeEndpoint(externalCrumbtrailUrl)
    : undefined;
  const demoHost = "127.0.0.1";
  const demoPort = await reservePort(demoHost);
  const demoOrigin = `http://${demoHost}:${demoPort}`;
  let demo;
  let client;
  let sessionId;
  let requestId;

  try {
    if (crumbtrailServer) {
      await listen(crumbtrailServer, "127.0.0.1");
      crumbtrailUrl = serverUrl(crumbtrailServer);
    }
    if (!crumbtrailUrl)
      throw new VerificationError(
        "server-start",
        "Crumbtrail endpoint was not available",
      );

    const transport = new AwaitableHttpTransport(crumbtrailUrl, {
      fetchImpl: rawFetch,
    });
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
      networkCorrelationAllowedOrigins: [demoOrigin],
      flushIntervalMs: 60_000,
      flushBufferSize: 100,
      httpEndpoint: crumbtrailUrl,
      transportInstance: transport,
    });
    sessionId = client.getSessionId();
    await transport.waitForSessionStart();

    const backendFetch = new TrackedFetch(rawFetch, "backend-intake");
    demo = await startDemoServer({
      port: demoPort,
      host: demoHost,
      endpoint: crumbtrailUrl,
      sessionId,
      fetch: backendFetch.fetch,
    });

    const response = await fetch(
      `${demo.url}/api/demo-bug?token=${encodeURIComponent(token)}`,
    );
    const responseJson = await safeJson(response);
    if (response.status !== 500 || responseJson?.ok !== false) {
      throw new VerificationError(
        "express-demo",
        "demo route did not return the expected safe 500 JSON response",
        {
          status: response.status,
          requestId: responseJson?.requestId,
        },
      );
    }
    requestId = responseJson.requestId;
    if (!requestId)
      throw new VerificationError(
        "express-demo",
        "demo response did not include a request ID",
        { status: response.status },
      );

    await backendFetch.waitForIdle({ phase: "backend-intake" });
    await client.stop();
    client = undefined;

    const sessionDir =
      transport.lastFinalization?.sessionDir ?? path.join(outputDir, sessionId);
    const artifacts = assertArtifacts(sessionDir);
    const events = readEvents(artifacts["events.ndjson"]);
    const linkedEvents = assertCorrelatedEvents(events, {
      sessionId,
      requestId,
    });
    const index = readJson(artifacts["index.json"], "index");
    const linkedEntry = assertIndex(index, { sessionId, requestId });
    const llmJson = readJson(artifacts["llm.json"], "llm-json");
    assertLlmArtifacts({
      llmJson,
      llmMarkdownPath: artifacts["llm.md"],
      requestId,
      token,
    });
    const mcp = await assertMcp({ outputDir, sessionId, requestId, token });
    const fixContext = await assertFixContextCausalChain({
      outputDir,
      sessionId,
      token,
    });
    assertNoSecretLeak({ artifacts, mcpText: mcp.text, token });

    const result = {
      sessionId,
      requestId,
      outputDir,
      sessionDir,
      artifacts,
      linkedCounts: {
        events: linkedEvents,
        index: index.fullStackRequests.summary.linked,
        llm: llmJson.fullStackEvidence.summary.linked,
      },
      frontendStatus: linkedEntry.frontend.status,
      backendStatus: linkedEntry.backend.statusCode,
      mcpStatus: mcp.parsed.status,
      mcpCorrelationStatus: mcp.parsed.correlationStatus,
      causalChainRootDetector: fixContext.causal_chain.root.detector,
      causalChainSymptomDetectors: fixContext.causal_chain.symptoms.map(
        (s) => s.detector,
      ),
    };

    if (options.print !== false) printBoundedResult(result);
    return result;
  } finally {
    if (client) {
      await client.stop().catch(() => undefined);
    }
    if (demo?.server) await closeServer(demo.server).catch(() => undefined);
    if (crumbtrailServer)
      await closeServer(crumbtrailServer).catch(() => undefined);
  }
}

function normalizeEndpoint(value) {
  const endpoint = String(value || "").trim();
  if (!endpoint) return undefined;
  return endpoint.replace(/\/+$/, "");
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

function assertCorrelatedEvents(events, { sessionId, requestId }) {
  const kinds = [
    "net.req",
    "net.res",
    "backend.req.start",
    "backend.req.error",
    "backend.req.end",
  ];
  const matches = Object.fromEntries(kinds.map((kind) => [kind, []]));
  for (const event of events) {
    if (!matches[event.k]) continue;
    const data = event.d ?? {};
    if (data.sessionId === sessionId && data.requestId === requestId)
      matches[event.k].push(event);
  }

  for (const kind of kinds) {
    if (matches[kind].length === 0) {
      throw new VerificationError(
        "events",
        `missing correlated ${kind} event`,
        {
          sessionId,
          requestId,
          observedCounts: countKinds(events),
        },
      );
    }
  }

  const failedResponse = matches["net.res"].find(
    (event) => event.d?.st === 500,
  );
  if (!failedResponse)
    throw new VerificationError("events", "missing failed net.res status 500", {
      sessionId,
      requestId,
    });
  const backendEnd = matches["backend.req.end"].find(
    (event) => event.d?.statusCode === 500,
  );
  if (!backendEnd)
    throw new VerificationError(
      "events",
      "missing backend.req.end statusCode 500",
      { sessionId, requestId },
    );
  return Object.fromEntries(
    Object.entries(matches).map(([kind, values]) => [kind, values.length]),
  );
}

function assertIndex(index, { sessionId, requestId }) {
  const section = index.fullStackRequests;
  if (!section?.summary || !Array.isArray(section.linked)) {
    throw new VerificationError(
      "index",
      "index.fullStackRequests is missing linked evidence",
      { sessionId, requestId },
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
    (entry) => entry.sessionId === sessionId && entry.requestId === requestId,
  );
  if (!linked)
    throw new VerificationError("index", "linked request entry not found", {
      sessionId,
      requestId,
    });
  if (linked.frontend?.status !== 500 || linked.backend?.statusCode !== 500) {
    throw new VerificationError(
      "index",
      "linked request did not preserve frontend/backend 500 statuses",
      {
        frontendStatus: linked.frontend?.status,
        backendStatus: linked.backend?.statusCode,
      },
    );
  }
  if (linked.backend?.correlation?.status !== "linked") {
    throw new VerificationError(
      "index",
      "linked request correlation status was not linked",
      {
        correlationStatus: linked.backend?.correlation?.status,
      },
    );
  }
  return linked;
}

function assertLlmArtifacts({ llmJson, llmMarkdownPath, requestId, token }) {
  const linked = llmJson.fullStackEvidence?.linked;
  if (
    !Array.isArray(linked) ||
    !linked.some((entry) => entry.requestId === requestId)
  ) {
    throw new VerificationError(
      "llm-json",
      "llm.json did not include linked full-stack evidence for request",
      { requestId },
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
  if (!markdown.includes(requestId)) {
    throw new VerificationError(
      "llm-md",
      "llm.md did not include the linked request ID",
      { requestId },
    );
  }
  if (JSON.stringify(llmJson).includes(token) || markdown.includes(token)) {
    throw new VerificationError(
      "redaction",
      "LLM artifacts leaked the query token",
      { requestId },
    );
  }
}

async function assertMcp({ outputDir, sessionId, requestId, token }) {
  const server = new McpServer({ outputDir });
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "getLinkedRequestContext",
      arguments: { sessionId, requestId },
    },
  });
  const result = response?.result;
  if (!result || result.isError) {
    throw new VerificationError("mcp", "MCP lookup returned an error result", {
      sessionId,
      requestId,
    });
  }
  const text = result.content?.[0]?.text;
  const parsed = JSON.parse(text);
  if (parsed.status !== "linked" || parsed.correlationStatus !== "linked") {
    throw new VerificationError(
      "mcp",
      "MCP lookup did not return linked status",
      {
        status: parsed.status,
        correlationStatus: parsed.correlationStatus,
      },
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
  if (
    !parsed.linked?.backend?.start ||
    !parsed.linked?.backend?.end ||
    !parsed.linked?.backend?.errorRef
  ) {
    throw new VerificationError(
      "mcp",
      "MCP lookup did not include backend lifecycle/error refs",
      { sessionId, requestId },
    );
  }
  if (
    !Array.isArray(parsed.diagnostics) ||
    parsed.diagnostics.length === 0 ||
    JSON.stringify(parsed.diagnostics).length > 1_000
  ) {
    throw new VerificationError(
      "mcp",
      "MCP diagnostics were missing or unbounded",
      { diagnosticsLength: JSON.stringify(parsed.diagnostics ?? "").length },
    );
  }
  if (text.includes(token))
    throw new VerificationError(
      "redaction",
      "MCP output leaked the query token",
      { requestId },
    );
  return { parsed, text };
}

async function assertFixContextCausalChain({ outputDir, sessionId, token }) {
  const server = new McpServer({ outputDir });
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "getFixContext", arguments: { sessionId } },
  });
  const result = response?.result;
  if (!result || result.isError) {
    throw new VerificationError(
      "fix-context",
      "getFixContext returned an error result",
      { sessionId },
    );
  }
  const text = result.content?.[0]?.text;
  const contract = JSON.parse(text);
  if (contract.schemaVersion !== "fix-context.v1") {
    throw new VerificationError(
      "fix-context",
      "fix-context schema version drifted",
      { schemaVersion: contract.schemaVersion },
    );
  }
  const chain = contract.causal_chain;
  if (!chain || !chain.root || !Array.isArray(chain.symptoms)) {
    throw new VerificationError(
      "fix-context",
      "fix-context did not surface a populated causal_chain",
      {
        causalChain: chain,
      },
    );
  }
  if (
    typeof chain.root.detector !== "string" ||
    !chain.root.detector.startsWith("backend_")
  ) {
    throw new VerificationError(
      "fix-context",
      "causal_chain root was not a backend root cause",
      {
        rootDetector: chain.root.detector,
      },
    );
  }
  const httpSymptom = chain.symptoms.find(
    (symptom) => symptom.detector === "http_error",
  );
  if (!httpSymptom) {
    throw new VerificationError(
      "fix-context",
      "causal_chain did not include the http_error symptom",
      {
        symptomDetectors: chain.symptoms.map((s) => s.detector),
      },
    );
  }
  if (contract.ranked_candidates?.[0]?.causalRole !== "root") {
    throw new VerificationError(
      "fix-context",
      "ranked_candidates[0] was not the causal root",
      {
        topCausalRole: contract.ranked_candidates?.[0]?.causalRole,
      },
    );
  }
  if (text.includes(token)) {
    throw new VerificationError(
      "redaction",
      "getFixContext output leaked the query token",
      { sessionId },
    );
  }
  return contract;
}

function assertNoSecretLeak({ artifacts, mcpText, token }) {
  for (const name of ["index.json", "llm.json", "llm.md"]) {
    const text = fs.readFileSync(artifacts[name], "utf-8");
    if (text.includes(token))
      throw new VerificationError(
        "redaction",
        `${name} leaked the query token`,
      );
  }
  if (mcpText.includes(token))
    throw new VerificationError(
      "redaction",
      "MCP output leaked the query token",
    );
}

function printBoundedResult(result) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionId: result.sessionId,
        requestId: result.requestId,
        outputDir: result.outputDir,
        sessionDir: result.sessionDir,
        artifacts: result.artifacts,
        linkedCounts: result.linkedCounts,
        statuses: {
          frontend: result.frontendStatus,
          backend: result.backendStatus,
          mcp: result.mcpStatus,
          mcpCorrelation: result.mcpCorrelationStatus,
        },
        causalChain: {
          rootDetector: result.causalChainRootDetector,
          symptomDetectors: result.causalChainSymptomDetectors,
        },
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
      "express-demo",
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

async function reservePort(host) {
  const server = http.createServer();
  await listen(server, host);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server).catch(() => undefined);
    throw new VerificationError(
      "server-start",
      "failed to reserve a local demo port",
    );
  }
  const port = address.port;
  await closeServer(server);
  return port;
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
  runFullStackExpressVerification().catch((error) => {
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
