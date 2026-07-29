import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function insert(
  after: Record<string, unknown>,
  table = "order_exports",
  op = "insert",
): BugEvent {
  return {
    t: 10,
    k: "db.diff",
    d: {
      engine: "postgres",
      op,
      table,
      pk: { id: 1 },
      after,
      requestId: "req-a",
    },
  } as unknown as BugEvent;
}

function candidates(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 });
}

function detectors(events: BugEvent[]): string[] {
  return candidates(events).map((candidate) => candidate.detector);
}

describe("counter_contradiction", () => {
  // Both fixtures below are the real after-images captured from the playground
  // recall harness, not invented shapes.

  it("names an export row that claims more than it wrote", () => {
    const found = detectors([
      insert({
        requested_by: "ops-console",
        rows_expected: 8,
        rows_written: 3,
        id: 1,
        created_at: "2026-07-28T07:19:09.015Z",
      }),
    ]);
    expect(found).toContain("counter_contradiction");
  });

  it("names a report row whose advertised total exceeds the rows it returned", () => {
    const found = detectors([
      insert(
        {
          kind: "orders-page",
          rows_returned: 3,
          total_claimed: 8,
          distinct_seen: 3,
          total_cents: null,
          note: "status=placed after=0",
          id: 1,
          created_at: "2026-07-28T07:18:57.178Z",
        },
        "ops_reports",
      ),
    ]);
    expect(found).toContain("counter_contradiction");
  });

  it("shows the reader both numbers and which columns they came from", () => {
    const [candidate] = candidates([
      insert({ rows_expected: 8, rows_written: 3 }),
    ]).filter((entry) => entry.detector === "counter_contradiction");

    expect(candidate.anchor.message).toContain("rows_expected");
    expect(candidate.anchor.message).toContain("rows_written");
    expect(candidate.anchor.message).toContain("8");
    expect(candidate.anchor.message).toContain("3");
    // The claim is that two recorded counters disagree, which is a fact about
    // the row. Whether that is a defect is the reader's call, so this must not
    // present itself with the confidence of a proven invariant break.
    expect(candidate.confidence).not.toBe("high");
  });

  it("stays silent when the counters agree", () => {
    expect(
      detectors([insert({ rows_expected: 8, rows_written: 8 })]),
    ).not.toContain("counter_contradiction");
  });

  // The batch rows below are the real `reprice_batches` lifecycle captured from
  // the playground: inserted as a plan, progressed by updates, ending terminal.

  it("stays silent on a batch row inserted as a plan", () => {
    // status pending with nothing applied yet is an intention, not a claim.
    expect(
      detectors([
        insert(
          {
            status: "pending",
            attempt: 1,
            rows_total: 2,
            id: 1,
            rows_applied: 0,
            last_error: null,
          },
          "reprice_batches",
        ),
      ]),
    ).not.toContain("counter_contradiction");
  });

  it("stays silent while the batch is still running", () => {
    expect(
      detectors([
        insert(
          { status: "running", rows_total: 2, rows_applied: 1 },
          "reprice_batches",
          "update",
        ),
      ]),
    ).not.toContain("counter_contradiction");
  });

  it("names a batch that finished having applied fewer rows than it had", () => {
    // The app declared itself done. That is the moment the counters have to agree.
    const found = detectors([
      insert(
        { status: "done", attempt: 1, rows_total: 2, id: 1, rows_applied: 1 },
        "reprice_batches",
        "update",
      ),
    ]);
    expect(found).toContain("counter_contradiction");
  });

  it("treats an unrecognized status as not yet finished", () => {
    // Deny-biased: a status this cannot read is not evidence the work is over.
    expect(
      detectors([
        insert(
          { status: "reconciling", rows_total: 2, rows_applied: 1 },
          "reprice_batches",
          "update",
        ),
      ]),
    ).not.toContain("counter_contradiction");
  });

  it("stays silent on a statusless row that has achieved nothing yet", () => {
    expect(
      detectors([insert({ rows_expected: 8, rows_written: 0 })]),
    ).not.toContain("counter_contradiction");
  });

  it("does not read a money column as a count", () => {
    // total_cents is an amount. Pairing it against a row count would fire on
    // every ordinary order that costs more cents than it has line items.
    expect(
      detectors([insert({ total_cents: 19900, rows_returned: 3 }, "orders")]),
    ).not.toContain("counter_contradiction");
  });

  it("stays silent when one side was not captured as a number", () => {
    expect(
      detectors([insert({ rows_expected: null, rows_written: 3 })]),
    ).not.toContain("counter_contradiction");
    expect(
      detectors([insert({ rows_expected: {}, rows_written: 3 })]),
    ).not.toContain("counter_contradiction");
  });

  it("stays silent when the row records only one of the two counters", () => {
    expect(detectors([insert({ rows_written: 3 })])).not.toContain(
      "counter_contradiction",
    );
  });
});
