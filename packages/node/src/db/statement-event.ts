import {
  DB_STATEMENT_EVENT_KIND,
  normalizeStatementShape,
  type BugEvent,
  type DbEngine,
  type DbStatementEventData,
  type DbStatementOp,
} from "crumbtrail-core";

/** Redaction-metadata attribution for shapes taken off statements that SUCCEEDED. */
export const DB_STATEMENT_SHAPE_LABEL = "db.statement.shape";

export interface BuildDbStatementEventInput {
  engine: DbEngine;
  op: DbStatementOp;
  /** Table the statement addressed, or `null` when it did not parse to one. */
  table: string | null;
  /** Raw statement text. Normalized here; the raw form never leaves this function. */
  statement: string;
  /** Rows returned or affected, when the driver reported a count. */
  rowCount?: number | null;
  /** 1-based ordinal of this statement within its request. */
  seq: number;
  requestId: string;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}

/**
 * Builds the canonical `db.statement` event: a statement the host issued that the database
 * accepted.
 *
 * The mirror of `buildDbErrorEvent`, and it exists because the mirror was missing. A failing
 * statement could be described by what it ASKED; a succeeding one could only be described by what
 * it RETURNED, and a statement that returned nothing could not be described at all. So a wrong
 * predicate on a query that runs perfectly — the common case — left no readable trace.
 *
 * The privacy contract is identical and is not relaxed because the statement worked: the text is
 * reduced to its shape before it is stored, bind values are never passed in, and `rowCount` is a
 * count rather than a row. Row images stay on `db.read`, where the read caps and column redaction
 * that govern them live.
 */
export function buildDbStatementEvent(
  input: BuildDbStatementEventInput,
): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();

  const d: DbStatementEventData = {
    engine: input.engine,
    op: input.op,
    table: input.table,
    shape: normalizeStatementShape(input.statement, DB_STATEMENT_SHAPE_LABEL),
    rowCount:
      typeof input.rowCount === "number" && Number.isFinite(input.rowCount)
        ? Math.max(0, Math.round(input.rowCount))
        : null,
    seq: input.seq,
    requestId: input.requestId,
    t: now,
  };

  const event: BugEvent = {
    t: now,
    k: DB_STATEMENT_EVENT_KIND,
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
