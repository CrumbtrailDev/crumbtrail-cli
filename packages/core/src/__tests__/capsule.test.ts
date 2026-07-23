import { describe, expect, it } from "vitest";
import {
  CAPSULE_SCHEMA_VERSION,
  GAP_REASONS,
  compileCapsuleV2,
  isGapReason,
} from "../capsule";
import type {
  CompileCapsuleV2Input,
  EvidenceProfile,
} from "../capsule";
import { assembleBundle } from "../fusion";
import type { RankedBundle, Symptom } from "../fusion";
import type { EvidenceItem, IntentSignal } from "../evidence";
import * as core from "../index";

function evidenceItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "id-1",
    lane: "flow",
    kind: "flow.step-missing",
    brief: "generic evidence",
    ref: {},
    before: undefined,
    after: undefined,
    ...overrides,
  };
}

/** A full-ish bundle: network + db evidence anchored to a request/table. */
function richBundle(): RankedBundle {
  const symptom: Symptom = { title: "checkout fails", url: "/api/checkout" };
  const evidence: EvidenceItem[] = [
    evidenceItem({
      id: "net-1",
      lane: "network",
      kind: "net.status",
      brief: "POST /api/checkout returned 500",
      ref: { requestId: "req_abc", sig: "checkout-500" },
    }),
    evidenceItem({
      id: "db-1",
      lane: "db",
      kind: "db.row-value",
      brief: "orders row not written",
      ref: { table: "orders", pk: { id: 42 } },
    }),
  ];
  const intent: IntentSignal[] = [];
  return assembleBundle({ symptom, evidence, intent });
}

/** A thin/degraded bundle: empty symptom, no evidence, a gap. */
function thinBundle(): RankedBundle {
  return assembleBundle({
    symptom: { title: "" },
    evidence: [],
    intent: [],
    gaps: [{ lane: "network", reason: "no recorded sessions compared" }],
  });
}

function baseInput(bundle: RankedBundle): CompileCapsuleV2Input {
  return {
    identity: { canonicalId: "ISSUE-1", signature: "sig-1" },
    bundle,
  };
}

describe("compileCapsuleV2 — envelope shape", () => {
  it("tags the schema version and re-exports from the barrel", () => {
    expect(CAPSULE_SCHEMA_VERSION).toBe("capsule.v2");
    expect(core.CAPSULE_SCHEMA_VERSION).toBe("capsule.v2");
    expect(core.compileCapsuleV2).toBe(compileCapsuleV2);
    expect(typeof core.isGapReason).toBe("function");
  });

  it("produces all ten envelope parts", () => {
    const capsule = compileCapsuleV2(baseInput(richBundle()));
    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.identity).toBeDefined();
    expect(capsule.symptom).toBeDefined();
    expect(capsule.occurrences).toBeDefined();
    expect(capsule.evidence).toBeDefined();
    expect(capsule.joinGraph).toBeDefined();
    expect(capsule.quality).toBeDefined();
    expect(capsule.advisory).toBeDefined();
    expect(capsule.memory).toBeDefined();
    expect(capsule.resolution).toBeDefined();
    expect(capsule.directions).toBeDefined();
    expect(capsule.identity.schemaVersion).toBe("capsule.v2");
    expect(capsule.identity.revision).toBe(1);
  });
});

describe("Part 4 — additive: wraps the existing bundle unchanged", () => {
  it("references the ranked bundle verbatim without altering it", () => {
    const bundle = richBundle();
    const snapshot = structuredClone(bundle);
    const capsule = compileCapsuleV2(baseInput(bundle));

    // Same object, referenced not re-shaped.
    expect(capsule.evidence.bundle).toBe(bundle);
    // Deep-equal to the pre-compile snapshot: nothing mutated.
    expect(capsule.evidence.bundle).toEqual(snapshot);
    // v1 shape preserved: schema, evidence order, opinion stance.
    expect(capsule.evidence.bundle.schemaVersion).toBe("fusion.v1");
    expect(capsule.evidence.bundle.evidence.map((e) => e.id)).toEqual([
      "net-1",
      "db-1",
    ]);
    expect(capsule.evidence.bundle.opinion.stance).toBe("advisory");
  });

  it("carries evidence references drawn from the bundle", () => {
    const bundle = richBundle();
    const capsule = compileCapsuleV2(baseInput(bundle));
    expect(capsule.evidence.refs).toHaveLength(bundle.evidence.length);
  });
});

describe("Part 5 — join graph: islands + provenance + non-causal proximity", () => {
  it("preserves unjoined evidence as an island, never dropped", () => {
    const bundle = richBundle();
    const capsule = compileCapsuleV2({
      ...baseInput(bundle),
      // Only net-1 participates in a join; db-1 has no join at all and must be
      // preserved as an island.
      joins: [
        {
          evidenceIds: ["net-1", "net-1"],
          key: "requestId",
          provenance: "captured",
          basis: "shared_key",
        },
      ],
    });
    // db-1 is unjoined → must appear as an island.
    const islandIds = capsule.joinGraph.islands.map((i) => i.evidenceId);
    expect(islandIds).toContain("db-1");
    // No evidence id is silently lost: every evidence id is either in an edge
    // or an island.
    const edgeIds = new Set(
      capsule.joinGraph.edges.flatMap((e) => [e.fromEvidenceId, e.toEvidenceId]),
    );
    for (const item of bundle.evidence) {
      expect(edgeIds.has(item.id) || islandIds.includes(item.id)).toBe(true);
    }
    // Island reason comes from the closed vocab.
    for (const island of capsule.joinGraph.islands) {
      expect(GAP_REASONS).toContain(island.reason);
    }
  });

  it("all evidence becomes islands when no joins are supplied", () => {
    const bundle = richBundle();
    const capsule = compileCapsuleV2(baseInput(bundle));
    expect(capsule.joinGraph.edges).toEqual([]);
    expect(capsule.joinGraph.islands.map((i) => i.evidenceId).sort()).toEqual([
      "db-1",
      "net-1",
    ]);
  });

  it("records key provenance on edges and only asserts causal for captured keys", () => {
    const bundle = richBundle();
    const capsule = compileCapsuleV2({
      ...baseInput(bundle),
      joins: [
        {
          evidenceIds: ["net-1", "db-1"],
          key: "requestId",
          provenance: "provider_mapped",
          basis: "shared_key",
        },
      ],
    });
    const edge = capsule.joinGraph.edges[0];
    expect(edge.provenance).toBe("provider_mapped");
    // A provider-mapped (not captured) shared key is correlation, not causation.
    expect(edge.causal).toBe(false);
    expect(capsule.joinGraph.islands).toEqual([]);
  });

  it("labels time-proximity edges non-causal", () => {
    const bundle = richBundle();
    const capsule = compileCapsuleV2({
      ...baseInput(bundle),
      joins: [
        {
          evidenceIds: ["net-1", "db-1"],
          key: "time",
          provenance: "inferred",
          basis: "time_proximity",
        },
      ],
    });
    const edge = capsule.joinGraph.edges[0];
    expect(edge.basis).toBe("time_proximity");
    // Rule: never present time proximity as an exact causal join.
    expect(edge.causal).toBe(false);
  });
});

describe("Part 6 — quality report: closed gaps + completeness denominator", () => {
  it("emits gap reasons ONLY from the closed vocabulary", () => {
    const bundle = thinBundle();
    const capsule = compileCapsuleV2({
      ...baseInput(bundle),
      gaps: [{ lane: "db", reason: "not_configured" }],
      redactions: [{ lane: "browser", reason: "policy_redacted" }],
      queryFailures: [{ lane: "logs", reason: "query_timeout" }],
    });
    for (const gap of capsule.quality.gaps) {
      expect(isGapReason(gap.reason)).toBe(true);
    }
    for (const r of capsule.quality.redactions) {
      expect(r.reason).toBe("policy_redacted");
    }
    for (const q of capsule.quality.queryFailures) {
      expect(GAP_REASONS).toContain(q.reason);
    }
  });

  it("maps a bundle source-unavailable gap into a query failure", () => {
    const bundle = assembleBundle({
      symptom: { title: "checkout fails" },
      evidence: [],
      intent: [],
      gaps: [
        {
          lane: "network",
          reason: "sentry dispatch failed",
          kind: "source-unavailable",
        },
      ],
    });
    const capsule = compileCapsuleV2(baseInput(bundle));
    expect(
      capsule.quality.queryFailures.some(
        (q) => q.reason === "source_unavailable",
      ),
    ).toBe(true);
  });

  it("omits completeness entirely when no EvidenceProfile is supplied", () => {
    const capsule = compileCapsuleV2(baseInput(richBundle()));
    expect(capsule.quality.profile).toBeUndefined();
    expect(capsule.quality.completeness).toBeUndefined();
    // No denominator → no missing lanes claimed either.
    expect(capsule.quality.missingLanes).toEqual([]);
    // Present lanes are still reported (no score needed for that).
    expect(capsule.quality.presentLanes.sort()).toEqual(["db", "network"]);
  });

  it("computes completeness against the EvidenceProfile denominator when present", () => {
    const profile: EvidenceProfile = {
      expectedLanes: ["network", "db", "flow", "browser"],
      configuredSources: ["sentry", "postgres"],
    };
    const capsule = compileCapsuleV2({
      ...baseInput(richBundle()),
      evidenceProfile: profile,
    });
    expect(capsule.quality.profile).toEqual(profile);
    // 2 of 4 expected lanes present (network, db).
    expect(capsule.quality.completeness).toEqual({
      score: 0.5,
      expected: 4,
      present: 2,
    });
    expect(capsule.quality.missingLanes.sort()).toEqual(["browser", "flow"]);
  });
});

describe("Part 7/10 — degraded input stays deliverable + inconclusive", () => {
  it("compiles a thin bundle into a deliverable, inconclusive capsule", () => {
    const capsule = compileCapsuleV2(baseInput(thinBundle()));
    // Still a full capsule — delivery is never blocked by low quality.
    expect(capsule.schemaVersion).toBe("capsule.v2");
    expect(capsule.evidence.bundle.evidence).toEqual([]);
    // Advisory is explicitly inconclusive.
    expect(capsule.advisory.inconclusive).toBe(true);
    expect(capsule.advisory.stance).toBe("advisory");
    // Directions still present (bounded next actions).
    expect(capsule.directions.nextActions.length).toBeGreaterThan(0);
  });

  it("marks a rich, distinguished bundle as NOT inconclusive", () => {
    const capsule = compileCapsuleV2(baseInput(richBundle()));
    expect(capsule.advisory.inconclusive).toBe(false);
    expect(capsule.advisory.fixClasses.length).toBeGreaterThan(0);
  });
});

describe("occurrences + resolution defaults", () => {
  it("defaults occurrences to a privacy-safe inferred zero aggregate", () => {
    const capsule = compileCapsuleV2(baseInput(richBundle()));
    expect(capsule.occurrences).toEqual({
      sessions: 0,
      users: 0,
      tenants: 0,
      releases: [],
      provenance: "inferred",
      privacySafe: true,
    });
    expect(capsule.resolution.verificationState).toBe("unverified");
  });
});

describe("isGapReason", () => {
  it("accepts closed-vocab members and rejects anything else", () => {
    for (const r of GAP_REASONS) expect(isGapReason(r)).toBe(true);
    expect(isGapReason("totally_made_up")).toBe(false);
    expect(isGapReason(undefined)).toBe(false);
    expect(isGapReason(7)).toBe(false);
  });
});
