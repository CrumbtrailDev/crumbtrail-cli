/**
 * Instrumentation for `postgres` (porsager/postgres.js), the tagged-template
 * Postgres client.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Auto-instrumentation knew four drivers: `pg`, `mysql2`, `better-sqlite3` and
 * `mssql`. Real Node services on Postgres increasingly do not use any of them —
 * they use `postgres`, whose whole surface is a callable tagged template rather
 * than a `query(text, params)` method. On such an app every DB detector was
 * unreachable, and the install reported nothing at all about it.
 *
 * ## How this differs from the `pg` shim
 *
 * The `pg` shim REPLACES `query`, so it decides how the host's statement runs.
 * That is not available here: a postgres.js query is a lazy `Query` object the
 * caller may still turn into a cursor, a stream, a raw-row read, or a fragment
 * embedded in another query. Rerouting it through `sql.unsafe` would silently
 * change all of those.
 *
 * So this OBSERVES instead. The original call runs untouched and its exact
 * `Query` is returned. Capture wraps the query's own `resolve`/`reject` — the
 * two callbacks postgres.js itself invokes when the statement settles — so no
 * listener is added, no promise is derived, and the host's handled/unhandled
 * rejection behaviour is exactly what it was.
 *
 * The one place capture does change the statement is the `RETURNING *` append
 * on an un-returning INSERT/UPDATE/DELETE, which is the same trade the `pg`
 * shim already makes and the only way an after-image exists at all. It is
 * applied ONLY when every interpolated value is a plain bind value, so a
 * statement built from postgres.js fragments or helpers (`sql(row)`,
 * `sql(columns)`) is never rewritten — those are recorded as statements and the
 * missing diff is reported as a capture gap rather than guessed at.
 *
 * ## What is recorded
 *
 * - `db.statement` for every correlated statement, with the driver's own final
 *   SQL (`$1` placeholders, never bind values) and its row count.
 * - `db.error` when the statement raised.
 * - `db.diff` for mutations whose after-image could be read.
 * - `db.read` rows under `captureReads`, as everywhere else.
 * - `capture_gap` when a mutation was seen and no diff could be built.
 */

import type { DbConnectionIdentity } from "crumbtrail-core";
import {
  classifyStatement,
  leadingSqlKeyword,
  parseLimitOffset,
  type ParsedMutation,
  type ParsedRead,
} from "./sql";
import {
  emitGap,
  emitDbDiffEvents,
  emitDbErrorEvent,
  emitDbReadEvents,
  emitDbStatementEvent,
  extractDbConnectionIdentity,
  finishDbTransaction,
  isRecord,
  nextStatementSeq,
  startDbQueryTimer,
  startDbTransaction,
  type DbTransactionContext,
  type InstrumentDbClientOptions,
  type ReadCallsitesByRequest,
} from "./instrument-shared";

const ENGINE = "postgres" as const;

/** Marks a wrapped callable so a second install cannot double-instrument it. */
const INSTRUMENTED = Symbol.for("crumbtrail.db.postgresJsInstrumented");

/**
 * The parts of a postgres.js `Query` this reads. Everything is optional because
 * the object belongs to the driver, not to us: a shape we do not recognise is
 * left entirely alone rather than guessed at.
 */
interface DuckTypedPostgresQuery {
  strings?: readonly string[];
  args?: readonly unknown[];
  /** The final SQL the driver built, available once the statement has run. */
  string?: string;
  resolve?: (value: unknown) => unknown;
  reject?: (reason: unknown) => unknown;
  /** Set by `.raw()` / `.values()`; those results are not row objects. */
  isRaw?: unknown;
  /** Set by `.cursor()`; rows arrive in pages, not in the settled value. */
  cursorRows?: unknown;
  cursorFn?: unknown;
  forEachFn?: unknown;
}

/** A postgres.js `sql` — a callable carrying `unsafe`, `begin` and `reserve`. */
export type DuckTypedPostgresSql = ((...args: unknown[]) => unknown) & {
  unsafe?: unknown;
  begin?: unknown;
  savepoint?: unknown;
  reserve?: unknown;
};

/** Per-request ordinals, shared across every query issued through one `sql`. */
interface RequestCounters {
  emittedReadRowsByRequest: Map<string, number>;
  readCallsitesByRequest: ReadCallsitesByRequest;
  readStatementsByRequest: Map<string, number>;
  statementsByRequest: Map<string, number>;
}

function newCounters(): RequestCounters {
  return {
    emittedReadRowsByRequest: new Map(),
    readCallsitesByRequest: new Map(),
    readStatementsByRequest: new Map(),
    statementsByRequest: new Map(),
  };
}

function isInstrumented(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[INSTRUMENTED] === true
  );
}

/**
 * Wrap a postgres.js `sql` so every statement issued through it — including
 * through a `begin` transaction or a `reserve`d connection — is recorded.
 *
 * Returns the original untouched when it is not a postgres.js callable, or when
 * it has already been instrumented.
 */
export function instrumentPostgresSql<T>(
  sql: T,
  options: InstrumentDbClientOptions,
): T {
  if (typeof sql !== "function" || isInstrumented(sql)) return sql;
  return wrapSql(sql as DuckTypedPostgresSql, options, newCounters(), {
    connection: extractDbConnectionIdentity(ENGINE, sql),
  }) as T;
}

interface SqlContext {
  connection?: DbConnectionIdentity;
  transaction?: DbTransactionContext;
}

function wrapSql(
  sql: DuckTypedPostgresSql,
  options: InstrumentDbClientOptions,
  counters: RequestCounters,
  context: SqlContext,
): DuckTypedPostgresSql {
  const proxy = new Proxy(sql, {
    apply(target, thisArg, args) {
      const query = Reflect.apply(target, thisArg, args);
      try {
        // Only a tagged-template call is a statement. `sql("name")` builds an
        // identifier and `sql(obj)` a helper; both are values inside some other
        // statement, and neither runs on its own.
        if (isTaggedTemplateCall(args)) {
          observe(query, plannedTextFor(args), options, counters, context);
        }
      } catch {
        // Capture may never decide whether the host's query is built.
      }
      return query;
    },
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true;
      if (prop === "unsafe")
        return wrapUnsafe(target, options, counters, context);
      if (prop === "begin")
        return wrapBegin(target, options, counters, context);
      if (prop === "savepoint")
        return wrapSavepoint(target, options, counters, context);
      if (prop === "reserve")
        return wrapReserve(target, options, counters, context);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}

/** A postgres.js savepoint stays inside the outer transaction and keeps its transaction id. */
function wrapSavepoint(
  sql: DuckTypedPostgresSql,
  options: InstrumentDbClientOptions,
  counters: RequestCounters,
  context: SqlContext,
): unknown {
  const original = sql.savepoint;
  if (typeof original !== "function") return original;
  const originalFn = original as (...args: unknown[]) => unknown;
  return function (this: unknown, ...args: unknown[]): unknown {
    const index = args.findIndex((arg) => typeof arg === "function");
    if (index < 0) return originalFn.apply(sql, args);
    const fn = args[index] as (...values: unknown[]) => unknown;
    const next = [...args];
    next[index] = (...values: unknown[]): unknown => {
      const scoped = values[0];
      if (typeof scoped === "function" && !isInstrumented(scoped)) {
        values[0] = wrapSql(
          scoped as DuckTypedPostgresSql,
          options,
          counters,
          context,
        );
      }
      return fn(...values);
    };
    return originalFn.apply(sql, next);
  };
}

/** `sql.unsafe(text, params)` — the exact text is known before it runs. */
function wrapUnsafe(
  sql: DuckTypedPostgresSql,
  options: InstrumentDbClientOptions,
  counters: RequestCounters,
  context: SqlContext,
): unknown {
  const original = sql.unsafe;
  if (typeof original !== "function") return original;
  const originalFn = original as (...args: unknown[]) => unknown;
  return function (this: unknown, ...args: unknown[]): unknown {
    const query = originalFn.apply(sql, args);
    try {
      const text = typeof args[0] === "string" ? args[0] : undefined;
      if (text) observe(query, text, options, counters, context);
    } catch {
      // Same contract: never fail the host's statement.
    }
    return query;
  };
}

/**
 * `sql.begin(fn)` hands the callback its OWN `sql` bound to the transaction's
 * connection. Instrumenting only the outer callable would therefore record
 * every statement a service issues except the ones inside its transactions —
 * which are the writes that matter most.
 */
function wrapBegin(
  sql: DuckTypedPostgresSql,
  options: InstrumentDbClientOptions,
  counters: RequestCounters,
  context: SqlContext,
): unknown {
  const original = sql.begin;
  if (typeof original !== "function") return original;
  const originalFn = original as (...args: unknown[]) => unknown;
  return function (this: unknown, ...args: unknown[]): unknown {
    const index = args.findIndex((arg) => typeof arg === "function");
    if (index < 0) return originalFn.apply(sql, args);
    const fn = args[index] as (...values: unknown[]) => unknown;
    let requestId: string | undefined;
    try {
      requestId = options.requestId ?? options.getRequestId?.();
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
    }
    const transaction = startDbTransaction({
      engine: ENGINE,
      requestId,
      connection: context.connection,
      options,
    });
    const wrapped = (...values: unknown[]): unknown => {
      const scoped = values[0];
      if (typeof scoped === "function" && !isInstrumented(scoped)) {
        // The transaction's statements share the outer counters on purpose: a
        // request's statement ordinals must stay one sequence whether or not a
        // transaction was opened partway through it.
        values[0] = wrapSql(scoped as DuckTypedPostgresSql, options, counters, {
          connection: context.connection,
          transaction,
        });
      }
      return fn(...values);
    };
    const next = [...args];
    next[index] = wrapped;
    let result: unknown;
    try {
      result = originalFn.apply(sql, next);
    } catch (error) {
      finishDbTransaction({
        engine: ENGINE,
        transaction,
        outcome: "rollback",
        requestId,
        options,
      });
      throw error;
    }
    if (!result || typeof (result as Promise<unknown>).then !== "function")
      return result;
    return (result as Promise<unknown>).then(
      (value) => {
        finishDbTransaction({
          engine: ENGINE,
          transaction,
          outcome: "commit",
          requestId,
          options,
        });
        return value;
      },
      (error) => {
        finishDbTransaction({
          engine: ENGINE,
          transaction,
          outcome: "rollback",
          requestId,
          options,
        });
        throw error;
      },
    );
  };
}

/** `sql.reserve()` resolves to a dedicated `sql` carrying `release`. */
function wrapReserve(
  sql: DuckTypedPostgresSql,
  options: InstrumentDbClientOptions,
  counters: RequestCounters,
  context: SqlContext,
): unknown {
  const original = sql.reserve;
  if (typeof original !== "function") return original;
  const originalFn = original as (...args: unknown[]) => unknown;
  return function (this: unknown, ...args: unknown[]): unknown {
    const result = originalFn.apply(sql, args);
    if (!result || typeof (result as Promise<unknown>).then !== "function")
      return result;
    return (result as Promise<unknown>).then((reserved) => {
      try {
        if (typeof reserved === "function" && !isInstrumented(reserved)) {
          return wrapSql(reserved as DuckTypedPostgresSql, options, counters, {
            connection:
              extractDbConnectionIdentity(ENGINE, reserved) ??
              context.connection,
            transaction: context.transaction,
          });
        }
      } catch (error) {
        emitGap(options, { reason: "uninstrumented_client", error });
      }
      return reserved;
    });
  };
}

function isTaggedTemplateCall(args: readonly unknown[]): boolean {
  const first = args[0] as { raw?: unknown } | undefined;
  return Array.isArray(first) && Array.isArray(first?.raw);
}

/**
 * The statement postgres.js is ABOUT to build, reconstructed from the template
 * so it can be classified before it runs.
 *
 * Exact whenever every interpolated value is a plain bind value, because that is
 * precisely the case where postgres.js emits `$1…$n` in the same positions.
 * Returns undefined when any value is a fragment or a helper: those expand into
 * SQL of their own, the reconstruction would be a guess, and a guess is not
 * something to rewrite a customer's statement on.
 */
function plannedTextFor(args: readonly unknown[]): string | undefined {
  const strings = args[0] as readonly string[];
  const values = args.slice(1);
  if (!values.every(isPlainBindValue)) return undefined;
  let text = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    text += `$${index + 1}${strings[index + 1] ?? ""}`;
  }
  return text;
}

/**
 * A value postgres.js will send as a bind parameter rather than expand into
 * SQL. Deliberately a small allowlist: everything postgres.js treats specially
 * (`Query` fragments, `Builder` helpers, `Identifier`s, typed `Parameter`s) is an
 * object, so refusing unknown objects is the safe default.
 */
function isPlainBindValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const type = typeof value;
  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "bigint"
  )
    return true;
  if (value instanceof Date) return true;
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return value.every(isPlainBindValue);
  return false;
}

/**
 * Attach capture to one query.
 *
 * `plannedText` is the statement as it will be built, or undefined when it could
 * not be reconstructed exactly. The RETURNING rewrite needs it; the recording
 * does not, because the driver publishes its own final SQL on the query by the
 * time the statement settles.
 */
function observe(
  query: unknown,
  plannedText: string | undefined,
  options: InstrumentDbClientOptions,
  counters: RequestCounters,
  context: SqlContext,
): void {
  const q = query as DuckTypedPostgresQuery | undefined;
  if (!q || typeof q.resolve !== "function" || typeof q.reject !== "function")
    return;

  const requestId = options.requestId ?? options.getRequestId?.();
  // No request scope means nothing to correlate the statement to, exactly as in
  // every other adapter.
  if (!requestId) return;
  const elapsed = startDbQueryTimer(options);

  let parsed: ParsedMutation | undefined;
  let parsedRead: ParsedRead | undefined;
  try {
    if (plannedText) {
      const classification = classifyStatement(plannedText);
      if (classification.kind === "unparsable" && classification.mayMutate) {
        emitGap(options, {
          reason: "unparsed_sql",
          detail: leadingSqlKeyword(plannedText),
        });
      }
      parsed =
        classification.kind === "mutation"
          ? classification.mutation
          : undefined;
      parsedRead =
        classification.kind === "read" ? classification.read : undefined;
    } else {
      // A statement assembled from fragments or helpers. It still runs and is
      // still recorded; what cannot be produced is an after-image, and a
      // mutation with no diff is a completeness gap the reader must see.
      const keyword = leadingSqlKeyword(q.strings?.[0] ?? "");
      if (MUTATING_KEYWORDS.has(keyword.toUpperCase())) {
        emitGap(options, { reason: "unparsed_sql", detail: keyword });
      }
    }
  } catch (error) {
    emitGap(options, { reason: "capture_exception", error });
    return;
  }

  // The one rewrite: an un-returning mutation cannot report what it changed.
  // Appending to the LAST template fragment always lands at the very end of the
  // built statement, because postgres.js emits `strings[i]` after each value.
  let rewritten = false;
  if (parsed && plannedText && !/\breturning\b/i.test(plannedText)) {
    rewritten = appendReturning(q);
    if (!rewritten) {
      emitGap(options, { reason: "unparsed_sql", detail: parsed.op });
    }
  }

  const originalResolve = q.resolve.bind(q);
  const originalReject = q.reject.bind(q);
  let settled = false;

  q.resolve = (value: unknown): unknown => {
    if (!settled) {
      settled = true;
      try {
        recordSuccess({
          query: q,
          result: value,
          plannedText,
          parsed,
          parsedRead,
          rewritten,
          requestId,
          options,
          counters,
          context: { ...context, durationMs: elapsed() },
        });
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
      }
    }
    return originalResolve(value);
  };

  q.reject = (reason: unknown): unknown => {
    if (!settled) {
      settled = true;
      try {
        emitDbErrorEvent({
          engine: ENGINE,
          op: parsed?.op ?? (parsedRead ? "select" : "other"),
          table: parsed?.table ?? parsedRead?.table ?? null,
          statement: statementTextOf(q, plannedText),
          requestId,
          error: reason,
          options,
          context: {
            connection: context.connection,
            transactionId: context.transaction?.id,
          },
        });
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
      }
    }
    return originalReject(reason);
  };
}

const MUTATING_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "REPLACE",
]);

/**
 * Append `RETURNING *` by replacing the query's template fragments.
 *
 * A NEW array is written rather than the driver's own being mutated in place:
 * postgres.js caches prepared statements and origin stacks keyed by the exact
 * `strings` object it was handed, so editing that object would change queries
 * this capture never saw.
 */
function appendReturning(q: DuckTypedPostgresQuery): boolean {
  const strings = q.strings;
  if (!Array.isArray(strings) || strings.length === 0) return false;
  const last = strings[strings.length - 1];
  if (typeof last !== "string") return false;
  try {
    const next = [...strings];
    next[next.length - 1] = `${last.replace(/;\s*$/, "")} RETURNING *`;
    // `raw` is what marks an array as template strings; the driver reads it when
    // the query is constructed, and a replacement without it would not be
    // recognised by anything downstream that checks.
    Object.defineProperty(next, "raw", {
      value: next.slice(),
      enumerable: false,
      configurable: true,
    });
    (q as { strings?: unknown }).strings = next;
    return true;
  } catch {
    return false;
  }
}

/** The driver's own final SQL, falling back to what we planned. */
function statementTextOf(
  q: DuckTypedPostgresQuery,
  plannedText: string | undefined,
): string {
  const built = typeof q.string === "string" ? q.string : undefined;
  return built ?? plannedText ?? "";
}

/**
 * A settled postgres.js result is an Array subclass carrying `count` and
 * `command`. `.raw()`, `.values()` and cursor reads settle to something else,
 * and those are recorded as statements without row images rather than being
 * read as rows they are not.
 */
function rowsOf(
  q: DuckTypedPostgresQuery,
  result: unknown,
): { rows: Array<Record<string, unknown>>; rowCount: number | null } {
  const count = (result as { count?: unknown } | undefined)?.count;
  const rowCount =
    typeof count === "number" && Number.isFinite(count) ? count : null;
  if (q.isRaw || q.cursorRows !== undefined || q.cursorFn || q.forEachFn) {
    return { rows: [], rowCount };
  }
  if (!Array.isArray(result)) return { rows: [], rowCount };
  return {
    rows: result.filter(isRecord),
    rowCount: rowCount ?? result.length,
  };
}

function recordSuccess(input: {
  query: DuckTypedPostgresQuery;
  result: unknown;
  plannedText: string | undefined;
  parsed: ParsedMutation | undefined;
  parsedRead: ParsedRead | undefined;
  rewritten: boolean;
  requestId: string;
  options: InstrumentDbClientOptions;
  counters: RequestCounters;
  context: SqlContext & { durationMs: number };
}): void {
  const { query, result, parsed, parsedRead, requestId, options, counters } =
    input;
  const statement = statementTextOf(query, input.plannedText);
  const { rows, rowCount } = rowsOf(query, result);

  emitDbStatementEvent({
    engine: ENGINE,
    op: parsed?.op ?? (parsedRead ? "select" : "other"),
    table: parsed?.table ?? parsedRead?.table ?? null,
    // The statement the driver actually ran, minus a RETURNING clause capture
    // added itself: the reader is looking for this statement in their own
    // repository, and a clause they never wrote is not in it.
    statement: input.rewritten ? stripAppendedReturning(statement) : statement,
    rowCount,
    seq: nextStatementSeq(counters.statementsByRequest, requestId),
    requestId,
    options,
    context: {
      connection: input.context.connection,
      durationMs: input.context.durationMs,
      transactionId: input.context.transaction?.id,
    },
  });

  if (parsed) {
    if (!input.rewritten && rows.length === 0) {
      // The mutation ran and nothing here can say which rows it touched.
      emitGap(options, { reason: "unparsed_sql", detail: parsed.op });
      return;
    }
    emitDbDiffEvents({
      engine: ENGINE,
      op: parsed.op,
      table: parsed.table,
      requestId,
      rows,
      rowCount: rowCount ?? rows.length,
      options,
      context: {
        connection: input.context.connection,
        durationMs: input.context.durationMs,
        transactionId: input.context.transaction?.id,
      },
    });
    return;
  }

  if (options.captureReads && parsedRead && rows.length > 0) {
    emitDbReadEvents({
      engine: ENGINE,
      table: parsedRead.table,
      requestId,
      rows,
      rowCount: rowCount ?? rows.length,
      options,
      emittedReadRowsByRequest: counters.emittedReadRowsByRequest,
      readCallsitesByRequest: counters.readCallsitesByRequest,
      readStatementsByRequest: counters.readStatementsByRequest,
      queryShape: parseLimitOffset(statement, query.args as unknown),
      statement,
      context: {
        connection: input.context.connection,
        durationMs: input.context.durationMs,
        transactionId: input.context.transaction?.id,
      },
    });
  }
}

function stripAppendedReturning(statement: string): string {
  return statement.replace(/\s+RETURNING\s+\*\s*$/i, "");
}
