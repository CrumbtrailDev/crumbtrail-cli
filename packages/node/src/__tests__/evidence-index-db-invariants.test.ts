import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { buildCausalGraph } from "../causal-graph";

/**
 * Fixtures mirror the shapes the live harness captured, not synthetic minima:
 * the checkout flow writes `products`, `orders`, and `order_items` under one
 * request id, and the clean control writes two `shipments` rows whose after
 * images carry nothing but a primary key.
 */
function diff(
  t: number,
  requestId: string,
  op: string,
  table: string,
  pk: Record<string, unknown>,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op, table, pk, after, before, requestId },
  };
}

const find = (events: BugEvent[], detector: string, start = 1000) =>
  buildEvidenceCandidates(events, { start }).filter(
    (c) => c.detector === detector,
  );

describe("db_field_divergence", () => {
  it("names two linked rows that disagree on one value in one request", () => {
    // The gap 1 session: one request set the product price to 8900 and wrote
    // the order_items line at 7900. The order_items row references the product.
    const events = [
      diff(
        1100,
        "req-checkout",
        "update",
        "products",
        { id: 42 },
        {
          id: 42,
          price_cents: 8900,
        },
      ),
      diff(
        1200,
        "req-checkout",
        "insert",
        "order_items",
        { id: 7 },
        {
          id: 7,
          product_id: 42,
          price_cents: 7900,
        },
      ),
    ];
    const found = find(events, "db_field_divergence");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("high");
    expect(found[0].score).toBe(90);
    expect(found[0].title).toContain("price_cents");
    expect(found[0].title).toContain("8900");
    expect(found[0].title).toContain("7900");
    expect(found[0].anchor.requestId).toBe("req-checkout");
    // Outranks the generic db_mutation surfacing of the very same writes, so a
    // reader working the list downward reaches the named bug first.
    expect(buildEvidenceCandidates(events, { start: 1000 })[0].detector).toBe(
      "db_field_divergence",
    );
  });

  it("is silent when the linked rows agree", () => {
    const events = [
      diff(
        1100,
        "req-checkout",
        "update",
        "products",
        { id: 42 },
        {
          id: 42,
          price_cents: 8900,
        },
      ),
      diff(
        1200,
        "req-checkout",
        "insert",
        "order_items",
        { id: 7 },
        {
          id: 7,
          product_id: 42,
          price_cents: 8900,
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent on unlinked rows that merely share a column name", () => {
    // Two customers' order rows in one batch request. Same column, different
    // values, no foreign key between them — supposed to differ.
    const events = [
      diff(
        1100,
        "req-batch",
        "insert",
        "orders",
        { id: 1 },
        {
          id: 1,
          total_cents: 8900,
        },
      ),
      diff(
        1200,
        "req-batch",
        "insert",
        "invoices",
        { id: 2 },
        {
          id: 2,
          total_cents: 9258,
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent across two rows of one table", () => {
    // Siblings, not a contradiction, even when one references the other's pk.
    const events = [
      diff(
        1100,
        "req-checkout",
        "insert",
        "order_items",
        { id: 1 },
        {
          id: 1,
          price_cents: 8900,
        },
      ),
      diff(
        1200,
        "req-checkout",
        "insert",
        "order_items",
        { id: 2 },
        {
          id: 2,
          parent_id: 1,
          price_cents: 7900,
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent across two requests", () => {
    const events = [
      diff(
        1100,
        "req-one",
        "update",
        "products",
        { id: 42 },
        {
          id: 42,
          price_cents: 8900,
        },
      ),
      diff(
        1200,
        "req-two",
        "insert",
        "order_items",
        { id: 7 },
        {
          id: 7,
          product_id: 42,
          price_cents: 7900,
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("ignores identity and clock fields, which are supposed to differ", () => {
    const events = [
      diff(
        1100,
        "req-checkout",
        "update",
        "products",
        { id: 42 },
        {
          id: 42,
          product_id: 42,
          updated_at: 1,
          version: 3,
        },
      ),
      diff(
        1200,
        "req-checkout",
        "insert",
        "order_items",
        { id: 7 },
        {
          id: 7,
          product_id: 42,
          updated_at: 2,
          version: 3,
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });
});

/**
 * The rows of session ses_20260727_201639_01d3cd76d2a8, verbatim: a two-line
 * checkout on a freshly seeded store, where every table's primary key sequence
 * still starts at 1. Small sequential ids are what make this fixture worth
 * keeping — the single-product fixtures above use deliberately non-colliding
 * ids (42, 7), which is exactly why the collision below survived.
 *
 * The checkout underpays: the order totals 70894 but the payment settles 60500.
 */
const twoLineCheckout = (): BugEvent[] => [
  diff(
    1100,
    "req-checkout",
    "update",
    "products",
    { id: 1 },
    {
      id: 1,
      price_cents: 19900,
      inventory: 23,
    },
  ),
  diff(
    1120,
    "req-checkout",
    "update",
    "products",
    { id: 3 },
    {
      id: 3,
      price_cents: 6900,
      inventory: 0,
    },
  ),
  diff(
    1140,
    "req-checkout",
    "insert",
    "orders",
    { id: 1 },
    {
      id: 1,
      total_cents: 70894,
    },
  ),
  diff(
    1160,
    "req-checkout",
    "insert",
    "order_items",
    { id: 1 },
    {
      id: 1,
      order_id: 1,
      product_id: 1,
      qty: 2,
      price_cents: 19900,
    },
  ),
  diff(
    1180,
    "req-checkout",
    "insert",
    "order_items",
    { id: 2 },
    {
      id: 2,
      order_id: 1,
      product_id: 3,
      qty: 3,
      price_cents: 6900,
    },
  ),
  diff(
    1200,
    "req-checkout",
    "insert",
    "payments",
    { id: 1 },
    {
      id: 1,
      order_id: 1,
      amount_cents: 60500,
      status: "succeeded",
    },
  ),
];

describe("db_field_divergence — foreign key linkage", () => {
  it("does not link two rows on a column that names a different table", () => {
    // The false positive: `order_items.order_id` is 1 and `products.id` is 1,
    // so a scan of every value in the after image linked order_items#2 to
    // products#1 and reported their prices (6900 vs 19900) as a contradiction.
    // Those rows describe different products — order_items#2 is product 3. The
    // only join that links order_items to products is `product_id`.
    const found = find(twoLineCheckout(), "db_field_divergence");
    expect(found.filter((c) => c.title.includes("price_cents"))).toHaveLength(
      0,
    );
  });

  it("still links rows through the column that does name the target table", () => {
    // Same fixture, one price edited: order_items#2 IS product 3, so a price
    // disagreement between those two rows is a real contradiction.
    const events = twoLineCheckout().map((event) =>
      event.d.table === "order_items" && (event.d.pk as { id: number }).id === 2
        ? diff(
            event.t,
            "req-checkout",
            "insert",
            "order_items",
            { id: 2 },
            {
              id: 2,
              order_id: 1,
              product_id: 3,
              qty: 3,
              price_cents: 5900,
            },
          )
        : event,
    );
    const found = find(events, "db_field_divergence").filter((c) =>
      c.title.includes("price_cents"),
    );
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("6900");
    expect(found[0].title).toContain("5900");
    // The message cites the join it actually used, so a reader can check it.
    expect(found[0].anchor.message).toContain("order_items.product_id");
  });

  it("is silent when the shared value is not a scalar identifier", () => {
    // `{}` is what a db.diff after image leaves behind for a Date. Two of them
    // stringify alike and must never constitute a foreign key match.
    const events = [
      diff(
        1100,
        "req-checkout",
        "insert",
        "orders",
        { id: {} },
        {
          id: {},
          total_cents: 8900,
        },
      ),
      diff(
        1200,
        "req-checkout",
        "insert",
        "payments",
        { id: 1 },
        {
          id: 1,
          order_id: {},
          amount_cents: 7900,
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });
});

describe("db_field_divergence — settlement rows that do not settle their parent", () => {
  it("names a payment that does not cover the order it references", () => {
    const found = find(twoLineCheckout(), "db_field_divergence").filter((c) =>
      c.title.includes("amount_cents"),
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("high");
    expect(found[0].score).toBe(90);
    expect(found[0].title).toContain("70894");
    expect(found[0].title).toContain("60500");
    expect(found[0].anchor.requestId).toBe("req-checkout");
    expect(found[0].anchor.message).toContain("payments.order_id");
  });

  it("outranks the app's own log line, which used to be the only way it surfaced", () => {
    // The whole point. In the live session this underpayment reached the reader
    // only at rank 5, score 50, severity low, as a `console_warning` — because
    // the application happened to log it. Delete that one line from the app and
    // the checkout fraud left the ranking entirely.
    const events: BugEvent[] = [
      ...twoLineCheckout(),
      {
        t: 1210,
        k: "con",
        d: { lv: "warn", args: ["payment 60500 does not cover order 70894"] },
      },
    ];
    const candidates = buildEvidenceCandidates(
      events,
      { start: 1000 },
      buildCausalGraph({ events }),
    );
    const settlement = candidates.findIndex((c) =>
      c.title.includes("amount_cents"),
    );
    const warning = candidates.findIndex(
      (c) => c.detector === "console_warning",
    );
    expect(settlement).toBeGreaterThanOrEqual(0);
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(settlement).toBeLessThan(warning);
  });

  it("outranks every generic surfacing of the request's writes, including earlier ones", () => {
    // This divergence anchors on the third write of six, so the two `products`
    // updates precede it on the request spine. Those writes are joined to it by
    // ordering, not causation, and the graph grades that link `low` for exactly
    // that reason — a `low` link must not reorder anything.
    const events = twoLineCheckout();
    const candidates = buildEvidenceCandidates(
      events,
      { start: 1000 },
      buildCausalGraph({ events }),
    );
    const settlement = candidates.findIndex((c) =>
      c.title.includes("amount_cents"),
    );
    const genericWrites = candidates
      .map((c, i) => (c.detector === "db_mutation" ? i : -1))
      .filter((i) => i >= 0);
    expect(settlement).toBeGreaterThanOrEqual(0);
    // Six writes, four distinct table-and-operation pairs: `products` is
    // updated twice and `order_items` inserted twice. Writes tied to no error
    // roll up per pair rather than taking a ranked slot each, so the six
    // surface as four candidates carrying `occurrences`.
    expect(genericWrites).toHaveLength(4);
    const rolledUp = genericWrites
      .map((i) => candidates[i])
      .filter((c) => (c.occurrences ?? 1) > 1);
    expect(rolledUp.map((c) => c.occurrences).sort()).toEqual([2, 2]);
    expect(settlement).toBeLessThan(Math.min(...genericWrites));
  });

  it("is silent when the payment settles the order exactly", () => {
    const events = twoLineCheckout().map((event) =>
      event.d.table === "payments"
        ? diff(
            event.t,
            "req-checkout",
            "insert",
            "payments",
            { id: 1 },
            {
              id: 1,
              order_id: 1,
              amount_cents: 70894,
              status: "succeeded",
            },
          )
        : event,
    );
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent when one order is settled by more than one payment", () => {
    // A split payment or an installment: no single row is supposed to equal the
    // total, so comparing either one against it says nothing.
    const events = [
      ...twoLineCheckout(),
      diff(
        1220,
        "req-checkout",
        "insert",
        "payments",
        { id: 2 },
        {
          id: 2,
          order_id: 1,
          amount_cents: 10394,
          status: "succeeded",
        },
      ),
    ];
    expect(
      find(events, "db_field_divergence").filter((c) =>
        c.title.includes("amount_cents"),
      ),
    ).toHaveLength(0);
  });

  it("is silent for a child row that is a component of the total, not a settlement of it", () => {
    // A coupon carries the same `amount_cents` column as a payment and the same
    // `order_id` foreign key, and is SUPPOSED to differ from the order total.
    const events = [
      diff(
        1140,
        "req-checkout",
        "insert",
        "orders",
        { id: 1 },
        {
          id: 1,
          total_cents: 70894,
        },
      ),
      diff(
        1200,
        "req-checkout",
        "insert",
        "coupon_redemptions",
        { id: 1 },
        {
          id: 1,
          order_id: 1,
          coupon_code: "SAVE10",
          amount_cents: 1000,
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent when the two money columns are in different units", () => {
    const events = [
      diff(
        1140,
        "req-checkout",
        "insert",
        "orders",
        { id: 1 },
        {
          id: 1,
          total_cents: 70894,
        },
      ),
      diff(
        1200,
        "req-checkout",
        "insert",
        "payments",
        { id: 1 },
        {
          id: 1,
          order_id: 1,
          amount_usd: 708.94,
          status: "succeeded",
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent across two requests", () => {
    const events = [
      diff(
        1140,
        "req-one",
        "insert",
        "orders",
        { id: 1 },
        {
          id: 1,
          total_cents: 70894,
        },
      ),
      diff(
        1200,
        "req-two",
        "insert",
        "payments",
        { id: 1 },
        {
          id: 1,
          order_id: 1,
          amount_cents: 60500,
          status: "succeeded",
        },
      ),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });
});

describe("duplicate_write", () => {
  it("names two identical inserts into one table in one request", () => {
    // The gap 3 session: a retry storm with no idempotency key redeemed one
    // coupon twice under a single request id.
    const row = {
      order_id: 31,
      coupon_code: "SAVE10",
      amount_cents: 1000,
    };
    const events = [
      diff(
        1100,
        "req-checkout",
        "insert",
        "coupon_redemptions",
        { id: 1 },
        {
          id: 1,
          ...row,
        },
      ),
      diff(
        1150,
        "req-checkout",
        "insert",
        "coupon_redemptions",
        { id: 2 },
        {
          id: 2,
          ...row,
        },
      ),
    ];
    const found = find(events, "duplicate_write");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("high");
    expect(found[0].score).toBe(90);
    expect(found[0].title).toContain("coupon_redemptions");
    expect(found[0].title).toContain("2 identical rows");
    // Anchored on the FIRST of the duplicates.
    expect(found[0].anchor.t).toBe(1100);
  });

  it("is silent on the clean control's two empty-after shipments rows", () => {
    // Planner finding F2. Both rows reduce to `{}` once the primary key is
    // dropped, so a naive identical-inserts rule fires on the control.
    const events = [
      diff(1100, "req-checkout", "insert", "shipments", { id: 1 }, { id: 1 }),
      diff(1150, "req-checkout", "insert", "shipments", { id: 2 }, { id: 2 }),
    ];
    expect(find(events, "duplicate_write")).toHaveLength(0);
  });

  it("is silent when every surviving field is empty or zero", () => {
    // The same hole one level in: the capture recorded fields but no content.
    // `created_at` arrives as `{}` because db.diff after images drop Dates.
    const events = [
      diff(
        1100,
        "req-checkout",
        "insert",
        "shipments",
        { id: 1 },
        {
          id: 1,
          created_at: {},
          retries: 0,
          label: "",
        },
      ),
      diff(
        1150,
        "req-checkout",
        "insert",
        "shipments",
        { id: 2 },
        {
          id: 2,
          created_at: {},
          retries: 0,
          label: "",
        },
      ),
    ];
    expect(find(events, "duplicate_write")).toHaveLength(0);
  });

  it("is silent when the two inserts genuinely differ", () => {
    const events = [
      diff(
        1100,
        "req-checkout",
        "insert",
        "order_items",
        { id: 1 },
        {
          id: 1,
          product_id: 42,
          qty: 1,
        },
      ),
      diff(
        1150,
        "req-checkout",
        "insert",
        "order_items",
        { id: 2 },
        {
          id: 2,
          product_id: 43,
          qty: 1,
        },
      ),
    ];
    expect(find(events, "duplicate_write")).toHaveLength(0);
  });

  it("is silent across two requests, and on updates", () => {
    const row = { order_id: 31, coupon_code: "SAVE10", amount_cents: 1000 };
    const twoRequests = [
      diff(
        1100,
        "req-one",
        "insert",
        "coupon_redemptions",
        { id: 1 },
        {
          id: 1,
          ...row,
        },
      ),
      diff(
        1150,
        "req-two",
        "insert",
        "coupon_redemptions",
        { id: 2 },
        {
          id: 2,
          ...row,
        },
      ),
    ];
    expect(find(twoRequests, "duplicate_write")).toHaveLength(0);

    const updates = [
      diff(
        1100,
        "req-checkout",
        "update",
        "coupon_redemptions",
        { id: 1 },
        {
          id: 1,
          ...row,
        },
      ),
      diff(
        1150,
        "req-checkout",
        "update",
        "coupon_redemptions",
        { id: 2 },
        {
          id: 2,
          ...row,
        },
      ),
    ];
    expect(find(updates, "duplicate_write")).toHaveLength(0);
  });

  it("reports the count when a retry storm writes the row three times", () => {
    const row = { order_id: 31, coupon_code: "SAVE10", amount_cents: 1000 };
    const events = [1100, 1150, 1200].map((t, i) =>
      diff(
        t,
        "req-checkout",
        "insert",
        "coupon_redemptions",
        { id: i + 1 },
        {
          id: i + 1,
          ...row,
        },
      ),
    );
    const found = find(events, "duplicate_write");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("3 identical rows");
  });
});

/**
 * The shipped path always builds a causal graph, and the ranker hard partitions
 * causal roots ahead of high and medium confidence symptoms BEFORE score is
 * consulted. A detector that merely scores 90 therefore proves nothing about
 * where a reader finds it. These assert the ranked position with the graph
 * ENABLED, which is the only position production ever produces.
 */
describe("db invariant detectors — ranked position with the causal graph enabled", () => {
  const ranked = (events: BugEvent[]) =>
    buildEvidenceCandidates(
      events,
      { start: 1000 },
      buildCausalGraph({ events }),
    );

  it("field divergence leads its session instead of the generic write surfacing", () => {
    // One checkout request writes four rows. Every one of them also produces a
    // generic db_mutation candidate, and the earliest of those used to own the
    // request's first causal node, which made it the root and pushed the named
    // divergence below it as a symptom.
    const events = [
      diff(
        1100,
        "req-checkout",
        "update",
        "products",
        { id: 7 },
        {
          id: 7,
          price_cents: 8900,
        },
      ),
      diff(
        1150,
        "req-checkout",
        "insert",
        "orders",
        { id: 1 },
        {
          id: 1,
          total_cents: 9258,
        },
      ),
      diff(
        1200,
        "req-checkout",
        "insert",
        "order_items",
        { id: 1 },
        {
          id: 1,
          order_id: 1,
          product_id: 7,
          price_cents: 7900,
        },
      ),
      diff(1250, "req-checkout", "insert", "jobs", { id: 1 }, { id: 1 }),
    ];
    const candidates = ranked(events);
    const divergence = candidates.findIndex(
      (c) => c.detector === "db_field_divergence",
    );
    expect(divergence).toBeGreaterThanOrEqual(0);
    // The property this change establishes is relative, not absolute: the named divergence outranks
    // EVERY generic surfacing of the same writes. Asserting position 0 of the whole session would
    // also fail for any unrelated detector that later fires here at score 90 or above, and would
    // read as a divergence regression when it is not one.
    const genericWrites = candidates
      .map((c, i) => (c.detector === "db_mutation" ? i : -1))
      .filter((i) => i >= 0);
    expect(genericWrites.length).toBeGreaterThan(0);
    expect(divergence).toBeLessThan(Math.min(...genericWrites));
    // And it leads as a cause, not as something explained by one of those writes.
    expect(candidates[divergence].causalRole).toBe("root");
    expect(candidates[divergence].rootCauseId).toBeUndefined();
  });

  it("a duplicate write outranks an unrelated background write in another request", () => {
    // The duplicate is a genuine symptom of the 500 that triggered the retry,
    // so it can never be a root here. It must still outrank a background job
    // drain that is a root only because nothing upstream of it bears a
    // candidate.
    const row = { order_id: 1, code: "SAVE10", amount_cents: 1000 };
    const events: BugEvent[] = [
      {
        t: 1050,
        k: "backend.req.error",
        d: {
          requestId: "req-checkout",
          method: "POST",
          route: "/checkout",
          statusCode: 500,
          error: { name: "Error", message: "pricing upstream failed" },
        },
      },
      diff(
        1100,
        "req-checkout",
        "insert",
        "coupon_redemptions",
        { id: 1 },
        {
          id: 1,
          ...row,
        },
      ),
      diff(
        1150,
        "req-checkout",
        "insert",
        "coupon_redemptions",
        { id: 2 },
        {
          id: 2,
          ...row,
        },
      ),
      // Unrelated background drain, its own request, no error anywhere near it.
      diff(4000, "req-drain", "insert", "shipments", { id: 1 }, { id: 1 }),
      diff(
        4050,
        "req-drain",
        "insert",
        "inventory_ledger",
        { id: 1 },
        {
          id: 1,
          product_id: 7,
          delta: -1,
          reason: "fulfillment",
        },
      ),
    ];
    const candidates = ranked(events);
    const positionOf = (
      predicate: (detector: string, title: string) => boolean,
    ) => candidates.findIndex((c) => predicate(c.detector, c.title));
    const duplicate = positionOf((detector) => detector === "duplicate_write");
    const drain = positionOf(
      (detector, title) =>
        detector === "db_mutation" && title.includes("shipments"),
    );
    expect(duplicate).toBeGreaterThanOrEqual(0);
    expect(drain).toBeGreaterThanOrEqual(0);
    expect(duplicate).toBeLessThan(drain);
  });
});
