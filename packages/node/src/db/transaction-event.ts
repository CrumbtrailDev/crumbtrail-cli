import {
  DB_TRANSACTION_EVENT_KIND,
  type BugEvent,
  type DbConnectionIdentity,
  type DbEngine,
  type DbTransactionEventData,
  type DbTransactionOutcome,
} from "crumbtrail-core";

export function buildDbTransactionEvent(input: {
  engine: DbEngine;
  transactionId: string;
  outcome: DbTransactionOutcome;
  requestId?: string;
  connection?: DbConnectionIdentity;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();
  const d: DbTransactionEventData = {
    engine: input.engine,
    transactionId: input.transactionId,
    outcome: input.outcome,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.connection ? { connection: input.connection } : {}),
  };
  const event: BugEvent = {
    t: now,
    k: DB_TRANSACTION_EVENT_KIND,
    d: d as unknown as Record<string, unknown>,
  };
  if (input.sessionId) event.sessionId = input.sessionId;
  const startedAt = normalizeStartedAt(input.sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);
  return event;
}

function normalizeStartedAt(
  value: number | Date | undefined,
): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return Number.isFinite(value) ? Math.round(value as number) : undefined;
}
