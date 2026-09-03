# Capture database changes

Crumbtrail records the rows a request actually changed as `k:'db.diff'` events — op, table,
primary key, after-image, optional before-image — correlated to the request's trace id so they
land in the same evidence window as the frontend and backend events of the request that caused
the write, and feed session db differencing.

Every shim is duck-typed: you inject your own driver object and `crumbtrail-node` never imports
`pg`, `postgres`, `@neondatabase/serverless`, `@planetscale/database`, `mysql2`,
`mssql`, or a sqlite driver. All adapters take the same options
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

## Opt in to cross session race evidence

Race evidence is disabled unless `raceEvidence.enabled` is `true`. When enabled, a single row
read or diff can carry a sealed `raceEvidence` object for a future lost update analysis:

```ts
const db = instrumentPgClient(pool, {
  getRequestId: () => requestStore.getStore()?.requestId,
  emit: sendBackendEvent,
  captureBefore: true,
  raceEvidence: {
    enabled: true,
    resourceSubject: "orders",
    optimisticVersionField: "version",
  },
});
```

With `autoCapture`, the ingest credential is used as an in memory HMAC key only when it has at
least 32 non whitespace bytes and sufficient character diversity. The key never enters an event. The SDK emits fixed length,
domain separated HMAC SHA 256 identifiers for the entity, the optional common resource subject,
and the configured version field. DB reads and diffs use the same entity domain, so one row and
its version can be compared across requests. Use the same `resourceSubject` in a cache integration
when both planes represent the same application resource.

Without a strong ingest credential, use a per operation `resolve` callback that returns exactly
these fields: required `entityHash`, plus optional `resourceHash`, `versionHash`,
`beforeVersionHash`, and `afterVersionHash`. Every identifier is exactly 64 characters long.
Static `identifiers` are accepted only by the direct event builders. Multiple operation database and
cache instrumentation ignores them so one entity's identifier cannot be reused for another.
Accepted characters are letters, numbers, underscore, and hyphen. The callback can throw safely,
and invalid output omits only the race object.

The direct `buildDbReadEvent` and `buildDbDiffEvent` builders require
`raceEvidenceCapability: "transaction-outcome"` before they attach race evidence. Set it only when
the producer observed the operation's transaction outcome. The builders reject Prisma and MongoDB
engine tags at this boundary. The PlanetScale adapter suppresses race evidence because its HTTP
hook does not expose a transaction outcome.

Race evidence is omitted from bulk and image less diffs without a resolvable entity, reads that
return more than one row, multi key cache operations, and database work observed inside a
transaction. A DB primary key must be nonempty and fully resolved. Every configured primary key
column must be an own property with a defined value, including composite keys. Existing primary
key, cache key, row, value, and redaction capture remains unchanged.

Prisma, MongoDB, and PlanetScale adapters omit race evidence for all operations. Their hooks do not
expose transaction commit or rollback outcome, so this also applies when an operation succeeds and
when its surrounding transaction later rolls back. Ordinary database events still capture where
the adapter can provide them.

MongoDB single-entity ordinary `update`, `delete`, and `findAndModify` diffs use a fully resolved
`_id`. Bulk and unresolved commands omit race evidence. Common BSON `ObjectId` values are supported
by validating the ObjectId prototype's `toHexString()` result as 24 hexadecimal characters, without
adding a MongoDB package dependency.

Clients instrumented through `instrumentDatabaseClient` before `autoCapture` starts read the active
race configuration when each event is built, so the call order remains safe.
Do not use any of those raw or redacted values as a cross session join key.

## Prisma

Use the explicit fallback when the Prisma client already exists before `autoCapture` starts, or
when the application wants to wire the client itself:

```ts
import { instrumentPrismaClient } from "crumbtrail-node";

const db = instrumentPrismaClient(prisma, {
  getRequestId: () => requestStore.getStore()?.requestId,
  emit: sendBackendEvent,
});
```

The function returns Prisma's extended client. Prisma query extensions do not expose transaction
commit or rollback outcome, so the adapter captures ordinary database evidence but never adds
`raceEvidence`.

## MongoDB

Enable command monitoring before instrumenting an existing `MongoClient`:

```ts
import { MongoClient, type Db } from "mongodb";
import { instrumentMongoClient } from "crumbtrail-node";

const client = new MongoClient(process.env.MONGODB_URL!, {
  monitorCommands: true,
});
const instrumented = instrumentMongoClient(client, {
  getRequestId: () => requestStore.getStore()?.requestId,
  emit: sendBackendEvent,
});
const db: Db = instrumented.db("app");
```

The command monitor captures supported statements and returns the original client. MongoDB command
monitoring does not expose transaction commit or rollback outcome, so this adapter never adds
`raceEvidence`. `autoCapture` enables `monitorCommands` when it patches the `MongoClient`
constructor.

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

Before-images come from one extra `SELECT` on your own connection, built from the statement's
`WHERE` clause. Two properties bound it:

- It is bound in full or it is not issued. The clause is lifted out of a larger statement, so its
  `$n` placeholders are renumbered from `$1` and the matching values are supplied. A clause whose
  placeholders are not all covered by the call's parameters produces no probe.
- It cannot cost you a write. Inside a transaction, any statement that errors aborts the whole
  transaction, so the probe is wrapped in a savepoint that is rolled back to if it throws for any
  reason. Postgres itself reports whether a transaction is open, so this holds even when the
  transaction was opened through a path the shim never saw.

When the probe yields no image, the `db.diff` event carries
`beforeImageStatus: { status: "unavailable", reason }` with one of `before_probe_failed` (issued,
and the database rejected it), `before_probe_unbindable` (not issued, could not be bound), or
`before_probe_unguarded` (not issued, the savepoint guard could not be established). A missing
`beforeImageStatus` means no before-image was asked for, which is a different thing from one that
was attempted and failed.

## Neon HTTP (`@neondatabase/serverless`)

`autoCapture` instruments query functions returned by `neon()` automatically. To wrap an
existing query function, identify the driver because its callable shape is also used by
postgres.js:

```ts
import { neon } from "@neondatabase/serverless";
import { instrumentDatabaseClient } from "crumbtrail-node";

const db = instrumentDatabaseClient(neon(process.env.DATABASE_URL), {
  driver: "neon-http",
});
```

Both tagged templates and `query(text, params, options)` are captured. Mutation after-images come
from an appended `RETURNING *`. Composed template fragments run untouched because their final SQL
cannot be reconstructed safely, and mutating fragments emit an `unparsed_sql` gap.

Neon HTTP does not provide an interactive transaction around a query. The adapter therefore omits
before-images instead of issuing a separate non-atomic fetch and presenting it as the state changed
by the mutation. `captureBefore` has no effect for this adapter.

Neon's WebSocket `Pool` and `Client` implement the `pg` query contract. `autoCapture` routes them
through the existing pg adapter. Use `instrumentPgClient` when wrapping an existing pool manually;
they do not need another adapter.

## PlanetScale (`@planetscale/database`)

`autoCapture` instruments both `connect()` and connections returned by `new Client().connection()`.
To wrap an existing connection:

```ts
import { connect } from "@planetscale/database";
import { instrumentDatabaseClient } from "crumbtrail-node";

const db = instrumentDatabaseClient(connect(config), {
  driver: "planetscale",
});
```

PlanetScale returns MySQL result metadata over HTTP. Inserts are re-read by `insertId` when it
identifies one row. UPDATE and DELETE statements with a usable WHERE clause are selected before
the mutation, and updates are selected again by primary key. Missing or ambiguous images produce
an image-less `db.diff` with the driver's `rowsAffected` count. The original `execute()` result is
returned unchanged.

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
