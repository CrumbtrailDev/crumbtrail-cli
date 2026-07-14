import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "../mcp-server";
import { TicketError } from "../ticket/clients";
import type { TicketConnector } from "../ticket/clients";
import type { Reproducer, ReproductionResult } from "../reproduce/types";
import type {
  BugEvent,
  CommitInfo,
  GitHostClient,
  GitHostRef,
  Symptom,
} from "crumbtrail-core";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "crumbtrail-solve-context-"),
  );
  tempRoots.push(root);
  return root;
}

function sessionDir(root: string, name: string, events: BugEvent[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: name }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n"),
  );
  return dir;
}

function checkoutEvents(status = 200): BugEvent[] {
  return [
    {
      t: 1000,
      k: "clk",
      d: { el: { sig: "checkout-submit", txt: "Place order" } },
    },
    {
      t: 1100,
      k: "net.req",
      d: { id: "r1", requestId: "req-1", method: "POST", url: "/api/checkout" },
    },
    {
      t: 1200,
      k: "net.res",
      d: {
        id: "r1",
        requestId: "req-1",
        st: status,
        body: { ok: status < 400 },
      },
    },
  ] as unknown as BugEvent[];
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("solveContext MCP tool", () => {
  it("appears in tools/list", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    tempRoots.push(tmpDir);
    const server = new McpServer({ outputDir: tmpDir });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    const names = (res!.result as any).tools.map((t: any) => t.name);
    expect(names).toContain("solveContext");
  });

  it("returns a regression hypothesis when two sessions diverge", async () => {
    const root = makeRoot();
    sessionDir(root, "sess-a", checkoutEvents(200));
    sessionDir(root, "sess-b", checkoutEvents(500));
    const server = new McpServer({ outputDir: root });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails", url: "/api/checkout" },
          baselineSession: "sess-a",
          currentSession: "sess-b",
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(bundle.evidence.length).toBeGreaterThan(0);
    expect(bundle.opinion.hypotheses[0].kind).toBe("regression");
  });

  it("returns empty evidence, one gap, and a latent hypothesis without sessions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    tempRoots.push(tmpDir);
    const server = new McpServer({ outputDir: tmpDir });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails" },
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.evidence).toEqual([]);
    expect(bundle.gaps).toHaveLength(1);
    expect(
      bundle.opinion.hypotheses.some((h: any) => h.kind === "latent"),
    ).toBe(true);
  });
});

describe("solveContext MCP tool — ticket wiring", () => {
  function fakeTicketConnector(symptom: Symptom): TicketConnector {
    return {
      async fetchSymptom(_id: string) {
        return symptom;
      },
    };
  }

  function throwingTicketConnector(err: Error): TicketConnector {
    return {
      async fetchSymptom(_id: string) {
        throw err;
      },
    };
  }

  it("fetches + normalizes a ticket into the symptom used for fusion", async () => {
    const root = makeRoot();
    sessionDir(root, "sess-a", checkoutEvents(200));
    sessionDir(root, "sess-b", checkoutEvents(500));
    const server = new McpServer({
      outputDir: root,
      ticketConnectorFactory: () =>
        fakeTicketConnector({ title: "Checkout 500", url: "/checkout" }),
    });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          ticket: { provider: "jira", id: "ABC-1" },
          baselineSession: "sess-a",
          currentSession: "sess-b",
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.symptom.title).toBe("Checkout 500");
    expect(
      bundle.opinion.hypotheses.some((h: any) => h.kind === "regression"),
    ).toBe(true);
  });

  it("returns one gap and an inconclusive hypothesis with neither symptom nor ticket", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    tempRoots.push(tmpDir);
    const server = new McpServer({ outputDir: tmpDir });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {},
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.gaps.length).toBe(1);
    expect(
      bundle.opinion.hypotheses.some((h: any) => h.kind === "inconclusive"),
    ).toBe(true);
  });

  it("falls back to the passed symptom when the ticket connector throws", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    tempRoots.push(tmpDir);
    const server = new McpServer({
      outputDir: tmpDir,
      ticketConnectorFactory: () =>
        throwingTicketConnector(new TicketError(404, "not found")),
    });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          ticket: { provider: "jira", id: "ABC-1" },
          symptom: { title: "checkout fails" },
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.symptom.title).toBe("checkout fails");
  });
});

describe("solveContext MCP tool — git-host intent wiring", () => {
  const originalToken = process.env.CRUMBTRAIL_GITHUB_TOKEN;

  beforeEach(() => {
    process.env.CRUMBTRAIL_GITHUB_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CRUMBTRAIL_GITHUB_TOKEN;
    else process.env.CRUMBTRAIL_GITHUB_TOKEN = originalToken;
  });

  function fakeGitHostClient(commits: CommitInfo[]): GitHostClient {
    return {
      async listCommits(_ref: GitHostRef) {
        return commits;
      },
    };
  }

  it("splits regression evidence into intentional-change when a fake git host explains it", async () => {
    const root = makeRoot();
    sessionDir(root, "sess-a", checkoutEvents(200));
    sessionDir(root, "sess-b", checkoutEvents(500));
    const server = new McpServer({
      outputDir: root,
      gitHostClientFactory: () =>
        fakeGitHostClient([
          {
            sha: "a1",
            message: "checkout status change intentional",
            files: ["src/routes/checkout.ts"],
          },
        ]),
    });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails", url: "/api/checkout" },
          baselineSession: "sess-a",
          currentSession: "sess-b",
          gitHost: {
            owner: "acme",
            repo: "widgets",
            baseRef: "v1",
            headRef: "v2",
          },
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    const intentional = bundle.opinion.hypotheses.find(
      (h: any) => h.kind === "intentional-change",
    );
    const regression = bundle.opinion.hypotheses.find(
      (h: any) => h.kind === "regression",
    );

    expect(intentional).toBeDefined();
    expect(intentional.evidenceIds.length).toBeGreaterThan(0);
    if (regression) {
      for (const id of intentional.evidenceIds) {
        expect(regression.evidenceIds).not.toContain(id);
      }
    }
  });

  it("behaves like slice 1 (still regression) with no token/gitHost", async () => {
    const root = makeRoot();
    sessionDir(root, "sess-a", checkoutEvents(200));
    sessionDir(root, "sess-b", checkoutEvents(500));
    delete process.env.CRUMBTRAIL_GITHUB_TOKEN;
    const server = new McpServer({ outputDir: root });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails", url: "/api/checkout" },
          baselineSession: "sess-a",
          currentSession: "sess-b",
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.opinion.hypotheses[0].kind).toBe("regression");
  });
});

describe("solveContext MCP tool — adaptive capture directives", () => {
  it("suggests one capture directive raising all informative lanes when no sessions are compared", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    tempRoots.push(tmpDir);
    const server = new McpServer({ outputDir: tmpDir });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails" },
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.directives).toHaveLength(1);
    expect(bundle.directives[0].scope).toBe("signature");
    expect(bundle.directives[0].raise.length).toBeGreaterThan(0);
  });

  it("yields no capture directives when two diverging sessions produce evidence with no gaps", async () => {
    const root = makeRoot();
    sessionDir(root, "sess-a", checkoutEvents(200));
    sessionDir(root, "sess-b", checkoutEvents(500));
    const server = new McpServer({ outputDir: root });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails", url: "/api/checkout" },
          baselineSession: "sess-a",
          currentSession: "sess-b",
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    // Two-session compare produces non-empty evidence and no gaps, so the
    // generator's thin-evidence condition (evidence.length === 0 || gaps.length > 0)
    // is false: observed behavior is directives === [].
    expect(bundle.gaps).toEqual([]);
    expect(bundle.directives).toEqual([]);
  });
});

describe("solveContext MCP tool — reproduction wiring", () => {
  function fakeReproducer(result: ReproductionResult): {
    reproducer: Reproducer;
    callCount: () => number;
  } {
    let calls = 0;
    return {
      reproducer: {
        async reproduce(_symptom) {
          calls += 1;
          return result;
        },
      },
      callCount: () => calls,
    };
  }

  it("uses fresh evidence and drops the thin-evidence gap when reproduction succeeds and is allowed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    tempRoots.push(tmpDir);
    const { reproducer } = fakeReproducer({
      attempted: true,
      evidence: [
        {
          id: "repro-1",
          lane: "network",
          kind: "net.status",
          brief: "checkout returned 500 during reproduction",
          ref: {},
          before: 200,
          after: 500,
        },
      ],
      intent: [],
      note: "reproduced",
    });
    const server = new McpServer({
      outputDir: tmpDir,
      reproducerFactory: () => reproducer,
    });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails" },
          allowReproduction: true,
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.evidence.length).toBe(1);
    expect(
      bundle.gaps.some((g: any) =>
        g.reason.includes("no recorded session matched"),
      ),
    ).toBe(false);
    expect(
      bundle.opinion.hypotheses.some(
        (h: any) => h.kind === "regression" || h.kind === "latent",
      ),
    ).toBe(true);
  });

  it("does not call the reproducer when allowReproduction is omitted/false", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    tempRoots.push(tmpDir);
    const { reproducer, callCount } = fakeReproducer({
      attempted: true,
      evidence: [
        {
          id: "repro-1",
          lane: "network",
          kind: "net.status",
          brief: "should not be used",
          ref: {},
          before: 200,
          after: 500,
        },
      ],
      intent: [],
      note: "reproduced",
    });
    const server = new McpServer({
      outputDir: tmpDir,
      reproducerFactory: () => reproducer,
    });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails" },
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(callCount()).toBe(0);
    expect(bundle.evidence).toEqual([]);
    expect(bundle.gaps).toHaveLength(1);
  });

  it("never throws out of solveContext when the reproducer throws", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    tempRoots.push(tmpDir);
    const throwingReproducer: Reproducer = {
      async reproduce() {
        throw new Error("browser crashed");
      },
    };
    const server = new McpServer({
      outputDir: tmpDir,
      reproducerFactory: () => throwingReproducer,
    });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails" },
          allowReproduction: true,
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(bundle.evidence).toEqual([]);
    expect(bundle.gaps).toHaveLength(1);
  });

  it("does not call the reproducer when sessions already produced evidence", async () => {
    const root = makeRoot();
    sessionDir(root, "sess-a", checkoutEvents(200));
    sessionDir(root, "sess-b", checkoutEvents(500));
    const { reproducer, callCount } = fakeReproducer({
      attempted: true,
      evidence: [
        {
          id: "repro-1",
          lane: "network",
          kind: "net.status",
          brief: "should not be used",
          ref: {},
          before: 200,
          after: 500,
        },
      ],
      intent: [],
      note: "reproduced",
    });
    const server = new McpServer({
      outputDir: root,
      reproducerFactory: () => reproducer,
    });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout fails", url: "/api/checkout" },
          baselineSession: "sess-a",
          currentSession: "sess-b",
          allowReproduction: true,
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(callCount()).toBe(0);
    expect(bundle.opinion.hypotheses[0].kind).toBe("regression");
  });
});

describe("solveContext MCP tool — symptom-only auto-locate", () => {
  /** Seed a session and give it a finalized llm.json carrying distinctBugs — the
   *  exact field readDistinctBugs (and thus the recall/locate store) reads. */
  function seedLocatedSession(
    root: string,
    name: string,
    distinctBugs: unknown[],
  ): void {
    const dir = sessionDir(root, name, checkoutEvents(500));
    fs.writeFileSync(
      path.join(dir, "llm.json"),
      JSON.stringify({ distinctBugs }),
    );
  }

  const matchingBug = {
    schemaVersion: 1,
    bugId: "bug-checkout",
    title: "checkout failed span error",
    severity: "high",
    firstSeen: 1000,
    lastSeen: 1200,
    window: { start: 1000, end: 1200 },
    requestIds: ["req-1"],
    representative: {
      title: "checkout failed span error",
      detector: "otel_span_error",
      severity: "high",
      message: "checkout failed span error",
      route: "/api/checkout",
      requestId: "req-1",
    },
    frontendEvidence: [],
    backendEvidence: [
      {
        candidateId: "cand-1",
        detector: "otel_span_error",
        t: 1200,
        requestId: "req-1",
        route: "/api/checkout",
        message: "checkout POST 500",
      },
    ],
    candidateIds: ["cand-1"],
  };

  it("auto-populates the bundle from a located session when a ticket/symptom alone matches", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-incident", [matchingBug]);
    const server = new McpServer({ outputDir: root });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: {
            title: "checkout failed span error",
            url: "/api/checkout",
            errorSig: "otel_span_error",
          },
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(bundle.evidence.length).toBeGreaterThan(0);
    // Evidence adapted from the located session (network lane from backend ref).
    expect(bundle.evidence[0].lane).toBe("network");
    expect(bundle.evidence[0].ref.sessionId).toBe("sess-incident");
    // Populated evidence ⇒ the thin-evidence gap never fires.
    expect(
      bundle.gaps.some((g: any) =>
        g.reason.includes("no recorded session matched"),
      ),
    ).toBe(false);
    expect(
      bundle.opinion.hypotheses.some((h: any) => h.kind === "regression"),
    ).toBe(true);

    // War-game 01 Move 2: the locate decision is now surfaced on the bundle
    // (previously dropped). A matched auto-locate reports method "fuzzy" and the
    // matched session id.
    expect(bundle.located).toBeDefined();
    expect(bundle.located.outcome).toBe("matched");
    expect(bundle.located.method).toBe("fuzzy");
    expect(bundle.located.sessionId).toBe("sess-incident");
    expect(bundle.located.confidence).toBeGreaterThan(0);

    // Move 3: contextCompleteness is present and well-formed.
    expect(bundle.contextCompleteness).toBeDefined();
    expect(["low", "medium", "high"]).toContain(
      bundle.contextCompleteness.level,
    );
    expect(bundle.contextCompleteness.score).toBeGreaterThanOrEqual(0);
    expect(bundle.contextCompleteness.score).toBeLessThanOrEqual(1);

    // Move 4: the regression hypothesis carries a concrete, anchored
    // verification observation naming the located request id — never vacuous.
    const regression = bundle.opinion.hypotheses.find(
      (h: any) => h.kind === "regression",
    );
    expect(regression.verification).toBeDefined();
    expect(regression.verification.length).toBeGreaterThan(0);
    expect(regression.verification[0].how).toBe("request");
    expect(regression.verification[0].observation).toContain("req-1");

    // Move 5: escalation is always present (advisory, consumer-side).
    expect(bundle.escalation).toBeDefined();
    expect(typeof bundle.escalation.recommended).toBe("boolean");
  });

  it("leaves the gaps-only bundle unchanged when no session rhymes with the symptom", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-unrelated", [
      {
        schemaVersion: 1,
        bugId: "bug-dash",
        title: "Dashboard render timeout",
        severity: "high",
        firstSeen: 1000,
        lastSeen: 1200,
        window: { start: 1000, end: 1200 },
        requestIds: [],
        representative: {
          title: "Dashboard render timeout",
          detector: "otel_span_error",
          severity: "high",
          message: "dashboard widget render timeout",
          route: "/dashboard",
        },
        frontendEvidence: [],
        backendEvidence: [],
        candidateIds: [],
      },
    ]);
    const server = new McpServer({ outputDir: root });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout failed span error" },
        },
      },
    });

    const result = res!.result as any;
    const bundle = JSON.parse(result.content[0].text);

    // Inconclusive locate ⇒ identical gaps-only shape as the no-session path.
    expect(bundle.evidence).toEqual([]);
    expect(bundle.gaps).toHaveLength(1);
    expect(
      bundle.opinion.hypotheses.some((h: any) => h.kind === "latent"),
    ).toBe(true);
  });
});
