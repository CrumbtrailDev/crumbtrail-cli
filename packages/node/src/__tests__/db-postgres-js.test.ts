import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { instrumentPostgresSql } from "../db/postgres-js";

/**
 * A stand-in for porsager/postgres, faithful to the two things instrumentation
 * depends on: the callable builds a LAZY query object, and the driver settles it
 * by calling the query's own `resolve` / `reject`.
 */
interface FakeQuery {
  strings: string[];
  args: unknown[];
  string?: string;
  resolve: (value: unknown) => unknown;
  reject: (reason: unknown) => unknown;
  settled: Promise<unknown>;
}

interface FakeSql {
  (...args: unknown[]): FakeQuery;
  unsafe: (text: string, params?: unknown[]) => FakeQuery;
  begin: (fn: (tx: FakeSql) => unknown) => unknown;
  reserve: () => Promise<FakeSql>;
  /** Every query the fake driver was asked to build, newest last. */
  built: FakeQuery[];
}

function makeSql(): FakeSql {
  const built: FakeQuery[] = [];
  const build = (strings: string[], args: unknown[]): FakeQuery => {
    let resolve!: (value: unknown) => unknown;
    let reject!: (reason: unknown) => unknown;
    const settled = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    const query: FakeQuery = {
      strings,
      args,
      resolve: (value) => resolve(value),
      reject: (reason) => reject(reason),
      settled,
    };
    built.push(query);
    return query;
  };

  const sql = ((...args: unknown[]) => {
    const strings = args[0] as string[];
    return build([...strings], args.slice(1));
  }) as FakeSql;
  sql.built = built;
  sql.unsafe = (text: string, params: unknown[] = []) =>
    build([text], params);
  sql.begin = (fn) => fn(makeSql());
  sql.reserve = async () => makeSql();
  return sql;
}

/** Template-literal call shape: `sql\`…\`` becomes `sql(strings, ...values)`. */
function tag(parts: string[]): string[] {
  const strings = [...parts] as string[] & { raw?: string[] };
  strings.raw = [...parts];
  return strings;
}

/** Settle a query the way the driver would, with a postgres.js `Result`. */
function settle(
  query: FakeQuery,
  rows: Array<Record<string, unknown>>,
  extra: { count?: number; string?: string } = {},
): void {
  const result = Object.assign([...rows], {
    count: extra.count ?? rows.length,
    command: "SELECT",
  });
  if (extra.string) query.string = extra.string;
  query.resolve(result);
}

function options(events: BugEvent[], extra: Record<string, unknown> = {}) {
  return {
    emit: (event: BugEvent) => events.push(event),
    requestId: "req_1",
    ...extra,
  };
}

describe("instrumentPostgresSql", () => {
  it("appends RETURNING to an un-returning mutation and records the diff", async () => {
    const events: BugEvent[] = [];
    const raw = makeSql();
    const sql = instrumentPostgresSql(raw, options(events));

    const query = sql(
      tag(["update carts set total_cents = ", " where id = ", ""]),
      500,
      7,
    ) as FakeQuery;

    // The rewrite lands at the very end of the built statement, because
    // postgres.js emits each template fragment after the value before it.
    expect(query.strings[query.strings.length - 1]).toBe(" RETURNING *");

    settle(query, [{ id: 7, total_cents: 500 }], {
      string:
        "update carts set total_cents = $1 where id = $2 RETURNING *",
    });
    await query.settled;

    const kinds = events.map((e) => e.k);
    expect(kinds).toContain("db.statement");
    expect(kinds).toContain("db.diff");

    const diff = events.find((e) => e.k === "db.diff");
    expect(diff?.d.op).toBe("update");
    expect(diff?.d.table).toBe("carts");
    expect((diff?.d.after as Record<string, unknown>).total_cents).toBe(500);

    // The recorded statement is the one the reader will find in their own
    // repository, not the RETURNING rewrite capture added.
    const statement = events.find((e) => e.k === "db.statement");
    expect(String(statement?.d.statement)).not.toMatch(/RETURNING/i);
  });

  it("records a statement that raised, and rethrows the driver's own error", async () => {
    const events: BugEvent[] = [];
    const raw = makeSql();
    const sql = instrumentPostgresSql(raw, options(events));

    const query = sql(
      tag(["select * from orders where id = ", ""]),
      1,
    ) as FakeQuery;
    query.string = "select * from orders where id = $1";
    const failure = new Error("canceling statement due to statement timeout");
    query.reject(failure);

    await expect(query.settled).rejects.toBe(failure);
    const error = events.find((e) => e.k === "db.error");
    expect(error).toBeDefined();
    expect(error?.d.table).toBe("orders");
  });

  it("never rewrites a statement built from postgres.js helpers, and says so", async () => {
    const events: BugEvent[] = [];
    const raw = makeSql();
    const sql = instrumentPostgresSql(raw, options(events));

    // `sql(row)` expands into SQL of its own, so the statement cannot be
    // reconstructed exactly and must not be rewritten on a guess.
    const helper = { columns: ["a"] };
    const query = sql(tag(["insert into orders ", ""]), helper) as FakeQuery;
    expect(query.strings[query.strings.length - 1]).toBe("");

    settle(query, [], { string: "insert into orders (a) values ($1)" });
    await query.settled;

    const gap = events.find((e) => e.k === "capture_gap");
    expect(gap).toBeDefined();
    expect(gap?.d.surface).toBe("db_diff");
    // The statement is still recorded; only the after-image is missing.
    expect(events.some((e) => e.k === "db.statement")).toBe(true);
    expect(events.some((e) => e.k === "db.diff")).toBe(false);
  });

  it("instruments the sql handed to a transaction", async () => {
    const events: BugEvent[] = [];
    const raw = makeSql();
    const sql = instrumentPostgresSql(raw, options(events));

    let inner!: FakeQuery;
    (sql as unknown as FakeSql).begin((tx) => {
      inner = tx(
        tag(["delete from sessions where id = ", ""]),
        "abc",
      ) as unknown as FakeQuery;
      return undefined;
    });

    settle(inner, [{ id: "abc" }], {
      string: "delete from sessions where id = $1 RETURNING *",
    });
    await inner.settled;

    const diff = events.find((e) => e.k === "db.diff");
    expect(diff?.d.op).toBe("delete");
    expect(diff?.d.table).toBe("sessions");
  });

  it("records reads through sql.unsafe when captureReads is on", async () => {
    const events: BugEvent[] = [];
    const raw = makeSql();
    const sql = instrumentPostgresSql(
      raw,
      options(events, { captureReads: true }),
    );

    const query = (sql as unknown as FakeSql).unsafe(
      "select id, email from profiles where id = $1",
      [3],
    );
    settle(query, [{ id: 3, email: "a@b.test" }], {
      string: "select id, email from profiles where id = $1",
    });
    await query.settled;

    expect(events.some((e) => e.k === "db.read")).toBe(true);
    expect(events.some((e) => e.k === "db.statement")).toBe(true);
  });

  it("records nothing outside a request scope, and never breaks the call", () => {
    const events: BugEvent[] = [];
    const raw = makeSql();
    const sql = instrumentPostgresSql(raw, {
      emit: (event: BugEvent) => events.push(event),
      getRequestId: () => undefined,
    });

    const query = sql(tag(["select 1"])) as FakeQuery;
    expect(query.strings).toEqual(["select 1"]);
    expect(events).toHaveLength(0);
  });

  it("leaves a value that is not a postgres.js callable untouched", () => {
    const notSql = { query: vi.fn() };
    expect(instrumentPostgresSql(notSql, { emit: vi.fn() })).toBe(notSql);
  });
});
