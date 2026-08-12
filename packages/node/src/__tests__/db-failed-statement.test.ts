/**
 * A database statement that RAISED must leave a record, and that record must reach the reader.
 *
 * These are the implementer's tests for the `db.error` plane. They cover three things the
 * behaviour probe deliberately leaves open — the gating decision, the leak surface, and whether
 * the record survives the whole way to `llm.md` and `fix-context` — plus the invariance guard that
 * a session in which nothing failed renders exactly as it did before the plane existed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  instrumentMysqlClient,
  instrumentPgClient,
  type DuckTypedMysqlClient,
  type DuckTypedPgClient,
} from "../db";
import { buildDbErrorEvent, captureDbErrorCode } from "../db/error-event";
import { postProcess } from "../post-process";
import { buildFixContextFromArtifacts } from "../fix-context";
import type { LlmBundle } from "../llm-bundle";

class DriverError extends Error {
  code: string | number;
  constructor(message: string, code: string | number) {
    super(message);
    this.name = "error";
    this.code = code;
  }
}

/**
 * A fake driver whose matching statements reject, as a real one does. Typed against
 * `DuckTypedPgClient` rather than inferred, so the instrumented handle keeps the two-argument
 * `query(text, params)` signature the adapter actually exposes.
 */
function clientRejecting(match: RegExp, error: Error): DuckTypedPgClient {
  return {
    query(text: unknown) {
      if (typeof text === "string" && match.test(text))
        return Promise.reject(error);
      return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-failed-stmt-"));
  tempDirs.push(dir);
  return dir;
}

describe("capture: a raised statement is recorded", () => {
  it("records a failed mutation with engine, op, table, shape, code and requestId", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(
      clientRejecting(/insert/i, new DriverError("duplicate key value", "23505")),
      { requestId: "req-1", sessionId: "ses-1", emit: (e) => events.push(e) },
    );

    await expect(
      db.query("INSERT INTO ledger (user_id, delta) VALUES ($1, $2)", [7, 100]),
    ).rejects.toBeInstanceOf(DriverError);

    const errors = events.filter((event) => event.k === "db.error");
    expect(errors).toHaveLength(1);
    expect(errors[0].d).toMatchObject({
      engine: "postgres",
      op: "insert",
      table: "ledger",
      code: "23505",
      errorName: "error",
      requestId: "req-1",
    });
    expect(String((errors[0].d as Record<string, unknown>).shape)).toContain(
      "ledger",
    );
  });

  it("records a failed READ even though read capture is off by default", async () => {
    // The gating decision, stated as a test: `captureReads` caps row IMAGES, and a failure record
    // carries no rows. Gating the failure on it would leave a raised SELECT invisible on every
    // default install, which is the exact shape this plane exists to close.
    const events: BugEvent[] = [];
    const db = instrumentPgClient(
      clientRejecting(/select/i, new DriverError("no such column", "42703")),
      { requestId: "req-2", sessionId: "ses-1", emit: (e) => events.push(e) },
    );

    await expect(db.query("SELECT tier FROM accounts WHERE id = $1", [7])).rejects.toThrow();

    const errors = events.filter((event) => event.k === "db.error");
    expect(errors).toHaveLength(1);
    expect(errors[0].d).toMatchObject({ op: "select", table: "accounts", code: "42703" });
  });

  it("rethrows the host's own error object, unchanged and unwrapped", async () => {
    const raised = new DriverError("deadlock detected", "40P01");
    const db = instrumentPgClient(clientRejecting(/update/i, raised), {
      requestId: "req-3",
      emit: () => {},
    });

    await expect(db.query("UPDATE ledger SET delta = $1 WHERE id = $2", [1, 2])).rejects.toBe(
      raised,
    );
  });

  it("still rethrows the host's error when the emit sink itself throws", async () => {
    // Capture may never decide what the caller sees, including when capture is what is broken.
    const raised = new DriverError("connection terminated", "57P01");
    const db = instrumentPgClient(clientRejecting(/insert/i, raised), {
      requestId: "req-4",
      emit: () => {
        throw new Error("sink is down");
      },
    });

    await expect(db.query("INSERT INTO ledger (id) VALUES ($1)", [1])).rejects.toBe(raised);
  });

  it("emits nothing for a statement that succeeds", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(clientRejecting(/never-matches/, new Error("x")), {
      requestId: "req-5",
      emit: (e) => events.push(e),
    });
    await db.query("INSERT INTO ledger (id) VALUES ($1)", [1]);
    expect(events.filter((event) => event.k === "db.error")).toHaveLength(0);
  });
});

describe("the same seam on MySQL — the mechanism is engine-agnostic, not Postgres-specific", () => {
  function mysqlRejecting(match: RegExp, error: Error): DuckTypedMysqlClient {
    const answer = (sql: unknown) =>
      typeof sql === "string" && match.test(sql)
        ? Promise.reject(error)
        : Promise.resolve([[{ id: 1 }], []] as unknown);
    return { query: answer, execute: answer } as DuckTypedMysqlClient;
  }

  it("records a failed MySQL mutation and rethrows the driver's error", async () => {
    const events: BugEvent[] = [];
    const raised = new DriverError("Duplicate entry", "ER_DUP_ENTRY");
    const db = instrumentMysqlClient(mysqlRejecting(/insert/i, raised), {
      requestId: "req-my",
      emit: (e) => events.push(e),
    });

    await expect(db.query("INSERT INTO ledger (id) VALUES (?)", [1])).rejects.toBe(raised);

    const errors = events.filter((event) => event.k === "db.error");
    expect(errors).toHaveLength(1);
    expect(errors[0].d).toMatchObject({
      engine: "mysql",
      op: "insert",
      table: "ledger",
      code: "ER_DUP_ENTRY",
      requestId: "req-my",
    });
  });

  it("records a failed MySQL read with read capture off", async () => {
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(
      mysqlRejecting(/select/i, new DriverError("Unknown column", "ER_BAD_FIELD_ERROR")),
      { requestId: "req-my2", emit: (e) => events.push(e) },
    );

    await expect(db.query("SELECT tier FROM accounts WHERE id = ?", [1])).rejects.toThrow();

    const errors = events.filter((event) => event.k === "db.error");
    expect(errors).toHaveLength(1);
    expect(errors[0].d).toMatchObject({ op: "select", table: "accounts" });
  });
});

describe("leak surface: only a code, a class name and a literal-free shape travel", () => {
  it("carries neither the driver message nor an inline literal", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(
      clientRejecting(
        /insert/i,
        new DriverError("Key (email)=(ada@example.com) already exists", "23505"),
      ),
      { requestId: "req-6", emit: (e) => events.push(e) },
    );

    await expect(
      db.query("INSERT INTO people (email, age) VALUES ('ada@example.com', 41)"),
    ).rejects.toThrow();

    const errors = events.filter((event) => event.k === "db.error");
    const text = JSON.stringify(errors);
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("already exists");
    expect(text).toContain("people");
    // The numeric literal is asserted against the SHAPE, not the whole payload: the payload
    // carries an epoch timestamp, and any short digit string is a substring of some timestamp.
    // Asserting on the payload passes or fails according to the clock, which is not a test.
    const shape = String((errors[0].d as Record<string, unknown>).shape);
    expect(shape).not.toMatch(/\d/);
    expect(shape).toContain("INSERT INTO people");
  });

  it("normalizes literals out of the shape while keeping the structure", () => {
    const event = buildDbErrorEvent({
      engine: "postgres",
      op: "update",
      table: "people",
      statement:
        "UPDATE people SET email = 'ada@example.com', age = 41 WHERE id = 7 -- by ada",
      error: new DriverError("nope", "23505"),
      requestId: "req-7",
    });
    const shape = String((event.d as Record<string, unknown>).shape);
    expect(shape).toContain("UPDATE people SET email");
    expect(shape).not.toContain("ada@example.com");
    expect(shape).not.toContain("41");
    expect(shape).not.toContain("by ada");
  });

  it("refuses a code that is not code-shaped, and never falls back to the message", () => {
    expect(captureDbErrorCode(new DriverError("m", "23505"))).toBe("23505");
    expect(captureDbErrorCode(new DriverError("m", "ER_DUP_ENTRY"))).toBe("ER_DUP_ENTRY");
    expect(captureDbErrorCode(new DriverError("m", 1062))).toBe("1062");
    // A driver that puts prose on `.code` must not turn the field into a message channel.
    expect(captureDbErrorCode(new DriverError("m", "duplicate key value violates"))).toBeNull();
    expect(captureDbErrorCode(new Error("plain"))).toBeNull();
  });
});

describe("delivery: the record reaches the reader", () => {
  const baseEvents = (extra: Record<string, unknown>[]) => [
    { t: 1000, k: "session.lifecycle", offsetMs: 0, d: { action: "start", reason: "user" } },
    { t: 1100, k: "clk", offsetMs: 100, d: { el: { txt: "Redeem" } } },
    {
      t: 1200,
      k: "net.res",
      offsetMs: 200,
      d: { url: "/api/redeem", method: "POST", status: 500, requestId: "rq-1" },
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
      bundle: JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8")) as LlmBundle,
    };
  }

  const failedStatement = {
    t: 1250,
    k: "db.error",
    offsetMs: 250,
    d: {
      engine: "postgres",
      op: "insert",
      table: "ledger",
      shape: "INSERT INTO ledger (user_id, delta) VALUES (?, ?)",
      code: "23505",
      errorName: "error",
      requestId: "rq-1",
      t: 1250,
    },
  };

  it("renders a failed statement into llm.md and carries it in bundle.json", async () => {
    const { markdown, bundle } = await render(baseEvents([failedStatement]));

    expect(markdown).toContain("## Database Statements That Failed");
    expect(markdown).toContain("23505");
    expect(markdown).toContain("ledger");
    expect(bundle.databaseErrors).toHaveLength(1);
    expect(bundle.databaseErrors?.[0]).toMatchObject({ table: "ledger", code: "23505" });
  });

  it("renders the failed statement BEFORE the rows that did change", async () => {
    const { markdown } = await render(
      baseEvents([
        failedStatement,
        {
          t: 1260,
          k: "db.diff",
          offsetMs: 260,
          d: {
            engine: "postgres",
            op: "insert",
            table: "audit",
            pk: { id: 1 },
            after: { id: 1 },
            requestId: "rq-1",
          },
        },
      ]),
    );
    // Assert both sections are actually present before comparing positions: `indexOf` returns
    // -1 for an absent heading, which would make a missing section read as "ordered first".
    const failedAt = markdown.indexOf("## Database Statements That Failed");
    const changesAt = markdown.indexOf("## Database Row Changes");
    expect(failedAt).toBeGreaterThan(-1);
    expect(changesAt).toBeGreaterThan(-1);
    expect(failedAt).toBeLessThan(changesAt);
  });

  it("adds NOTHING when no statement failed — no key, no heading", async () => {
    // The invariance guard. A session in which nothing raised must serialize and render exactly as
    // it did before this plane existed; an empty plane is not a finding and must not cost a line.
    const { markdown, bundle } = await render(baseEvents([]));

    expect("databaseErrors" in bundle).toBe(false);
    expect(markdown).not.toContain("Database Statements That Failed");
  });

  it("joins the real adapter to the real renderer end to end, with no hand-written event", async () => {
    // Every other test in this file grades ONE side of the emitter→builder join: the capture tests
    // assert what the adapter emits, the delivery tests render a fixture this file authored. If a
    // field name diverged between the two, both groups would stay green while the mechanism
    // reached nobody — which is the failure this plane exists to stop, one layer up. So this test
    // authors nothing: the events come out of `instrumentPgClient` and go straight into
    // `postProcess`.
    const captured: BugEvent[] = [];
    const db = instrumentPgClient(
      clientRejecting(/insert/i, new DriverError("duplicate key value", "23505")),
      {
        requestId: "rq-e2e",
        emit: (event) => captured.push(event),
        now: () => 1250,
        sessionStartedAt: 1000,
      },
    );
    await expect(
      db.query("INSERT INTO ledger (user_id, delta) VALUES ($1, $2)", [7, 100]),
    ).rejects.toThrow();
    expect(captured.length).toBeGreaterThan(0);

    const { markdown, bundle } = await render([
      ...baseEvents([]),
      ...(captured as unknown as Record<string, unknown>[]),
    ]);

    expect(markdown).toContain("## Database Statements That Failed");
    expect(markdown).toContain("23505");
    expect(bundle.databaseErrors?.[0]).toMatchObject({ table: "ledger", code: "23505" });
    // And the driver's message still does not travel, measured on the artifact the reader reads.
    expect(markdown).not.toContain("duplicate key value");
  });

  it("scopes db_errors onto the fix-context primary window by requestId", async () => {
    const bundle = {
      session: { id: "ses-scope", startMs: 1000, endMs: 2000 },
      databaseErrors: [
        { t: 1250, engine: "postgres", op: "insert", table: "ledger", shape: "INSERT INTO ledger", code: "23505", errorName: "error", requestId: "rq-1" },
        { t: 9999, engine: "postgres", op: "insert", table: "elsewhere", shape: "INSERT INTO elsewhere", code: "23505", errorName: "error", requestId: "rq-other" },
      ],
      databaseDiffs: [],
      databaseReads: [],
      databaseActivity: [],
    } as unknown as LlmBundle;

    const context = buildFixContextFromArtifacts(
      tempDir(),
      {},
      bundle,
      [
        {
          anchor: { requestId: "rq-1" },
          evidenceWindow: null,
        },
      ] as unknown as Parameters<typeof buildFixContextFromArtifacts>[3],
    );

    expect(context.primary_window.db_errors.map((error) => error.table)).toEqual(["ledger"]);
  });
});
