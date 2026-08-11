// A detector's node family is DERIVED from the evidence it anchored on, not
// looked up by name.
//
// `nodeKindsForDetector` is a hand-maintained switch, and its own history is
// four detectors added to it one at a time, each comment recording that it was
// the same defect being paid for again: a detector nobody remembered to map took
// the empty family, the temporal fallback had no compatible kind, and the
// candidate reported `causalRole: "isolated"` — dropping out of the incident
// thread and leaving `causal_chain` null.
//
// `derivedNodeKinds` closes that by construction for the planes an anchor can
// identify. These tests pin BOTH directions, because a change that attaches
// everything passes every "is it connected" assertion and destroys ranking:
// `net.req`/`net.res` sit on the request spine and are the most numerous nodes
// in a session.

import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";

import {
  attributeCandidates,
  buildCausalGraph,
  type CausalGraph,
} from "../causal-graph";
import { buildEvidenceCandidates } from "../evidence-index";

// --- End-to-end, over the SDK's own response_race fixture ------------------------------------

function req(
  id: string | number,
  t: number,
  url: string,
  method = "GET",
): BugEvent {
  return { t, k: "net.req", d: { id, url, method } } as unknown as BugEvent;
}

function res(id: string | number, t: number, st = 200): BugEvent {
  return { t, k: "net.res", d: { id, st } } as unknown as BugEvent;
}

/** The `response_race` fixture: typed "de", then "desk"; the narrower query answers last. */
const RACED: BugEvent[] = [
  req("a", 100, "http://x/api/search?q=de"),
  req("b", 150, "http://x/api/search?q=desk"),
  res("b", 200),
  res("a", 400),
];

function candidateFor(events: BugEvent[], detector: string) {
  const graph = buildCausalGraph({ events });
  return buildEvidenceCandidates(events, { start: 0 }, graph).find(
    (candidate) => candidate.detector === detector,
  );
}

describe("a network-plane detector nobody mapped still reaches its own plane", () => {
  it("attributes response_race to the request it names", () => {
    // `response_race` is in DETECTOR_ANCHORING_UNREVIEWED: no `case` names it and
    // no prefix covers it. Before the derivation it took the empty family and
    // reported isolated on this exact fixture. Its anchor carries `method` AND
    // `url` — a request line — which is what places it on the network planes.
    const candidate = candidateFor(RACED, "response_race");
    expect(candidate).toBeDefined();
    expect(candidate!.anchor.method).toBeDefined();
    expect(candidate!.anchor.url).toBeDefined();
    expect(candidate!.causalRole).toBeDefined();
    expect(candidate!.causalRole).not.toBe("isolated");
  });
});

// --- Both directions, at the attribution seam -------------------------------------------------
// Hand-built graphs so each rule is exercised in isolation and a failure names one rule.

function node(
  id: string,
  kind: CausalGraph["nodes"][number]["kind"],
  t: number,
  requestId?: string,
): CausalGraph["nodes"][number] {
  return { id, kind, t, brief: id, ...(requestId ? { requestId } : {}) };
}

function graphOf(nodes: CausalGraph["nodes"]): CausalGraph {
  return { schemaVersion: "causal-graph.v2", nodes, edges: [] };
}

function roleOf(
  graph: CausalGraph,
  detector: string,
  anchor: Record<string, unknown>,
): string {
  const attribution = attributeCandidates(
    graph,
    [{ id: "c1", anchor: anchor as never }],
    () => detector,
  );
  return attribution.get("c1")!.causalRole;
}

describe("a derived candidate lands on the right node, not merely on some node", () => {
  it("joins the thread as a symptom of the request that caused it", () => {
    // "Not isolated" is only half a proof. A rule that attaches a finding to the
    // WRONG node of the right family passes every "is it connected" assertion
    // and still destroys ranking. So this reads back WHERE the candidate landed,
    // through the one place attribution makes it observable: the causal roles.
    //
    // Two nodes of one request, joined by a request edge. The mapped detector
    // sits on the request; the DERIVED one sits on the response 400ms later. If
    // the derivation put `response_race` on the response, it is a symptom whose
    // root is the request candidate — and the request candidate names it back.
    // If it had grabbed the request node instead, the roles would invert.
    const graph: CausalGraph = {
      schemaVersion: "causal-graph.v2",
      nodes: [
        node("net.req:1000", "net.req", 1000),
        node("net.res:1400", "net.res", 1400),
      ],
      edges: [
        {
          from: "net.req:1000",
          to: "net.res:1400",
          kind: "request",
          confidence: "high",
        },
      ],
    };
    const attribution = attributeCandidates(
      graph,
      [
        { id: "the-request", anchor: { t: 1000 } as never },
        {
          id: "the-race",
          anchor: {
            t: 1400,
            method: "GET",
            url: "http://x/api/search",
          } as never,
        },
      ],
      (id) => (id === "the-race" ? "response_race" : "network_error"),
    );
    expect(attribution.get("the-race")).toEqual({
      causalRole: "symptom",
      rootCauseId: "the-request",
      attributionConfidence: "high",
    });
    expect(attribution.get("the-request")).toEqual({
      causalRole: "root",
      causes: ["the-race"],
    });
  });
});

describe("derivation attaches the planes an anchor identifies", () => {
  const NET_GRAPH = graphOf([node("net.res:1000", "net.res", 1000)]);

  it("places a request line on the network planes", () => {
    expect(
      roleOf(NET_GRAPH, "response_race", {
        t: 1000,
        method: "GET",
        url: "http://x/api/search",
      }),
    ).not.toBe("isolated");
  });

  it("places a database engine source on the write plane", () => {
    const graph = graphOf([node("db.write:1000", "db.write", 1000)]);
    expect(
      roleOf(graph, "fractional_cent_rounding", { t: 1000, source: "postgres" }),
    ).not.toBe("isolated");
  });

  it("places a named table on the write plane", () => {
    const graph = graphOf([node("db.write:1000", "db.write", 1000)]);
    expect(
      roleOf(graph, "existing_children_reparented_to_new_row", {
        t: 1000,
        table: "public.order_items",
      }),
    ).not.toBe("isolated");
  });

  it("covers every shipped database engine, not just postgres", () => {
    const graph = graphOf([node("db.write:1000", "db.write", 1000)]);
    for (const engine of ["postgres", "mysql", "mssql", "sqlite"]) {
      expect(
        roleOf(graph, "lost_update", { t: 1000, source: engine }),
        `engine ${engine} should reach the write plane`,
      ).not.toBe("isolated");
    }
  });
});

describe("derivation refuses the cases that would steal a node", () => {
  // Every graph here holds a node the candidate COULD have been handed. If a
  // test in this block ever goes green by attaching, the rule stopped
  // discriminating.
  const RICH_GRAPH = graphOf([
    node("net.res:1000", "net.res", 1000),
    node("net.req:1000", "net.req", 1000),
    node("backend.req:1000", "backend.req", 1000),
    node("db.write:1000", "db.write", 1000),
    node("console.error:1000", "console.error", 1000),
    node("user.click:1000", "user.click", 1000),
  ]);

  it("keeps console_warning isolated however its anchor is shaped", () => {
    // The reviewed decision in DETECTOR_ANCHORING_DECLARED outranks the
    // derivation. Warn-level `con` events never become nodes, so attaching one
    // could only ever steal a real console.error node from a genuine
    // console_error candidate — and the anchor shape must not be able to argue
    // its way past that.
    expect(
      roleOf(RICH_GRAPH, "console_warning", {
        t: 1000,
        method: "GET",
        url: "http://x/api/search",
        source: "postgres",
        table: "public.orders",
      }),
    ).toBe("isolated");
  });

  it("keeps runtime_warning isolated", () => {
    // `backend.warning` is absent from `nodeKindFor`, so a Node process warning
    // has no node. It is the single most frequent isolated detector in captured
    // sessions (57 of 127), which is exactly why a loose backend-plane rule
    // would have looked like a large win while handing 57 candidates the
    // `backend.req` node of the request that actually failed.
    expect(
      roleOf(RICH_GRAPH, "runtime_warning", { t: 1000, source: "backend" }),
    ).toBe("isolated");
  });

  it("does not treat `source: \"backend\"` as a plane rule", () => {
    // Deliberately not a rule: the `backend_` prefix already covers the
    // detectors that belong there. `downstream_succeeded_after_timeout` carries
    // the label and is not one of them.
    expect(
      roleOf(RICH_GRAPH, "downstream_succeeded_after_timeout", {
        t: 1000,
        source: "backend",
      }),
    ).toBe("isolated");
  });

  it("needs BOTH method and url, not either", () => {
    // `stale_view_after_pop` and `rtl_physical_layout_rules` carry a bare `url`
    // and are browser-plane findings. A disjunctive rule would put them on the
    // request spine.
    expect(
      roleOf(RICH_GRAPH, "stale_view_after_pop", {
        t: 1000,
        url: "http://x/products",
      }),
    ).toBe("isolated");
    expect(
      roleOf(RICH_GRAPH, "request_target_row_mismatch", {
        t: 1000,
        method: "POST",
      }),
    ).toBe("isolated");
  });

  it("leaves a browser-plane detector isolated, because no anchor field names its plane", () => {
    // Honest limit, not an oversight: `listener_growth` anchors with
    // `{t, offsetMs, route, message}` and nothing in that identifies a plane.
    // Reaching it means carrying the EVENT KIND a detector fired on down to its
    // anchor, which this change does not attempt.
    expect(
      roleOf(RICH_GRAPH, "listener_growth", {
        t: 1000,
        route: "http://x/products",
      }),
    ).toBe("isolated");
  });

  it("does not let `route` alone attach anything", () => {
    // `route` is on very nearly every anchor in the SDK. If it ever became a
    // signal, every candidate in a session would attach.
    expect(
      roleOf(RICH_GRAPH, "ui_arithmetic_mismatch", {
        t: 1000,
        route: "http://x/cart",
      }),
    ).toBe("isolated");
  });
});

describe("a derived write family carries the write discipline with it", () => {
  it("refuses a db.write node from another instant", () => {
    // The `ownWriteOnly` bar: a DB write detector names ONE write, and the
    // nearest unowned `db.write` is some OTHER write of the same request.
    // Handing it that node shifts the emitted chain by a slot. The bar reads the
    // RESOLVED family, so a detector that reached `db.write` by derivation is
    // barred exactly as the hand-listed ones are — otherwise the derivation
    // would reintroduce the cascade in the set nobody has hand-checked.
    const graph = graphOf([node("db.write:1500", "db.write", 1500)]);
    expect(
      roleOf(graph, "fractional_cent_rounding", { t: 1000, source: "postgres" }),
    ).toBe("isolated");
  });

  it("still takes the write at its own instant", () => {
    const graph = graphOf([node("db.write:1000", "db.write", 1000)]);
    expect(
      roleOf(graph, "fractional_cent_rounding", { t: 1000, source: "postgres" }),
    ).not.toBe("isolated");
  });
});

describe("the derivation never overrides an explicit decision", () => {
  it("keeps a mapped detector on its mapped family", () => {
    // `console_error` is mapped to `console.error`. Its anchor can carry a code
    // frame and a route; if the derivation ran first, a future anchor field
    // could silently move it onto the request spine.
    const graph = graphOf([
      node("net.res:1000", "net.res", 1000),
      node("console.error:1005", "console.error", 1005),
    ]);
    const attribution = attributeCandidates(
      graph,
      [
        {
          id: "c1",
          anchor: {
            t: 1000,
            method: "GET",
            url: "http://x/api/search",
          } as never,
        },
      ],
      () => "console_error",
    );
    // It reached the console.error node 5ms away rather than the net.res node it
    // was sitting on.
    expect(attribution.get("c1")!.causalRole).not.toBe("isolated");
    expect(graph.nodes.find((n) => n.kind === "net.res")).toBeDefined();
  });
});
