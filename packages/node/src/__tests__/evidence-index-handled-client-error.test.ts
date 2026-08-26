import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

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
) {
  return buildEvidenceCandidates(
    [...failures.map((entry) => entry.event), ...events].sort(
      (a, b) => a.t - b.t,
    ),
    {
      start: 900,
      failedReqs: failures.map((entry) => entry.failedReq) as never,
    },
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
