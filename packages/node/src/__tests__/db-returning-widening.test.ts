import { describe, it, expect } from "vitest";
import type { BugEvent, DbDiffEventData } from "crumbtrail-core";
import { instrumentPgClient, planReturning } from "../db";

/**
 * A statement that names its own `RETURNING` columns used to decide the after-image, so an
 * `INSERT INTO jobs (type, payload, status, ...) RETURNING id` reached the bundle as `{"id":1}` —
 * every column describing what the write did, gone, because the caller only needed the key back.
 */
function fakePgClient(
  handler: (text: string, params?: unknown[]) => { rows: unknown[] },
) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return Promise.resolve(handler(text, params));
    },
  };
}

describe("planReturning", () => {
  it("appends RETURNING * when the statement has none", () => {
    const plan = planReturning("INSERT INTO orders (name) VALUES ($1)");
    expect(plan.text).toBe("INSERT INTO orders (name) VALUES ($1) RETURNING *");
    expect(plan.projectTo).toBeUndefined();
  });

  it("widens a narrow column list and records what to project back", () => {
    const plan = planReturning(
      "INSERT INTO orders (user_id, total_cents) VALUES ($1,$2) RETURNING id, total_cents",
    );
    expect(plan.text).toBe(
      "INSERT INTO orders (user_id, total_cents) VALUES ($1,$2) RETURNING *",
    );
    expect(plan.projectTo).toEqual(["id", "total_cents"]);
  });

  it("lower-cases unquoted identifiers and keeps quoted ones as written", () => {
    const plan = planReturning('UPDATE t SET a = 1 RETURNING Id, "MixedCase"');
    expect(plan.projectTo).toEqual(["id", "MixedCase"]);
  });

  it("leaves RETURNING * alone", () => {
    const sql = "DELETE FROM widgets WHERE id = $1 RETURNING *";
    expect(planReturning(sql)).toEqual({ text: sql });
  });

  it("leaves an aliased or computed list alone rather than risk a missing column", () => {
    for (const sql of [
      "INSERT INTO t (a) VALUES ($1) RETURNING id AS order_id",
      "INSERT INTO t (a) VALUES ($1) RETURNING coalesce(a, 0)",
      "INSERT INTO t (a) VALUES ($1) RETURNING t.id",
    ]) {
      expect(planReturning(sql)).toEqual({ text: sql });
    }
  });

  it("survives a trailing semicolon", () => {
    expect(planReturning("INSERT INTO t (a) VALUES ($1);").text).toBe(
      "INSERT INTO t (a) VALUES ($1) RETURNING *",
    );
    expect(planReturning("INSERT INTO t (a) VALUES ($1) RETURNING id;")).toEqual(
      {
        text: "INSERT INTO t (a) VALUES ($1) RETURNING *",
        projectTo: ["id"],
      },
    );
  });
});

describe("instrumentPgClient with a host-supplied RETURNING list", () => {
  it("captures the whole row and hands the caller only the columns it named", async () => {
    const client = fakePgClient(() => ({
      rows: [
        {
          id: 1,
          type: "record_payment",
          payload: '{"orderId":1}',
          status: "pending",
          attempts: 0,
        },
      ],
    }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-jobs",
      emit: (event) => events.push(event),
    });

    const result = await db.query(
      "INSERT INTO jobs (type, payload, status, attempts) VALUES ($1,$2,'pending',0) RETURNING id",
      ["record_payment", '{"orderId":1}'],
    );

    expect(client.calls[0].text).toMatch(/returning \*$/i);
    const diff = events[0].d as unknown as DbDiffEventData;
    expect(diff.after).toEqual({
      id: 1,
      type: "record_payment",
      payload: '{"orderId":1}',
      status: "pending",
      attempts: 0,
    });
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  it("does not project when the statement had no RETURNING of its own", async () => {
    const client = fakePgClient(() => ({ rows: [{ id: 4, name: "Ada" }] }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-plain",
      emit: (event) => events.push(event),
    });

    const result = await db.query("INSERT INTO people (name) VALUES ($1)", [
      "Ada",
    ]);

    expect(result.rows).toEqual([{ id: 4, name: "Ada" }]);
    const diff = events[0].d as unknown as DbDiffEventData;
    expect(diff.after).toEqual({ id: 4, name: "Ada" });
  });
});
