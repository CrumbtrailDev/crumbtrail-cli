import { describe, expect, it } from "vitest";
import { assembleBundle } from "../fusion";
import type { Symptom } from "../fusion";
import type { EvidenceItem } from "../evidence";

// Evidence ranking (formerly fusion-rank.ts) exercised through the public
// assembleBundle entry: bundle.evidence is the ranked, complete evidence set.

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

describe("assembleBundle evidence ranking", () => {
  it("ranks an item whose brief contains the symptom url above one that doesn't", () => {
    const symptom: Symptom = { title: "checkout fails", url: "/api/checkout" };
    const urlMatch = item({
      id: "url-match",
      lane: "network",
      brief: "POST /api/checkout returned 500",
    });
    const noMatch = item({
      id: "no-match",
      lane: "network",
      brief: "unrelated env flag toggled",
    });

    const bundle = assembleBundle({
      symptom,
      evidence: [noMatch, urlMatch],
      intent: [],
    });

    expect(bundle.evidence.map((i) => i.id)).toEqual(["url-match", "no-match"]);
  });

  it("ranks higher token overlap above lower overlap when lane and url are equal", () => {
    const symptom: Symptom = {
      title: "checkout total mismatch",
      description: "order total is wrong after checkout",
    };
    const overlap = item({
      id: "overlap",
      lane: "db",
      kind: "db.row-value",
      brief: "order total changed unexpectedly",
    });
    const noOverlap = item({
      id: "no-overlap",
      lane: "db",
      kind: "db.row-value",
      brief: "xyzzy plugh quux",
    });

    const bundle = assembleBundle({
      symptom,
      evidence: [noOverlap, overlap],
      intent: [],
    });

    expect(bundle.evidence.map((i) => i.id)).toEqual(["overlap", "no-overlap"]);
  });

  it("returns the same number of items as input — nothing dropped", () => {
    const symptom: Symptom = { title: "some bug" };
    const items = [
      item({ id: "a", lane: "db" }),
      item({ id: "b", lane: "env" }),
      item({ id: "c", lane: "browser" }),
    ];

    const bundle = assembleBundle({ symptom, evidence: items, intent: [] });

    expect(bundle.evidence.length).toBe(items.length);
    expect(new Set(bundle.evidence.map((i) => i.id))).toEqual(
      new Set(items.map((i) => i.id)),
    );
  });

  it("is deterministic — same input twice gives identical order", () => {
    const symptom: Symptom = { title: "checkout fails", url: "/api/checkout" };
    const items = [
      item({
        id: "a",
        lane: "network",
        brief: "POST /api/checkout returned 500",
      }),
      item({ id: "b", lane: "db", brief: "order total changed" }),
      item({ id: "c", lane: "env", brief: "flag toggled" }),
    ];

    const first = assembleBundle({ symptom, evidence: items, intent: [] });
    const second = assembleBundle({ symptom, evidence: items, intent: [] });

    expect(first.evidence.map((i) => i.id)).toEqual(
      second.evidence.map((i) => i.id),
    );
  });
});
