import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("declined_payment_ordered", () => {
  it("flags an order inserted after an explicit gateway decline", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "backend.http",
          d: {
            service: "payments",
            chargeStatus: "declined",
            failureCode: "card_declined",
          },
        },
        {
          t: 120,
          k: "db.diff",
          d: {
            engine: "postgres",
            op: "insert",
            table: "orders",
            requestId: "req-checkout",
            after: { id: 1 },
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("declined_payment_ordered");
  });

  it("stays silent for an approved charge or no order write", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "backend.http",
          d: { service: "payments", chargeStatus: "approved" },
        },
        {
          t: 120,
          k: "db.diff",
          d: { op: "insert", table: "orders" },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("declined_payment_ordered");
    expect(
      detectors([
        {
          t: 100,
          k: "backend.http",
          d: { service: "payments", chargeStatus: "declined" },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("declined_payment_ordered");
  });
});
