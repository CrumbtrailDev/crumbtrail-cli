import {
  DB_READ_BULK_EVENT_KIND,
  DB_READ_EVENT_KIND,
  mergeRedactionMetadata,
  type BugEvent,
  type DbEngine,
  type DbReadBulkEventData,
  type DbReadEventData,
} from "crumbtrail-core";
import { buildSensitiveColumnSet, redactColumns } from "./columns";
import { boundColumnRow } from "./diff-event";

export interface BuildDbReadEventInput {
  /** Engine that produced the read. Defaults to `"postgres"` for back-compat. */
  engine?: DbEngine;
  table: string;
  pk: Record<string, unknown> | null;
  row: Record<string, unknown>;
  requestId: string;
  sessionId?: string;
  redactColumns?: readonly string[];
  now?: number;
  sessionStartedAt?: number | Date;
}

export interface BuildDbReadBulkEventInput {
  /** Engine that produced the read. Defaults to `"postgres"` for back-compat. */
  engine?: DbEngine;
  table: string;
  requestId: string;
  rowCount: number;
  emittedRows: number;
  samplePks: Array<Record<string, unknown>>;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}

export function buildDbReadEvent(input: BuildDbReadEventInput): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();
  const sensitive = buildSensitiveColumnSet(input.redactColumns);
  const row = redactColumns(input.row, sensitive, "db.read.row");
  const pk = input.pk
    ? redactColumns(input.pk, sensitive, "db.read.pk")
    : { value: null as Record<string, unknown> | null, metadata: undefined };

  const boundedRow = boundColumnRow(row.value) ?? {};
  const boundedPk =
    boundColumnRow((pk.value as Record<string, unknown> | null) ?? undefined) ??
    null;

  const d: DbReadEventData = {
    engine: input.engine ?? "postgres",
    table: input.table,
    pk: boundedPk,
    row: boundedRow,
    requestId: input.requestId,
  };
  const redaction = mergeRedactionMetadata(row.metadata, pk.metadata);
  if (redaction) d.redaction = redaction;

  const event: BugEvent = {
    t: now,
    k: DB_READ_EVENT_KIND,
    d: d as unknown as Record<string, unknown>,
  };
  if (input.sessionId) event.sessionId = input.sessionId;

  const startedAt = normalizeStartedAt(input.sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);
  return event;
}

export function buildDbReadBulkEvent(
  input: BuildDbReadBulkEventInput,
): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();
  const d: DbReadBulkEventData = {
    engine: input.engine ?? "postgres",
    table: input.table,
    requestId: input.requestId,
    rowCount: input.rowCount,
    emittedRows: input.emittedRows,
    truncatedRows: Math.max(0, input.rowCount - input.emittedRows),
    samplePks: input.samplePks,
  };
  const event: BugEvent = {
    t: now,
    k: DB_READ_BULK_EVENT_KIND,
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
