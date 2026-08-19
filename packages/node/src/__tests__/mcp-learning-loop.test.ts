import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../mcp-server";

/**
 * CRUMB-113: the MCP server wires four things into the per-tenant learning loop.
 *  - resolveIssue   -> POST /api/memory/resolve  with optional usedMemoryIds (agent-token auth)
 *  - recallIssueContext returns duplicates + precedents + cautions in one call
 *  - recordClientNote / amendClientNote -> POST /api/memory/notes[/:id/amend]
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

/** Mutable bodies the verification endpoints answer with. Held by reference so a
 *  test can reshape the cloud's verdict after the server is already listening. */
interface MockCloudState {
  verificationOpen: Record<string, unknown>;
  verificationView: Record<string, unknown>;
  /** Status both verification endpoints answer with. 200 unless a test wants a
   *  refusal, which the client must surface as an error rather than a gap. */
  verificationStatus: number;
  /** Status POST /api/memory/notes answers with. 201 unless a test wants one of
   *  the three refusals the notes route can produce. */
  noteStatus: number;
  noteRejection: Record<string, unknown>;
}

interface MockCloud {
  url: string;
  requests: CapturedReq[];
  state: MockCloudState;
  stop(): Promise<void>;
}

/** A window in flight: nothing concluded, so every verdict field is null. */
const OPEN_WINDOW = {
  state: "open",
  observationStart: "2026-08-01T00:00:00.000Z",
  observationEnd: "2026-08-08T00:00:00.000Z",
  result: null,
  reason: null,
  strategy: null,
  confidence: null,
};

function startMockCloud(): Promise<MockCloud> {
  const requests: CapturedReq[] = [];
  const state: MockCloudState = {
    noteStatus: 201,
    noteRejection: {},
    verificationStatus: 200,
    verificationOpen: { opened: true, ...OPEN_WINDOW },
    verificationView: {
      state: "terminal",
      observationStart: "2026-08-01T00:00:00.000Z",
      observationEnd: "2026-08-08T00:00:00.000Z",
      result: "verified",
      reason: "clean_observation_window",
      strategy: "stable_signature_recurrence",
      confidence: 0.83,
    },
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
        // The cloud requires provenance and answers 400 invalid_provenance when
        // it is absent or outside the vocabulary. Mirrored here so a client that
        // stopped sending it fails these tests instead of failing in the field.
        if (
          !["inferred", "agent", "human-confirmed"].includes(
            memBody.provenance as string,
          )
        ) {
          return send(400, {
            error:
              "provenance must be one of: inferred, agent, human-confirmed",
            code: "invalid_provenance",
          });
        }
        return send(200, {
          ok: true,
          memoryId: memBody.memoryId,
          resolution: {
            disposition: memBody.disposition,
            provenance: memBody.provenance,
          },
          ...(used ? { adopted: used.length } : {}),
        });
      }
      if (req.method === "POST" && u.pathname === "/api/memory/recall") {
        const recallBody = (body ?? {}) as Record<string, unknown>;
        return send(200, {
          projectId: recallBody.projectId ?? null,
          include: recallBody.include ?? [
            "duplicates",
            "precedents",
            "cautions",
          ],
          duplicates: { requested: true, checked: false, truncated: false, matches: [] },
          precedents: {
            requested: true,
            ambiguous: false,
            margin: 0.4,
            threshold: 0.1,
            arms: { vector: { available: true }, lexical: { available: true } },
            results: [
              {
                id: "mem_1",
                title: "Checkout 500",
                source: "session",
                sourceRef: "sess-a",
                route: "/checkout",
                errorFamily: "http_500",
                score: 0.82,
                fusedScore: 0.5,
                placements: { vector: 1, lexical: 2 },
                agreement: 0.75,
                resolution: { disposition: "real-bug", rootCause: "null cart" },
                outcomeSummary:
                  "Fixed by guarding the empty cart; verified in prod.",
              },
            ],
          },
          cautions: {
            requested: true,
            notes: [
              {
                id: "cnt_1",
                scopeLevel: "client",
                subjectKey: "checkout",
                kind: "gotcha",
                body: "Their staging gateway rejects test cards on Fridays.",
                supersedes: [{ id: "cnt_0", scopeLevel: "general" }],
              },
            ],
            matched: 1,
            fetched: 1,
            limit: 50,
            truncated: false,
            truncatedCount: 0,
            playbookRules: [],
            playbookRuleCap: 40,
            playbookEvictsAtCap: true,
          },
        });
      }
      const amendMatch = u.pathname.match(
        /^\/api\/memory\/notes\/([^/]+)\/amend$/,
      );
      if (req.method === "POST" && amendMatch) {
        return send(200, {
          status: "amended",
          code: 200,
          created: false,
          amended: true,
          id: decodeURIComponent(amendMatch[1]!),
          note: { id: decodeURIComponent(amendMatch[1]!), outcome: (body as any)?.outcome ?? null },
        });
      }
      if (req.method === "POST" && u.pathname === "/api/memory/notes") {
        const noteBody = (body ?? {}) as Record<string, unknown>;
        if (state.noteStatus !== 201) {
          return send(state.noteStatus, state.noteRejection);
        }
        return send(201, {
          status: "created",
          code: 201,
          created: true,
          amended: false,
          id: `cnt_${String(noteBody.slug)}`,
          note: { id: `cnt_${String(noteBody.slug)}`, ...noteBody },
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
      if (u.pathname === "/api/agent/verification") {
        if (req.method === "POST")
          return send(state.verificationStatus, state.verificationOpen);
        if (req.method === "GET")
          return send(state.verificationStatus, state.verificationView);
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
        state,
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

  it("resolveIssue posts disposition + usedMemoryIds with agent-token auth and returns adopted", async () => {
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
    expect(parsed).toMatchObject({
      ok: true,
      memoryId: "mem_1",
      adopted: 2,
      source: "cloud",
    });

    const req = mock.requests.find((r) => r.path === "/api/memory/resolve");
    expect(req).toBeDefined();
    expect(req!.method).toBe("POST");
    // The memory plane is agent-token authenticated; the ingest key must never
    // appear on it.
    expect(req!.auth).toBeUndefined();
    expect(req!.agentToken).toBe("ctagt-token");
    expect(req!.body).toMatchObject({
      memoryId: "mem_1",
      disposition: "real-bug",
      usedMemoryIds: ["mem_1", "mem_2"],
      rootCause: "null cart",
      // The cloud requires provenance and 400s without it. An MCP call is a
      // model's claim, so it goes on the wire as "agent" and never as a
      // person's confirmation.
      provenance: "agent",
    });
  });

  it("resolveIssue always sends provenance 'agent', whatever the agent passes", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    // An agent that tries to claim a person confirmed the resolution — by the
    // documented wire name or by any near miss — is ignored, not obeyed. The
    // tool takes no provenance argument, so there is nothing to override.
    const { isError } = await call(server, "resolveIssue", {
      memoryId: "mem_1",
      disposition: "real-bug",
      provenance: "human-confirmed",
      source: "human",
      confirmed: true,
    });

    expect(isError).toBe(false);
    const req = mock.requests.find((r) => r.path === "/api/memory/resolve");
    expect(req!.body.provenance).toBe("agent");
    expect(req!.body).not.toHaveProperty("source");
    expect(req!.body).not.toHaveProperty("confirmed");
  });

  it("the resolveIssue tool schema exposes no provenance argument", async () => {
    const server = new McpServer({ outputDir: tmpDir });
    const listed = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const resolveTool = (listed!.result as any).tools.find(
      (t: { name: string }) => t.name === "resolveIssue",
    );
    expect(resolveTool).toBeDefined();
    expect(Object.keys(resolveTool.inputSchema.properties)).not.toContain(
      "provenance",
    );
    expect(resolveTool.inputSchema.required).not.toContain("provenance");
  });

  /**
   * The guard that outlives this file: no shipped source in the SDK may put
   * "human-confirmed" on the wire. The string is allowed to exist exactly once,
   * in learning-loop.ts, where it is a vocabulary constant documenting what the
   * cloud accepts — never at a call site. A human's confirmation is recorded
   * through an authenticated dashboard session, not by an agent asserting it.
   */
  it("no shipped source outside the provenance vocabulary mentions human-confirmed", () => {
    const srcRoot = path.resolve(__dirname, "..", "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "__tests__"
          )
            continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
        if (!fs.readFileSync(full, "utf-8").includes("human-confirmed"))
          continue;
        offenders.push(path.relative(srcRoot, full).split(path.sep).join("/"));
      }
    };
    for (const pkg of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = path.join(srcRoot, pkg.name, "src");
      if (fs.existsSync(src)) walk(src);
    }
    expect(offenders).toEqual(["node/src/learning-loop.ts"]);
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
    expect(parsed.gaps[0]).toMatch(
      /CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN/,
    );
  });

  it("recallIssueContext returns all three sections from one POST", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { parsed } = await call(server, "recallIssueContext", {
      text: "checkout 500 error",
      projectId: "proj_1",
    });
    expect(parsed.source).toBe("cloud");
    const precedent = parsed.precedents.results[0];
    expect(precedent.outcomeSummary).toMatch(/verified in prod/);
    // Per arm availability and the ambiguity gate survive the hop.
    expect(parsed.precedents.arms.vector.available).toBe(true);
    expect(parsed.precedents.ambiguous).toBe(false);
    // "Could not check" stays distinguishable from "nothing found".
    expect(parsed.duplicates.checked).toBe(false);
    // Truncation disclosure and the playbook contrast are not flattened away.
    expect(parsed.cautions.truncatedCount).toBe(0);
    expect(parsed.cautions.playbookEvictsAtCap).toBe(true);
    expect(parsed.cautions.notes[0].supersedes[0].id).toBe("cnt_0");

    const req = mock.requests.find((r) => r.path === "/api/memory/recall");
    expect(req!.method).toBe("POST");
    expect(req!.agentToken).toBe("ctagt-token");
    expect(req!.body).toMatchObject({ text: "checkout 500 error" });
  });

  it("recallIssueContext puts cautions back into an include that dropped it", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    await call(server, "recallIssueContext", {
      text: "checkout 500 error",
      include: ["precedents"],
    });
    const req = mock.requests.find((r) => r.path === "/api/memory/recall");
    // The request that leaves this machine already carries cautions. The cloud
    // enforces the same rule; neither side relies on the other to do it.
    expect(req!.body.include).toEqual(["precedents", "cautions"]);
  });

  it("recordClientNote posts a note with bearer auth", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { isError, parsed } = await call(server, "recordClientNote", {
      projectId: "proj_1",
      scopeLevel: "client",
      subjectKey: "checkout",
      slug: "friday-test-cards",
      kind: "gotcha",
      body: "Their staging gateway rejects test cards on Fridays.",
    });
    expect(isError).toBe(false);
    expect(parsed).toMatchObject({ status: "created", source: "cloud" });

    const req = mock.requests.find((r) => r.path === "/api/memory/notes");
    expect(req!.method).toBe("POST");
    expect(req!.agentToken).toBe("ctagt-token");
    expect(req!.body).toMatchObject({
      scopeLevel: "client",
      kind: "gotcha",
      slug: "friday-test-cards",
    });
  });

  it("recordClientNote surfaces a near_match refusal with its code, not as a success", async () => {
    mock = await startMockCloud();
    mock.state.noteStatus = 409;
    mock.state.noteRejection = {
      error: "A note that already says roughly this exists.",
      code: "near_match",
      action_required: "choose_one",
    };
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { isError, text } = await call(server, "recordClientNote", {
      scopeLevel: "general",
      subjectKey: "checkout",
      slug: "friday-test-cards",
      kind: "gotcha",
      body: "Their staging gateway rejects test cards on Fridays.",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/near_match/);
  });

  it("recordClientNote rejects an unknown kind before any network call", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });
    const { isError } = await call(server, "recordClientNote", {
      scopeLevel: "client",
      subjectKey: "checkout",
      slug: "s",
      kind: "vibes",
      body: "b",
    });
    expect(isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it("amendClientNote appends to one note and can flip its outcome", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { isError, parsed } = await call(server, "amendClientNote", {
      id: "cnt_1",
      amendment: "Still true after the gateway upgrade.",
      outcome: "held",
    });
    expect(isError).toBe(false);
    expect(parsed).toMatchObject({ status: "amended", id: "cnt_1" });

    const req = mock.requests.find((r) => r.path.endsWith("/amend"));
    expect(req!.path).toBe("/api/memory/notes/cnt_1/amend");
    expect(req!.body).toMatchObject({
      amendment: "Still true after the gateway upgrade.",
      outcome: "held",
    });
    // Body is never amendable on this path.
    expect(req!.body.body).toBeUndefined();
  });

  it("resolveIssue records each rejected precedent as a rejected_solution note", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { isError, parsed } = await call(server, "resolveIssue", {
      memoryId: "mem_1",
      disposition: "real-bug",
      projectId: "proj_1",
      rejectedMemoryIds: [
        { memoryId: "mem_9", reason: "That fix targets the v1 cart API." },
      ],
    });
    expect(isError).toBe(false);
    expect(parsed.rejectionsLanded).toBe(1);
    expect(parsed.rejections[0]).toMatchObject({
      memoryId: "mem_9",
      landed: true,
    });

    const req = mock.requests.find((r) => r.path === "/api/memory/notes");
    expect(req!.body).toMatchObject({
      kind: "rejected_solution",
      // The flip out of future precedents keys on this.
      subjectMemoryId: "mem_9",
      subjectKey: "issue_memory:mem_9",
      body: "That fix targets the v1 cart API.",
    });
  });

  it("resolveIssue reports a rejection that did not land instead of hiding it", async () => {
    mock = await startMockCloud();
    mock.state.noteStatus = 503;
    mock.state.noteRejection = {
      error: "The near match guard could not run.",
      code: "guard_unavailable",
    };
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });

    const { isError, parsed } = await call(server, "resolveIssue", {
      memoryId: "mem_1",
      disposition: "real-bug",
      rejectedMemoryIds: [{ memoryId: "mem_9", reason: "Wrong subsystem." }],
    });
    // The resolution itself landed, so this is not an error — but the rejection
    // did not, and says so rather than being folded into the success.
    expect(isError).toBe(false);
    expect(parsed.rejectionsLanded).toBe(0);
    expect(parsed.rejections[0]).toMatchObject({
      memoryId: "mem_9",
      landed: false,
      code: "guard_unavailable",
    });
  });

  it("resolveIssue refuses a rejection with no reason, before any write", async () => {
    mock = await startMockCloud();
    configureCloud(mock.url);
    const server = new McpServer({ outputDir: tmpDir });
    const { isError } = await call(server, "resolveIssue", {
      memoryId: "mem_1",
      disposition: "real-bug",
      rejectedMemoryIds: ["mem_9"],
    });
    expect(isError).toBe(true);
    // Nothing was written: a malformed rejection is an argument error, not a
    // half-applied resolve.
    expect(mock.requests).toHaveLength(0);
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
    expect(parsed.feedback).toMatchObject({
      signal: "adopted",
      source: "agent",
    });

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
    const { isError } = await call(server, "getPlaybook", {
      project: "bad id!",
    });
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

  // --- Fix verification (CP-V2) --------------------------------------------
  //
  // The invariant under test is the cloud verification engine's own: an absence
  // of evidence is never a verified fix. The MCP payload is the last place that
  // can be enforced, so the inconclusive cases below are the load-bearing ones,
  // not the happy path.
  describe("fix verification", () => {
    it("startFixVerification posts project + issue with the agent token and returns the open window", async () => {
      mock = await startMockCloud();
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, parsed } = await call(server, "startFixVerification", {
        project: "proj_1",
        canonicalIssueId: "ci_42",
      });

      expect(isError).toBe(false);
      expect(parsed).toMatchObject({
        source: "cloud",
        project: "proj_1",
        canonicalIssueId: "ci_42",
        opened: true,
        state: "open",
        result: null,
        conclusive: false,
        fixConfirmed: false,
        recurred: false,
        observationEnd: "2026-08-08T00:00:00.000Z",
      });
      // An open window must never read as a fix that held.
      expect(parsed.interpretation).toMatch(/NOTHING has been concluded/);

      const req = mock.requests.find(
        (r) => r.path === "/api/agent/verification",
      );
      expect(req).toBeDefined();
      expect(req!.method).toBe("POST");
      // The verification plane is agent-token authenticated; the ingest key
      // must never appear on it.
      expect(req!.auth).toBeUndefined();
      expect(req!.agentToken).toBe("ctagt-token");
      // The tool's `canonicalIssueId` is the route's `issue` on the wire.
      expect(req!.body).toEqual({ project: "proj_1", issue: "ci_42" });
    });

    it("startFixVerification surfaces opened:false when the cloud handed back a live window", async () => {
      mock = await startMockCloud();
      mock.state.verificationOpen = { opened: false, ...OPEN_WINDOW };
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { parsed } = await call(server, "startFixVerification", {
        project: "proj_1",
        canonicalIssueId: "ci_42",
      });
      expect(parsed.opened).toBe(false);
      expect(parsed.state).toBe("open");
      expect(parsed.fixConfirmed).toBe(false);
    });

    it("getFixVerification reads with bearer auth and passes result + reason through verbatim", async () => {
      mock = await startMockCloud();
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, parsed } = await call(server, "getFixVerification", {
        project: "proj_1",
        canonicalIssueId: "ci_42",
      });

      expect(isError).toBe(false);
      expect(parsed).toMatchObject({
        source: "cloud",
        state: "terminal",
        result: "verified",
        reason: "clean_observation_window",
        strategy: "stable_signature_recurrence",
        confidence: 0.83,
        conclusive: true,
        fixConfirmed: true,
        recurred: false,
      });

      const req = mock.requests.find(
        (r) => r.path === "/api/agent/verification",
      );
      expect(req!.method).toBe("GET");
      expect(req!.agentToken).toBe("ctagt-token");
      expect(req!.query.project).toBe("proj_1");
      expect(req!.query.issue).toBe("ci_42");
    });

    // THE safety catch. An agent that reads "inconclusive" as "done" defeats the
    // whole feature, so the rendered payload must not contain the word anywhere
    // — not in a field, not in a derived boolean's name, not in the prose.
    it("an insufficient_traffic verdict never renders as verified anywhere in the payload", async () => {
      mock = await startMockCloud();
      mock.state.verificationView = {
        state: "terminal",
        observationStart: "2026-08-01T00:00:00.000Z",
        observationEnd: "2026-08-08T00:00:00.000Z",
        result: "inconclusive",
        reason: "insufficient_traffic",
        strategy: "stable_signature_recurrence",
        confidence: null,
      };
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, parsed, text } = await call(
        server,
        "getFixVerification",
        { project: "proj_1", canonicalIssueId: "ci_42" },
      );

      expect(isError).toBe(false);
      // The load-bearing assertion, first: the whole serialised payload — keys,
      // values and prose alike — must not contain the word anywhere.
      expect(text.toLowerCase()).not.toContain("verified");
      expect(parsed.result).toBe("inconclusive");
      expect(parsed.reason).toBe("insufficient_traffic");
      expect(parsed.fixConfirmed).toBe(false);
      expect(parsed.recurred).toBe(false);
      expect(parsed.confidence).toBeNull();
      expect(parsed.interpretation).toMatch(/could not tell/);
      expect(parsed.interpretation).toMatch(/NOT a fix/);
    });

    it.each([
      "window_incomplete",
      "window_too_short",
      "no_telemetry",
      "insufficient_traffic",
    ])(
      "the inconclusive reason %s renders as unestablished, never as verified",
      async (reason) => {
        mock = await startMockCloud();
        mock.state.verificationView = {
          state: "terminal",
          observationStart: "2026-08-01T00:00:00.000Z",
          observationEnd: "2026-08-08T00:00:00.000Z",
          result: "inconclusive",
          reason,
          strategy: "stable_signature_recurrence",
          confidence: null,
        };
        configureCloud(mock.url);
        const server = new McpServer({ outputDir: tmpDir });

        const { parsed, text } = await call(server, "getFixVerification", {
          project: "proj_1",
          canonicalIssueId: "ci_42",
        });
        expect(parsed.reason).toBe(reason);
        expect(parsed.fixConfirmed).toBe(false);
        expect(text.toLowerCase()).not.toContain("verified");
      },
    );

    it("a recurred verdict says the fix did not hold and confirms nothing", async () => {
      mock = await startMockCloud();
      mock.state.verificationView = {
        state: "terminal",
        observationStart: "2026-08-01T00:00:00.000Z",
        observationEnd: "2026-08-08T00:00:00.000Z",
        result: "recurred",
        reason: "recurrence_detected",
        strategy: "stable_signature_recurrence",
        confidence: 1,
      };
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { parsed, text } = await call(server, "getFixVerification", {
        project: "proj_1",
        canonicalIssueId: "ci_42",
      });
      expect(parsed.recurred).toBe(true);
      expect(parsed.fixConfirmed).toBe(false);
      expect(parsed.interpretation).toMatch(/did NOT hold/);
      expect(text.toLowerCase()).not.toContain("verified");
    });

    it("state none says nothing was ever measured rather than reporting a clean result", async () => {
      mock = await startMockCloud();
      mock.state.verificationView = {
        state: "none",
        observationStart: null,
        observationEnd: null,
        result: null,
        reason: null,
        strategy: null,
        confidence: null,
      };
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { parsed, text } = await call(server, "getFixVerification", {
        project: "proj_1",
        canonicalIssueId: "ci_42",
      });
      expect(parsed.state).toBe("none");
      expect(parsed.conclusive).toBe(false);
      expect(parsed.fixConfirmed).toBe(false);
      expect(parsed.interpretation).toMatch(/nothing has been measured/);
      expect(text.toLowerCase()).not.toContain("verified");
    });

    it.each(["startFixVerification", "getFixVerification"])(
      "%s rejects a malformed project id before any network call",
      async (tool) => {
        mock = await startMockCloud();
        configureCloud(mock.url);
        const server = new McpServer({ outputDir: tmpDir });
        const { isError } = await call(server, tool, {
          project: "bad id!",
          canonicalIssueId: "ci_42",
        });
        expect(isError).toBe(true);
        expect(mock.requests).toHaveLength(0);
      },
    );

    it.each(["startFixVerification", "getFixVerification"])(
      "%s rejects a missing canonicalIssueId before any network call",
      async (tool) => {
        mock = await startMockCloud();
        configureCloud(mock.url);
        const server = new McpServer({ outputDir: tmpDir });
        const { isError, text } = await call(server, tool, {
          project: "proj_1",
        });
        expect(isError).toBe(true);
        expect(text).toMatch(/canonicalIssueId/);
        expect(mock.requests).toHaveLength(0);
      },
    );

    it.each(["startFixVerification", "getFixVerification"])(
      "%s reports a gap (not an error) when the cloud is unconfigured",
      async (tool) => {
        const server = new McpServer({ outputDir: tmpDir });
        const { isError, parsed } = await call(server, tool, {
          project: "proj_1",
          canonicalIssueId: "ci_42",
        });
        expect(isError).toBe(false);
        expect(parsed).toMatchObject({
          ok: false,
          source: "remote-unavailable",
        });
        expect(parsed.gaps[0]).toMatch(
          /CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN/,
        );
      },
    );

    it.each(["startFixVerification", "getFixVerification"])(
      "%s refuses a plain http cloud rather than putting the agent token on the wire",
      async (tool) => {
        process.env.CRUMBTRAIL_CLOUD_URL = "http://cloud.crumbtrail.test";
        process.env.CRUMBTRAIL_CLOUD_TOKEN = "ctagt-token";
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
          const server = new McpServer({ outputDir: tmpDir });
          const { isError, parsed, text } = await call(server, tool, {
            project: "proj_1",
            canonicalIssueId: "ci_42",
          });

          expect(isError).toBe(false);
          expect(parsed).toMatchObject({
            ok: false,
            source: "remote-unavailable",
          });
          expect(parsed.gaps[0]).toMatch(/https/);
          // The refusal names the variable, never the value or the token.
          expect(text).not.toContain("ctagt-token");
          expect(text).not.toContain("cloud.crumbtrail.test");
          // Nothing was sent anywhere.
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          fetchSpy.mockRestore();
        }
      },
    );

    it("still uses a loopback http cloud, which is how it is run locally", async () => {
      mock = await startMockCloud();
      configureCloud(mock.url);
      expect(mock.url.startsWith("http://127.0.0.1:")).toBe(true);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError } = await call(server, "getFixVerification", {
        project: "proj_1",
        canonicalIssueId: "ci_42",
      });
      expect(isError).toBe(false);
      expect(
        mock.requests.some((r) => r.path === "/api/agent/verification"),
      ).toBe(true);
    });

    it("a cloud rejection is an error the agent sees, never a quiet non-result", async () => {
      mock = await startMockCloud();
      // An issue the token cannot reach is a 404 from the route.
      mock.state.verificationStatus = 404;
      mock.state.verificationView = {
        error: "Canonical issue not found",
        code: "not_found",
      };
      configureCloud(mock.url);
      const server = new McpServer({ outputDir: tmpDir });

      const { isError, text } = await call(server, "getFixVerification", {
        project: "proj_1",
        canonicalIssueId: "ci_42",
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/getFixVerification failed/);
      expect(text).toMatch(/Canonical issue not found \(not_found\)/);
    });
  });
});
