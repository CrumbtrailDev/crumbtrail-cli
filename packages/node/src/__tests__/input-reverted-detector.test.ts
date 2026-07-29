import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function input(
  t: number,
  trusted: boolean | undefined,
  originalLength: number | undefined,
  options: { name?: string; val?: string } = {},
): BugEvent {
  const d: Record<string, unknown> = {
    el: { tag: "INPUT", name: options.name ?? "coupon", type: "text" },
    ev: "input",
  };
  if (trusted !== undefined) d.trusted = trusted;
  if (originalLength !== undefined)
    d.valSummary = { kind: "input", action: "redacted", reason: "input_value", originalLength };
  if (options.val !== undefined) d.val = options.val;
  return { t, k: "inp", d } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("input_reverted", () => {
  it("names a programmatic write that cleared what the user typed", () => {
    const found = detectors([
      input(1_000, true, 8),
      input(1_500, false, 0),
    ]);
    expect(found).toContain("input_reverted");
  });

  it("says how the value was taken back", () => {
    const candidate = buildEvidenceCandidates(
      [input(1_000, true, 8), input(1_500, false, 0)],
      { start: 0 },
    ).find((entry) => entry.detector === "input_reverted");
    expect(candidate?.severity).toBe("high");
    expect(candidate?.anchor.message).toContain("cleared the field");
    expect(candidate?.anchor.message).toContain("500 ms");
  });

  it("fires when the app shortened the value rather than clearing it", () => {
    const found = detectors([input(1_000, true, 12), input(1_200, false, 4)]);
    expect(found).toContain("input_reverted");
  });

  it("fires when the app replaced the value with a different one of the same length", () => {
    const found = detectors([
      input(1_000, true, 5, { val: "audio" }),
      input(1_200, false, 5, { val: "video" }),
    ]);
    expect(found).toContain("input_reverted");
  });

  it("stays silent when the programmatic write lengthened the value", () => {
    // Autocomplete and formatting both do this, and neither is a revert.
    const found = detectors([input(1_000, true, 3), input(1_200, false, 12)]);
    expect(found).not.toContain("input_reverted");
  });

  it("stays silent outside the ten second window", () => {
    const found = detectors([input(1_000, true, 8), input(12_000, false, 0)]);
    expect(found).not.toContain("input_reverted");
  });

  it("stays silent when the second write was the user's own", () => {
    const found = detectors([input(1_000, true, 8), input(1_500, true, 0)]);
    expect(found).not.toContain("input_reverted");
  });

  it("cannot run without captured provenance", () => {
    const found = detectors([
      input(1_000, undefined, 8),
      input(1_500, undefined, 0),
    ]);
    expect(found).not.toContain("input_reverted");
  });

  it("keeps fields apart", () => {
    const found = detectors([
      input(1_000, true, 8, { name: "coupon" }),
      input(1_500, false, 0, { name: "search" }),
    ]);
    expect(found).not.toContain("input_reverted");
  });

  it("reports one candidate per field however often it is overwritten", () => {
    const candidates = buildEvidenceCandidates(
      [
        input(1_000, true, 8),
        input(1_100, false, 0),
        input(2_000, true, 8),
        input(2_100, false, 0),
      ],
      { start: 0 },
    ).filter((entry) => entry.detector === "input_reverted");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].occurrences).toBe(2);
  });
});
