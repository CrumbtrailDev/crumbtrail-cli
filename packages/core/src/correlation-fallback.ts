import {
  CRUMBTRAIL_REQUEST_HEADER_LOWER,
  CRUMBTRAIL_SESSION_HEADER_LOWER,
  W3C_TRACEPARENT_HEADER,
  correlationOriginOf,
  markCorrelationOriginHeaderRejected,
} from "./correlation";

/* ------------------------------------------------------------------ */
/* CORS preflight rejection: detection and graceful degradation        */
/* ------------------------------------------------------------------ */

/**
 * The failure this module exists for.
 *
 * A customer follows the snippet comment, adds their backend origin to
 * `networkCorrelationAllowedOrigins`, and their app stops working. The browser
 * now sends `x-crumbtrail-session-id`, `x-crumbtrail-request-id` and
 * `traceparent` cross-origin, which makes every such request preflighted. A
 * backend with `cors({ allowedHeaders: ["Content-Type", "Authorization"] })`
 * answers the preflight without those names, so the browser blocks the real
 * request:
 *
 *   Request header field traceparent is not allowed by
 *   Access-Control-Allow-Headers in preflight response.
 *
 * From the page there is no response and no status — `fetch` rejects with a
 * `TypeError`, XHR fires `error` with status 0 — which is indistinguishable
 * from the server being down. So we do not guess: we retry the request once
 * without our headers and let the outcome decide. Succeeding without them and
 * failing with them is the signature of a header rejection, and only then do we
 * stop stamping the origin and tell the developer what to change.
 *
 * Turning on correlation must never be able to take an application down.
 */

export const CORRELATION_HEADER_NAMES = [
  CRUMBTRAIL_SESSION_HEADER_LOWER,
  CRUMBTRAIL_REQUEST_HEADER_LOWER,
  W3C_TRACEPARENT_HEADER,
] as const;

/**
 * How many times one origin may be probed before we give up probing it.
 *
 * A probe costs a duplicate request. When the real cause is an outage rather
 * than a header rejection every probe fails and doubles the app's traffic, so
 * after a few failures we stop probing that origin and let its requests fail
 * exactly as they would have.
 */
const MAX_PROBES_PER_ORIGIN = 3;

const probeCounts = new Map<string, number>();

export function canProbeOrigin(origin: string): boolean {
  return (probeCounts.get(origin) ?? 0) < MAX_PROBES_PER_ORIGIN;
}

export function recordProbeAttempt(origin: string): void {
  probeCounts.set(origin, (probeCounts.get(origin) ?? 0) + 1);
}

export function __resetCorrelationFallbackForTests(): void {
  probeCounts.clear();
}

/* ------------------------------------------------------------------ */
/* Body replay safety                                                  */
/* ------------------------------------------------------------------ */

/**
 * Whether this request body may be sent a second time.
 *
 * Everything the platform models as a *value* — text, search params, bytes, a
 * blob, a form — can be extracted again, so a replay sends identical bytes. A
 * `ReadableStream` cannot: it is consumed by the first attempt, and replaying it
 * would send a truncated or empty body, which is worse than the failure we are
 * trying to repair. A `Request` that carries a body is refused for the same
 * reason — its body is a stream, and `bodyUsed` is not reliable across hosts.
 *
 * When the body cannot be replayed we do not retry. The application fails
 * exactly as it would have, and we still stop stamping the origin and warn, so
 * the next request is not broken by us as well.
 */
export type BodyReplaySafety = { safe: true } | { safe: false; reason: string };

export function isReplayableFetchBody(
  input: unknown,
  init: { body?: unknown; duplex?: unknown } | undefined,
): BodyReplaySafety {
  // `duplex: "half"` only exists to stream a request body.
  if (init?.duplex !== undefined)
    return { safe: false, reason: "streaming request body" };

  const body = init?.body;
  if (body === undefined || body === null) {
    // No init body: a Request may still be carrying one.
    if (isRequestWithBody(input))
      return { safe: false, reason: "Request object with a body" };
    return { safe: true };
  }
  return isReplayableBodyValue(body);
}

export function isReplayableXhrBody(body: unknown): BodyReplaySafety {
  if (body === undefined || body === null) return { safe: true };
  return isReplayableBodyValue(body);
}

function isReplayableBodyValue(body: unknown): BodyReplaySafety {
  if (typeof body === "string") return { safe: true };
  if (isInstanceOf(body, "URLSearchParams")) return { safe: true };
  if (isInstanceOf(body, "FormData")) return { safe: true };
  if (isInstanceOf(body, "Blob")) return { safe: true };
  if (isInstanceOf(body, "File")) return { safe: true };
  if (isInstanceOf(body, "Document")) return { safe: true };
  if (typeof ArrayBuffer !== "undefined") {
    if (body instanceof ArrayBuffer) return { safe: true };
    if (ArrayBuffer.isView(body as ArrayBufferView)) return { safe: true };
  }
  if (isInstanceOf(body, "ReadableStream"))
    return { safe: false, reason: "streaming request body" };
  return { safe: false, reason: "request body that cannot be replayed" };
}

function isRequestWithBody(input: unknown): boolean {
  if (typeof Request === "undefined") return false;
  if (!(input instanceof Request)) return false;
  // `body` is null for GET/HEAD and for a Request built without one.
  try {
    return input.body != null || input.bodyUsed;
  } catch {
    return false;
  }
}

function isInstanceOf(value: unknown, ctorName: string): boolean {
  const ctor = (globalThis as Record<string, unknown>)[ctorName] as
    | (new (...args: never[]) => unknown)
    | undefined;
  return typeof ctor === "function" && value instanceof ctor;
}

/* ------------------------------------------------------------------ */
/* The one warning                                                     */
/* ------------------------------------------------------------------ */

const ALLOW_HEADERS_LIST = CORRELATION_HEADER_NAMES.join(", ");

function corsFixLines(origin: string, lead: string): string {
  return [
    lead,
    `[crumbtrail] Crumbtrail has stopped adding correlation headers to ${origin} for the rest of this session. Your app is unaffected, but this session's frontend and backend evidence will not be joined.`,
    `[crumbtrail] To join them, add these three headers to Access-Control-Allow-Headers on ${origin}: ${ALLOW_HEADERS_LIST}`,
    `[crumbtrail] Express: cors({ allowedHeaders: ["Content-Type", "Authorization", "${CORRELATION_HEADER_NAMES[0]}", "${CORRELATION_HEADER_NAMES[1]}", "${CORRELATION_HEADER_NAMES[2]}"] })`,
    `[crumbtrail] Or remove ${origin} from networkCorrelationAllowedOrigins in your Crumbtrail.init config.`,
  ].join("\n");
}

/**
 * Stops stamping `origin` and says so once, naming the exact backend change.
 *
 * `unverified` marks the case where the request could not be replayed, so we
 * could not confirm the cause. We still stop stamping: an origin we cannot
 * prove is safe is not worth risking the application over.
 */
export function reportCorrelationHeadersRejected(
  origin: string,
  options?: { unverified?: boolean },
): void {
  try {
    const first = markCorrelationOriginHeaderRejected(origin);
    if (!first) return;
    if (typeof console === "undefined" || typeof console.warn !== "function")
      return;
    const lead = options?.unverified
      ? `[crumbtrail] A request to ${origin} carrying Crumbtrail's correlation headers failed before any response arrived, and its body could not be safely replayed without them, so the cause could not be confirmed. A CORS preflight that does not allow those headers produces exactly this failure.`
      : `[crumbtrail] ${origin} refused Crumbtrail's correlation headers in the CORS preflight, so the browser blocked your request. Crumbtrail retried it without them and it succeeded.`;
    console.warn(corsFixLines(origin, lead));
  } catch {
    // Diagnostics never break the host page.
  }
}

/**
 * The origin this request targets, when it is a different one from the page's.
 *
 * Only a cross-origin request is preflighted, so only a cross-origin request can
 * fail this way. Returns `undefined` for same-origin requests and for hosts with
 * no location at all.
 */
export function crossOriginTargetOf(url: string): string | undefined {
  const origin = correlationOriginOf(url);
  if (!origin) return undefined;
  const current = (globalThis as { location?: { origin?: string } }).location
    ?.origin;
  if (!current || current === "null") return undefined;
  return origin === current ? undefined : origin;
}
