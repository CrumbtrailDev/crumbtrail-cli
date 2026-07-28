import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// The live case: GET /api/orders/1 loaded the order by id with no user_id
// predicate, so the "Stranger" account (session user 4) read the "Owner"
// account's order (user_id 1) with a clean 200. The session stream carries
// both halves; the detector joins them.

function diff(
  t: number,
  table: string,
  after: Record<string, unknown>,
  requestId = "req-login",
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op: "insert", table, pk: { id: after.id }, after, requestId },
  } as unknown as BugEvent;
}

function read(
  t: number,
  table: string,
  row: Record<string, unknown>,
  requestId = "req-detail",
): BugEvent {
  return {
    t,
    k: "db.read",
    d: { engine: "postgres", table, pk: { id: row.id }, row, requestId, stmt: 1 },
  } as unknown as BugEvent;
}

function crossReads(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (c) => c.detector === "cross_user_read",
  );
}

describe("buildEvidenceCandidates — cross_user_read", () => {
  it("fires when a session's user reads a row owned by someone else", () => {
    const events = [
      diff(1000, "sessions", { id: "s-1", user_id: 4 }),
      read(2000, "orders", { id: 1, user_id: 1, total_cents: 19900 }),
    ];
    const hits = crossReads(events);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe(
      "Cross-user read: orders row owned by user 1 served to user 4",
    );
    expect(String(hits[0].anchor.message)).toContain("missing an ownership predicate");
  });

  it("stays silent when the reader owns the row", () => {
    const events = [
      diff(1000, "sessions", { id: "s-1", user_id: 4 }),
      read(2000, "orders", { id: 9, user_id: 4 }),
    ];
    expect(crossReads(events)).toHaveLength(0);
  });

  it("stays silent with no session trail — anonymous and token-auth flows", () => {
    // Ops consoles authenticate with tokens and never touch a sessions table;
    // an admin reading everyone's orders must not light this up.
    const events = [
      read(2000, "orders", { id: 1, user_id: 1 }),
      read(2010, "orders", { id: 2, user_id: 2 }),
    ];
    expect(crossReads(events)).toHaveLength(0);
  });

  it("tracks the most recent session — a re-login switches the active user", () => {
    const events = [
      diff(1000, "sessions", { id: "s-1", user_id: 3 }),
      diff(1500, "sessions", { id: "s-2", user_id: 4 }),
      read(2000, "orders", { id: 5, user_id: 3 }),
    ];
    // User 3's order read under user 4's session: fires, naming both.
    const hits = crossReads(events);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain("owned by user 3 served to user 4");
  });

  it("ignores rows without an owner column and the users table itself", () => {
    const events = [
      diff(1000, "sessions", { id: "s-1", user_id: 4 }),
      read(2000, "products", { id: 1, name: "Aurora", price_cents: 19900 }),
      // The login flow reads the user row of the account being verified.
      read(2010, "users", { id: 9, email: "x" }),
    ];
    expect(crossReads(events)).toHaveLength(0);
  });
});
