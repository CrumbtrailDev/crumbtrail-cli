// Contention loss is a FIRST-CLASS OBSERVABLE, not an absence.
//
// Attribution is strictly one-candidate-per-node, and it settles a contest by
// ARRIVAL ORDER — `anchor.t`, then `ownershipPriority`, then id — never by which
// candidate the node actually describes. The loser used to fall out of
// `resolve()` as a bare `undefined`, indistinguishable from a candidate that had
// nothing to attach to, and `projectCausalChain` then reported both as
// `top_candidate_isolated`: "this signal could not be placed in the graph".
//
// That statement is false for the losers, and it was false often. Measured over
// `agent-eval/out/loop-2026-08-11` by replaying the allocator out of band: of
// 134 isolated candidates, 54 (40%) across 31 distinct scenarios were contention
// losses. The product could not say it about itself — only an out-of-band replay
// could — which is what these tests close.
//
// BOTH DIRECTIONS ARE PINNED, on purpose. The over-permissive failure is the
// dangerous one here: a change that labels EVERY isolated candidate a contention
// loser satisfies every positive assertion below and turns the reason string
// from wrong-40%-of-the-time into wrong-60%-of-the-time. The negative controls
// are what refuse it, so they are not decoration.
//
// This file asserts what is RECORDED. It deliberately asserts nothing new about
// what is ALLOCATED: no candidate isolated before is attributed now, and no
// candidate's node moves. The winners are checked for exactly that.

import { describe, expect, it } from "vitest";

import {
  attributeCandidates,
  buildCausalGraph,
  CAUSAL_GRAPH_SCHEMA_VERSION,
  type CausalGraph,
  type CausalNode,
} from "../causal-graph";
import { buildEvidenceCandidates, type EvidenceCandidate } from "../evidence-index";
import { projectCausalChain } from "../fix-context";
import type { BugEvent } from "crumbtrail-core";

function graphOf(nodes: CausalNode[]): CausalGraph {
  return { schemaVersion: CAUSAL_GRAPH_SCHEMA_VERSION, nodes, edges: [] };
}

/** One `net.res` for `req1`, the node two network-plane candidates will fight over. */
const ONE_RESPONSE = graphOf([
  {
    id: "net.res:350:r=req1",
    kind: "net.res",
    t: 350,
    requestId: "req1",
    brief: "res 500",
  },
]);

const signal = (over: Record<string, unknown>) =>
  ({
    schemaVersion: 1,
    id: "cand_0001",
    detector: "http_error",
    title: "GET /api/checkout returned 500",
    severity: "high",
    score: 90,
    confidence: "high",
    anchor: { t: 350 },
    ...over,
  }) as unknown as EvidenceCandidate;

// --- POSITIVE: the loser names the node it lost and who took it ------------------------------

describe("a candidate that LOST a node says so, and names the winner", () => {
  it("records the node, the incumbent and the precedence step (requestId)", () => {
    // Both candidates name request `req1`, and `req1` has exactly one node. The
    // earlier anchor wins by arrival order; the later one is the loser, and its
    // loss is the thing that used to be invisible.
    const attribution = attributeCandidates(
      ONE_RESPONSE,
      [
        { id: "incumbent", anchor: { t: 350, requestId: "req1" } },
        { id: "loser", anchor: { t: 360, requestId: "req1" } },
      ],
      (id) => (id === "incumbent" ? "http_error" : "displayed_field_mismatch"),
    );

    const loser = attribution.get("loser")!;
    expect(loser.causalRole).toBe("isolated");
    expect(loser.isolationCause).toBe("lost-contention");
    expect(loser.contention).toEqual({
      nodeId: "net.res:350:r=req1",
      heldBy: "incumbent",
      step: "requestId",
    });

    // THE FENCE. The winner is untouched: it still holds the node, it is not
    // isolated, and it carries no isolation record of its own. A change that
    // altered allocation instead of recording it fails here.
    const incumbent = attribution.get("incumbent")!;
    expect(incumbent.causalRole).not.toBe("isolated");
    expect(incumbent.isolationCause).toBeUndefined();
    expect(incumbent.contention).toBeUndefined();
  });

  it("records a loss at the temporal step as `temporal`", () => {
    // No requestId on either anchor, so precedence 1 never applies and the
    // contest happens entirely in step 2. The step is reported because the two
    // are different claims: a requestId loss means the node was picked by the
    // candidate's own request identity, a temporal one means only that the
    // clock put them close together.
    const attribution = attributeCandidates(
      graphOf([
        { id: "net.res:1000", kind: "net.res", t: 1000, brief: "res 500" },
      ]),
      [
        { id: "first", anchor: { t: 1000 } },
        { id: "second", anchor: { t: 1100 } },
      ],
      () => "http_error",
    );

    expect(attribution.get("first")!.causalRole).not.toBe("isolated");
    const second = attribution.get("second")!;
    expect(second.causalRole).toBe("isolated");
    expect(second.isolationCause).toBe("lost-contention");
    expect(second.contention).toEqual({
      nodeId: "net.res:1000",
      heldBy: "first",
      step: "temporal",
    });
  });

  it("projects a contention-distinct absence when the loser is ranked[0]", () => {
    // The product half. Same null chain as before — nothing is newly claimed —
    // but the reason no longer says the signal could not be placed, because it
    // could, and something else took it.
    const { chain, absence } = projectCausalChain([
      signal({
        id: "cand_0002",
        detector: "displayed_field_mismatch",
        causalRole: "isolated",
        isolationCause: "lost-contention",
        contention: {
          nodeId: "net.res:350:r=req1",
          heldBy: "cand_0001",
          step: "requestId",
        },
      }),
      signal({ id: "cand_0001", detector: "http_error", causalRole: "root" }),
    ]);

    expect(chain).toBeNull();
    expect(absence).toEqual({
      reason: "top_candidate_lost_contention",
      detector: "displayed_field_mismatch",
      signalId: "cand_0002",
      contendedNodeId: "net.res:350:r=req1",
      incumbentSignalId: "cand_0001",
      incumbentDetector: "http_error",
    });
  });

  it("still reports the contest when the incumbent is not in the emitted signals", () => {
    // The incumbent can be capped out of the emitted candidate set. The node and
    // the loss are still facts; only the incumbent's identity is unavailable, so
    // it is omitted rather than invented.
    const { absence } = projectCausalChain([
      signal({
        causalRole: "isolated",
        isolationCause: "lost-contention",
        contention: {
          nodeId: "net.res:350:r=req1",
          heldBy: "cand_9999",
          step: "temporal",
        },
      }),
    ]);

    expect(absence?.reason).toBe("top_candidate_lost_contention");
    expect(absence?.contendedNodeId).toBe("net.res:350:r=req1");
    expect(absence?.incumbentSignalId).toBeUndefined();
    expect(absence?.incumbentDetector).toBeUndefined();
  });

  it("does not contradict the signal when the contention payload was dropped", () => {
    // The emit block drops the whole `contention` record when the incumbent's
    // dedupeKey does not resolve to an emitted id, rather than shipping a
    // dangling reference — but it keeps the cause, which is still true. Keyed on
    // the payload instead of the cause, this signal would be reported "could not
    // be placed in the graph" while itself saying it lost a contest: the same
    // false statement this finding exists to remove, one field over.
    const { chain, absence } = projectCausalChain([
      signal({ causalRole: "isolated", isolationCause: "lost-contention" }),
    ]);

    expect(chain).toBeNull();
    expect(absence?.reason).toBe("top_candidate_lost_contention");
    expect(absence?.contendedNodeId).toBeUndefined();
    expect(absence?.incumbentSignalId).toBeUndefined();
  });
});

// --- NEGATIVE: a genuinely nodeless detector must NOT be called a loser ----------------------

describe("a genuinely isolated candidate carries NO contention record", () => {
  it("reports `no-node-family` for a detector with no node family, and the ORIGINAL absence reason", () => {
    // `user_marker` is one of the five detectors `findTemporalNode` names
    // explicitly: it has no causal node family and must stay isolated so it
    // never steals a request-spine node from the candidate that owns it. Its
    // isolation is CORRECT, and calling it a contention loss would be a new
    // false statement replacing the old one.
    //
    // The graph is deliberately POPULATED. `attributeCandidates` short-circuits
    // on an empty graph and hands back a bare `isolated` for everything, so a
    // control built on one would pass because of the short circuit rather than
    // because the family is empty — green for the wrong reason.
    //
    // The anchor deliberately carries NO requestId either. Precedence 1 does not
    // consult the node family at all — it matches on request identity and uses
    // the family only to break a tie — so a nodeless detector that anchors with a
    // requestId still takes that request's node and is NOT isolated. The empty
    // family gates step 2 and only step 2, which is the path this control has to
    // exercise.
    const attribution = attributeCandidates(
      ONE_RESPONSE,
      [{ id: "marker", anchor: { t: 350 } }],
      () => "user_marker",
    );

    const marker = attribution.get("marker")!;
    expect(marker.causalRole).toBe("isolated");
    expect(marker.isolationCause).toBe("no-node-family");
    expect(marker.contention).toBeUndefined();

    const { chain, absence } = projectCausalChain([
      signal({ detector: "user_marker", causalRole: "isolated" }),
    ]);
    expect(chain).toBeNull();
    expect(absence).toEqual({
      reason: "top_candidate_isolated",
      detector: "user_marker",
      signalId: "cand_0001",
    });
    expect(absence?.contendedNodeId).toBeUndefined();
  });

  it("reports `no-compatible-node` when the family exists and the session held no such node", () => {
    // The third cause, and the one that separates "nothing was there" from
    // "something was there and I lost it". `http_error` has a real family
    // (net.res/net.req) and this session contains only a database write, so
    // nothing was taken from this candidate — there was nothing to take.
    const attribution = attributeCandidates(
      graphOf([
        { id: "db.write:400", kind: "db.write", t: 400, brief: "insert orders" },
      ]),
      [{ id: "lonely", anchor: { t: 400 } }],
      () => "http_error",
    );

    const lonely = attribution.get("lonely")!;
    expect(lonely.causalRole).toBe("isolated");
    expect(lonely.isolationCause).toBe("no-compatible-node");
    expect(lonely.contention).toBeUndefined();
  });

  it("does NOT record a loss for a candidate that lost one contest and won another node", () => {
    // The silent over-fire. This candidate loses the requestId contest at
    // precedence 1 and then takes a free compatible node at precedence 2, so it
    // is ATTRIBUTED. A record attached at the moment of the loss rather than at
    // the moment of isolation would tag an attributed candidate as a loser.
    const attribution = attributeCandidates(
      graphOf([
        {
          id: "net.res:350:r=req1",
          kind: "net.res",
          t: 350,
          requestId: "req1",
          brief: "res 500",
        },
        { id: "net.req:360", kind: "net.req", t: 360, brief: "GET /x" },
      ]),
      [
        { id: "incumbent", anchor: { t: 350, requestId: "req1" } },
        { id: "loser_then_winner", anchor: { t: 360, requestId: "req1" } },
      ],
      () => "http_error",
    );

    const second = attribution.get("loser_then_winner")!;
    expect(second.causalRole).not.toBe("isolated");
    expect(second.isolationCause).toBeUndefined();
    expect(second.contention).toBeUndefined();
  });
});

// --- The record survives the pipeline, on a real captured shape ------------------------------

describe("the contention record reaches the emitted candidates", () => {
  it("carries cause and incumbent through to the artifact, in emitted candidate ids", () => {
    // The real, measured shape of this defect: one request writes two rows, a
    // named DB invariant (`db_field_divergence`) and the generic `db_mutation`
    // surfacing of the SAME write both anchor on it, and the named failure wins
    // by `ownershipPriority`. The generic one is the loser — the case
    // `ownershipPriority`'s own comment describes, previously reported as an
    // unexplained `isolated`.
    //
    // Without this test the two copy sites — the attribution copy loop and the
    // emit block in `evidence-index.ts` — could be unwired and every assertion
    // above would still pass: the field would be born invisible, which is a
    // defect this repo has already paid for once.
    const diff = (
      t: number,
      op: string,
      table: string,
      pk: Record<string, unknown>,
      after: Record<string, unknown>,
    ): BugEvent => ({
      t,
      k: "db.diff",
      d: { engine: "postgres", op, table, pk, after, requestId: "req-checkout" },
    });
    const events: BugEvent[] = [
      diff(1100, "update", "products", { id: 42 }, { id: 42, price_cents: 8900 }),
      diff(
        1200,
        "insert",
        "order_items",
        { id: 7 },
        { id: 7, product_id: 42, price_cents: 7900 },
      ),
    ];

    const graph = buildCausalGraph({ events });
    const emitted = buildEvidenceCandidates(events, { start: 1000 }, graph);

    const named = emitted.find((c) => c.detector === "db_field_divergence")!;
    const displaced = emitted.find(
      (c) => c.detector === "db_mutation" && c.anchor.t === 1100,
    )!;

    expect(named.causalRole).toBe("root");
    expect(displaced.causalRole).toBe("isolated");
    expect(displaced.isolationCause).toBe("lost-contention");
    expect(displaced.contention?.nodeId).toBe("db.write:1100:r=req-checkout");
    expect(displaced.contention?.step).toBe("requestId");
    // `heldBy` is a dedupeKey inside the attributor and an emitted candidate id
    // in the artifact. A reader must be able to resolve it against this list.
    expect(displaced.contention?.heldBy).toBe(named.id);
    expect(emitted.some((c) => c.id === displaced.contention?.heldBy)).toBe(true);
  });
});
