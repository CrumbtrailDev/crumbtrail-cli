import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { buildCausalGraph, attributeCandidates } from "../causal-graph";

/**
 * A statement the database REFUSED is the most decisive database observable the capture path
 * collects, and it used to reach the reader only as a rendered row: nothing that produces the
 * ranked opinion could see it, so it could never promote a candidate however exactly it named the
 * fault. These tests pin the two halves of that — that a candidate is produced, and that it can
 * take a node in the causal graph — and the invariance the change must not break.
 */

function dbError(overrides: Record<string, unknown> = {}): BugEvent {
  return {
    t: 1500,
    k: "db.error",
    d: {
      engine: "postgres",
      op: "insert",
      table: "ledger_entries",
      shape:
        "INSERT INTO ledger_entries (account_id, amount_cents, reference) VALUES (?, ?, ?)",
      code: "23505",
      errorName: "Error",
      requestId: "req-1",
      t: 1500,
      ...overrides,
    },
  };
}

describe("buildEvidenceCandidates — a statement the database refused", () => {
  it("produces a candidate carrying the observable's own fields", () => {
    const candidates = buildEvidenceCandidates([dbError()], { start: 1000 });
    const cand = candidates.find((c) => c.detector === "db_statement_failed");

    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("high");
    expect(cand!.score).toBe(90);
    expect(cand!.anchor.requestId).toBe("req-1");
    expect(cand!.anchor.table).toBe("ledger_entries");
    expect(cand!.anchor.source).toBe("postgres");
    expect(cand!.anchor.errorCode).toBe("23505");
    // The statement shape reaches the ranked opinion verbatim — that is the whole point of the
    // finding, and a candidate that dropped it would name only the table.
    expect(cand!.anchor.statementShape).toBe(
      "INSERT INTO ledger_entries (account_id, amount_cents, reference) VALUES (?, ?, ?)",
    );
    expect(cand!.title).toBe(
      "Database insert on ledger_entries was refused (23505)",
    );
  });

  it("carries no error message and no bind values", () => {
    const candidates = buildEvidenceCandidates(
      [
        dbError({
          // A driver that puts prose where a code belongs must not turn the anchor into a message
          // channel: `code` is read through the same bounded path the capture layer uses.
          code: null,
          errorName: "QueryFailedError",
        }),
      ],
      { start: 1000 },
    );
    const cand = candidates.find((c) => c.detector === "db_statement_failed")!;
    expect(cand.anchor.message).toBeUndefined();
    // With no code from the database, the class name stands in on the anchor and is left out of
    // the title, where it would read as a claim about the statement.
    expect(cand.anchor.errorCode).toBe("QueryFailedError");
    expect(cand.title).toBe("Database insert on ledger_entries was refused");
  });

  it("names the statement even when the SQL did not parse to a table or a verb", () => {
    const candidates = buildEvidenceCandidates(
      [dbError({ op: "other", table: null, code: null })],
      { start: 1000 },
    );
    const cand = candidates.find((c) => c.detector === "db_statement_failed")!;
    expect(cand.title).toBe("Database statement was refused");
    expect(cand.anchor.table).toBeUndefined();
    expect(cand.anchor.statementShape).toContain("INSERT INTO ledger_entries");
  });

  it("keeps two different failing statements in one request apart, and collapses a retry", () => {
    const distinct = buildEvidenceCandidates(
      [
        dbError(),
        dbError({ t: 1600, table: "accounts", shape: "UPDATE accounts SET balance_cents = ? WHERE id = ?" }),
      ],
      { start: 1000 },
    ).filter((c) => c.detector === "db_statement_failed");
    expect(distinct).toHaveLength(2);

    const retried = buildEvidenceCandidates(
      [dbError(), { ...dbError(), t: 1700 }],
      { start: 1000 },
    ).filter((c) => c.detector === "db_statement_failed");
    expect(retried).toHaveLength(1);
  });

  it("emits nothing when no statement was refused", () => {
    const candidates = buildEvidenceCandidates(
      [
        {
          t: 1500,
          k: "db.diff",
          d: {
            engine: "postgres",
            op: "insert",
            table: "ledger_entries",
            requestId: "req-1",
          },
        },
      ],
      { start: 1000 },
    );
    expect(
      candidates.some((c) => c.detector === "db_statement_failed"),
    ).toBe(false);
  });
});

describe("causal graph — a refused statement is placeable", () => {
  const events: BugEvent[] = [
    {
      t: 1000,
      k: "backend.req.start",
      d: { requestId: "req-1", method: "POST", route: "/api/redeem" },
    },
    dbError(),
    {
      t: 1900,
      k: "backend.req.error",
      d: {
        requestId: "req-1",
        method: "POST",
        route: "/api/redeem",
        statusCode: 500,
        error: { name: "Error", message: "internal" },
      },
    },
  ];

  it("builds a db.error node rather than claiming a write happened", () => {
    const graph = buildCausalGraph({ events });
    const kinds = graph.nodes.map((n) => n.kind);
    expect(kinds).toContain("db.error");
    // A statement that raised wrote nothing, so it must not present as the write plane: the
    // write-to-write confidence clamp and the own-write-only fallback bar both read `db.write`
    // as "this row changed".
    expect(kinds).not.toContain("db.write");
  });

  it("attributes the candidate to a node instead of reporting it isolated", () => {
    const graph = buildCausalGraph({ events });
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "db_statement_failed")!;
    const attribution = attributeCandidates(
      graph,
      candidates.map((c) => ({ id: c.id, anchor: c.anchor })),
      (id) => candidates.find((c) => c.id === id)?.detector,
    ).get(cand.id);

    expect(attribution).toBeDefined();
    expect(attribution!.causalRole).not.toBe("isolated");
  });
});
