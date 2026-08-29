import {
  DB_ERROR_EVENT_KIND,
  normalizeStatementShape,
  type BugEvent,
  type DbEngine,
  type DbErrorCategory,
  type DbErrorEventData,
  type DbErrorOp,
} from "crumbtrail-core";
import type { DbCallsite } from "./callsite";

export interface BuildDbErrorEventInput {
  engine: DbEngine;
  op: DbErrorOp;
  /** Table the statement addressed, or `null` when it did not parse to one. */
  table: string | null;
  /** Raw statement text. Normalized here; the raw form never leaves this function. */
  statement: string;
  /** The error the driver raised. Only stable code fields and its class name are read. */
  error: unknown;
  requestId: string;
  /** Application callsite captured while the refused statement was being emitted. */
  callsite?: DbCallsite;
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
export function captureDbErrorCode(
  error: unknown,
  engine?: DbEngine,
): string | null {
  if (error == null || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const preferred =
    engine === "mysql"
      ? record.errno
      : engine === "sqlite"
        ? record.errcode
        : engine === "mssql"
          ? record.number
          : undefined;
  const raw = preferred ?? record.code;
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

function numericErrorField(error: unknown, field: string): number | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function stringErrorField(error: unknown, field: string): string | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value.trim().toUpperCase() : undefined;
}

/** Classifies a failed statement from stable driver codes without reading error prose. */
export function classifyDbError(
  engine: DbEngine,
  error: unknown,
): DbErrorCategory {
  const code = stringErrorField(error, "code");

  if (engine === "postgres") {
    if (code === "40P01") return "deadlock";
    if (code === "23505") return "unique_constraint";
    if (code === "23503") return "foreign_key_constraint";
    if (code === "23514") return "check_constraint";
    if (code === "40001") return "serialization_failure";
    if (
      code?.startsWith("08") ||
      code === "57P01" ||
      code === "57P02" ||
      code === "57P03"
    ) {
      return "connection_loss";
    }
    return "unknown";
  }

  if (engine === "mysql") {
    const errno = numericErrorField(error, "errno");
    const sqlState =
      stringErrorField(error, "sqlState") ??
      stringErrorField(error, "sqlstate");
    if (errno === 1213 || code === "ER_LOCK_DEADLOCK") return "deadlock";
    if (
      errno === 1062 ||
      errno === 1022 ||
      errno === 1169 ||
      code === "ER_DUP_ENTRY" ||
      code === "ER_DUP_KEY"
    ) {
      return "unique_constraint";
    }
    if (
      errno === 1216 ||
      errno === 1217 ||
      errno === 1451 ||
      errno === 1452 ||
      code === "ER_ROW_IS_REFERENCED" ||
      code === "ER_ROW_IS_REFERENCED_2" ||
      code === "ER_NO_REFERENCED_ROW" ||
      code === "ER_NO_REFERENCED_ROW_2"
    ) {
      return "foreign_key_constraint";
    }
    if (
      errno === 3819 ||
      errno === 4025 ||
      code === "ER_CHECK_CONSTRAINT_VIOLATED"
    ) {
      return "check_constraint";
    }
    if (sqlState === "40001") return "serialization_failure";
    if (
      errno === 2002 ||
      errno === 2003 ||
      errno === 2006 ||
      errno === 2013 ||
      errno === 2055 ||
      code === "PROTOCOL_CONNECTION_LOST" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EPIPE"
    ) {
      return "connection_loss";
    }
    return "unknown";
  }

  if (engine === "sqlite") {
    const resultCode = numericErrorField(error, "errcode");
    if (
      resultCode === 1555 ||
      resultCode === 2067 ||
      code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      return "unique_constraint";
    }
    if (resultCode === 787 || code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return "foreign_key_constraint";
    }
    if (resultCode === 275 || code === "SQLITE_CONSTRAINT_CHECK") {
      return "check_constraint";
    }
    if (code === "SQLITE_CONSTRAINT") return "constraint_violation";
    return "unknown";
  }

  const number = numericErrorField(error, "number");
  if (number === 1205) return "deadlock";
  if (number === 2601 || number === 2627) return "unique_constraint";
  // SQL Server number 547 covers both CHECK and FOREIGN KEY failures. The code
  // alone cannot distinguish them, so preserve that ambiguity without reading prose.
  if (number === 547) return "constraint_violation";
  if (
    number === 3960 ||
    number === 41302 ||
    number === 41305 ||
    number === 41325
  ) {
    return "serialization_failure";
  }
  if (
    number === 64 ||
    number === 233 ||
    number === 10053 ||
    number === 10054 ||
    number === 10060 ||
    code === "ECONNCLOSED" ||
    code === "ENOTOPEN" ||
    code === "ESOCKET"
  ) {
    return "connection_loss";
  }
  return "unknown";
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
    code: captureDbErrorCode(input.error, input.engine),
    category: classifyDbError(input.engine, input.error),
    errorName: captureDbErrorName(input.error),
    requestId: input.requestId,
    ...(input.callsite !== undefined ? { callsite: input.callsite } : {}),
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
