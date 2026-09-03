import {
  DB_DIFF_EVENT_KIND,
  mergeRedactionMetadata,
  type BugEvent,
  type DbConnectionIdentity,
  type DbBeforeImageStatus,
  type DbDiffEventData,
  type DbDiffOp,
  type DbEngine,
} from "crumbtrail-core";
import type { DbCallsite } from "./callsite";
import { buildSensitiveColumnSet, redactColumns } from "./columns";
import {
  buildRaceEvidence,
  readOptimisticVersion,
  type RaceEvidenceOptions,
} from "../race-evidence";

export interface BuildDbDiffEventInput {
  /** Engine that produced the mutation. Defaults to `"postgres"` for back-compat. */
  engine?: DbEngine;
  connection?: DbConnectionIdentity;
  op: DbDiffOp;
  table: string;
  /** Primary-key column→value map, or `null` when it could not be resolved. */
  pk: Record<string, unknown> | null;
  /** Post-image of the affected row (insert/update). */
  after?: Record<string, unknown>;
  /** Pre-image of the affected row (deletes, or updates with before-capture enabled). */
  before?: Record<string, unknown>;
  /** Missing row images, with static reasons that cannot be confused with user data. */
  imageUnavailable?: Partial<Record<"before" | "after", string>>;
  /** Explicit completeness state when a full before-image could not be captured. */
  beforeImageStatus?: DbBeforeImageStatus;
  /** Set only on image-less statement-level fallback events (pk `null`, no after/before). */
  rowCount?: number;
  /** Correlation id; MUST equal the active request's traceId/requestId. */
  requestId: string;
  durationMs?: number;
  transactionId?: string;
  sessionId?: string;
  /** Extra sensitive column names to drop, on top of {@link DEFAULT_SENSITIVE_DB_COLUMNS}. */
  redactColumns?: readonly string[];
  /** Host application callsite that issued the write, when callsite capture is on. */
  callsite?: DbCallsite;
  now?: number;
  sessionStartedAt?: number | Date;
  /** Optional nested-value bounds applied after redaction. */
  valueBounds?: DbValueBounds;
  /** Explicit opt in configuration for bounded cross session race evidence. */
  raceEvidence?: RaceEvidenceOptions;
}

/**
 * Per-column-value size cap (8 KiB). Large TEXT/JSONB values are truncated with a clear marker so a
 * single oversized column can't bloat the `db.diff` event (and, transitively, the bundle). Bounding
 * happens AFTER redaction so secret detection still sees the full value first.
 */
export const MAX_DB_VALUE_LENGTH = 8 * 1024;

export interface DbValueBounds {
  /** Maximum nested object or array depth. The row itself is depth zero. */
  maxDepth?: number;
  /** Maximum keys or items retained from any one object or array. */
  maxContainerEntries?: number;
}

const DEPTH_TRUNCATION_MARKER = "…[truncated: maximum document depth]";
const SIZE_TRUNCATION_MARKER = "…[truncated: container size limit]";

function boundStringValue(value: string, max = MAX_DB_VALUE_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length} chars]`;
}

/** Recursively truncates oversized string values inside a column image (handles nested JSONB). */
export function boundColumnValue(
  value: unknown,
  bounds: DbValueBounds = {},
  depth = 0,
): unknown {
  if (typeof value === "string") return boundStringValue(value);
  const maxDepth = normalizeBound(bounds.maxDepth);
  const maxEntries = normalizeBound(bounds.maxContainerEntries);
  if ((Array.isArray(value) || isObject(value)) && depth >= maxDepth) {
    return DEPTH_TRUNCATION_MARKER;
  }
  if (Array.isArray(value)) {
    const retained = value
      .slice(0, maxEntries)
      .map((inner) => boundColumnValue(inner, bounds, depth + 1));
    if (value.length > retained.length) retained.push(SIZE_TRUNCATION_MARKER);
    return retained;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, inner] of entries.slice(0, maxEntries)) {
      out[key] = boundColumnValue(inner, bounds, depth + 1);
    }
    if (entries.length > maxEntries) {
      let markerKey = "__crumbtrail_truncated__";
      while (markerKey in out) markerKey += "_";
      out[markerKey] = SIZE_TRUNCATION_MARKER;
    }
    return out;
  }
  return value;
}

function normalizeBound(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value))
    return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function boundColumnRow(
  row: Record<string, unknown> | undefined,
  bounds?: DbValueBounds,
): Record<string, unknown> | undefined {
  return row
    ? (boundColumnValue(row, bounds) as Record<string, unknown>)
    : undefined;
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
  const boundedAfter = boundColumnRow(after.value, input.valueBounds);
  const boundedBefore = boundColumnRow(before.value, input.valueBounds);
  const boundedPk =
    boundColumnRow(
      (pk.value as Record<string, unknown> | null) ?? undefined,
      input.valueBounds,
    ) ?? null;

  const d: DbDiffEventData = {
    engine: input.engine ?? "postgres",
    ...(input.connection ? { connection: input.connection } : {}),
    op: input.op,
    table: input.table,
    pk: boundedPk,
    requestId: input.requestId,
    durationMs: normalizeDuration(input.durationMs),
    ...(input.transactionId ? { transactionId: input.transactionId } : {}),
    ...(boundedAfter !== undefined ? { after: boundedAfter } : {}),
    ...(boundedBefore !== undefined ? { before: boundedBefore } : {}),
    ...(input.imageUnavailable !== undefined
      ? { imageUnavailable: input.imageUnavailable }
      : {}),
    ...(input.beforeImageStatus !== undefined
      ? { beforeImageStatus: input.beforeImageStatus }
      : {}),
    ...(input.rowCount !== undefined ? { rowCount: input.rowCount } : {}),
    // Not redacted: a callsite is the host's own source path and line, which is
    // the one thing in the event that is definitionally not user data.
    ...(input.callsite !== undefined ? { callsite: input.callsite } : {}),
  };
  if (
    !input.transactionId &&
    input.pk !== null &&
    (input.rowCount === undefined || input.rowCount === 1)
  ) {
    const versionField = input.raceEvidence?.optimisticVersionField;
    const raceEvidence = buildRaceEvidence(input.raceEvidence, {
      surface: "db.diff",
      operation: input.op,
      table: input.table,
      primaryKey: input.pk,
      resourceSubject: input.raceEvidence?.resourceSubject,
      beforeVersion: readOptimisticVersion(input.before, versionField),
      afterVersion: readOptimisticVersion(input.after, versionField),
    });
    if (raceEvidence) d.raceEvidence = raceEvidence;
  }

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

function normalizeDuration(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value * 1000) / 1000)
    : 0;
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
