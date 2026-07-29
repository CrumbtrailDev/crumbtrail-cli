import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

function diff(
  t: number,
  requestId: string,
  op: string,
  table: string,
  id: number,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      engine: "postgres",
      requestId,
      op,
      table,
      pk: { id },
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    },
  } as unknown as BugEvent;
}

describe("relational write integrity", () => {
  it("flags existing child rows moved to a parent inserted by the same request", () => {
    expect(
      detectors([
        diff(100, "duplicate-1", "insert", "orders", 3, undefined, {
          id: 3,
          status: "placed",
        }),
        diff(
          110,
          "duplicate-1",
          "update",
          "order_items",
          1,
          { id: 1, order_id: 1, product_id: 7 },
          { id: 1, order_id: 3, product_id: 7 },
        ),
      ]),
    ).toContain("existing_children_reparented_to_new_row");
  });

  it("does not flag a duplicate operation that inserts replacement children", () => {
    expect(
      detectors([
        diff(100, "duplicate-1", "insert", "orders", 3, undefined, {
          id: 3,
        }),
        diff(110, "duplicate-1", "insert", "order_items", 5, undefined, {
          id: 5,
          order_id: 3,
        }),
      ]),
    ).not.toContain("existing_children_reparented_to_new_row");
  });

  it("flags a correlated update whose primary key contradicts the requested row", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "net.req",
          d: {
            requestId: "edit-1",
            method: "POST",
            url: "/api/ops/order-line",
            body: JSON.stringify({
              orderId: 1,
              itemId: 2,
              index: 0,
              qty: 5,
            }),
          },
        },
        diff(
          110,
          "edit-1",
          "update",
          "order_items",
          1,
          { id: 1, order_id: 1, qty: 2 },
          { id: 1, order_id: 1, qty: 5 },
        ),
        {
          t: 120,
          k: "net.res",
          d: { requestId: "edit-1", st: 200 },
        },
      ] as unknown as BugEvent[]),
    ).toContain("request_target_row_mismatch");
  });

  it("stays silent when the requested row and written primary key agree", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "net.req",
          d: {
            requestId: "edit-1",
            method: "POST",
            url: "/api/ops/order-line",
            body: JSON.stringify({ itemId: 2, qty: 5 }),
          },
        },
        diff(
          110,
          "edit-1",
          "update",
          "order_items",
          2,
          { id: 2, qty: 2 },
          { id: 2, qty: 5 },
        ),
        {
          t: 120,
          k: "net.res",
          d: { requestId: "edit-1", st: 200 },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("request_target_row_mismatch");
  });

  it("flags a later request that writes an exact prior field value back", () => {
    expect(
      detectors([
        diff(
          100,
          "stock-1",
          "update",
          "products",
          7,
          { id: 7, inventory: 1 },
          { id: 7, inventory: 11 },
        ),
        diff(
          200,
          "form-1",
          "update",
          "products",
          7,
          { id: 7, inventory: 11 },
          { id: 7, inventory: 1 },
        ),
      ]),
    ).toContain("stale_value_writeback");
  });

  it("does not call a continuing change or same-request correction stale", () => {
    expect(
      detectors([
        diff(
          100,
          "stock-1",
          "update",
          "products",
          7,
          { id: 7, inventory: 1 },
          { id: 7, inventory: 11 },
        ),
        diff(
          200,
          "stock-2",
          "update",
          "products",
          7,
          { id: 7, inventory: 11 },
          { id: 7, inventory: 12 },
        ),
      ]),
    ).not.toContain("stale_value_writeback");
    expect(
      detectors([
        diff(
          100,
          "stock-1",
          "update",
          "products",
          7,
          { id: 7, inventory: 1 },
          { id: 7, inventory: 11 },
        ),
        diff(
          200,
          "stock-1",
          "update",
          "products",
          7,
          { id: 7, inventory: 11 },
          { id: 7, inventory: 1 },
        ),
      ]),
    ).not.toContain("stale_value_writeback");
  });

  it("flags a batch applied count larger than its correlated staging rows", () => {
    expect(
      detectors([
        diff(100, "batch-1", "insert", "reprice_stage", 1, undefined, {
          id: 1,
          batch_id: 4,
          product_id: 8,
        }),
        diff(
          200,
          "batch-1",
          "update",
          "reprice_batches",
          4,
          { id: 4, rows_applied: 0 },
          { id: 4, rows_applied: 2 },
        ),
      ]),
    ).toContain("batch_applied_count_exceeds_staged_rows");
  });

  it("accepts a batch count equal to the number of staging rows", () => {
    expect(
      detectors([
        diff(100, "batch-1", "insert", "reprice_stage", 1, undefined, {
          id: 1,
          batch_id: 4,
        }),
        diff(
          200,
          "batch-1",
          "update",
          "reprice_batches",
          4,
          { id: 4, rows_applied: 0 },
          { id: 4, rows_applied: 1 },
        ),
      ]),
    ).not.toContain("batch_applied_count_exceeds_staged_rows");
  });

  it("flags repeated entity mutations with only an unrelated batch audit", () => {
    expect(
      detectors([
        diff(
          100,
          "bulk-1",
          "update",
          "products",
          7,
          { id: 7, price_cents: 7900 },
          { id: 7, price_cents: 8100 },
        ),
        diff(
          110,
          "bulk-1",
          "update",
          "products",
          6,
          { id: 6, price_cents: 5900 },
          { id: 6, price_cents: 6100 },
        ),
        diff(120, "bulk-1", "insert", "audit_log", 1, undefined, {
          id: 1,
          entity: "reprice_batches",
          entity_id: 1,
          action: "completed",
        }),
      ]),
    ).toContain("mutations_missing_entity_audit");
  });

  it("accepts repeated mutations with a matching entity audit", () => {
    expect(
      detectors([
        diff(
          100,
          "bulk-1",
          "update",
          "products",
          7,
          { id: 7, price_cents: 7900 },
          { id: 7, price_cents: 8100 },
        ),
        diff(
          110,
          "bulk-1",
          "update",
          "products",
          6,
          { id: 6, price_cents: 5900 },
          { id: 6, price_cents: 6100 },
        ),
        diff(120, "bulk-1", "insert", "audit_log", 1, undefined, {
          id: 1,
          entity: "products",
          entity_id: 7,
          action: "price-change",
        }),
      ]),
    ).not.toContain("mutations_missing_entity_audit");
  });

  it("flags a report total that contradicts its referenced source row", () => {
    expect(
      detectors([
        diff(
          100,
          "refund-1",
          "update",
          "orders",
          1,
          { id: 1, total_cents: 35_700 },
          { id: 1, total_cents: 35_200 },
        ),
        diff(200, "report-1", "insert", "ops_reports", 1, undefined, {
          id: 1,
          kind: "order-totals",
          total_cents: 35_700,
          note: "order=1",
        }),
      ]),
    ).toContain("report_total_contradicts_source_row");
  });

  it("accepts a report total that matches its referenced source row", () => {
    expect(
      detectors([
        diff(
          100,
          "refund-1",
          "update",
          "orders",
          1,
          { id: 1, total_cents: 35_700 },
          { id: 1, total_cents: 35_200 },
        ),
        diff(200, "report-1", "insert", "ops_reports", 1, undefined, {
          id: 1,
          kind: "order-totals",
          total_cents: 35_200,
          note: "order=1",
        }),
      ]),
    ).not.toContain("report_total_contradicts_source_row");
  });
});
