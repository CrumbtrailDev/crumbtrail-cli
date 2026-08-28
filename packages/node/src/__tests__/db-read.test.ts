import { describe, expect, it } from "vitest";
import {
  type BugEvent,
  type DbReadBulkEventData,
  type DbReadEventData,
} from "crumbtrail-core";
import { instrumentPgClient, parseRead } from "../db";
import { DEFAULT_MAX_SESSION_EVENT_BYTES } from "../writer";

/**
 * `db.statement` is emitted for EVERY instrumented statement, whatever it returned, so it appears
 * in every stream in this file and is evidence about neither row reads nor row diffs — which is
 * what these suites bind. Its own behaviour, including that it survives when nothing else is
 * captured, is bound in `db-successful-statement.test.ts`.
 */
const notStatement = (event: BugEvent): boolean => event.k !== "db.statement";

const DB_READ_EVENT_KIND = "db.read";
const DB_READ_BULK_EVENT_KIND = "db.read.bulk";

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

function rows(count: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    rank: index + 1,
    ...extra,
  }));
}

describe("parseRead", () => {
  it("parses simple SELECT table names and ignores mutations", () => {
    expect(
      parseRead("SELECT * FROM invoice_rankings WHERE tenant_id = $1"),
    ).toEqual({ table: "invoice_rankings" });
    expect(parseRead('select id from "InvoiceRanking"')).toEqual({
      table: "InvoiceRanking",
    });
    expect(parseRead("UPDATE invoice_rankings SET rank = 3")).toBeUndefined();
  });
});

describe("instrumentPgClient read capture", () => {
  it("does not capture SELECT rows unless captureReads is enabled", async () => {
    const client = fakePgClient(rows(1));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-default-off",
      emit: (event) => {
        if (notStatement(event)) events.push(event);
      },
    });

    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = $1", [
      "acme",
    ]);

    expect(events).toEqual([]);
  });

  it("emits capped, redacted db.read events when captureReads is enabled", async () => {
    const client = fakePgClient(
      rows(2, { token: "tok_secret_value_should_vanish" }),
    );
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-read",
      sessionId: "ses-read",
      captureReads: true,
      emit: (event) => {
        if (notStatement(event)) events.push(event);
      },
      now: () => 1_800_000_000_250,
      sessionStartedAt: 1_800_000_000_000,
    });

    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = $1", [
      "acme",
    ]);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.k)).toEqual([
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
    ]);
    expect(events[0].sessionId).toBe("ses-read");
    expect(events[0].offsetMs).toBe(250);
    const d = events[0].d as unknown as DbReadEventData;
    expect(d).toMatchObject({
      engine: "postgres",
      table: "invoice_rankings",
      pk: { id: 1 },
      requestId: "req-read",
      row: { id: 1, rank: 1, token: "[REDACTED]" },
    });
    expect(JSON.stringify(events)).not.toContain(
      "tok_secret_value_should_vanish",
    );
    expect((events[0].d as Record<string, unknown>).callsite).toBeUndefined();
  });

  it("captures one callsite per read shape when captureCallsite is enabled", async () => {
    const client = fakePgClient(rows(1));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-read-callsite",
      captureReads: true,
      captureCallsite: true,
      emit: (event) => {
        if (notStatement(event)) events.push(event);
      },
    });

    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = $1", [
      "acme",
    ]);
    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = $1", [
      "beta",
    ]);

    const reads = events.filter((event) => event.k === DB_READ_EVENT_KIND);
    expect(reads).toHaveLength(2);
    expect((reads[0].d as Record<string, unknown>).callsite).toMatchObject({
      file: expect.stringContaining("db-read.test.ts"),
      line: expect.any(Number),
    });
    expect((reads[1].d as Record<string, unknown>).callsite).toEqual(
      (reads[0].d as Record<string, unknown>).callsite,
    );
  });

  it("caps successful-read callsite captures at eight shapes per request", async () => {
    const client = fakePgClient(rows(1));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-read-callsite-cap",
      captureReads: true,
      captureCallsite: true,
      emit: (event) => {
        if (notStatement(event)) events.push(event);
      },
    });

    for (let index = 0; index < 9; index += 1) {
      await db.query(`SELECT * FROM table_${index} WHERE id = $1`, [index]);
    }

    const reads = events.filter((event) => event.k === DB_READ_EVENT_KIND);
    expect(reads).toHaveLength(9);
    for (const read of reads.slice(0, 8)) {
      expect((read.d as Record<string, unknown>).callsite).toBeDefined();
    }
    expect((reads[8].d as Record<string, unknown>).callsite).toBeUndefined();
  });

  it("emits db.read.bulk instead of flooding a session for large reads", async () => {
    const client = fakePgClient(rows(5));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-bulk",
      captureReads: true,
      maxReadRowsPerStatement: 2,
      emit: (event) => {
        if (notStatement(event)) events.push(event);
      },
    });

    await db.query("SELECT * FROM invoice_rankings");

    expect(events.map((event) => event.k)).toEqual([
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_BULK_EVENT_KIND,
    ]);
    expect(events[2].d as unknown as DbReadBulkEventData).toEqual({
      engine: "postgres",
      table: "invoice_rankings",
      requestId: "req-bulk",
      rowCount: 5,
      emittedRows: 2,
      truncatedRows: 3,
      samplePks: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
  });

  it("enforces a per-request read row cap across multiple statements", async () => {
    const client = fakePgClient(rows(3));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-request-cap",
      captureReads: true,
      maxReadRowsPerStatement: 3,
      maxReadRowsPerRequest: 4,
      emit: (event) => {
        if (notStatement(event)) events.push(event);
      },
    });

    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = $1", [
      "acme",
    ]);
    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = $1", [
      "beta",
    ]);

    expect(events.map((event) => event.k)).toEqual([
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_BULK_EVENT_KIND,
    ]);
    expect(events[4].d).toMatchObject({
      rowCount: 3,
      emittedRows: 1,
      truncatedRows: 2,
    });
  });

  it("tracks read row caps separately when a reused client sees a new request id", async () => {
    const client = fakePgClient(rows(2));
    const events: BugEvent[] = [];
    let activeRequestId = "req-a";
    const db = instrumentPgClient(client, {
      getRequestId: () => activeRequestId,
      captureReads: true,
      maxReadRowsPerStatement: 2,
      maxReadRowsPerRequest: 2,
      emit: (event) => {
        if (notStatement(event)) events.push(event);
      },
    });

    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = $1", [
      "acme",
    ]);
    activeRequestId = "req-b";
    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = $1", [
      "beta",
    ]);

    expect(events.map((event) => event.k)).toEqual([
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
    ]);
    expect(events.map((event) => event.d.requestId)).toEqual([
      "req-a",
      "req-a",
      "req-b",
      "req-b",
    ]);
  });

  it("keeps a bulk read far below the 50 MB session event cap", async () => {
    const huge = "safe prose value ".repeat(2_000);
    const client = fakePgClient(rows(5_000, { notes: huge }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-size-budget",
      captureReads: true,
      maxReadRowsPerStatement: 3,
      emit: (event) => {
        if (notStatement(event)) events.push(event);
      },
    });

    await db.query("SELECT * FROM invoice_rankings");

    const bytes = Buffer.byteLength(
      events.map((event) => JSON.stringify(event)).join("\n"),
      "utf8",
    );
    expect(
      events.filter((event) => event.k === DB_READ_EVENT_KIND),
    ).toHaveLength(3);
    expect(
      events.filter((event) => event.k === DB_READ_BULK_EVENT_KIND),
    ).toHaveLength(1);
    expect(bytes).toBeLessThan(DEFAULT_MAX_SESSION_EVENT_BYTES / 100);
    expect(JSON.stringify(events)).not.toContain(huge);
  });
});
