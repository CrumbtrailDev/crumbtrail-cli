import {
  classifyStatement,
  countPlaceholders,
  leadingSqlKeyword,
  parseMutation,
  parseRead,
  type ParsedMutation,
  type ParsedRead,
} from "./sql";
import {
  emitGap,
  emitDbDiffEvents,
  emitDbErrorEvent,
  emitDbReadEvents,
  emitImagelessDbDiff,
  extractDbConnectionIdentity,
  finishDbTransaction,
  extractPk,
  isRecord,
  normalizeMaxRowsPerStatement,
  nextStatementSeq,
  pkKey,
  startDbQueryTimer,
  startDbTransaction,
  type DbStatementContext,
  type DbTransactionContext,
  type InstrumentDbClientOptions,
  type ReadCallsitesByRequest,
} from "./instrument-shared";
import { captureGenerationFor } from "../capture-generation";

/**
 * Minimal duck-typed view of a better-sqlite3 / `node:sqlite` statement. The host injects the real
 * database, so the sqlite driver stays an optional peer and tests use a synchronous fake. `run`
 * returns the mutation summary (`changes` + `lastInsertRowid`); `all`/`get` read rows back.
 */
export interface DuckTypedSqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}

export interface DuckTypedSqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Minimal duck-typed view of a better-sqlite3 / `node:sqlite` database: `prepare(sql)` → statement. */
export interface DuckTypedSqliteDatabase {
  readonly isTransaction?: boolean;
  readonly inTransaction?: boolean;
  prepare(sql: unknown, ...rest: unknown[]): DuckTypedSqliteStatement;
}

const ENGINE = "sqlite" as const;

function observedSqliteAutocommit(db: DuckTypedSqliteDatabase): boolean {
  try {
    const states = [db.isTransaction, db.inTransaction].filter(
      (value) => value !== undefined,
    );
    return states.length > 0 && states.every((value) => value === false);
  } catch {
    return false;
  }
}

type ResolvedParams =
  | { kind: "named"; value: Record<string, unknown> }
  | { kind: "positional"; values: unknown[] };

/**
 * Classifies the bind arguments of a statement execution. A single plain-object argument is treated
 * as SQLite named parameters; anything else is positional. The one-level flatten is a defensive
 * path, not a documented better-sqlite3 call shape: better-sqlite3's `run()` takes spread positional
 * args (`run(a, b)`), so this only matters if a caller (or another duck-typed driver) passes
 * `run([a, b])` directly.
 */
function resolveParams(args: unknown[]): ResolvedParams {
  if (args.length === 1 && isRecord(args[0])) {
    return { kind: "named", value: args[0] as Record<string, unknown> };
  }
  const values: unknown[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) values.push(...arg);
    else values.push(arg);
  }
  return { kind: "positional", values };
}

/**
 * Reuses a mutation's bind params for the WHERE-clause pre-SELECT. Named params are passed through
 * verbatim (SQLite binds them by name); positional params take the trailing `?`-count of the WHERE
 * clause from the END of the flattened positional args. Best-effort — a mismatch throws inside the
 * caller's try/catch and degrades to no image, never a failed host query.
 */
function bindReusedParams(
  resolved: ResolvedParams,
  whereClause: string,
): unknown[] {
  if (resolved.kind === "named") return [resolved.value];
  const count = countPlaceholders(whereClause);
  const start = Math.max(0, resolved.values.length - count);
  return resolved.values.slice(start);
}

/** Builds a post-SELECT that fetches rows back by primary key (IN-list for single-col, OR-of-ANDs for composite). */
function buildPostSelectByPk(
  table: string,
  pkCols: readonly string[],
  pks: Array<Record<string, unknown>>,
): { sql: string; params: unknown[] } | null {
  if (pks.length === 0 || pkCols.length === 0) return null;
  if (pkCols.length === 1) {
    const col = pkCols[0];
    const params = pks.map((pk) => pk[col]);
    const placeholders = params.map(() => "?").join(", ");
    return {
      sql: `SELECT * FROM ${table} WHERE ${col} IN (${placeholders})`,
      params,
    };
  }
  const clause = pks
    .map(() => `(${pkCols.map((col) => `${col} = ?`).join(" AND ")})`)
    .join(" OR ");
  const params = pks.flatMap((pk) => pkCols.map((col) => pk[col]));
  return { sql: `SELECT * FROM ${table} WHERE ${clause}`, params };
}

/** Reads `changes` off a run() result as a non-negative integer; unusable shapes count as 0. */
function toChangeCount(info: unknown): number {
  if (
    isRecord(info) &&
    typeof info.changes === "number" &&
    Number.isFinite(info.changes)
  ) {
    return Math.max(0, Math.floor(info.changes));
  }
  return 0;
}

/** Returns a usable `lastInsertRowid` (finite positive number or positive bigint), else undefined. */
function validRowid(info: unknown): number | bigint | undefined {
  if (!isRecord(info)) return undefined;
  const rowid = info.lastInsertRowid;
  if (typeof rowid === "number" && Number.isFinite(rowid) && rowid > 0)
    return rowid;
  if (typeof rowid === "bigint" && rowid > 0n) return rowid;
  return undefined;
}

/**
 * Wraps a duck-typed better-sqlite3 / `node:sqlite` database so INSERT/UPDATE/DELETE statements
 * executed within a request scope record a `db.diff` event (op, table, primary key, after-image;
 * before-image behind `captureBefore`), and SELECTs optionally record `db.read` evidence. Everything
 * is fully synchronous — the sync driver's `run`/`all` return values are observed inline, so events
 * are visible the instant the host call returns.
 *
 * The database is wrapped with a Proxy that intercepts `prepare`; the returned statement is itself
 * proxied so `run` (mutations) and `all` (reads, when `captureReads`) are instrumented and every
 * other member (`get`, `iterate`, `pluck`, …) binds straight through. Non-string or unparseable SQL
 * yields the real statement untouched.
 *
 * After-images come from post-SELECTs (INSERT by `rowid`, UPDATE by the pks captured in a pre-SELECT)
 * — the host's SQL text is never rewritten, so `run()` returns exactly what the real driver produced.
 * Every capture step is wrapped: a failing pre/post-SELECT, missing rowid, WITHOUT-ROWID table, or
 * emit error degrades to fewer/no images (image-less fallback carrying `rowCount`), never a failed
 * host query.
 *
 * Limitations: trigger/cascade side effects and rows changed via other tables are not captured; the
 * pre-image SELECT reuses the statement's WHERE clause + params, so it supports single-table
 * UPDATE/DELETE (not CTEs, joins, or sub-selects).
 */
export function instrumentSqliteDatabase<T extends DuckTypedSqliteDatabase>(
  db: T,
  options: InstrumentDbClientOptions,
): T {
  const emittedReadRowsByRequest = new Map<string, number>();
  const readStatementsByRequest = new Map<string, number>();
  const readCallsitesByRequest: ReadCallsitesByRequest = new Map();
  const statementSeqByRequest = new Map<string, number>();
  const connection = extractDbConnectionIdentity(ENGINE, db);
  let transaction: DbTransactionContext | undefined;

  const handleInsert = (
    realStmt: DuckTypedSqliteStatement,
    parsed: ParsedMutation,
    args: unknown[],
    requestId: string,
    operationOptions: InstrumentDbClientOptions,
  ): unknown => {
    const statementSeq = nextStatementSeq(statementSeqByRequest, requestId);
    // The host mutation. Its own errors propagate normally — we never swallow the caller's query.
    const elapsed = startDbQueryTimer(operationOptions);
    const info = realStmt.run(...args);
    const context: DbStatementContext = {
      observedAutocommit: observedSqliteAutocommit(db),
      connection,
      durationMs: elapsed(),
      transactionId: transaction?.id,
      statementSeq,
    };
    try {
      const changes = toChangeCount(info);
      const rowid = validRowid(info);
      if (changes === 1 && rowid !== undefined) {
        let afterRow: Record<string, unknown> | undefined;
        try {
          const row = db
            .prepare(`SELECT * FROM ${parsed.table} WHERE rowid = ?`)
            .get(rowid);
          if (isRecord(row)) afterRow = row;
        } catch (error) {
          emitGap(operationOptions, { reason: "capture_exception", error });
          afterRow = undefined;
        }
        if (afterRow) {
          emitDbDiffEvents({
            engine: ENGINE,
            op: "insert",
            table: parsed.table,
            requestId,
            rows: [afterRow],
            rowCount: 1,
            options: operationOptions,
            context,
          });
          return info;
        }
      }
      // WITHOUT-ROWID table, multi-row insert, or a failed rowid lookup: keep the write visible.
      if (changes > 0) {
        emitImagelessDbDiff({
          engine: ENGINE,
          op: "insert",
          table: parsed.table,
          requestId,
          rowCount: changes,
          options: operationOptions,
          context,
        });
      }
    } catch (error) {
      emitGap(operationOptions, { reason: "capture_exception", error });
    }
    return info;
  };

  const handleUpdate = (
    realStmt: DuckTypedSqliteStatement,
    parsed: ParsedMutation,
    args: unknown[],
    requestId: string,
    operationOptions: InstrumentDbClientOptions,
  ): unknown => {
    const statementSeq = nextStatementSeq(statementSeqByRequest, requestId);
    const resolved = resolveParams(args);
    const pkCols = operationOptions.pkColumns?.[parsed.table] ?? ["id"];

    // Pre-SELECT by WHERE to capture the affected pks (and, when enabled, the before-image). Strictly
    // best-effort: a failing SELECT must NOT abort a mutation that would otherwise succeed.
    let usablePks: Array<Record<string, unknown>> | undefined;
    let beforeByPk: Map<string, Record<string, unknown>> | undefined;
    if (parsed.whereClause) {
      try {
        const preRows = db
          .prepare(`SELECT * FROM ${parsed.table} ${parsed.whereClause}`)
          .all(...bindReusedParams(resolved, parsed.whereClause));
        const pks: Array<Record<string, unknown>> = [];
        const beforeMap = new Map<string, Record<string, unknown>>();
        for (const row of Array.isArray(preRows) ? preRows : []) {
          if (!isRecord(row)) continue;
          const pk = extractPk(row, parsed.table, operationOptions.pkColumns);
          if (pk && pkCols.every((col) => col in pk)) pks.push(pk);
          if (pk) beforeMap.set(pkKey(pk), row);
        }
        usablePks = pks;
        if (operationOptions.captureBefore) beforeByPk = beforeMap;
      } catch (error) {
        emitGap(operationOptions, { reason: "capture_exception", error });
        usablePks = undefined;
        beforeByPk = undefined;
      }
    }

    // The host mutation. Errors propagate normally.
    const elapsed = startDbQueryTimer(operationOptions);
    const info = realStmt.run(...args);
    const context: DbStatementContext = {
      observedAutocommit: observedSqliteAutocommit(db),
      connection,
      durationMs: elapsed(),
      transactionId: transaction?.id,
      statementSeq,
    };

    try {
      const changes = toChangeCount(info);
      if (usablePks && usablePks.length > 0) {
        const maxRows = normalizeMaxRowsPerStatement(
          operationOptions.maxRowsPerStatement,
        );
        const capped = usablePks.slice(0, maxRows);
        let afterRows: Array<Record<string, unknown>> | undefined;
        try {
          const post = buildPostSelectByPk(parsed.table, pkCols, capped);
          if (post) {
            const rows = db.prepare(post.sql).all(...post.params);
            afterRows = (Array.isArray(rows) ? rows : []).filter(isRecord);
          }
        } catch (error) {
          emitGap(operationOptions, { reason: "capture_exception", error });
          afterRows = undefined;
        }
        if (afterRows && afterRows.length > 0) {
          emitDbDiffEvents({
            engine: ENGINE,
            op: "update",
            table: parsed.table,
            requestId,
            rows: afterRows,
            beforeByPk,
            rowCount: changes,
            options: operationOptions,
            context,
          });
          return info;
        }
      }
      // No WHERE, a failed pre/post-SELECT, or no rows recovered: keep the write visible.
      if (changes > 0) {
        emitImagelessDbDiff({
          engine: ENGINE,
          op: "update",
          table: parsed.table,
          requestId,
          rowCount: changes,
          options: operationOptions,
          context,
        });
      }
    } catch (error) {
      emitGap(operationOptions, { reason: "capture_exception", error });
    }
    return info;
  };

  const handleDelete = (
    realStmt: DuckTypedSqliteStatement,
    parsed: ParsedMutation,
    args: unknown[],
    requestId: string,
    operationOptions: InstrumentDbClientOptions,
  ): unknown => {
    const statementSeq = nextStatementSeq(statementSeqByRequest, requestId);
    const resolved = resolveParams(args);

    // Deletes always carry a before-image (pg parity): pre-SELECT the rows before they vanish.
    let beforeRows: Array<Record<string, unknown>> | undefined;
    if (parsed.whereClause) {
      try {
        const preRows = db
          .prepare(`SELECT * FROM ${parsed.table} ${parsed.whereClause}`)
          .all(...bindReusedParams(resolved, parsed.whereClause));
        beforeRows = (Array.isArray(preRows) ? preRows : []).filter(isRecord);
      } catch (error) {
        emitGap(operationOptions, { reason: "capture_exception", error });
        beforeRows = undefined;
      }
    }

    // The host mutation. Errors propagate normally.
    const elapsed = startDbQueryTimer(operationOptions);
    const info = realStmt.run(...args);
    const context: DbStatementContext = {
      observedAutocommit: observedSqliteAutocommit(db),
      connection,
      durationMs: elapsed(),
      transactionId: transaction?.id,
      statementSeq,
    };

    try {
      const changes = toChangeCount(info);
      if (beforeRows && beforeRows.length > 0) {
        emitDbDiffEvents({
          engine: ENGINE,
          op: "delete",
          table: parsed.table,
          requestId,
          rows: beforeRows,
          rowCount: changes,
          options: operationOptions,
          context,
        });
        return info;
      }
      if (changes > 0) {
        emitImagelessDbDiff({
          engine: ENGINE,
          op: "delete",
          table: parsed.table,
          requestId,
          rowCount: changes,
          options: operationOptions,
          context,
        });
      }
    } catch (error) {
      emitGap(operationOptions, { reason: "capture_exception", error });
    }
    return info;
  };

  const instrumentedRun = (
    realStmt: DuckTypedSqliteStatement,
    parsed: ParsedMutation,
    args: unknown[],
    statement: string,
  ): unknown => {
    const operationOptions = captureGenerationFor(options);
    // Correlation resolution is diff-capture work; if it throws or is absent, run the host mutation
    // untouched. Instrumentation must never decide whether — or how — the host's query runs.
    let requestId: string | undefined;
    try {
      requestId =
        operationOptions.requestId ?? operationOptions.getRequestId?.();
    } catch (error) {
      emitGap(operationOptions, { reason: "capture_exception", error });
      return realStmt.run(...args);
    }
    if (!requestId) return realStmt.run(...args);

    try {
      switch (parsed.op) {
        case "insert":
          return handleInsert(
            realStmt,
            parsed,
            args,
            requestId,
            operationOptions,
          );
        case "update":
          return handleUpdate(
            realStmt,
            parsed,
            args,
            requestId,
            operationOptions,
          );
        case "delete":
          return handleDelete(
            realStmt,
            parsed,
            args,
            requestId,
            operationOptions,
          );
        default:
          return realStmt.run(...args);
      }
    } catch (error) {
      emitDbErrorEvent({
        engine: ENGINE,
        op: parsed.op,
        table: parsed.table,
        statement,
        statementParams:
          args.length === 1 && isRecord(args[0]) ? args[0] : args,
        requestId,
        error,
        options: operationOptions,
        context: { connection, transactionId: transaction?.id },
      });
      throw error;
    }
  };

  const instrumentedRead = (
    realStmt: DuckTypedSqliteStatement,
    parsedRead: ParsedRead,
    args: unknown[],
    statement: string,
    method: "all" | "get",
  ): unknown => {
    const operationOptions = captureGenerationFor(options);
    let requestId: string | undefined;
    try {
      requestId =
        operationOptions.requestId ?? operationOptions.getRequestId?.();
    } catch (error) {
      emitGap(operationOptions, { reason: "capture_exception", error });
      return realStmt[method](...args);
    }
    // The host read runs exactly once; its result is returned unchanged.
    const elapsed = startDbQueryTimer(operationOptions);
    let result: unknown;
    try {
      result = realStmt[method](...args);
    } catch (error) {
      if (requestId) {
        emitDbErrorEvent({
          engine: ENGINE,
          op: "select",
          table: parsedRead.table,
          statement,
          requestId,
          error,
          options: operationOptions,
        });
      }
      throw error;
    }
    const context: DbStatementContext = {
      connection,
      durationMs: elapsed(),
      transactionId: transaction?.id,
    };
    // Preserve the existing read-capture boundary: `.all()` emits row evidence;
    // `.get()` is wrapped only so a refused SELECT is no longer invisible.
    if (!requestId || !operationOptions.captureReads || method === "get")
      return result;
    try {
      const rows = (
        Array.isArray(result) ? result : isRecord(result) ? [result] : []
      ).filter(isRecord);
      emitDbReadEvents({
        engine: ENGINE,
        table: parsedRead.table,
        requestId,
        rows,
        rowCount: rows.length,
        options: operationOptions,
        emittedReadRowsByRequest,
        readCallsitesByRequest,
        readStatementsByRequest,
        statement,
        context,
      });
    } catch (error) {
      emitGap(operationOptions, { reason: "capture_exception", error });
    }
    return result;
  };

  const wrapStatement = (
    stmt: DuckTypedSqliteStatement,
    parsed: ParsedMutation | undefined,
    parsedRead: ParsedRead | undefined,
    statement: string,
  ): DuckTypedSqliteStatement =>
    new Proxy(stmt, {
      get(target, prop, _receiver) {
        if (prop === "run" && parsed) {
          return (...args: unknown[]) =>
            instrumentedRun(target, parsed, args, statement);
        }
        if ((prop === "all" || prop === "get") && parsedRead) {
          return (...args: unknown[]) =>
            instrumentedRead(target, parsedRead, args, statement, prop);
        }
        // `target` (not `receiver`) as the `this` binding: accessor properties (e.g. node:sqlite's
        // native `sourceSQL` getter) must run against the real statement, not this Proxy.
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const wrapTransactionFunction = (fn: (...args: unknown[]) => unknown) =>
    new Proxy(fn, {
      apply(target, thisArg, args) {
        const operationOptions = captureGenerationFor(options);
        // better-sqlite3 implements a nested transaction wrapper with a savepoint. Keep the outer
        // transaction id and let its eventual outcome speak for the whole transaction.
        if (transaction) return Reflect.apply(target, thisArg, args);
        let requestId: string | undefined;
        try {
          requestId =
            operationOptions.requestId ?? operationOptions.getRequestId?.();
        } catch (error) {
          emitGap(operationOptions, { reason: "capture_exception", error });
        }
        const active = startDbTransaction({
          engine: ENGINE,
          requestId,
          connection,
          options: operationOptions,
        });
        const previous = transaction;
        transaction = active;
        try {
          const result = Reflect.apply(target, thisArg, args);
          finishDbTransaction({
            engine: ENGINE,
            transaction: active,
            outcome: "commit",
            requestId,
            options: operationOptions,
          });
          return result;
        } catch (error) {
          finishDbTransaction({
            engine: ENGINE,
            transaction: active,
            outcome: "rollback",
            requestId,
            options: operationOptions,
          });
          throw error;
        } finally {
          transaction = previous;
        }
      },
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" &&
          (prop === "deferred" || prop === "immediate" || prop === "exclusive")
          ? wrapTransactionFunction(value as (...args: unknown[]) => unknown)
          : value;
      },
    });

  return new Proxy(db, {
    get(target, prop, _receiver) {
      if (prop === "transaction") {
        const factory = Reflect.get(target, prop, target);
        if (typeof factory !== "function") return factory;
        return (...args: unknown[]) => {
          const fn = (factory as (...values: unknown[]) => unknown).apply(
            target,
            args,
          );
          return typeof fn === "function"
            ? wrapTransactionFunction(fn as (...values: unknown[]) => unknown)
            : fn;
        };
      }
      if (prop === "prepare") {
        return (...prepareArgs: unknown[]): DuckTypedSqliteStatement => {
          const operationOptions = captureGenerationFor(options);
          // The host prepare runs and its errors propagate; parsing is separate best-effort work.
          const sql = prepareArgs[0];
          let realStmt: DuckTypedSqliteStatement;
          try {
            realStmt = target.prepare(
              ...(prepareArgs as [unknown, ...unknown[]]),
            );
          } catch (error) {
            let requestId: string | undefined;
            try {
              requestId =
                operationOptions.requestId ?? operationOptions.getRequestId?.();
            } catch {
              requestId = undefined;
            }
            if (requestId && typeof sql === "string") {
              emitDbErrorEvent({
                engine: ENGINE,
                op: "other",
                table: null,
                statement: sql,
                requestId,
                error,
                options: operationOptions,
              });
            }
            throw error;
          }
          if (typeof sql !== "string") return realStmt;
          let parsed: ParsedMutation | undefined;
          let parsedRead: ParsedRead | undefined;
          try {
            const classification = classifyStatement(sql);
            if (
              classification.kind === "unparsable" &&
              classification.mayMutate
            ) {
              emitGap(operationOptions, {
                reason: "unparsed_sql",
                detail: leadingSqlKeyword(sql),
              });
            }
            parsed =
              classification.kind === "mutation"
                ? classification.mutation
                : undefined;
            parsedRead =
              classification.kind === "read" ? classification.read : undefined;
          } catch (error) {
            emitGap(operationOptions, { reason: "capture_exception", error });
            return realStmt;
          }
          if (!parsed && !parsedRead) return realStmt;
          return wrapStatement(realStmt, parsed, parsedRead, sql);
        };
      }
      // `target` (not `receiver`) as the `this` binding: accessor properties (e.g. node:sqlite's
      // native `sourceSQL` getter) must run against the real database, not this Proxy.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
