import { describe, it, expect } from "vitest";
import { buildEvidenceCandidates } from "../evidence-index";
import type { BugEvent } from "crumbtrail-core";

/**
 * The ranked list is capped at 200. On the CalcDesk corpus roughly 130 of those
 * slots went to `db_mutation` on ordinary inserts — seeding a fixture writes
 * hundreds of rows and each one took a slot — so the sentence explaining a
 * failure never reached the list even once it was captured.
 *
 * Writes tied to no error roll up per table and operation. Writes tied to an
 * error keep their own identity, because which write it was is the question.
 */

const diff = (
  t: number,
  requestId: string | undefined,
  op: string,
  table: string,
  after: Record<string, unknown>,
): BugEvent =>
  ({
    t,
    k: "db.diff",
    d: { ...(requestId ? { requestId } : {}), op, table, pk: { id: 1 }, after },
  }) as unknown as BugEvent;

const seedWrites = (count: number, table = "results"): BugEvent[] =>
  Array.from({ length: count }, (_, i) =>
    diff(2000 + i * 10, undefined, "insert", table, { id: i, value: i }),
  );

const dbCandidates = (events: BugEvent[]) =>
  buildEvidenceCandidates(events, { start: 1000 }).filter(
    (c) => c.detector === "db_mutation",
  );

describe("candidate budget", () => {
  it("rolls three hundred routine inserts into one candidate", () => {
    const found = dbCandidates(seedWrites(300));
    expect(found).toHaveLength(1);
    expect(found[0]?.occurrences).toBe(300);
  });

  it("keeps the count rather than hiding the volume", () => {
    const found = dbCandidates(seedWrites(47));
    expect(found[0]?.occurrences).toBe(47);
  });

  it("rolls up per table and operation, not across them", () => {
    const found = dbCandidates([
      ...seedWrites(20, "results"),
      ...seedWrites(20, "audit_log"),
      diff(9000, undefined, "update", "results", { id: 1, value: 9 }),
    ]);
    const titles = found.map((c) => c.title).sort();
    expect(found).toHaveLength(3);
    expect(titles.some((t) => t.includes("update"))).toBe(true);
  });

  it("never rolls up a write tied to a failing request", () => {
    const events: BugEvent[] = [
      ...seedWrites(200),
      {
        t: 5000,
        k: "backend.req.end",
        d: {
          requestId: "req-fail",
          method: "POST",
          pathname: "/api/calcs/2/run",
          statusCode: 500,
        },
      } as unknown as BugEvent,
      diff(4990, "req-fail", "insert", "results", { id: 901, value: 1 }),
      diff(4995, "req-fail", "insert", "results", { id: 902, value: 2 }),
    ];
    const found = dbCandidates(events);
    // The two writes inside the failed request stay separate; the two hundred
    // routine ones collapse to a single rolled-up entry.
    const linked = found.filter((c) => c.anchor.requestId === "req-fail");
    expect(linked).toHaveLength(2);
    expect(linked.every((c) => c.occurrences === undefined)).toBe(true);
  });

  it("leaves room in the cap for everything else", () => {
    const events: BugEvent[] = [
      // The failure sits well clear of the write burst: a write NEAR an error is
      // graded temporal and deliberately keeps its own slot, so it would not be
      // measuring the rollup.
      ...seedWrites(400),
      {
        t: 600_000,
        k: "backend.req.end",
        d: {
          requestId: "req-fail",
          method: "POST",
          pathname: "/api/calcs/2/run",
          statusCode: 500,
        },
      } as unknown as BugEvent,
    ];
    const all = buildEvidenceCandidates(events, { start: 1000 });
    // Four hundred writes used to be four hundred candidates competing for two
    // hundred slots. Now they are one, and the failure is on the list.
    expect(all.length).toBeLessThan(200);
    expect(
      all.some((c) => c.anchor.requestId === "req-fail" && c.score >= 80),
    ).toBe(true);
  });
});

/**
 * Capturing the response body (#54) put the sentence in the session. Nothing
 * read it into the ranked list, so a failure still reached a reader as
 * "Backend HTTP 500 from POST /api/calcs/2/run".
 */
describe("backend failures name themselves", () => {
  const failing = (responseBody?: string): BugEvent[] =>
    [
      {
        t: 5000,
        k: "backend.req.end",
        d: {
          requestId: "req-1",
          method: "PATCH",
          pathname: "/api/calcs/2",
          statusCode: 500,
          ...(responseBody ? { responseBody } : {}),
        },
      },
    ] as unknown as BugEvent[];

  const backend = (events: BugEvent[]) =>
    buildEvidenceCandidates(events, { start: 1000 }).find(
      (c) => c.detector === "backend_http_error",
    );

  it("quotes the sentence the handler returned", () => {
    const found = backend(
      failing(
        JSON.stringify({
          error: '42P01: relation "_result_2" does not exist',
        }),
      ),
    );
    expect(found?.title).toContain("_result_2");
    expect(found?.anchor.message).toContain("does not exist");
  });

  it("reads message, detail and reason too", () => {
    expect(backend(failing(JSON.stringify({ message: "row not found" })))?.title).toContain(
      "row not found",
    );
    expect(backend(failing(JSON.stringify({ detail: "no such column" })))?.title).toContain(
      "no such column",
    );
  });

  it("says nothing extra when the body stated nothing", () => {
    const found = backend(failing(JSON.stringify({ ok: false, code: 7 })));
    expect(found?.title).toBe("Backend HTTP 500 from PATCH /api/calcs/2");
  });

  /** A redacted value is a placeholder object, not a sentence. */
  it("never pastes a redaction placeholder into the title", () => {
    const found = backend(
      failing(
        JSON.stringify({
          error: { $redacted: "[REDACTED]", len: 42, charset: "mixed" },
        }),
      ),
    );
    expect(found?.title).not.toContain("REDACTED");
    expect(found?.title).toBe("Backend HTTP 500 from PATCH /api/calcs/2");
  });

  it("survives a body that is not JSON", () => {
    expect(backend(failing("<html>Error</html>"))?.title).toBe(
      "Backend HTTP 500 from PATCH /api/calcs/2",
    );
  });

  it("prefers a thrown error's own message over the body", () => {
    const events = [
      {
        t: 5000,
        k: "backend.req.error",
        d: {
          requestId: "req-1",
          method: "PATCH",
          pathname: "/api/calcs/2",
          error: { message: "thrown from the handler" },
          responseBody: JSON.stringify({ error: "generic wrapper text" }),
        },
      },
    ] as unknown as BugEvent[];
    const found = buildEvidenceCandidates(events, { start: 1000 }).find(
      (c) => c.detector === "backend_request_error",
    );
    expect(found?.anchor.message).toBe("thrown from the handler");
  });
});
