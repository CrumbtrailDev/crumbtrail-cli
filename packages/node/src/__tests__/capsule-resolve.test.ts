import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleBundle } from "crumbtrail-core";
import type { EvidenceItem, RankedBundle, Symptom } from "crumbtrail-core";
import {
  compileCapsuleFromBundle,
  deriveCapsuleCanonicalId,
  deriveCapsuleSignature,
  resolveIssueToCapsule,
} from "../capsule-resolve";
import { buildRecallStore } from "../recall";
import { McpServer } from "../mcp-server";
import { runCli } from "../cli";

/**
 * capsule.v2 resolution parity (CRUMB-60). Proves crumbtrail-node resolves an
 * issue to a capsule.v2 envelope through BOTH the MCP server and the CLI from
 * ONE shared helper, and that the existing fusion.v1 tool/CLI outputs are
 * untouched.
 */

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-capsule-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

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

// --- fixtures ---------------------------------------------------------------

function evidenceItem(id: string, lane: EvidenceItem["lane"]): EvidenceItem {
  return {
    id,
    lane,
    t: 1200,
    summary: `${lane} evidence ${id}`,
    ref: { kind: "session", sessionId: "sess-1" },
  } as unknown as EvidenceItem;
}

/** A bundle produced by the REAL fusion path, never hand-assembled. */
function bundleFor(
  symptom: Symptom,
  evidence: EvidenceItem[] = [],
): RankedBundle {
  return assembleBundle({ symptom, evidence, intent: [], gaps: [] });
}

const checkoutEvents = [
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
    d: { id: "r1", requestId: "req-1", st: 500, body: { ok: false } },
  },
];

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

/** Seed a finalized session whose llm.json carries the distinctBugs the
 *  locate/recall store reads. */
function seedLocatedSession(outputDir: string, name: string): void {
  const dir = path.join(outputDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: name }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    checkoutEvents.map((event) => JSON.stringify(event)).join("\n"),
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

// --- the shared compile helper ---------------------------------------------

describe("compileCapsuleFromBundle (the one compile site)", () => {
  it("wraps the resolved bundle in a capsule.v2 envelope with all ten parts", () => {
    const bundle = bundleFor({ title: "checkout fails", url: "/api/checkout" }, [
      evidenceItem("ev-1", "network"),
    ]);

    const capsule = compileCapsuleFromBundle(bundle);

    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.identity.schemaVersion).toBe("capsule.v2");
    for (const part of [
      "identity",
      "symptom",
      "occurrences",
      "evidence",
      "joinGraph",
      "quality",
      "advisory",
      "memory",
      "resolution",
      "directions",
    ] as const) {
      expect(capsule[part]).toBeDefined();
    }
  });

  it("references the existing bundle verbatim as part 4 — never re-ranked", () => {
    const evidence = [evidenceItem("ev-1", "network"), evidenceItem("ev-2", "browser")];
    const bundle = bundleFor({ title: "checkout fails" }, evidence);

    const capsule = compileCapsuleFromBundle(bundle);

    // Identity, not a copy: the capsule points at the same bundle object.
    expect(capsule.evidence.bundle).toBe(bundle);
    expect(capsule.evidence.bundle.schemaVersion).toBe("fusion.v1");
    expect(capsule.evidence.bundle.evidence.map((e) => e.id)).toEqual(
      bundle.evidence.map((e) => e.id),
    );
    expect(capsule.symptom.behavior).toEqual(bundle.symptom);
  });

  it("derives the signature from the symptom's own errorSig when present", () => {
    const bundle = bundleFor({ title: "checkout fails", errorSig: "err_abc123" });

    expect(deriveCapsuleSignature(bundle)).toBe("err_abc123");
    expect(compileCapsuleFromBundle(bundle).identity.signature).toBe("err_abc123");
  });

  it("derives a deterministic signature when the symptom carries no errorSig", () => {
    const a = bundleFor({ title: "checkout fails", url: "/api/checkout" });
    const b = bundleFor({ title: "checkout fails", url: "/api/checkout" });
    const other = bundleFor({ title: "login fails", url: "/api/login" });

    expect(deriveCapsuleSignature(a)).toBe(deriveCapsuleSignature(b));
    expect(deriveCapsuleSignature(a)).not.toBe(deriveCapsuleSignature(other));
    expect(deriveCapsuleSignature(a)).toMatch(/^sig_/);
  });

  it("uses the located session id as the canonical id, else the signature", () => {
    const bare = bundleFor({ title: "checkout fails" });
    expect(deriveCapsuleCanonicalId(bare, "sig_x")).toBe("sig_x");

    const located: RankedBundle = {
      ...bare,
      located: {
        outcome: "matched",
        confidence: 0.9,
        method: "fuzzy",
        sessionId: "sess-42",
        reasons: [],
      },
    };
    expect(deriveCapsuleCanonicalId(located, "sig_x")).toBe("sess-42");
    expect(compileCapsuleFromBundle(located).identity.canonicalId).toBe("sess-42");
  });

  it("emits NO completeness score when node supplies no evidence profile", () => {
    const bundle = bundleFor({ title: "checkout fails" }, [
      evidenceItem("ev-1", "network"),
    ]);

    const capsule = compileCapsuleFromBundle(bundle);

    // The type links profile+completeness; without a denominator neither appears.
    expect(capsule.quality.profile).toBeUndefined();
    expect(capsule.quality.completeness).toBeUndefined();
    expect(capsule.quality.presentLanes).toContain("network");
  });

  it("scores completeness only when a caller supplies the profile denominator", () => {
    const bundle = bundleFor({ title: "checkout fails" }, [
      evidenceItem("ev-1", "network"),
    ]);

    const capsule = compileCapsuleFromBundle(bundle, {
      evidenceProfile: {
        expectedLanes: ["network", "browser"],
        configuredSources: ["sentry"],
      },
    });

    expect(capsule.quality.completeness).toEqual({
      score: 0.5,
      expected: 2,
      present: 1,
    });
    expect(capsule.quality.missingLanes).toEqual(["browser"]);
  });

  it("stays deliverable and explicitly inconclusive on a thin bundle", () => {
    const capsule = compileCapsuleFromBundle(bundleFor({ title: "" }));

    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.advisory.stance).toBe("advisory");
    expect(capsule.advisory.inconclusive).toBe(true);
    // Node fabricates nothing it does not have.
    expect(capsule.occurrences).toEqual({
      sessions: 0,
      users: 0,
      tenants: 0,
      releases: [],
      provenance: "inferred",
      privacySafe: true,
    });
    expect(capsule.memory).toEqual({ relatedIssues: [], verifiedFixHistory: [] });
    expect(capsule.resolution).toEqual({ verificationState: "unverified" });
  });

  it("preserves unjoined evidence as islands rather than dropping it", () => {
    const bundle = bundleFor({ title: "checkout fails" }, [
      evidenceItem("ev-1", "network"),
      evidenceItem("ev-2", "browser"),
    ]);

    const capsule = compileCapsuleFromBundle(bundle);

    expect(capsule.joinGraph.edges).toEqual([]);
    expect(capsule.joinGraph.islands.map((i) => i.evidenceId).sort()).toEqual([
      "ev-1",
      "ev-2",
    ]);
    for (const island of capsule.joinGraph.islands) {
      expect(island.reason).toBe("missing_join_key");
    }
  });
});

// --- the shared resolution path --------------------------------------------

describe("resolveIssueToCapsule (shared by MCP + CLI)", () => {
  it("resolves a symptom through the existing locate+assemble path", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");

    const { capsule, bundle, match } = await resolveIssueToCapsule(
      { title: "checkout failed span error", url: "/api/checkout" },
      buildRecallStore(root),
      { sources: [] },
    );

    expect(capsule.schemaVersion).toBe("capsule.v2");
    // The capsule wraps exactly the bundle the existing path produced.
    expect(capsule.evidence.bundle).toBe(bundle);
    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(match).toBeDefined();
  });

  it("returns a deliverable capsule that states its limits when nothing matches", async () => {
    const root = makeRoot();

    const { capsule } = await resolveIssueToCapsule(
      { title: "nothing recorded like this" },
      buildRecallStore(root),
      { sources: [] },
    );

    // Deliverable, not a refusal: a full envelope carrying its own gaps.
    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.evidence.bundle.evidence).toEqual([]);
    expect(capsule.quality.gaps.map((g) => g.reason)).toContain(
      "no_matching_evidence",
    );
    // No profile configured, so completeness is not scored rather than guessed.
    expect(capsule.quality.completeness).toBeUndefined();
    // The advisory stays advisory and low-confidence; unknowns are named.
    expect(capsule.advisory.stance).toBe("advisory");
    expect(capsule.advisory.fixClasses[0]?.confidence).toBeLessThanOrEqual(0.3);
    expect(capsule.advisory.unknowns.length).toBeGreaterThan(0);
    expect(capsule.directions.nextActions.length).toBeGreaterThan(0);
  });
});

// --- MCP surface ------------------------------------------------------------

describe("resolveCapsule MCP tool", () => {
  it("appears in tools/list", async () => {
    const server = new McpServer({ outputDir: makeRoot() });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    const names = (res!.result as any).tools.map((t: any) => t.name);
    expect(names).toContain("resolveCapsule");
    // Additive: the existing tool is still there.
    expect(names).toContain("solveContext");
  });

  it("resolves a symptom to a capsule.v2 envelope", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    const server = new McpServer({ outputDir: root, evidenceSourcesFactory: () => [] });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "resolveCapsule",
        arguments: {
          symptom: { title: "checkout failed span error", url: "/api/checkout" },
        },
      },
    });

    const capsule = JSON.parse((res!.result as any).content[0].text);
    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.evidence.bundle.schemaVersion).toBe("fusion.v1");
    expect(capsule.identity.signature).toBeTruthy();
    expect(capsule.advisory.stance).toBe("advisory");
  });

  it("requires a symptom title", async () => {
    const server = new McpServer({ outputDir: makeRoot() });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "resolveCapsule", arguments: {} },
    });

    expect((res!.result as any).isError).toBe(true);
  });

  it("leaves the existing solveContext output unchanged (no capsule leakage)", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");
    const server = new McpServer({ outputDir: root, evidenceSourcesFactory: () => [] });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "solveContext",
        arguments: {
          symptom: { title: "checkout failed span error", url: "/api/checkout" },
        },
      },
    });

    const bundle = JSON.parse((res!.result as any).content[0].text);
    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(bundle.capsule).toBeUndefined();
    expect(bundle.identity).toBeUndefined();
  });
});

// --- CLI surface ------------------------------------------------------------

describe("crumbtrail-server capsule CLI command", () => {
  it("emits the capsule.v2 envelope as JSON", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");

    const out = await captureStdout(() =>
      runCli([
        "capsule",
        "checkout failed span error",
        "--url",
        "/api/checkout",
        "--output",
        root,
        "--json",
      ]),
    );

    const capsule = JSON.parse(out);
    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.evidence.bundle.schemaVersion).toBe("fusion.v1");
  });

  it("prints a human summary without --json", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");

    const out = await captureStdout(() =>
      runCli(["capsule", "checkout failed span error", "--output", root]),
    );

    expect(out).toContain("capsule.v2");
    expect(out).toContain("Signature:");
    expect(out).toContain("Advisory:");
  });

  it("fails with a clear message when no symptom title is given", async () => {
    const errs: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        errs.push(String(chunk));
        return true;
      });
    let code: number;
    try {
      code = await runCli(["capsule", "--output", makeRoot()]);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(1);
    expect(errs.join("")).toContain("title");
  });

  it("documents itself in help and per-subcommand help", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await runCli(["help"]);
      await runCli(["capsule", "--help"]);
    } finally {
      spy.mockRestore();
    }
    const out = logs.join("\n");
    expect(out).toContain("capsule");
    expect(out).toContain("crumbtrail-server capsule");
    expect(out).toContain("Options:");
  });
});

// --- parity -----------------------------------------------------------------

describe("MCP + CLI capsule parity", () => {
  it("produces an identical capsule from both surfaces for the same issue", async () => {
    const root = makeRoot();
    seedLocatedSession(root, "sess-checkout");

    const server = new McpServer({ outputDir: root, evidenceSourcesFactory: () => [] });
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "resolveCapsule",
        arguments: {
          symptom: { title: "checkout failed span error", url: "/api/checkout" },
        },
      },
    });
    const mcpCapsule = JSON.parse((res!.result as any).content[0].text);

    const out = await captureStdout(() =>
      runCli([
        "capsule",
        "checkout failed span error",
        "--url",
        "/api/checkout",
        "--output",
        root,
        "--json",
      ]),
    );
    const cliCapsule = JSON.parse(out);

    expect(cliCapsule).toEqual(mcpCapsule);
  });
});
