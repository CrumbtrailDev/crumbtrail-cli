# crumbtrail-node

Backend capture for [Crumbtrail](https://crumbtrail.ai): crash and log capture, Express
middleware, `node:http` request capture, and database instrumentation.

This package records what the backend did during a session and files it into the same
session as the browser evidence. It stores nothing, serves nothing and analyses nothing;
the artifacts it produces are read by the hosted Crumbtrail product.

## Install

```bash
npm install crumbtrail-node
```

Requires Node.js 22.15 or later.

Or let the setup wizard install and wire everything for you:

```bash
npx crumbtrail
```

Pair it with [`crumbtrail-core`](https://www.npmjs.com/package/crumbtrail-core) in the
browser. The wizard also connects your coding agent to Crumbtrail's hosted MCP endpoint,
which is where captured evidence is read back.

## Fresh-install validation

The published package's install contract is exercised from a temporary standalone
install, in this repository:

```bash
pnpm verify:fresh-install
```

The verifier builds and packs `crumbtrail-core` and `crumbtrail-node`, installs the packed
tarballs into a temporary npm project, and captures a deliberate failure through the
installed package. Passing output names each phase it cleared.

## Serverless Node handlers

This package exports `withCrumbtrailAwsLambda`, `withCrumbtrailVercel`, and
`withCrumbtrailNetlify` for async HTTP handlers. Each wrapper requires an
`endpoint` or custom `transport`. For exact platform examples, lifecycle
behavior, options, and limitations, see
[Capture serverless HTTP functions](../../docs/integrations/serverless-functions.md).

## Database diffing

Database adapters wrap a duck-typed driver object the host injects (no driver dependency is
ever imported) so INSERT/UPDATE/DELETE statements executed inside a request scope record a
`k:'db.diff'` event (`{ engine, op, table, pk, after, before?, requestId }`):

| Engine   | Wrap                                     | After-image strategy                                                           |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| postgres | `instrumentPgClient(client, options)`    | appends `RETURNING *`                                                          |
| mysql    | `instrumentMysqlClient(client, options)` | post-`SELECT` by `insertId` / pk (no SQL rewriting)                            |
| mssql    | `instrumentMssqlPool(pool, options)`     | injects `OUTPUT INSERTED.*` / `DELETED.*` (rows stripped from the host result) |
| sqlite   | `instrumentSqliteDatabase(db, options)`  | post-`SELECT` by `lastInsertRowid` / pk (fully synchronous)                    |

Neon HTTP uses `instrumentNeonHttpQuery(query, options)` and appends `RETURNING *` for
after-images. PlanetScale uses `instrumentPlanetScaleClient(client, options)` and applies the
MySQL re-read strategy to its HTTP `execute()` results. `autoCapture` detects both packages.
Prisma uses `instrumentPrismaClient(client, options)` and MongoDB uses
`instrumentMongoClient(client, options)` when the host needs an explicit fallback.

All adapters take the same `InstrumentDbClientOptions` and share the same guarantees: the host
query never fails and never runs twice because of instrumentation — parse/correlation/capture/
emit failures degrade to "no diff emitted", and statements the shim cannot confidently handle
(multi-statement batches, comment-wedged SQL on mssql, multi-row MySQL inserts) fall back to an
image-less `db.diff` (`pk: null`, `rowCount`) so the write stays visible to differencing.
Sensitive columns are dropped before any event rests (`DEFAULT_SENSITIVE_DB_COLUMNS` =
`password`, `token`, `secret`, `api_key`, `ssn`; extend with `redactColumns`).
`captureBefore: true` also records UPDATE pre-images (and is how MySQL/SQLite before-images are
sourced) via one extra `SELECT` that is bound in full or not issued, and that is savepoint-guarded
on Postgres so it can never abort the transaction it is observing; when it yields no image the
`db.diff` carries `beforeImageStatus` saying why. `captureReads: true` opts into capped `db.read`
row capture. The events correlate by
`requestId` (= the request's trace id), so they land in the same evidence window and feed
session db differencing across all engines. Per-engine wiring
examples: [`docs/integrations/databases.md`](../../docs/integrations/databases.md).

Refused statements emit `db.error` with a driver-code-derived category and no error message or
bind values. Pool checkouts emit `db.pool.wait` with their wait duration. `mssql` also emits the
distinct `db.pool.timeout` event when acquisition fails with `ETIMEOUT`; the other drivers do not
provide a stable pool-timeout code, so their error prose is never guessed.

### Cross session race evidence

Race evidence is off by default. Enable it only when the hosted product will inspect lost updates
or stale cache repopulation. It adds a sealed `raceEvidence` object to eligible single entity
`db.read`, `db.diff`, and single key cache `get`, `set`, `del`, or `unlink` events. The object has
only these fixed length identifiers: required `entityHash`, plus optional `resourceHash`,
`versionHash`, `beforeVersionHash`, and `afterVersionHash`:

```ts
await autoCapture({
  endpoint: process.env.CRUMBTRAIL_ENDPOINT!,
  raceEvidence: {
    enabled: true,
    resourceSubject: "orders",
    optimisticVersionField: "version",
  },
});
```

When `autoCapture` has an ingest credential with at least 32 non whitespace bytes and sufficient
character diversity, the SDK keeps that credential in memory and uses it only as the key for domain
separated HMAC SHA 256 digests. It never places the credential in an event or in the race evidence
object. `resourceSubject` is
optional. Set the same subject for the database and cache integrations when they represent the
same application resource. The configured version field produces `versionHash` on reads,
`beforeVersionHash` and `afterVersionHash` on diffs, and no version identifier when the field is
missing.

Bulk database statements, image less diffs without a resolvable entity, multi key cache calls, and
database work inside an observed transaction do not receive race evidence. Prisma, MongoDB, and
PlanetScale adapters omit race evidence for all operations because their hooks do not expose
transaction commit or rollback outcome. A database event also needs a nonempty, fully resolved
primary key. Every configured primary key column must be present as an own property with a defined
value, including composite keys. Existing row, key, value, and redaction capture is unchanged. A
resolver or HMAC failure omits only `raceEvidence` and never changes the host operation.

MongoDB single-entity ordinary `update`, `delete`, and `findAndModify` diffs use a fully resolved
`_id`. Bulk and unresolved commands omit race evidence. Common BSON `ObjectId` values are
represented by a validated 24 character hexadecimal `toHexString()` value without adding a MongoDB
package dependency.

If the instrumentation path has no strong ingest credential, supply already opaque 64 character
identifiers through a per operation `resolve` callback. Multiple operation instrumentation does not
reuse a static `identifiers` object across calls. Static identifiers are accepted only by the
direct `buildCacheEvent`, `buildDbReadEvent`, and `buildDbDiffEvent` builders, where the caller
constructs one event at a time. The SDK accepts letters, numbers, underscore, and hyphen only,
and requires `entityHash`:

```ts
import { instrumentIoredisClient } from "crumbtrail-node";

const cache = instrumentIoredisClient(redis, {
  requestId: "request-id-from-your-context",
  emit: sendEvent,
  raceEvidence: {
    enabled: true,
    resolve(input) {
      if (input.surface !== "cache") return undefined;
      return {
        resourceHash: "r".repeat(64),
        entityHash: "e".repeat(64),
      };
    },
  },
});
```

Do not use a raw primary key, raw cache key, redacted key shape, version value, row value, or
arbitrary metadata as an identifier. The identifiers are the only fields intended for future
cross session joins.

### Which clients get instrumented

`autoCapture` instruments for you: it replaces the exported factories of every driver above
that the app actually depends on (`instrumentDatabases: false` opts out). Because it works by
replacing a factory, it covers the clients created after it runs — the patch is applied before
`autoCapture` first yields, so a pool built while the app's own modules are still loading is
covered, provided `autoCapture` was called first.

SQLite auto-instrumentation covers `better-sqlite3` and the CommonJS `node:sqlite`
`DatabaseSync` constructor.

Two cases fall outside that, and both are reported by name at startup rather than left to look
like a working install:

- a client the host already holds when capture starts
- postgres.js loaded as an ES module, where the copy the app imported is not the copy the
  CommonJS patch replaced (reported as `esm-unreachable`)
- `node:sqlite` loaded through an ESM named import, whose built-in `DatabaseSync` binding Node does
  not allow the SDK to replace (reported as `esm-unreachable`)

For both, instrument it yourself. The call routes to the running capture and its request scope,
and is safe in any order relative to `autoCapture`. If you instrument the client first, its race
evidence configuration is read again when each event is built after capture starts:

```ts
import { instrumentDatabaseClient } from "crumbtrail-node";

export const sql = instrumentDatabaseClient(postgres(process.env.DATABASE_URL));
```

The driver is detected from the client's shape; pass `{ driver: "postgres" }` if a wrapper makes
that ambiguous. An unrecognised client is returned untouched rather than wrapped as the wrong
driver.

Statements record evidence only inside a request scope, since `requestId` is what puts a write in
the same evidence window as the request that issued it. Work outside any request — a cron tick, a
queue worker — is not captured by this.

`autoCapture` keeps the higher cost database evidence disabled unless you opt in. These options
apply only to the automatic driver wrappers and all default to `false`:

```ts
await autoCapture({
  endpoint: process.env.CRUMBTRAIL_ENDPOINT!,
  captureDatabaseReads: true,
  captureDatabaseBeforeImages: true,
  captureDatabaseCallsites: true,
});
```

`captureDatabaseReads` maps to the explicit adapters' `captureReads` option,
`captureDatabaseBeforeImages` maps to `captureBefore`, and `captureDatabaseCallsites` maps to
`captureCallsite`. The explicit `instrument*` APIs keep their existing option names and defaults.

### Redis evidence

`autoCapture` and the explicit Redis adapters capture these operations inside a request scope:

- reads and hash reads: `get`, `getbuffer`, `getex`, `mget`, `hget`, `hmget`, `getdel`
- writes and hash writes: `set`, `setex`, `psetex`, `hset`
- invalidation and counters: `del`, `unlink`, `hdel`, `incr`, `decr`
- expiry: `expire`, `persist`, `ttl`

Values and keys are redacted using the shared capture policy. A rejected promise emits one `cache`
event with `outcome: "failure"`, a bounded redacted error message, and its error class, then
rethrows the original error. A `multi()` transaction or `pipeline()` emits one summary when
`exec()` or ioredis `execBuffer()` resolves or rejects. The summary includes a bounded command
count and operation list. An ioredis `WATCH` abort that resolves `exec()` to `null` is reported as
`outcome: "aborted"` and the `null` result is returned unchanged.
For ioredis `multi({ pipeline: false })`, per-command `QUEUED` replies are returned unchanged and
only the root `exec()` emits the aggregate transaction outcome. Inline nested transaction tuples
are inspected for failure counts without copying command results.

Unsupported Redis commands are passed through without per-command evidence. Batch summaries do not
capture command arguments or results. Redis work outside a request scope is not emitted because it
cannot be joined to a user session.

### Callsites: which line issued the write

`captureCallsite: true` adds `callsite` to every `db.diff`: the innermost host frame plus the
app frames above it (`{ file, line, column, fn, stack }`, repo-relative against
`callsiteRoot`). The innermost frame alone is usually not the answer — in any app with a
repository layer it names the same `insertOrder` helper for every defect that touches that
table, while the line a fix has to change sits one or two frames up in the route handler. Both
ends are reported rather than guessed at.

Off by default: capturing a stack per query is not free. Library, runtime and instrumentation
frames are excluded by path, so a linked checkout does not report the SDK's own internals as
the host's code. With a repo binding (`CRUMBTRAIL_REPO` + `CRUMBTRAIL_COMMIT_SHA`, else the
git remote and `HEAD`) the callsite also resolves to a GitHub permalink; without one it
still works.

```ts
instrumentPgClient(pool, {
  captureCallsite: true,
  callsiteRoot: repoRoot,
  emit: (event) => sendBackendEvent(event),
});
```

### Read capture and query fan-out

`captureReads: true` records SELECT results as capped, redacted `db.read` events. Each row is one
event, and each event carries `d.stmt`, the 1-based ordinal of the SELECT within its request. That
ordinal is what separates one SELECT returning fifty rows from fifty SELECTs returning one row —
without it the two produce byte-identical evidence, and telling them apart is the whole point of an
N+1 finding. The `n_plus_one_query` detector reads it; read caps bound the count, so a finding
understates a large fan-out rather than overstating it.

Read events also carry `d.q`, the resolved LIMIT/OFFSET window the statement ran with (literals and
Postgres `$n` placeholders; an unresolvable placeholder yields nothing rather than a guess). The
`pagination_first_page_offset` detector compares that window against the request's own paging
parameters: a request that asks for the first page whose SELECT ran with `0 < OFFSET < LIMIT` is
skipping rows that will be returned to no page at all, which is the off-by-one behind every "the
first item just isn't there" report. Offset equal to the limit (a real page 2, a ranked pick) and
cursor-paged requests stay silent.

`captureBefore: true` records UPDATE pre-images, which the `lost_update` detector needs: it fires
when a second writer's before-image still shows the value an earlier writer had already replaced
and both computed the same new value. That is the only rule here that crosses request boundaries,
because a lost update is made of two concurrent requests and a per-request rule can never see one.

### Overlapping requests

`response_race` names two requests to the same endpoint that overlapped and came back in the
opposite order to the one they were sent in. Nothing has to fail for it to fire, which is the point:
a search box that renders results for a query the user has already replaced produces two clean 200s
and no other trace. Send order is read from capture order rather than from timestamps, because two
fetches issued in one tick share a millisecond.

It reports a race, not a defect. An application that discards responses no longer matching its
current input emits the same events and is correct, so the finding states the ordering and leaves the
conclusion to the reader. The two calls are identified by send offset rather than by URL, since the
query string is both the part that differs and the part redaction removes.

`concurrent_duplicate_mutation` is the write-side sibling: two byte-identical mutations (same
method, URL, and body) whose lifetimes overlapped and which BOTH returned 2xx. That is the transport
shape of a read-modify-write race — a double-fired submit or two writers on a shared resource — and
its downstream symptom is a duplicated line or a lost increment, invisible to every error detector
because nothing failed. A sequential retry after a failure is the client behaving correctly and is
excluded, as is any body carrying a redaction marker, since redaction can collapse distinct payloads
into one signature.

### Database invariants

A set of detectors reads `db.diff` and `db.read` events for claims that need no knowledge of the
application, only of what data never legitimately does:

- `interpolation_artifact` — persisted text carrying a template value that never resolved: a
  word-bounded `undefined` or `NaN`, `[object Object]`, or an unrendered `{{name}}`/`${name}`.
  A notification row storing "Hi undefined, your order #1 was cancelled" inserts cleanly, mails
  cleanly, and returns 200 everywhere; the defect is visible only in the value itself.
- `state_flip_flop` — a string lifecycle column (`status`, `state`, `phase`, `stage`) that was
  held, left, and reached again on one row. Whatever the intended state machine, a status that
  goes `placed → delivered → placed` is an invalid transition or two writers fighting. Boolean
  and toggle columns are excluded, since a user flipping a switch twice is `A → B → A` by design.
- `duplicate_charge` — two settled rows for one business reference and one amount. The grouping
  key is one transaction-reference column at a time (never the composite), because the row that
  duplicates a charge legitimately differs in its gateway-assigned id. Actor columns (`user_id`)
  are excluded: the same customer paying the same amount twice for two orders is commerce.
- `money_scale_shift` — a money column that moved by exactly 100x or 10000x in a single UPDATE,
  the fingerprint of a cents/dollars conversion applied once too often or too rarely.
- `cross_user_read` — a request served one user a row owned by another. The active user comes only
  from writes on a sessions-shaped table, so anonymous flows and token-auth admin consoles never
  establish one and stay silent.
- `duplicate_readback` — two rows read back identical on every business column (generated columns
  excluded, entity anchor required): the read-plane proof of a non-idempotent retry when the
  INSERT after-images were captured too thin for `duplicate_write` to compare.
- `orphaned_reference` — a child row committed with a null `*_id` whose parent table receives its
  INSERT afterwards. A nullable reference that stays null is a data-model choice; a null reference
  whose parent shows up after the child was committed is dependent writes run in the wrong order.

Each of these fires on the stored data alone, so it works even when the application logs nothing —
and each states the evidence it rests on (the columns compared, both user ids, the value chain) so
a reader verifies rather than trusts.

### Inbound requests, on any framework

The browser SDK stamps `x-crumbtrail-session-id`, `x-crumbtrail-request-id` and
`traceparent` on the calls it makes. Something on the backend has to read them
back, or the session holds one side of every call and joins nothing.

`autoCapture` does that with no application code and no framework module. It
hooks `http.Server`, which is what express, `@hono/node-server`, fastify, both
Nest adapters and a hand-written `createServer` all end up being, and records
each correlated request as `backend.req.start` and `backend.req.end` in the
browser's own session. Status, duration, allowlisted response headers and the
response body follow the same policy as the Express middleware, under the same
redaction.

A backend with no browser in front of it records its requests too. When a
request carries no session id, the recorders file it under the session
`autoCapture` opened for this process, and the event says
`correlation.sessionIdSource: "process"` so nothing reads it as a join that did
not happen. Only a request with no session of any kind available, which means
`autoCapture` is not installed or its handshake has not succeeded, goes
unrecorded. A response the peer cut short leaves a `capture_gap` rather than
disappearing.

The Express middleware still earns its place: it knows the matched route and the
error a handler threw, neither of which is visible at the socket. When both are
installed the middleware claims the request and the `http.Server` hook stays
silent, so a request is recorded once. Disable the hook with
`captureHttpRequests: false`.

### Structured logs

A real backend logs through pino, winston or bunyan, and a failure it expected is
caught, logged with its stack, and answered with a status. It reaches no console
and crashes nothing, so a capture surface that hooks only `console.error` and the
crash handlers sees an empty session for the most ordinary failure there is.

`autoCapture` and the Express middleware both watch the place every logger
converges: the file descriptor. `process.stdout.write` / `process.stderr.write`
covers pino's default destination, winston's Console transport and morgan;
`fs.write` / `fs.writeSync` on fd 1 and 2 covers SonicBoom, which
`pino(pino.destination(1))` writes through without ever touching
`process.stdout`. Lines that parse as NDJSON carrying a level are recorded as
`backend.log` events; everything else the process writes is ignored.

Warn and above by default (`logLevel` moves the floor), the message, error and
stack pass through the same redaction as any other captured text, only bounded
scalar context fields ride along, and one install caps at 500 events so a log
storm cannot flood a session. The host's own write always happens, unchanged.

A line written while a request is being handled carries that request's id, and
is filed to the session the request belongs to — the browser's, when a browser
correlated the call. So the click that got the 500 and the log line explaining
it share one join key instead of landing in two unrelated issues. The same
applies to a `console.error` raised inside a handler. A line written between
requests keeps the process's own session and carries no request id, exactly as
before.
The `backend_log_error` detector surfaces an error or fatal line as a
high-severity candidate carrying the logged stack, collapsed by content so an
upstream outage logged once per request reads as one finding. Disable with
`captureLogs: false`.

To retain a small set of support-relevant fields from structured log context,
pass an exact path allowlist. This applies to log context only:

```ts
autoCapture({
  endpoint: "https://api.crumbtrail.ai",
  diagnosticFields: ["context.status", "attempts[0].code"],
});
```

The same option is available on the Express middleware and on
`installBackendLogCapture`. It retains only selected scalar values. The first
64 configured paths are parsed, at most 16 leaves are retained, array indexes
must be between 0 and 63, and strings are capped at 256 characters. Selected
strings are normalized with Unicode NFKC before classification. Values that
remain non-ASCII are omitted. Whole or embedded URLs use the diagnostic URL
policy, which ignores `keepFields` and redacts unsafe schemes. Sensitive names
and token, card, password, email, and other secret patterns still redact.
Wildcards, bodies, headers, stacks, locals, inherited properties, accessors,
cycles, and non-scalars are excluded. Omit the option to keep the existing log
redaction behavior. It does not change `keepFields` or response-body capture.

### Runtime warnings

The Express middleware (like `autoCapture` before it) subscribes to `process.on("warning")` and
records each runtime warning as a `backend.warning` event in the session the middleware most
recently saw. A `MaxListenersExceededWarning` fires synchronously inside the request that crossed
the threshold, so attribution is exact in the case that matters. The `runtime_warning` detector
ranks a listener-leak warning above console output the app chose to print, because the platform
put a threshold behind it. Disable with `captureRuntimeWarnings: false`.

On the browser side, the `ui.listeners` gauge emits at every navigation commit, and two detectors
read the curve: session-total growth that never shrinks (gross leaks), and a per-type staircase
scoped to one path — one event type whose count rises on every arrival at the same route, which is
the exact signature of a subscribe-on-mount with no cleanup even at one leaked handler per visit.

## Headless job-run sessions

Queue workers, cron jobs, and batch runs can create a session without a browser:

```ts
import { startHeadlessSession } from "crumbtrail-node";

const session = await startHeadlessSession({
  endpoint: "http://127.0.0.1:9898",
  sessionId: `job-${Date.now()}`,
  metadata: {
    app: "billing-worker",
    release: process.env.RELEASE,
    build: process.env.GIT_SHA,
  },
});

await session.record({
  t: Date.now(),
  k: "con",
  d: { lv: "info", msg: "job started" },
});
await session.end();
```

If the job already exports OpenTelemetry, stamp spans/logs with the same
`crumbtrail.session.id`; Crumbtrail files those signals into the same agent-readable
session as logs and row diffs.

## Backend request lifecycle

Every request the express middleware starts reaches a terminal record. `backend.req.end` is
emitted when the response finishes, and also when the response closes after its body was
already written; a response that closes before finishing has no status to report, so the
request emits a `capture_gap` with `surface: "backend_request"` and `reason:
"request_unterminated"` instead. Exactly one of the two is emitted per request.

Event delivery is retried on a transport level rejection, because a capture server under a
burst of event posts fills its accept backlog and the kernel resets the next connection, which
arrives as `TypeError: fetch failed` and used to drop the event silently. Set `retries: 0` to
send each event exactly once. If a `backend.req.end` still never lands, the request emits a
`capture_gap` with `reason: "delivery_failed"` carrying the same `requestId`, so a reader sees
a named hole rather than a request that appears never to have happened.

### Which id joins a browser failure to its backend request

Two different ids travel with one network exchange and they do different jobs. `id` is the browser
collector's own sequence number, and it restarts at 1 on every page load, so it can only ever join
browser events to each other. `requestId` is the shared correlation id carried in
`X-Crumbtrail-Request-Id`: the browser collector stamps it on the request, response and error of one
exchange, and the express middleware adopts the incoming value rather than minting its own, so it is
the only key both planes hold.

`index.json` therefore carries both. Entries under `failedReqs[]` and `networkErrors[]` have
`requestId` alongside `id`, present whenever the exchange carried a correlation id. A candidate's
`anchor.requestId` publishes the shared id when there is one and falls back to the browser local
sequence number when there is not. Consumers tell the two apart by shape, since a page counter is a
bare run of digits while a correlation id is a 32 character hexadecimal W3C trace id or a `req_`
prefixed token, so a correlation id that happened to be all digits is refused and the fallback is
used instead.

## Public API boundary

The package exports backend capture primitives:

- `autoCapture` — the zero-configuration entry point; installs the rest
- `createCrumbtrailExpressMiddleware` / `createCrumbtrailExpressErrorMiddleware`
- `installHttpRequestCapture`, `installBackendLogCapture`, `installBackendWarningCapture`
- `instrumentPgClient`, `instrumentMysqlClient`, `instrumentMssqlPool`,
  `instrumentSqliteDatabase`, `instrumentPostgresSql`, `instrumentNeonHttpQuery`,
  `instrumentPlanetScaleClient`, `instrumentDatabaseClient`
- `startHeadlessSession` for job runs with no browser
- `flushBackendEvents` and `backendIntakeQueueStats` for processes that exit early

`src/index.ts` is the complete list. Session storage, post-processing, evidence bundling
and the MCP server are no longer part of this package; they belong to the hosted product.

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
