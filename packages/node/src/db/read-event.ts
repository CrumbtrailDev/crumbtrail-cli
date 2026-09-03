import {
  DB_READ_BULK_EVENT_KIND,
  DB_READ_EVENT_KIND,
  mergeRedactionMetadata,
  type BugEvent,
  type DbConnectionIdentity,
  type DbEngine,
  type DbReadBulkEventData,
  type DbReadEventData,
} from "crumbtrail-core";
import type { DbCallsite } from "./callsite";
import { buildSensitiveColumnSet, redactColumns } from "./columns";
import { boundColumnRow, type DbValueBounds } from "./diff-event";
import {
  buildRaceEvidence,
  readRaceServiceCompatibility,
  isRaceEvidenceInputEligible,
  readOptimisticVersion,
  type RaceEvidenceOptions,
} from "../race-evidence";

export interface BuildDbReadEventInput {
  /** Engine that produced the read. Defaults to `"postgres"` for back-compat. */
  engine?: DbEngine;
  connection?: DbConnectionIdentity;
  table: string;
  pk: Record<string, unknown> | null;
  row: Record<string, unknown>;
  requestId: string;
  durationMs?: number;
  transactionId?: string;
  /** Application callsite that issued the SELECT, when callsite capture is enabled. */
  callsite?: DbCallsite;
  /** 1-based ordinal of the SELECT within this request. */
  stmt?: number;
  /** Already-normalized shape of the SELECT that produced this row. Never raw statement text. */
  shape?: string;
  /** Resolved LIMIT/OFFSET the statement ran with, when the adapter parsed one. */
  queryShape?: { limit?: number; offset?: number };
  sessionId?: string;
  redactColumns?: readonly string[];
  now?: number;
  sessionStartedAt?: number | Date;
  /** Optional nested-value bounds applied after redaction. */
  valueBounds?: DbValueBounds;
  /** Explicit opt in configuration for bounded cross session race evidence. */
  raceEvidence?: RaceEvidenceOptions;
  /** Configured DB primary-key columns used to require a complete identity. */
  primaryKeyColumns?: readonly string[];
  /**
   * Capability asserted by a producer that observed this operation's
   * transaction outcome. Generic builders cannot infer this from `engine`:
   * PlanetScale uses the same `mysql` tag as transactional MySQL clients.
   */
  raceEvidenceCapability?: "transaction-outcome";
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
  const row = safeRedactColumns(input.row, sensitive, "db.read.row");
  const pk = input.pk
    ? safeRedactColumns(input.pk, sensitive, "db.read.pk")
    : { value: null as Record<string, unknown> | null, metadata: undefined };

  const boundedRow = boundColumnRow(row.value, input.valueBounds) ?? {};
  const boundedPk =
    boundColumnRow(
      (pk.value as Record<string, unknown> | null) ?? undefined,
      input.valueBounds,
    ) ?? null;

  const d: DbReadEventData = {
    engine: input.engine ?? "postgres",
    ...(input.connection ? { connection: input.connection } : {}),
    table: input.table,
    pk: boundedPk,
    row: boundedRow,
    requestId: input.requestId,
    durationMs: normalizeDuration(input.durationMs),
    ...(input.transactionId ? { transactionId: input.transactionId } : {}),
    ...(input.callsite !== undefined ? { callsite: input.callsite } : {}),
  };
  if (Number.isInteger(input.stmt) && (input.stmt as number) > 0)
    d.stmt = input.stmt;
  // Omitted rather than emitted empty: an empty shape is indistinguishable from an absent one to
  // a reader, and a key that is always present but sometimes meaningless reads as an answer.
  if (typeof input.shape === "string" && input.shape.length > 0)
    d.shape = input.shape;
  const shape = input.queryShape;
  if (shape && (shape.limit !== undefined || shape.offset !== undefined)) {
    d.q = {
      ...(Number.isInteger(shape.limit) ? { limit: shape.limit } : {}),
      ...(Number.isInteger(shape.offset) ? { offset: shape.offset } : {}),
    };
  }
  if (
    input.raceEvidenceCapability === "transaction-outcome" &&
    supportsGenericRaceEvidenceEngine(input.engine) &&
    !input.transactionId &&
    isRaceEvidenceInputEligible({
      surface: "db.read",
      operation: "read",
      table: input.table,
      primaryKey: input.pk,
      primaryKeyColumns: input.primaryKeyColumns,
    })
  ) {
    const versionField = input.raceEvidence?.optimisticVersionField;
    const raceEvidence = buildRaceEvidence(input.raceEvidence, {
      surface: "db.read",
      operation: "read",
      table: input.table,
      primaryKey: input.pk,
      primaryKeyColumns: input.primaryKeyColumns,
      resourceSubject: input.raceEvidence?.resourceSubject,
      currentVersion: readOptimisticVersion(input.row, versionField),
    });
    if (raceEvidence) {
      d.raceEvidence = raceEvidence;
      d.serviceCompatibility = readRaceServiceCompatibility(input.raceEvidence);
    }
  }
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

function supportsGenericRaceEvidenceEngine(
  engine: BuildDbReadEventInput["engine"],
): boolean {
  // Prisma and MongoDB adapters do not expose a transaction outcome at this
  // builder boundary. PlanetScale is intentionally represented as mysql, so a
  // producer must assert the outcome capability explicitly instead.
  return engine !== "prisma" && engine !== "mongodb";
}

function safeRedactColumns(
  row: Record<string, unknown> | undefined,
  sensitive: Set<string>,
  path: string,
): ReturnType<typeof redactColumns> {
  try {
    return redactColumns(row, sensitive, path);
  } catch {
    return { value: undefined };
  }
}

function normalizeDuration(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value * 1000) / 1000)
    : 0;
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
