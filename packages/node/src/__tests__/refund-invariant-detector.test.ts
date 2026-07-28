import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function dbRead(
  t: number,
  requestId: string,
  table: string,
  row: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.read",
    d: { requestId, engine: "postgres", table, row },
  } as unknown as BugEvent;
}

function dbDiff(
  t: number,
  requestId: string,
  table: string,
  op: string,
  pk: Record<string, unknown>,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      requestId,
      engine: "postgres",
      table,
      op,
      pk,
      ...(before ? { before } : {}),
      after,
    },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("refund lifecycle invariants", () => {
  it("flags cumulative issued refunds above the order total", () => {
    const found = detectors([
      dbRead(10, "r1", "orders", { id: 7, total_cents: 10_000 }),
      dbDiff(
        20,
        "r1",
        "refunds",
        "insert",
        { id: 1 },
        undefined,
        { id: 1, order_id: 7, amount_cents: 6_000, status: "issued" },
      ),
      dbDiff(
        30,
        "r2",
        "refunds",
        "insert",
        { id: 2 },
        undefined,
        { id: 2, order_id: 7, amount_cents: 6_000, status: "issued" },
      ),
    ]);
    expect(found).toContain("refund_total_exceeded");
  });

  it("allows cumulative refunds equal to the order total", () => {
    const found = detectors([
      dbRead(10, "r1", "orders", { id: 7, total_cents: 10_000 }),
      dbDiff(
        20,
        "r1",
        "refunds",
        "insert",
        { id: 1 },
        undefined,
        { id: 1, order_id: 7, amount_cents: 4_000, status: "issued" },
      ),
      dbDiff(
        30,
        "r2",
        "refunds",
        "insert",
        { id: 2 },
        undefined,
        { id: 2, order_id: 7, amount_cents: 6_000, status: "issued" },
      ),
    ]);
    expect(found).not.toContain("refund_total_exceeded");
  });

  it("flags a return and refund that both restock the same order item", () => {
    const found = detectors([
      dbRead(10, "return", "order_items", {
        order_id: 7,
        product_id: 3,
        qty: 2,
      }),
      dbDiff(
        20,
        "return",
        "orders",
        "update",
        { id: 7 },
        { id: 7, status: "placed" },
        { id: 7, status: "returned" },
      ),
      dbDiff(
        30,
        "return",
        "products",
        "update",
        { id: 3 },
        { id: 3, inventory: 8 },
        { id: 3, inventory: 10 },
      ),
      dbRead(40, "refund", "order_items", {
        order_id: 7,
        product_id: 3,
        qty: 2,
      }),
      dbDiff(
        50,
        "refund",
        "refunds",
        "insert",
        { id: 1 },
        undefined,
        { id: 1, order_id: 7, amount_cents: 5_000, status: "issued" },
      ),
      dbDiff(
        60,
        "refund",
        "products",
        "update",
        { id: 3 },
        { id: 3, inventory: 10 },
        { id: 3, inventory: 12 },
      ),
    ]);
    expect(found).toContain("duplicate_restock");
  });

  it("does not flag one restock followed by a non-inventory refund", () => {
    const found = detectors([
      dbRead(10, "return", "order_items", {
        order_id: 7,
        product_id: 3,
        qty: 2,
      }),
      dbDiff(
        20,
        "return",
        "orders",
        "update",
        { id: 7 },
        { id: 7, status: "placed" },
        { id: 7, status: "returned" },
      ),
      dbDiff(
        30,
        "return",
        "products",
        "update",
        { id: 3 },
        { id: 3, inventory: 8 },
        { id: 3, inventory: 10 },
      ),
      dbDiff(
        50,
        "refund",
        "refunds",
        "insert",
        { id: 1 },
        undefined,
        { id: 1, order_id: 7, amount_cents: 5_000, status: "issued" },
      ),
    ]);
    expect(found).not.toContain("duplicate_restock");
  });
});
