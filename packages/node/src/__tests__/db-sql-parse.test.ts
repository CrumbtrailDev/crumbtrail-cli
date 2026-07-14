import { describe, expect, it } from "vitest";
import {
  DB_DIFF_BULK_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  type BugEvent,
  type DbDiffBulkEventData,
  type DbDiffEventData,
} from "crumbtrail-core";
import { countPlaceholders, parseMutation, parseRead } from "../db/sql";
import {
  emitImagelessDbDiff,
  type InstrumentDbClientOptions,
} from "../db/instrument-shared";

describe("countPlaceholders", () => {
  it("counts bare positional placeholders", () => {
    expect(countPlaceholders("id = ? AND name = ?")).toBe(2);
    expect(countPlaceholders("no params here")).toBe(0);
  });

  it("ignores placeholders inside single- and double-quoted string literals", () => {
    expect(countPlaceholders("note = 'is this ok?' AND id = ?")).toBe(1);
    expect(countPlaceholders(`label = "why? really" AND id = ?`)).toBe(1);
  });

  it("treats doubled quotes as escaped quotes inside a literal", () => {
    // The '' is an escaped quote, so the literal stays open across the inner `?`.
    expect(countPlaceholders("note = 'it''s a ? mark' AND id = ?")).toBe(1);
  });

  it("ignores placeholders inside backtick and bracket quoted identifiers", () => {
    expect(countPlaceholders("`weird?col` = ? AND id = ?")).toBe(2);
    expect(countPlaceholders("[weird?col] = ? AND id = ?")).toBe(2);
  });
});

describe("parseMutation dialect identifier handling", () => {
  it("strips backtick-quoted identifiers (MySQL)", () => {
    expect(parseMutation("INSERT INTO `orders` (name) VALUES (?)")).toEqual({
      op: "insert",
      table: "orders",
    });
  });

  it("strips bracket-quoted identifiers (MSSQL)", () => {
    expect(parseMutation("INSERT INTO [orders] (name) VALUES (@p0)")).toEqual({
      op: "insert",
      table: "orders",
    });
  });

  it("normalizes schema-qualified names to dot-joined bare names", () => {
    expect(
      parseMutation("INSERT INTO [dbo].[orders] (name) VALUES (@p0)"),
    ).toEqual({ op: "insert", table: "dbo.orders" });
    expect(parseMutation("INSERT INTO `db`.`t` (a) VALUES (?)")).toEqual({
      op: "insert",
      table: "db.t",
    });
    expect(
      parseMutation('UPDATE "s"."t" SET a = 1 WHERE id = 2'),
    ).toMatchObject({ op: "update", table: "s.t" });
  });

  it("tolerates MSSQL TOP (n) / TOP n on DELETE and UPDATE", () => {
    expect(
      parseMutation("DELETE TOP (10) FROM orders WHERE status = 'x'"),
    ).toMatchObject({ op: "delete", table: "orders" });
    expect(parseMutation("DELETE TOP 10 FROM [dbo].[orders]")).toMatchObject({
      op: "delete",
      table: "dbo.orders",
    });
    expect(
      parseMutation("UPDATE TOP (5) orders SET status = 'done' WHERE id = 1"),
    ).toMatchObject({ op: "update", table: "orders" });
  });

  it("still parses the plain Postgres shapes unchanged", () => {
    expect(parseMutation("INSERT INTO orders (name) VALUES ($1)")).toEqual({
      op: "insert",
      table: "orders",
    });
    expect(parseRead('select id from "InvoiceRanking"')).toEqual({
      table: "InvoiceRanking",
    });
  });
});

/** Options collecting emitted events for the shared-helper tests. */
function collectingOptions(
  events: BugEvent[],
  overrides: Partial<InstrumentDbClientOptions> = {},
): InstrumentDbClientOptions {
  return {
    emit: (event) => events.push(event),
    now: () => 1_700_000_000_250,
    sessionStartedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("emitImagelessDbDiff", () => {
  it("emits one image-less db.diff with pk null, rowCount, and the engine tag", () => {
    const events: BugEvent[] = [];
    emitImagelessDbDiff({
      engine: "mysql",
      op: "insert",
      table: "orders",
      requestId: "req-imageless",
      rowCount: 3,
      options: collectingOptions(events, { sessionId: "ses-x" }),
    });

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe(DB_DIFF_EVENT_KIND);
    expect(events[0].sessionId).toBe("ses-x");
    expect(events[0].offsetMs).toBe(250);
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.engine).toBe("mysql");
    expect(d.op).toBe("insert");
    expect(d.table).toBe("orders");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(3);
    expect(d.after).toBeUndefined();
    expect(d.before).toBeUndefined();
  });

  it("adds a db.diff.bulk summary when rowCount exceeds the per-statement cap", () => {
    const events: BugEvent[] = [];
    emitImagelessDbDiff({
      engine: "mysql",
      op: "insert",
      table: "orders",
      requestId: "req-over",
      rowCount: 5,
      options: collectingOptions(events, { maxRowsPerStatement: 3 }),
    });

    expect(events.map((event) => event.k)).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_BULK_EVENT_KIND,
    ]);
    expect(events[1].d as unknown as DbDiffBulkEventData).toEqual({
      engine: "mysql",
      op: "insert",
      table: "orders",
      requestId: "req-over",
      rowCount: 5,
      emittedRows: 0,
      truncatedRows: 5,
      samplePks: [],
    });
  });

  it("omits the bulk summary when rowCount is within the cap", () => {
    const events: BugEvent[] = [];
    emitImagelessDbDiff({
      engine: "sqlite",
      op: "insert",
      table: "orders",
      requestId: "req-under",
      rowCount: 2,
      options: collectingOptions(events, { maxRowsPerStatement: 3 }),
    });

    expect(events.map((event) => event.k)).toEqual([DB_DIFF_EVENT_KIND]);
  });
});
