import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

function state(t: number, name: string, length: number): BugEvent {
  return {
    t,
    k: "inp",
    d: {
      ev: "state",
      trusted: false,
      el: { name },
      val: length === 0 ? "" : "*".repeat(length),
      valSummary: { originalLength: length },
    },
  } as unknown as BugEvent;
}

describe("form_reset_after_error", () => {
  it("flags multiple silent clears after a validation response", () => {
    expect(
      detectors([
        { t: 100, k: "inp", d: { ev: "submit", trusted: true } },
        { t: 120, k: "net.res", d: { requestId: "req-1", st: 400 } },
        state(800, "name", 0),
        state(801, "line1", 0),
        state(802, "city", 0),
      ] as unknown as BugEvent[]),
    ).toContain("form_reset_after_error");
  });

  it("stays silent for a successful submit or one changed control", () => {
    expect(
      detectors([
        { t: 100, k: "inp", d: { ev: "submit", trusted: true } },
        { t: 120, k: "net.res", d: { st: 200 } },
        state(800, "name", 0),
        state(801, "line1", 0),
      ] as unknown as BugEvent[]),
    ).not.toContain("form_reset_after_error");
    expect(
      detectors([
        { t: 100, k: "inp", d: { ev: "submit", trusted: true } },
        { t: 120, k: "net.res", d: { st: 422 } },
        state(800, "postalCode", 0),
      ] as unknown as BugEvent[]),
    ).not.toContain("form_reset_after_error");
  });
});
