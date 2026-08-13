import {
  DB_ERROR_EVENT_KIND,
  normalizeStatementShape,
  type BugEvent,
  type DbEngine,
  type DbErrorEventData,
  type DbErrorOp,
} from "crumbtrail-core";

export interface BuildDbErrorEventInput {
  engine: DbEngine;
  op: DbErrorOp;
  /** Table the statement addressed, or `null` when it did not parse to one. */
  table: string | null;
  /** Raw statement text. Normalized here; the raw form never leaves this function. */
  statement: string;
  /** The error the driver raised. Only its `code` and class name are read. */
  error: unknown;
  requestId: string;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}

const MAX_DB_ERROR_CODE_LENGTH = 64;
/**
 * A database error code is a closed vocabulary of short identifiers: `23505` (Postgres),
 * `ER_DUP_ENTRY` (MySQL), `SQLITE_CONSTRAINT` (SQLite), `EREQUEST` (mssql). Bounding the shape as
 * well as the length is what stops a driver that happens to put prose on `.code` from turning this
 * field into a message channel.
 */
const DB_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Reads the database's own error code and nothing else.
 *
 * There is deliberately NO fallback to `message`. A missing code is reported as `null`, because a
 * reader who is told "no code" is better served than one handed a driver's prose wearing a code's
 * name — and the prose is exactly what must not travel.
 */
export function captureDbErrorCode(error: unknown): string | null {
  if (error == null || typeof error !== "object") return null;
  const raw = (error as { code?: unknown }).code;
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" && Number.isFinite(raw)
        ? String(raw)
        : undefined;
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_DB_ERROR_CODE_LENGTH) return null;
  return DB_ERROR_CODE_PATTERN.test(trimmed) ? trimmed : null;
}

/** Returns only an error class name, never a message, stack, query, or bind value. */
export function captureDbErrorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  if (
    error != null &&
    typeof error === "object" &&
    typeof (error as { name?: unknown }).name === "string"
  ) {
    return ((error as { name: string }).name || "Error").slice(0, 120);
  }
  return typeof error === "string" ? "Error" : "UnknownError";
}

/**
 * Builds the canonical `db.error` event: a statement the host issued and the database refused.
 *
 * Nothing user-supplied reaches the payload. The statement is reduced to its shape, the error is
 * reduced to a code and a class name, and the bind values are never passed in.
 */
export function buildDbErrorEvent(input: BuildDbErrorEventInput): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();

  const d: DbErrorEventData = {
    engine: input.engine,
    op: input.op,
    table: input.table,
    shape: normalizeStatementShape(input.statement),
    code: captureDbErrorCode(input.error),
    errorName: captureDbErrorName(input.error),
    requestId: input.requestId,
    t: now,
  };

  const event: BugEvent = {
    t: now,
    k: DB_ERROR_EVENT_KIND,
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
