import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../mcp-server";

/**
 * Where the ten memory and learning tools get their cloud credentials.
 *
 * A stdio server run by one engineer has one tenant and one token, and reads it
 * from the process environment. A HOSTED deployment serves every tenant from
 * one process, so there is no token that is correct for the process: the only
 * correct credential for a call is the CALLING tenant's own agent token, known
 * per request. `McpServerConfig.cloudCredentials` is that seam, and without it
 * every one of these ten tools failed unconditionally in hosted mode.
 *
 * A mock cloud answers all ten routes and records the bearer token it was sent,
 * so these assert whose credential actually went on the wire.
 */

interface CapturedReq {
  method: string;
  path: string;
  agentToken: string | undefined;
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
      requests.push({
        method: req.method ?? "",
        path: u.pathname,
        agentToken: (req.headers["authorization"] as string | undefined)
          ?.replace(/^Bearer\s+/i, "")
          .trim(),
      });
      res.writeHead(200, { "content-type": "application/json" });
      // Every route answers a body its client can parse. The tools' rendering is
      // covered elsewhere; what is under test here is which token arrived.
      res.end(
        JSON.stringify({
          ok: true,
          id: "cnt_1",
          status: "created",
          rules: [],
          queued: { probeName: "network.inflight" },
          projectId: "proj_1",
          days: 14,
          candidates: [],
          totalDetections: 0,
          truncated: false,
          autonomy: { level: "hold", requested: "alert", source: "project" },
          canonicalIssueId: "iss_1",
          result: "inconclusive",
          reason: "window_open",
          opened: true,
        }),
      );
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

/** The ten tools that need a cloud credential, with the route each one calls. */
const CLOUD_TOOLS: Array<{
  name: string;
  args: Record<string, unknown>;
  path: string;
}> = [
  {
    name: "recallIssueContext",
    args: { text: "checkout 500", projectId: "proj_1" },
    path: "/api/memory/recall",
  },
  {
    name: "resolveIssue",
    args: { memoryId: "mem_1", disposition: "real-bug" },
    path: "/api/memory/resolve",
  },
  {
    name: "recordClientNote",
    args: {
      projectId: "proj_1",
      scopeLevel: "client",
      subjectKey: "checkout",
      slug: "friday-test-cards",
      kind: "gotcha",
      body: "Their staging gateway rejects test cards on Fridays.",
    },
    path: "/api/memory/notes",
  },
  {
    name: "amendClientNote",
    args: { id: "cnt_1", amendment: "Still true after the upgrade." },
    path: "/api/memory/notes/cnt_1/amend",
  },
  {
    name: "recordFeedback",
    args: {
      projectId: "proj_1",
      subjectKind: "recall_match",
      subjectRef: "mem_1",
      signal: "helpful",
    },
    path: "/api/agent/feedback",
  },
  {
    name: "getPlaybook",
    args: { projectId: "proj_1" },
    path: "/api/agent/playbook",
  },
  {
    name: "startFixVerification",
    args: { projectId: "proj_1", canonicalIssueId: "iss_1" },
    path: "/api/agent/verification",
  },
  {
    name: "getFixVerification",
    args: { projectId: "proj_1", canonicalIssueId: "iss_1" },
    path: "/api/agent/verification",
  },
  {
    name: "requestProbe",
    args: { projectId: "proj_1", probe: "network.inflight" },
    path: "/api/agent/probe",
  },
  {
    name: "shadowBacktest",
    args: { projectId: "proj_1" },
    path: "/api/agent/shadow-backtest",
  },
];

describe("McpServerConfig.cloudCredentials — the per-caller credential seam", () => {
  let tmpDir: string;
  let mock: MockCloud | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-cloud-cred-"));
    mock = await startMockCloud();
    delete process.env.CRUMBTRAIL_CLOUD_URL;
    delete process.env.CRUMBTRAIL_CLOUD_TOKEN;
  });

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CRUMBTRAIL_CLOUD_URL;
    delete process.env.CRUMBTRAIL_CLOUD_TOKEN;
  });

  async function call(
    server: McpServer,
    name: string,
    args: Record<string, unknown>,
  ) {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = res!.result as { content: Array<{ text: string }> };
    return result.content[0].text;
  }

  it.each(CLOUD_TOOLS)(
    "$name reaches the cloud with the caller's own token and no process env",
    async ({ name, args, path: route }) => {
      // No CRUMBTRAIL_CLOUD_* is set. Before the seam existed this failed
      // unconditionally with "requires CRUMBTRAIL_CLOUD_URL and
      // CRUMBTRAIL_CLOUD_TOKEN", which is why the hosted list withheld all ten.
      const server = new McpServer({
        outputDir: tmpDir,
        cloudCredentials: {
          baseUrl: mock!.url,
          token: "ctagt_caller_a",
        },
      });
      const text = await call(server, name, args);
      expect(text).not.toMatch(/CRUMBTRAIL_CLOUD_URL/);
      const req = mock!.requests.find((r) => r.path === route);
      expect(req, `${name} never called ${route}`).toBeDefined();
      expect(req!.agentToken).toBe("ctagt_caller_a");
    },
  );

  it("answers one caller with that caller's token, never the process env", async () => {
    // The leak this forecloses: a hosted process that happens to carry an agent
    // token in its own environment answering tenant A's request with it.
    process.env.CRUMBTRAIL_CLOUD_URL = mock!.url;
    process.env.CRUMBTRAIL_CLOUD_TOKEN = "ctagt_process_wide";
    const server = new McpServer({
      outputDir: tmpDir,
      cloudCredentials: { baseUrl: mock!.url, token: "ctagt_caller_a" },
    });

    await call(server, "getPlaybook", { projectId: "proj_1" });

    const req = mock!.requests.find((r) => r.path === "/api/agent/playbook");
    expect(req!.agentToken).toBe("ctagt_caller_a");
    expect(
      mock!.requests.some((r) => r.agentToken === "ctagt_process_wide"),
    ).toBe(false);
  });

  it("keeps two callers apart across servers built from the same process", async () => {
    const a = new McpServer({
      outputDir: tmpDir,
      cloudCredentials: { baseUrl: mock!.url, token: "ctagt_caller_a" },
    });
    const b = new McpServer({
      outputDir: tmpDir,
      cloudCredentials: { baseUrl: mock!.url, token: "ctagt_caller_b" },
    });

    await call(a, "getPlaybook", { projectId: "proj_a" });
    await call(b, "getPlaybook", { projectId: "proj_b" });

    const tokens = mock!.requests
      .filter((r) => r.path === "/api/agent/playbook")
      .map((r) => r.agentToken);
    expect(tokens).toEqual(["ctagt_caller_a", "ctagt_caller_b"]);
  });

  it("still reads the process environment when no credentials are passed", async () => {
    // The self-hosted stdio model, unchanged.
    process.env.CRUMBTRAIL_CLOUD_URL = mock!.url;
    process.env.CRUMBTRAIL_CLOUD_TOKEN = "ctagt_self_hosted";
    const server = new McpServer({ outputDir: tmpDir });

    await call(server, "getPlaybook", { projectId: "proj_1" });

    const req = mock!.requests.find((r) => r.path === "/api/agent/playbook");
    expect(req!.agentToken).toBe("ctagt_self_hosted");
  });

  it("names the environment variables only when the environment was the source", async () => {
    // Sending a hosted operator to look at CRUMBTRAIL_CLOUD_TOKEN — a variable
    // that path deliberately never reads — is a wrong answer that costs an hour.
    const selfHosted = new McpServer({ outputDir: tmpDir });
    expect(
      await call(selfHosted, "getPlaybook", { projectId: "proj_1" }),
    ).toMatch(/CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN/);

    const hosted = new McpServer({
      outputDir: tmpDir,
      cloudCredentials: { baseUrl: "", token: "" },
    });
    const text = await call(hosted, "getPlaybook", { projectId: "proj_1" });
    expect(text).not.toMatch(/CRUMBTRAIL_CLOUD_URL/);
    expect(text).toMatch(/agent token for the calling tenant/);
  });

  it("refuses to put a caller's token on a plain http base that is not loopback", async () => {
    const server = new McpServer({
      outputDir: tmpDir,
      cloudCredentials: {
        baseUrl: "http://cloud.example.com",
        token: "ctagt_caller_a",
      },
    });
    const text = await call(server, "getPlaybook", { projectId: "proj_1" });
    expect(text).toMatch(/must use https/);
    expect(mock!.requests).toHaveLength(0);
  });

  it("accepts the loopback origin a hosted deployment calls itself on", async () => {
    // `http://127.0.0.1:<port>` is the hop the hosted MCP endpoint already uses
    // for its own audited routes, so the https rule must not break it.
    const server = new McpServer({
      outputDir: tmpDir,
      cloudCredentials: { baseUrl: `${mock!.url}/`, token: "ctagt_caller_a" },
    });
    await call(server, "getPlaybook", { projectId: "proj_1" });
    const req = mock!.requests.find((r) => r.path === "/api/agent/playbook");
    expect(req).toBeDefined();
    expect(req!.agentToken).toBe("ctagt_caller_a");
  });
});
