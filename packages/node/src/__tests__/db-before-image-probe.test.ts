import { describe, expect, it } from "vitest";
import {
  CAPTURE_GAP_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  type BugEvent,
  type DbDiffEventData,
} from "crumbtrail-core";
import { rebindNumberedPlaceholders } from "../db/sql";
import { instrumentPgClient } from "../db";

/**
 * The before-image probe is the one statement the shim issues on the host's own connection. These
 * suites bind the three properties that makes safe: it is bound completely or not issued, it can
 * never cost the host its transaction, and when it yields nothing it says so.
 */

describe("rebindNumberedPlaceholders", () => {
  it("renumbers a clause whose placeholders do not start at $1", () => {
    expect(rebindNumberedPlaceholders("WHERE id = $2", [250, 7])).toEqual({
      text: "WHERE id = $1",
      params: [7],
    });
  });

  it("returns a clause with no placeholders unchanged and binds nothing", () => {
    expect(
      rebindNumberedPlaceholders("WHERE status = 'pending'", ["shipped"]),
    ).toEqual({ text: "WHERE status = 'pending'", params: [] });
  });

  it("renumbers several placeholders in first-appearance order", () => {
    expect(
      rebindNumberedPlaceholders("WHERE paid_cents = $1 AND number = $3", [
        100,
        "open",
        "INV-9",
      ]),
    ).toEqual({
      text: "WHERE paid_cents = $1 AND number = $2",
      params: [100, "INV-9"],
    });
  });

  it("takes only the WHERE values when placeholders sit in both SET and WHERE", () => {
    // UPDATE team_invoices SET paid_cents = $1, status = $2 WHERE number = $3
    expect(
      rebindNumberedPlaceholders("WHERE number = $3", [100, "paid", "INV-9"]),
    ).toEqual({ text: "WHERE number = $1", params: ["INV-9"] });
  });

  it("renumbers placeholders inside a subquery in the clause", () => {
    expect(
      rebindNumberedPlaceholders(
        "WHERE tier_id IN (SELECT id FROM tiers WHERE name = $2) AND id = $3",
        [100, "gold", 1],
      ),
    ).toEqual({
      text: "WHERE tier_id IN (SELECT id FROM tiers WHERE name = $1) AND id = $2",
      params: ["gold", 1],
    });
  });

  it("collapses a repeated placeholder onto one number and binds it once", () => {
    expect(
      rebindNumberedPlaceholders("WHERE id = $2 OR parent_id = $2", [1, 42]),
    ).toEqual({ text: "WHERE id = $1 OR parent_id = $1", params: [42] });
  });

  it("does not rewrite $1 inside a multi-digit placeholder", () => {
    const params = Array.from({ length: 12 }, (_value, index) => index);
    expect(rebindNumberedPlaceholders("WHERE id = $12", params)).toEqual({
      text: "WHERE id = $1",
      params: [11],
    });
  });

  it("ignores placeholder-looking text inside a dollar-quoted body", () => {
    expect(
      rebindNumberedPlaceholders(
        "WHERE note = $tag$cost is $9$tag$ AND id = $2",
        [1, 5],
      ),
    ).toEqual({
      text: "WHERE note = $tag$cost is $9$tag$ AND id = $1",
      params: [5],
    });
  });

  it("refuses a clause referencing a placeholder past the end of the params", () => {
    expect(rebindNumberedPlaceholders("WHERE id = $4", [1, 2])).toBeUndefined();
  });

  it("refuses a clause with placeholders when no params array was supplied", () => {
    expect(
      rebindNumberedPlaceholders("WHERE id = $1", undefined),
    ).toBeUndefined();
  });
});

/** Records every statement and lets a test decide which one fails, and how. */
function scriptedClient(
  fail: (text: string) => Error | undefined = () => undefined,
) {
  const calls: string[] = [];
  return {
    calls,
    query(text: string, params?: unknown[]) {
      calls.push(text);
      const error = fail(text);
      if (error) return Promise.reject(error);
      if (/^select/i.test(text))
        return Promise.resolve({ rows: [{ id: 3, status: "pending" }] });
      if (/^(savepoint|release|rollback)/i.test(text))
        return Promise.resolve({ rows: [] });
      return Promise.resolve({
        rows: [{ id: 3, status: "shipped" }],
        rowCount: 1,
        params,
      });
    },
  };
}

/** A client that reports no open transaction, the way Postgres answers a bare pool query. */
function untransactedClient() {
  return scriptedClient((text) => {
    if (!/^savepoint/i.test(text)) return undefined;
    const error = new Error(
      "SAVEPOINT can only be used in transaction blocks",
    ) as Error & { code?: string };
    error.code = "25P01";
    return error;
  });
}

function collect(): { events: BugEvent[]; emit: (event: BugEvent) => void } {
  const events: BugEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

const diffOf = (events: BugEvent[]): DbDiffEventData =>
  events.find((event) => event.k === DB_DIFF_EVENT_KIND)!
    .d as unknown as DbDiffEventData;

describe("before-image probe binding", () => {
  it("issues a self-contained probe for an UPDATE whose WHERE starts past $1", async () => {
    const client = scriptedClient();
    const { events, emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-1",
      captureBefore: true,
      emit,
    });

    await db.query(
      "UPDATE reward_accounts SET balance_cents = balance_cents + $1 WHERE id = $2",
      [250, 3],
    );

    expect(client.calls).toContain(
      "SELECT * FROM reward_accounts WHERE id = $1",
    );
    expect(diffOf(events).before).toEqual({ id: 3, status: "pending" });
  });

  it("does not issue a probe it cannot bind, and says so", async () => {
    // A clause referencing more parameters than the call supplied cannot be bound completely.
    const client = scriptedClient();
    const { events, emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-2",
      captureBefore: true,
      emit,
    });

    await db.query("UPDATE orders SET status = 'x' WHERE id = $2", [3]);

    expect(client.calls.some((text) => /^select/i.test(text))).toBe(false);
    expect(diffOf(events).beforeImageStatus).toEqual({
      status: "unavailable",
      reason: "before_probe_unbindable",
    });
  });
});

describe("before-image probe transaction safety", () => {
  it("guards the probe with a savepoint and releases it on success", async () => {
    const client = scriptedClient();
    const { emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-3",
      captureBefore: true,
      emit,
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      "shipped",
      3,
    ]);

    expect(client.calls).toEqual([
      "SAVEPOINT crumbtrail_before_image_probe",
      "SELECT * FROM orders WHERE id = $1",
      "RELEASE SAVEPOINT crumbtrail_before_image_probe",
      "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
    ]);
  });

  it("rolls back to the savepoint when the probe throws for an unforeseen reason", async () => {
    // The guard has to hold for failures the shim cannot name, which is the whole point of it.
    const client = scriptedClient((text) =>
      /^select/i.test(text) ? new Error("division by zero") : undefined,
    );
    const { events, emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-4",
      captureBefore: true,
      emit,
    });

    const result = await db.query(
      "UPDATE orders SET status = $1 WHERE id = $2",
      ["shipped", 3],
    );

    expect(client.calls).toEqual([
      "SAVEPOINT crumbtrail_before_image_probe",
      "SELECT * FROM orders WHERE id = $1",
      "ROLLBACK TO SAVEPOINT crumbtrail_before_image_probe",
      "RELEASE SAVEPOINT crumbtrail_before_image_probe",
      "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
    ]);
    // The host's statement ran and its real result came back unchanged.
    expect(result).toMatchObject({ rowCount: 1 });
    expect(diffOf(events).after).toEqual({ id: 3, status: "shipped" });
  });

  it("probes without a savepoint when Postgres reports no open transaction", async () => {
    const client = untransactedClient();
    const { events, emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-5",
      captureBefore: true,
      emit,
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      "shipped",
      3,
    ]);

    expect(client.calls).toEqual([
      "SAVEPOINT crumbtrail_before_image_probe",
      "SELECT * FROM orders WHERE id = $1",
      "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
    ]);
    expect(diffOf(events).before).toEqual({ id: 3, status: "pending" });
  });

  it("does not guard a pool query, whose probe cannot reach a host transaction", async () => {
    // A savepoint on a pool lands on a third connection: it protects nothing, and the checkout it
    // costs would appear in the pool-pressure stream as real pressure.
    const client = {
      ...scriptedClient(),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    };
    const { events, emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-pool",
      captureBefore: true,
      emit,
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      "shipped",
      3,
    ]);

    expect(client.calls).toEqual([
      "SELECT * FROM orders WHERE id = $1",
      "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
    ]);
    expect(diffOf(events).before).toEqual({ id: 3, status: "pending" });
  });

  it("declines to probe when the guard cannot be established for another reason", async () => {
    const client = scriptedClient((text) =>
      /^savepoint/i.test(text) ? new Error("connection terminated") : undefined,
    );
    const { events, emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-6",
      captureBefore: true,
      emit,
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      "shipped",
      3,
    ]);

    expect(client.calls.some((text) => /^select/i.test(text))).toBe(false);
    expect(diffOf(events).beforeImageStatus).toEqual({
      status: "unavailable",
      reason: "before_probe_unguarded",
    });
  });
});

describe("before-image probe failure reporting", () => {
  it("marks the diff so a failed probe cannot read as capture being switched off", async () => {
    const client = scriptedClient((text) =>
      /^select/i.test(text)
        ? new Error("permission denied for table orders")
        : undefined,
    );
    const { events, emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-7",
      captureBefore: true,
      emit,
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      "shipped",
      3,
    ]);

    const diff = diffOf(events);
    expect(diff.before).toBeUndefined();
    expect(diff.beforeImageStatus).toEqual({
      status: "unavailable",
      reason: "before_probe_failed",
    });
    // The gap event stays: it carries the driver's own error name.
    expect(events.some((event) => event.k === CAPTURE_GAP_EVENT_KIND)).toBe(
      true,
    );
  });

  it("leaves the status unset when the probe succeeded", async () => {
    const client = scriptedClient();
    const { events, emit } = collect();
    const db = instrumentPgClient(client, {
      requestId: "req-8",
      captureBefore: true,
      emit,
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      "shipped",
      3,
    ]);

    expect(diffOf(events).beforeImageStatus).toBeUndefined();
  });
});
