import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  buildEvidenceCandidates,
  CAUSAL_RANK_CONSTANTS,
  DB_WRITE_RANK,
  type EvidenceCandidate,
} from "../evidence-index";

/**
 * Real capture, trimmed to the events that drive database-write ranking.
 *
 * Source: local session `ses_20260723_160942_5cb9d594a635` (playground checkout, 2026-07-23). A
 * retry storm with no idempotency key wrote two identical `coupon_redemptions` rows for one order
 * 1ms apart under a single requestId, while a transient pricing 500 in the same request raised an
 * OTel span error. Three unrelated writes from a background job drain land ~3s later under a
 * different request id.
 *
 * Kept verbatim from `events.ndjson`: the ERROR span and all nine `db.diff` rows. Everything else
 * (navigation, perf, storage, heartbeats, successful spans) is dropped because it does not
 * participate in this ranking.
 */
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/sessions/retry-storm-duplicate-write.ndjson",
);

const CHECKOUT_REQUEST = "fbf3b6666c405d6e976de328042040a3";
const DRAIN_REQUEST = "backend_req_mrxy3swz_34hstvj1";
/** The pricing 500 that raised the OTel span error, in the checkout request. */
const ERROR_T = 1784837398387;

function loadFixture(): BugEvent[] {
  return fs
    .readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BugEvent);
}

function mutations(candidates: EvidenceCandidate[]): EvidenceCandidate[] {
  return candidates.filter((c) => c.detector === "db_mutation");
}

function byTable(
  candidates: EvidenceCandidate[],
  table: string,
): EvidenceCandidate[] {
  return mutations(candidates).filter((c) =>
    (c.anchor.message ?? "").endsWith(` ${table}`),
  );
}

/** A minimal `db.diff` row, for the synthetic linkage cases. */
function write(t: number, requestId: string | undefined, table: string) {
  return {
    t,
    k: "db.diff",
    d: {
      op: "insert",
      table,
      pk: { id: t },
      after: { id: t },
      ...(requestId === undefined ? {} : { requestId }),
    },
  } as BugEvent;
}

describe("database write ranking against errors (real session)", () => {
  const events = loadFixture();
  const candidates = buildEvidenceCandidates(events, { start: ERROR_T });

  it("emits one candidate per captured db.diff, losing none", () => {
    expect(events.filter((e) => e.k === "db.diff")).toHaveLength(9);
    expect(mutations(candidates)).toHaveLength(9);
  });

  it("gives every write of the failing request one shared rank", () => {
    const inRequest = mutations(candidates)
      .filter((c) => c.anchor.requestId === CHECKOUT_REQUEST)
      .sort((a, b) => a.anchor.t - b.anchor.t);
    expect(inRequest).toHaveLength(6);
    expect(inRequest.map((c) => c.anchor.message)).toEqual([
      "update on products",
      "insert on orders",
      "insert on order_items",
      "insert on coupon_redemptions",
      "insert on coupon_redemptions",
      "insert on jobs",
    ]);

    // Deliberate. Ordering these against each other was tried and removed: the error precedes all
    // six, so any distance measure collapses to write order, and write order is an artifact of the
    // checkout code path. It ranked the two duplicate `coupon_redemptions` rows — the actual defect
    // — below the innocent `products` update purely because checkout writes coupons last.
    // Separating them needs an observable property of the rows, which is a detector's job.
    expect(new Set(inRequest.map((c) => c.score))).toEqual(
      new Set([DB_WRITE_RANK.LINKED_SCORE]),
    );
    expect(new Set(inRequest.map((c) => c.severity))).toEqual(
      new Set(["medium"]),
    );
    expect(new Set(inRequest.map((c) => c.confidence))).toEqual(
      new Set(["medium"]),
    );
  });

  it("places the linked rank exactly where it is meant to sit among its neighbours", () => {
    // Read each neighbour's score off the detector that emits it, rather than restating a literal
    // here that can drift away from the file it describes.
    const scoreOf = (events: BugEvent[], detector: string): number => {
      const candidate = buildEvidenceCandidates(events, {
        start: 1000,
        failedReqs: [{ t: 1200, m: "GET", url: "/api/cart", st: 404 }],
      }).find((c) => c.detector === detector);
      expect(candidate, `expected a ${detector} candidate`).toBeDefined();
      return candidate!.score;
    };

    // qty=1 in the payload but inventory.stock moved by 2: the strongest db-plane signal.
    const deltaMismatch = scoreOf(
      [
        {
          t: 1000,
          k: "net.req",
          d: {
            id: "r1",
            m: "POST",
            url: "https://shop.example/api/orders",
            body: JSON.stringify({ productId: 7, qty: 1 }),
          },
        },
        { t: 1100, k: "net.res", d: { id: "r1", st: 200 } },
        {
          t: 1050,
          k: "db.diff",
          d: {
            engine: "postgres",
            op: "update",
            table: "inventory",
            pk: { id: 7 },
            requestId: "r1",
            before: { id: 7, stock: 25 },
            after: { id: 7, stock: 23 },
          },
        },
      ],
      "db_delta_mismatch",
    );
    // A 4xx the client saw, and the same 4xx as the backend recorded it.
    const clientHttpError = scoreOf(
      [{ t: 1200, k: "net.res", d: { id: "r2", st: 404 } }],
      "http_error",
    );
    const backendHttpClientError = scoreOf(
      [
        {
          t: 1300,
          k: "backend.req.end",
          d: {
            requestId: "r3",
            method: "GET",
            route: "/api/cart",
            statusCode: 404,
          },
        },
      ],
      "backend_http_client_error",
    );

    // A write that merely landed in a failing request is weaker evidence than an observed data
    // inconsistency or than the failure the client actually saw, so it must lead neither.
    expect(DB_WRITE_RANK.LINKED_SCORE).toBeLessThan(deltaMismatch);
    expect(DB_WRITE_RANK.LINKED_SCORE).toBeLessThan(clientHttpError);
    // Deliberate tie, asserted rather than left to chance. `backend_http_client_error` is the same
    // claim in a different plane — a request the backend answered 4xx is worth reading, not proof
    // of a defect — so ranking the two apart would assert a difference that is not there. Nothing
    // in this file gives scores distinct values (`repeated_clicks` alone spans 58..65, over
    // `console_error`'s 58 and the OTel 60s), so "pick an unoccupied number" is not an invariant
    // available to hold; stating the relationship is.
    expect(DB_WRITE_RANK.LINKED_SCORE).toBe(backendHttpClientError);
    // And clearly separated from a write with no link at all.
    expect(DB_WRITE_RANK.LINKED_SCORE).toBeGreaterThan(
      DB_WRITE_RANK.STANDALONE_SCORE,
    );
  });

  it("does not promote a different request's writes on time proximity alone", () => {
    const drain = mutations(candidates).filter(
      (c) => c.anchor.requestId === DRAIN_REQUEST,
    );
    expect(drain).toHaveLength(3);
    // ~3s after the error and in another request: outside PROXIMITY_MS, so standalone.
    for (const c of drain) {
      expect(c.anchor.t - ERROR_T).toBeGreaterThan(DB_WRITE_RANK.PROXIMITY_MS);
      expect(c.severity).toBe("low");
      expect(c.score).toBe(DB_WRITE_RANK.STANDALONE_SCORE);
      expect(c.title).not.toContain("near an error");
      expect(c.title).not.toContain("failing request");
    }
  });

  it("keeps the duplicate coupon rows ranked above the unrelated background write", () => {
    const coupons = byTable(candidates, "coupon_redemptions");
    const shipments = byTable(candidates, "shipments");
    expect(coupons).toHaveLength(2);
    expect(shipments).toHaveLength(1);
    for (const coupon of coupons) {
      expect(coupon.score).toBeGreaterThan(shipments[0].score);
    }
  });
});

describe("database write ranking — linkage rules", () => {
  const events = loadFixture();

  it("binds the proximity window to the causal graph's own edge window", () => {
    expect(DB_WRITE_RANK.PROXIMITY_MS).toBe(
      CAUSAL_RANK_CONSTANTS.MAP_WINDOW_MS,
    );
  });

  it("links a write to an error sharing its request id regardless of elapsed time", () => {
    // The real checkout writes, re-anchored 60s later: same request, still implicated.
    const shifted: BugEvent[] = events.map((event) =>
      event.k === "db.diff" &&
      (event.d as { requestId?: string }).requestId === CHECKOUT_REQUEST
        ? { ...event, t: event.t + 60_000 }
        : event,
    );
    const inRequest = mutations(
      buildEvidenceCandidates(shifted, { start: ERROR_T }),
    ).filter((c) => c.anchor.requestId === CHECKOUT_REQUEST);
    expect(inRequest).toHaveLength(6);
    for (const c of inRequest) {
      expect(c.score).toBe(DB_WRITE_RANK.LINKED_SCORE);
      // Unbounded in time, so the title may not claim the write is near anything.
      expect(c.title).toContain("in the failing request");
      expect(c.title).not.toContain("near an error");
    }
  });

  it("links a write with no shared request id only inside the proximity window", () => {
    const errorSpan = events.find((event) => event.k === "backend.otel.span")!;
    const near = mutations(
      buildEvidenceCandidates(
        [errorSpan, write(ERROR_T + 500, undefined, "shipments")],
        { start: ERROR_T },
      ),
    );
    expect(near).toHaveLength(1);
    expect(near[0].score).toBe(DB_WRITE_RANK.LINKED_SCORE);
    expect(near[0].title).toContain("near an error");

    // The window is inclusive at both ends of the rule: `rankDbWritesAgainstErrors` links at
    // `distance <= PROXIMITY_MS` and `clusterErrorMoments` chains at `gap <= PROXIMITY_MS`. Pinning
    // the exact boundary keeps the two from drifting apart into an off-by-one.
    const atBoundary = mutations(
      buildEvidenceCandidates(
        [
          errorSpan,
          write(ERROR_T + DB_WRITE_RANK.PROXIMITY_MS, undefined, "shipments"),
        ],
        { start: ERROR_T },
      ),
    );
    expect(atBoundary).toHaveLength(1);
    expect(atBoundary[0].score).toBe(DB_WRITE_RANK.LINKED_SCORE);
    expect(atBoundary[0].severity).toBe("medium");
    expect(atBoundary[0].title).toContain("near an error");

    const far = mutations(
      buildEvidenceCandidates(
        [
          errorSpan,
          write(
            ERROR_T + DB_WRITE_RANK.PROXIMITY_MS + 1,
            undefined,
            "shipments",
          ),
        ],
        { start: ERROR_T },
      ),
    );
    expect(far).toHaveLength(1);
    expect(far[0].score).toBe(DB_WRITE_RANK.STANDALONE_SCORE);
    expect(far[0].severity).toBe("low");
  });

  it("does not implicate a same-request write that landed before the error", () => {
    const errorSpan = events.find((event) => event.k === "backend.otel.span")!;
    const firstWrite = events.find(
      (event) =>
        event.k === "db.diff" &&
        (event.d as { requestId?: string }).requestId === CHECKOUT_REQUEST,
    )!;
    // Same request, but 10s before the failure: request membership alone is not evidence.
    const before: BugEvent[] = [
      { ...firstWrite, t: ERROR_T - 10_000 },
      errorSpan,
    ];
    const ranked = mutations(
      buildEvidenceCandidates(before, { start: ERROR_T - 10_000 }),
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].severity).toBe("low");
    expect(ranked[0].score).toBe(DB_WRITE_RANK.STANDALONE_SCORE);
  });

  it("links an OTel db span to an error sharing its traceId, unbounded in time", () => {
    // The OTel plane keys rule 1 on `traceId`, which can span a long-running job or a fan-out of
    // child spans, so it reaches further than `db.diff`'s `requestId`.
    const errorSpan = events.find((event) => event.k === "backend.otel.span")!;
    const dbSpan: BugEvent = {
      t: ERROR_T + 120_000,
      k: "backend.otel.span",
      d: {
        traceId: CHECKOUT_REQUEST,
        spanId: "aaaaaaaaaaaaaaaa",
        name: "pg.query",
        serviceName: "kartbug-server",
        statusCode: "OK",
        attributes: {
          "db.system": "postgresql",
          "db.operation": "INSERT",
          "db.statement":
            "insert into coupon_redemptions (order_id) values ($1)",
        },
      },
    };
    const activity = buildEvidenceCandidates([errorSpan, dbSpan], {
      start: ERROR_T,
    }).filter((c) => c.detector === "otel_db_activity");
    expect(activity).toHaveLength(1);
    expect(activity[0].score).toBe(DB_WRITE_RANK.LINKED_SCORE);
    expect(activity[0].severity).toBe("medium");
    // Two minutes after the failure: linked by trace membership, so it may not claim proximity.
    expect(activity[0].title).toContain("in the failing request");
    expect(activity[0].title).not.toContain("near an error");
  });

  it("surfaces every write at the standalone score when the session has no error", () => {
    const noError = events.filter((event) => event.k === "db.diff");
    const ranked = mutations(
      buildEvidenceCandidates(noError, { start: ERROR_T }),
    );
    expect(ranked).toHaveLength(9);
    expect(new Set(ranked.map((c) => c.score))).toEqual(
      new Set([DB_WRITE_RANK.STANDALONE_SCORE]),
    );
    expect(ranked.every((c) => c.severity === "low")).toBe(true);
  });
});

describe("database write ranking — one failure is one moment", () => {
  /**
   * One logical failure emits several error events milliseconds apart: the 5xx response, the
   * backend error record, and the console error it raises on the client. `collectErrorMoments`
   * emits each separately (and again from the pre-built index arrays), so before they were
   * collapsed a session could hold half a dozen "error moments" for one failure.
   */
  const burst: BugEvent[] = [
    { t: 1000, k: "net.res", d: { id: "n1", requestId: "req-1", st: 500 } },
    {
      t: 1003,
      k: "backend.req.error",
      d: { requestId: "req-1", statusCode: 500 },
    },
    { t: 1006, k: "con", d: { lv: "error", args: ["checkout failed"] } },
  ];
  const writes: BugEvent[] = [
    write(1010, "req-1", "orders"),
    // No request id at all: this one can only reach a failure through the proximity rule.
    write(1011, undefined, "order_items"),
    write(1012, "req-1", "jobs"),
  ];

  it("ranks writes identically whether the failure emitted one event or a burst", () => {
    const single = mutations(
      buildEvidenceCandidates([burst[0], ...writes], { start: 1000 }),
    ).sort((a, b) => a.anchor.t - b.anchor.t);
    const many = mutations(
      buildEvidenceCandidates([...burst, ...writes], { start: 1000 }),
    ).sort((a, b) => a.anchor.t - b.anchor.t);

    expect(single.map((c) => c.score)).toEqual(many.map((c) => c.score));
    expect(single.map((c) => c.severity)).toEqual(many.map((c) => c.severity));
  });

  it("gives request-linked and proximity-linked writes of one failure the same rank", () => {
    const ranked = mutations(
      buildEvidenceCandidates([...burst, ...writes], { start: 1000 }),
    ).sort((a, b) => a.anchor.t - b.anchor.t);
    expect(ranked).toHaveLength(3);
    expect(ranked.map((c) => c.score)).toEqual([
      DB_WRITE_RANK.LINKED_SCORE,
      DB_WRITE_RANK.LINKED_SCORE,
      DB_WRITE_RANK.LINKED_SCORE,
    ]);
    // The linkage rule still differs, and only the proximity branch may say "near an error".
    expect(ranked.map((c) => c.title)).toEqual([
      "Database insert on orders in the failing request",
      "Database insert on order_items near an error",
      "Database insert on jobs in the failing request",
    ]);
  });

  it("does not let errors interleaved between writes escalate any of them", () => {
    const interleaved: BugEvent[] = [
      burst[0],
      writes[0],
      { t: 1010, k: "con", d: { lv: "error", args: ["retry 1"] } },
      writes[1],
      { t: 1011, k: "con", d: { lv: "error", args: ["retry 2"] } },
      writes[2],
    ];
    const ranked = mutations(
      buildEvidenceCandidates(interleaved, { start: 1000 }),
    );
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked.map((c) => c.score))).toEqual(
      new Set([DB_WRITE_RANK.LINKED_SCORE]),
    );
    expect(new Set(ranked.map((c) => c.severity))).toEqual(new Set(["medium"]));
  });
});
