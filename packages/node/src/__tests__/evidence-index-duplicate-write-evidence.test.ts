import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// A live run reported "Duplicate write: 3 identical rows inserted into
// order_items in one request" as the session's single High signal. The three
// rows were verifiably different — Aurora x3 @ 19900, Nimbus x2 @ 12900, Ember
// x1 @ 5900 — and the shipped candidate carried no after image, so a reader
// could not check the claim at all.
//
// Two things are graded here:
//  1. A signature resting on one foreign-key column cannot license the claim.
//     Three order_items rows of one order all share order_id; that is evidence
//     the after image was partial, not that one write happened three times.
//  2. When the detector does fire, it ships the compared columns, so the next
//     reader verifies rather than trusts.

function insert(
  t: number,
  requestId: string,
  table: string,
  pk: Record<string, unknown> | null,
  after: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op: "insert", table, pk, after, requestId },
  };
}

describe("buildEvidenceCandidates — duplicate_write evidence", () => {
  it("stays silent when the only shared column is a foreign key", () => {
    // The observed false positive: a partial after image reduced to {order_id}.
    const events = [
      insert(1000, "req-1", "order_items", { id: 1 }, { id: 1, order_id: 7 }),
      insert(1001, "req-1", "order_items", { id: 2 }, { id: 2, order_id: 7 }),
      insert(1002, "req-1", "order_items", { id: 3 }, { id: 3, order_id: 7 }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(0);
  });

  it("stays silent when a full after image shows the rows differ", () => {
    const events = [
      insert(
        1000,
        "req-1",
        "order_items",
        { id: 1 },
        { id: 1, order_id: 7, product_id: 1, qty: 3, price_cents: 19900 },
      ),
      insert(
        1001,
        "req-1",
        "order_items",
        { id: 2 },
        { id: 2, order_id: 7, product_id: 2, qty: 2, price_cents: 12900 },
      ),
      insert(
        1002,
        "req-1",
        "order_items",
        { id: 3 },
        { id: 3, order_id: 7, product_id: 6, qty: 1, price_cents: 5900 },
      ),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(0);
  });

  it("still catches the genuine retry-storm duplicate and ships its evidence", () => {
    // The case this detector exists for: one request redeemed a coupon twice.
    // Every non-generated column matches, so the claim is real.
    const row = { order_id: 7, code: "SAVE10", discount_cents: 1000 };
    const events = [
      insert(1000, "req-1", "coupon_redemptions", { id: 1 }, { id: 1, ...row }),
      insert(1001, "req-1", "coupon_redemptions", { id: 2 }, { id: 2, ...row }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    const dup = candidates.find((c) => c.detector === "duplicate_write");

    expect(dup).toBeDefined();
    expect(dup?.severity).toBe("high");
    expect(dup?.title).toContain("coupon_redemptions");
    // The claim ships the columns it rests on, so a reader can check it.
    expect(dup?.anchor.comparedColumns).toEqual([
      "code",
      "discount_cents",
      "order_id",
    ]);
    expect(dup?.anchor.sharedAfterImage).toEqual({
      code: "SAVE10",
      discount_cents: 1000,
      order_id: 7,
    });
  });

  // A column the capture could not represent arrives as `{}` — a Buffer, a JSON
  // column, a driver wrapper. That is the absence of an answer, not an answer,
  // and the rows may well differ exactly there, so identity is unknown and the
  // claim cannot be made. Distinct from a scalar null, which is a real value a
  // nullable column legitimately holds.
  it("stays silent when a substantive column was captured unrepresented", () => {
    const events = [
      insert(1000, "req-1", "webhook_deliveries", { id: 1 }, { id: 1, endpoint: "/hooks/pay", payload: {} }),
      insert(1001, "req-1", "webhook_deliveries", { id: 2 }, { id: 2, endpoint: "/hooks/pay", payload: {} }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(0);
  });

  it("treats a scalar null as a real value rather than a capture gap", () => {
    // Nullable columns are ordinary; refusing to judge whenever one is null
    // would silence the detector across most real schemas.
    const row = { order_id: 7, code: "SAVE10", redeemed_by: null };
    const events = [
      insert(1000, "req-1", "coupon_redemptions", { id: 1 }, { id: 1, ...row }),
      insert(1001, "req-1", "coupon_redemptions", { id: 2 }, { id: 2, ...row }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(1);
  });

  // Timestamps are database-generated, exactly like the primary key, so they
  // cannot be part of what makes two rows the same row. The live retry storm
  // wrote its two redemptions inside one millisecond and fired; the identical
  // storm one millisecond slower would not have, which makes the detector a
  // coin flip on machine speed rather than on the defect.
  it("fires on a genuine duplicate whose generated timestamps differ", () => {
    const row = { order_id: 7, code: "SAVE10", amount_cents: 1000 };
    const events = [
      insert(1000, "req-1", "coupon_redemptions", { id: 1 }, { id: 1, ...row, created_at: "2026-07-28T06:33:43.835Z" }),
      insert(1001, "req-1", "coupon_redemptions", { id: 2 }, { id: 2, ...row, created_at: "2026-07-28T06:33:43.836Z" }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    const dup = candidates.find((c) => c.detector === "duplicate_write");
    expect(dup).toBeDefined();
    // The timestamp is evidence a reader wants, but it is not what the claim
    // rests on, so it must not appear among the compared columns.
    expect(dup?.anchor.comparedColumns).not.toContain("created_at");
    expect(dup?.anchor.comparedColumns).toEqual([
      "amount_cents",
      "code",
      "order_id",
    ]);
  });

  it("does not let a timestamp alone license a duplicate claim", () => {
    // Once generated columns are out, a row whose only remaining column is a
    // timestamp has nothing discriminating left, so the detector stays silent.
    const events = [
      insert(1000, "req-1", "pings", { id: 1 }, { id: 1, created_at: "2026-07-28T06:00:00.000Z" }),
      insert(1001, "req-1", "pings", { id: 2 }, { id: 2, created_at: "2026-07-28T06:00:00.000Z" }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(0);
  });

  it("does not group inserts made by different requests", () => {
    const row = { order_id: 7, code: "SAVE10", discount_cents: 1000 };
    const events = [
      insert(1000, "req-1", "coupon_redemptions", { id: 1 }, { id: 1, ...row }),
      insert(1001, "req-2", "coupon_redemptions", { id: 2 }, { id: 2, ...row }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(0);
  });

  it("still fires on two non-key columns that genuinely match", () => {
    // Guards against over-tightening: two substantive columns is enough
    // evidence, and must not need three.
    const row = { code: "SAVE10", discount_cents: 1000 };
    const events = [
      insert(1000, "req-1", "redemptions", { id: 1 }, { id: 1, ...row }),
      insert(1001, "req-1", "redemptions", { id: 2 }, { id: 2, ...row }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(1);
  });

  it("fires on a single non-key column that is not a foreign key", () => {
    // A shipments table keyed only by a tracking number: one column, but it
    // identifies the row rather than pointing at a parent.
    const events = [
      insert(1000, "req-1", "shipments", { id: 1 }, { id: 1, tracking: "1Z9" }),
      insert(1001, "req-1", "shipments", { id: 2 }, { id: 2, tracking: "1Z9" }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(1);
  });

  it("stays silent on bulk-created rows that share only state columns", () => {
    // Eight orders seeded in one request, identical on every captured column
    // because the capture is narrow: lifecycle status, a money amount, and a
    // null foreign key. Nothing ties them to one entity, so nothing supports
    // "the same row written twice" — this exact shape fired on four live ops
    // sessions whose flows merely seed data.
    const row = { status: "placed", total_cents: 35700, user_id: null };
    const events = [1, 2, 3, 4].map((n) =>
      insert(1000 + n, "req-1", "orders", { id: n }, { id: n, ...row }),
    );

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(0);
  });

  it("fires when the shared image carries a non-null foreign key anchor", () => {
    const row = { order_id: 1, code: "SAVE10", amount_cents: 1000 };
    const events = [
      insert(1000, "req-1", "coupon_redemptions", { id: 1 }, { id: 1, ...row }),
      insert(1001, "req-1", "coupon_redemptions", { id: 2 }, { id: 2, ...row }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(1);
  });
});
