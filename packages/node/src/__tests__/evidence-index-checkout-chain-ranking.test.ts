import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { buildCausalGraph } from "../causal-graph";

// Replay of live session ses_20260727_212516_74eb77d4fef2: a playground checkout
// that posted `total=23319` against a 19900 subtotal and stored the client's
// number verbatim in `orders.total_cents`. `db_client_supplied_value` (#36) names
// it at score 90 / severity high / confidence high.
//
// The session ranked it THIRD, under a score-50 console warning and a score-40
// "Database update on products", because the request spine chains every node of a
// request in time order and `enforceRootBeforeSymptom` gave that ordering
// positional authority over score:
//
//   1  50 low  isolated  console_warning
//   2  40 low  root      db_mutation (products)
//   3  90 high symptom   db_client_supplied_value   ← the bug
//   4  40 low  symptom   db_mutation (orders)
//   ...
//
// The emitted chain was write order relabelled as causation — and shifted by one,
// because the named failure took the `orders` node and every following
// `db_mutation` was displaced onto the next write. That produced claims running
// backwards in time ("order_items" attributed to the later "jobs" write).
//
// The graph must be enabled here: `buildCausalGraph` is unconditional in the SDK's
// post-processing, so a ranking measured without it does not describe what ships.

const REQ = "219ecb8e6542f08db6f2a31c79d498d7";
const AUTH_REQ = "b47967bee7a6aa5eb1080abff0b12ba0";
const T0 = 1785201951738;

const write = (
  t: number,
  op: "insert" | "update",
  table: string,
  pk: number,
  after: Record<string, unknown>,
): BugEvent => ({
  t,
  k: "db.diff",
  d: { engine: "postgres", op, table, pk: { id: pk }, requestId: REQ, after },
});

const span = (t: number, spanId: string, serviceName: string): BugEvent => ({
  t,
  k: "backend.otel.span",
  d: {
    traceId: REQ,
    spanId,
    name: "POST",
    kind: 2,
    serviceName,
    statusCode: "UNSET",
  },
});

function checkoutSession(): {
  events: BugEvent[];
  index: Parameters<typeof buildEvidenceCandidates>[1];
} {
  const events: BugEvent[] = [
    {
      t: T0,
      k: "net.req",
      d: {
        id: 1,
        method: "POST",
        url: "/api/checkout",
        requestId: REQ,
        traceId: REQ,
        body: '{"userId":1,"couponCode":null,"total":23319,"items":[{"productId":1,"qty":1}],"paymentScenario":null}',
      },
    },
    {
      t: T0 + 3,
      k: "backend.req.start",
      d: { requestId: REQ, method: "POST", url: "/api/checkout" },
    },
    span(T0 + 3, "7eb5e4a8127d08ac", "kartbug-server"),
    span(T0 + 8, "74b58155fa711606", "kartbug-pricing"),
    // The inventory decrement: an ordinary write, unrelated to the pricing defect.
    write(T0 + 63, "update", "products", 1, {
      id: 1,
      slug: "aurora-headphones",
      name: "Aurora Wireless Headphones",
      price_cents: 19900,
      inventory: 22,
    }),
    // An OTLP span lands BETWEEN the two writes. This is what let the write→write
    // clamp be laundered into a high-confidence causal claim.
    span(T0 + 67, "200dc35e1243e940", "kartbug-payments"),
    // The defect: the client's `total` stored verbatim.
    write(T0 + 77, "insert", "orders", 2, { id: 2, total_cents: 23319 }),
    write(T0 + 79, "insert", "order_items", 3, {
      id: 3,
      order_id: 2,
      product_id: 1,
      qty: 1,
      price_cents: 19900,
    }),
    write(T0 + 83, "insert", "jobs", 2, { id: 2 }),
    {
      t: T0 + 83,
      k: "backend.req.end",
      d: {
        requestId: REQ,
        method: "POST",
        url: "/api/checkout",
        route: "/",
        statusCode: 200,
        durationMs: 80,
      },
    },
    { t: T0 + 84, k: "net.res", d: { id: 1, st: 200, requestId: REQ } },
    {
      t: T0 + 85,
      k: "con",
      d: {
        lv: "warn",
        args: [
          '"Total mismatch — persisted 23319¢ but server computed 19900¢"',
        ],
      },
    },
    // The webhook reuses the same requestId, so its writes join the same spine.
    {
      t: T0 + 685,
      k: "backend.req.start",
      d: { requestId: REQ, method: "POST", url: "/api/payments/webhook" },
    },
    write(T0 + 689, "insert", "payment_webhooks", 2, { id: 2 }),
    // The gateway charged the correct amount — one more sign that only the
    // persisted order total came from the client.
    write(T0 + 695, "insert", "payments", 2, {
      id: 2,
      order_id: 2,
      order_ref: "ord_ms3z5dtn_42e3d2c3",
      amount_cents: 19900,
      status: "succeeded",
    }),
    write(T0 + 708, "update", "payment_webhooks", 2, {
      id: 2,
      event_id: "evt_0001_2c6f47",
      type: "charge.succeeded",
    }),
    {
      t: T0 + 708,
      k: "backend.req.end",
      d: {
        requestId: REQ,
        method: "POST",
        url: "/api/payments/webhook",
        route: "/webhook",
        statusCode: 200,
        durationMs: 23,
      },
    },
    // A logged-out visitor polling /api/me — a deliberate, uninteresting 401.
    {
      t: T0 + 95,
      k: "backend.req.end",
      d: {
        requestId: AUTH_REQ,
        method: "GET",
        url: "/api/me",
        route: "/me",
        statusCode: 401,
      },
    },
    {
      t: T0 + 97,
      k: "net.res",
      d: { id: 2, st: 401, requestId: AUTH_REQ },
    },
  ];
  events.sort((a, b) => a.t - b.t);

  return {
    events,
    index: {
      start: T0 - 1000,
      end: T0 + 1000,
      navs: [{ t: T0 - 1000, to: "http://localhost:5505/checkout" }],
      failedReqs: [
        { t: T0 + 97, m: "GET", url: "/api/me", st: 401, id: 2 },
      ] as never,
    } as Parameters<typeof buildEvidenceCandidates>[1],
  };
}

describe("buildEvidenceCandidates — checkout chain ranking", () => {
  const { events, index } = checkoutSession();
  const candidates = buildEvidenceCandidates(
    events,
    index,
    buildCausalGraph({ events }),
  );
  const rankOf = (detector: string) =>
    candidates.findIndex((c) => c.detector === detector);
  const byTable = (table: string) =>
    candidates.find(
      (c) => c.detector === "db_mutation" && c.title.includes(` on ${table}`),
    )!;

  it("emits the client-supplied-value signal at all", () => {
    expect(rankOf("db_client_supplied_value")).toBeGreaterThanOrEqual(0);
  });

  it("ranks the score-90 named failure first", () => {
    expect(candidates[0].detector).toBe("db_client_supplied_value");
    expect(candidates[0].score).toBe(90);
    expect(candidates[0].severity).toBe("high");
  });

  it("puts no lower-scoring signal above it", () => {
    const top = rankOf("db_client_supplied_value");
    for (const [i, candidate] of candidates.entries()) {
      if (i >= top) continue;
      expect(
        candidate.score,
        `${candidate.detector} (score ${candidate.score}) outranked the score-90 defect`,
      ).toBeGreaterThan(90);
    }
  });

  it("does not present the inventory decrement as the cause of the defect", () => {
    const defect = candidates.find(
      (c) => c.detector === "db_client_supplied_value",
    )!;
    const products = byTable("products");
    // The two writes are consecutive stages of one request and nothing more. If a
    // link is emitted at all it must be graded as sequence, never as an
    // established cause.
    if (defect.rootCauseId === products.id) {
      expect(defect.attributionConfidence).toBe("low");
    }
  });

  it("never claims a later write caused an earlier one", () => {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    for (const candidate of candidates) {
      if (!candidate.rootCauseId) continue;
      const root = byId.get(candidate.rootCauseId);
      if (!root) continue;
      expect(
        root.anchor.t,
        `${candidate.title} names ${root.title} as its cause, but that happened later`,
      ).toBeLessThanOrEqual(candidate.anchor.t);
    }
  });

  it("attributes each db_mutation to its own write, not a neighbouring one", () => {
    // Every db_mutation candidate that carries a causal role must describe the
    // write it is named for. The displacement cascade showed up as "orders"
    // reporting the order_items write's ancestry.
    for (const table of ["orders", "order_items", "jobs"]) {
      const candidate = byTable(table);
      expect(candidate, `no db_mutation candidate for ${table}`).toBeDefined();
    }
    expect(byTable("order_items").rootCauseId).not.toBe(byTable("jobs").id);
  });

  it("re-ranks without dropping or inventing a signal", () => {
    // The re-rank reorders; it must never change the SET. Compared against the
    // same input with no graph — which skips attribution and the chain layout
    // entirely — by the fields that identify a signal, since `id` is assigned
    // from rank and is expected to differ. A hard count would break every time a
    // detector is added, which says nothing about the ranker.
    const identify = (list: typeof candidates) =>
      list
        .map((c) => `${c.detector}|${c.anchor.t}|${c.title}`)
        .sort((a, b) => a.localeCompare(b));
    expect(identify(candidates)).toEqual(
      identify(buildEvidenceCandidates(events, index)),
    );
  });

  it("is deterministic across runs", () => {
    const again = buildEvidenceCandidates(
      events,
      index,
      buildCausalGraph({ events }),
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(candidates));
  });
});
