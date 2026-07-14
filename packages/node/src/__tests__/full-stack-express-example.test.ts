import { describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Crumbtrail } from "crumbtrail-core";
import { createServer } from "../server";
import { McpServer } from "../mcp-server";
import {
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
} from "../express";

const TOKEN = "vitest-token-super-secret-1234567890";

describe("full-stack Express example integration", () => {
  it("generates linked client, backend, LLM, and MCP evidence for the no-extension demo failure", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-full-stack-test-"),
    );
    const outputDir = path.join(tmpRoot, "sessions");
    const crumbtrailServer = createServer({ port: 0, outputDir });
    let demoServer: http.Server | undefined;
    let client: Crumbtrail | undefined;

    try {
      await listen(crumbtrailServer);
      const crumbtrailUrl = serverUrl(crumbtrailServer);
      const transport = new AwaitableTransport(crumbtrailUrl);
      let sessionId = "";

      const backendFetch = new TrackedFetch();
      demoServer = await startSourceExpressDemo({
        crumbtrailUrl,
        sessionId: () => sessionId,
        fetch: backendFetch.fetch,
      });
      const demoUrl = serverUrl(demoServer);

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
        networkCorrelationAllowedOrigins: [demoUrl],
        flushIntervalMs: 60_000,
        flushBufferSize: 100,
        httpEndpoint: crumbtrailUrl,
        transportInstance: transport,
      });

      sessionId = client.getSessionId();
      await transport.waitForSessionStart();

      const response = await fetch(
        `${demoUrl}/api/demo-bug?token=${encodeURIComponent(TOKEN)}`,
      );
      const body = (await response.json()) as {
        ok?: boolean;
        requestId?: string;
      };
      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.requestId).toEqual(
        expect.stringMatching(/^[A-Za-z0-9._:-]+$/),
      );
      const requestId = body.requestId!;

      await backendFetch.waitForIdle();
      await client.stop();
      client = undefined;

      const sessionDir = findSessionDir(outputDir, sessionId);
      const eventsPath = path.join(sessionDir, "events.ndjson");
      const indexPath = path.join(sessionDir, "index.json");
      const llmJsonPath = path.join(sessionDir, "llm.json");
      const llmMdPath = path.join(sessionDir, "llm.md");

      for (const artifactPath of [
        eventsPath,
        indexPath,
        llmJsonPath,
        llmMdPath,
      ]) {
        expect(fs.existsSync(artifactPath), artifactPath).toBe(true);
      }

      const events = readEvents(eventsPath);
      for (const kind of [
        "net.req",
        "net.res",
        "backend.req.start",
        "backend.req.error",
        "backend.req.end",
      ]) {
        expect(
          events.some(
            (event) =>
              event.k === kind &&
              event.d.sessionId === sessionId &&
              event.d.requestId === requestId,
          ),
          kind,
        ).toBe(true);
      }
      expect(
        events.some(
          (event) =>
            event.k === "net.res" &&
            event.d.requestId === requestId &&
            event.d.st === 500,
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.k === "backend.req.end" &&
            event.d.requestId === requestId &&
            event.d.statusCode === 500,
        ),
      ).toBe(true);

      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      expect(index.fullStackRequests.summary.linked).toBeGreaterThanOrEqual(1);
      const linked = index.fullStackRequests.linked.find(
        (entry: any) =>
          entry.sessionId === sessionId && entry.requestId === requestId,
      );
      expect(linked).toMatchObject({
        frontend: { status: 500 },
        backend: { statusCode: 500, correlation: { status: "linked" } },
      });

      const llmJson = JSON.parse(fs.readFileSync(llmJsonPath, "utf-8"));
      expect(
        llmJson.fullStackEvidence.linked.some(
          (entry: any) => entry.requestId === requestId,
        ),
      ).toBe(true);
      const llmMd = fs.readFileSync(llmMdPath, "utf-8");
      expect(llmMd).toContain("## Full-Stack Request Evidence");
      expect(llmMd).toContain("### Linked Request Moments");
      expect(llmMd).toContain(requestId);

      const mcpResponse = await new McpServer({ outputDir }).handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "getLinkedRequestContext",
          arguments: { sessionId, requestId },
        },
      });
      const mcpResult = mcpResponse!.result as any;
      const mcpText = mcpResult.content[0].text;
      const mcp = JSON.parse(mcpText);
      expect(mcp).toMatchObject({
        status: "linked",
        correlationStatus: "linked",
        linked: {
          frontend: { status: 500 },
          backend: {
            statusCode: 500,
            correlation: { status: "linked" },
          },
        },
      });
      expect(mcp.linked.backend.start).toBeDefined();
      expect(mcp.linked.backend.errorRef).toBeDefined();
      expect(mcp.linked.backend.end).toBeDefined();
      expect(mcp.diagnostics.join(" ")).toMatch(
        /Linked full-stack request evidence/i,
      );

      for (const text of [
        fs.readFileSync(indexPath, "utf-8"),
        fs.readFileSync(llmJsonPath, "utf-8"),
        llmMd,
        mcpText,
      ]) {
        expect(text).not.toContain(TOKEN);
      }
    } finally {
      if (client) await client.stop().catch(() => undefined);
      if (demoServer) await closeServer(demoServer);
      await closeServer(crumbtrailServer);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

function createSourceExpressDemoApp(options: {
  crumbtrailUrl: string;
  sessionId: string | (() => string | undefined);
  fetch: typeof globalThis.fetch;
}) {
  const app = express();
  app.disable("x-powered-by");
  const middlewareOptions = {
    endpoint: options.crumbtrailUrl,
    sessionId: options.sessionId,
    fetch: options.fetch,
  };

  app.use(createCrumbtrailExpressMiddleware(middlewareOptions));
  app.get("/api/demo-bug", async (_req, _res, next) => {
    await Promise.resolve();
    next(new Error("Intentional Crumbtrail Express demo failure"));
  });
  app.use(createCrumbtrailExpressErrorMiddleware(middlewareOptions));
  app.use((error: unknown, req: any, res: any, _next: any) => {
    const requestId =
      typeof req.get === "function"
        ? req.get("x-crumbtrail-request-id")
        : undefined;
    res.status(500).json({
      ok: false,
      error: "DEMO_BUG",
      message:
        "The demo route failed safely. Inspect Crumbtrail artifacts for correlated details.",
      requestId,
    });
  });
  return app;
}

async function startSourceExpressDemo(options: {
  crumbtrailUrl: string;
  sessionId: string | (() => string | undefined);
  fetch: typeof globalThis.fetch;
}): Promise<http.Server> {
  const app = createSourceExpressDemoApp(options);
  const server = app.listen(0, "127.0.0.1");
  await onceListening(server);
  return server;
}

class TrackedFetch {
  pending = new Set<Promise<Response>>();
  failures: unknown[] = [];
  fetch: typeof globalThis.fetch = (input, init) => {
    const promise = Promise.resolve(globalThis.fetch(input, init))
      .catch((error) => {
        this.failures.push(error);
        throw error;
      })
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
    return promise;
  };

  async waitForIdle(): Promise<void> {
    const startedAt = Date.now();
    while (this.pending.size > 0) {
      if (Date.now() - startedAt > 3_000)
        throw new Error(
          `Timed out waiting for backend intake; pending=${this.pending.size}`,
        );
      await Promise.race([...this.pending, delay(20)]).catch(() => undefined);
    }
    if (this.failures.length > 0)
      throw new Error("Backend intake fetch failed");
  }
}

class AwaitableTransport {
  sessionId = "";
  pending = new Set<Promise<unknown>>();
  failures: unknown[] = [];
  startPromise?: Promise<void>;

  constructor(readonly endpoint: string) {}

  async startSession(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.sessionId = sessionId;
    this.startPromise = this.track(
      this.postJson("/api/session/start", { sessionId, metadata }),
    );
    await this.startPromise;
  }

  async sendEvents(events: unknown[]): Promise<void> {
    await this.track(
      this.postJson("/api/events", { sessionId: this.sessionId, events }),
    );
  }

  async sendBlob(name: string, blob: Blob): Promise<void> {
    await this.track(
      this.checkedFetch(`/api/blob/${name}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Session-Id": this.sessionId,
        },
        body: blob,
      }),
    );
  }

  async sendBugReport(report: unknown, events: unknown[]): Promise<void> {
    await this.track(this.postJson("/api/bug/flag", { report, events }));
  }

  async endSession(sessionId: string): Promise<void> {
    await this.waitForIdle();
    await this.postJson("/api/session/end", { sessionId });
  }

  async waitForSessionStart(): Promise<void> {
    if (!this.startPromise) throw new Error("startSession was not called");
    await this.startPromise;
  }

  async waitForIdle(): Promise<void> {
    const startedAt = Date.now();
    while (this.pending.size > 0) {
      if (Date.now() - startedAt > 3_000)
        throw new Error(
          `Timed out waiting for client intake; pending=${this.pending.size}`,
        );
      await Promise.race([...this.pending, delay(20)]).catch(() => undefined);
    }
    if (this.failures.length > 0) throw new Error("Client intake failed");
  }

  async postJson(pathname: string, body: unknown): Promise<void> {
    await this.checkedFetch(pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async checkedFetch(pathname: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.endpoint}${pathname}`, init);
    expect(response.ok, `${pathname} status ${response.status}`).toBe(true);
    return response;
  }

  track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise
      .catch((error) => {
        this.failures.push(error);
        throw error;
      })
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }
}

async function listen(server: http.Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  await onceListening(server);
}

async function onceListening(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function serverUrl(server: http.Server): string {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server address unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function readEvents(
  eventsPath: string,
): Array<{ k: string; d: Record<string, unknown> }> {
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findSessionDir(outputDir: string, sessionId: string): string {
  const stack = [outputDir];
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
