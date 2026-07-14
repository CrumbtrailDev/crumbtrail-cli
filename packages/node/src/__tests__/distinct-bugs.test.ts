import { describe, it, expect } from "vitest";
import { buildDistinctBugSignature, groupDistinctBugs } from "../distinct-bugs";
import type { EvidenceCandidate } from "../evidence-index";

function candidate(
  overrides: Partial<EvidenceCandidate> &
    Pick<EvidenceCandidate, "id" | "detector" | "anchor">,
): EvidenceCandidate {
  return {
    schemaVersion: 1,
    title: `${overrides.detector} candidate`,
    severity: "medium",
    score: 50,
    confidence: "high",
    evidenceWindow: {
      start: overrides.anchor.t - 15,
      end: overrides.anchor.t + 45,
      windowId: "win_0001",
    },
    ...overrides,
  } as EvidenceCandidate;
}

// Two distinct failures + a duplicate of one:
//  - Bug A: a front-end HTTP 500 correlated (same requestId) to a back-end OTel span error.
//  - Bug B: a console error, plus a second identical console error shortly after (the duplicate).
const FIXTURE: EvidenceCandidate[] = [
  candidate({
    id: "cand_0001",
    detector: "http_error",
    title: "HTTP 500 from POST /api/pay",
    severity: "high",
    score: 90,
    anchor: {
      t: 1000,
      offsetMs: 0,
      route: "/checkout",
      requestId: "req-A",
      method: "POST",
      url: "/api/pay",
      status: 500,
      message: "HTTP 500",
    },
    evidenceWindow: { start: 985, end: 1045, windowId: "win_0001" },
  }),
  candidate({
    id: "cand_0002",
    detector: "otel_span_error",
    title: "OTel span error (HTTP 500): POST /api/pay [api]",
    severity: "high",
    score: 88,
    anchor: {
      t: 1010,
      offsetMs: 10,
      route: "/checkout",
      requestId: "req-A",
      status: 500,
      message: "upstream failed",
      source: "api",
    },
    evidenceWindow: { start: 995, end: 1055, windowId: "win_0001" },
  }),
  candidate({
    id: "cand_0003",
    detector: "console_error",
    title: "Console error: Cannot read properties of undefined",
    severity: "medium",
    score: 58,
    anchor: {
      t: 2000,
      offsetMs: 1000,
      message: "Cannot read properties of undefined",
    },
    evidenceWindow: { start: 1985, end: 2045, windowId: "win_0002" },
  }),
  candidate({
    id: "cand_0004",
    detector: "console_error",
    title: "Console error: Cannot read properties of undefined",
    severity: "medium",
    score: 58,
    anchor: {
      t: 2200,
      offsetMs: 1200,
      message: "Cannot read properties of undefined",
    },
    evidenceWindow: { start: 2185, end: 2245, windowId: "win_0002" },
  }),
];

describe("groupDistinctBugs", () => {
  it("groups two distinct failures and dedups a repeat into exactly two stable bugs", () => {
    const bugs = groupDistinctBugs(FIXTURE);

    expect(bugs).toHaveLength(2);

    // Deterministic ordering: severity desc (high before medium), then firstSeen, then bugId.
    const [bugA, bugB] = bugs;

    // Stable, deterministic ids locked to detect any drift in the dedup-key derivation.
    expect(bugA.bugId).toBe("bug_1xcohsf");
    expect(bugB.bugId).toBe("bug_1pg6ltd");

    // Bug A: correlated front-end + back-end share one requestId, so front/back land together.
    expect(bugA.severity).toBe("high");
    expect(bugA.requestIds).toEqual(["req-A"]);
    expect(bugA.firstSeen).toBe(1000);
    expect(bugA.lastSeen).toBe(1010);
    expect(bugA.window).toEqual({ start: 985, end: 1055 });
    expect(bugA.candidateIds).toEqual(["cand_0001", "cand_0002"]);
    expect(bugA.frontendEvidence.map((ref) => ref.candidateId)).toEqual([
      "cand_0001",
    ]);
    expect(bugA.backendEvidence.map((ref) => ref.candidateId)).toEqual([
      "cand_0002",
    ]);
    expect(bugA.representative).toMatchObject({
      detector: "http_error",
      requestId: "req-A",
      method: "POST",
      status: 500,
    });
    expect(bugA.frontendEvidence[0]).toMatchObject({
      method: "POST",
      status: 500,
    });

    // Bug B: the duplicate console error collapsed into the same bug.
    expect(bugB.severity).toBe("medium");
    expect(bugB.requestIds).toEqual([]);
    expect(bugB.candidateIds).toEqual(["cand_0003", "cand_0004"]);
    expect(bugB.frontendEvidence).toHaveLength(2);
    expect(bugB.backendEvidence).toHaveLength(0);
    expect(bugB).not.toHaveProperty("dbDiffs");
  });

  it("is deterministic regardless of input order", () => {
    const forward = groupDistinctBugs(FIXTURE);
    const reversed = groupDistinctBugs([...FIXTURE].reverse());
    expect(reversed).toEqual(forward);
  });

  it("returns an empty list for no candidates", () => {
    expect(groupDistinctBugs([])).toEqual([]);
  });

  it("carries target descriptors into distinct bug evidence and signatures", () => {
    const bugs = groupDistinctBugs([
      candidate({
        id: "cand_target_a",
        detector: "repeated_clicks",
        title: "Repeated clicks on Submit order",
        anchor: {
          t: 1000,
          message: "3 clicks within 3s",
          target: {
            role: "button",
            label: "Submit order",
            testID: "submit-order",
            accessibilityId: "checkout.submit",
            componentName: "Pressable",
            routePath: "/checkout",
            ancestryHash: "rn:checkout:footer:primary",
          },
        },
      }),
      candidate({
        id: "cand_target_b",
        detector: "repeated_clicks",
        title: "Repeated clicks on Submit order",
        anchor: {
          t: 1200,
          message: "3 clicks within 3s",
          target: {
            role: "button",
            label: "Cancel order",
            testID: "cancel-order",
            accessibilityId: "checkout.cancel",
            componentName: "Pressable",
            routePath: "/checkout",
            ancestryHash: "rn:checkout:footer:secondary",
          },
        },
      }),
    ]);

    expect(bugs).toHaveLength(2);
    expect(bugs.map((bug) => bug.representative.target?.testID).sort()).toEqual(
      ["cancel-order", "submit-order"],
    );
    expect(
      bugs.flatMap((bug) =>
        bug.frontendEvidence.map((ref) => ref.target?.routePath),
      ),
    ).toEqual(["/checkout", "/checkout"]);
    expect(
      bugs.flatMap((bug) =>
        bug.frontendEvidence.map((ref) => ref.target?.componentName),
      ),
    ).toEqual(["Pressable", "Pressable"]);
  });
});

describe("buildDistinctBugSignature", () => {
  it("normalizes long row IDs across sessions but keeps small semantic numbers distinct", () => {
    const invoiceA = groupDistinctBugs([
      candidate({
        id: "cand_invoice_a",
        detector: "db_mutation",
        title: "Wrong invoice rank",
        anchor: {
          t: 1000,
          message: "Invoice 123 ranked 3 instead of 1",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const invoiceB = groupDistinctBugs([
      candidate({
        id: "cand_invoice_b",
        detector: "db_mutation",
        title: "Wrong invoice rank",
        anchor: {
          t: 1000,
          message: "Invoice 456 ranked 3 instead of 1",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const thresholdA = groupDistinctBugs([
      candidate({
        id: "cand_threshold_a",
        detector: "db_mutation",
        title: "Wrong approval threshold",
        anchor: {
          t: 1000,
          message: "Expected 2 approvals but got 3",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const thresholdB = groupDistinctBugs([
      candidate({
        id: "cand_threshold_b",
        detector: "db_mutation",
        title: "Wrong approval threshold",
        anchor: {
          t: 1000,
          message: "Expected 7 approvals but got 8",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];

    expect(buildDistinctBugSignature(invoiceA)).toBe(
      buildDistinctBugSignature(invoiceB),
    );
    expect(buildDistinctBugSignature(thresholdA)).not.toBe(
      buildDistinctBugSignature(thresholdB),
    );
  });
});
