import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../mcp-server";

/**
 * recallSimilarIssues — local (no-cloud) recall over the session store. Verifies
 * that a session rhyming with a prior one (same route, similar error text) is
 * surfaced above an unrelated session, and that free-text recall works.
 */
describe("MCP recallSimilarIssues (local)", () => {
  let tmpDir: string;
  let server: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-recall-"));
    server = new McpServer({ outputDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CRUMBTRAIL_CLOUD_URL;
    delete process.env.CRUMBTRAIL_API_KEY;
  });

  function seed(
    sessionId: string,
    bug: {
      detector: string;
      message: string;
      route: string;
      flags?: Record<string, unknown>;
    },
  ) {
    const dir = path.join(tmpDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: sessionId, app: "app" }),
    );
    fs.writeFileSync(
      path.join(dir, "llm.json"),
      JSON.stringify({
        distinctBugs: [
          {
            bugId: `bug_${sessionId}`,
            title: `Console error: ${bug.message}`,
            severity: "medium",
            firstSeen: 1,
            lastSeen: 2,
            requestIds: [],
            representative: {
              detector: bug.detector,
              severity: "medium",
              message: bug.message,
              route: bug.route,
            },
          },
        ],
        environment: bug.flags ? { flags: bug.flags } : null,
        databaseDiffs: [],
      }),
    );
  }

  async function call(name: string, args: Record<string, unknown>) {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = res!.result as any;
    return result.isError
      ? { error: result.content[0].text }
      : JSON.parse(result.content[0].text);
  }

  it("recalls the rhyming session above an unrelated one", async () => {
    seed("sess-a", {
      detector: "console_error",
      message: "Payment failed: gateway timeout",
      route: "/checkout",
      flags: { betaCheckout: true },
    });
    seed("sess-b", {
      detector: "console_error",
      message: "Payment failed: upstream gateway error",
      route: "/checkout",
      flags: { betaCheckout: true },
    });
    seed("sess-c", {
      detector: "otel_span_error",
      message: "Dashboard widget render timeout",
      route: "/dashboard",
    });

    const out = await call("recallSimilarIssues", { sessionId: "sess-b" });
    expect(out.source).toBe("local");
    const refs = out.matches.map((m: any) => m.sessionId);
    expect(refs).toContain("sess-a");
    expect(refs).not.toContain("sess-b"); // never recalls itself
    expect(out.matches[0].sessionId).toBe("sess-a");
    expect(out.matches[0].reasons).toContain("same-route");
  });

  it("recalls by free-text query", async () => {
    seed("sess-a", {
      detector: "console_error",
      message: "Payment failed: gateway timeout",
      route: "/checkout",
    });
    const out = await call("recallSimilarIssues", {
      query: "payment gateway timeout",
    });
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches[0].sessionId).toBe("sess-a");
  });

  it("returns empty when the queried session has no bugs indexed", async () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "empty" }),
    );
    fs.writeFileSync(
      path.join(dir, "llm.json"),
      JSON.stringify({ distinctBugs: [] }),
    );
    const out = await call("recallSimilarIssues", { sessionId: "empty" });
    expect(out.matches).toEqual([]);
    expect(out.indexed).toBe(false);
  });

  it("errors when neither sessionId nor query is given", async () => {
    const out = await call("recallSimilarIssues", {});
    expect(out.error).toBeTruthy();
  });
});
