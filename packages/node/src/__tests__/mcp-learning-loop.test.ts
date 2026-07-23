import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../mcp-server";

/**
 * CRUMB-113: the MCP server wires four things into the per-tenant learning loop.
 *  - resolveIssue   -> POST /api/memory/resolve  with optional usedMemoryIds (project-key auth)
 *  - recallSimilarIssues surfaces outcomeSummary + resolution_* reasons from the cloud
 *  - recordFeedback -> POST /api/agent/feedback  (agent-token auth)
 *  - getPlaybook    -> GET  /api/agent/playbook  (agent-token auth)
 *
 * These tests stand up a mock cloud that records what the client sent (path,
 * method, auth header, body/query) so we assert the wire contract, not just the
 * happy-path return.
 */
interface CapturedReq {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | undefined;
  agentToken: string | undefined;
  body: any;
}

interface MockCloud {
  url: string;
  requests: CapturedReq[];
  stop(): Promise<void>;
}

function startMockCloud(): Promise<MockCloud> {
  const requests: CapturedReq[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "", "http://mock.local");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({
        method: req.method ?? "",
        path: u.pathname,
        query: Object.fromEntries(u.searchParams.entries()),
        auth: req.headers["x-crumbtrail-auth"] as string | undefined,
        agentToken: (req.headers["authorization"] as string | undefined)
          ?.replace(/^Bearer\s+/i, "")
          .trim(),
        body,
      });

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.method === "POST" && u.pathname === "/api/memory/resolve") {
        const memBody = (body ?? {}) as Record<string, unknown>;
        const used = Array.isArray(memBody.usedMemoryIds)
          ? memBody.usedMemoryIds
          : undefined;
        return send(200, {
          ok: true,
          memoryId: memBody.memoryId,
          resolution: { disposition: memBody.disposition, source: "human" },
          ...(used ? { adopted: used.length } : {}),
        });
      }
      if (u.pathname === "/api/memory/recall") {
        return send(200, {
          indexed: true,
          matches: [
            {
              id: "mem_1",
              title: "Checkout 500",
              source: "session",
              sourceRef: "sess-a",
              route: "/checkout",
              errorFamily: "http_500",
              severity: "high",
              score: 0.82,
              reasons: ["semantic", "same-route", "resolution_verified"],
              resolution: { disposition: "real-bug", rootCause: "null cart" },
              outcomeSummary: "Fixed by guarding the empty cart; verified in prod.",
            },
          ],
        });
      }
      if (req.method === "POST" && u.pathname === "/api/agent/feedback") {
        const fbBody = (body ?? {}) as Record<string, unknown>;
        return send(201, {
          feedback: {
            id: "lfb_1",
            signal: fbBody.signal,
            source: fbBody.source,
            subjectRef: fbBody.subjectRef,
          },
        });
      }
      if (req.method === "GET" && u.pathname === "/api/agent/playbook") {
        return send(200, {
          rules: [{ id: "rule_1", text: "Check the cart is non-empty" }],
        });
      }
      send(404, { error: "Not found", code: "not_found" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object")
        return reject(new Error("no addr"));
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        stop: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

describe("MCP learning loop (CRUMB-113)", () => {
  let tmpDir: string;
  let mock: MockCloud | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-learn-"));
  });

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CRUMBTRAIL_CLOUD_URL;
    delete process.env.CRUMBTRAIL_CLOUD_TOKEN;
    delete process.env.CRUMBTRAIL_API_KEY;
  });

  async function call(server: McpServer, name: string, args: Record<string, unknown>) {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = res!.result as any;
    const text = result.content[0].text as string;
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined; // errorResult() returns a plain message, not JSON.
    }
    return { isError: result.isError === true, text, parsed };
  }

  function configureCloud(url: string) {
    process.env.CRUMBTRAIL_CLOUD_URL = url;
    process.env.CRUMBTRAIL_API_KEY = "proj-key-xyz";
    process.env.CRUMBTRAIL_CLOUD_TOKEN = "ctagt-token";
  }

  it("resolveIssue posts disposition + usedMemoryIds with project-key auth and returns adopted", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { isError, parsed } = await call(server, "resolveIssue", {
      memoryId: "mem_1",
      disposition: "real-bug",
      usedMemoryIds: ["mem_1", "mem_2"],
      rootCause: "null cart",
    });

    expect(isError).toBe(false);
    expect(parsed).toMatchObject({ ok: true, memoryId: "mem_1", adopted: 2, source: "cloud" });

    const req = mock.requests.find((r) => r.path === "/api/memory/resolve");
    expect(req).toBeDefined();
    expect(req!.method).toBe("POST");
    expect(req!.auth).toBe("proj-key-xyz");
    expect(req!.body).toMatchObject({
      memoryId: "mem_1",
      disposition: "real-bug",
      usedMemoryIds: ["mem_1", "mem_2"],
      rootCause: "null cart",
    });
  });

  it("resolveIssue omits usedMemoryIds when not provided (no adopted count)", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { parsed } = await call(server, "resolveIssue", {
      memoryId: "mem_9",
      disposition: "works-as-designed",
    });
    expect(parsed.adopted).toBeUndefined();
    const req = mock.requests.find((r) => r.path === "/api/memory/resolve");
    expect(req!.body).not.toHaveProperty("usedMemoryIds");
  });

  it("resolveIssue rejects a bad disposition before any network call", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });
    const { isError, text } = await call(server, "resolveIssue", {
      memoryId: "mem_1",
      disposition: "not-a-disposition",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/disposition must be one of/);
    expect(mock.requests).toHaveLength(0);
  });

  it("resolveIssue rejects more than 100 usedMemoryIds", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });
    const { isError } = await call(server, "resolveIssue", {
      memoryId: "mem_1",
      disposition: "real-bug",
      usedMemoryIds: Array.from({ length: 101 }, (_, i) => `m${i}`),
    });
    expect(isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it("resolveIssue reports a gap (not an error) when the cloud is unconfigured", async () => {
    const server = new McpServer({ outputDir: tmpDir });
    const { isError, parsed } = await call(server, "resolveIssue", {
      memoryId: "mem_1",
      disposition: "real-bug",
    });
    expect(isError).toBe(false);
    expect(parsed).toMatchObject({ ok: false, source: "remote-unavailable" });
    expect(parsed.gaps[0]).toMatch(/CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_API_KEY/);
  });

  it("recallSimilarIssues surfaces outcomeSummary + resolution_verified reason from the cloud", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { parsed } = await call(server, "recallSimilarIssues", {
      query: "checkout 500 error",
    });
    expect(parsed.source).toBe("cloud");
    const match = parsed.matches[0];
    expect(match.outcomeSummary).toMatch(/verified in prod/);
    expect(match.reasons).toContain("resolution_verified");
  });

  it("recordFeedback posts an agent signal with bearer auth and source=agent", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { isError, parsed } = await call(server, "recordFeedback", {
      projectId: "proj_1",
      subjectKind: "recall_match",
      subjectRef: "mem_1",
      signal: "adopted",
      note: "reused the prior fix",
    });

    expect(isError).toBe(false);
    expect(parsed).toMatchObject({ source: "cloud" });
    expect(parsed.feedback).toMatchObject({ signal: "adopted", source: "agent" });

    const req = mock.requests.find((r) => r.path === "/api/agent/feedback");
    expect(req!.method).toBe("POST");
    expect(req!.agentToken).toBe("ctagt-token");
    expect(req!.body).toMatchObject({
      projectId: "proj_1",
      subjectKind: "recall_match",
      subjectRef: "mem_1",
      signal: "adopted",
      source: "agent",
      note: "reused the prior fix",
    });
  });

  it("recordFeedback rejects an unknown signal before any network call", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });
    const { isError } = await call(server, "recordFeedback", {
      projectId: "proj_1",
      subjectKind: "recall_match",
      subjectRef: "mem_1",
      signal: "loved_it",
    });
    expect(isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it("getPlaybook reads active rules with bearer auth and project query", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { isError, parsed } = await call(server, "getPlaybook", {
      project: "proj_1",
    });
    expect(isError).toBe(false);
    expect(parsed.source).toBe("cloud");
    expect(parsed.rules[0]).toMatchObject({ id: "rule_1" });

    const req = mock.requests.find((r) => r.path === "/api/agent/playbook");
    expect(req!.method).toBe("GET");
    expect(req!.agentToken).toBe("ctagt-token");
    expect(req!.query.project).toBe("proj_1");
  });

  it("getPlaybook rejects an invalid project id before any network call", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });
    const { isError } = await call(server, "getPlaybook", { project: "bad id!" });
    expect(isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it("getPlaybook reports a gap when the agent token is unconfigured", async () => {
    // Fully unconfigured: agent auth needs CRUMBTRAIL_CLOUD_TOKEN, which is absent.
    const server = new McpServer({ outputDir: tmpDir });
    const { isError, parsed } = await call(server, "getPlaybook", {
      project: "proj_1",
    });
    expect(isError).toBe(false);
    expect(parsed).toMatchObject({ ok: false, source: "remote-unavailable" });
    expect(parsed.gaps[0]).toMatch(/CRUMBTRAIL_CLOUD_TOKEN/);
  });
});
