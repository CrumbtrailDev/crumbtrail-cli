import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../mcp-server";

/**
 * recallIssueContext — local (no-cloud) recall over the session store.
 *
 * The load-bearing assertion in this file is the last one: without a cloud,
 * `cautions` reports itself unavailable and carries NO `notes` key. An empty
 * array would be a claim that we looked and found no warnings about this
 * client, which is a lie the agent would act on.
 */
describe("MCP recallIssueContext (local)", () => {
  let tmpDir: string;
  let server: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-recall-"));
    server = new McpServer({ outputDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CRUMBTRAIL_CLOUD_URL;
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

    const out = await call("recallIssueContext", { sessionId: "sess-b" });
    expect(out.source).toBe("local");
    const results = out.precedents.results;
    const refs = results.map((m: any) => m.sessionId);
    expect(refs).toContain("sess-a");
    expect(refs).not.toContain("sess-b"); // never recalls itself
    expect(results[0].sessionId).toBe("sess-a");
    expect(results[0].reasons).toContain("same-route");
    // The vector arm has no offline analogue and says so, rather than looking
    // like an arm that ran and found nothing.
    expect(out.precedents.arms.vector).toEqual({
      available: false,
      reason: "cloud_only",
    });
    expect(out.precedents.arms.lexical.available).toBe(true);
  });

  it("recalls by free text", async () => {
    seed("sess-a", {
      detector: "console_error",
      message: "Payment failed: gateway timeout",
      route: "/checkout",
    });
    const out = await call("recallIssueContext", {
      text: "payment gateway timeout",
    });
    expect(out.precedents.results.length).toBeGreaterThan(0);
    expect(out.precedents.results[0].sessionId).toBe("sess-a");
  });

  it("reports duplicates as unchecked when no signature was supplied", async () => {
    seed("sess-a", {
      detector: "console_error",
      message: "Payment failed: gateway timeout",
      route: "/checkout",
    });
    const out = await call("recallIssueContext", { sessionId: "sess-a" });
    // "I could not check" is not "I checked and found none".
    expect(out.duplicates.checked).toBe(false);
    expect(out.duplicates.matches).toEqual([]);
  });

  it("matches an exact duplicate by signature, and nothing else", async () => {
    seed("sess-a", {
      detector: "console_error",
      message: "Payment failed: gateway timeout",
      route: "/checkout",
    });
    const seeded = await call("recallIssueContext", {
      text: "payment gateway timeout",
    });
    const signature = seeded.precedents.results[0].signature;
    expect(signature).toBeTruthy();

    const hit = await call("recallIssueContext", {
      bugSignatures: [signature],
    });
    expect(hit.duplicates.checked).toBe(true);
    expect(hit.duplicates.matches.map((m: any) => m.signature)).toEqual([
      signature,
    ]);
    expect(hit.duplicates.matches[0].via).toBe("signature");

    const miss = await call("recallIssueContext", {
      bugSignatures: ["sig_that_does_not_exist"],
    });
    expect(miss.duplicates.checked).toBe(true);
    expect(miss.duplicates.matches).toEqual([]);
  });

  it("returns empty precedents when the queried session has no bugs indexed", async () => {
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
    const out = await call("recallIssueContext", { sessionId: "empty" });
    expect(out.precedents.results).toEqual([]);
  });

  it("never reports cautions as an empty list without a cloud", async () => {
    seed("sess-a", {
      detector: "console_error",
      message: "Payment failed: gateway timeout",
      route: "/checkout",
    });
    const out = await call("recallIssueContext", { sessionId: "sess-a" });
    expect(out.cautions).toEqual({
      requested: true,
      available: false,
      reason: "cloud_only",
    });
    // The whole point: no `notes` key at all. `notes: []` would read as "there
    // are no warnings about this client", which is not what we know.
    expect("notes" in out.cautions).toBe(false);
  });

  it("keeps cautions in the answer even when include leaves it out", async () => {
    seed("sess-a", {
      detector: "console_error",
      message: "Payment failed: gateway timeout",
      route: "/checkout",
    });
    const out = await call("recallIssueContext", {
      sessionId: "sess-a",
      include: ["precedents"],
    });
    expect(out.duplicates).toEqual({ requested: false });
    expect(out.precedents.requested).toBe(true);
    expect(out.cautions.available).toBe(false);
    expect(out.cautions.reason).toBe("cloud_only");
  });

  it("rejects an unknown include entry rather than silently dropping it", async () => {
    const out = await call("recallIssueContext", { include: ["cauitons"] });
    expect(out.error).toBeTruthy();
  });
});
