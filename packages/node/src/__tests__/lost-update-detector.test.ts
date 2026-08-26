import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

const TABLE = "product_rating_cache";
const SHAPE =
  "SELECT product_id, rating_avg, rating_count FROM product_rating_cache WHERE product_id = ?";

function select(t: number, requestId: string): BugEvent {
  return {
    t,
    k: "db.statement",
    d: {
      engine: "postgres",
      op: "select",
      table: TABLE,
      shape: SHAPE,
      rowCount: 1,
      seq: 2,
      requestId,
    },
  } as unknown as BugEvent;
}

function update(
  t: number,
  requestId: string,
  after: Record<string, unknown> = {
    product_id: 8,
    rating_avg: 3,
    rating_count: 1,
  },
  pk: Record<string, unknown> | null = null,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      engine: "postgres",
      op: "update",
      table: TABLE,
      pk,
      after,
      requestId,
    },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("lost_update", () => {
  it("fires for a read-modify-write interleaved with another request's write", () => {
    const found = detectors([
      select(10, "req-reader"),
      update(20, "req-other"),
      update(30, "req-reader"),
    ]);

    expect(found).toContain("lost_update");
  });

  it("does not fire for two sequential updates with no read-before", () => {
    const found = detectors([update(10, "req-a"), update(20, "req-b")]);

    expect(found).not.toContain("lost_update");
  });

  it("does not fire when the reader has no other writer between its read and write", () => {
    const found = detectors([select(10, "req-reader"), update(20, "req-reader")]);

    expect(found).not.toContain("lost_update");
  });

  it("does not join updates for different keyed rows", () => {
    const found = detectors([
      select(10, "req-reader"),
      update(20, "req-other", {
        product_id: 9,
        rating_avg: 4,
        rating_count: 2,
      }),
      update(30, "req-reader"),
    ]);

    expect(found).not.toContain("lost_update");
  });

  it("does not infer a row from a table-only SELECT", () => {
    const found = detectors([
      {
        t: 10,
        k: "db.statement",
        d: {
          engine: "postgres",
          op: "select",
          table: TABLE,
          shape: "SELECT * FROM product_rating_cache",
          rowCount: 1,
          seq: 2,
          requestId: "req-reader",
        },
      } as unknown as BugEvent,
      update(20, "req-other"),
      update(30, "req-reader"),
    ]);

    expect(found).not.toContain("lost_update");
  });
});
