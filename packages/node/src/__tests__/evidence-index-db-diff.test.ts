import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function dbDiff(
  t: number,
  requestId: string,
  extra: Record<string, unknown> = {},
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      engine: "postgres",
      op: "update",
      table: "orders",
      pk: { id: 1 },
      requestId,
      ...extra,
    },
  };
}

describe("buildEvidenceCandidates — db.diff", () => {
  it("ranks a db.diff temporally adjacent to an error as high-value evidence", () => {
    const events: BugEvent[] = [
      dbDiff(5000, "trace-1"),
      { t: 5200, k: "err", d: { msg: "TypeError: cannot read x" } },
    ];
    const candidates = buildEvidenceCandidates(events, {
      start: 5000,
      errs: [{ t: 5200, msg: "TypeError: cannot read x" }],
    });
    const dbCand = candidates.find((c) => c.detector === "db_mutation");
    expect(dbCand).toBeDefined();
    expect(dbCand!.severity).toBe("high");
    expect(dbCand!.score).toBe(88);
    expect(dbCand!.anchor.requestId).toBe("trace-1");
    expect(dbCand!.anchor.message).toContain("update");
    expect(dbCand!.anchor.message).toContain("orders");
  });

  it("ranks a db.diff sharing a requestId with a failing backend response as high-value", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.req.error",
        d: { requestId: "trace-9", statusCode: 500 },
      },
      dbDiff(60_000, "trace-9"),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const dbCand = candidates.find((c) => c.detector === "db_mutation");
    expect(dbCand).toBeDefined();
    expect(dbCand!.severity).toBe("high");
    expect(dbCand!.anchor.requestId).toBe("trace-9");
  });

  it("surfaces a standalone db.diff (no nearby error) at a low score for maximum visibility", () => {
    const events: BugEvent[] = [dbDiff(5000, "trace-ok")];
    const candidates = buildEvidenceCandidates(events, { start: 5000 });
    const dbCand = candidates.find((c) => c.detector === "db_mutation");
    expect(dbCand).toBeDefined();
    expect(dbCand!.severity).toBe("low");
    expect(dbCand!.score).toBe(40);
    expect(dbCand!.anchor.requestId).toBe("trace-ok");
    // With no error present, the standalone db.diff is the top-ranked candidate.
    expect(candidates[0].detector).toBe("db_mutation");
  });

  it("derives the db_mutation anchor source from a non-postgres engine (mysql)", () => {
    const events: BugEvent[] = [dbDiff(5000, "trace-my", { engine: "mysql" })];
    const candidates = buildEvidenceCandidates(events, { start: 5000 });
    const dbCand = candidates.find((c) => c.detector === "db_mutation");
    expect(dbCand).toBeDefined();
    expect(dbCand!.anchor.source).toBe("mysql");
  });

  it("defaults the db_mutation anchor source to postgres for a legacy engineless event", () => {
    const events: BugEvent[] = [
      {
        t: 5000,
        k: "db.diff",
        d: {
          op: "update",
          table: "orders",
          pk: { id: 1 },
          requestId: "trace-legacy",
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 5000 });
    const dbCand = candidates.find((c) => c.detector === "db_mutation");
    expect(dbCand).toBeDefined();
    expect(dbCand!.anchor.source).toBe("postgres");
  });
});
