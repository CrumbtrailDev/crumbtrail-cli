import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../mcp-server";

/**
 * The two agent-plane tools that let an agent act on what a bundle told it:
 *  - requestProbe   -> POST /api/agent/probe            (agent-token auth)
 *  - shadowBacktest -> GET  /api/agent/shadow-backtest  (agent-token auth)
 *
 * A mock cloud records what the client sent (method, path, query, bearer token,
 * body) so these assert the wire contract as well as the rendering. The
 * rendering assertions matter as much as the wire: a queued probe must not read
 * as an answer, and an undecidable threshold rule must not read as a pass.
 */
interface CapturedReq {
  method: string;
  path: string;
  query: Record<string, string>;
  agentToken: string | undefined;
  body: any;
}

interface MockCloudState {
  /** 202 body of POST /api/agent/probe. */
  probeStatus: number;
  probeBody: Record<string, unknown>;
  /** 200 body of GET /api/agent/shadow-backtest. */
  backtestStatus: number;
  backtestBody: Record<string, unknown>;
}

interface MockCloud {
  url: string;
  requests: CapturedReq[];
  state: MockCloudState;
  stop(): Promise<void>;
}

const QUEUED = {
  queued: {
    probeName: "network.inflight",
    requestedAt: "2026-08-11T10:00:00.000Z",
    expiresAt: "2026-08-11T10:15:00.000Z",
  },
};

/** One replayed detection that clears every rule it CAN decide, while three
 *  rules stayed undecidable. The whole point of the shape: `clears` is true and
 *  the candidate is still not approved. */
const BACKTEST_REPORT = {
  projectId: "proj_1",
  days: 14,
  windowStart: "2026-07-28T00:00:00.000Z",
  windowEnd: "2026-08-11T00:00:00.000Z",
  autonomy: {
    level: "hold",
    requested: "alert",
    source: "project",
    clamped: true,
    wouldPropose: false,
  },
  rules: { min_confidence: 0.6 },
  totalDetections: 1,
  truncated: false,
  candidates: [
    {
      detector: "error_rate_spike",
      stableSignature: "sig_abc",
      title: "Checkout 500 spike",
      confidence: 0.91,
      explanation: "Rate tripled over the window.",
      evidence: { occurrences: 12 },
      canonicalIssueId: "ci_42",
      alreadyProposed: false,
      thresholds: {
        clears: true,
        failedRules: [],
        undecidable: [
          { rule: "severity_at_least", reason: "No severity is stored." },
          { rule: "max_diff_lines", reason: "Diff size needs a fix first." },
          { rule: "max_open_prs", reason: "Rolling count at filing time." },
        ],
      },
    },
  ],
};

function startMockCloud(): Promise<MockCloud> {
  const requests: CapturedReq[] = [];
  const state: MockCloudState = {
    probeStatus: 202,
    probeBody: { ...QUEUED },
    backtestStatus: 200,
    backtestBody: { ...BACKTEST_REPORT },
  };
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
        agentToken: (req.headers["authorization"] as string | undefined)
          ?.replace(/^Bearer\s+/i, "")
          .trim(),
        body,
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && u.pathname === "/api/agent/probe")
        return send(state.probeStatus, state.probeBody);
      if (req.method === "GET" && u.pathname === "/api/agent/shadow-backtest")
        return send(state.backtestStatus, state.backtestBody);
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
        state,
        stop: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

describe("MCP live probe plane and shadow back test", () => {
  let tmpDir: string;
  let mock: MockCloud | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-probe-"));
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
    process.env.CRUMBTRAIL_CLOUD_TOKEN = "ctagt-token";
  }

  describe("requestProbe", () => {
    it("posts project + probe with the agent token and reports queued, not answered", async () => {
      mock = await startMockCloud();
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, parsed, text } = await call(server, "requestProbe", {
        project: "proj_1",
        probe: "network.inflight",
      });

      expect(isError).toBe(false);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]).toMatchObject({
        method: "POST",
        path: "/api/agent/probe",
        agentToken: "ctagt-token",
        body: { project: "proj_1", probe: "network.inflight" },
      });
      expect(parsed).toMatchObject({
        source: "cloud",
        project: "proj_1",
        probe: "network.inflight",
        queued: true,
        answered: false,
        expiresAt: "2026-08-11T10:15:00.000Z",
      });
      // The one misreading this tool exists to prevent.
      expect(text).toMatch(/queued probe is not an answer/i);
    });

    it("refuses a probe outside the fixed vocabulary before any network call", async () => {
      mock = await startMockCloud();
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, text } = await call(server, "requestProbe", {
        project: "proj_1",
        probe: "storage.dump",
      });

      expect(isError).toBe(true);
      expect(text).toMatch(/network\.inflight/);
      expect(mock.requests).toHaveLength(0);
    });

    it("refuses a malformed project id before any network call", async () => {
      mock = await startMockCloud();
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, text } = await call(server, "requestProbe", {
        project: "bad id!",
        probe: "runtime.env",
      });

      expect(isError).toBe(true);
      expect(text).toMatch(/requestProbe requires a valid project id/);
      expect(mock.requests).toHaveLength(0);
    });

    it("reports a gap (not an error) when the cloud is unconfigured", async () => {
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, parsed } = await call(server, "requestProbe", {
        project: "proj_1",
        probe: "runtime.env",
      });

      expect(isError).toBe(false);
      expect(parsed).toMatchObject({ ok: false, source: "remote-unavailable" });
      expect(parsed.gaps[0]).toMatch(
        /CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN/,
      );
    });

    it("surfaces a project that has not opted into live probes as an error", async () => {
      mock = await startMockCloud();
      mock.state.probeStatus = 403;
      mock.state.probeBody = {
        error: "Live probes are disabled for this project",
        code: "live_probe_disabled",
        level: "hold",
      };
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, text } = await call(server, "requestProbe", {
        project: "proj_1",
        probe: "runtime.env",
      });

      expect(isError).toBe(true);
      expect(text).toMatch(/requestProbe failed/);
      expect(text).toMatch(/live_probe_disabled/);
    });
  });

  describe("shadowBacktest", () => {
    it("gets project + days with the agent token and keeps undecidable rules visible", async () => {
      mock = await startMockCloud();
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, parsed, text } = await call(server, "shadowBacktest", {
        project: "proj_1",
        days: 30,
      });

      expect(isError).toBe(false);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]).toMatchObject({
        method: "GET",
        path: "/api/agent/shadow-backtest",
        query: { project: "proj_1", days: "30" },
        agentToken: "ctagt-token",
      });
      expect(parsed.candidates).toHaveLength(1);
      expect(parsed.candidates[0].thresholds.undecidable).toHaveLength(3);
      // Counted on the report so a skimming reader cannot miss that the check
      // was partial even when `clears` is true.
      expect(parsed.candidates[0].thresholds.clears).toBe(true);
      expect(parsed.undecidableRules).toBe(3);
      expect(parsed.autonomy.wouldPropose).toBe(false);
      expect(text).toMatch(/undecidable rule is not a pass/i);
    });

    it("omits days entirely when the caller names none, so the cloud default applies", async () => {
      mock = await startMockCloud();
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError } = await call(server, "shadowBacktest", {
        project: "proj_1",
      });

      expect(isError).toBe(false);
      expect(mock.requests[0].query).toEqual({ project: "proj_1" });
    });

    it.each([0, 91, 14.5, "30"])(
      "refuses an out of range days value (%s) before any network call",
      async (days) => {
        mock = await startMockCloud();
        configureCloud(mock.url);
        const server = new McpServer({ outputDir: tmpDir });

        const { isError, text } = await call(server, "shadowBacktest", {
          project: "proj_1",
          days,
        });

        expect(isError).toBe(true);
        expect(text).toMatch(/between 1 and 90/);
        expect(text).toMatch(/never clamped/);
        expect(mock.requests).toHaveLength(0);
      },
    );

    it("reports a gap (not an error) when the cloud is unconfigured", async () => {
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, parsed } = await call(server, "shadowBacktest", {
        project: "proj_1",
      });

      expect(isError).toBe(false);
      expect(parsed).toMatchObject({ ok: false, source: "remote-unavailable" });
      expect(parsed.gaps[0]).toMatch(
        /CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN/,
      );
    });

    it("surfaces a cloud refusal as an error the agent sees", async () => {
      mock = await startMockCloud();
      mock.state.backtestStatus = 404;
      mock.state.backtestBody = {
        error: "Project not found",
        code: "not_found",
      };
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, text } = await call(server, "shadowBacktest", {
        project: "proj_1",
      });

      expect(isError).toBe(true);
      expect(text).toMatch(/shadowBacktest failed/);
      expect(text).toMatch(/not_found/);
    });
  });
});
