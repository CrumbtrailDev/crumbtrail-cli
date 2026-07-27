import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * Fixtures mirror a real captured session, not synthetic minima. The live
 * harness run of 2026-07-27 posted
 *   {"userId":1,"couponCode":null,"total":23319,"items":[{"productId":1,"qty":1}]}
 * to /api/checkout, and `orders.total_cents` came back as exactly 23319 —
 * the client's number, persisted as if the server had computed it.
 */
function req(
  t: number,
  requestId: string,
  body: unknown,
  url = "/api/checkout",
): BugEvent {
  return {
    t,
    k: "net.req",
    d: {
      id: 3,
      method: "POST",
      url,
      requestId,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  };
}

function diff(
  t: number,
  requestId: string,
  op: string,
  table: string,
  pk: Record<string, unknown>,
  after: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op, table, pk, after, requestId },
  };
}

const find = (events: BugEvent[], detector: string, start = 1000) =>
  buildEvidenceCandidates(events, { start }).filter(
    (c) => c.detector === detector,
  );

describe("db_client_supplied_value", () => {
  it("names the money field a request body wrote straight into the database", () => {
    const events = [
      req(1100, "req-checkout", {
        userId: 1,
        couponCode: null,
        total: 23319,
        items: [{ productId: 1, qty: 1 }],
      }),
      diff(1200, "req-checkout", "insert", "orders", { id: 1 }, {
        id: 1,
        total_cents: 23319,
      }),
    ];

    const found = find(events, "db_client_supplied_value");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("high");
    expect(found[0].confidence).toBe("high");
    expect(found[0].title).toContain("orders.total_cents");
    expect(found[0].title).toContain("23319");
    expect(found[0].title).toContain("total");
    expect(found[0].anchor.requestId).toBe("req-checkout");
  });

  it("stays silent when the persisted total is server-computed", () => {
    // Same flow, honest server: the client's number is ignored and the row
    // carries the server's subtotal instead.
    const events = [
      req(1100, "req-checkout", {
        userId: 1,
        total: 23319,
        items: [{ productId: 1, qty: 1 }],
      }),
      diff(1200, "req-checkout", "insert", "orders", { id: 1 }, {
        id: 1,
        total_cents: 19900,
      }),
    ];
    expect(find(events, "db_client_supplied_value")).toHaveLength(0);
  });

  it("ignores non-money fields the client is supposed to choose", () => {
    // productId and qty coming from the client is the entire point of a cart.
    // Only money is a trust-boundary violation worth a high-severity signal.
    const events = [
      req(1100, "req-checkout", {
        userId: 1,
        items: [{ productId: 42, qty: 7 }],
      }),
      diff(1200, "req-checkout", "insert", "order_items", { id: 1 }, {
        id: 1,
        order_id: 1,
        product_id: 42,
        qty: 7,
        price_cents: 19900,
      }),
    ];
    expect(find(events, "db_client_supplied_value")).toHaveLength(0);
  });

  it("does not fire across unrelated requests", () => {
    // The client sent 23319 on one request; a DIFFERENT request wrote it. That
    // is not evidence the value crossed the trust boundary in this flow.
    const events = [
      req(1100, "req-a", { total: 23319 }),
      diff(1200, "req-b", "insert", "orders", { id: 1 }, {
        id: 1,
        total_cents: 23319,
      }),
    ];
    expect(find(events, "db_client_supplied_value")).toHaveLength(0);
  });

  it("stays silent on an unparseable or redacted body", () => {
    const events = [
      req(1100, "req-checkout", "[REDACTED]"),
      diff(1200, "req-checkout", "insert", "orders", { id: 1 }, {
        id: 1,
        total_cents: 23319,
      }),
    ];
    expect(find(events, "db_client_supplied_value")).toHaveLength(0);
  });

  it("ignores small integers that collide by coincidence", () => {
    // qty:1 in the body and a money field that happens to equal 1 is noise, not
    // a trust-boundary violation. Real money values are not single digits.
    const events = [
      req(1100, "req-checkout", { items: [{ productId: 1, qty: 1 }] }),
      diff(1200, "req-checkout", "insert", "orders", { id: 1 }, {
        id: 1,
        total_cents: 1,
      }),
    ];
    expect(find(events, "db_client_supplied_value")).toHaveLength(0);
  });

  it("outranks the generic db_mutation surfacing of the same write", () => {
    const events = [
      req(1100, "req-checkout", { total: 23319 }),
      diff(1200, "req-checkout", "insert", "orders", { id: 1 }, {
        id: 1,
        total_cents: 23319,
      }),
    ];
    const all = buildEvidenceCandidates(events, { start: 1000 });
    const mine = all.findIndex((c) => c.detector === "db_client_supplied_value");
    const generic = all.findIndex((c) => c.detector === "db_mutation");
    expect(mine).toBeGreaterThanOrEqual(0);
    if (generic >= 0) expect(mine).toBeLessThan(generic);
  });
});
