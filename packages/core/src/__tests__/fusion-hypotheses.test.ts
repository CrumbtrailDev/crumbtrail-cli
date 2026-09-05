import { describe, expect, it } from "vitest";
import { assembleBundle } from "../fusion";
import type { Hypothesis, Symptom } from "../fusion";
import type { EvidenceItem, IntentSignal } from "../evidence";

// Hypothesis classification (formerly fusion-hypotheses.ts) exercised through
// the public assembleBundle entry: bundle.opinion.hypotheses.

function item(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
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

function classify(
  symptom: Symptom,
  evidence: EvidenceItem[],
  intent: IntentSignal[],
): Hypothesis[] {
  return assembleBundle({ symptom, evidence, intent }).opinion.hypotheses;
}

const symptom: Symptom = { title: "checkout total is wrong" };

describe("assembleBundle hypothesis classification", () => {
  it("emits regression as the top hypothesis for unexplained network/db divergences", () => {
    const evidence = [
      item({
        id: "net-1",
        lane: "network",
        kind: "net.status",
        before: 200,
        after: 500,
      }),
      item({
        id: "db-1",
        lane: "db",
        kind: "db.row-value",
        before: 4,
        after: 3,
      }),
    ];

    const hypotheses = classify(symptom, evidence, []);

    expect(hypotheses[0].kind).toBe("regression");
    expect(hypotheses[0].confidence).toBeGreaterThan(0.5);
    expect(hypotheses[0].evidenceIds.sort()).toEqual(["db-1", "net-1"]);
  });

  it("splits explained evidence into intentional-change, leaving it out of regression", () => {
    const explained = item({
      id: "net-explained",
      lane: "network",
      kind: "net.status",
      before: 200,
      after: 500,
    });
    const unexplained = item({
      id: "net-unexplained",
      lane: "network",
      kind: "net.status",
      before: 200,
      after: 503,
    });
    const intent: IntentSignal[] = [
      {
        evidenceId: "net-explained",
        explainedByCommit: { sha: "abc123", message: "widen timeout" },
      },
    ];

    const hypotheses = classify(symptom, [explained, unexplained], intent);

    const intentional = hypotheses.find((h) => h.kind === "intentional-change");
    const regression = hypotheses.find((h) => h.kind === "regression");

    expect(intentional).toBeDefined();
    expect(intentional!.evidenceIds).toEqual(["net-explained"]);
    expect(intentional!.rationale).toContain("abc123");

    expect(regression).toBeDefined();
    expect(regression!.evidenceIds).toEqual(["net-unexplained"]);
    expect(regression!.evidenceIds).not.toContain("net-explained");
  });

  it("ignores dangling IntentSignals whose evidenceId is not in the evidence set", () => {
    const evidence = [
      item({ id: "net-1", lane: "network", kind: "net.status" }),
    ];
    const intent: IntentSignal[] = [
      {
        evidenceId: "net-1",
        explainedByCommit: { sha: "abc123", message: "widen timeout" },
      },
      {
        evidenceId: "not-in-evidence",
        explainedByCommit: { sha: "def456", message: "unrelated commit" },
      },
    ];

    const hypotheses = classify(symptom, evidence, intent);

    const intentional = hypotheses.filter(
      (h) => h.kind === "intentional-change",
    );
    expect(intentional).toHaveLength(1);
    expect(intentional[0].evidenceIds).toEqual(["net-1"]);
    for (const h of hypotheses) {
      expect(h.evidenceIds).not.toContain("not-in-evidence");
    }
  });

  it("classifies comparative env-lane-only evidence as environment", () => {
    const evidence = [
      item({
        id: "env-1",
        lane: "env",
        kind: "env.diff",
        before: "staging",
        after: "production",
      }),
    ];

    const hypotheses = classify(symptom, evidence, []);

    expect(hypotheses[0].kind).toBe("environment");
    expect(hypotheses[0].evidenceIds).toEqual(["env-1"]);
  });

  it("does not call current-only evidence a regression", () => {
    const evidence = Array.from({ length: 7 }, (_, index) =>
      item({
        id: `current-${index}`,
        lane: index < 3 ? "flow" : index < 6 ? "network" : "browser",
        kind:
          index < 3
            ? "cache.activity"
            : index < 6
              ? "mcp.error"
              : "console.warning",
        before: null,
        after:
          index < 3
            ? "hit"
            : index < 6
              ? "invalid arguments"
              : "SDK close returned 500",
      }),
    );

    const hypotheses = classify(symptom, evidence, []);

    expect(hypotheses).toEqual([
      expect.objectContaining({ kind: "inconclusive", evidenceIds: [] }),
    ]);
  });

  it("does not compare unsupported values by type mismatch", () => {
    const hypotheses = classify(
      symptom,
      [item({ lane: "network", before: () => "old", after: "new" })],
      [],
    );

    expect(
      hypotheses.some((hypothesis) => hypothesis.kind === "regression"),
    ).toBe(false);
  });

  it("does not call equal before and after values a regression", () => {
    const hypotheses = classify(
      symptom,
      [
        item({
          lane: "db",
          before: { total: 4, page: 1 },
          after: { page: 1, total: 4 },
        }),
      ],
      [],
    );

    expect(
      hypotheses.some((hypothesis) => hypothesis.kind === "regression"),
    ).toBe(false);
  });

  it("does not infer environment or client fault from current-only evidence", () => {
    const hypotheses = classify(
      symptom,
      [
        item({ lane: "env", before: null, after: "production" }),
        item({ lane: "browser", before: null, after: "SDK warning" }),
      ],
      [],
    );

    expect(hypotheses).toEqual([
      expect.objectContaining({ kind: "inconclusive", evidenceIds: [] }),
    ]);
  });

  it("classifies comparative browser-lane-only evidence as client-side", () => {
    const evidence = [
      item({
        id: "browser-1",
        lane: "browser",
        kind: "browser.diff",
        before: "ready",
        after: "crashed",
      }),
    ];

    const hypotheses = classify(symptom, evidence, []);

    expect(hypotheses[0].kind).toBe("client-side");
    expect(hypotheses[0].evidenceIds).toEqual(["browser-1"]);
  });

  it("stays inconclusive for empty evidence with a non-empty symptom", () => {
    const hypotheses = classify(symptom, [], []);

    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0].kind).toBe("inconclusive");
    expect(hypotheses[0].evidenceIds).toEqual([]);
  });

  it("sorts the resulting array by confidence descending", () => {
    const evidence = [
      item({ id: "net-1", lane: "network", kind: "net.status" }),
      item({ id: "db-1", lane: "db", kind: "db.row-value" }),
      item({ id: "env-1", lane: "env", kind: "env.diff" }),
      item({ id: "browser-1", lane: "browser", kind: "browser.diff" }),
    ];

    const hypotheses = classify(symptom, evidence, []);

    const confidences = hypotheses.map((h) => h.confidence);
    const sorted = [...confidences].sort((a, b) => b - a);
    expect(confidences).toEqual(sorted);
  });
});
