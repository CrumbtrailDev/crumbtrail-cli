import { describe, expect, it } from "vitest";
import {
  DB_POOL_TIMEOUT_EVENT_KIND,
  DB_POOL_WAIT_EVENT_KIND,
  type BugEvent,
} from "crumbtrail-core";
import { instrumentMssqlPool } from "../db/mssql";
import { instrumentMysqlClient } from "../db/mysql";
import { instrumentPgClient } from "../db/pg";
import { instrumentPostgresSql } from "../db/postgres-js";

function clock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe("database pool checkout capture", () => {
  it("records pg promise checkout wait time", async () => {
    const events: BugEvent[] = [];
    const acquired = { query: async () => ({ rows: [], rowCount: 0 }) };
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => acquired,
    };
    const db = instrumentPgClient(pool, {
      requestId: "req-pg-pool",
      now: clock(100, 145),
      emit: (event) => events.push(event),
    });

    await db.connect();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      k: DB_POOL_WAIT_EVENT_KIND,
      d: { engine: "postgres", waitMs: 45, requestId: "req-pg-pool" },
    });
  });

  it("records mysql2 getConnection wait time without altering the connection", async () => {
    const events: BugEvent[] = [];
    const connection = { release() {} };
    const pool = {
      query: async () => [[], []],
      getConnection: async () => connection,
    };
    const db = instrumentMysqlClient(pool, {
      requestId: "req-mysql-pool",
      now: clock(20, 32),
      emit: (event) => events.push(event),
    });

    await expect(db.getConnection()).resolves.toBe(connection);
    expect(events[0]).toMatchObject({
      k: DB_POOL_WAIT_EVENT_KIND,
      d: { engine: "mysql", waitMs: 12, requestId: "req-mysql-pool" },
    });
  });

  it("records postgres.js reserve wait time and keeps the reserved client callable", async () => {
    const events: BugEvent[] = [];
    const reserved = (() => ({})) as ((...args: unknown[]) => unknown) & {
      unsafe?: unknown;
    };
    const sql = (() => ({})) as ((...args: unknown[]) => unknown) & {
      reserve: () => Promise<typeof reserved>;
    };
    sql.reserve = async () => reserved;
    const db = instrumentPostgresSql(sql, {
      requestId: "req-postgres-js-pool",
      now: clock(500, 509),
      emit: (event) => events.push(event),
    });

    const value = await db.reserve();

    expect(typeof value).toBe("function");
    expect(events[0]).toMatchObject({
      k: DB_POOL_WAIT_EVENT_KIND,
      d: {
        engine: "postgres",
        waitMs: 9,
        requestId: "req-postgres-js-pool",
      },
    });
  });

  it("records mssql ETIMEOUT as a distinct event without its message", async () => {
    const events: BugEvent[] = [];
    const timeout = Object.assign(new Error("tenant secret in timeout"), {
      code: "ETIMEOUT",
    });
    const pool = {
      request: () => ({ input: () => undefined, query: async () => ({}) }),
      acquire: async (_requester: unknown) => Promise.reject(timeout),
    };
    const db = instrumentMssqlPool(pool, {
      requestId: "req-mssql-pool",
      now: clock(1_000, 1_250),
      emit: (event) => events.push(event),
    });

    await expect(db.acquire({})).rejects.toBe(timeout);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      k: DB_POOL_TIMEOUT_EVENT_KIND,
      d: {
        engine: "mssql",
        waitMs: 250,
        code: "ETIMEOUT",
        errorName: "Error",
        requestId: "req-mssql-pool",
      },
    });
    expect(JSON.stringify(events[0])).not.toContain("tenant secret");
  });

  it("does not guess a pg checkout timeout from message text", async () => {
    const events: BugEvent[] = [];
    const timeout = new Error(
      "timeout exceeded while waiting for a client secret",
    );
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => Promise.reject(timeout),
    };
    const db = instrumentPgClient(pool, {
      requestId: "req-pg-timeout",
      now: clock(0, 50),
      emit: (event) => events.push(event),
    });

    await expect(db.connect()).rejects.toBe(timeout);
    expect(events).toEqual([]);
  });
});
