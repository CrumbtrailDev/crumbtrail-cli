import {
  DB_DIFF_BULK_EVENT_KIND,
  type BugEvent,
  type DbDiffBulkEventData,
  type DbDiffOp,
  type DbEngine,
} from "crumbtrail-core";
import { buildSensitiveColumnSet, redactColumns } from "./columns";
import { buildDbDiffEvent } from "./diff-event";
import { buildDbReadBulkEvent, buildDbReadEvent } from "./read-event";

/**
 * Engine-agnostic emission pipeline shared by every DB adapter. All functions here are synchronous
 * so a sync driver (e.g. better-sqlite3) can reuse them; the "instrumentation can never fail the
 * host query" guarantee lives in each adapter, which wraps these calls in its own never-fail
 * try/catch. The behavior mirrors the original Postgres shim byte-for-byte, parameterized by
 * `engine`.
 */

export const DEFAULT_MAX_ROWS_PER_STATEMENT = 100;
export const DEFAULT_MAX_READ_ROWS_PER_STATEMENT = 25;
export const DEFAULT_MAX_READ_ROWS_PER_REQUEST = 100;

/**
 * Options accepted by every `instrument*` adapter. Every field is engine-agnostic; the Postgres
 * shim keeps `InstrumentPgClientOptions` as a back-compat alias of this type.
 */
export interface InstrumentDbClientOptions {
  /** Active request correlation id (equals the request's traceId). */
  requestId?: string;
  /** Lazily resolve the active request id (e.g. from AsyncLocalStorage); wins when `requestId` is absent. */
  getRequestId?: () => string | undefined;
  sessionId?: string;
  /** Sink for emitted `db.diff` events (e.g. forward to `sendBackendEvent`). */
  emit: (event: BugEvent) => void;
  /** When true, capture the pre-image of UPDATE rows via a SELECT-by-WHERE before mutating. */
  captureBefore?: boolean;
  /** When true, capture capped/redacted SELECT result rows as pre-state read evidence. Default off. */
  captureReads?: boolean;
  /** Extra sensitive column names dropped on top of the defaults. */
  redactColumns?: readonly string[];
  /** Primary-key columns per table; defaults to `['id']` for unlisted tables. */
  pkColumns?: Record<string, readonly string[]>;
  /** Maximum per-row `db.diff` events to emit for one statement before adding a bulk summary. */
  maxRowsPerStatement?: number;
  /** Maximum per-row `db.read` events to emit for one SELECT before adding a bulk summary. */
  maxReadRowsPerStatement?: number;
  /** Maximum per-row `db.read` events to emit for one request scope. */
  maxReadRowsPerRequest?: number;
  now?: () => number;
  sessionStartedAt?: number | Date;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function extractPk(
  row: Record<string, unknown>,
  table: string,
  pkColumns?: Record<string, readonly string[]>,
): Record<string, unknown> | null {
  const cols = pkColumns?.[table] ?? ["id"];
  const pk: Record<string, unknown> = {};
  for (const col of cols) {
    if (col in row) pk[col] = row[col];
  }
  return Object.keys(pk).length > 0 ? pk : null;
}

export function pkKey(pk: Record<string, unknown> | null): string {
  return pk ? JSON.stringify(pk) : "";
}

function redactPkSample(
  pk: Record<string, unknown> | null,
  sensitive: ReturnType<typeof buildSensitiveColumnSet>,
): Record<string, unknown> | null {
  return pk
    ? (redactColumns(pk, sensitive, "db.diff.bulk.samplePks").value ?? null)
    : null;
}

export function normalizeMaxRowsPerStatement(
  value: number | undefined,
): number {
  if (value === undefined) return DEFAULT_MAX_ROWS_PER_STATEMENT;
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROWS_PER_STATEMENT;
  return Math.max(0, Math.floor(value));
}

export function normalizeReadCap(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function buildDbDiffBulkEvent(input: {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  requestId: string;
  rowCount: number;
  emittedRows: number;
  samplePks: Array<Record<string, unknown>>;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();
  const d: DbDiffBulkEventData = {
    engine: input.engine,
    op: input.op,
    table: input.table,
    requestId: input.requestId,
    rowCount: input.rowCount,
    emittedRows: input.emittedRows,
    truncatedRows: Math.max(0, input.rowCount - input.emittedRows),
    samplePks: input.samplePks,
  };
  const event: BugEvent = {
    t: now,
    k: DB_DIFF_BULK_EVENT_KIND,
    d: d as unknown as Record<string, unknown>,
  };
  if (input.sessionId) event.sessionId = input.sessionId;

  const startedAt = normalizeStartedAt(input.sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);

  return event;
}

function normalizeStartedAt(
  startedAt: number | Date | undefined,
): number | undefined {
  if (startedAt instanceof Date) {
    const time = startedAt.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return Number.isFinite(startedAt)
    ? Math.round(startedAt as number)
    : undefined;
}

/**
 * Emits per-row `db.diff` events for a mutation's after-image rows, plus a single `db.diff.bulk`
 * summary when `rowCount` exceeds the per-statement cap. Delete rows carry `before`; insert/update
 * rows carry `after` (and `before` from `beforeByPk` when captured). samplePks holds up to 3 pks.
 */
export function emitDbDiffEvents(input: {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  requestId: string;
  /** After-image records for the statement (already filtered to plain objects). */
  rows: Array<Record<string, unknown>>;
  /** Pre-image lookup by pk for updates with before-capture enabled. */
  beforeByPk?: Map<string, Record<string, unknown>>;
  /** Total rows the statement changed (may exceed `rows.length` when the driver reports more). */
  rowCount: number;
  options: InstrumentDbClientOptions;
}): void {
  const { engine, op, table, requestId, rows, beforeByPk, rowCount, options } =
    input;
  const maxRows = normalizeMaxRowsPerStatement(options.maxRowsPerStatement);
  const emittedRows = Math.min(rows.length, maxRows);
  const emitRows = rows.slice(0, emittedRows);
  const samplePks: Array<Record<string, unknown>> = [];
  const sensitive = buildSensitiveColumnSet(options.redactColumns);

  for (const row of emitRows) {
    const pk = extractPk(row, table, options.pkColumns);
    const samplePk = redactPkSample(pk, sensitive);
    if (samplePks.length < 3 && samplePk) samplePks.push(samplePk);
    const event = buildDbDiffEvent({
      engine,
      op,
      table,
      pk,
      requestId,
      sessionId: options.sessionId,
      redactColumns: options.redactColumns,
      now: options.now?.(),
      sessionStartedAt: options.sessionStartedAt,
      ...(op === "delete"
        ? { before: row }
        : { after: row, before: beforeByPk?.get(pkKey(pk)) }),
    });
    options.emit(event);
  }

  if (rowCount > maxRows) {
    for (
      let index = emittedRows;
      index < rows.length && samplePks.length < 3;
      index += 1
    ) {
      const samplePk = redactPkSample(
        extractPk(rows[index], table, options.pkColumns),
        sensitive,
      );
      if (samplePk) samplePks.push(samplePk);
    }
    options.emit(
      buildDbDiffBulkEvent({
        engine,
        op,
        table,
        requestId,
        rowCount,
        emittedRows,
        samplePks,
        sessionId: options.sessionId,
        now: options.now?.(),
        sessionStartedAt: options.sessionStartedAt,
      }),
    );
  }
}

/**
 * Emits the image-less statement-level fallback: one `db.diff` with `pk: null` and `rowCount` set
 * (per-row images were unobtainable, e.g. a MySQL multi-row insert), plus a `db.diff.bulk` summary
 * (emittedRows 0, samplePks []) when the count exceeds the per-statement cap.
 */
export function emitImagelessDbDiff(input: {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  requestId: string;
  rowCount: number;
  options: InstrumentDbClientOptions;
}): void {
  const { engine, op, table, requestId, rowCount, options } = input;
  options.emit(
    buildDbDiffEvent({
      engine,
      op,
      table,
      pk: null,
      rowCount,
      requestId,
      sessionId: options.sessionId,
      redactColumns: options.redactColumns,
      now: options.now?.(),
      sessionStartedAt: options.sessionStartedAt,
    }),
  );

  const maxRows = normalizeMaxRowsPerStatement(options.maxRowsPerStatement);
  if (rowCount > maxRows) {
    options.emit(
      buildDbDiffBulkEvent({
        engine,
        op,
        table,
        requestId,
        rowCount,
        emittedRows: 0,
        samplePks: [],
        sessionId: options.sessionId,
        now: options.now?.(),
        sessionStartedAt: options.sessionStartedAt,
      }),
    );
  }
}

/**
 * Emits capped, redacted `db.read` events for a SELECT's rows plus a `db.read.bulk` summary when
 * more rows exist than were emitted. Honors both the per-statement cap and the per-request budget
 * tracked in `emittedReadRowsByRequest`.
 */
export function emitDbReadEvents(input: {
  engine: DbEngine;
  table: string;
  requestId: string;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  options: InstrumentDbClientOptions;
  emittedReadRowsByRequest: Map<string, number>;
}): void {
  const { engine, table, requestId, rows, rowCount, options } = input;
  const emittedReadRowsByRequest = input.emittedReadRowsByRequest;
  const perStatementCap = normalizeReadCap(
    options.maxReadRowsPerStatement,
    DEFAULT_MAX_READ_ROWS_PER_STATEMENT,
  );
  const perRequestCap = normalizeReadCap(
    options.maxReadRowsPerRequest,
    DEFAULT_MAX_READ_ROWS_PER_REQUEST,
  );
  const emittedForRequest = emittedReadRowsByRequest.get(requestId) ?? 0;
  const remainingForRequest = Math.max(0, perRequestCap - emittedForRequest);
  const emittedRows = Math.min(
    rows.length,
    perStatementCap,
    remainingForRequest,
  );
  const emitRows = rows.slice(0, emittedRows);
  const samplePks: Array<Record<string, unknown>> = [];
  const sensitive = buildSensitiveColumnSet(options.redactColumns);

  for (const row of emitRows) {
    const pk = extractPk(row, table, options.pkColumns);
    const samplePk = redactPkSample(pk, sensitive);
    if (samplePks.length < 3 && samplePk) samplePks.push(samplePk);
    options.emit(
      buildDbReadEvent({
        engine,
        table,
        pk,
        row,
        requestId,
        sessionId: options.sessionId,
        redactColumns: options.redactColumns,
        now: options.now?.(),
        sessionStartedAt: options.sessionStartedAt,
      }),
    );
    emittedReadRowsByRequest.set(
      requestId,
      (emittedReadRowsByRequest.get(requestId) ?? 0) + 1,
    );
  }

  if (rowCount > emittedRows) {
    for (
      let index = emittedRows;
      index < rows.length && samplePks.length < 3;
      index += 1
    ) {
      const samplePk = redactPkSample(
        extractPk(rows[index], table, options.pkColumns),
        sensitive,
      );
      if (samplePk) samplePks.push(samplePk);
    }
    options.emit(
      buildDbReadBulkEvent({
        engine,
        table,
        requestId,
        rowCount,
        emittedRows,
        samplePks,
        sessionId: options.sessionId,
        now: options.now?.(),
        sessionStartedAt: options.sessionStartedAt,
      }),
    );
  }
}
