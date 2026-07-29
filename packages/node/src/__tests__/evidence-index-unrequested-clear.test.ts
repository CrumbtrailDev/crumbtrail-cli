import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * Fixtures mirror a real captured session: TaskFlow BUG-46 in the second
 * playground corpus. The client PATCHed
 *   /api/tasks/2  {"status":"in_progress"}
 * from a form whose model was loaded before another user saved a description.
 * The route wrote the whole row back, so `tasks.description` went from
 * 'Acceptance criteria written by Alice' to null in the same statement that
 * set the status. Nothing threw, the response was 200, and the row is
 * internally consistent — only the pairing of body and diff shows a column
 * was destroyed that the request never mentioned.
 *
 * Session ses_20260729_072333_4d16d72def1c, request
 * ae8aef6fc6921a1a65df9547f39b2a5c.
 */
function req(
  t: number,
  requestId: string,
  body: unknown,
  url = "/api/tasks/2",
  method = "PATCH",
): BugEvent {
  return {
    t,
    k: "net.req",
    d: {
      id: 7,
      method,
      url,
      requestId,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  };
}

function diff(
  t: number,
  requestId: string,
  op: string,
  table: string,
  pk: Record<string, unknown>,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "sqlite", op, table, pk, after, before, requestId },
  };
}

const find = (events: BugEvent[], detector: string, start = 1000) =>
  buildEvidenceCandidates(events, { start }).filter(
    (c) => c.detector === detector,
  );

describe("db_unrequested_clear", () => {
  it("names a column the write destroyed that the request body never mentioned", () => {
    const events = [
      req(1100, "req-patch", { status: "in_progress" }),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        {
          id: 2,
          status: "in_progress",
          description: null,
          updated_at: "2026-07-29T07:24:11Z",
        },
        {
          id: 2,
          status: "todo",
          description: "Acceptance criteria written by Alice",
          updated_at: "2026-07-29T07:20:03Z",
        },
      ),
    ];

    const found = find(events, "db_unrequested_clear");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("tasks.description");
    expect(found[0].anchor.requestId).toBe("req-patch");
    expect(found[0].severity).toBe("high");
    // The named field that DID change is what proves this was a partial update.
    expect(found[0].anchor.message).toContain("status");
  });

  it("stays silent when the request named the field it cleared", () => {
    const events = [
      req(1100, "req-patch", { status: "in_progress", description: "" }),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        { id: 2, status: "in_progress", description: "" },
        { id: 2, status: "todo", description: "old text" },
      ),
    ];
    expect(find(events, "db_unrequested_clear")).toHaveLength(0);
  });

  it("matches the body field name across snake_case and camelCase", () => {
    const events = [
      req(1100, "req-patch", { status: "in_progress", dueDate: null }),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        { id: 2, status: "in_progress", due_date: null },
        { id: 2, status: "todo", due_date: "2026-08-01" },
      ),
    ];
    expect(find(events, "db_unrequested_clear")).toHaveLength(0);
  });

  it("stays silent on identity and clock columns", () => {
    const events = [
      req(1100, "req-patch", { status: "in_progress" }),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        { id: 2, status: "in_progress", assignee_id: null, closed_at: null },
        {
          id: 2,
          status: "todo",
          assignee_id: 4,
          closed_at: "2026-07-20T00:00:00Z",
        },
      ),
    ];
    expect(find(events, "db_unrequested_clear")).toHaveLength(0);
  });

  it("fires when the named field did not change and the clear was the only effect", () => {
    // The captured shape: `status` was already `in_progress`, so the PATCH
    // accomplished nothing except destroying `description`. Requiring a named
    // field to have CHANGED would miss the purest form of the bug.
    const events = [
      req(1100, "req-patch", { status: "in_progress" }),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        {
          id: 2,
          status: "in_progress",
          description: null,
          updated_at: "2026-07-29 11:24:36",
        },
        {
          id: 2,
          status: "in_progress",
          description: "Acceptance criteria written by Alice",
          updated_at: "2026-07-29 11:24:35",
        },
      ),
    ];
    const found = find(events, "db_unrequested_clear");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("tasks.description");
  });

  it("stays silent when the request names no column this row has", () => {
    // A server-side lifecycle write that happens to share a request id is not a
    // partial update of this row, so a cleared column is not collateral damage.
    const events = [
      req(1100, "req-patch", { status: "in_progress" }),
      diff(
        1140,
        "req-patch",
        "update",
        "job_locks",
        { id: 9 },
        { id: 9, holder: null },
        { id: 9, holder: "worker-3" },
      ),
    ];
    expect(find(events, "db_unrequested_clear")).toHaveLength(0);
  });

  it("stays silent when a column merely changed rather than being cleared", () => {
    const events = [
      req(1100, "req-patch", { status: "in_progress" }),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        { id: 2, status: "in_progress", view_count: 12 },
        { id: 2, status: "todo", view_count: 11 },
      ),
    ];
    expect(find(events, "db_unrequested_clear")).toHaveLength(0);
  });

  it("stays silent on inserts, which clear nothing", () => {
    const events = [
      req(1100, "req-post", { status: "todo" }, "/api/tasks", "POST"),
      diff(
        1140,
        "req-post",
        "insert",
        "tasks",
        { id: 60 },
        { id: 60, status: "todo", description: null },
      ),
    ];
    expect(find(events, "db_unrequested_clear")).toHaveLength(0);
  });

  it("stays silent when the body is redacted or unparseable", () => {
    const events = [
      req(1100, "req-patch", "[REDACTED]"),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        { id: 2, status: "in_progress", description: null },
        { id: 2, status: "todo", description: "text" },
      ),
    ];
    expect(find(events, "db_unrequested_clear")).toHaveLength(0);
  });

  it("stays silent without a before snapshot", () => {
    const events = [
      req(1100, "req-patch", { status: "in_progress" }),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        {
          id: 2,
          status: "in_progress",
          description: null,
        },
      ),
    ];
    expect(find(events, "db_unrequested_clear")).toHaveLength(0);
  });

  it("raises one candidate per column, deduped per request and table", () => {
    const events = [
      req(1100, "req-patch", { status: "in_progress" }),
      diff(
        1140,
        "req-patch",
        "update",
        "tasks",
        { id: 2 },
        { id: 2, status: "in_progress", description: null, notes: "" },
        {
          id: 2,
          status: "todo",
          description: "Acceptance criteria written by Alice",
          notes: "ping Bob",
        },
      ),
    ];
    const found = find(events, "db_unrequested_clear");
    expect(found).toHaveLength(2);
    // One per column, not one per row: both names have to survive dedupe.
    expect(found.some((c) => c.title.includes("tasks.description"))).toBe(true);
    expect(found.some((c) => c.title.includes("tasks.notes"))).toBe(true);
  });
});
