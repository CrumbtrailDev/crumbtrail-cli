export const CRUMBTRAIL_SESSION_HEADER = "X-Crumbtrail-Session-Id" as const;
export const CRUMBTRAIL_REQUEST_HEADER = "X-Crumbtrail-Request-Id" as const;

export const CRUMBTRAIL_SESSION_HEADER_LOWER =
  CRUMBTRAIL_SESSION_HEADER.toLowerCase();
export const CRUMBTRAIL_REQUEST_HEADER_LOWER =
  CRUMBTRAIL_REQUEST_HEADER.toLowerCase();

const REQUEST_ID_PREFIX = "req";
const REQUEST_ID_RANDOM_LENGTH = 12;
export const CRUMBTRAIL_REQUEST_ID_MAX_LENGTH = 64;

function randomBase36(length: number): string {
  let value = "";
  while (value.length < length) {
    value += Math.random().toString(36).slice(2);
  }
  return value.slice(0, length);
}

export function generateRequestId(): string {
  return `${REQUEST_ID_PREFIX}_${Date.now().toString(36)}_${randomBase36(REQUEST_ID_RANDOM_LENGTH)}`.slice(
    0,
    CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  );
}

function normalizeRequestId(requestId: string | undefined): string {
  if (requestId && requestId.length <= CRUMBTRAIL_REQUEST_ID_MAX_LENGTH)
    return requestId;
  return generateRequestId();
}

export function createCrumbtrailRequestHeaders(
  sessionId: string,
  requestId?: string,
): Record<
  typeof CRUMBTRAIL_SESSION_HEADER | typeof CRUMBTRAIL_REQUEST_HEADER,
  string
> {
  return {
    [CRUMBTRAIL_SESSION_HEADER]: sessionId,
    [CRUMBTRAIL_REQUEST_HEADER]: normalizeRequestId(requestId),
  };
}

export const W3C_TRACEPARENT_HEADER = "traceparent" as const;

export interface W3CTraceContext {
  traceId: string;
  spanId: string;
  flags: number;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const FLAGS_RE = /^[0-9a-f]{2}$/;

export function parseTraceparent(
  value: string | undefined,
): W3CTraceContext | undefined {
  if (!value) return undefined;
  const parts = value.trim().split("-");
  if (parts.length !== 4) return undefined;
  const [version, traceId, spanId, flags] = parts;
  if (version !== "00") return undefined;
  if (!TRACE_ID_RE.test(traceId) || traceId === "0".repeat(32))
    return undefined;
  if (!SPAN_ID_RE.test(spanId) || spanId === "0".repeat(16)) return undefined;
  if (!FLAGS_RE.test(flags)) return undefined;
  return { traceId, spanId, flags: Number.parseInt(flags, 16) };
}

export function formatTraceparent(ctx: W3CTraceContext): string {
  const flags = (ctx.flags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/* ------------------------------------------------------------------ */
/* W3C trace-context generation + outbound correlation resolution      */
/* ------------------------------------------------------------------ */

const TRACE_FLAG_SAMPLED = 0x01;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const c = (
    globalThis as {
      crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(buf);
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < bytes; i++) out += buf[i].toString(16).padStart(2, "0");
  return out;
}

/** 16-byte (32 hex) W3C trace id; never all-zero. */
export function generateTraceId(): string {
  let id = randomHex(16);
  if (id === "0".repeat(32)) id = id.slice(0, 31) + "1";
  return id;
}

/** 8-byte (16 hex) W3C span id; never all-zero. */
export function generateSpanId(): string {
  let id = randomHex(8);
  if (id === "0".repeat(16)) id = id.slice(0, 15) + "1";
  return id;
}

/** Fresh, sampled W3C trace context the browser controls. */
export function generateTraceContext(): W3CTraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    flags: TRACE_FLAG_SAMPLED,
  };
}

export interface OutboundCorrelation {
  sessionId: string;
  /** Unified correlation key. Equals `traceId` unless the caller pinned a request id. */
  requestId: string;
  traceId: string;
  spanId: string;
  /** Spec-valid `traceparent` value to emit on the outbound request. */
  traceparent: string;
}

function runtimeOrigin(): string | undefined {
  try {
    const origin = (globalThis as { location?: { origin?: string } }).location
      ?.origin;
    if (!origin || origin === "null") return undefined;
    return origin;
  } catch {
    return undefined;
  }
}

function urlOrigin(value: string, baseOrigin?: string): string | undefined {
  try {
    return new URL(value, baseOrigin).origin;
  } catch {
    return undefined;
  }
}

function normalizeAllowedOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "self") return runtimeOrigin();
  return urlOrigin(trimmed);
}

/**
 * Decides whether Crumbtrail may stamp outbound correlation headers.
 *
 * Same-origin requests are allowed automatically. Cross-origin requests must match an
 * explicit backend-origin allowlist so the default does not trigger CORS preflights or
 * leak trace context to third-party services.
 */
export function canInjectCorrelationHeaders(
  requestUrl: string,
  allowedOrigins: readonly string[] = [],
): boolean {
  const currentOrigin = runtimeOrigin();
  const requestOrigin = urlOrigin(requestUrl, currentOrigin);
  if (!requestOrigin) return false;
  if (currentOrigin && requestOrigin === currentOrigin) return true;

  return allowedOrigins.some(
    (origin) => normalizeAllowedOrigin(origin) === requestOrigin,
  );
}

/**
 * Resolves the correlation identity for one outbound request.
 *
 * - If the caller already set a valid `traceparent` (an app doing W3C propagation),
 *   we adopt its trace context so we join on the user's existing trace.
 * - Otherwise we mint a fresh sampled trace context.
 *
 * The trace id doubles as the Crumbtrail request id (`X-Crumbtrail-Request-Id`), so the
 * native Express path and the OTLP `traceId → requestId` bridge join on one shared key.
 * An explicit caller-provided request id is honored as-is for backwards compatibility.
 */
export function resolveOutboundCorrelation(input: {
  sessionId: string;
  existingRequestId?: string;
  existingTraceparent?: string;
}): OutboundCorrelation {
  const existing = parseTraceparent(input.existingTraceparent);
  const ctx = existing ?? generateTraceContext();
  const requestId = normalizeRequestId(input.existingRequestId ?? ctx.traceId);
  return {
    sessionId: input.sessionId,
    requestId,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceparent: formatTraceparent(ctx),
  };
}
