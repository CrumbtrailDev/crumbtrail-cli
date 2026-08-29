import {
  DB_POOL_TIMEOUT_EVENT_KIND,
  DB_POOL_WAIT_EVENT_KIND,
  type BugEvent,
  type DbEngine,
  type DbPoolTimeoutEventData,
  type DbPoolWaitEventData,
} from "crumbtrail-core";
import { captureDbErrorCode, captureDbErrorName } from "./error-event";

interface BuildDbPoolEventInput {
  engine: DbEngine;
  waitMs: number;
  requestId: string;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}

function eventTime(now: number | undefined): number {
  return Number.isFinite(now) ? Math.round(now as number) : Date.now();
}

function waitDuration(waitMs: number): number {
  return Number.isFinite(waitMs) ? Math.max(0, Math.round(waitMs)) : 0;
}

function withEnvelope(event: BugEvent, input: BuildDbPoolEventInput): BugEvent {
  if (input.sessionId) event.sessionId = input.sessionId;
  const startedAt =
    input.sessionStartedAt instanceof Date
      ? input.sessionStartedAt.getTime()
      : input.sessionStartedAt;
  if (Number.isFinite(startedAt)) {
    event.offsetMs = Math.max(0, event.t - Math.round(startedAt as number));
  }
  return event;
}

export function buildDbPoolWaitEvent(input: BuildDbPoolEventInput): BugEvent {
  const now = eventTime(input.now);
  const d: DbPoolWaitEventData = {
    engine: input.engine,
    waitMs: waitDuration(input.waitMs),
    requestId: input.requestId,
    t: now,
  };
  return withEnvelope(
    {
      t: now,
      k: DB_POOL_WAIT_EVENT_KIND,
      d: d as unknown as Record<string, unknown>,
    },
    input,
  );
}

export function buildDbPoolTimeoutEvent(
  input: BuildDbPoolEventInput & { error: unknown },
): BugEvent {
  const now = eventTime(input.now);
  const d: DbPoolTimeoutEventData = {
    engine: input.engine,
    waitMs: waitDuration(input.waitMs),
    code: captureDbErrorCode(input.error, input.engine),
    errorName: captureDbErrorName(input.error),
    requestId: input.requestId,
    t: now,
  };
  return withEnvelope(
    {
      t: now,
      k: DB_POOL_TIMEOUT_EVENT_KIND,
      d: d as unknown as Record<string, unknown>,
    },
    input,
  );
}

/** True only for a driver code documented as a pool acquisition timeout. */
export function isPoolCheckoutTimeout(
  engine: DbEngine,
  error: unknown,
): boolean {
  if (engine !== "mssql" || error == null || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === "ETIMEOUT";
}
