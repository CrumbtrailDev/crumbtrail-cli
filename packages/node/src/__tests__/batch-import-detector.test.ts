import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { jsonResponse } from "./fixtures/net-res";

const ENDPOINT = "/api/admin/import/prices";

function csvRequest(t: number, requestId: string, body: string): BugEvent {
  return {
    t,
    k: "net.req",
    d: { requestId, method: "POST", url: ENDPOINT, body },
  } as unknown as BugEvent;
}

function update(
  t: number,
  requestId: string,
  id: number,
  slug: string,
  before: number,
  after: number,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      requestId,
      engine: "postgres",
      op: "update",
      table: "products",
      pk: { id },
      before: { id, slug, price_cents: before },
      after: { id, slug, price_cents: after },
    },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("correlated batch import detectors", () => {
  it("flags a success response that claims more applied rows than it describes", () => {
    const csv =
      "sku,price_cents\nalpha,10100\nbeta,10200\ngamma,10300\ndelta,10400";
    const found = detectors([
      csvRequest(100, "r1", csv),
      jsonResponse(120, "r1", {
        total: 4,
        applied: 4,
        errors: [],
        rows: [],
      }),
    ]);
    expect(found).toContain("acknowledged_batch_rows_missing");
  });

  it("does not call an explicitly failed row missing", () => {
    const csv = "sku,price_cents\nalpha,10100\nbeta,not-a-number";
    const found = detectors([
      csvRequest(100, "r1", csv),
      jsonResponse(120, "r1", {
        total: 2,
        applied: 1,
        errors: [{ row: 2 }],
        rows: [{ row: 1 }],
      }),
    ]);
    expect(found).not.toContain("acknowledged_batch_rows_missing");
  });

  it("flags one database row rewritten by distinct rows in one CSV request", () => {
    const csv =
      "sku,name,price_cents\nalpha,Alpha,15900\nalpha-studio,Alpha Studio,29900";
    const found = detectors([
      csvRequest(100, "r1", csv),
      update(105, "r1", 1, "alpha", 19900, 15900),
      update(110, "r1", 1, "alpha", 15900, 29900),
      jsonResponse(120, "r1", {
        total: 2,
        applied: 2,
        errors: [],
        rows: [{ row: 1 }, { row: 2 }],
      }),
    ]);
    expect(found).toContain("same_request_row_rewritten");
  });

  it("does not flag distinct primary keys updated once each", () => {
    const csv = "sku,price_cents\nalpha,15900\nbeta,29900";
    const found = detectors([
      csvRequest(100, "r1", csv),
      update(105, "r1", 1, "alpha", 19900, 15900),
      update(110, "r1", 2, "beta", 12900, 29900),
      jsonResponse(120, "r1", {
        total: 2,
        applied: 2,
        errors: [],
        rows: [{ row: 1 }, { row: 2 }],
      }),
    ]);
    expect(found).not.toContain("same_request_row_rewritten");
  });

  it("flags identities written with the following CSV row's values", () => {
    const csv =
      "sku,price_cents\nalpha,10100\nbeta,10200\ngamma,10300\ndelta,10400";
    const found = detectors([
      csvRequest(100, "r1", csv),
      update(105, "r1", 1, "alpha", 19900, 10200),
      update(110, "r1", 2, "beta", 12900, 10300),
      update(115, "r1", 3, "gamma", 6900, 10400),
      jsonResponse(120, "r1", {
        total: 4,
        applied: 4,
        errors: [],
        rows: [{ row: 1 }, { row: 2 }, { row: 3 }],
      }),
    ]);
    expect(found).toContain("batch_value_shift");
  });

  it("does not infer a shift from one coincidental next-row value", () => {
    const csv = "sku,price_cents\nalpha,10100\nbeta,10200\ngamma,10300";
    const found = detectors([
      csvRequest(100, "r1", csv),
      update(105, "r1", 1, "alpha", 19900, 10200),
      update(110, "r1", 2, "beta", 12900, 10200),
      jsonResponse(120, "r1", {
        total: 3,
        applied: 2,
        errors: [{ row: 3 }],
        rows: [{ row: 1 }, { row: 2 }],
      }),
    ]);
    expect(found).not.toContain("batch_value_shift");
  });
});
