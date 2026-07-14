import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../mcp-server";
import { TicketError } from "../ticket/clients";
import type { TicketConnector } from "../ticket/clients";

/**
 * MCP pull-path: solveContext resolves a ticket (URL string or {provider,id}) and,
 * when the cloud env pair is configured, returns a pre-assembled bundle from the
 * cloud by-ticket endpoint (short-circuit). On any miss/unconfigured it falls back
 * to the local path unchanged. Env-clearing mirrors mcp-recall.test.ts.
 */
interface CapturedReq {
  path: string;
  provider: string | null;
  key: string | null;
  auth: string | undefined;
}

interface MockCloud {
  url: string;
  requests: CapturedReq[];
  stop(): Promise<void>;
}

// The stored bundle the mock hands back on a hit. A distinctive marker lets a
// test tell "returned verbatim from cloud" apart from a locally-assembled bundle.
const STORED_BUNDLE = {
  schemaVersion: "fusion.v1",
  symptom: { title: "STORED BUNDLE" },
  evidence: [],
  marker: "from-cloud",
};

/** A stand-in cloud that answers GET /api/bundles/by-ticket for one known ticketKey. */
function startMockCloud(hitKey: string): Promise<MockCloud> {
  const requests: CapturedReq[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "", "http://mock.local");
    requests.push({
      path: u.pathname,
      provider: u.searchParams.get("provider"),
      key: u.searchParams.get("ticketKey"),
      auth: req.headers["x-crumbtrail-auth"] as string | undefined,
    });
    if (u.pathname === "/api/bundles/by-ticket") {
      if (u.searchParams.get("ticketKey") === hitKey) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "bnd_deadbeefdeadbeef",
            status: "matched",
            confidence: 0.72,
            sessionId: "sess-cloud",
            bundle: STORED_BUNDLE,
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Bundle not found", code: "not_found" }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
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

const throwingConnector: TicketConnector = {
  async fetchSymptom() {
    throw new TicketError(0, "no local creds in test");
  },
};

describe("MCP pull-path (solveContext ticket → cloud bundle)", () => {
  let tmpDir: string;
  let mock: MockCloud | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-pull-"));
  });

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CRUMBTRAIL_CLOUD_URL;
    delete process.env.CRUMBTRAIL_API_KEY;
  });

  async function solve(server: McpServer, args: Record<string, unknown>) {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "solveContext", arguments: args },
    });
    const result = res!.result as any;
    return JSON.parse(result.content[0].text);
  }

  it("a Jira browse URL resolves + short-circuits to the stored cloud bundle", async () => {
    mock = await startMockCloud("ABC-123");
    process.env.CRUMBTRAIL_CLOUD_URL = mock.url;
    process.env.CRUMBTRAIL_API_KEY = "proj-key-xyz";
    const server = new McpServer({
      outputDir: tmpDir,
      ticketConnectorFactory: () => throwingConnector,
    });

    const bundle = await solve(server, {
      ticket: "https://acme.atlassian.net/browse/ABC-123",
    });

    // Returned verbatim from the cloud (marker present), not locally assembled.
    expect(bundle.marker).toBe("from-cloud");
    expect(bundle.symptom.title).toBe("STORED BUNDLE");

    // The cloud was asked with the parsed provider+key and the project API key.
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].path).toBe("/api/bundles/by-ticket");
    expect(mock.requests[0].provider).toBe("jira");
    expect(mock.requests[0].key).toBe("ABC-123");
    expect(mock.requests[0].auth).toBe("proj-key-xyz");
  });

  it("a Jira REST-issue URL resolves to the SAME stored bundle as browse", async () => {
    mock = await startMockCloud("ABC-123");
    process.env.CRUMBTRAIL_CLOUD_URL = mock.url;
    process.env.CRUMBTRAIL_API_KEY = "proj-key-xyz";
    const server = new McpServer({
      outputDir: tmpDir,
      ticketConnectorFactory: () => throwingConnector,
    });

    const bundle = await solve(server, {
      ticket: "https://acme.atlassian.net/rest/api/3/issue/ABC-123",
    });
    expect(bundle.marker).toBe("from-cloud");
    expect(mock.requests[0].provider).toBe("jira");
    expect(mock.requests[0].key).toBe("ABC-123");
  });

  it("an explicit {provider,id} resolves to the SAME stored bundle", async () => {
    mock = await startMockCloud("ABC-123");
    process.env.CRUMBTRAIL_CLOUD_URL = mock.url;
    process.env.CRUMBTRAIL_API_KEY = "proj-key-xyz";
    const server = new McpServer({
      outputDir: tmpDir,
      ticketConnectorFactory: () => throwingConnector,
    });

    const bundle = await solve(server, {
      ticket: { provider: "jira", id: "ABC-123" },
    });
    expect(bundle.marker).toBe("from-cloud");
    expect(mock.requests[0].key).toBe("ABC-123");
  });

  it("a cloud MISS falls back to the local path unchanged (no short-circuit)", async () => {
    mock = await startMockCloud("SOME-OTHER-KEY"); // ABC-123 will 404
    process.env.CRUMBTRAIL_CLOUD_URL = mock.url;
    process.env.CRUMBTRAIL_API_KEY = "proj-key-xyz";
    const server = new McpServer({
      outputDir: tmpDir,
      ticketConnectorFactory: () => throwingConnector,
    });

    const bundle = await solve(server, {
      ticket: "https://acme.atlassian.net/browse/ABC-123",
    });

    // Not the stored bundle; a locally-assembled fusion bundle instead.
    expect(bundle.marker).toBeUndefined();
    expect(bundle.schemaVersion).toBe("fusion.v1");
    // Local fetch fell back to the ticket id as the symptom title, with a gap.
    expect(bundle.symptom.title).toBe("ABC-123");
    expect(bundle.gaps.length).toBeGreaterThan(0);
    // The cloud WAS consulted (and missed).
    expect(mock.requests).toHaveLength(1);
  });

  it("unconfigured cloud env: no pull attempt, straight to the local path", async () => {
    // No CRUMBTRAIL_CLOUD_URL/API_KEY set.
    mock = await startMockCloud("ABC-123");
    const server = new McpServer({
      outputDir: tmpDir,
      ticketConnectorFactory: () => throwingConnector,
    });

    const bundle = await solve(server, {
      ticket: { provider: "jira", id: "ABC-123" },
    });

    expect(bundle.marker).toBeUndefined();
    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(bundle.symptom.title).toBe("ABC-123");
    // The mock cloud was never contacted.
    expect(mock.requests).toHaveLength(0);
  });

  it("an unrecognized ticket URL is an honest miss (gap), never a throw", async () => {
    const server = new McpServer({ outputDir: tmpDir });

    const bundle = await solve(server, {
      ticket: "https://example.com/not/a/ticket",
    });

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(
      bundle.gaps.some((g: any) =>
        g.reason.includes("ticket url not recognized"),
      ),
    ).toBe(true);
  });

  it("a passed symptom still wins when an unrecognized URL is given", async () => {
    const server = new McpServer({ outputDir: tmpDir });

    const bundle = await solve(server, {
      ticket: "https://example.com/not/a/ticket",
      symptom: { title: "checkout fails" },
    });

    expect(bundle.symptom.title).toBe("checkout fails");
    expect(
      bundle.gaps.some((g: any) =>
        g.reason.includes("ticket url not recognized"),
      ),
    ).toBe(false);
  });
});
