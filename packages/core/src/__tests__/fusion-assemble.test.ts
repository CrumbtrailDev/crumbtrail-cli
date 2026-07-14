import { describe, expect, it } from "vitest";
import { assembleBundle } from "../fusion";
import type { Symptom } from "../fusion";
import type { EvidenceItem, IntentSignal } from "../evidence";

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

describe("assembleBundle", () => {
  it("keeps evidence complete and ranked, with advisory opinion for a divergent input", () => {
    const symptom: Symptom = { title: "checkout fails", url: "/api/checkout" };
    const evidence = [
      item({ id: "unrelated", lane: "env", brief: "unrelated flag toggle" }),
      item({
        id: "net-1",
        lane: "network",
        kind: "net.status",
        brief: "POST /api/checkout returned 500",
      }),
    ];
    const intent: IntentSignal[] = [];

    const bundle = assembleBundle({ symptom, evidence, intent });

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(bundle.symptom).toEqual(symptom);
    expect(bundle.evidence.length).toBe(evidence.length);
    expect(bundle.evidence.map((e) => e.id)).toEqual(["net-1", "unrelated"]);
    expect(bundle.opinion.stance).toBe("advisory");
    expect(bundle.opinion.hypotheses.length).toBeGreaterThan(0);
    expect(bundle.gaps).toEqual([]);
  });

  it("yields a single inconclusive hypothesis and empty evidence for all-empty input", () => {
    const symptom: Symptom = { title: "" };

    const bundle = assembleBundle({ symptom, evidence: [], intent: [] });

    expect(bundle.evidence).toEqual([]);
    expect(bundle.opinion.hypotheses).toHaveLength(1);
    expect(bundle.opinion.hypotheses[0].kind).toBe("inconclusive");
  });

  it("passes through provided gaps", () => {
    const symptom: Symptom = { title: "checkout fails" };
    const gaps = [
      { lane: "network" as const, reason: "no recorded sessions compared" },
    ];

    const bundle = assembleBundle({ symptom, evidence: [], intent: [], gaps });

    expect(bundle.gaps).toEqual(gaps);
  });

  it("surfaces one capture directive raising all informative lanes for all-empty input with a gap", () => {
    const symptom: Symptom = { title: "checkout fails" };
    const gaps = [
      { lane: "network" as const, reason: "no recorded sessions compared" },
    ];

    const bundle = assembleBundle({ symptom, evidence: [], intent: [], gaps });

    expect(bundle.directives).toHaveLength(1);
    expect(bundle.directives[0].raise).toEqual([
      "network",
      "db",
      "browser",
      "flow",
    ]);
    expect(bundle.directives[0].scope).toBe("signature");
  });

  it("yields no capture directives when evidence covers all informative lanes with no gaps", () => {
    const symptom: Symptom = { title: "checkout fails" };
    const evidence = [
      item({ id: "e1", lane: "network" }),
      item({ id: "e2", lane: "db" }),
      item({ id: "e3", lane: "browser" }),
      item({ id: "e4", lane: "flow" }),
    ];

    const bundle = assembleBundle({ symptom, evidence, intent: [] });

    expect(bundle.directives).toEqual([]);
  });
});
