/**
 * A database statement that SUCCEEDED must say what it ASKED, and that must reach the reader.
 *
 * The counterpart of `db-failed-statement.test.ts`, and it exists because that plane left an
 * asymmetry behind: the bundle could show what a FAILING statement asked and could never show what
 * a SUCCEEDING one asked. A successful query was recorded only as the rows it returned, and rows
 * are what the database HELD, never what was requested of it. Worse, a SELECT that legitimately
 * matched zero rows emitted no row event at all and so appeared in no plane whatsoever.
 *
 * So every defect in the QUESTION — predicate precedence, boolean grouping, a filter that is wrong
 * or missing, a lookup keyed on the wrong column — was unreadable from the bundle whenever the
 * query executed fine, which is the common case rather than the exotic one.
 *
 * These tests bind that behaviour rather than any constant: remove the success-path statement
 * record and the zero-row tests go red; remove the shape from the read rows and the correlation
 * tests go red; loosen the normalization and the privacy tests go red.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeStatementShape, type BugEvent } from "crumbtrail-core";
import {
  instrumentMysqlClient,
  instrumentPgClient,
  type DuckTypedMysqlClient,
  type DuckTypedPgClient,
} from "../db";
import { postProcess } from "../post-process";
import { buildFixContextFromArtifacts } from "../fix-context";
import type { LlmBundle } from "../llm-bundle";

const STATEMENT_KIND = "db.statement";

function statements(events: BugEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.k === STATEMENT_KIND)
    .map((event) => event.d as unknown as Record<string, unknown>);
}

/** A Postgres client answering every statement with the rows it is told to. */
function pgReturning(
  rows: Array<Record<string, unknown>>,
  seen?: string[],
): DuckTypedPgClient {
  return {
    query(text: unknown) {
      if (typeof text === "string") seen?.push(text);
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-ok-stmt-"));
  tempDirs.push(dir);
  return dir;
}

describe("capture: a statement that SUCCEEDED says what it asked", () => {
  it("records engine, op, table, shape, rowCount and requestId for a successful SELECT", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([{ id: 1 }, { id: 2 }]), {
      requestId: "req-select",
      sessionId: "ses-ok",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await db.query(
      "SELECT id FROM accounts WHERE (tier = $1 OR legacy) AND active = $2",
      ["gold", true],
    );

    const recorded = statements(events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      engine: "postgres",
      op: "select",
      table: "accounts",
      rowCount: 2,
      seq: 1,
      requestId: "req-select",
    });
    // The grouping of the predicate is the whole point: it is what a precedence defect lives in,
    // and it is exactly what a list of returned rows cannot show.
    expect(String(recorded[0].shape)).toContain(
      "WHERE (tier = ? OR legacy) AND active = ?",
    );
  });

  it("records a SELECT that matched ZERO rows, which no other plane can describe", async () => {
    // The load-bearing case. A lookup that misses emits no `db.read` — so before this plane the
    // operation was not merely thin in the bundle, it was absent, and "the lookup returned
    // nothing" was indistinguishable from "the lookup never ran".
    const events: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([]), {
      requestId: "req-empty",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await db.query("SELECT id FROM coupons WHERE code = $1", ["SPRING"]);

    expect(events.filter((event) => event.k === "db.read")).toHaveLength(0);
    const recorded = statements(events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ table: "coupons", rowCount: 0 });
  });

  it("records the statement even when read capture is OFF, as the failure plane does", async () => {
    // The same gating decision, for the same reason: `captureReads` caps row IMAGES, and this
    // record carries none. Gating it there would leave every default install exactly as blind to
    // a wrong predicate as it was before.
    const events: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([{ id: 1 }]), {
      requestId: "req-no-reads",
      emit: (event) => events.push(event),
    });

    await db.query("SELECT id FROM accounts WHERE id = $1", [1]);

    expect(events.filter((event) => event.k === "db.read")).toHaveLength(0);
    expect(statements(events)).toHaveLength(1);
  });

  it("records a mutation that matched nothing, which leaves no diff either", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([]), {
      requestId: "req-noop-update",
      emit: (event) => events.push(event),
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", ["done", 9]);

    expect(events.filter((event) => event.k === "db.diff")).toHaveLength(0);
    const recorded = statements(events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      op: "update",
      table: "orders",
      rowCount: 0,
    });
    // The host's own statement, not the RETURNING-augmented rewrite: the reader is looking for
    // this statement in their own repository.
    expect(String(recorded[0].shape)).not.toContain("RETURNING");
  });

  it("numbers statements within a request so execution order survives", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([{ id: 1 }]), {
      requestId: "req-order",
      emit: (event) => events.push(event),
    });

    await db.query("BEGIN");
    await db.query("SELECT id FROM accounts WHERE id = $1", [1]);
    await db.query("COMMIT");

    const recorded = statements(events);
    expect(recorded.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    // Transaction boundaries fall out of the general rule rather than being special-cased.
    expect(recorded.map((entry) => entry.shape)).toEqual([
      "BEGIN",
      "SELECT id FROM accounts WHERE id = ?",
      "COMMIT",
    ]);
  });

  it("does not record the SELECTs our own capture path issues", async () => {
    // The pre-image SELECT runs against the raw client, not the proxy. If that ever changed, the
    // request's statement list would describe the instrumentation rather than the application.
    const events: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([{ id: 3 }]), {
      requestId: "req-before",
      captureBefore: true,
      emit: (event) => events.push(event),
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", ["done", 3]);

    const recorded = statements(events);
    expect(recorded).toHaveLength(1);
    expect(String(recorded[0].shape)).toContain("UPDATE orders");
  });

  it("joins each returned row to the statement that asked for it", async () => {
    // A row alone cannot separate "the database holds the wrong value" from "the predicate
    // selected the wrong row", and those two have different fixes.
    const events: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([{ id: 1 }, { id: 2 }]), {
      requestId: "req-join",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await db.query("SELECT id FROM accounts WHERE tier = $1", ["gold"]);

    const reads = events.filter((event) => event.k === "db.read");
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect((read.d as Record<string, unknown>).shape).toBe(
        "SELECT id FROM accounts WHERE tier = ?",
      );
    }
  });

  it("never lets capture decide what the caller sees", async () => {
    const client = pgReturning([{ id: 1 }]);
    const db = instrumentPgClient(client, {
      requestId: "req-sink-down",
      captureReads: true,
      emit: () => {
        throw new Error("sink is down");
      },
    });

    await expect(
      db.query("SELECT id FROM accounts WHERE id = $1", [1]),
    ).resolves.toEqual({ rows: [{ id: 1 }], rowCount: 1 });
  });
});

describe("privacy: the shape is normalized, and it is not relaxed because the statement worked", () => {
  it("carries no literal from an interpolated statement", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([]), {
      requestId: "req-privacy",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await db.query(
      "SELECT id FROM people WHERE email = 'ada@example.com' AND age = 41",
    );

    const shape = String(statements(events)[0].shape);
    expect(shape).toContain("SELECT id FROM people WHERE email");
    expect(shape).not.toContain("ada@example.com");
    expect(shape).not.toMatch(/\d/);
  });

  it("discards the residue of a statement whose quoting does not balance", () => {
    // The leak this plane would otherwise have multiplied. `LIKE '%o'brien%'` tokenizes as the
    // literal `'%o'` followed by the bare word `brien%'`, so a naive literal pass replaces the
    // first and leaves a fragment of the customer's search term standing inside what is
    // documented as a value-free shape. It survived on the failure path because failures are rare;
    // on the success path it would ride along on the common case.
    const shape = normalizeStatementShape(
      "SELECT id FROM products WHERE LOWER(name) LIKE '%o'brien%' ORDER BY id",
    );
    expect(shape).not.toContain("brien");
    expect(shape).not.toContain("'");
    expect(shape).toBe(
      "SELECT id FROM products WHERE LOWER(name) LIKE ? ORDER BY id",
    );
  });

  it("keeps the structure that makes a shape worth having", () => {
    expect(
      normalizeStatementShape(
        "SELECT id FROM orders WHERE (status = 'open' OR status = 'held') AND total > 100",
      ),
    ).toBe(
      "SELECT id FROM orders WHERE (status = ? OR status = ?) AND total > ?",
    );
  });
});

describe("the same seam on MySQL — the mechanism is engine-agnostic", () => {
  function mysqlReturning(payload: unknown): DuckTypedMysqlClient {
    const answer = () => Promise.resolve([payload, []] as unknown);
    return { query: answer, execute: answer } as DuckTypedMysqlClient;
  }

  it("records a successful MySQL SELECT that returned nothing", async () => {
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(mysqlReturning([]), {
      requestId: "req-my-empty",
      emit: (event) => events.push(event),
    });

    await db.query("SELECT id FROM coupons WHERE code = ?", ["SPRING"]);

    const recorded = statements(events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      engine: "mysql",
      op: "select",
      table: "coupons",
      rowCount: 0,
    });
  });

  it("records a successful MySQL mutation with the rows it affected", async () => {
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(
      mysqlReturning({ affectedRows: 2, insertId: 0 }),
      { requestId: "req-my-update", emit: (event) => events.push(event) },
    );

    await db.query("UPDATE orders SET status = ? WHERE tier = ?", [
      "done",
      "gold",
    ]);

    const recorded = statements(events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      engine: "mysql",
      op: "update",
      table: "orders",
      rowCount: 2,
    });
  });
});

describe("delivery: the statement reaches the reader", () => {
  const baseEvents = (extra: Record<string, unknown>[]) => [
    {
      t: 1000,
      k: "session.lifecycle",
      offsetMs: 0,
      d: { action: "start", reason: "user" },
    },
    { t: 1100, k: "clk", offsetMs: 100, d: { el: { txt: "Search" } } },
    {
      t: 1200,
      k: "net.res",
      offsetMs: 200,
      d: {
        url: "/api/search",
        method: "GET",
        status: 200,
        requestId: "rq-1",
      },
    },
    ...extra,
  ];

  async function render(events: Record<string, unknown>[]) {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    await postProcess(dir);
    return {
      dir,
      markdown: fs.readFileSync(path.join(dir, "llm.md"), "utf8"),
      bundle: JSON.parse(
        fs.readFileSync(path.join(dir, "bundle.json"), "utf8"),
      ) as LlmBundle,
    };
  }

  it("adds NOTHING when the capture path recorded no statement", async () => {
    const { markdown, bundle } = await render(baseEvents([]));
    expect("databaseStatements" in bundle).toBe(false);
    expect(markdown).not.toContain("Database Statements That Ran");
  });

  it("joins the real adapter to the real renderer, end to end, with no hand-written event", async () => {
    // Nothing in this test authors an event. If a field name diverged between what the adapter
    // emits and what the builder reads, every capture test above would stay green while the
    // mechanism reached nobody — which is the failure this plane exists to stop, one layer up.
    const captured: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([]), {
      requestId: "rq-1",
      captureReads: true,
      emit: (event) => captured.push(event),
      now: () => 1250,
      sessionStartedAt: 1000,
    });
    await db.query(
      "SELECT id FROM coupons WHERE code = $1 AND (expires_at IS NULL OR expires_at > NOW())",
      ["SPRING"],
    );
    expect(captured.length).toBeGreaterThan(0);

    const { markdown, bundle, dir } = await render([
      ...baseEvents([]),
      ...(captured as unknown as Record<string, unknown>[]),
    ]);

    expect(markdown).toContain("## Database Statements That Ran");
    expect(markdown).toContain("coupons");
    expect(bundle.databaseStatements).toHaveLength(1);
    expect(bundle.databaseStatements?.[0]).toMatchObject({
      table: "coupons",
      rowCount: 0,
      op: "select",
    });
    expect(String(bundle.databaseStatements?.[0].shape)).toContain(
      "(expires_at IS NULL OR expires_at > NOW())",
    );

    // And it reaches the plane an agent reads, not only the bundle it is built from.
    const context = buildFixContextFromArtifacts(dir, {}, bundle, [
      { anchor: { requestId: "rq-1" }, evidenceWindow: null },
    ] as unknown as Parameters<typeof buildFixContextFromArtifacts>[3]);
    expect(
      context.primary_window.db_statements.map((statement) => statement.table),
    ).toEqual(["coupons"]);
  });

  it("carries the statement shape on the rows a successful SELECT returned", async () => {
    const captured: BugEvent[] = [];
    const db = instrumentPgClient(pgReturning([{ id: 1, tier: "gold" }]), {
      requestId: "rq-1",
      captureReads: true,
      captureCallsite: true,
      emit: (event) => captured.push(event),
      now: () => 1250,
      sessionStartedAt: 1000,
    });
    await db.query("SELECT id, tier FROM accounts WHERE tier = $1", ["gold"]);

    const { bundle } = await render([
      ...baseEvents([]),
      ...(captured as unknown as Record<string, unknown>[]),
    ]);

    expect(bundle.databaseReads).toHaveLength(1);
    expect(bundle.databaseReads[0].shape).toBe(
      "SELECT id, tier FROM accounts WHERE tier = ?",
    );
    expect(bundle.databaseReads[0].callsite).toMatchObject({
      file: expect.stringContaining("db-successful-statement.test.ts"),
      line: expect.any(Number),
    });
  });
});
