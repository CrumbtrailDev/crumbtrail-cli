import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// A 4xx the application deliberately returned is a protocol outcome, not a
// defect. Before this pass every status >= 400 became a medium/high-confidence
// candidate scoring 70, so a live session that signed in with bad credentials
// four times and rejected one expired coupon buried its only real defect (a
// console.warn naming a wrong persisted order total) under twelve rows of
// expected auth traffic.
//
// The rule graded here: an auth challenge (401/403), or any 4xx whose body is a
// structured error object, is demoted to low/low and grouped by route+status.
// Everything else — an unexplained 404, any 5xx — is untouched.

/** A failed request plus the net.res carrying its body, as post-process emits them. */
function failure(opts: {
  t: number;
  browserId: string;
  method: string;
  url: string;
  status: number;
  body?: string;
  /** Shared correlation id linking this to a backend request. */
  requestId?: string;
}): { event: BugEvent; failedReq: Record<string, unknown> } {
  return {
    event: {
      t: opts.t,
      k: "net.res",
      d: {
        id: opts.browserId,
        st: opts.status,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
      },
    },
    failedReq: {
      t: opts.t,
      m: opts.method,
      url: opts.url,
      st: opts.status,
      id: opts.browserId,
    },
  };
}

function build(
  failures: Array<ReturnType<typeof failure>>,
  extra: { events?: BugEvent[]; start?: number } = {},
) {
  const events = [
    ...failures.map((f) => f.event),
    ...(extra.events ?? []),
  ].sort((a, b) => a.t - b.t);
  return buildEvidenceCandidates(events, {
    start: extra.start ?? 900,
    failedReqs: failures.map((f) => f.failedReq) as never,
  });
}

describe("buildEvidenceCandidates — handled client errors", () => {
  it("demotes and groups four invalid-credential 401s into one low signal", () => {
    const candidates = build([
      failure({
        t: 1000,
        browserId: "b1",
        method: "POST",
        url: "/api/login",
        status: 401,
        body: '{"error":"invalid_credentials"}',
      }),
      failure({
        t: 2000,
        browserId: "b2",
        method: "POST",
        url: "/api/login",
        status: 401,
        body: '{"error":"invalid_credentials"}',
      }),
      failure({
        t: 3000,
        browserId: "b3",
        method: "POST",
        url: "/api/login",
        status: 401,
        body: '{"error":"invalid_credentials"}',
      }),
      failure({
        t: 4000,
        browserId: "b4",
        method: "POST",
        url: "/api/login",
        status: 401,
        body: '{"error":"invalid_credentials"}',
      }),
    ]);

    const http = candidates.filter((c) => c.detector === "http_error");
    expect(http).toHaveLength(1);
    expect(http[0].severity).toBe("low");
    expect(http[0].confidence).toBe("low");
    expect(http[0].score).toBeLessThanOrEqual(30);
    // The count survives the collapse: four attempts is materially different
    // from one, and dropping it would hide a credential-stuffing pattern.
    expect(http[0].occurrences).toBe(4);
    // Grouping keeps the earliest anchor so the window opens at the first hit.
    expect(http[0].anchor.t).toBe(1000);
  });

  it("demotes an auth challenge that carries no body at all", () => {
    // GET /api/me returning 401 for a logged-out visitor is the app working.
    const candidates = build([
      failure({
        t: 1000,
        browserId: "b1",
        method: "GET",
        url: "/api/me",
        status: 401,
      }),
    ]);

    const http = candidates.find((c) => c.detector === "http_error");
    expect(http?.severity).toBe("low");
    expect(http?.confidence).toBe("low");
  });

  it("demotes a 400 whose body is a structured error object", () => {
    const candidates = build([
      failure({
        t: 1000,
        browserId: "b1",
        method: "POST",
        url: "/api/checkout",
        status: 400,
        body: '{"error":"expired_coupon"}',
      }),
    ]);

    const http = candidates.find((c) => c.detector === "http_error");
    expect(http?.severity).toBe("low");
    expect(http?.score).toBeLessThanOrEqual(30);
  });

  it("leaves an unexplained 404 at full severity", () => {
    // No structured body and not an auth challenge: this may well be a routing
    // bug, so nothing here licenses calling it expected.
    const candidates = build([
      failure({
        t: 1000,
        browserId: "b1",
        method: "GET",
        url: "/api/jobs",
        status: 404,
      }),
    ]);

    const http = candidates.find((c) => c.detector === "http_error");
    expect(http?.severity).toBe("medium");
    expect(http?.score).toBe(70);
  });

  it("leaves a 500 with a structured body at full severity", () => {
    // A handler that formats its own crash is still a crash.
    const candidates = build([
      failure({
        t: 1000,
        browserId: "b1",
        method: "POST",
        url: "/api/checkout",
        status: 500,
        body: '{"error":"internal"}',
      }),
    ]);

    const http = candidates.find((c) => c.detector === "http_error");
    expect(http?.severity).toBe("high");
    expect(http?.score).toBe(90);
  });

  it("ranks a first-party console warning above every handled 4xx", () => {
    // The regression this whole pass exists for: the real defect was a
    // console.warn at rank 29 of 29, under twelve expected auth rows.
    const candidates = build(
      [
        failure({
          t: 1000,
          browserId: "b1",
          method: "POST",
          url: "/api/login",
          status: 401,
          body: '{"error":"invalid_credentials"}',
        }),
        failure({
          t: 2000,
          browserId: "b2",
          method: "POST",
          url: "/api/checkout",
          status: 400,
          body: '{"error":"expired_coupon"}',
        }),
      ],
      {
        events: [
          {
            t: 3000,
            k: "con",
            d: {
              lv: "warn",
              args: [
                "Total mismatch — persisted 107104¢ but server computed 91400¢",
              ],
            },
          },
        ],
      },
    );

    expect(candidates[0].detector).toBe("console_warning");
    const rank = (detector: string) =>
      candidates.findIndex((c) => c.detector === detector);
    expect(rank("console_warning")).toBeLessThan(rank("http_error"));
  });

  it("demotes a backend 4xx that shares a demoted request id", () => {
    // The same outcome observed on the backend plane must not survive at
    // medium after the frontend view of it was demoted, or one expected
    // rejection still produces two rows.
    const candidates = build(
      [
        failure({
          t: 2000,
          browserId: "b1",
          method: "POST",
          url: "/api/checkout",
          status: 400,
          body: '{"error":"expired_coupon"}',
          requestId: "shared-req-1",
        }),
      ],
      {
        events: [
          {
            t: 2000,
            k: "backend.req.end",
            d: {
              requestId: "shared-req-1",
              method: "POST",
              route: "/",
              statusCode: 400,
            },
          },
        ],
      },
    );

    const backend = candidates.find(
      (c) => c.detector === "backend_http_client_error",
    );
    expect(backend?.severity).toBe("low");
    expect(backend?.score).toBeLessThanOrEqual(30);
  });

  it("demotes a backend auth challenge on its own evidence", () => {
    const candidates = build([], {
      events: [
        {
          t: 2000,
          k: "backend.req.end",
          d: {
            requestId: "shared-req-2",
            method: "POST",
            route: "/login",
            statusCode: 401,
          },
        },
      ],
    });

    const backend = candidates.find(
      (c) => c.detector === "backend_http_client_error",
    );
    expect(backend?.severity).toBe("low");
    expect(backend?.confidence).toBe("low");
  });

  it("leaves an unexplained backend 4xx at medium", () => {
    const candidates = build([], {
      events: [
        {
          t: 2000,
          k: "backend.req.end",
          d: {
            requestId: "shared-req-3",
            method: "GET",
            route: "/reports/:id",
            statusCode: 409,
          },
        },
      ],
    });

    const backend = candidates.find(
      (c) => c.detector === "backend_http_client_error",
    );
    expect(backend?.severity).toBe("medium");
    expect(backend?.score).toBe(66);
  });
});
