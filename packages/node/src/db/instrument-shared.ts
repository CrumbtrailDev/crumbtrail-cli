import {
  buildCaptureGapEvent,
  DB_DIFF_BULK_EVENT_KIND,
  type BugEvent,
  type CaptureGapEventData,
  type DbDiffBulkEventData,
  type DbDiffOp,
  type DbEngine,
  type DbErrorOp,
  type DbStatementOp,
  normalizeStatementShape,
} from "crumbtrail-core";
import {
  appFramesFromStack,
  captureDbCallsite,
  type DbCallsite,
} from "./callsite";
import { buildSensitiveColumnSet, redactColumns } from "./columns";
import { buildDbDiffEvent, type DbValueBounds } from "./diff-event";
import { buildDbErrorEvent } from "./error-event";
import { buildDbReadBulkEvent, buildDbReadEvent } from "./read-event";
import {
  buildDbStatementEvent,
  DB_STATEMENT_SHAPE_LABEL,
} from "./statement-event";

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
 * Maximum distinct statement shapes that capture a stack in one request.
 *
 * The budget is per REQUEST and per PROCESS, not per instrumented client. A cap
 * held in a map owned by `instrumentPgClient` is multiplied by however many
 * clients an application instruments — a pool wrapper per tenant, a read replica
 * beside a primary — and a bound that a caller can multiply by construction is
 * not a bound. Both lanes draw on the same budget for the same reason: a refused
 * statement is rare in a healthy process and continuous in a broken one, which
 * is exactly when nothing should be capturing an unbounded number of stacks.
 */
export const DEFAULT_MAX_CALLSITES_PER_REQUEST = 8;

/**
 * How many requests keep a callsite budget before the oldest is dropped.
 *
 * The map is keyed by request id, and request ids are unbounded over a process's
 * life. Every per-request map beside this one has the same shape and the same
 * hole; this one is bounded because it holds objects rather than counters.
 */
const MAX_TRACKED_CALLSITE_REQUESTS = 256;

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
  /** A separate, non recursive sink for a capture gap when `emit` fails. */
  emitGap?: (event: BugEvent) => void;
  /** Alias for `emitGap` used by hosts that keep gap handling separate from event emission. */
  onGap?: (event: BugEvent) => void;
  /** Final host supplied fallback when no dedicated gap sink is available. */
  onWarning?: (event: BugEvent) => void;
  /** When true, capture the pre-image of UPDATE rows via a SELECT-by-WHERE before mutating. */
  captureBefore?: boolean;
  /** When true, capture capped/redacted SELECT result rows as pre-state read evidence. Default off. */
  captureReads?: boolean;
  /** Extra sensitive column names dropped on top of the defaults. */
  redactColumns?: readonly string[];
  /**
   * Capture the host application callsite (file, line) that issued database work and ride it on
   * the event. Refused statements always capture one; successful reads capture only when this is
   * enabled. Writes and reads are otherwise off by default. Set `callsiteRoot` to make the path
   * repo-relative.
   */
  captureCallsite?: boolean;
  callsiteRoot?: string;
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

export interface EmitGapInput {
  reason: Extract<
    CaptureGapEventData["reason"],
    "unparsed_sql" | "uninstrumented_client" | "capture_exception"
  >;
  /** A safe descriptor only: error name, table and operation, or leading SQL keyword. */
  detail?: string;
  error?: unknown;
}

/**
 * Records a bounded completeness gap without ever changing host database behavior. A failed
 * primary event sink must never be retried for the gap because that would repeat the same failure
 * path. The gap uses only an independent fallback sink.
 */
export function emitGap(
  options: InstrumentDbClientOptions,
  input: EmitGapInput,
): void {
  const event = buildGapEvent(options, input);
  try {
    options.emit(event);
  } catch (error) {
    emitGapFallback(options, event, error);
  }
}

function buildGapEvent(
  options: InstrumentDbClientOptions,
  input: EmitGapInput,
): BugEvent {
  return buildCaptureGapEvent({
    surface: "db_diff",
    reason: input.reason,
    detail: input.detail ?? captureErrorName(input.error),
    sessionId: options.sessionId,
    t: options.now?.(),
    sessionStartedAt: options.sessionStartedAt,
  });
}

/**
 * Emits a regular database event once. If that primary sink fails, its gap is sent directly to
 * the independent fallback, never back through `options.emit`.
 */
export function emitDbEvent(
  options: InstrumentDbClientOptions,
  event: BugEvent,
): boolean {
  try {
    options.emit(event);
    return true;
  } catch (error) {
    emitGapFallback(
      options,
      buildGapEvent(options, { reason: "capture_exception", error }),
      error,
    );
    return false;
  }
}

function emitGapFallback(
  options: InstrumentDbClientOptions,
  event: BugEvent,
  primaryError: unknown,
): void {
  const fallback = options.emitGap ?? options.onGap ?? options.onWarning;
  if (fallback) {
    try {
      fallback(event);
      return;
    } catch (fallbackError) {
      retainUnroutedGap(event, primaryError, fallbackError);
      return;
    }
  }
  retainUnroutedGap(event, primaryError);
}

/**
 * A process local last resort preserves the most recent gap without calling user code. It is
 * deliberately bounded and is only reached when every configured reporting sink has failed.
 */
const unroutedCaptureGaps: BugEvent[] = [];
const MAX_UNROUTED_CAPTURE_GAPS = 20;

function retainUnroutedGap(
  event: BugEvent,
  _primaryError: unknown,
  _fallbackError?: unknown,
): void {
  unroutedCaptureGaps.push(event);
  if (unroutedCaptureGaps.length > MAX_UNROUTED_CAPTURE_GAPS) {
    unroutedCaptureGaps.shift();
  }
}

/** Returns only an error class name, never a message, stack, query, or bind value. */
export function captureErrorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  if (isRecord(error) && typeof error.name === "string")
    return error.name.slice(0, 120);
  return typeof error === "string" ? "Error" : "UnknownError";
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

export type ReadCallsitesByRequest = Map<
  string,
  Map<string, DbCallsite | undefined>
>;

/**
 * The thrown error's own origin, which survives an async rejection where the
 * catch site does not.
 *
 * Two refusals are deliberate. A stack this SDK did not produce is not evidence
 * of where the statement was issued — `error.stack` is an ordinary writable
 * property and a driver, a wrapper, or user code may set it to anything — so a
 * stack that yields no frame is reported as no callsite rather than trusted
 * further. And there is no fallback to the catch site: the catch sits inside
 * this instrumentation or inside the driver, so capturing it would publish a
 * location that is confidently not the one a reader wants. Absent is the honest
 * answer, and `code-locations` already refuses a guess by name.
 */
function captureDbErrorCallsite(
  error: unknown,
  root: string | undefined,
): DbCallsite | undefined {
  const stack =
    error instanceof Error
      ? error.stack
      : isRecord(error) && typeof error.stack === "string"
        ? error.stack
        : undefined;
  if (typeof stack !== "string" || stack.length === 0) return undefined;
  return appFramesFromStack(stack, root ?? process.cwd(), 1)[0];
}

/**
 * One callsite budget for the whole process, shared by every instrumented
 * client and by both the refused-statement and successful-read lanes.
 */
const callsiteBudget: ReadCallsitesByRequest = new Map();

/** True while this request still has room for another distinct statement shape. */
function claimCallsiteBudget(requestId: string, shape: string | undefined) {
  let byShape = callsiteBudget.get(requestId);
  if (!byShape) {
    if (callsiteBudget.size >= MAX_TRACKED_CALLSITE_REQUESTS) {
      // Insertion-ordered, so the first key is the oldest request tracked.
      const oldest = callsiteBudget.keys().next();
      if (!oldest.done) callsiteBudget.delete(oldest.value);
    }
    byShape = new Map();
    callsiteBudget.set(requestId, byShape);
  }
  const key = shape ?? "";
  return {
    seen: byShape.has(key),
    cached: byShape.get(key),
    full: byShape.size >= DEFAULT_MAX_CALLSITES_PER_REQUEST,
    remember(callsite: DbCallsite | undefined) {
      byShape.set(key, callsite);
      return callsite;
    },
  };
}

/** Test seam: the budget is process-wide, so a suite must be able to clear it. */
export function resetCallsiteBudgetForTests(): void {
  callsiteBudget.clear();
}

/** Captures once per normalized statement shape and caches an absent application frame too. */
function readCallsiteFor(
  options: InstrumentDbClientOptions,
  requestId: string,
  shape: string | undefined,
  _readCallsitesByRequest: ReadCallsitesByRequest,
): DbCallsite | undefined {
  if (!options.captureCallsite) return undefined;
  const slot = claimCallsiteBudget(requestId, shape);
  if (slot.seen) return slot.cached;
  if (slot.full) return undefined;
  return slot.remember(captureDbCallsite(options.callsiteRoot));
}

/**
 * A refused statement's callsite, drawn from the same per-request budget.
 *
 * Uncapped, this captures a stack on every refusal — and a process refusing one
 * statement is usually a process refusing all of them, so the lane that most
 * needs a bound is the one that had none.
 */
function errorCallsiteFor(
  options: InstrumentDbClientOptions,
  requestId: string,
  shape: string | undefined,
  error: unknown,
): DbCallsite | undefined {
  const slot = claimCallsiteBudget(requestId, shape);
  if (slot.seen) return slot.cached;
  if (slot.full) return undefined;
  return slot.remember(captureDbErrorCallsite(error, options.callsiteRoot));
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
  valueBounds?: DbValueBounds;
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
      callsite: options.captureCallsite
        ? captureDbCallsite(options.callsiteRoot)
        : undefined,
      now: options.now?.(),
      sessionStartedAt: options.sessionStartedAt,
      valueBounds: input.valueBounds,
      ...(op === "delete"
        ? { before: row }
        : { after: row, before: beforeByPk?.get(pkKey(pk)) }),
    });
    if (!emitDbEvent(options, event)) return;
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
    emitDbEvent(
      options,
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
  if (
    !emitDbEvent(
      options,
      buildDbDiffEvent({
        engine,
        op,
        table,
        pk: null,
        rowCount,
        requestId,
        sessionId: options.sessionId,
        redactColumns: options.redactColumns,
        callsite: options.captureCallsite
          ? captureDbCallsite(options.callsiteRoot)
          : undefined,
        now: options.now?.(),
        sessionStartedAt: options.sessionStartedAt,
      }),
    )
  ) {
    return;
  }

  const maxRows = normalizeMaxRowsPerStatement(options.maxRowsPerStatement);
  if (rowCount > maxRows) {
    emitDbEvent(
      options,
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
 * Records that a host statement was attempted and RAISED, captures its application callsite when
 * the stack provides one, then hands the error straight back.
 *
 * This is the engine-agnostic seam every adapter uses, and it exists because the capture
 * vocabulary could otherwise only describe statements that succeeded: the host `query` rejected,
 * the adapter's `await` rejected with it, and no event was emitted at all. In an incident whose
 * fault IS the failing statement, that dropped the single most decisive observable.
 *
 * Two guarantees, both load-bearing:
 *
 * 1. **It never changes host behavior.** Every failure inside emission is swallowed here — the
 *    caller's `catch` rethrows the driver's original error untouched either way. Instrumentation
 *    that masked an application error would be strictly worse than instrumentation that recorded
 *    nothing.
 * 2. **It is not a capture gap.** `capture_exception` means *our* code threw. This means *their*
 *    statement failed. Same shaped event, opposite owner, and a reader acts on them differently.
 */
export function emitDbErrorEvent(input: {
  engine: DbEngine;
  op: DbErrorOp;
  table: string | null;
  statement: string;
  requestId: string;
  error: unknown;
  options: InstrumentDbClientOptions;
}): void {
  const { options } = input;
  try {
    emitDbEvent(
      options,
      buildDbErrorEvent({
        engine: input.engine,
        op: input.op,
        table: input.table,
        statement: input.statement,
        error: input.error,
        requestId: input.requestId,
        callsite: errorCallsiteFor(
          options,
          input.requestId,
          normalizeStatementShape(input.statement),
          input.error,
        ),
        sessionId: options.sessionId,
        now: options.now?.(),
        sessionStartedAt: options.sessionStartedAt,
      }),
    );
  } catch {
    // Building or routing the record is capture work. It may never decide what the caller sees.
  }
}

/**
 * Records that a host statement was attempted and SUCCEEDED, and never changes what the caller
 * sees.
 *
 * The mirror of {@link emitDbErrorEvent}, and it closes the asymmetry that one left behind: the
 * capture vocabulary could say what a FAILING statement asked and could never say what a
 * SUCCEEDING one asked. Rows are not that answer — they are what the database held, not what was
 * requested of it — and a statement that returned no rows produced no evidence whatsoever.
 *
 * Deliberately NOT gated on `captureReads`, for the same reason the error seam is not: that flag
 * caps row IMAGES, and this record carries none. Gating it there would leave every default install
 * exactly as blind to a wrong predicate as it is today.
 *
 * Every failure inside emission is swallowed. Instrumentation may not decide whether the host's
 * statement succeeded.
 */
export function emitDbStatementEvent(input: {
  engine: DbEngine;
  op: DbStatementOp;
  table: string | null;
  statement: string;
  rowCount?: number | null;
  /** Per-request statement counter, owned by the adapter so execution order survives. */
  seq: number;
  requestId: string;
  options: InstrumentDbClientOptions;
}): void {
  const { options } = input;
  try {
    emitDbEvent(
      options,
      buildDbStatementEvent({
        engine: input.engine,
        op: input.op,
        table: input.table,
        statement: input.statement,
        rowCount: input.rowCount,
        seq: input.seq,
        requestId: input.requestId,
        sessionId: options.sessionId,
        now: options.now?.(),
        sessionStartedAt: options.sessionStartedAt,
      }),
    );
  } catch {
    // Building or routing the record is capture work. It may never decide what the caller sees.
  }
}

/**
 * Allocates the next 1-based statement ordinal for a request.
 *
 * Separate from the read ordinal (`db.read.stmt`), which counts only SELECTs whose rows were
 * captured. This one counts every instrumented statement, so a reader can order what the request
 * did — including the statements that returned nothing and so appear nowhere else.
 */
export function nextStatementSeq(
  statementsByRequest: Map<string, number>,
  requestId: string,
): number {
  const seq = (statementsByRequest.get(requestId) ?? 0) + 1;
  statementsByRequest.set(requestId, seq);
  return seq;
}

/**
 * Emits capped, redacted `db.read` events for a SELECT's rows plus a `db.read.bulk` summary when
 * more rows exist than were emitted. Honors both the per-statement cap and the per-request budget
 * tracked in `emittedReadRowsByRequest`. When opted in, one callsite is reused for each normalized
 * statement shape, with at most eight distinct shapes captured per request.
 */
export function emitDbReadEvents(input: {
  engine: DbEngine;
  table: string;
  requestId: string;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  options: InstrumentDbClientOptions;
  emittedReadRowsByRequest: Map<string, number>;
  /** Per-request callsite cache, keyed by normalized statement shape. */
  readCallsitesByRequest: ReadCallsitesByRequest;
  /**
   * Per-request SELECT counter, shared with the caller so every statement in a
   * request gets a distinct ordinal. Rows are emitted one event each, so this
   * is the only thing separating N single-row SELECTs from one N-row SELECT.
   */
  readStatementsByRequest?: Map<string, number>;
  /** Resolved LIMIT/OFFSET the statement ran with, when the adapter parsed one. */
  queryShape?: { limit?: number; offset?: number };
  /**
   * Raw statement text, normalized once here and carried on every row it produced.
   *
   * A row alone cannot distinguish "the database holds the wrong value" from "the predicate
   * selected the wrong row", and those two have different fixes. Normalized per statement rather
   * than per row so the cost is paid once.
   */
  statement?: string;
  valueBounds?: DbValueBounds;
}): void {
  const { engine, table, requestId, rows, rowCount, options } = input;
  let shape: string | undefined;
  try {
    shape = input.statement
      ? normalizeStatementShape(input.statement, DB_STATEMENT_SHAPE_LABEL) ||
        undefined
      : undefined;
  } catch {
    // Shaping is capture work; a row without a shape beats no row at all.
    shape = undefined;
  }
  const emittedReadRowsByRequest = input.emittedReadRowsByRequest;
  const readStatementsByRequest = input.readStatementsByRequest;
  let stmt: number | undefined;
  if (readStatementsByRequest) {
    stmt = (readStatementsByRequest.get(requestId) ?? 0) + 1;
    readStatementsByRequest.set(requestId, stmt);
  }
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
  const callsite =
    emitRows.length > 0
      ? readCallsiteFor(options, requestId, shape, input.readCallsitesByRequest)
      : undefined;

  for (const row of emitRows) {
    const pk = extractPk(row, table, options.pkColumns);
    const samplePk = redactPkSample(pk, sensitive);
    if (samplePks.length < 3 && samplePk) samplePks.push(samplePk);
    if (
      !emitDbEvent(
        options,
        buildDbReadEvent({
          engine,
          table,
          pk,
          row,
          requestId,
          ...(stmt !== undefined ? { stmt } : {}),
          ...(shape !== undefined ? { shape } : {}),
          queryShape: input.queryShape,
          callsite,
          sessionId: options.sessionId,
          redactColumns: options.redactColumns,
          now: options.now?.(),
          sessionStartedAt: options.sessionStartedAt,
          valueBounds: input.valueBounds,
        }),
      )
    ) {
      return;
    }
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
    emitDbEvent(
      options,
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
