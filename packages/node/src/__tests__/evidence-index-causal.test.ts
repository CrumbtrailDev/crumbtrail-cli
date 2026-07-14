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
    // never ranked[0]
    expect(candidates[0].id).not.toBe(feSymptom.id);
  });

  it("blast boost is bounded by MAX_BLAST_BOOST", () => {
    // Many high-severity symptoms attributed to one root must not push its ranking score up without
    // bound; cap is MAX_BLAST_BOOST.
    expect(CAUSAL_RANK_CONSTANTS.MAX_BLAST_BOOST).toBe(12);
    expect(CAUSAL_RANK_CONSTANTS.SEVERITY_WEIGHT.high).toBe(3);
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
