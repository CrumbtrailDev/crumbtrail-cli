# Database row diffing (Postgres, MySQL, MSSQL, SQLite)

Crumbtrail records the rows a request actually changed as `k:'db.diff'` events — op, table,
primary key, after-image, optional before-image — correlated to the request's trace id so they
land in the same evidence window as the frontend and backend events of the request that caused
the write, and feed session db differencing.

Every shim is duck-typed: you inject your own driver object and `crumbtrail-node` never imports
`pg`, `mysql2`, `mssql`, or a sqlite driver. All four take the same options
(`InstrumentDbClientOptions`), and instrumentation can never fail or double-run your query —
anything the shim cannot capture degrades to fewer events, never a broken statement.

## Shared wiring: request correlation

A `db.diff` is only recorded inside a request scope. Resolve the scope from the same headers the
backend middleware uses (the browser SDK sets `X-Crumbtrail-Request-Id` = the W3C trace id):

```ts
import { resolveDbRequestContext } from "crumbtrail-node";

app.post("/api/checkout", async (req, res) => {
  const ctx = resolveDbRequestContext({ headers: req.headers });
  const db = instrumentPgClient(pool, { ...ctx, emit: sendBackendEvent });
  await db.query("UPDATE orders SET paid = $1 WHERE id = $2", [true, orderId]);
});
```

For a long-lived instrumented client, pass `getRequestId: () => …` (e.g. backed by
`AsyncLocalStorage`) instead of per-request `requestId`.

## Postgres (`pg` Client or Pool)

```ts
import { instrumentPgClient } from "crumbtrail-node";

const db = instrumentPgClient(pool, {
  getRequestId: () => requestStore.getStore()?.requestId,
  emit: sendBackendEvent,
  captureBefore: true, // pre-image of single-table UPDATEs via a SELECT
});
```

After-images come from an appended `RETURNING *` (skipped when your statement already has one).

## MySQL (`mysql2/promise` Connection or Pool)

```ts
import { instrumentMysqlClient } from "crumbtrail-node";

const db = instrumentMysqlClient(pool, {
  getRequestId: () => requestStore.getStore()?.requestId,
  emit: sendBackendEvent,
  captureBefore: true,
});
```

MySQL has no `RETURNING`, so images come from best-effort extra SELECTs: single-row inserts are
re-read by `insertId`; UPDATE/DELETE rows are pre-selected by the statement's WHERE clause and
updates re-read by primary key afterward. Multi-row inserts and statements without a usable
WHERE degrade to an image-less `db.diff` carrying `rowCount` (`affectedRows`). Your SQL is never
rewritten. Both `query` and `execute` are instrumented.

## SQL Server (`mssql` ConnectionPool)

```ts
import { instrumentMssqlPool } from "crumbtrail-node";

const pool = instrumentMssqlPool(await sql.connect(config), {
  getRequestId: () => requestStore.getStore()?.requestId,
  emit: sendBackendEvent,
  captureBefore: true,
});

const request = pool.request();
request.input("id", sql.Int, orderId);
await request.query("UPDATE orders SET paid = 1 WHERE id = @id");
```

After-images come from an injected `OUTPUT INSERTED.*` (`DELETED.*` for deletes); the injected
rows are consumed for evidence and stripped from your result, so your code sees the recordset
shape the original statement would have produced. Statements the shim cannot confidently edit —
multi-statement batches, an existing OUTPUT clause, comment-wedged SQL — run untouched and
degrade to an image-less diff. Tables with triggers reject OUTPUT at compile time (error 334);
the shim detects the compile-class failure (334/156/102 — these fail before any row changes) and
re-runs your original statement once on a fresh request with the same inputs.

## SQLite (better-sqlite3 or `node:sqlite`)

```ts
import { instrumentSqliteDatabase } from "crumbtrail-node";

const db = instrumentSqliteDatabase(new Database("app.db"), {
  getRequestId: () => requestStore.getStore()?.requestId,
  emit: sendBackendEvent,
  captureBefore: true,
});

db.prepare("UPDATE orders SET status = ? WHERE id = ?").run("shipped", 3);
```

Fully synchronous — events are emitted before `run()` returns. Inserts are re-read by
`lastInsertRowid`; UPDATE/DELETE images come from pre/post SELECTs by WHERE and primary key.
`WITHOUT ROWID` tables and multi-row statements degrade to image-less diffs.

`autoCapture` patches both the `better-sqlite3` default constructor and the CommonJS built-in
`node:sqlite` `DatabaseSync` constructor. Node does not allow replacing an ESM named import of a
built-in constructor. Apps that use `import { DatabaseSync } from "node:sqlite"` receive an
`esm-unreachable` startup report and must pass the database to `instrumentSqliteDatabase()`.
Positional binds, named-object binds, and the `run()` / `all()` / `get()` statement methods keep
their native call shapes.

## Failed statement classification

A refused statement emits `k:'db.error'` with its normalized statement shape, driver code, and a
stable `category`. Categories are `deadlock`, `unique_constraint`, `foreign_key_constraint`,
`check_constraint`, `constraint_violation`, `serialization_failure`, `connection_loss`, and
`unknown`.

Classification reads Postgres SQLSTATE, MySQL errno and SQLSTATE, SQLite result codes, or SQL
Server error numbers. It does not read error messages. SQL Server error 547 is
`constraint_violation` because its number does not distinguish a foreign key from a check
constraint. Missing or unrecognized codes are `unknown`. Error messages and bind values are not
included in the event.

## Pool pressure

Completed checkouts emit `k:'db.pool.wait'` with `engine`, `waitMs`, and `requestId` for:

- `pg` Pool `connect()`
- `mysql2` Pool `getConnection()`
- `mssql` ConnectionPool `acquire()`
- postgres.js `reserve()`

An `mssql` checkout rejected with the driver's `ETIMEOUT` code emits
`k:'db.pool.timeout'`. The event includes elapsed wait time, the code, and the error class name,
but not the error message. pg, mysql2, and postgres.js do not expose a stable code that uniquely
identifies pool checkout timeout, so Crumbtrail records their completed waits but does not guess a
timeout from message text.

## Capture completeness (gap records)

Instrumentation never throws into your query, but when it cannot capture something on the
differentiated path it no longer stays silent: it emits a structured `k:'capture_gap'` event
(`surface`, `reason`, bounded and redacted `detail`) so an incomplete bundle is distinguishable
from a complete one. Reasons include `unparsed_sql` (a statement the SQL classifier could not
resolve, so no diff was produced), `uninstrumented_client` (a pooled client that could not be
wrapped), and `capture_exception` (a diff emit that failed). SQL classification uses a real
multi dialect parser; anything it cannot classify becomes an `unparsed_sql` gap rather than a
missing diff, and pooled clients acquired through `pool.connect()` (promise and callback style)
are instrumented so the pool path no longer bypasses capture.

Gap events flow through the required `emit` sink. If that sink itself fails, the gap is routed to
an independent fallback so a reporting failure is still recorded:

- `emitGap` / `onGap` — optional independent sink for `capture_gap` events used when the primary
  `emit` sink throws (never re-enters `emit`).

The assembled bundle carries a `completeness` section: gap counts by surface and reason plus a
derived grade of `complete`, `degraded`, or `fragmentary`, so a consuming agent knows how much of
the differentiated path was captured.

## Options shared by every engine

- `emit` (required) — sink for the events, e.g. forward to `sendBackendEvent`.
- `emitGap` / `onGap` — optional independent sink for `capture_gap` events (fallback when `emit`
  throws).
- `requestId` / `getRequestId` / `sessionId` — request-scope correlation (see above). Resolution
  falls back to a W3C `traceparent` header when the Crumbtrail headers were stripped by a gateway,
  so the browser to backend to SQL join survives.
- `captureBefore` — record UPDATE pre-images (deletes always carry their removed row).
- `captureReads` — opt-in capped `db.read` capture of SELECT rows (off by default; raises PII
  surface).
- `redactColumns` — extra sensitive column names dropped on top of
  `DEFAULT_SENSITIVE_DB_COLUMNS` (`password`, `token`, `secret`, `api_key`, `ssn`).
- `pkColumns` — primary-key columns per table (default `['id']`); used for pk extraction and the
  MySQL/SQLite post-selects.
- `maxRowsPerStatement`, `maxReadRowsPerStatement`, `maxReadRowsPerRequest` — caps; overflow is
  summarized in `db.diff.bulk` / `db.read.bulk` events.

## Limitations (all engines)

Trigger/cascade side effects and rows changed in other tables are not captured; before-image
capture reuses the statement's WHERE clause, so it supports single-table UPDATEs (not CTEs,
joins, or sub-selects). Values larger than 8 KiB per column are truncated after redaction. If
your service already exports OpenTelemetry DB spans, those complement row diffs as
statement-level activity evidence (see [opentelemetry.md](./opentelemetry.md)).
