import { describe, expect, it } from "vitest";
import {
  DB_DIFF_BULK_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  type BugEvent,
  type DbDiffBulkEventData,
} from "crumbtrail-core";
import { instrumentPgClient } from "../db";

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    status: "ready",
  }));
}

function fakePgClient(resultRows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return Promise.resolve({ rows: resultRows, rowCount: resultRows.length });
    },
  };
}

describe("instrumentPgClient bulk cap", () => {
  it("emits only per-row db.diff events when row count is under the cap", async () => {
    const client = fakePgClient(rows(2));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-under",
      maxRowsPerStatement: 3,
      emit: (e) => events.push(e),
    });

    await db.query("UPDATE orders SET status = $1 WHERE status = $2", [
      "ready",
      "pending",
    ]);

    expect(events.map((event) => event.k)).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
    ]);
  });

  it("emits only per-row db.diff events when row count is exactly at the cap", async () => {
    const client = fakePgClient(rows(3));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-exact",
      maxRowsPerStatement: 3,
      emit: (e) => events.push(e),
    });

    await db.query("UPDATE orders SET status = $1 WHERE status = $2", [
      "ready",
      "pending",
    ]);

    expect(events.map((event) => event.k)).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
    ]);
  });

  it("emits capped per-row db.diff events plus one db.diff.bulk summary when over the cap", async () => {
    const client = fakePgClient(rows(5));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-over",
      sessionId: "ses-over",
      maxRowsPerStatement: 3,
      emit: (e) => events.push(e),
      now: () => 1_700_000_000_250,
      sessionStartedAt: 1_700_000_000_000,
    });

    const result = await db.query(
      "UPDATE orders SET status = $1 WHERE status = $2",
      ["ready", "pending"],
    );

    expect(result).toEqual({ rows: rows(5), rowCount: 5 });
    expect(events).toHaveLength(4);
    expect(events.slice(0, 3).map((event) => event.k)).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
    ]);
    expect(events[3].k).toBe(DB_DIFF_BULK_EVENT_KIND);
    expect(events[3].sessionId).toBe("ses-over");
    expect(events[3].offsetMs).toBe(250);
    expect(events.slice(0, 3).map((event) => event.d.pk)).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    expect(events[3].d as unknown as DbDiffBulkEventData).toEqual({
      engine: "postgres",
      op: "update",
      table: "orders",
      requestId: "req-over",
      rowCount: 5,
      emittedRows: 3,
      truncatedRows: 2,
      samplePks: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
  });

  it("honors custom maxRowsPerStatement values", async () => {
    const client = fakePgClient(rows(4));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-custom",
      maxRowsPerStatement: 1,
      emit: (e) => events.push(e),
    });

    await db.query("INSERT INTO orders (status) VALUES ($1)", ["ready"]);

    expect(events.map((event) => event.k)).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_BULK_EVENT_KIND,
    ]);
    expect(events[1].d).toMatchObject({
      rowCount: 4,
      emittedRows: 1,
      truncatedRows: 3,
    });
  });

  it("uses the default cap of 100 rows", async () => {
    const client = fakePgClient(rows(101));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-default",
      emit: (e) => events.push(e),
    });

    await db.query("DELETE FROM orders WHERE status = $1", ["stale"]);

    expect(
      events.filter((event) => event.k === DB_DIFF_EVENT_KIND),
    ).toHaveLength(100);
    expect(
      events.filter((event) => event.k === DB_DIFF_BULK_EVENT_KIND),
    ).toHaveLength(1);
    expect(events[100].d).toMatchObject({
      rowCount: 101,
      emittedRows: 100,
      truncatedRows: 1,
    });
  });

  it("swallows bulk emission failures and still returns the host query result", async () => {
    const client = fakePgClient(rows(5));
    const db = instrumentPgClient(client, {
      requestId: "req-throw",
      maxRowsPerStatement: 3,
      emit: () => {
        throw new Error("sink exploded");
      },
    });

    const result = await db.query(
      "UPDATE orders SET status = $1 WHERE status = $2",
      ["ready", "pending"],
    );

    expect(result).toEqual({ rows: rows(5), rowCount: 5 });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].text).toMatch(/returning \*/i);
  });
});
