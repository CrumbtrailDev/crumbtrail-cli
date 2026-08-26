import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { buildCausalGraph } from "../causal-graph";

/** A failed response plus the failed-request index entry post-process emits. */
function failure(opts: {
  t: number;
  id: string;
  method: string;
  url: string;
  status: number;
  requestId?: string;
}): { event: BugEvent; failedReq: Record<string, unknown> } {
  return {
    event: {
      t: opts.t,
      k: "net.res",
      d: {
        id: opts.id,
        st: opts.status,
        ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
      },
    },
    failedReq: {
      t: opts.t,
      m: opts.method,
      url: opts.url,
      st: opts.status,
      id: opts.id,
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    },
  };
}

function build(
  failures: Array<ReturnType<typeof failure>>,
  events: BugEvent[] = [],
  withGraph = false,
) {
  const allEvents = [...failures.map((entry) => entry.event), ...events].sort(
    (a, b) => a.t - b.t,
  );
  return buildEvidenceCandidates(
    allEvents,
    {
      start: 900,
      failedReqs: failures.map((entry) => entry.failedReq) as never,
    },
    withGraph ? buildCausalGraph({ events: allEvents }) : undefined,
  );
}

describe("buildEvidenceCandidates — consumed client errors", () => {
  it("does not raise a client error that has no captured consequence", () => {
    const candidates = build(
      [
        failure({
          t: 1000,
          id: "r1",
          method: "GET",
          url: "/resource",
          status: 401,
        }),
      ],
      [
        // The application continued its normal page flow after consuming the
        // completed response. No error or retry followed it.
        { t: 1100, k: "net.req", d: { id: "r2", m: "GET", url: "/catalog" } },
        { t: 1200, k: "net.res", d: { id: "r2", st: 200 } },
      ],
    );

    expect(candidates.filter((c) => c.detector === "http_error")).toHaveLength(
      0,
    );
  });

  it("does not keep a client error for an unrelated candidate in the consequence window", () => {
    const candidates = build(
      [
        failure({
          t: 1000,
          id: "r1",
          method: "GET",
          url: "/api/me",
          status: 401,
        }),
      ],
      [
        // This is a separate database request, close enough to trigger the old
        // session-wide consequence test but unrelated to /api/me.
        {
          t: 2000,
          k: "db.read",
          d: { requestId: "reviews", table: "reviews", stmt: 1 },
        },
        {
          t: 2100,
          k: "db.read",
          d: { requestId: "reviews", table: "reviews", stmt: 2 },
        },
        {
          t: 2200,
          k: "db.read",
          d: { requestId: "reviews", table: "reviews", stmt: 3 },
        },
        {
          t: 2300,
          k: "db.read",
          d: { requestId: "reviews", table: "reviews", stmt: 4 },
        },
        {
          t: 2400,
          k: "db.read",
          d: { requestId: "reviews", table: "reviews", stmt: 5 },
        },
        {
          t: 2500,
          k: "db.read",
          d: { requestId: "reviews", table: "reviews", stmt: 6 },
        },
        {
          t: 2600,
          k: "db.read",
          d: { requestId: "reviews", table: "reviews", stmt: 7 },
        },
        {
          t: 2700,
          k: "db.read",
          d: { requestId: "reviews", table: "reviews", stmt: 8 },
        },
      ],
      true,
    );

    expect(
      candidates.find((c) => c.detector === "n_plus_one_query"),
    ).toBeDefined();
    expect(candidates.filter((c) => c.detector === "http_error")).toHaveLength(
      0,
    );
  });

  it("keeps a client error followed by a surfaced failure", () => {
    const candidates = build(
      [
        failure({
          t: 1000,
          id: "r1",
          method: "POST",
          url: "/checkout",
          status: 401,
        }),
      ],
      [
        {
          t: 1100,
          k: "con",
          d: { lv: "err", args: ["checkout could not continue"] },
        },
      ],
    );

    const http = candidates.find((c) => c.detector === "http_error");
    expect(http).toMatchObject({ severity: "medium", score: 70 });
  });

  it("always raises a 5xx, even when the client continues normally", () => {
    const candidates = build([
      failure({
        t: 1000,
        id: "r1",
        method: "POST",
        url: "/checkout",
        status: 500,
      }),
    ]);

    expect(candidates.find((c) => c.detector === "http_error")).toMatchObject({
      severity: "high",
      score: 90,
    });
  });

  it("keeps a retry of the same client-error operation visible", () => {
    const first = failure({
      t: 1000,
      id: "r1",
      method: "POST",
      url: "/checkout",
      status: 409,
    });
    const second = failure({
      t: 2000,
      id: "r2",
      method: "POST",
      url: "/checkout",
      status: 409,
    });

    const candidates = build([first, second], [
      { t: 1500, k: "net.req", d: { id: "r2", m: "POST", url: "/checkout" } },
    ]);

    expect(candidates.filter((c) => c.detector === "http_error")).toHaveLength(
      1,
    );
    expect(
      candidates.find((c) => c.detector === "http_error")?.occurrences,
    ).toBe(2);
  });
});
