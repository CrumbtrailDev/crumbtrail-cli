import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

function order(
  requestId: string,
  totalCents: number,
): BugEvent {
  return {
    t: 200,
    k: "db.diff",
    d: {
      engine: "postgres",
      requestId,
      op: "insert",
      table: "orders",
      pk: { id: 1 },
      after: { id: 1, total_cents: totalCents },
    },
  } as unknown as BugEvent;
}

describe("checkout correctness", () => {
  it("flags an order total that contradicts correlated authoritative pricing", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "backend.http",
          d: {
            requestId: "checkout-1",
            service: "pricing",
            status: 200,
            totalCents: 21_542,
          },
        },
        order("checkout-1", 23_319),
      ] as unknown as BugEvent[]),
    ).toContain("pricing_total_ignored_by_checkout");
  });

  it("accepts an order total that matches pricing", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "backend.http",
          d: {
            requestId: "checkout-1",
            service: "pricing",
            status: 200,
            totalCents: 21_542,
          },
        },
        order("checkout-1", 21_542),
      ] as unknown as BugEvent[]),
    ).not.toContain("pricing_total_ignored_by_checkout");
  });

  it("flags an order committed after its pricing request timed out", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "backend.http",
          d: {
            requestId: "checkout-1",
            service: "pricing",
            status: 0,
            errorKind: "timeout",
            error: "timed out after 250ms",
          },
        },
        order("checkout-1", 23_319),
      ] as unknown as BugEvent[]),
    ).toContain("checkout_committed_after_pricing_timeout");
  });

  it("does not call a failed checkout a fallback commit", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "backend.http",
          d: {
            requestId: "checkout-1",
            service: "pricing",
            status: 0,
            errorKind: "timeout",
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("checkout_committed_after_pricing_timeout");
  });

  it("flags an order inserted in the request that made inventory negative", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "db.diff",
          d: {
            engine: "postgres",
            requestId: "checkout-1",
            op: "update",
            table: "products",
            pk: { id: 7 },
            before: { id: 7, inventory: 0 },
            after: { id: 7, inventory: -1 },
          },
        },
        order("checkout-1", 9_258),
      ] as unknown as BugEvent[]),
    ).toContain("order_committed_with_negative_inventory");
  });

  it("accepts a checkout that leaves inventory non-negative", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "db.diff",
          d: {
            engine: "postgres",
            requestId: "checkout-1",
            op: "update",
            table: "products",
            pk: { id: 7 },
            before: { id: 7, inventory: 1 },
            after: { id: 7, inventory: 0 },
          },
        },
        order("checkout-1", 9_258),
      ] as unknown as BugEvent[]),
    ).not.toContain("order_committed_with_negative_inventory");
  });
});
