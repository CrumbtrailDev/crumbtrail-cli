/**
 * ACCEPTANCE PROBE — authored by the harness orchestrator, not by the implementer.
 *
 * THE CLAIM UNDER TEST: the SDK's own database capture can only record statements that
 * SUCCEEDED. When the host statement raises, `wrappedQuery`'s `await client.query(...)`
 * rejects and nothing at all is emitted (`packages/node/src/db/pg.ts:95` for reads,
 * `:158` for mutations — neither is inside a try/catch). So the single most decisive
 * observable in a "the request 500ed because the write blew up" incident — the failing
 * statement and its error — is absent from the bundle, and the reader must infer it.
 *
 * Measured on the frozen 60-session catalog before this probe was written, from the
 * product's OWN output rather than any grader's prose: a POST that returned 500 carried
 * 0 db_reads and 0 db_diffs for its own requestId, and the failing statement appears
 * nowhere in the bundle. Three DISTINCT ground-truth subjects showed it.
 *
 * WHAT THIS PROBE DELIBERATELY DOES NOT DO: name an event kind, a field name, or a
 * placement in the bundle. Those are the implementer's design. It pins the BEHAVIOUR —
 * that a raised statement leaves a record naming what was attempted and what went wrong,
 * that the record is distinguishable from "our own instrumentation threw", and that the
 * host's error still propagates untouched.
 */
import { describe, expect, it } from "vitest";
import { CAPTURE_GAP_EVENT_KIND, type BugEvent } from "crumbtrail-core";
import { instrumentPgClient } from "../db";

class PgError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "error";
    this.code = code;
  }
}

/** A client whose SELECTs succeed and whose one INSERT raises, as a real driver does. */
function rejectingPgClient(error: Error) {
  return {
    query(text: string) {
      if (/^\s*insert/i.test(text)) return Promise.reject(error);
      return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 });
    },
  };
}

describe("a database statement that RAISED is recorded, not silently dropped", () => {
  it("emits a record naming the attempted statement and the error when the host INSERT rejects", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(rejectingPgClient(new PgError("duplicate key value violates unique constraint", "23505")), {
      requestId: "req-failed-insert",
      sessionId: "ses-acceptance",
      emit: (event) => events.push(event),
    });

    // The host error must still reach the caller, unchanged. Capture never swallows it.
    await expect(
      db.query("INSERT INTO points_ledger (user_id, delta) VALUES ($1, $2)", [7, 100]),
    ).rejects.toMatchObject({ code: "23505" });

    // SOMETHING must describe the attempt. Today: nothing is emitted at all.
    expect(events.length, "a raised statement emitted no event whatsoever").toBeGreaterThan(0);

    const described = events.filter((event) => {
      const text = JSON.stringify(event);
      return text.includes("points_ledger") && text.includes("23505");
    });

    expect(
      described.length,
      "no emitted event names both the table that was written and the error the database returned",
    ).toBeGreaterThan(0);

    // It must not be reported as a capture gap. `capture_exception` means OUR instrumentation
    // threw — a different fact with a different owner. Reusing it here would tell the reader
    // the tooling broke when in truth the application's statement failed.
    for (const event of described) {
      expect(
        event.k,
        "the failed host statement was reported as a capture gap, which says the SDK broke",
      ).not.toBe(CAPTURE_GAP_EVENT_KIND);
    }

    // The bind values are the caller's data and must not travel. The SDK's existing stance
    // (`captureErrorName` returns only an error class name) is the one to keep.
    for (const event of described) {
      const text = JSON.stringify(event);
      expect(text, "a bind value leaked into the failed-statement record").not.toContain(
        "duplicate key value violates unique constraint",
      );
    }
  });

  it("a SELECT that raises is recorded too — the gap is not specific to writes", async () => {
    const events: BugEvent[] = [];
    const client = {
      query(text: string) {
        if (/^\s*select/i.test(text))
          return Promise.reject(new PgError('column "reward_tier" does not exist', "42703"));
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const db = instrumentPgClient(client, {
      requestId: "req-failed-select",
      sessionId: "ses-acceptance",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await expect(db.query("SELECT reward_tier FROM accounts WHERE id = $1", [7])).rejects.toMatchObject({
      code: "42703",
    });

    const described = events.filter((event) => {
      const text = JSON.stringify(event);
      return text.includes("accounts") && text.includes("42703");
    });
    expect(
      described.length,
      "a SELECT that raised left no record naming the table and the error",
    ).toBeGreaterThan(0);
  });
});
