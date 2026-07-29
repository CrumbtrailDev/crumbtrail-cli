import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// Two fulfillment-job invariants from live sessions:
// - duplicate_readback: a non-idempotent retry inserted a second shipments row
//   for order 1. The INSERT after images were captured thin ({id} only), so
//   duplicate_write had nothing to compare — but the read-back rows carry the
//   full picture: different pks, identical business columns.
// - orphaned_reference: dependent writes reordered, so inventory_ledger was
//   committed with shipment_id = null and the shipments row appeared later.

function insert(
  t: number,
  table: string,
  after: Record<string, unknown>,
  requestId = "req-job",
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op: "insert", table, pk: { id: after.id ?? 1 }, after, requestId },
  } as unknown as BugEvent;
}

function read(
  t: number,
  table: string,
  row: Record<string, unknown>,
  requestId = "req-read",
): BugEvent {
  return {
    t,
    k: "db.read",
    d: { engine: "postgres", table, pk: { id: row.id }, row, requestId, stmt: 1 },
  } as unknown as BugEvent;
}

function of(events: BugEvent[], detector: string) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (c) => c.detector === detector,
  );
}

describe("buildEvidenceCandidates — duplicate_readback", () => {
  it("fires on two rows identical on every business column", () => {
    const events = [
      read(1000, "shipments", { id: 1, order_id: 1, status: "created", created_at: "A" }),
      read(1010, "shipments", { id: 2, order_id: 1, status: "created", created_at: "B" }),
    ];
    const hits = of(events, "duplicate_readback");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe(
      "Duplicate rows: 2 shipments rows identical on every business column",
    );
    expect(String(hits[0].anchor.message)).toContain("order_id");
  });

  it("stays silent when any business column differs", () => {
    const events = [
      read(1000, "order_items", { id: 1, order_id: 1, product_id: 1, qty: 1 }),
      read(1010, "order_items", { id: 2, order_id: 1, product_id: 2, qty: 1 }),
    ];
    expect(of(events, "duplicate_readback")).toHaveLength(0);
  });

  it("dedupes re-reads of the same physical row", () => {
    const row = { id: 1, order_id: 1, status: "created" };
    const events = [read(1000, "shipments", row), read(2000, "shipments", row)];
    expect(of(events, "duplicate_readback")).toHaveLength(0);
  });

  it("demands an entity anchor, exactly like duplicate_write", () => {
    // Two rows agreeing only on state columns are not one duplicated event.
    const events = [
      read(1000, "jobs", { id: 1, status: "pending", type: "fulfillment" }),
      read(1010, "jobs", { id: 2, status: "pending", type: "fulfillment" }),
    ];
    expect(of(events, "duplicate_readback")).toHaveLength(0);
  });
});

describe("buildEvidenceCandidates — orphaned_reference", () => {
  it("fires when a null reference's parent is inserted afterwards", () => {
    const events = [
      insert(1000, "inventory_ledger", {
        id: 1,
        product_id: 1,
        order_id: 1,
        shipment_id: null,
        delta: -1,
      }),
      insert(1050, "shipments", { id: 1 }),
    ];
    const hits = of(events, "orphaned_reference");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe(
      "Orphaned reference: inventory_ledger.shipment_id written null before shipments existed",
    );
    expect(String(hits[0].anchor.message)).toContain("50 ms AFTER");
  });

  it("stays silent when the parent was created first", () => {
    const events = [
      insert(1000, "shipments", { id: 1 }),
      insert(1050, "inventory_ledger", { id: 1, shipment_id: null, delta: -1 }),
    ];
    expect(of(events, "orphaned_reference")).toHaveLength(0);
  });

  it("stays silent when the reference is populated", () => {
    const events = [
      insert(1000, "inventory_ledger", { id: 1, shipment_id: 2, delta: -1 }),
      insert(1050, "shipments", { id: 3 }),
    ];
    expect(of(events, "orphaned_reference")).toHaveLength(0);
  });

  it("stays silent when no parent table ever gets an insert", () => {
    // A nullable ref that stays null with no parent created is a data-model
    // choice, not an ordering bug.
    const events = [
      insert(1000, "notifications", { id: 1, order_id: null, subject: "hi" }),
    ];
    expect(of(events, "orphaned_reference")).toHaveLength(0);
  });
});
