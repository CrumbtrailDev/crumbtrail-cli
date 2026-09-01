import type { DbBeforeImageStatus } from "crumbtrail-core";
import {
  classifyStatement,
  ensureReturning,
  leadingSqlKeyword,
  parseLimitOffset,
  parseMutation,
  parseRead,
  rebindNumberedPlaceholders,
  type ParsedMutation,
  type ParsedRead,
} from "./sql";
import {
  beginPoolCheckout,
  emitGap,
  emitDbDiffEvents,
  emitDbErrorEvent,
  emitDbReadEvents,
  emitDbStatementEvent,
  extractDbConnectionIdentity,
  finishDbTransaction,
  extractPk,
  isRecord,
  nextStatementSeq,
  pkKey,
  startDbQueryTimer,
  startDbTransaction,
  classifyDbTransactionCommand,
  type DbTransactionContext,
  type InstrumentDbClientOptions,
  type ReadCallsitesByRequest,
} from "./instrument-shared";

export { parseMutation, parseRead } from "./sql";

/**
 * Minimal duck-typed view of a `pg` Client/Pool. We never import `pg` at module top-level — the
 * host injects its own client/pool, so `pg` stays an optional peer and tests use a fake client.
 */
export interface DuckTypedPgQueryResult {
  rows?: unknown[];
  rowCount?: number | null;
  command?: string;
}

export interface DuckTypedPgClient {
  query(text: unknown, params?: unknown): Promise<DuckTypedPgQueryResult>;
}

/** Back-compat alias: the Postgres shim shares the engine-agnostic option shape. */
export type InstrumentPgClientOptions = InstrumentDbClientOptions;

const ENGINE = "postgres" as const;

/**
 * Wraps a duck-typed `pg` client/pool so INSERT/UPDATE/DELETE statements executed within a request
 * scope record a `db.diff` event (op, table, primary key, after-image; before-image behind
 * `captureBefore`). The shim appends `RETURNING *` when absent to read the after-image, and reads
 * the result rows otherwise. Only the promise-returning `query(text, params)` form is instrumented;
 * config-object and callback forms pass straight through. Engine is Postgres only; the builder is
 * driver-agnostic so other engines can slot in later. A pool's `connect()` result is proxied too,
 * so mutations issued through acquired clients retain the same instrumentation and pool lifecycle.
 *
 * Limitations: trigger/cascade side effects and rows changed by other tables are not captured; the
 * pre-image SELECT for `captureBefore` reuses the statement's WHERE clause, so it supports
 * single-table UPDATEs (not CTEs, joins, or sub-selects). That probe is bound in full or not
 * issued, and is guarded by a savepoint whenever a transaction is open, so it can never cost the
 * host its write. When it yields nothing, the `db.diff` event says why in `beforeImageStatus`.
 */
export function instrumentPgClient<T extends DuckTypedPgClient>(
  client: T,
  options: InstrumentPgClientOptions,
): T {
  const emittedReadRowsByRequest = new Map<string, number>();
  const readStatementsByRequest = new Map<string, number>();
  const readCallsitesByRequest: ReadCallsitesByRequest = new Map();
  // Every instrumented statement, not only the SELECTs whose rows were captured: this is what
  // gives a statement that returned nothing an ordinal, and so a place in the request's order.
  const statementsByRequest = new Map<string, number>();
  const connection = extractDbConnectionIdentity(ENGINE, client);
  const poolTarget = looksLikePgPool(client);
  let transaction: DbTransactionContext | undefined;

  const wrappedQuery = async (
    text: unknown,
    params?: unknown,
  ): Promise<DuckTypedPgQueryResult> => {
    if (typeof text !== "string") return client.query(text, params);

    const transactionCommand = classifyDbTransactionCommand(text);
    if (transactionCommand) {
      let requestId: string | undefined;
      try {
        requestId = options.requestId ?? options.getRequestId?.();
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
      }
      const elapsed = startDbQueryTimer(options);
      let result: DuckTypedPgQueryResult;
      try {
        result = await client.query(text, params);
      } catch (error) {
        if (requestId) {
          emitDbErrorEvent({
            engine: ENGINE,
            op: "other",
            table: null,
            statement: text,
            requestId,
            error,
            options,
            context: { connection, transactionId: transaction?.id },
          });
        }
        throw error;
      }
      const durationMs = elapsed();
      const activeBefore = transaction;
      if (transactionCommand === "begin") {
        transaction = startDbTransaction({
          engine: ENGINE,
          requestId,
          connection,
          options,
        });
      } else if (transaction) {
        finishDbTransaction({
          engine: ENGINE,
          transaction,
          outcome: transactionCommand,
          requestId,
          options,
        });
        transaction = undefined;
      }
      if (requestId) {
        emitDbStatementEvent({
          engine: ENGINE,
          op: "other",
          table: null,
          statement: text,
          rowCount: resultRowCount(result),
          seq: nextStatementSeq(statementsByRequest, requestId),
          requestId,
          options,
          context: {
            connection,
            durationMs,
            transactionId: (transaction ?? activeBefore)?.id,
          },
        });
      }
      return result;
    }

    // Parse/correlation resolution is diff-capture work: if it throws, fall through to the host
    // query untouched. Instrumentation must never decide whether the host's query runs.
    let parsed: ParsedMutation | undefined;
    let parsedRead: ParsedRead | undefined;
    let requestId: string | undefined;
    try {
      const classification = classifyStatement(text);
      if (classification.kind === "unparsable" && classification.mayMutate) {
        emitGap(options, {
          reason: "unparsed_sql",
          detail: leadingSqlKeyword(text),
        });
      }
      parsed =
        classification.kind === "mutation"
          ? classification.mutation
          : undefined;
      parsedRead =
        classification.kind === "read" ? classification.read : undefined;
      requestId = options.requestId ?? options.getRequestId?.();
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
      return client.query(text, params);
    }
    if (!requestId) return client.query(text, params);

    if (!parsed) {
      // The host read (or other statement). If it RAISES, record what was attempted and what the
      // database said, then rethrow the driver's own error untouched. Recording is deliberately
      // NOT behind `captureReads`: that flag caps row IMAGES, and a failure record carries no
      // rows. Gating it there would leave a failed SELECT invisible on every default install.
      let result: DuckTypedPgQueryResult;
      const elapsed = startDbQueryTimer(options);
      try {
        result = await client.query(text, params);
      } catch (error) {
        emitDbErrorEvent({
          engine: ENGINE,
          op: parsedRead ? "select" : "other",
          table: parsedRead?.table ?? null,
          statement: text,
          requestId,
          error,
          options,
          context: { connection, transactionId: transaction?.id },
        });
        throw error;
      }
      const durationMs = elapsed();
      // Record what the statement ASKED, whatever it returned. Rows describe what the database
      // held; only the shape describes what was requested of it, and a SELECT that matched nothing
      // emits no row at all — so without this the operation is not merely thin, it is absent.
      // Outside `captureReads` on purpose: that flag caps row IMAGES and this record carries none.
      emitDbStatementEvent({
        engine: ENGINE,
        op: parsedRead ? "select" : "other",
        table: parsedRead?.table ?? null,
        statement: text,
        rowCount: resultRowCount(result),
        seq: nextStatementSeq(statementsByRequest, requestId),
        requestId,
        options,
        context: { connection, durationMs, transactionId: transaction?.id },
      });
      if (options.captureReads && parsedRead) {
        try {
          const rows = (result.rows ?? []).filter(isRecord);
          const rowCount =
            typeof result.rowCount === "number" &&
            Number.isFinite(result.rowCount)
              ? result.rowCount
              : rows.length;
          emitDbReadEvents({
            engine: ENGINE,
            table: parsedRead.table,
            requestId,
            rows,
            rowCount,
            options,
            emittedReadRowsByRequest,
            readCallsitesByRequest,
            readStatementsByRequest,
            queryShape: parseLimitOffset(text, params),
            statement: text,
            context: { connection, durationMs, transactionId: transaction?.id },
          });
        } catch (error) {
          emitGap(options, { reason: "capture_exception", error });
        }
      }
      return result;
    }

    const paramArray = Array.isArray(params) ? params : undefined;

    // Pre-image capture is strictly best-effort: a failing probe (bad WHERE, permissions, etc.)
    // must NOT abort a mutation that would otherwise succeed, and must not leave the reader unable
    // to tell a probe that failed from a before-image nobody asked for.
    let beforeByPk: Map<string, Record<string, unknown>> | undefined;
    let beforeImageStatus: DbBeforeImageStatus | undefined;
    if (options.captureBefore && parsed.op === "update" && parsed.whereClause) {
      try {
        const outcome = await captureBeforeImage(
          client,
          parsed,
          parsed.whereClause,
          paramArray,
          options,
          poolTarget,
        );
        beforeByPk = outcome.beforeByPk;
        beforeImageStatus = outcome.status;
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
        beforeByPk = undefined;
        beforeImageStatus = {
          status: "unavailable",
          reason: "before_probe_failed",
        };
      }
    }

    // RETURNING handling is diff-capture work too; if it throws, run the original statement so the
    // host's query is never broken by instrumentation.
    let instrumentedText: string;
    try {
      instrumentedText = ensureReturning(text);
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
      // We declined to instrument this mutation, but it is still the host's statement: if it
      // raises, the failure is the application's and gets recorded like any other. Two events on
      // this path is correct and says two different things — our RETURNING rewrite failed, AND
      // their statement failed — and they have different owners.
      try {
        const elapsed = startDbQueryTimer(options);
        const uninstrumented = await client.query(text, paramArray);
        const durationMs = elapsed();
        emitDbStatementEvent({
          engine: ENGINE,
          op: parsed.op,
          table: parsed.table,
          statement: text,
          rowCount: resultRowCount(uninstrumented),
          seq: nextStatementSeq(statementsByRequest, requestId),
          requestId,
          options,
          context: { connection, durationMs, transactionId: transaction?.id },
        });
        return uninstrumented;
      } catch (queryError) {
        emitDbErrorEvent({
          engine: ENGINE,
          op: parsed.op,
          table: parsed.table,
          statement: text,
          requestId,
          error: queryError,
          options,
          context: { connection, transactionId: transaction?.id },
        });
        throw queryError;
      }
    }

    // The host mutation. Its own errors propagate normally — we never swallow the caller's query.
    // We now also RECORD the failure on the way past: a mutation that raised is the decisive
    // observable in exactly the incidents where nothing else explains the response.
    let result: DuckTypedPgQueryResult;
    const elapsed = startDbQueryTimer(options);
    try {
      result = await client.query(instrumentedText, paramArray);
    } catch (error) {
      emitDbErrorEvent({
        engine: ENGINE,
        op: parsed.op,
        table: parsed.table,
        // The statement as the host wrote it, not our RETURNING-augmented rewrite: the reader is
        // looking for this statement in their own repository.
        statement: text,
        requestId,
        error,
        options,
        context: { connection, transactionId: transaction?.id },
      });
      throw error;
    }
    const durationMs = elapsed();

    // The statement ran. Record what it asked before deciding what it changed: a mutation whose
    // WHERE matched no row changes nothing and so appears in no diff, which is the same silence a
    // mutation that never ran would leave.
    emitDbStatementEvent({
      engine: ENGINE,
      op: parsed.op,
      table: parsed.table,
      // The statement as the host wrote it, not our RETURNING-augmented rewrite: the reader is
      // looking for this statement in their own repository.
      statement: text,
      rowCount: resultRowCount(result),
      seq: nextStatementSeq(statementsByRequest, requestId),
      requestId,
      options,
      context: { connection, durationMs, transactionId: transaction?.id },
    });

    // Diff capture/emit is best-effort: a parse/build/emit failure here degrades to "no diff
    // emitted" rather than breaking the host query, whose result is returned unchanged.
    try {
      const rows = (result.rows ?? []).filter(isRecord);
      const rowCount =
        typeof result.rowCount === "number" && Number.isFinite(result.rowCount)
          ? result.rowCount
          : rows.length;
      emitDbDiffEvents({
        engine: ENGINE,
        op: parsed.op,
        table: parsed.table,
        requestId,
        rows,
        beforeByPk,
        beforeImageStatus,
        rowCount,
        options,
        context: { connection, durationMs, transactionId: transaction?.id },
      });
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
    }

    return result;
  };

  const rawConnect = (client as unknown as { connect?: unknown }).connect;
  const connectWithCapture = (instrumentAcquired: boolean) =>
    typeof rawConnect === "function"
      ? (...args: unknown[]): unknown => {
          const checkout = beginPoolCheckout(ENGINE, options);
          const callback = args[0];
          if (typeof callback === "function") {
            const wrappedCallback = (
              error: unknown,
              acquired: unknown,
              release: unknown,
            ) => {
              if (error || acquired == null) checkout.failed(error);
              else checkout.acquired();
              return callback(
                error,
                error || acquired == null || !instrumentAcquired
                  ? acquired
                  : instrumentAcquiredClient(acquired, options),
                release,
              );
            };
            return (rawConnect as (...values: unknown[]) => unknown).apply(
              client,
              [wrappedCallback],
            );
          }
          const result = (
            rawConnect as (...values: unknown[]) => unknown
          ).apply(client, args);
          if (
            !result ||
            typeof (result as Promise<unknown>).then !== "function"
          ) {
            checkout.acquired();
            return instrumentAcquired
              ? instrumentAcquiredClient(result, options)
              : result;
          }
          return (result as Promise<unknown>).then(
            (acquired) => {
              checkout.acquired();
              return instrumentAcquired
                ? instrumentAcquiredClient(acquired, options)
                : acquired;
            },
            (error) => {
              checkout.failed(error);
              throw error;
            },
          );
        }
      : undefined;
  const wrappedConnect = connectWithCapture(true);
  const internalConnect = connectWithCapture(false);

  // pg Pool.query() calls `this.connect()` internally. Install the wrapper on
  // the pool itself so pressure is visible for both direct pool queries and
  // explicit checkouts, not only calls made through this Proxy.
  if (internalConnect) {
    try {
      (client as unknown as { connect: unknown }).connect = internalConnect;
    } catch {
      // The Proxy still covers explicit `instrumented.connect()` calls.
    }
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") return wrappedQuery;
      if (prop === "connect") {
        return wrappedConnect ?? Reflect.get(target, prop, receiver);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Fixed savepoint name for the before-image probe. Never derived from the host statement: a name
 * built from caller-controlled text would be an injection point on the host's own connection.
 */
const BEFORE_PROBE_SAVEPOINT = "crumbtrail_before_image_probe";

/** Outcome of one before-image attempt: the images it recovered, or why there are none. */
interface BeforeImageOutcome {
  beforeByPk?: Map<string, Record<string, unknown>>;
  status?: DbBeforeImageStatus;
}

/**
 * Reads the rows an UPDATE is about to change, on the host's own connection, without being able to
 * damage what the host is doing.
 *
 * Three rules, in order:
 *
 * 1. The probe is issued only if it can be bound completely. A clause lifted out of the host
 *    statement keeps that statement's placeholder numbering, so it is rewritten to stand alone;
 *    a clause that cannot be rewritten is not issued at all.
 * 2. The probe is wrapped in a savepoint whenever there is a transaction to protect. Inside
 *    `BEGIN`, any statement that errors aborts the whole transaction and the host's write is lost,
 *    so the guard has to cover failures nobody predicted, not only the ones we can name. A
 *    savepoint does that: it is taken before the probe runs and rolled back to on any throw.
 *    Postgres itself answers whether a transaction is open — `SAVEPOINT` outside one raises 25P01
 *    and leaves the session usable — which is more reliable than tracking `BEGIN` statements the
 *    shim happens to have seen, since a driver or ORM can open one through a path it never saw.
 * 3. Every way of ending without images sets a status, so the reader is told the before-image was
 *    attempted and failed rather than being left to read silence as a disabled feature.
 */
async function captureBeforeImage(
  client: DuckTypedPgClient,
  parsed: ParsedMutation,
  whereClause: string,
  paramArray: unknown[] | undefined,
  options: InstrumentPgClientOptions,
  poolTarget: boolean,
): Promise<BeforeImageOutcome> {
  const rebound = rebindNumberedPlaceholders(whereClause, paramArray);
  if (!rebound) {
    emitGap(options, {
      reason: "capture_exception",
      detail: "before_probe_unbindable",
    });
    return {
      status: { status: "unavailable", reason: "before_probe_unbindable" },
    };
  }

  let guarded = false;
  // A pool hands out a fresh connection per query, so the host's statement cannot be in a
  // transaction this probe could reach — and a savepoint here would land on a third connection,
  // protecting nothing while costing a checkout the pool-pressure stream would then report as
  // real. Transactional code holds a checked-out client, which arrives here as a client.
  if (!poolTarget) {
    try {
      await client.query(`SAVEPOINT ${BEFORE_PROBE_SAVEPOINT}`);
      guarded = true;
    } catch (error) {
      if (!isNoActiveTransaction(error)) {
        // We cannot promise the probe is harmless, so we do not run it.
        emitGap(options, { reason: "capture_exception", error });
        return {
          status: { status: "unavailable", reason: "before_probe_unguarded" },
        };
      }
      // Postgres reported no open transaction, so a probe failure is isolated to the probe.
    }
  }

  let pre: DuckTypedPgQueryResult;
  try {
    pre = await client.query(
      `SELECT * FROM ${parsed.table} ${rebound.text}`,
      rebound.params,
    );
  } catch (error) {
    emitGap(options, { reason: "capture_exception", error });
    if (guarded) await rollbackToProbeSavepoint(client, options);
    return { status: { status: "unavailable", reason: "before_probe_failed" } };
  }
  if (guarded) await releaseProbeSavepoint(client, options);

  const beforeByPk = new Map<string, Record<string, unknown>>();
  for (const row of pre.rows ?? []) {
    if (!isRecord(row)) continue;
    beforeByPk.set(pkKey(extractPk(row, parsed.table, options.pkColumns)), row);
  }
  return { beforeByPk };
}

/**
 * A `pg` Pool, told apart from a Client or a checked-out PoolClient by the counters only a pool
 * keeps. Duck-typed like every other read of the injected driver: `pg` is never imported here.
 */
function looksLikePgPool(client: unknown): boolean {
  const target = client as Record<string, unknown> | null | undefined;
  return (
    typeof target?.totalCount === "number" &&
    typeof target?.idleCount === "number" &&
    typeof target?.waitingCount === "number"
  );
}

/** Postgres raises 25P01 for SAVEPOINT outside a transaction block; the session stays usable. */
function isNoActiveTransaction(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "25P01") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /can only be used in transaction blocks/i.test(message);
}

/** Undoes a failed probe. Never throws: the host mutation still has to be allowed to run. */
async function rollbackToProbeSavepoint(
  client: DuckTypedPgClient,
  options: InstrumentPgClientOptions,
): Promise<void> {
  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${BEFORE_PROBE_SAVEPOINT}`);
  } catch (error) {
    // The transaction is already unrecoverable, so there is nothing left to protect. Recording it
    // is the whole value: it names the probe as the reason the host's write did not land.
    emitGap(options, { reason: "capture_exception", error });
    return;
  }
  await releaseProbeSavepoint(client, options);
}

/** Drops the guard once it is no longer needed. Never throws. */
async function releaseProbeSavepoint(
  client: DuckTypedPgClient,
  options: InstrumentPgClientOptions,
): Promise<void> {
  try {
    await client.query(`RELEASE SAVEPOINT ${BEFORE_PROBE_SAVEPOINT}`);
  } catch (error) {
    emitGap(options, { reason: "capture_exception", error });
  }
}

/** Rows the driver reported, preferring its own count over the length of the rows it returned. */
function resultRowCount(result: DuckTypedPgQueryResult): number | null {
  if (typeof result?.rowCount === "number" && Number.isFinite(result.rowCount))
    return result.rowCount;
  return Array.isArray(result?.rows) ? result.rows.length : null;
}

function instrumentAcquiredClient(
  acquired: unknown,
  options: InstrumentPgClientOptions,
): unknown {
  try {
    if (
      !acquired ||
      typeof (acquired as { query?: unknown }).query !== "function"
    ) {
      throw new TypeError("Pool client cannot be instrumented");
    }
    return instrumentPgClient(acquired as DuckTypedPgClient, options);
  } catch (error) {
    emitGap(options, { reason: "uninstrumented_client", error });
    return acquired;
  }
}
