import {
  formatTraceparent,
  generateSpanId,
  parseTraceparent,
} from "crumbtrail-core";
import {
  getBackendRequestContext,
  runInBackendRequestContext,
  type BackendRequestContext,
} from "./request-context";

export const CRUMBTRAIL_CONTEXT_TOKEN_VERSION = 1 as const;
export const DEFAULT_CONTEXT_TOKEN_TTL_MS = 15 * 60_000;
export const MAX_CONTEXT_TOKEN_TRACESTATE_LENGTH = 512;
export const MAX_CONTEXT_TOKEN_ID_LENGTH = 128;

/** A bounded, versioned carrier for causally related work. */
export interface CrumbtrailContextToken {
  readonly v: typeof CRUMBTRAIL_CONTEXT_TOKEN_VERSION;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly enqueuedAt?: number;
  readonly expiresAt?: number;
}

export interface CaptureTokenOptions {
  /** Absolute expiry. Defaults to a bounded fifteen minute lifetime. */
  expiresAt?: number;
  /** Convenience form for an expiry relative to the capture timestamp. */
  ttlMs?: number;
  /** Test and host clock seam. Defaults to `Date.now()`. */
  now?: number | (() => number);
}

export interface WithCausalContextOptions {
  /** Test and host clock seam used for expiry checks. */
  now?: number | (() => number);
}

export type CrumbtrailContextCarrier = CrumbtrailContextToken;

const TOKEN_KEYS = new Set([
  "v",
  "sessionId",
  "requestId",
  "traceparent",
  "tracestate",
  "enqueuedAt",
  "expiresAt",
]);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRACE_STATE_KEY_RE =
  /^(?:[a-z][a-z0-9_-]{0,255}|[a-z0-9][a-z0-9_-]{0,240}@[a-z][a-z0-9_-]{0,13})$/;
const TRACE_STATE_VALUE_RE = /^[\x20-\x2b\x2d-\x7e]*$/;

/**
 * Validate and normalize a token received from a queue, worker, or carrier.
 * Unknown fields, malformed W3C ids, all-zero ids, and expired tokens fail
 * closed. The returned object is a fresh frozen value.
 */
export function validateCrumbtrailContextToken(
  value: unknown,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !TOKEN_KEYS.has(key))) return undefined;
  if (value.v !== CRUMBTRAIL_CONTEXT_TOKEN_VERSION) return undefined;

  const traceparent = stringField(value.traceparent);
  if (!traceparent || !parseTraceparent(traceparent)) return undefined;

  const sessionId = optionalId(value.sessionId);
  const requestId = optionalId(value.requestId);
  if (value.sessionId !== undefined && !sessionId) return undefined;
  if (value.requestId !== undefined && !requestId) return undefined;

  const tracestate = optionalTraceState(value.tracestate);
  if (value.tracestate !== undefined && !tracestate) return undefined;

  const enqueuedAt = optionalTimestamp(value.enqueuedAt);
  const expiresAt = optionalTimestamp(value.expiresAt);
  if (value.enqueuedAt !== undefined && enqueuedAt === undefined)
    return undefined;
  if (value.expiresAt !== undefined && expiresAt === undefined)
    return undefined;
  if (
    enqueuedAt !== undefined &&
    expiresAt !== undefined &&
    expiresAt < enqueuedAt
  )
    return undefined;
  if (expiresAt !== undefined && readNow(now) >= expiresAt) return undefined;

  return Object.freeze({
    v: CRUMBTRAIL_CONTEXT_TOKEN_VERSION,
    traceparent,
    ...(sessionId ? { sessionId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(tracestate ? { tracestate } : {}),
    ...(enqueuedAt !== undefined ? { enqueuedAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

/** Alias for callers that prefer a boolean predicate. */
export function isCrumbtrailContextToken(
  value: unknown,
): value is CrumbtrailContextToken {
  return validateCrumbtrailContextToken(value) !== undefined;
}

/**
 * Capture the current request or causal context as a bounded token. Outside an
 * ALS context there is no claim to propagate, so this returns `undefined`.
 */
export function captureToken(
  options: CaptureTokenOptions = {},
): CrumbtrailContextToken | undefined {
  const context = getBackendRequestContext();
  if (!context?.traceparent) return undefined;
  const parent = parseTraceparent(context.traceparent);
  if (!parent) return undefined;
  const enqueuedAt = readNow(options.now ?? Date.now);
  const expiresAt = resolveExpiry(options, enqueuedAt);
  if (
    (options.expiresAt !== undefined || options.ttlMs !== undefined) &&
    expiresAt === undefined
  )
    return undefined;
  if (expiresAt !== undefined && expiresAt <= enqueuedAt) return undefined;
  return validateCrumbtrailContextToken(
    {
      v: CRUMBTRAIL_CONTEXT_TOKEN_VERSION,
      traceparent: context.traceparent,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.tracestate ? { tracestate: context.tracestate } : {}),
      enqueuedAt,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    enqueuedAt,
  );
}

/**
 * Run work with a child W3C span while preserving business return and error
 * semantics. Invalid or expired carriers reject before user code runs.
 */
export async function withCausalContext<T>(
  token: CrumbtrailContextToken,
  fn: () => T | Promise<T>,
  options: WithCausalContextOptions = {},
): Promise<T> {
  const validated = validateCrumbtrailContextToken(
    token,
    options.now ?? Date.now,
  );
  if (!validated)
    throw new TypeError("Invalid or expired Crumbtrail context token");
  const parent = parseTraceparent(validated.traceparent);
  if (!parent) throw new TypeError("Invalid Crumbtrail traceparent");

  const context: BackendRequestContext = {
    ...(validated.sessionId ? { sessionId: validated.sessionId } : {}),
    ...(validated.requestId
      ? { requestId: validated.requestId }
      : { requestId: parent.traceId }),
    traceparent: formatTraceparent({
      traceId: parent.traceId,
      spanId: generateSpanId(),
      flags: parent.flags,
    }),
    ...(validated.tracestate ? { tracestate: validated.tracestate } : {}),
    sessionIdSource: validated.sessionId ? "context" : undefined,
  };
  return await runInBackendRequestContext(context, fn);
}

/** Extract a token from a namespaced carrier without trusting extra fields. */
export function extractCrumbtrailContext(
  carrier: unknown,
): CrumbtrailContextToken | undefined {
  const value =
    isRecord(carrier) && "__crumbtrail" in carrier
      ? carrier.__crumbtrail
      : carrier;
  return validateCrumbtrailContextToken(value);
}

/** Put a token into a namespaced mutable carrier. */
export function injectCrumbtrailContext(
  carrier: Record<string, unknown>,
  token: CrumbtrailContextToken,
): Record<string, unknown> {
  const validated = validateCrumbtrailContextToken(token);
  if (!validated)
    throw new TypeError("Invalid or expired Crumbtrail context token");
  carrier.__crumbtrail = validated;
  return carrier;
}

function resolveExpiry(
  options: CaptureTokenOptions,
  now: number,
): number | undefined {
  if (options.expiresAt !== undefined)
    return normalizeTimestamp(options.expiresAt);
  if (options.ttlMs !== undefined) {
    const ttl = finiteInteger(options.ttlMs);
    return ttl === undefined ? undefined : now + Math.max(0, ttl);
  }
  return now + DEFAULT_CONTEXT_TOKEN_TTL_MS;
}

function optionalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!SAFE_ID_RE.test(trimmed) || /^0+$/.test(trimmed)) return undefined;
  return trimmed;
}

function optionalTraceState(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CONTEXT_TOKEN_TRACESTATE_LENGTH)
    return undefined;
  const members = trimmed.split(",");
  const keys = new Set<string>();
  if (
    members.some((member) => {
      const parts = member.trim().split("=");
      const [key, val] = parts;
      if (keys.has(key)) return true;
      keys.add(key);
      return (
        parts.length !== 2 ||
        !TRACE_STATE_KEY_RE.test(key) ||
        !val ||
        val.length > 256 ||
        !TRACE_STATE_VALUE_RE.test(val)
      );
    })
  )
    return undefined;
  return trimmed;
}

function optionalTimestamp(value: unknown): number | undefined {
  return value === undefined ? undefined : normalizeTimestamp(value);
}

function normalizeTimestamp(value: unknown): number | undefined {
  const number = finiteInteger(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNow(now: number | (() => number)): number {
  try {
    const value = typeof now === "function" ? now() : now;
    return Number.isFinite(value) ? Math.round(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
