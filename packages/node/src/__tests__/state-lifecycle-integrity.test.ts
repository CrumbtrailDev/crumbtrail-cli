import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

function diff(
  t: number,
  requestId: string,
  op: string,
  table: string,
  id: number | string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      engine: "postgres",
      requestId,
      op,
      table,
      pk: { id },
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    },
  } as unknown as BugEvent;
}

describe("async state lifecycle integrity", () => {
  it("flags a successful drain response that deferred and retained work", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "net.req",
          d: {
            requestId: "drain-1",
            method: "POST",
            url: "/api/admin/jobs/drain",
          },
        },
        {
          t: 120,
          k: "net.res",
          d: {
            requestId: "drain-1",
            st: 200,
            body: JSON.stringify({ processed: 0, deferred: 1, remaining: 1 }),
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("job_drain_left_work_deferred");
  });

  it("accepts a drain that completes all work", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "net.req",
          d: {
            requestId: "drain-1",
            method: "POST",
            url: "/api/admin/jobs/drain",
          },
        },
        {
          t: 120,
          k: "net.res",
          d: {
            requestId: "drain-1",
            st: 200,
            body: JSON.stringify({ processed: 1, deferred: 0, remaining: 0 }),
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("job_drain_left_work_deferred");
  });

  it("flags an hour-aligned retry clock shift after an attempt fails", () => {
    const t = Date.parse("2026-07-28T22:35:24.906Z");
    expect(
      detectors([
        diff(
          t,
          "tick-1",
          "update",
          "jobs",
          1,
          {
            id: 1,
            status: "pending",
            attempts: 0,
            run_at: "2026-07-28T22:35:24.890Z",
          },
          {
            id: 1,
            status: "pending",
            attempts: 1,
            run_at: "2026-07-29T07:35:25.904Z",
            last_error: "transient failure",
          },
        ),
      ]),
    ).toContain("retry_schedule_clock_shift");
  });

  it("does not flag a short retry backoff", () => {
    const t = Date.parse("2026-07-28T22:35:24.906Z");
    expect(
      detectors([
        diff(
          t,
          "tick-1",
          "update",
          "jobs",
          1,
          { id: 1, status: "pending", attempts: 0 },
          {
            id: 1,
            status: "pending",
            attempts: 1,
            run_at: "2026-07-28T22:35:25.904Z",
            last_error: "transient failure",
          },
        ),
      ]),
    ).not.toContain("retry_schedule_clock_shift");
  });

  it("flags a request that spans session deletion and then returns 401", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "backend.req.start",
          d: {
            requestId: "slow-1",
            method: "POST",
            url: "/api/ops/slow-write",
          },
        },
        diff(
          200,
          "rotate-1",
          "delete",
          "sessions",
          "old-session",
          { id: "old-session" },
          undefined,
        ),
        {
          t: 300,
          k: "backend.req.end",
          d: {
            requestId: "slow-1",
            method: "POST",
            url: "/api/ops/slow-write",
            statusCode: 401,
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("inflight_request_invalidated_by_session_rotation");
  });

  it("does not blame rotation for a request that began after deletion", () => {
    expect(
      detectors([
        diff(
          100,
          "rotate-1",
          "delete",
          "sessions",
          "old-session",
          { id: "old-session" },
          undefined,
        ),
        {
          t: 200,
          k: "backend.req.start",
          d: { requestId: "late-1", method: "POST", url: "/api/write" },
        },
        {
          t: 300,
          k: "backend.req.end",
          d: { requestId: "late-1", statusCode: 401 },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("inflight_request_invalidated_by_session_rotation");
  });

  it("flags a cached empty report after source rows arrived", () => {
    expect(
      detectors([
        diff(100, "dash-1", "insert", "ops_reports", 1, undefined, {
          id: 1,
          kind: "dashboard",
          rows_returned: 0,
          note: "cache=skip-empty",
        }),
        diff(150, "seed-1", "insert", "orders", 1, undefined, {
          id: 1,
          status: "placed",
        }),
        diff(200, "dash-2", "insert", "ops_reports", 2, undefined, {
          id: 2,
          kind: "dashboard",
          rows_returned: 0,
          note: "cache=hit",
        }),
      ]),
    ).toContain("cached_empty_result_after_data_arrived");
  });

  it("does not flag an empty cache hit when no source rows changed", () => {
    expect(
      detectors([
        diff(100, "dash-1", "insert", "ops_reports", 1, undefined, {
          id: 1,
          kind: "dashboard",
          rows_returned: 0,
          note: "cache=skip-empty",
        }),
        diff(200, "dash-2", "insert", "ops_reports", 2, undefined, {
          id: 2,
          kind: "dashboard",
          rows_returned: 0,
          note: "cache=hit",
        }),
      ]),
    ).not.toContain("cached_empty_result_after_data_arrived");
  });
});
