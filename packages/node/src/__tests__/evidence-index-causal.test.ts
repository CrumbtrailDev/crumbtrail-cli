import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  buildEvidenceCandidates,
  CAUSAL_RANK_CONSTANTS,
} from "../evidence-index";
import { buildCausalGraph, attributeCandidates } from "../causal-graph";

// A canonical Express-500 session: a user click triggers a checkout POST, the backend throws, the
// response is a 500, and the frontend surfaces an uncaught error. The backend error is the root; the
// frontend error is a downstream symptom.
const express500Events: BugEvent[] = [
  { t: 100, k: "clk", d: { el: { txt: "Checkout" }, route: "/checkout" } },
  {
    t: 150,
    k: "net.req",
    d: {
      id: "n1",
      requestId: "req1",
      url: "https://api.test/checkout",
      m: "POST",
      route: "/checkout",
    },
  },
  {
    t: 200,
    k: "backend.req.start",
    d: { requestId: "req1", method: "POST", route: "/checkout" },
  },
  {
    t: 300,
    k: "backend.req.error",
    d: {
      requestId: "req1",
      method: "POST",
      route: "/checkout",
      statusCode: 500,
      error: { name: "TypeError", message: "Cannot read amount_cents" },
    },
  },
  { t: 350, k: "net.res", d: { id: "n1", requestId: "req1", st: 500 } },
  { t: 400, k: "err", d: { msg: "Request failed with status 500" } },
];

function buildIndexFor(events: BugEvent[]) {
  const failedReqs = events
    .filter(
      (e) =>
        e.k === "net.res" &&
        typeof e.d.st === "number" &&
        (e.d.st as number) >= 400,
    )
    .map((e) => ({
      t: e.t,
      st: e.d.st as number,
      reason: "http_status" as string,
    }));
  const errs = events
    .filter((e) => e.k === "err" || e.k === "rej")
    .map((e) => ({ t: e.t, msg: String(e.d.msg ?? "") }));
  const navs = events
    .filter((e) => e.k === "nav")
    .map((e) => ({ t: e.t, to: String(e.d.to ?? "") }));
  return {
    start: events[0]?.t ?? 0,
    end: events[events.length - 1]?.t ?? 0,
    failedReqs,
    errs,
    navs,
  };
}

describe("attributeCandidates — classification", () => {
  it("classifies a backend root, its FE symptom, and an isolated candidate", () => {
    const graph = buildCausalGraph({ events: express500Events });
    const attribution = attributeCandidates(
      graph,
      [
        { id: "root", anchor: { t: 300, requestId: "req1" } },
        { id: "symptom", anchor: { t: 400 } },
        { id: "lonely", anchor: { t: 999999 } },
      ],
      (id) =>
        id === "root"
          ? "backend_request_error"
          : id === "symptom"
            ? "uncaught_error"
            : "console_error",
    );

    expect(attribution.get("root")!.causalRole).toBe("root");
    expect(attribution.get("symptom")!.causalRole).toBe("symptom");
    expect(attribution.get("symptom")!.rootCauseId).toBe("root");
    expect(attribution.get("symptom")!.attributionConfidence).toBeDefined();
    expect(attribution.get("lonely")!.causalRole).toBe("isolated");
    expect(attribution.get("root")!.causes).toEqual(["symptom"]);
  });

  it("empty graph → all isolated", () => {
    const graph = buildCausalGraph({ events: [] });
    const attribution = attributeCandidates(graph, [
      { id: "a", anchor: { t: 1 } },
    ]);
    expect(attribution.get("a")!.causalRole).toBe("isolated");
  });

  /**
   * Node ownership is an allowlist, and an unrecognised detector takes the UNPRIVILEGED default.
   * A future detector that merely surfaces a plane must not silently outrank the named failures it
   * ties with; the failure mode of forgetting to list a detector has to be "no claim", never "wins".
   * Both candidates below anchor on the same instant and the same request, and the unknown one is
   * given the alphabetically smaller id so it would win a bare id tie-break.
   */
  it("an unknown detector does not win node contention against a named failure", () => {
    const graph = buildCausalGraph({ events: express500Events });
    const attribution = attributeCandidates(
      graph,
      [
        { id: "aaa_unknown", anchor: { t: 300, requestId: "req1" } },
        { id: "zzz_named", anchor: { t: 300, requestId: "req1" } },
      ],
      (id) =>
        id === "aaa_unknown" ? "future_plane_probe" : "db_field_divergence",
    );

    expect(attribution.get("zzz_named")!.causalRole).not.toBe("isolated");
    expect(attribution.get("aaa_unknown")!.causalRole).toBe("isolated");
  });

  it("is invariant to candidate input order (shuffle → identical mapping)", () => {
    const graph = buildCausalGraph({ events: express500Events });
    const cands = [
      { id: "root", anchor: { t: 300, requestId: "req1" } },
      { id: "symptom", anchor: { t: 400 } },
    ];
    const detector = (id: string) =>
      id === "root" ? "backend_request_error" : "uncaught_error";
    const a = attributeCandidates(graph, cands, detector);
    const b = attributeCandidates(graph, [...cands].reverse(), detector);
    expect(JSON.stringify([...a.entries()].sort())).toBe(
      JSON.stringify([...b.entries()].sort()),
    );
  });
});

describe("buildEvidenceCandidates — Express-500 causal re-rank", () => {
  it("ranks the backend root above the FE symptom and tags the symptom", () => {
    const graph = buildCausalGraph({ events: express500Events });
    const index = buildIndexFor(express500Events);
    const candidates = buildEvidenceCandidates(express500Events, index, graph);

    expect(candidates[0].detector).toBe("backend_request_error");
    expect(candidates[0].causalRole).toBe("root");

    const feSymptom = candidates.find((c) => c.detector === "uncaught_error")!;
    expect(feSymptom.causalRole).toBe("symptom");
    expect(feSymptom.rootCauseId).toBe(candidates[0].id);

    // Ordering: the backend root strictly precedes the FE symptom.
    const rootIdx = candidates.findIndex(
      (c) => c.detector === "backend_request_error",
    );
    const symptomIdx = candidates.findIndex(
      (c) => c.detector === "uncaught_error",
    );
    expect(rootIdx).toBeLessThan(symptomIdx);
  });

  it("does NOT mutate the emitted score field (ranking-only boost)", () => {
    const graph = buildCausalGraph({ events: express500Events });
    const index = buildIndexFor(express500Events);
    const candidates = buildEvidenceCandidates(express500Events, index, graph);
    const root = candidates.find(
      (c) => c.detector === "backend_request_error",
    )!;
    expect(root.score).toBe(90); // unchanged by the blast boost
  });

  it("behaves exactly as today when no graph is supplied (untagged)", () => {
    const index = buildIndexFor(express500Events);
    const withoutGraph = buildEvidenceCandidates(express500Events, index);
    for (const c of withoutGraph) {
      expect(c.causalRole).toBeUndefined();
      expect(c.rootCauseId).toBeUndefined();
      expect(c.causes).toBeUndefined();
    }
  });

  it("produces byte-identical candidates.jsonl-equivalent JSON across two runs", () => {
    const graph = buildCausalGraph({ events: express500Events });
    const index = buildIndexFor(express500Events);
    const a = JSON.stringify(
      buildEvidenceCandidates(express500Events, index, graph),
    );
    const b = JSON.stringify(
      buildEvidenceCandidates(express500Events, index, graph),
    );
    expect(a).toBe(b);
  });
});

describe("buildEvidenceCandidates — gate behavior", () => {
  // Build a session where the symptom→root link is a high-confidence symptom edge (within 500ms).
  it("high-confidence symptom is collapsed below the root but still emitted", () => {
    const graph = buildCausalGraph({ events: express500Events });
    const index = buildIndexFor(express500Events);
    const candidates = buildEvidenceCandidates(express500Events, index, graph);
    const feSymptom = candidates.find((c) => c.detector === "uncaught_error")!;
    expect(feSymptom.attributionConfidence).toBe("high");
    // still present in output
    expect(feSymptom).toBeDefined();
    // Nothing causes this symptom, so no hoist reaches it and the tier holds: not ranked[0] here.
    // That is a fact about THIS session, not a general guarantee — see the cross-tier hoist test.
    expect(candidates[0].id).not.toBe(feSymptom.id);
  });

  /**
   * A high-confidence symptom is bound into its root's chain, and the chain is placed by its
   * strongest member — so the named failure sits directly under its own cause, ABOVE unrelated
   * roots that score lower. The `low` link hanging off it binds nothing and ranks on its own score.
   *
   * Pinned because the failure mode is silent: an earlier design partitioned high/medium symptoms
   * into a demoted tier and then undid it with a corrective sweep, and any change that lets a
   * symptom's grade set position again buries the named failure under whatever happened first.
   */
  it("keeps a symptom under its own cause and above lower-scoring unrelated roots", () => {
    const write = (t: number, requestId: string, table: string): BugEvent => ({
      t,
      k: "db.diff",
      d: {
        engine: "postgres",
        op: "insert",
        table,
        pk: { id: 1 },
        after: { id: 1 },
        requestId,
      },
    });
    // One failing request whose error precedes its writes, so the spine hop error -> first write is
    // a high-confidence `request` edge, while write -> write is clamped to low.
    const events: BugEvent[] = [
      {
        t: 100,
        k: "backend.req.error",
        d: {
          requestId: "req-checkout",
          method: "POST",
          route: "/checkout",
          statusCode: 500,
          error: { name: "Error", message: "pricing upstream failed" },
        },
      },
      write(300, "req-checkout", "orders"),
      write(310, "req-checkout", "order_items"),
      // Unrelated background drain, far enough away to carry no error linkage at all.
      write(90_000, "req-drain", "shipments"),
    ];
    const candidates = buildEvidenceCandidates(
      events,
      { start: 0 },
      buildCausalGraph({ events }),
    );

    // Match on " on <table>" so `orders` cannot also match `order_items`.
    const at = (table: string) =>
      candidates.findIndex((c) => c.title.includes(` on ${table}`));
    const get = (table: string) => candidates[at(table)];
    const backendAt = candidates.findIndex((c) =>
      c.detector.startsWith("backend_"),
    );

    const bound = get("orders");
    const sequenced = get("order_items");
    const unrelatedRoot = get("shipments");

    // Preconditions: `bound` is a high (credited) symptom of the backend error, so the two share a
    // chain; `sequenced` names `bound` as its root through a low (uncredited) link; `unrelatedRoot`
    // is a root of its own, scoring the same as the two writes.
    expect(bound.causalRole).toBe("symptom");
    expect(bound.attributionConfidence).toBe("high");
    expect(sequenced.causalRole).toBe("symptom");
    expect(sequenced.attributionConfidence).toBe("low");
    expect(sequenced.rootCauseId).toBe(bound.id);
    expect(unrelatedRoot.causalRole).toBe("root");

    // The chain is contiguous and led by its root: `bound` sits immediately under the cause it was
    // attributed to, not wherever its own grade would have put it.
    expect(backendAt).toBeGreaterThanOrEqual(0);
    expect(at("orders")).toBe(backendAt + 1);
    // The write merely sequenced behind it, and the unrelated root, both rank below.
    expect(at("orders")).toBeLessThan(at("order_items"));
    expect(at("orders")).toBeLessThan(at("shipments"));
  });

  it("blast boost is bounded by MAX_BLAST_BOOST", () => {
    // Many high-severity symptoms attributed to one root must not push its ranking score up without
    // bound; cap is MAX_BLAST_BOOST.
    expect(CAUSAL_RANK_CONSTANTS.MAX_BLAST_BOOST).toBe(12);
    expect(CAUSAL_RANK_CONSTANTS.SEVERITY_WEIGHT.high).toBe(3);
  });
});

describe("buildEvidenceCandidates — write-to-write causal claims are weakened", () => {
  /**
   * A request's spine chains its nodes in time order, so one write is joined to the next by a
   * high-confidence `request` edge. Ordering, not causation — so the causal claim drawn through it is
   * clamped to `low`.
   *
   * `backend.req.end` shares the last write's millisecond here, which used to hand that write the
   * node for the request's END instead of the node for itself — the requestId match took the nearest
   * node and broke the tie on node id, where `backend.req` sorts under `db.write`. The tie now
   * prefers a kind the detector describes, so each write reaches its own node; the assertions below
   * are unchanged and pin that the third write is clamped like its siblings either way.
   */
  const write = (t: number, table: string): BugEvent => ({
    t,
    k: "db.diff",
    d: {
      engine: "postgres",
      op: "insert",
      table,
      pk: { id: 1 },
      after: { id: 1 },
      requestId: "req1",
    },
  });
  const events: BugEvent[] = [
    {
      t: 100,
      k: "net.req",
      d: {
        id: "n1",
        requestId: "req1",
        url: "https://api.test/checkout",
        m: "POST",
      },
    },
    { t: 110, k: "backend.req.start", d: { requestId: "req1", route: "/c" } },
    write(200, "orders"),
    write(210, "order_items"),
    write(220, "jobs"),
    { t: 220, k: "backend.req.end", d: { requestId: "req1", route: "/c" } },
  ];

  it("clamps the write sharing a millisecond with the request's end like its siblings", () => {
    const candidates = buildEvidenceCandidates(
      events,
      { start: 0 },
      buildCausalGraph({ events }),
    );
    // Match on " on <table>" so `orders` cannot also match `order_items`.
    const byTable = (table: string) =>
      candidates.find((c) => c.title.includes(` on ${table}`))!;

    // Sibling writes, clamped through two db.write nodes.
    expect(byTable("order_items").attributionConfidence).toBe("low");
    // The one contending with `backend.req.end` for its millisecond. Same claim, same clamp.
    expect(byTable("jobs").causalRole).toBe("symptom");
    expect(byTable("jobs").rootCauseId).toBe(byTable("order_items").id);
    expect(byTable("jobs").attributionConfidence).toBe("low");
  });

  /**
   * The tie-break decides ownership only when the nodes are equidistant — time still dominates, so a
   * write cannot be pulled onto a distant node of the right kind. Pinned as the guard on that: the
   * request's end is nearer than either write, so it wins on time and the candidate lands there
   * anyway. `isDbWriteEnd` reading the OWNING CANDIDATE, not just the node kind, is what keeps the
   * claim clamped when that happens.
   */
  it("still clamps when a write's nearest node is not a write at all", () => {
    const spread: BugEvent[] = [
      { t: 100, k: "backend.req.start", d: { requestId: "req1", route: "/c" } },
      write(200, "orders"),
      { t: 215, k: "backend.req.end", d: { requestId: "req1", route: "/c" } },
      write(230, "jobs"),
    ];
    const graph = buildCausalGraph({ events: spread });
    const attribution = attributeCandidates(
      graph,
      [
        { id: "c_orders", anchor: { t: 200, requestId: "req1" } },
        // Anchored on the request's end, nearer to `backend.req` than to either write.
        { id: "c_stray", anchor: { t: 215, requestId: "req1" } },
      ],
      () => "db_mutation",
    );

    const stray = attribution.get("c_stray")!;
    expect(stray.causalRole).toBe("symptom");
    expect(stray.rootCauseId).toBe("c_orders");
    expect(stray.attributionConfidence).toBe("low");
  });

  /**
   * The per-hop clamp only sees ADJACENT nodes, so anything the request emits between two writes
   * splits the write-to-write hop in two and both halves grade `high`. A single OTLP span is enough,
   * and a real checkout emits several. That is how the client-supplied-total finding was published
   * as an established effect of an unrelated inventory decrement.
   */
  it("clamps a write-to-write claim that a span was emitted in the middle of", () => {
    const spanned: BugEvent[] = [
      { t: 100, k: "backend.req.start", d: { requestId: "req1", route: "/c" } },
      write(200, "products"),
      {
        t: 205,
        k: "backend.otel.span",
        d: {
          traceId: "req1",
          spanId: "s1",
          name: "POST",
          kind: 2,
          serviceName: "pricing",
          statusCode: "UNSET",
        },
      },
      write(210, "orders"),
      { t: 220, k: "backend.req.end", d: { requestId: "req1", route: "/c" } },
    ];
    const candidates = buildEvidenceCandidates(
      spanned,
      { start: 0 },
      buildCausalGraph({ events: spanned }),
    );
    const orders = candidates.find((c) => c.title.includes(" on orders"))!;
    const products = candidates.find((c) => c.title.includes(" on products"))!;
    // Neither hop of products -> span -> orders is write-to-write, so only a clamp applied to the
    // claim's two ends can catch this.
    expect(orders.rootCauseId).toBe(products.id);
    expect(orders.attributionConfidence).toBe("low");
  });

  it("leaves the request's entry hop alone — that one is not write-to-write", () => {
    const candidates = buildEvidenceCandidates(
      events,
      { start: 0 },
      buildCausalGraph({ events }),
    );
    // orders is caused by the backend.req node that opened the request, which bears no candidate and
    // is not a write. Nothing to weaken there.
    expect(
      candidates.find((c) => c.title.includes(" on orders"))!
        .attributionConfidence,
    ).toBe("high");
  });
});

describe("attributeCandidates — a write detector reaches only its own write", () => {
  /**
   * Two candidates describe the SAME write, so one loses the node. The loser used to take the
   * nearest unowned `db.write`, which is a DIFFERENT write of the same request — and that displaced
   * write's own candidate then took the next one, and so on down the request. The emitted chain
   * became write order shifted by a slot, which is how a candidate came to name as its cause a write
   * that happened after it.
   */
  const events: BugEvent[] = [
    { t: 100, k: "backend.req.start", d: { requestId: "req1", route: "/c" } },
    ...["orders", "order_items", "jobs"].map((table, i): BugEvent => ({
      t: 200 + i * 10,
      k: "db.diff",
      d: {
        engine: "postgres",
        op: "insert",
        table,
        pk: { id: 1 },
        after: { id: 1 },
        requestId: "req1",
      },
    })),
  ];

  it("leaves a displaced write isolated rather than on a neighbour's node", () => {
    const graph = buildCausalGraph({ events });
    // Two candidates on the FIRST write (t=200): a named failure and the generic plane surfacing.
    const attribution = attributeCandidates(
      graph,
      [
        { id: "named", anchor: { t: 200, requestId: "req1" } },
        { id: "generic", anchor: { t: 200, requestId: "req1" } },
        { id: "second_write", anchor: { t: 210, requestId: "req1" } },
      ],
      (id) => (id === "named" ? "db_field_divergence" : "db_mutation"),
    );

    // The named failure owns the write they share.
    expect(attribution.get("named")!.causalRole).not.toBe("isolated");
    // The loser does NOT wander onto the next write.
    expect(attribution.get("generic")!.causalRole).toBe("isolated");
    // ...which leaves that next write's own candidate free to claim it.
    expect(attribution.get("second_write")!.rootCauseId).toBe("named");
  });

  it("gives db_client_supplied_value the node on priority, not on dedupe-key alphabet", () => {
    const graph = buildCausalGraph({ events });
    // `db_client_supplied_value` and `db_mutation` ALWAYS tie: both anchor on the same db.diff. The
    // named failure must own the node whichever way the ids happen to sort, so this gives the
    // generic twin the alphabetically smaller id — the one that would win a bare id tie-break.
    const attribution = attributeCandidates(
      graph,
      [
        { id: "aaa_generic", anchor: { t: 200, requestId: "req1" } },
        { id: "zzz_client_value", anchor: { t: 200, requestId: "req1" } },
      ],
      (id) =>
        id === "zzz_client_value" ? "db_client_supplied_value" : "db_mutation",
    );

    expect(attribution.get("zzz_client_value")!.causalRole).not.toBe(
      "isolated",
    );
    expect(attribution.get("aaa_generic")!.causalRole).toBe("isolated");
  });
});

describe("buildEvidenceCandidates — console_warning must not steal a console.error node", () => {
  // Regression: warn-level `con` events never become graph nodes, so a console_warning candidate has
  // no node of its own. It must stay isolated instead of temporal-matching (and stealing) a real
  // console.error node that belongs to a genuine console_error candidate — otherwise the benign
  // warning is tagged the backend root's symptom while the real error drops to isolated.
  const events: BugEvent[] = [
    {
      t: 100,
      k: "net.req",
      d: {
        id: "n1",
        requestId: "req1",
        url: "https://api.test/checkout",
        m: "POST",
        route: "/checkout",
      },
    },
    {
      t: 150,
      k: "backend.req.start",
      d: { requestId: "req1", method: "POST", route: "/checkout" },
    },
    {
      t: 200,
      k: "backend.req.error",
      d: {
        requestId: "req1",
        method: "POST",
        route: "/checkout",
        statusCode: 500,
        error: { name: "TypeError", message: "boom" },
      },
    },
    { t: 250, k: "net.res", d: { id: "n1", requestId: "req1", st: 500 } },
    {
      t: 300,
      k: "con",
      d: {
        lv: "warn",
        msg: 'Warning: Each child in a list should have a unique "key" prop.',
      },
    },
    {
      t: 400,
      k: "con",
      d: { lv: "error", msg: "Checkout failed unexpectedly" },
    },
  ];

  function indexFor(evs: BugEvent[]) {
    const failedReqs = evs
      .filter(
        (e) =>
          e.k === "net.res" &&
          typeof e.d.st === "number" &&
          (e.d.st as number) >= 400,
      )
      .map((e) => ({
        t: e.t,
        st: e.d.st as number,
        reason: "http_status" as string,
      }));
    const consoleErrors = evs
      .filter(
        (e) =>
          e.k === "con" &&
          String((e.d as { lv?: unknown }).lv).startsWith("err"),
      )
      .map((e) => ({
        t: e.t,
        lv: "err",
        msg: String((e.d as { msg?: unknown }).msg ?? ""),
      }));
    return {
      start: evs[0].t,
      end: evs[evs.length - 1].t,
      failedReqs,
      consoleErrors,
      navs: [] as Array<{ t: number; to?: string }>,
    };
  }

  it("attributes the genuine console_error to the backend root and leaves the warning isolated", () => {
    const graph = buildCausalGraph({ events });
    const candidates = buildEvidenceCandidates(events, indexFor(events), graph);

    const backendRoot = candidates.find(
      (c) => c.detector === "backend_request_error",
    )!;
    const consoleErr = candidates.find((c) => c.detector === "console_error")!;
    const consoleWarn = candidates.find(
      (c) => c.detector === "console_warning",
    )!;

    expect(backendRoot.causalRole).toBe("root");
    expect(consoleErr.causalRole).toBe("symptom");
    expect(consoleErr.rootCauseId).toBe(backendRoot.id);
    expect(consoleWarn.causalRole).toBe("isolated");
    expect(backendRoot.causes).toContain(consoleErr.id);
    expect(backendRoot.causes ?? []).not.toContain(consoleWarn.id);
  });
});
