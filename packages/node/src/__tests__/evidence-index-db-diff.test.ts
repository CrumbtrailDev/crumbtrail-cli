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
  it("ranks a db.diff near an uncorrelatable error as medium, not as an established link", () => {
    // A browser `err` carries no requestId, so nothing contradicts the write
    // and nothing establishes it either. Suggestive, so it outranks a
    // standalone write, but it is not the top tier that same-request earns.
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
    expect(dbCand!.severity).toBe("medium");
    expect(dbCand!.score).toBe(64);
    expect(dbCand!.confidence).toBe("medium");
    expect(dbCand!.title).toContain("near an error");
    expect(dbCand!.anchor.requestId).toBe("trace-1");
    expect(dbCand!.anchor.message).toContain("update");
    expect(dbCand!.anchor.message).toContain("orders");
  });

  it("does not promote a write whose requestId contradicts every nearby error", () => {
    // The CP2 defect, from a real session: a background job drain ran 2942ms
    // after an unrelated checkout error and reached the top tier on the time
    // window alone. Both sides carry a requestId and they disagree, which is
    // positive evidence of NON linkage — the window must not override it.
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.req.error",
        d: { requestId: "req-checkout", statusCode: 500 },
      },
      dbDiff(3942, "req-job-drain", { table: "job_queue", op: "delete" }),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const dbCand = candidates.find((c) => c.detector === "db_mutation");
    expect(dbCand).toBeDefined();
    expect(dbCand!.severity).toBe("low");
    expect(dbCand!.score).toBe(40);
    expect(dbCand!.title).not.toContain("error");
    expect(dbCand!.anchor.requestId).toBe("req-job-drain");
  });

  it("still promotes a correlated write in the same session as a contradicting one", () => {
    // The discrimination the fix buys: two writes, same 5s window, same error.
    // One shares the error's request id and one does not.
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.req.error",
        d: { requestId: "req-checkout", statusCode: 500 },
      },
      dbDiff(1500, "req-checkout", { table: "orders" }),
      dbDiff(1600, "req-job-drain", { table: "job_queue" }),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const byTable = new Map(
      candidates
        .filter((c) => c.detector === "db_mutation")
        .map((c) => [c.anchor.requestId, c]),
    );
    expect(byTable.get("req-checkout")!.score).toBe(88);
    expect(byTable.get("req-checkout")!.severity).toBe("high");
    expect(byTable.get("req-checkout")!.title).toContain("failed request");
    expect(byTable.get("req-job-drain")!.score).toBe(40);
    expect(byTable.get("req-job-drain")!.severity).toBe("low");
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
