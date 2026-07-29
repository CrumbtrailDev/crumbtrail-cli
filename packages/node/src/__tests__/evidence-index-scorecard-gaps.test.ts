import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * Detectors written against the TaskFlow second corpus (BUG-21…BUG-55), the
 * holdout family selected so that almost nothing throws. Every fixture here
 * mirrors a shape taken from a real captured session, not a synthetic minimum —
 * `ses_20260729_072333_4d16d72def1c` and `ses_20260729_071205_97b2384e7bce`.
 *
 * Note the transport counter `d.id` is a NUMBER in real captures. It is written
 * that way here deliberately: reading it as a string is what silently emptied
 * the request map and stripped method/URL off these findings.
 */

let nextId = 100;

function req(
  t: number,
  requestId: string,
  url: string,
  method = "GET",
  body?: unknown,
): BugEvent {
  return {
    t,
    k: "net.req",
    d: {
      id: nextId++,
      method,
      url,
      requestId,
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    },
  };
}

/** Pairs with the most recent `req` by reusing its numeric transport id. */
function res(
  t: number,
  requestId: string,
  status: number,
  hdrs: Record<string, string>,
  body?: unknown,
  dur?: number,
): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      id: nextId - 1,
      st: status,
      requestId,
      hdrs,
      ...(dur === undefined ? {} : { dur }),
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
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

function read(
  t: number,
  requestId: string,
  table: string,
  row: Record<string, unknown>,
): BugEvent {
  return { t, k: "db.read", d: { engine: "sqlite", table, row, requestId } };
}

const find = (events: BugEvent[], detector: string, start = 1000) =>
  buildEvidenceCandidates(events, { start }).filter(
    (c) => c.detector === detector,
  );

const CSV = { "content-type": "text/csv; charset=utf-8" };
const XLSX = {
  "content-type":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=utf-8",
};

describe("download_empty_body", () => {
  it("flags a 200 that served a CSV content type with nothing in it", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/exports/board/1.csv"),
      res(1120, "r1", 200, {
        ...CSV,
        "content-length": "0",
        "x-export-warnings": "10",
      }),
    ];
    const found = find(events, "download_empty_body");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("text/csv");
    // The URL only survives if the numeric transport id is read correctly.
    expect(found[0].anchor.url).toContain("/api/exports/board/1.csv");
  });

  it("stays silent when the same route actually returns bytes", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/exports/board/3.csv"),
      res(1120, "r1", 200, { ...CSV, "content-length": "156" }),
    ];
    expect(find(events, "download_empty_body")).toHaveLength(0);
  });

  it("stays silent on 204, which is empty by definition", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/exports/board/1.csv"),
      res(1120, "r1", 204, { ...CSV, "content-length": "0" }),
    ];
    expect(find(events, "download_empty_body")).toHaveLength(0);
  });

  it("stays silent on an empty JSON response, which is ordinary", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/tasks"),
      res(1120, "r1", 200, {
        "content-type": "application/json",
        "content-length": "0",
      }),
    ];
    expect(find(events, "download_empty_body")).toHaveLength(0);
  });

  it("stays silent on a HEAD request, where no body is expected", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/exports/board/1.csv", "HEAD"),
      res(1120, "r1", 200, { ...CSV, "content-length": "0" }),
    ];
    expect(find(events, "download_empty_body")).toHaveLength(0);
  });

  it("collapses repeat hits on one endpoint into a single finding", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/exports/board/1.csv"),
      res(1120, "r1", 200, { ...CSV, "content-length": "0" }),
      req(1300, "r2", "http://localhost:7421/api/exports/board/1.csv"),
      res(1320, "r2", 200, { ...CSV, "content-length": "0" }),
      req(1500, "r3", "http://localhost:7421/api/exports/board/1.csv"),
      res(1520, "r3", 200, { ...CSV, "content-length": "0" }),
    ];
    expect(find(events, "download_empty_body")).toHaveLength(1);
  });
});

describe("content_type_body_mismatch", () => {
  it("flags a spreadsheet content type carrying a JSON body", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/exports/board/1.xlsx"),
      res(
        1120,
        "r1",
        200,
        { ...XLSX, "content-length": "1829" },
        {
          board: "Design",
          tasks: [{ id: 1 }],
        },
      ),
    ];
    const found = find(events, "content_type_body_mismatch");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("spreadsheetml");
  });

  it("stays silent when JSON is served under a JSON content type", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/tasks"),
      res(
        1120,
        "r1",
        200,
        { "content-type": "application/json" },
        {
          tasks: [],
        },
      ),
    ];
    expect(find(events, "content_type_body_mismatch")).toHaveLength(0);
  });

  it("stays silent when the body is redacted, which proves nothing", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/exports/board/1.xlsx"),
      res(1120, "r1", 200, XLSX, "[REDACTED]"),
    ];
    expect(find(events, "content_type_body_mismatch")).toHaveLength(0);
  });
});

describe("response_count_mismatch", () => {
  it("flags a response whose reported count exceeds the rows that changed", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/tasks/bulk-status", "POST", {
        board_id: 1,
        ids: [1, 3, 5, 9999],
        status: "done",
      }),
      res(
        1180,
        "r1",
        200,
        { "content-type": "application/json" },
        {
          updated: 4,
          status: "done",
        },
      ),
      diff(1120, "r1", "update", "tasks", { id: 1 }, { id: 1, status: "done" }),
      diff(1130, "r1", "update", "tasks", { id: 3 }, { id: 3, status: "done" }),
      diff(1140, "r1", "update", "tasks", { id: 5 }, { id: 5, status: "done" }),
    ];
    const found = find(events, "response_count_mismatch");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("updated=4");
    expect(found[0].title).toContain("3 rows");
  });

  it("stays silent when the count is honest", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/tasks/bulk-status", "POST", {
        ids: [1, 3],
      }),
      res(1180, "r1", 200, {}, { updated: 2 }),
      diff(1120, "r1", "update", "tasks", { id: 1 }, { id: 1, status: "done" }),
      diff(1130, "r1", "update", "tasks", { id: 3 }, { id: 3, status: "done" }),
    ];
    expect(find(events, "response_count_mismatch")).toHaveLength(0);
  });

  it("does not count inserts against a field that names updates", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/tasks/bulk-status", "POST", {
        ids: [1],
      }),
      res(1180, "r1", 200, {}, { updated: 1 }),
      diff(1120, "r1", "update", "tasks", { id: 1 }, { id: 1, status: "done" }),
      diff(1130, "r1", "insert", "activity_log", { id: 9 }, { id: 9 }),
    ];
    expect(find(events, "response_count_mismatch")).toHaveLength(0);
  });

  it("stays silent when two count fields make the claim ambiguous", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/tasks/bulk", "POST", {
        ids: [1],
      }),
      res(1180, "r1", 200, {}, { updated: 4, changed: 2 }),
      diff(1120, "r1", "update", "tasks", { id: 1 }, { id: 1, status: "done" }),
    ];
    expect(find(events, "response_count_mismatch")).toHaveLength(0);
  });
});

describe("retry_loop_against_success", () => {
  const delivery = (t: number, id: number, attempt: number, status: number) =>
    diff(
      t,
      "r1",
      "insert",
      "webhook_deliveries",
      { id },
      {
        id,
        attempt,
        status: "retrying",
        http_status: status,
      },
    );

  it("flags an escalating retry sequence that only ever saw a 2xx", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/webhooks/test", "POST", {
        board_id: 1,
      }),
      ...[1, 2, 3, 4, 5].map((n) => delivery(1100 + n * 10, 70 + n, n, 204)),
    ];
    const found = find(events, "retry_loop_against_success");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("204");
    expect(found[0].title).toContain("5 attempts");
  });

  it("stays silent when the retries were against real failures", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/webhooks/test", "POST", {}),
      ...[1, 2, 3, 4].map((n) => delivery(1100 + n * 10, 70 + n, n, 500)),
    ];
    expect(find(events, "retry_loop_against_success")).toHaveLength(0);
  });

  it("stays silent on a mixed sequence that eventually succeeded", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/webhooks/test", "POST", {}),
      delivery(1110, 71, 1, 500),
      delivery(1120, 72, 2, 502),
      delivery(1130, 73, 3, 200),
    ];
    expect(find(events, "retry_loop_against_success")).toHaveLength(0);
  });

  it("stays silent below the minimum attempt count", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/webhooks/test", "POST", {}),
      delivery(1110, 71, 1, 204),
      delivery(1120, 72, 2, 204),
    ];
    expect(find(events, "retry_loop_against_success")).toHaveLength(0);
  });
});

describe("latency_outlier", () => {
  const fast = (t: number, n: number) => [
    req(t, `f${n}`, `http://localhost:7421/api/tasks/${n}`),
    res(t + 5, `f${n}`, 200, {}, undefined, 15),
  ];

  it("flags a request far above the session's own median", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => fast(1100 + i * 20, i)).flat(),
      req(1400, "slow", "http://localhost:7421/api/tasks/report"),
      res(1500, "slow", 200, {}, undefined, 789),
    ];
    const found = find(events, "latency_outlier");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("789 ms");
    expect(found[0].anchor.url).toContain("/api/tasks/report");
  });

  it("stays silent without enough requests to have a distribution", () => {
    const events = [
      ...Array.from({ length: 3 }, (_, i) => fast(1100 + i * 20, i)).flat(),
      req(1400, "slow", "http://localhost:7421/api/tasks/report"),
      res(1500, "slow", 200, {}, undefined, 789),
    ];
    expect(find(events, "latency_outlier")).toHaveLength(0);
  });

  it("stays silent on a fast session, where a ratio is noise", () => {
    // 40x the median, but 4 ms in absolute terms — nobody's bug.
    const events = [
      ...Array.from({ length: 10 }, (_, i) => [
        req(1100 + i * 20, `f${i}`, `http://localhost:7421/api/tasks/${i}`),
        res(1105 + i * 20, `f${i}`, 200, {}, undefined, 0.1),
      ]).flat(),
      req(1400, "slow", "http://localhost:7421/api/tasks/report"),
      res(1500, "slow", 200, {}, undefined, 4),
    ];
    expect(find(events, "latency_outlier")).toHaveLength(0);
  });

  it("leaves anything over the absolute threshold to slow_request", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => fast(1100 + i * 20, i)).flat(),
      req(1400, "slow", "http://localhost:7421/api/tasks/report"),
      res(1500, "slow", 200, {}, undefined, 6_000),
    ];
    expect(find(events, "latency_outlier")).toHaveLength(0);
    expect(find(events, "slow_request").length).toBeGreaterThan(0);
  });
});

describe("db_write_read_column_split", () => {
  it("flags a value written to a column no read ever selects", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/views", "POST", {
        name: "My open items",
        filters: { status: "todo" },
      }),
      diff(
        1120,
        "r1",
        "insert",
        "saved_views",
        { id: 5 },
        {
          id: 5,
          name: "My open items",
          filters: null,
          filters_json: '{"status":"todo"}',
        },
      ),
      read(1200, "r2", "saved_views", { id: 1, name: "a", filters: null }),
      read(1210, "r2", "saved_views", { id: 2, name: "b", filters: null }),
      read(1220, "r2", "saved_views", { id: 3, name: "c", filters: null }),
    ];
    const found = find(events, "db_write_read_column_split");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("saved_views.filters_json");
    expect(found[0].title).toContain("saved_views.filters");
  });

  it("stays silent once any read selects the written column", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/views", "POST", {}),
      diff(
        1120,
        "r1",
        "insert",
        "saved_views",
        { id: 5 },
        {
          id: 5,
          filters: null,
          filters_json: '{"status":"todo"}',
        },
      ),
      read(1200, "r2", "saved_views", { id: 1, filters: null }),
      read(1210, "r2", "saved_views", { id: 2, filters: null }),
      read(1220, "r2", "saved_views", {
        id: 3,
        filters: null,
        filters_json: "{}",
      }),
    ];
    expect(find(events, "db_write_read_column_split")).toHaveLength(0);
  });

  it("stays silent on a narrow SELECT where nothing was left empty", () => {
    // The reads simply do not project `body`. Nothing the reads DO select was
    // starved by the write, so this is ordinary column selection.
    const events = [
      req(1100, "r1", "http://localhost:7421/api/comments", "POST", {}),
      diff(
        1120,
        "r1",
        "insert",
        "comments",
        { id: 5 },
        {
          id: 5,
          author: "alice",
          body: "hello",
        },
      ),
      read(1200, "r2", "comments", { id: 1, author: "alice" }),
      read(1210, "r2", "comments", { id: 2, author: "bob" }),
      read(1220, "r2", "comments", { id: 3, author: "carol" }),
    ];
    expect(find(events, "db_write_read_column_split")).toHaveLength(0);
  });

  it("stays silent below the minimum number of reads", () => {
    const events = [
      req(1100, "r1", "http://localhost:7421/api/views", "POST", {}),
      diff(
        1120,
        "r1",
        "insert",
        "saved_views",
        { id: 5 },
        {
          id: 5,
          filters: null,
          filters_json: '{"status":"todo"}',
        },
      ),
      read(1200, "r2", "saved_views", { id: 1, filters: null }),
    ];
    expect(find(events, "db_write_read_column_split")).toHaveLength(0);
  });
});
