import { describe, expect, it } from "vitest";
import { assembleBundle } from "../fusion";
import type { CaptureDirective, EvidenceGap, Symptom } from "../fusion";
import type { EvidenceItem } from "../evidence";

// Capture directives (formerly capture-directive.ts) exercised through the
// public assembleBundle entry: bundle.directives.

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

function gap(overrides: Partial<EvidenceGap> = {}): EvidenceGap {
  return {
    lane: "network",
    reason: "no recorded sessions compared",
    ...overrides,
  };
}

function directivesFor(
  symptom: Symptom,
  evidence: EvidenceItem[],
  gaps?: EvidenceGap[],
): CaptureDirective[] {
  return assembleBundle({ symptom, evidence, intent: [], gaps }).directives;
}

describe("assembleBundle capture directives", () => {
  it("returns one directive raising all informative lanes for empty evidence + a gap", () => {
    const symptom: Symptom = { title: "Checkout Fails Hard!" };
    const directives = directivesFor(symptom, [], [gap()]);

    expect(directives).toHaveLength(1);
    expect(directives[0].raise).toEqual(["network", "db", "browser", "flow"]);
    expect(directives[0].scope).toBe("signature");
    expect(directives[0].signature).toBe("checkout-fails-hard");
  });

  it("uses errorSig as the signature when present", () => {
    const symptom: Symptom = {
      title: "checkout fails",
      errorSig: "ERR_CHECKOUT_500",
    };
    const directives = directivesFor(symptom, [], [gap()]);

    expect(directives[0].signature).toBe("ERR_CHECKOUT_500");
  });

  it("returns [] when evidence covers all informative lanes", () => {
    const symptom: Symptom = { title: "checkout fails" };
    const evidence = [
      item({ id: "e1", lane: "network" }),
      item({ id: "e2", lane: "db" }),
      item({ id: "e3", lane: "browser" }),
      item({ id: "e4", lane: "flow" }),
    ];

    const directives = directivesFor(symptom, evidence, [gap()]);

    expect(directives).toEqual([]);
  });

  it("returns [] when evidence is present and there are no gaps (not thin)", () => {
    const symptom: Symptom = { title: "checkout fails" };
    const evidence = [item({ id: "e1", lane: "network" })];

    const directives = directivesFor(symptom, evidence);

    expect(directives).toEqual([]);
  });

  it("raises only the missing lanes when partial evidence + a gap", () => {
    const symptom: Symptom = { title: "checkout fails" };
    const evidence = [item({ id: "e1", lane: "network" })];

    const directives = directivesFor(symptom, evidence, [gap()]);

    expect(directives).toHaveLength(1);
    expect(directives[0].raise).toEqual(["db", "browser", "flow"]);
  });

  it("is deterministic across repeated calls with the same inputs", () => {
    const symptom: Symptom = { title: "checkout fails" };
    const evidence: EvidenceItem[] = [];
    const gaps = [gap()];

    const first = directivesFor(symptom, evidence, gaps);
    const second = directivesFor(symptom, evidence, gaps);

    expect(first).toEqual(second);
  });

  it("falls back to 'unknown' signature when title and errorSig are both empty", () => {
    const symptom: Symptom = { title: "" };
    const directives = directivesFor(symptom, [], [gap()]);

    expect(directives[0].signature).toBe("unknown");
  });
});
