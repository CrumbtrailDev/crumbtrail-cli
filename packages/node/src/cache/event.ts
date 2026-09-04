import {
  BACKEND_REDACTION_POLICY,
  redactNetworkTextBody,
  redactProbeStorageKey,
  type BugEvent,
  type PayloadSummary,
  type RedactionMetadata,
} from "crumbtrail-core";
import { backendRedactionMetadata } from "../redaction-plane";
import {
  buildRaceEvidence,
  readRaceServiceCompatibility,
  isRaceEligibleCacheOperation,
  type RaceEvidenceOptions,
  type SealedRaceEvidence,
} from "../race-evidence";

export const CACHE_EVENT_KIND = "cache" as const;

export type CacheDriver = "ioredis" | "redis";

export interface CacheEventData {
  serviceCompatibility?: "compatible" | "incompatible" | "unknown";
  driver: CacheDriver;
  op: string;
  key: string | string[];
  requestId: string;
  /** Present on rejected commands so readers can distinguish a failed cache call from a miss. */
  outcome?: "success" | "failure" | "aborted";
  hit?: boolean;
  ttlMs?: number;
  value?: unknown;
  valueSummary?: PayloadSummary;
  /** Error class and bounded, redacted message for a rejected cache command. */
  errorName?: string;
  error?: string;
  /** Bounded command summary for a Redis pipeline or transaction. */
  summary?: CacheOperationSummary;
  raceEvidence?: SealedRaceEvidence;
  redaction?: RedactionMetadata;
}

export interface CacheOperationSummary {
  operationCount: number;
  operations: string[];
  /** Number of per-command ioredis tuple failures, capped before emission. */
  failureCount?: number;
  /** Whether the failure count reached its reporting cap. */
  failureCountTruncated?: boolean;
  truncated?: boolean;
}

export interface BuildCacheEventInput {
  driver: CacheDriver;
  op: string;
  keys: readonly unknown[];
  requestId: string;
  hit?: boolean;
  ttlMs?: number;
  value?: unknown;
  outcome?: "success" | "failure" | "aborted";
  error?: unknown;
  summary?: CacheOperationSummary;
  raceEvidence?: RaceEvidenceOptions;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}

const MAX_CACHE_VALUE_LENGTH = 8 * 1024;
const MAX_CACHE_ERROR_LENGTH = 512;
const MAX_SUMMARY_OPERATIONS = 50;
const MAX_SUMMARY_OPERATION_LENGTH = 64;
const MAX_SUMMARY_FAILURES = 100;

export function buildCacheEvent(input: BuildCacheEventInput): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();
  const redactedKeys = input.keys.map((key, index) =>
    redactProbeStorageKey(String(key), `cache.key[${index}]`),
  );
  const redactedValue =
    input.value === undefined ? undefined : redactCacheValue(input.value);
  const redaction = backendRedactionMetadata(
    ...redactedKeys.map((result) => result.metadata),
    redactedValue?.metadata,
  );
  const d: CacheEventData = {
    driver: input.driver,
    op: input.op,
    key:
      redactedKeys.length === 1
        ? redactedKeys[0].value
        : redactedKeys.map((result) => result.value),
    requestId: input.requestId,
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.hit !== undefined ? { hit: input.hit } : {}),
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    ...(redactedValue?.value !== undefined
      ? { value: redactedValue.value }
      : {}),
    ...(redactedValue?.summary ? { valueSummary: redactedValue.summary } : {}),
  };
  if (input.summary) d.summary = normalizeSummary(input.summary);
  if (input.error !== undefined) {
    const error = redactCacheError(input.error);
    d.errorName = error.name;
    if (error.message !== undefined) d.error = error.message;
    if (error.metadata) {
      d.redaction = backendRedactionMetadata(
        ...(redaction ? [redaction] : []),
        error.metadata,
      );
    }
  }
  if (redaction && !d.redaction) d.redaction = redaction;
  if (input.keys.length === 1 && isRaceEligibleCacheOperation(input.op)) {
    const raceEvidence = buildRaceEvidence(input.raceEvidence, {
      surface: "cache",
      operation: input.op,
      cacheKey: input.keys[0],
    });
    if (raceEvidence) {
      d.raceEvidence = raceEvidence;
      d.serviceCompatibility = readRaceServiceCompatibility(input.raceEvidence);
    }
  }

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

function normalizeSummary(
  summary: CacheOperationSummary,
): CacheOperationSummary {
  const operations = summary.operations
    .slice(0, MAX_SUMMARY_OPERATIONS)
    .map((operation) =>
      String(operation).slice(0, MAX_SUMMARY_OPERATION_LENGTH),
    );
  return {
    operationCount: Number.isFinite(summary.operationCount)
      ? Math.max(0, Math.trunc(summary.operationCount))
      : operations.length,
    operations,
    ...(typeof summary.failureCount === "number" &&
    Number.isFinite(summary.failureCount) &&
    summary.failureCount > 0
      ? {
          failureCount: Math.min(
            MAX_SUMMARY_FAILURES,
            Math.trunc(summary.failureCount),
          ),
        }
      : {}),
    ...(summary.failureCountTruncated ? { failureCountTruncated: true } : {}),
    ...(summary.truncated || operations.length < summary.operationCount
      ? { truncated: true }
      : {}),
  };
}

function redactCacheError(error: unknown): {
  name: string;
  message?: string;
  metadata?: RedactionMetadata;
} {
  const name = captureCacheErrorName(error);
  let message: string | undefined;
  try {
    if (error instanceof Error) message = error.message;
    else if (typeof error === "string") message = error;
    else if (error && typeof error === "object") {
      const candidate = (error as Record<string, unknown>).message;
      if (typeof candidate === "string") message = candidate;
    }
  } catch {
    message = undefined;
  }
  if (!message) return { name };
  const result = redactNetworkTextBody(message, {
    contentType: "text/plain",
    maxLength: MAX_CACHE_ERROR_LENGTH,
    path: "cache.error",
  });
  return {
    name,
    ...(result.body !== undefined ? { message: result.body } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

function captureCacheErrorName(error: unknown): string {
  try {
    if (error instanceof Error && error.name) return error.name.slice(0, 120);
    if (
      error &&
      typeof error === "object" &&
      typeof (error as Record<string, unknown>).name === "string"
    ) {
      return (
        ((error as Record<string, unknown>).name as string) || "Error"
      ).slice(0, 120);
    }
  } catch {
    // Error inspection must never affect the host rejection.
  }
  return typeof error === "string" ? "Error" : "UnknownError";
}

function redactCacheValue(value: unknown): {
  value?: unknown;
  summary?: PayloadSummary;
  metadata?: RedactionMetadata;
} {
  if (containsBinary(value)) {
    const summary: PayloadSummary = {
      kind: "binary",
      action: "summarized",
      reason: "binary_cache_value",
      originalLength: binaryLength(value),
    };
    return {
      summary,
      metadata: {
        policy: BACKEND_REDACTION_POLICY,
        fields: [
          {
            path: "cache",
            reason: "binary_cache_value",
            action: "summarized",
          },
        ],
        summaries: [summary],
      },
    };
  }
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

const MAX_BINARY_SCAN_DEPTH = 32;
const MAX_BINARY_SCAN_ENTRIES = 256;

/** Returns true for byte containers, including Buffer and nested byte values. */
function containsBinary(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  scanned = { count: 0 },
): boolean {
  if (binaryLength(value) !== undefined) return true;
  if (value === null || typeof value !== "object") return false;
  if (depth >= MAX_BINARY_SCAN_DEPTH) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  let entries: unknown[];
  try {
    entries = Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>);
  } catch {
    return true;
  }
  if (scanned.count + entries.length > MAX_BINARY_SCAN_ENTRIES) return true;
  scanned.count += entries.length;
  return entries.some((entry) =>
    containsBinary(entry, seen, depth + 1, scanned),
  );
}

function binaryLength(value: unknown): number | undefined {
  try {
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
  } catch {
    return undefined;
  }
  return undefined;
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
