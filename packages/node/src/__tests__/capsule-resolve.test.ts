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
