import {
  mergeRedactionMetadata,
  redactNetworkTextBody,
  redactProbeStorageKey,
  type BugEvent,
  type PayloadSummary,
  type RedactionMetadata,
} from "crumbtrail-core";

export const CACHE_EVENT_KIND = "cache" as const;

export type CacheDriver = "ioredis" | "redis";

export interface CacheEventData {
  driver: CacheDriver;
  op: string;
  key: string | string[];
  requestId: string;
  hit?: boolean;
  ttlMs?: number;
  value?: unknown;
  valueSummary?: PayloadSummary;
  redaction?: RedactionMetadata;
}

export interface BuildCacheEventInput {
  driver: CacheDriver;
  op: string;
  keys: readonly unknown[];
  requestId: string;
  hit?: boolean;
  ttlMs?: number;
  value?: unknown;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}

const MAX_CACHE_VALUE_LENGTH = 8 * 1024;

export function buildCacheEvent(input: BuildCacheEventInput): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();
  const redactedKeys = input.keys.map((key, index) =>
    redactProbeStorageKey(String(key), `cache.key[${index}]`),
  );
  const redactedValue =
    input.value === undefined ? undefined : redactCacheValue(input.value);
  const d: CacheEventData = {
    driver: input.driver,
    op: input.op,
    key:
      redactedKeys.length === 1
        ? redactedKeys[0].value
        : redactedKeys.map((result) => result.value),
    requestId: input.requestId,
    ...(input.hit !== undefined ? { hit: input.hit } : {}),
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    ...(redactedValue?.value !== undefined
      ? { value: redactedValue.value }
      : {}),
    ...(redactedValue?.summary ? { valueSummary: redactedValue.summary } : {}),
  };
  const redaction = mergeRedactionMetadata(
    ...redactedKeys.map((result) => result.metadata),
    redactedValue?.metadata,
  );
  if (redaction) d.redaction = redaction;

  const event: BugEvent = {
    t: now,
    k: CACHE_EVENT_KIND,
    d: d as unknown as Record<string, unknown>,
  };
  if (input.sessionId) event.sessionId = input.sessionId;
  const startedAt = normalizeStartedAt(input.sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);
  return event;
}

function redactCacheValue(value: unknown): {
  value?: unknown;
  summary?: PayloadSummary;
  metadata?: RedactionMetadata;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify({ value });
  } catch {
    serialized = JSON.stringify({ value: String(value) });
  }
  const result = redactNetworkTextBody(serialized, {
    contentType: "application/json",
    maxLength: MAX_CACHE_VALUE_LENGTH,
    mode: "structured",
    path: "cache",
  });
  if (result.body === undefined) {
    return {
      ...(result.bodySummary ? { summary: result.bodySummary } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
  }
  try {
    const parsed = JSON.parse(result.body) as { value?: unknown };
    return {
      value: parsed.value,
      ...(result.bodySummary ? { summary: result.bodySummary } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
  } catch {
    return {
      ...(result.bodySummary ? { summary: result.bodySummary } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
  }
}

function normalizeStartedAt(startedAt: number | Date | undefined) {
  if (startedAt instanceof Date) {
    const time = startedAt.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return Number.isFinite(startedAt)
    ? Math.round(startedAt as number)
    : undefined;
}
