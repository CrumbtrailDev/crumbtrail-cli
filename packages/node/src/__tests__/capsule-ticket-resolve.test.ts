import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "../mcp-server";
import { runCli } from "../cli";
import { resolveTicketToBundle } from "../ticket-resolve";
import { buildRecallStore } from "../recall";
import { localSessionAccess } from "../ticket-resolve";

/**
 * capsule.v2 TICKET resolution (CRUMB-60).
 *
 * The ticket-driven pipeline (`resolveTicketToBundle`) is the ONE producer
 * behind `solveContext`, the MCP `resolveCapsule` tool and the CLI `capsule`
 * command. These tests prove three things:
 *
 *   1. `solveContext` still emits exactly the same fusion.v1 payload after the
 *      pipeline was extracted out of it — same top-level keys, no capsule keys.
 *   2. A ticket resolves to a capsule on BOTH surfaces, through that producer
 *      and the single compile site.
 *   3. The two surfaces are byte-identical for the same ticket input, so the
 *      capsule fingerprint (canonicalId + signature) is stable across surfaces.
 *
 * The ticket fetch is a real HTTP round trip to a local stand-in Jira, driven
 * through the documented JIRA_* env credentials — the same code path production
 * takes — so neither surface gets a test-only shortcut the other lacks.
 */

const tempRoots: string[] = [];
const servers: http.Server[] = [];
const envKeys = [
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "CRUMBTRAIL_CLOUD_URL",
  "CRUMBTRAIL_API_KEY",
  "CRUMBTRAIL_GITHUB_TOKEN",
] as const;
let savedEnv: Record<string, string | undefined> = {};

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "crumbtrail-capsule-ticket-"),
  );
  tempRoots.push(root);
  return root;
}

const TICKET_SUMMARY = "checkout failed span error";
const TICKET_KEY = "CRUMB-60";

/** A stand-in Jira that serves ONE issue. `status` drives the failure case. */
async function startJira(status = 200): Promise<{ baseUrl: string; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ errorMessages: ["boom"] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        key: TICKET_KEY,
        fields: {
          summary: TICKET_SUMMARY,
          description: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "POST /api/checkout returns 500" }],
              },
            ],
          },
        },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, hits };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  // The cloud pull path and git-host inference must stay unconfigured so this
  // exercises the local ticket-fetch pipeline.
  for (const key of envKeys) delete process.env[key];
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

async function useJira(status = 200): Promise<{ hits: string[] }> {
  const { baseUrl, hits } = await startJira(status);
  process.env.JIRA_BASE_URL = baseUrl;
  process.env.JIRA_EMAIL = "agent@example.com";
  process.env.JIRA_API_TOKEN = "test-token";
  return { hits };
}

const matchingBug = {
  schemaVersion: 1,
  bugId: "bug-checkout",
  title: TICKET_SUMMARY,
  severity: "high",
  firstSeen: 1000,
  lastSeen: 1200,
  window: { start: 1000, end: 1200 },
  requestIds: ["req-1"],
  representative: {
    title: TICKET_SUMMARY,
    detector: "otel_span_error",
    severity: "high",
    // Mirrors the ticket description so the locate engine scores this session
    // above its match threshold from the TICKET text alone.
    message: "POST /api/checkout returns 500",
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

function seedLocatedSession(outputDir: string, name: string): void {
  const dir = path.join(outputDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: name }),
  );
  fs.writeFileSync(
    path.join(dir, "llm.json"),
    JSON.stringify({ distinctBugs: [matchingBug] }),
  );
  fs.writeFileSync(
    path.join(dir, "index.json"),
    JSON.stringify({ start: 1000, end: 1200 }),
  );
}

async function captureStdout(run: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

function serverFor(root: string): McpServer {
  return new McpServer({ outputDir: root, evidenceSourcesFactory: () => [] });
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return res!.result as any;
}

/** Every top-level key a fusion.v1 RankedBundle may carry. `located` is present
 *  only when a locate ran, so it is asserted separately. */
const FUSION_TOP_LEVEL_KEYS = [
  "schemaVersion",
  "symptom",
  "evidence",
  "opinion",
  "gaps",
  "directives",
  "contextCompleteness",
  "escalation",
];

// --- solveContext is untouched by the extraction ----------------------------

describe("solveContext output shape after the pipeline extraction", () => {
  it("emits the same fusion.v1 top-level keys for a symptom, with no capsule leakage", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");

    const result = await callTool(serverFor(root), "solveContext", {
      symptom: { title: TICKET_SUMMARY, url: "/api/checkout" },
    });
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(Object.keys(bundle).sort()).toEqual(
      [...FUSION_TOP_LEVEL_KEYS, "located"].sort(),
    );
    // No part of the capsule envelope may leak into the fusion payload.
    for (const capsuleKey of [
      "capsule",
      "identity",
      "joinGraph",
      "quality",
      "advisory",
      "memory",
      "resolution",
      "directions",
      "occurrences",
    ]) {
      expect(bundle[capsuleKey]).toBeUndefined();
    }
  });

  it("emits the same fusion.v1 payload for a TICKET, with no capsule leakage", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    await useJira();

    const result = await callTool(serverFor(root), "solveContext", {
      ticket: { provider: "jira", ticketKey: TICKET_KEY },
    });
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(Object.keys(bundle).sort()).toEqual(
      [...FUSION_TOP_LEVEL_KEYS, "located"].sort(),
    );
    expect(bundle.symptom.title).toBe(TICKET_SUMMARY);
    expect(bundle.symptom.source).toBe("jira");
    expect(bundle.capsule).toBeUndefined();
    expect(bundle.identity).toBeUndefined();
  });

  it("keeps emitting an evidence-free bundle with gaps when no input is given", async () => {
    const result = await callTool(serverFor(makeRoot()), "solveContext", {});
    const bundle = JSON.parse(result.content[0].text);

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(bundle.evidence).toEqual([]);
    expect(bundle.gaps.map((gap: any) => gap.reason)).toContain(
      "a symptom or ticket is required",
    );
    // No locate ran, so the optional key stays absent exactly as before.
    expect(Object.keys(bundle).sort()).toEqual([...FUSION_TOP_LEVEL_KEYS].sort());
  });

  it("still refuses an explicit session comparison against a remote artifact store", async () => {
    const resolved = await resolveTicketToBundle(
      {
        symptom: { title: TICKET_SUMMARY },
        baselineSession: "a",
        currentSession: "b",
      },
      { recallStore: buildRecallStore(makeRoot()), evidenceSources: [] },
    );

    expect(resolved.kind).toBe("error");
    if (resolved.kind !== "error") return;
    expect(resolved.message).toContain("remote artifact store");
  });
});

// --- the ticket path reaches the capsule surfaces ---------------------------

describe("resolveCapsule MCP tool — ticket input", () => {
  it("resolves a ticket reference to a capsule.v2 envelope", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    const { hits } = await useJira();

    const result = await callTool(serverFor(root), "resolveCapsule", {
      ticket: { provider: "jira", ticketKey: TICKET_KEY },
    });
    const capsule = JSON.parse(result.content[0].text);

    // The ticket really was fetched through the documented connector.
    expect(hits).toEqual([`/rest/api/3/issue/${TICKET_KEY}`]);
    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.symptom.behavior.title).toBe(TICKET_SUMMARY);
    expect(capsule.evidence.bundle.schemaVersion).toBe("fusion.v1");
    // The ticket text alone located the recorded session and carried its
    // evidence into the capsule — this is the ticket-driven pipeline, not a
    // symptom the caller had already resolved by hand.
    expect(capsule.evidence.bundle.located.outcome).toBe("matched");
    expect(capsule.evidence.bundle.located.sessionId).toBe("sess-checkout");
    expect(capsule.evidence.bundle.evidence.length).toBeGreaterThan(0);
    expect(capsule.identity.canonicalId).toBe("sess-checkout");
    // The ticket is recorded as an external ref, never invented.
    expect(capsule.identity.externalRefs).toEqual([
      { system: "jira", id: TICKET_KEY },
    ]);
  });

  it("wraps EXACTLY the bundle solveContext returns for the same ticket", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    await useJira();
    const server = serverFor(root);
    const args = { ticket: { provider: "jira", ticketKey: TICKET_KEY } };

    const fusion = JSON.parse(
      (await callTool(server, "solveContext", args)).content[0].text,
    );
    const capsule = JSON.parse(
      (await callTool(server, "resolveCapsule", args)).content[0].text,
    );

    // One producer: the capsule frames the fusion bundle, never a second ranking.
    expect(capsule.evidence.bundle).toEqual(fusion);
  });

  it("resolves a pasted ticket URL and records it as the external ref link", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    await useJira();
    const url = `https://acme.atlassian.net/browse/${TICKET_KEY}`;

    const result = await callTool(serverFor(root), "resolveCapsule", {
      ticket: url,
    });
    const capsule = JSON.parse(result.content[0].text);

    expect(capsule.symptom.behavior.title).toBe(TICKET_SUMMARY);
    expect(capsule.identity.externalRefs).toEqual([
      { system: "jira", id: TICKET_KEY, url },
    ]);
  });

  it("stays deliverable and states the gap when the ticket fetch fails", async () => {
    const root = makeRoot();
    await useJira(500);

    const result = await callTool(serverFor(root), "resolveCapsule", {
      ticket: { provider: "jira", ticketKey: TICKET_KEY },
    });
    const capsule = JSON.parse(result.content[0].text);

    // Deliverable, not a refusal: a full envelope naming the failure as a gap.
    expect(result.isError).toBeUndefined();
    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.evidence.bundle.evidence).toEqual([]);
    expect(capsule.advisory.stance).toBe("advisory");
    expect(JSON.stringify(capsule.evidence.bundle.gaps)).toContain(
      "ticket fetch failed",
    );
    // The unresolved ticket is still linked, and the symptom degrades to its key.
    expect(capsule.symptom.behavior.title).toBe(TICKET_KEY);
    expect(capsule.identity.externalRefs).toEqual([
      { system: "jira", id: TICKET_KEY },
    ]);
  });

  it("requires a symptom title or a ticket", async () => {
    const result = await callTool(serverFor(makeRoot()), "resolveCapsule", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ticket");
  });

  it("advertises the ticket input on the tool schema", async () => {
    const res = await serverFor(makeRoot()).handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tool = (res!.result as any).tools.find(
      (t: any) => t.name === "resolveCapsule",
    );
    expect(tool.inputSchema.properties.ticket).toBeDefined();
    expect(tool.inputSchema.properties.baselineSession).toBeDefined();
  });
});

// --- CLI surface, ticket input ----------------------------------------------

describe("crumbtrail-server capsule CLI — ticket input", () => {
  it("resolves a ticket reference to the capsule.v2 envelope", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    await useJira();

    const out = await captureStdout(() =>
      runCli([
        "capsule",
        "--ticket",
        TICKET_KEY,
        "--provider",
        "jira",
        "--output",
        root,
        "--json",
      ]),
    );
    const capsule = JSON.parse(out);

    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.symptom.behavior.title).toBe(TICKET_SUMMARY);
    expect(capsule.identity.externalRefs).toEqual([
      { system: "jira", id: TICKET_KEY },
    ]);
  });

  it("rejects an unknown --provider", async () => {
    const errs: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        errs.push(String(chunk));
        return true;
      });
    let code: number;
    try {
      code = await runCli([
        "capsule",
        "--ticket",
        TICKET_KEY,
        "--provider",
        "linear",
        "--output",
        makeRoot(),
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(1);
    expect(errs.join("")).toContain("--provider must be one of");
  });

  it("documents the ticket flags in per-subcommand help", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await runCli(["capsule", "--help"]);
    } finally {
      spy.mockRestore();
    }
    const out = logs.join("\n");
    expect(out).toContain("--ticket");
    expect(out).toContain("--provider");
  });
});

// --- parity: the property that must hold for the TICKET path ----------------

describe("MCP + CLI capsule parity — TICKET path", () => {
  it("produces an identical capsule from both surfaces for an explicit ticket ref", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    await useJira();

    const mcp = JSON.parse(
      (
        await callTool(serverFor(root), "resolveCapsule", {
          ticket: { provider: "jira", ticketKey: TICKET_KEY },
        })
      ).content[0].text,
    );
    const cli = JSON.parse(
      await captureStdout(() =>
        runCli([
          "capsule",
          "--ticket",
          TICKET_KEY,
          "--provider",
          "jira",
          "--output",
          root,
          "--json",
        ]),
      ),
    );

    expect(cli).toEqual(mcp);
    // The fingerprint specifically must be stable across surfaces.
    expect(cli.identity.canonicalId).toBe(mcp.identity.canonicalId);
    expect(cli.identity.signature).toBe(mcp.identity.signature);
  });

  it("produces an identical capsule from both surfaces for a pasted ticket URL", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    await useJira();
    const url = `https://acme.atlassian.net/browse/${TICKET_KEY}`;

    const mcp = JSON.parse(
      (await callTool(serverFor(root), "resolveCapsule", { ticket: url }))
        .content[0].text,
    );
    const cli = JSON.parse(
      await captureStdout(() =>
        runCli(["capsule", "--ticket", url, "--output", root, "--json"]),
      ),
    );

    expect(cli).toEqual(mcp);
  });

  it("keeps the fingerprint stable across repeated resolutions of one ticket", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    await useJira();
    const args = { ticket: { provider: "jira", ticketKey: TICKET_KEY } };

    const first = JSON.parse(
      (await callTool(serverFor(root), "resolveCapsule", args)).content[0].text,
    );
    const second = JSON.parse(
      (await callTool(serverFor(root), "resolveCapsule", args)).content[0].text,
    );

    expect(second.identity).toEqual(first.identity);
    expect(second).toEqual(first);
  });

  it("runs the SAME producer for both surfaces: one shared call, one result", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    await useJira();
    const args = { ticket: { provider: "jira", ticketKey: TICKET_KEY } };

    // The producer, called directly with the deps each surface builds.
    const direct = await resolveTicketToBundle(args, {
      recallStore: buildRecallStore(root),
      evidenceSources: [],
      localSessions: localSessionAccess(root),
    });
    expect(direct.kind).toBe("assembled");
    if (direct.kind !== "assembled") return;

    const viaMcp = JSON.parse(
      (await callTool(serverFor(root), "resolveCapsule", args)).content[0].text,
    );
    expect(viaMcp.evidence.bundle).toEqual(JSON.parse(JSON.stringify(direct.bundle)));
  });
});
