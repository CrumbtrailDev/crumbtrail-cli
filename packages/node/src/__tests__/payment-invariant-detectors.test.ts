import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// Two payment-shaped invariants from live sessions:
// - duplicate_charge: the idempotency key was generated inside the retry loop,
//   so attempt 2 became a second real charge — two succeeded payments rows for
//   one order_ref, differing only in gateway_charge_id. duplicate_write is
//   structurally blind to this (the gateway id differs by design).
// - money_scale_shift: capturePayment divided by 100 before sending and the
//   gateway read the value as cents, so a full capture recorded 199 of 19900.

function insert(
  t: number,
  table: string,
  after: Record<string, unknown>,
  requestId = "req-1",
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op: "insert", table, pk: { id: after.id }, after, requestId },
  } as unknown as BugEvent;
}

function update(
  t: number,
  table: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  requestId = "req-1",
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op: "update", table, pk: { id: 1 }, before, after, requestId },
  } as unknown as BugEvent;
}

function of(events: BugEvent[], detector: string) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (c) => c.detector === detector,
  );
}

describe("buildEvidenceCandidates — duplicate_charge", () => {
  const charge = (id: number, gatewayId: string) => ({
    id,
    order_id: 1,
    order_ref: "ord_ms4uzroz",
    amount_cents: 5900,
    status: "succeeded",
    gateway_charge_id: gatewayId,
  });

  it("fires on two settled rows sharing reference and amount", () => {
    const events = [
      insert(1000, "payments", charge(1, "ch_0001")),
      insert(1100, "payments", charge(2, "ch_0002")),
    ];
    const hits = of(events, "duplicate_charge");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe(
      "Duplicate settlement: 2 settled payments rows for one reference",
    );
    expect(hits[0].severity).toBe("high");
    // The message names the reference the claim rests on and the amount.
    expect(String(hits[0].anchor.message)).toContain("order_id=1");
    expect(String(hits[0].anchor.message)).toContain("amount_cents=5900");
  });

  it("stays silent when the second charge has a different amount", () => {
    const events = [
      insert(1000, "payments", charge(1, "ch_0001")),
      insert(1100, "payments", { ...charge(2, "ch_0002"), amount_cents: 300 }),
    ];
    expect(of(events, "duplicate_charge")).toHaveLength(0);
  });

  it("stays silent when only one of the rows settled", () => {
    const events = [
      insert(1000, "payments", { ...charge(1, "ch_0001"), status: "failed" }),
      insert(1100, "payments", charge(2, "ch_0002")),
    ];
    expect(of(events, "duplicate_charge")).toHaveLength(0);
  });

  it("stays silent on settled rows for different references", () => {
    const events = [
      insert(1000, "payments", charge(1, "ch_0001")),
      insert(1100, "payments", {
        ...charge(2, "ch_0002"),
        order_id: 2,
        order_ref: "ord_other",
      }),
    ];
    expect(of(events, "duplicate_charge")).toHaveLength(0);
  });
});

describe("buildEvidenceCandidates — money_scale_shift", () => {
  it("fires when a money column moves by exactly 100x in one update", () => {
    const events = [
      update(
        1000,
        "payments",
        { amount_cents: 19900, status: "succeeded" },
        { amount_cents: 199, status: "captured" },
      ),
    ];
    const hits = of(events, "money_scale_shift");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain("100x");
    expect(hits[0].title).toContain("19900 → 199");
  });

  it("stays silent on ordinary money changes", () => {
    const events = [
      update(1000, "orders", { total_cents: 19900 }, { total_cents: 21542 }),
      // 2x is a plausible real change; only exact 100x/10000x is a unit bug.
      update(1010, "orders", { total_cents: 100 }, { total_cents: 200 }),
    ];
    expect(of(events, "money_scale_shift")).toHaveLength(0);
  });

  it("stays silent on non-money columns and zero values", () => {
    const events = [
      update(1000, "products", { stock_count: 100 }, { stock_count: 1 }),
      update(1010, "orders", { total_cents: 0 }, { total_cents: 0 }),
    ];
    expect(of(events, "money_scale_shift")).toHaveLength(0);
  });
});
