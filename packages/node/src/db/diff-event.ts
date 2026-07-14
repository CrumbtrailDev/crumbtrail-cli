import {
  DB_DIFF_EVENT_KIND,
  mergeRedactionMetadata,
  type BugEvent,
  type DbDiffEventData,
  type DbDiffOp,
  type DbEngine,
} from "crumbtrail-core";
import { buildSensitiveColumnSet, redactColumns } from "./columns";

export interface BuildDbDiffEventInput {
  /** Engine that produced the mutation. Defaults to `"postgres"` for back-compat. */
  engine?: DbEngine;
  op: DbDiffOp;
  table: string;
  /** Primary-key column→value map, or `null` when it could not be resolved. */
  pk: Record<string, unknown> | null;
  /** Post-image of the affected row (insert/update). */
  after?: Record<string, unknown>;
  /** Pre-image of the affected row (deletes, or updates with before-capture enabled). */
  before?: Record<string, unknown>;
  /** Set only on image-less statement-level fallback events (pk `null`, no after/before). */
  rowCount?: number;
  /** Correlation id; MUST equal the active request's traceId/requestId. */
  requestId: string;
  sessionId?: string;
  /** Extra sensitive column names to drop, on top of {@link DEFAULT_SENSITIVE_DB_COLUMNS}. */
  redactColumns?: readonly string[];
  now?: number;
  sessionStartedAt?: number | Date;
}

/**
 * Per-column-value size cap (8 KiB). Large TEXT/JSONB values are truncated with a clear marker so a
 * single oversized column can't bloat the `db.diff` event (and, transitively, the bundle). Bounding
 * happens AFTER redaction so secret detection still sees the full value first.
 */
export const MAX_DB_VALUE_LENGTH = 8 * 1024;

function boundStringValue(value: string, max = MAX_DB_VALUE_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length} chars]`;
}

/** Recursively truncates oversized string values inside a column image (handles nested JSONB). */
export function boundColumnValue(value: unknown): unknown {
  if (typeof value === "string") return boundStringValue(value);
  if (Array.isArray(value)) return value.map(boundColumnValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = boundColumnValue(inner);
    }
    return out;
  }
  return value;
}

export function boundColumnRow(
  row: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return row ? (boundColumnValue(row) as Record<string, unknown>) : undefined;
}

/**
 * Builds the canonical `k:'db.diff'` event for one changed row. Sensitive columns are dropped from
 * `after`/`before`/`pk` via the shared redaction policy BEFORE the event is returned, so secret
 * values never rest in the event. The event carries `requestId` so it lands in the same evidence
 * window as the `backend.req.*` and front-end network events of the request that caused the write.
 */
export function buildDbDiffEvent(input: BuildDbDiffEventInput): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();
  const sensitive = buildSensitiveColumnSet(input.redactColumns);

  const after = redactColumns(input.after, sensitive, "db.diff.after");
  const before = redactColumns(input.before, sensitive, "db.diff.before");
  const pk = input.pk
    ? redactColumns(input.pk, sensitive, "db.diff.pk")
    : { value: null as Record<string, unknown> | null, metadata: undefined };

  // Bound oversized column values AFTER redaction so a huge TEXT/JSONB cell can't rest in full.
  const boundedAfter = boundColumnRow(after.value);
  const boundedBefore = boundColumnRow(before.value);
  const boundedPk =
    boundColumnRow((pk.value as Record<string, unknown> | null) ?? undefined) ??
    null;

  const d: DbDiffEventData = {
    engine: input.engine ?? "postgres",
    op: input.op,
    table: input.table,
    pk: boundedPk,
    requestId: input.requestId,
    ...(boundedAfter !== undefined ? { after: boundedAfter } : {}),
    ...(boundedBefore !== undefined ? { before: boundedBefore } : {}),
    ...(input.rowCount !== undefined ? { rowCount: input.rowCount } : {}),
  };

  const redaction = mergeRedactionMetadata(
    after.metadata,
    before.metadata,
    pk.metadata,
  );
  if (redaction) d.redaction = redaction;

  const event: BugEvent = {
    t: now,
    k: DB_DIFF_EVENT_KIND,
    d: d as unknown as Record<string, unknown>,
  };
  if (input.sessionId) event.sessionId = input.sessionId;

  const startedAt = normalizeStartedAt(input.sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);

  return event;
}

function normalizeStartedAt(
  startedAt: BuildDbDiffEventInput["sessionStartedAt"],
): number | undefined {
  if (startedAt instanceof Date) {
    const time = startedAt.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return Number.isFinite(startedAt)
    ? Math.round(startedAt as number)
    : undefined;
}
