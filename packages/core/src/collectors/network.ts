import { applyGraphqlIdentity } from "../graphql";
import type { EventBus } from "../event-bus";
import type {
  CrumbtrailConfig,
  CollectorCleanup,
  CollectorContext,
} from "../types";
import {
  attachRedactionMetadata,
  credentialPresence,
  redactHeaders,
  redactNetworkTextBody,
  redactUrl,
  summarizeBinaryPayload,
  summarizeOmittedPayload,
  type BodyRedactionResult,
  type RedactionMetadata,
} from "../redaction";
import {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER,
  W3C_TRACEPARENT_HEADER,
  canInjectCorrelationHeaders,
  isCorrelationOriginHeaderRejected,
  resolveOutboundCorrelation,
} from "../correlation";
import {
  canProbeOrigin,
  crossOriginTargetOf,
  isReplayableFetchBody,
  isReplayableXhrBody,
  recordProbeAttempt,
  reportCorrelationHeadersRejected,
} from "../correlation-fallback";
import {
  EARLY_MAX_ENTRIES,
  drainEarlyCapture,
  type EarlyRequestRecord,
} from "../early-capture";
import { emitResourceFailure } from "../resource-failure-event";
import { now, readStructuredBody } from "../utils";
import { captureCallStack } from "../call-stack";
import { emitFilePartEvents } from "./file-part";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let nextId = 1;

const BINARY_CONTENT_TYPES = ["octet-stream", "image/", "audio/", "video/"];

/** Live map of in-flight requests, snapshotted at flag time via the `network.pending` state provider. */
type PendingRequestMap = Map<
  number,
  { method: string; url: string; startTime: number }
>;

/* ------------------------------------------------------------------ */
/* Correlation allowlist diagnostics                                   */
/* ------------------------------------------------------------------ */

/**
 * Says once, per backend origin, that a request which was otherwise ready to
 * carry correlation headers went out without them.
 *
 * `networkCorrelationAllowedOrigins` defaults to empty and a browser app calling
 * a backend on another origin is the normal shape of a multi service product, so
 * the default outcome is a session whose frontend and backend evidence never
 * joins. Nothing in the request, the session, or the dashboard names the cause,
 * which makes a correct looking install indistinguishable from a broken one.
 * This is the one line that names it.
 *
 * Deliberately quiet: `console.info`, once per origin per page, and capped, so a
 * production app with a chatty API prints at most a handful of lines. Never
 * throws — a host with an unusual console must not be taken down by a
 * diagnostic.
 */
const CORRELATION_HINT_MAX_ORIGINS = 10;
const correlationHintedOrigins = new Set<string>();

function hintCorrelationOriginNotAllowed(url: string): void {
  try {
    // An origin we disabled ourselves because its CORS policy refuses the
    // headers has already been explained, in a warning that says the opposite
    // of "add it to the allowlist". Two contradictory lines is worse than one.
    if (isCorrelationOriginHeaderRejected(url)) return;
    const base = (globalThis as { location?: { href?: string } }).location
      ?.href;
    const origin = new URL(url, base).origin;
    if (correlationHintedOrigins.has(origin)) return;
    if (correlationHintedOrigins.size >= CORRELATION_HINT_MAX_ORIGINS) return;
    correlationHintedOrigins.add(origin);
    if (typeof console !== "undefined" && typeof console.info === "function") {
      console.info(
        `[crumbtrail] requests to ${origin} are not carrying session correlation headers, so this session's frontend and backend evidence will not be joined. Add ${origin} to networkCorrelationAllowedOrigins in your Crumbtrail.init config to join them.`,
      );
    }
  } catch {
    // Diagnostics never break the host page.
  }
}

/** Test seam: the hint is once per page, and a suite is one page. */
export function __resetCorrelationHintsForTests(): void {
  correlationHintedOrigins.clear();
}

function isBinaryContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return BINARY_CONTENT_TYPES.some((t) => lower.includes(t));
}

function isSSE(ct: string): boolean {
  return ct.toLowerCase().includes("text/event-stream");
}

/**
 * Exported because the admission hold re-asks this question at release time: a
 * policy that arrives while events are held may add an `excludeUrls` pattern,
 * and a held request for a now-excluded URL must not reach the wire.
 */
export function shouldExclude(url: string, config: CrumbtrailConfig): boolean {
  if (config.httpEndpoint && url.includes(config.httpEndpoint)) return true;
  return config.networkExcludeUrls.some((pattern) => url.includes(pattern));
}

/* ------------------------------------------------------------------ */
/* Response body summary (`d.bodyMeta`)                                */
/* ------------------------------------------------------------------ */

/**
 * `d.body` carries the redacted response body as text, which answers "what did
 * the server say" but not "what shape was it, and how much of it is here".
 * `d.bodyMeta` adds the size facts plus a bounded, parsed view so a detector
 * can compare a rendered number against the field that produced it without
 * re-parsing an unbounded string, and can tell a real empty list from a
 * truncated one.
 *
 * The parsed view is derived from the ALREADY REDACTED body text, never from
 * the raw response, so it cannot widen what capture stores.
 */
const RESPONSE_SUMMARY_MAX_BYTES = 32_768;
const RESPONSE_SUMMARY_MAX_DEPTH = 4;
const RESPONSE_SUMMARY_MAX_ARRAY = 20;
const RESPONSE_SUMMARY_MAX_STRING = 120;

export interface ResponseBodyMeta {
  /** `"json"` when `data` is present, otherwise the response's media type. */
  ct: string;
  /** Body size in bytes. Absent when neither the text nor content-length was available. */
  bytes?: number;
  /** True when depth, array length, or string length caps dropped anything. */
  truncated?: boolean;
  data?: unknown;
  /** True length of each truncated array, keyed by its path (`"$"` is the root). */
  arrayTotal?: Record<string, number>;
}

interface SummaryState {
  truncated: boolean;
  arrayTotal: Record<string, number>;
}

function utf8ByteLength(text: string): number {
  try {
    if (typeof TextEncoder !== "undefined")
      return new TextEncoder().encode(text).length;
  } catch {
    // Fall through to the character-count approximation.
  }
  return text.length;
}

function mediaType(contentType: string): string {
  const essence = contentType.split(";")[0]?.trim().toLowerCase();
  return essence || "unknown";
}

function isJsonContentType(contentType: string): boolean {
  return /\bjson\b/i.test(contentType);
}

function capSummaryValue(
  value: unknown,
  depth: number,
  path: string,
  state: SummaryState,
): unknown {
  if (typeof value === "string") {
    if (value.length <= RESPONSE_SUMMARY_MAX_STRING) return value;
    state.truncated = true;
    return value.slice(0, RESPONSE_SUMMARY_MAX_STRING);
  }

  if (Array.isArray(value)) {
    if (depth >= RESPONSE_SUMMARY_MAX_DEPTH) {
      state.truncated = true;
      return `[array:${value.length}]`;
    }
    const kept = value.slice(0, RESPONSE_SUMMARY_MAX_ARRAY);
    if (value.length > kept.length) {
      state.truncated = true;
      state.arrayTotal[path] = value.length;
    }
    return kept.map((entry, index) =>
      capSummaryValue(entry, depth + 1, `${path}[${index}]`, state),
    );
  }

  if (value !== null && typeof value === "object") {
    if (depth >= RESPONSE_SUMMARY_MAX_DEPTH) {
      state.truncated = true;
      return "[object]";
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = capSummaryValue(entry, depth + 1, `${path}.${key}`, state);
    }
    return output;
  }

  return value;
}

/**
 * Builds `d.bodyMeta` for one response. `redactedBody` is the output of the
 * shared body-redaction pipeline; it is parsed (never the raw text) and capped.
 * Returns undefined when nothing is known about the body at all.
 */
/**
 * Exported because the admission hold rebuilds `d.bodyMeta` at release time: it
 * is a parsed copy of the response body, so a policy that re-redacts the body
 * has to re-derive it or the cleartext survives in the parsed view.
 */
export function buildResponseBodyMeta(input: {
  contentType: string;
  contentLength?: string | null;
  text?: string;
  redactedBody?: string;
}): ResponseBodyMeta | undefined {
  // `Number(null)` is 0, not NaN: a response with no content-length header
  // would otherwise be reported as zero bytes.
  const declared =
    input.contentLength !== undefined &&
    input.contentLength !== null &&
    input.contentLength.trim() !== ""
      ? Number(input.contentLength)
      : Number.NaN;
  const bytes =
    input.text !== undefined
      ? utf8ByteLength(input.text)
      : Number.isFinite(declared) && declared >= 0
        ? declared
        : undefined;

  if (!input.contentType && bytes === undefined) return undefined;

  const meta: ResponseBodyMeta = { ct: mediaType(input.contentType) };
  if (bytes !== undefined) meta.bytes = bytes;

  // Deliberately not gated on same-origin. The redacted body text in `d.body`
  // is already captured for every origin this collector sees, so withholding
  // the parsed view of that same text would hide structure the event already
  // carries — and a third-party API's payload is exactly where a contradiction
  // between what the page shows and what the service returned needs reading.
  const summarizable =
    input.redactedBody !== undefined &&
    isJsonContentType(input.contentType) &&
    bytes !== undefined &&
    bytes <= RESPONSE_SUMMARY_MAX_BYTES;
  if (!summarizable) return meta;

  try {
    const parsed = JSON.parse(input.redactedBody as string) as unknown;
    const state: SummaryState = { truncated: false, arrayTotal: {} };
    meta.data = capSummaryValue(parsed, 0, "$", state);
    meta.ct = "json";
    if (state.truncated) meta.truncated = true;
    if (Object.keys(state.arrayTotal).length > 0)
      meta.arrayTotal = state.arrayTotal;
  } catch {
    // Not parseable after redaction: size facts only, never a partial guess.
    delete meta.data;
  }
  return meta;
}

function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const result: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
  } else {
    return headers as Record<string, string>;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function responseHeadersToRecord(
  response: Response,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    result[key] = value;
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function extractMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function extractRequestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): { body?: string; nonText: boolean; formData?: FormData } {
  const body =
    init?.body ?? (input instanceof Request ? input.body : undefined);
  if (body == null) return { nonText: false };
  if (typeof body === "string") return { body, nonText: false };
  const readable = readStructuredBody(body);
  if (readable !== undefined) {
    const formData =
      typeof FormData !== "undefined" && body instanceof FormData
        ? body
        : undefined;
    return {
      body: readable,
      nonText: false,
      ...(formData ? { formData } : {}),
    };
  }
  return { nonText: true };
}

function getHeaderValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function headersToInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Headers | undefined {
  try {
    if (init?.headers !== undefined) return new Headers(init.headers);
    if (input instanceof Request) return new Headers(input.headers);
    return undefined;
  } catch {
    return undefined;
  }
}

function headersToWritableInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Headers {
  return headersToInit(input, init) ?? new Headers();
}

function buildFetchArgsWithHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Headers,
): [RequestInfo | URL, RequestInit | undefined] {
  return [input, { ...init, headers }];
}

function applyFetchCorrelationHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  config: CrumbtrailConfig,
  context?: CollectorContext,
): {
  input: RequestInfo | URL;
  init?: RequestInit;
  requestHeaders?: Record<string, string>;
  sessionId?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  /** True only when this call added a header the application had not set. */
  injected?: boolean;
} {
  const existingHeaders = headersToInit(input, init);
  const url = extractUrlString(input);

  if (!config.networkCorrelationHeaders) {
    return { input, init, requestHeaders: headersToRecord(existingHeaders) };
  }

  if (
    !canInjectCorrelationHeaders(url, config.networkCorrelationAllowedOrigins)
  ) {
    // Only a request that would otherwise have been stamped is worth naming: an
    // app with no session yet has a different problem, and saying so here would
    // point at the wrong setting.
    if (existingHeaders?.get(CRUMBTRAIL_SESSION_HEADER) ?? context?.sessionId) {
      hintCorrelationOriginNotAllowed(url);
    }
    return { input, init, requestHeaders: headersToRecord(existingHeaders) };
  }

  const sessionId =
    existingHeaders?.get(CRUMBTRAIL_SESSION_HEADER) ?? context?.sessionId;
  if (!sessionId) {
    return { input, init, requestHeaders: headersToRecord(existingHeaders) };
  }

  try {
    const headers = headersToWritableInit(input, init);
    const existingSessionId = headers.get(CRUMBTRAIL_SESSION_HEADER);
    const existingRequestId = headers.get(CRUMBTRAIL_REQUEST_HEADER);
    const existingTraceparent = headers.get(W3C_TRACEPARENT_HEADER);
    const correlation = resolveOutboundCorrelation({
      sessionId: existingSessionId ?? sessionId,
      existingRequestId: existingRequestId ?? undefined,
      existingTraceparent: existingTraceparent ?? undefined,
    });

    if (!existingSessionId)
      headers.set(CRUMBTRAIL_SESSION_HEADER, correlation.sessionId);
    if (!existingRequestId)
      headers.set(CRUMBTRAIL_REQUEST_HEADER, correlation.requestId);
    if (!existingTraceparent)
      headers.set(W3C_TRACEPARENT_HEADER, correlation.traceparent);

    const [nextInput, nextInit] = buildFetchArgsWithHeaders(
      input,
      init,
      headers,
    );
    return {
      input: nextInput,
      init: nextInit,
      requestHeaders: headersToRecord(headers),
      sessionId: correlation.sessionId,
      requestId: correlation.requestId,
      traceId: correlation.traceId,
      spanId: correlation.spanId,
      injected:
        !existingSessionId || !existingRequestId || !existingTraceparent,
    };
  } catch {
    return { input, init, requestHeaders: headersToRecord(existingHeaders) };
  }
}

/** Structured (v2) body redaction is the default; `redaction.mode: "full"` restores v1. */
/**
 * The application's own redaction settings, in the shape `redactNetworkTextBody` wants.
 *
 * Exported so every transport answers to one policy. A second copy would drift, and the first
 * symptom of the drift would be a socket frame publishing a field the app had denied.
 */
export function bodyRedactionOptions(config: CrumbtrailConfig): {
  mode: "structured" | "full";
  denyFields?: string[];
  keepFields?: string[];
} {
  return {
    mode: config.redaction?.mode ?? "structured",
    ...(config.redaction?.denyFields
      ? { denyFields: config.redaction.denyFields }
      : {}),
    ...(config.redaction?.keepFields
      ? { keepFields: config.redaction.keepFields }
      : {}),
  };
}

function applyBodyResult(
  target: Record<string, unknown>,
  result: BodyRedactionResult,
): void {
  if (result.body !== undefined) target.body = result.body;
  if (result.bodySummary) target.bodySummary = result.bodySummary;
}

function applyResponseBodyMeta(
  target: Record<string, unknown>,
  input: Parameters<typeof buildResponseBodyMeta>[0],
): void {
  const meta = buildResponseBodyMeta(input);
  if (meta) target.bodyMeta = meta;
}

/* ------------------------------------------------------------------ */
/* Correlation header rejection: the retry                             */
/* ------------------------------------------------------------------ */

/**
 * Decides whether a failed request is a candidate for the unstamped retry, and
 * returns the origin it targets.
 *
 * Refuses anything the retry cannot honestly test: a request we did not stamp,
 * a same-origin request (never preflighted), an origin already disabled or
 * already probed to its cap, and an abort — an `AbortController` firing is the
 * application's own decision and replaying it would defy it.
 */
function correlationRetryTarget(input: {
  url: string;
  injected: boolean;
  error: unknown;
}): string | undefined {
  if (!input.injected) return undefined;
  if (input.error instanceof Error && input.error.name === "AbortError")
    return undefined;
  if (isCorrelationOriginHeaderRejected(input.url)) return undefined;
  const origin = crossOriginTargetOf(input.url);
  if (!origin) return undefined;
  if (!canProbeOrigin(origin)) return undefined;
  return origin;
}

/**
 * Replays a failed fetch without correlation headers, exactly once.
 *
 * Returns the recovered `Response` when the unstamped attempt succeeds, which
 * is the only outcome that proves the headers were the cause. Returns
 * `undefined` in every other case, and the caller then fails the request the
 * way the application would have failed it on its own.
 */
async function retryFetchWithoutCorrelation(args: {
  originalFetch: typeof globalThis.fetch;
  input: RequestInfo | URL;
  init: RequestInit | undefined;
  url: string;
  injected: boolean;
  error: unknown;
}): Promise<Response | undefined> {
  const origin = correlationRetryTarget(args);
  if (!origin) return undefined;

  const replay = isReplayableFetchBody(
    args.input,
    args.init as { body?: unknown; duplex?: unknown } | undefined,
  );
  if (!replay.safe) {
    // Cannot prove the cause without sending the body twice, and sending a
    // stream twice sends it wrong. Fail as the app would have, and stop
    // stamping so we cannot be the cause of the next failure either.
    reportCorrelationHeadersRejected(origin, { unverified: true });
    return undefined;
  }

  recordProbeAttempt(origin);
  try {
    // `args.input`/`args.init` are the application's own arguments. The stamped
    // headers went onto a copy, so this replay carries exactly what the app
    // asked for.
    //
    // Called through `globalThis`, not as `args.originalFetch(...)`: the method
    // form passes `args` as the receiver and Chrome answers "Failed to execute
    // 'fetch' on 'Window': Illegal invocation", which the catch below would
    // read as the backend being unreachable.
    const response = await args.originalFetch.call(
      globalThis,
      args.input,
      args.init,
    );
    reportCorrelationHeadersRejected(origin);
    return response;
  } catch {
    // Failed both ways: the backend is unreachable, not fussy about headers.
    // Say nothing and change nothing.
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Fetch wrapper                                                       */
/* ------------------------------------------------------------------ */

function wrapFetch(
  bus: EventBus,
  config: CrumbtrailConfig,
  originalFetch: typeof globalThis.fetch,
  context: CollectorContext | undefined,
  pending: PendingRequestMap,
): typeof globalThis.fetch {
  return async function instrumentedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = extractUrlString(input);

    if (shouldExclude(url, config)) {
      return originalFetch(input, init);
    }

    const id = nextId++;
    const method = extractMethod(input, init);
    const startTime = now();
    // Synchronously, before the first await: after one the application's frames
    // are gone from the stack and what remains is the microtask that resumed us.
    const callStack = captureCallStack(instrumentedFetch);
    const fetchArgs = applyFetchCorrelationHeaders(
      input,
      init,
      config,
      context,
    );

    const urlResult = redactUrl(url, "url");
    const reqMetadata: Array<RedactionMetadata | undefined> = [
      urlResult.metadata,
    ];
    const reqData: Record<string, unknown> = {
      id,
      method,
      url: urlResult.value,
    };
    if (fetchArgs.sessionId) reqData.sessionId = fetchArgs.sessionId;
    if (fetchArgs.requestId) reqData.requestId = fetchArgs.requestId;
    if (fetchArgs.traceId) reqData.traceId = fetchArgs.traceId;
    if (fetchArgs.spanId) reqData.spanId = fetchArgs.spanId;

    const requestHeaders = config.networkCaptureHeaders
      ? fetchArgs.requestHeaders
      : undefined;
    if (requestHeaders) {
      const headersResult = redactHeaders(requestHeaders, "hdrs");
      reqData.hdrs = headersResult.value;
      reqMetadata.push(headersResult.metadata);
    }
    // Recorded whether or not headers are captured, because presence is not a
    // value. Without it a 401 the client ASKED for — an app checking on load
    // whether anyone is signed in — is indistinguishable from a 401 that means
    // authentication is broken, and the designed one is the most recurring
    // "issue" this product reports.
    reqData.creds = credentialPresence(fetchArgs.requestHeaders);

    const requestBody = extractRequestBody(input, init);
    if (requestBody.body !== undefined) {
      const bodyResult = redactNetworkTextBody(requestBody.body, {
        contentType: getHeaderValue(requestHeaders, "content-type"),
        maxLength: config.networkMaxBodySize,
        path: "body",
        ...bodyRedactionOptions(config),
      });
      applyBodyResult(reqData, bodyResult);
      applyGraphqlIdentity(reqData, requestBody.body);
      reqMetadata.push(bodyResult.metadata);
    } else if (requestBody.nonText) {
      const bodyResult = summarizeOmittedPayload(
        "non_text_request_body",
        "body",
      );
      applyBodyResult(reqData, bodyResult);
      reqMetadata.push(bodyResult.metadata);
    }

    // Which line of the application asked for this request.
    //
    // The backend half of a linked full-stack request has carried a callsite for
    // a while (`responseCallsite`, and the callsites riding on `db.diff`); the
    // frontend half carried none, so a bundle for a defect that never reached
    // the server — or reached it and got a correct 200 back — named no client
    // file at all. The rationale written for the backend field applies here
    // unchanged: a page that renders wrong without throwing had no pointer.
    if (callStack !== undefined) {
      const stackResult = redactNetworkTextBody(callStack, {
        contentType: "text/plain",
        path: "stk",
      });
      if (stackResult.body !== undefined) reqData.stk = stackResult.body;
      reqMetadata.push(stackResult.metadata);
    }

    attachRedactionMetadata(reqData, ...reqMetadata);

    bus.emit({ t: startTime, k: "net.req", d: reqData }, { rawUrl: url });

    // Fire-and-forget: describing and sniffing an upload never delays
    // dispatching the request it rides on. See `emitFilePartEvents`.
    if (requestBody.formData) {
      emitFilePartEvents(bus, id, requestBody.formData.entries(), startTime);
    }

    pending.set(id, { method, url: urlResult.value, startTime });
    let response: Response;
    try {
      response = await originalFetch(fetchArgs.input, fetchArgs.init);
    } catch (error) {
      // A stamped cross-origin request that failed before any response is the
      // shape a rejected CORS preflight takes. Retry it once without our
      // headers; if that works, the headers were the cause, and the app gets
      // the response it would have got without Crumbtrail installed.
      const recovered = await retryFetchWithoutCorrelation({
        originalFetch,
        input,
        init,
        url,
        injected: fetchArgs.injected === true,
        error,
      });
      if (recovered) {
        response = recovered;
        // The request that actually reached the server carried no correlation
        // headers, so the response has no backend counterpart to join to.
        // Claiming the ids on `net.res` would invent a join that does not exist.
        fetchArgs.sessionId = undefined;
        fetchArgs.requestId = undefined;
        fetchArgs.traceId = undefined;
        fetchArgs.spanId = undefined;
      } else {
        emitFetchFailure(error);
        throw error;
      }
    } finally {
      pending.delete(id);
    }

    function emitFetchFailure(error: unknown): void {
      // Network-level failure (offline, DNS, CORS, abort): there is no Response,
      // so emit a net.err carrying the request identity instead of a net.res.
      const errData: Record<string, unknown> = {
        id,
        method,
        url: urlResult.value,
        dur: now() - startTime,
        msg: error instanceof Error ? error.message : String(error),
        transport: "fetch",
      };
      if (error instanceof Error && error.name && error.name !== "Error")
        errData.name = error.name;
      if (fetchArgs.sessionId) errData.sessionId = fetchArgs.sessionId;
      if (fetchArgs.requestId) errData.requestId = fetchArgs.requestId;
      if (fetchArgs.traceId) errData.traceId = fetchArgs.traceId;
      if (fetchArgs.spanId) errData.spanId = fetchArgs.spanId;
      attachRedactionMetadata(errData, urlResult.metadata);
      bus.emit({ t: now(), k: "net.err", d: errData }, { rawUrl: url });
    }

    const dur = now() - startTime;
    // Stamped when the response ARRIVED, not when its body finished. A streaming response can stay
    // open for minutes, and dating the event at the close would put it after everything the stream
    // caused - the timeline would report the effects before the cause.
    const responseTime = now();

    const resMetadata: Array<RedactionMetadata | undefined> = [
      urlResult.metadata,
    ];
    // The response names its own request. `net.res` used to carry `id` alone, so
    // every reader had to find the paired `net.req` to learn WHICH request
    // failed - and the pair is not guaranteed to survive: a request that started
    // before the capture window, before the ring buffer's oldest retained event,
    // or before a truncated upload's cut leaves its response standing alone. The
    // index then recorded the failure as `{m:"", url:"", st:500}` and every
    // downstream title read "HTTP 500 from request unknown URL". `net.err`
    // already carries method and url for exactly this reason, and the native SDK
    // wire contract puts them on the response too; this makes the browser's
    // failing response as self-describing as both.
    const resData: Record<string, unknown> = {
      id,
      method,
      url: urlResult.value,
      st: response.status,
      dur,
    };
    if (fetchArgs.sessionId) resData.sessionId = fetchArgs.sessionId;
    if (fetchArgs.requestId) resData.requestId = fetchArgs.requestId;
    if (fetchArgs.traceId) resData.traceId = fetchArgs.traceId;
    if (fetchArgs.spanId) resData.spanId = fetchArgs.spanId;

    if (config.networkCaptureHeaders) {
      const hdrs = responseHeadersToRecord(response);
      if (hdrs) {
        const headersResult = redactHeaders(hdrs, "hdrs");
        resData.hdrs = headersResult.value;
        resMetadata.push(headersResult.metadata);
      }
    }

    const contentType = response.headers.get("content-type") ?? "";
    const contentLength = response.headers.get("content-length");

    if (isSSE(contentType)) {
      const bodyResult = summarizeOmittedPayload("stream_payload", "body");
      applyBodyResult(resData, bodyResult);
      resMetadata.push(bodyResult.metadata);
      applyResponseBodyMeta(resData, {
        contentType,
        contentLength,
      });
    } else if (isBinaryContentType(contentType)) {
      const bodyResult = summarizeBinaryPayload(
        contentType,
        contentLength,
        "body",
      );
      applyBodyResult(resData, bodyResult);
      resMetadata.push(bodyResult.metadata);
      applyResponseBodyMeta(resData, {
        contentType,
        contentLength,
      });
    } else {
      try {
        // clone() leaves the app's stream untouched — the page still reads the
        // response itself.
        const cloned = response.clone();
        const read = await readBoundedText(
          cloned,
          config.networkMaxBodySize,
          STREAM_READ_BUDGET_MS,
        );
        const text = read.text;
        if (read.openStream) {
          // The stream outlived the read budget. Before this, `await cloned.text()` waited for a
          // stream that may never end, and `net.res` was therefore never emitted at all: a request
          // that streamed - progress, tokens, a log tail, an export - left a `net.req` with no
          // response beside it, which reads as a request that never came back.
          resData.streaming = true;
        }
        if (text) {
          const bodyResult = redactNetworkTextBody(text, {
            contentType,
            maxLength: config.networkMaxBodySize,
            path: "body",
            ...bodyRedactionOptions(config),
          });
          if (bodyResult.body !== undefined) resData.body = bodyResult.body;
          if (bodyResult.bodySummary)
            resData.bodySummary = bodyResult.bodySummary;
          resMetadata.push(bodyResult.metadata);
          applyResponseBodyMeta(resData, {
            contentType,
            contentLength,
            text,
            redactedBody: bodyResult.body,
          });
        } else {
          // Empty body: an event that says "200, JSON, 0 bytes" is evidence.
          applyResponseBodyMeta(resData, { contentType, contentLength, text });
        }
      } catch {
        const bodyResult = summarizeOmittedPayload("body_read_failed", "body");
        applyBodyResult(resData, bodyResult);
        resMetadata.push(bodyResult.metadata);
        applyResponseBodyMeta(resData, { contentType, contentLength });
      }
    }

    attachRedactionMetadata(resData, ...resMetadata);

    bus.emit({ t: responseTime, k: "net.res", d: resData }, { rawUrl: url });

    return response;
  };
}

/**
 * How long the collector will wait for a response body before reporting what it has.
 *
 * A streaming response is a normal thing - progress updates, model tokens, a log tail, a large
 * export - and `Response.text()` on one resolves when the stream CLOSES, which may be never. The
 * old code awaited that before emitting `net.res`, so a streamed request was recorded as a request
 * that never came back.
 */
const STREAM_READ_BUDGET_MS = 2_000;

/**
 * Read a cloned response body, bounded by bytes and by time.
 *
 * Returns whatever arrived inside the budget. `openStream` says the body had not finished, which is
 * a fact about the response worth recording on its own: it distinguishes "the server sent this and
 * stopped" from "the server is still sending".
 *
 * The clone is cancelled on the way out. The application's own copy is untouched either way.
 */
async function readBoundedText(
  cloned: Response,
  maxBytes: number,
  budgetMs: number,
): Promise<{ text: string; openStream: boolean }> {
  const body = cloned.body;
  // No readable stream to walk (older hosts, or a synthetic Response): read the whole thing, but
  // still under the budget. `text()` on an open stream never resolves, and a host that hides the
  // stream from us hides the timeout from us too unless the race is here as well.
  if (!body || typeof body.getReader !== "function") {
    const whole = await Promise.race([
      cloned.text().then((text) => ({ text, openStream: false })),
      new Promise<{ text: string; openStream: boolean }>((resolve) =>
        setTimeout(() => resolve({ text: "", openStream: true }), budgetMs),
      ),
    ]);
    // Let go of the clone so the buffered copy is not held open behind us. Not awaited, for the
    // same reason as above.
    if (whole.openStream) {
      void Promise.resolve(cloned.body?.cancel()).catch(() => {});
    }
    return whole;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = now() + budgetMs;
  let text = "";
  let openStream = false;

  try {
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        openStream = true;
        break;
      }
      const step = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining),
        ),
      ]);
      if (step === "timeout") {
        openStream = true;
        break;
      }
      if (step.done) break;
      text += decoder.decode(step.value, { stream: true });
      if (text.length >= maxBytes) {
        // Enough for the record. Whether more was coming is unknowable from here without waiting
        // for it, which is the cost this bound exists to avoid.
        openStream = true;
        break;
      }
    }
    if (!openStream) text += decoder.decode();
  } finally {
    // NOT awaited. `cancel()` on a reader with a `read()` still outstanding never settles - the
    // very case this function exists to survive - so awaiting it reintroduces the hang one layer
    // down. Fire it and walk away; the application's own copy is unaffected either way.
    void Promise.resolve(reader.cancel()).catch(() => {});
  }

  return { text, openStream };
}

/* ------------------------------------------------------------------ */
/* XHR wrapper                                                         */
/* ------------------------------------------------------------------ */

function wrapXHR(
  bus: EventBus,
  config: CrumbtrailConfig,
  xhrPrototype: typeof XMLHttpRequest.prototype,
  context: CollectorContext | undefined,
  pending: PendingRequestMap,
): {
  origOpen: typeof XMLHttpRequest.prototype.open;
  origSend: typeof XMLHttpRequest.prototype.send;
  origSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader;
} {
  const origOpen = xhrPrototype.open;
  const origSend = xhrPrototype.send;
  const origSetRequestHeader = xhrPrototype.setRequestHeader;

  // Metadata stored per-instance via WeakMap
  const xhrMeta = new WeakMap<
    XMLHttpRequest,
    {
      id: number;
      method: string;
      url: string;
      startTime: number;
      excluded: boolean;
      requestHeaders: Record<string, string>;
      sessionId?: string;
      requestId?: string;
      traceId?: string;
      spanId?: string;
      /** Arguments of the app's own `open()`, so a retry reopens identically. */
      openArgs: [string, string | URL, ...unknown[]];
      /** Headers the application set, without the ones Crumbtrail added. */
      appHeaders: Record<string, string>;
      /** The body the app passed to `send()`, for a replay. */
      body?: Document | XMLHttpRequestBodyInit | null;
      /** True only when Crumbtrail added a correlation header to this request. */
      injected: boolean;
      /** One retry per request, ever. */
      retried: boolean;
    }
  >();

  // Registered once per XHR instance, from `open()`. Registration order decides
  // handler order, and `open()` is the earliest hook we have: an application
  // that assigns `xhr.onerror` after `open()` — the common shape — is behind us,
  // so `stopImmediatePropagation` can hide a failure we are about to repair. An
  // application that assigns it before `open()` sees the error first; the retry
  // still runs and still stops us breaking its later requests.
  const guarded = new WeakSet<XMLHttpRequest>();

  const retryXhrWithoutCorrelation = function (
    this: XMLHttpRequest,
    event: Event,
  ): void {
    const meta = xhrMeta.get(this);
    if (!meta || meta.excluded || meta.retried || !meta.injected) return;

    const origin = correlationRetryTarget({
      url: meta.url,
      injected: true,
      error: undefined,
    });
    if (!origin) return;

    meta.retried = true;

    const replay = isReplayableXhrBody(meta.body);
    if (!replay.safe) {
      reportCorrelationHeadersRejected(origin, { unverified: true });
      return;
    }

    // The app must not see this attempt at all: the whole point is that it
    // behaves as if Crumbtrail were absent.
    event.stopImmediatePropagation();
    recordProbeAttempt(origin);

    // Whatever happens next, the wire carries no correlation headers, so the
    // response has no backend counterpart to join to.
    meta.sessionId = undefined;
    meta.requestId = undefined;
    meta.traceId = undefined;
    meta.spanId = undefined;

    try {
      this.addEventListener(
        "load",
        () => reportCorrelationHeadersRejected(origin),
        { once: true },
      );
      (
        origOpen as unknown as (
          this: XMLHttpRequest,
          ...args: unknown[]
        ) => void
      ).call(this, ...meta.openArgs);
      for (const [name, value] of Object.entries(meta.appHeaders)) {
        try {
          origSetRequestHeader.call(this, name, value);
        } catch {
          // A header the host refuses on the second pass is not worth failing on.
        }
      }
      origSend.call(this, meta.body);
    } catch {
      // Reopening failed (an unusual host, or an XHR the app already aborted).
      // Nothing was proved, so nothing is claimed.
    }
  };

  xhrPrototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const urlStr = typeof url === "string" ? url : url.toString();
    const excluded = shouldExclude(urlStr, config);

    xhrMeta.set(this, {
      id: nextId++,
      method: method.toUpperCase(),
      url: urlStr,
      startTime: 0,
      excluded,
      requestHeaders: {},
      openArgs: [method, url, ...rest],
      appHeaders: {},
      injected: false,
      retried: false,
    });

    if (!excluded && !guarded.has(this)) {
      guarded.add(this);
      try {
        this.addEventListener("error", retryXhrWithoutCorrelation);
      } catch {
        // A host without addEventListener simply does not get the fallback.
      }
    }

    return (
      origOpen as unknown as (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...args: unknown[]
      ) => void
    ).call(this, method, url, ...rest);
  };

  // Intercept setRequestHeader to track request headers
  xhrPrototype.setRequestHeader = function (name: string, value: string) {
    const meta = xhrMeta.get(this);
    if (meta) {
      meta.requestHeaders[name] = value;
    }
    return origSetRequestHeader.call(this, name, value);
  };

  xhrPrototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const meta = xhrMeta.get(this);
    if (!meta || meta.excluded) {
      return origSend.call(this, body);
    }

    // Snapshotted before injection, so a replay carries the app's headers and
    // only the app's headers.
    meta.appHeaders = { ...meta.requestHeaders };
    meta.body = body;

    const correlationAllowed =
      config.networkCorrelationHeaders &&
      canInjectCorrelationHeaders(
        meta.url,
        config.networkCorrelationAllowedOrigins,
      );

    if (
      !correlationAllowed &&
      config.networkCorrelationHeaders &&
      (getHeaderValue(meta.requestHeaders, CRUMBTRAIL_SESSION_HEADER) ??
        context?.sessionId)
    ) {
      hintCorrelationOriginNotAllowed(meta.url);
    }

    if (correlationAllowed) {
      const existingSessionId = getHeaderValue(
        meta.requestHeaders,
        CRUMBTRAIL_SESSION_HEADER,
      );
      const existingRequestId = getHeaderValue(
        meta.requestHeaders,
        CRUMBTRAIL_REQUEST_HEADER,
      );
      const existingTraceparent = getHeaderValue(
        meta.requestHeaders,
        W3C_TRACEPARENT_HEADER,
      );
      const sessionId = existingSessionId ?? context?.sessionId;

      if (sessionId) {
        const correlation = resolveOutboundCorrelation({
          sessionId,
          existingRequestId,
          existingTraceparent,
        });

        meta.sessionId = correlation.sessionId;
        meta.requestId = correlation.requestId;
        meta.traceId = correlation.traceId;
        meta.spanId = correlation.spanId;

        if (!existingSessionId) {
          try {
            origSetRequestHeader.call(
              this,
              CRUMBTRAIL_SESSION_HEADER,
              meta.sessionId,
            );
            meta.requestHeaders[CRUMBTRAIL_SESSION_HEADER] = meta.sessionId;
            meta.injected = true;
          } catch {
            meta.sessionId = undefined;
          }
        }

        if (!existingRequestId) {
          try {
            origSetRequestHeader.call(
              this,
              CRUMBTRAIL_REQUEST_HEADER,
              meta.requestId,
            );
            meta.requestHeaders[CRUMBTRAIL_REQUEST_HEADER] = meta.requestId;
            meta.injected = true;
          } catch {
            meta.requestId = undefined;
          }
        }

        if (!existingTraceparent) {
          try {
            origSetRequestHeader.call(
              this,
              W3C_TRACEPARENT_HEADER,
              correlation.traceparent,
            );
            meta.requestHeaders[W3C_TRACEPARENT_HEADER] =
              correlation.traceparent;
            meta.injected = true;
          } catch {
            meta.traceId = undefined;
            meta.spanId = undefined;
          }
        }
      }
    }

    meta.startTime = now();

    const urlResult = redactUrl(meta.url, "url");
    const reqMetadata: Array<RedactionMetadata | undefined> = [
      urlResult.metadata,
    ];
    const reqData: Record<string, unknown> = {
      id: meta.id,
      method: meta.method,
      url: urlResult.value,
    };
    if (meta.sessionId) reqData.sessionId = meta.sessionId;
    if (meta.requestId) reqData.requestId = meta.requestId;
    if (meta.traceId) reqData.traceId = meta.traceId;
    if (meta.spanId) reqData.spanId = meta.spanId;

    if (
      config.networkCaptureHeaders &&
      Object.keys(meta.requestHeaders).length > 0
    ) {
      const headersResult = redactHeaders({ ...meta.requestHeaders }, "hdrs");
      reqData.hdrs = headersResult.value;
      reqMetadata.push(headersResult.metadata);
    }

    // Same reading as the fetch path: a form submission sent as FormData or URLSearchParams is
    // text, and discarding it loses every field the user filled in.
    const readableBody =
      body == null
        ? undefined
        : typeof body === "string"
          ? body
          : readStructuredBody(body);
    if (readableBody !== undefined) {
      const bodyResult = redactNetworkTextBody(readableBody, {
        contentType: getHeaderValue(meta.requestHeaders, "content-type"),
        maxLength: config.networkMaxBodySize,
        path: "body",
        ...bodyRedactionOptions(config),
      });
      applyBodyResult(reqData, bodyResult);
      applyGraphqlIdentity(reqData, readableBody);
      reqMetadata.push(bodyResult.metadata);
    } else if (body != null) {
      const bodyResult = summarizeOmittedPayload(
        "non_text_request_body",
        "body",
      );
      applyBodyResult(reqData, bodyResult);
      reqMetadata.push(bodyResult.metadata);
    }

    attachRedactionMetadata(reqData, ...reqMetadata);

    bus.emit({ t: meta.startTime, k: "net.req", d: reqData }, {
      rawUrl: meta.url,
    });

    // Fire-and-forget: describing and sniffing an upload never delays
    // dispatching the request it rides on. See `emitFilePartEvents`.
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      emitFilePartEvents(bus, meta.id, body.entries(), meta.startTime);
    }

    const emitResponse = () => {
      const dur = now() - meta.startTime;
      const resMetadata: Array<RedactionMetadata | undefined> = [
        urlResult.metadata,
      ];
      // Self-describing for the same reason the fetch path is: see the comment
      // on the fetch `net.res` payload.
      const resData: Record<string, unknown> = {
        id: meta.id,
        method: meta.method,
        url: urlResult.value,
        st: this.status,
        dur,
      };
      if (meta.sessionId) resData.sessionId = meta.sessionId;
      if (meta.requestId) resData.requestId = meta.requestId;
      if (meta.traceId) resData.traceId = meta.traceId;
      if (meta.spanId) resData.spanId = meta.spanId;

      if (config.networkCaptureHeaders) {
        const rawHeaders = this.getAllResponseHeaders();
        if (rawHeaders) {
          const hdrs: Record<string, string> = {};
          rawHeaders
            .split("\r\n")
            .filter(Boolean)
            .forEach((line: string) => {
              const idx = line.indexOf(": ");
              if (idx > -1) {
                hdrs[line.slice(0, idx)] = line.slice(idx + 2);
              }
            });
          if (Object.keys(hdrs).length > 0) {
            const headersResult = redactHeaders(hdrs, "hdrs");
            resData.hdrs = headersResult.value;
            resMetadata.push(headersResult.metadata);
          }
        }
      }

      const contentType = this.getResponseHeader("content-type") ?? "";
      const contentLength = this.getResponseHeader("content-length");

      if (isSSE(contentType)) {
        const bodyResult = summarizeOmittedPayload("stream_payload", "body");
        applyBodyResult(resData, bodyResult);
        resMetadata.push(bodyResult.metadata);
        applyResponseBodyMeta(resData, {
          contentType,
          contentLength,
        });
      } else if (isBinaryContentType(contentType)) {
        const bodyResult = summarizeBinaryPayload(
          contentType,
          contentLength,
          "body",
        );
        applyBodyResult(resData, bodyResult);
        resMetadata.push(bodyResult.metadata);
        applyResponseBodyMeta(resData, {
          contentType,
          contentLength,
        });
      } else {
        // responseText throws for a non-text responseType (json, blob,
        // arraybuffer); the response still deserves its size facts.
        let text: string | undefined;
        try {
          text = this.responseText;
        } catch {
          text = undefined;
        }
        if (text) {
          const bodyResult = redactNetworkTextBody(text, {
            contentType,
            maxLength: config.networkMaxBodySize,
            path: "body",
            ...bodyRedactionOptions(config),
          });
          if (bodyResult.body !== undefined) resData.body = bodyResult.body;
          if (bodyResult.bodySummary)
            resData.bodySummary = bodyResult.bodySummary;
          resMetadata.push(bodyResult.metadata);
          applyResponseBodyMeta(resData, {
            contentType,
            contentLength,
            text,
            redactedBody: bodyResult.body,
          });
        } else {
          applyResponseBodyMeta(resData, { contentType, contentLength });
        }
      }

      attachRedactionMetadata(resData, ...resMetadata);

      bus.emit({ t: now(), k: "net.res", d: resData }, { rawUrl: meta.url });
    };

    // error/timeout/abort settle the XHR without an HTTP response (status 0),
    // so they emit a net.err carrying the request identity instead of a net.res.
    const emitFailure = (msg: string, name?: string) => {
      const errData: Record<string, unknown> = {
        id: meta.id,
        method: meta.method,
        url: urlResult.value,
        dur: now() - meta.startTime,
        msg,
        transport: "xhr",
      };
      if (name) errData.name = name;
      if (meta.sessionId) errData.sessionId = meta.sessionId;
      if (meta.requestId) errData.requestId = meta.requestId;
      if (meta.traceId) errData.traceId = meta.traceId;
      if (meta.spanId) errData.spanId = meta.spanId;
      attachRedactionMetadata(errData, urlResult.metadata);
      bus.emit({ t: now(), k: "net.err", d: errData }, { rawUrl: meta.url });
    };

    this.addEventListener("load", emitResponse);
    this.addEventListener("error", () => emitFailure("network error"));
    this.addEventListener("timeout", () =>
      emitFailure("request timed out", "TimeoutError"),
    );
    this.addEventListener("abort", () =>
      emitFailure("request aborted", "AbortError"),
    );

    pending.set(meta.id, {
      method: meta.method,
      url: urlResult.value,
      startTime: meta.startTime,
    });
    // loadend fires after load/error/timeout/abort — covers every way an XHR settles.
    this.addEventListener("loadend", () => pending.delete(meta.id));

    return origSend.call(this, body);
  };

  return { origOpen, origSend, origSetRequestHeader };
}

/* ------------------------------------------------------------------ */
/* Early-capture drain                                                 */
/* ------------------------------------------------------------------ */

/**
 * Replays one request `crumbtrail-core/early` captured before the SDK existed.
 * The record carries raw text; every field leaves through the same redaction
 * the live wrappers use, and the original timestamps are preserved so the
 * first-paint requests sit in the timeline where they happened. `d.early`
 * marks the pair as retro-emitted — the request went out before this patch,
 * so response headers were never observed.
 */
function emitEarlyRecord(
  bus: EventBus,
  config: CrumbtrailConfig,
  record: EarlyRequestRecord,
): void {
  const id = nextId++;
  const urlResult = redactUrl(record.url, "url");
  const reqMetadata: Array<RedactionMetadata | undefined> = [
    urlResult.metadata,
  ];
  const reqData: Record<string, unknown> = {
    id,
    method: record.method,
    url: urlResult.value,
    early: true,
  };
  if (record.sessionId) reqData.sessionId = record.sessionId;
  if (record.requestId) reqData.requestId = record.requestId;
  if (record.traceId) reqData.traceId = record.traceId;
  if (record.spanId) reqData.spanId = record.spanId;

  if (record.reqBody !== undefined) {
    const bodyResult = redactNetworkTextBody(record.reqBody, {
      contentType: record.reqCt,
      maxLength: config.networkMaxBodySize,
      path: "body",
      ...bodyRedactionOptions(config),
    });
    applyBodyResult(reqData, bodyResult);
    applyGraphqlIdentity(reqData, record.reqBody);
    reqMetadata.push(bodyResult.metadata);
  }

  // The callsite the EARLY snippet captured, replayed with the rest of the
  // record. In an application that installs the snippet this is the only path a
  // `net.req` takes — measured at 26 of 26 in a captured session — so a callsite
  // on `wrapFetch` alone would be a producer nothing downstream ever sees.
  if (record.stk) {
    const stackResult = redactNetworkTextBody(record.stk, {
      contentType: "text/plain",
      path: "stk",
    });
    if (stackResult.body !== undefined) reqData.stk = stackResult.body;
    reqMetadata.push(stackResult.metadata);
  }

  attachRedactionMetadata(reqData, ...reqMetadata);
  bus.emit({ t: record.t, k: "net.req", d: reqData }, { rawUrl: record.url });

  const settledAt = record.t + record.dur;

  if (record.err !== undefined) {
    const errData: Record<string, unknown> = {
      id,
      method: record.method,
      url: urlResult.value,
      dur: record.dur,
      msg: record.err,
      transport: record.transport,
      early: true,
    };
    if (record.sessionId) errData.sessionId = record.sessionId;
    if (record.requestId) errData.requestId = record.requestId;
    if (record.traceId) errData.traceId = record.traceId;
    if (record.spanId) errData.spanId = record.spanId;
    attachRedactionMetadata(errData, urlResult.metadata);
    bus.emit({ t: settledAt, k: "net.err", d: errData }, {
      rawUrl: record.url,
    });
    return;
  }

  const resMetadata: Array<RedactionMetadata | undefined> = [
    urlResult.metadata,
  ];
  // Self-describing for the same reason the fetch path is: see the comment on
  // the fetch `net.res` payload.
  const resData: Record<string, unknown> = {
    id,
    method: record.method,
    url: urlResult.value,
    st: record.status ?? 0,
    dur: record.dur,
    early: true,
  };
  if (record.sessionId) resData.sessionId = record.sessionId;
  if (record.requestId) resData.requestId = record.requestId;
  if (record.traceId) resData.traceId = record.traceId;
  if (record.spanId) resData.spanId = record.spanId;

  if (record.resBody !== undefined) {
    const bodyResult = redactNetworkTextBody(record.resBody, {
      contentType: record.ct,
      maxLength: config.networkMaxBodySize,
      path: "body",
      ...bodyRedactionOptions(config),
    });
    if (bodyResult.body !== undefined) resData.body = bodyResult.body;
    if (bodyResult.bodySummary) resData.bodySummary = bodyResult.bodySummary;
    resMetadata.push(bodyResult.metadata);
    applyResponseBodyMeta(resData, {
      contentType: record.ct ?? "",
      text: record.resBody,
      redactedBody: bodyResult.body,
    });
  }

  attachRedactionMetadata(resData, ...resMetadata);
  bus.emit({ t: settledAt, k: "net.res", d: resData }, { rawUrl: record.url });
}

function isEarlyResourceError(record: EarlyRequestRecord): boolean {
  return record.kind === "resource-error";
}

/**
 * Drains the `crumbtrail-core/early` queue into the bus and defers the early
 * patch permanently. A no-op when the early module was never imported.
 */
function drainEarlyRequests(
  bus: EventBus,
  config: CrumbtrailConfig,
  context?: CollectorContext,
): void {
  const emit = (record: EarlyRequestRecord) => {
    if (isEarlyResourceError(record)) {
      if (!config.errors) return;
      try {
        emitResourceFailure(bus, record);
      } catch {
        // One malformed record never costs the rest of the queue.
      }
      return;
    }
    if (shouldExclude(record.url, config)) return;
    try {
      emitEarlyRecord(bus, config, record);
    } catch {
      // One malformed record never costs the rest of the queue.
    }
  };

  // The queue is one-shot: `drain()` empties it and can never be re-run, while
  // the bus refuses every event until the remote capture policy lands. Emitting
  // into that window destroys the records — and they are the requests that
  // rendered the first screen, already stamped with the correlation headers the
  // backend recorded, so their loss orphans backend evidence with nothing left
  // to say it happened. So the drain still runs first (the early patch must stop
  // taking new requests before the live patch below is installed, or every
  // request would be captured twice), but the records are HELD here until
  // admission is decided, then released or discarded.
  let release: "holding" | "open" | "denied" = "open";
  const held: EarlyRequestRecord[] = [];
  const accept = (record: EarlyRequestRecord) => {
    if (release === "denied") return;
    if (release === "open") {
      emit(record);
      return;
    }
    held.push(record);
    // The same cap the early queue itself carries; nothing may grow unbounded
    // in a page Crumbtrail did not write.
    while (held.length > EARLY_MAX_ENTRIES) held.shift();
  };

  if (context?.whenCaptureAdmitted) {
    release = "holding";
    context.whenCaptureAdmitted((admitted) => {
      if (!admitted) {
        release = "denied";
        held.length = 0;
        return;
      }
      release = "open";
      const pending = held.splice(0, held.length);
      for (const record of pending) emit(record);
    });
  }

  // The sink catches the requests still on the wire at this instant. They are
  // the page's first data load more often than not, and before the sink existed
  // they were captured by neither side: the early patch stopped recording at the
  // drain, and the patch below was installed after they were issued.
  for (const record of drainEarlyCapture(accept)) accept(record);
}

/* ------------------------------------------------------------------ */
/* Collector export                                                     */
/* ------------------------------------------------------------------ */

export function networkCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
  context?: CollectorContext,
): CollectorCleanup {
  // Drain before patching: the queued requests happened before this collector
  // existed, so they belong at the head of the network timeline.
  drainEarlyRequests(bus, config, context);

  const originalFetch = globalThis.fetch;
  const shouldPatchFetch = typeof originalFetch === "function";

  const xhrPrototype = globalThis.XMLHttpRequest?.prototype;
  const shouldPatchXHR = Boolean(
    xhrPrototype &&
    typeof xhrPrototype.open === "function" &&
    typeof xhrPrototype.send === "function" &&
    typeof xhrPrototype.setRequestHeader === "function",
  );

  const pending: PendingRequestMap = new Map();

  const originalXHRMethods = shouldPatchXHR
    ? wrapXHR(bus, config, xhrPrototype, context, pending)
    : undefined;

  if (shouldPatchFetch) {
    globalThis.fetch = wrapFetch(bus, config, originalFetch, context, pending);
  }

  const unregisterPendingProvider = context?.registerStateProvider?.(
    "network.pending",
    () =>
      Array.from(pending.values()).map((request) => ({
        method: request.method,
        url: request.url,
        ageMs: now() - request.startTime,
      })),
  );

  // Each restore runs on its own. This cleanup undoes several independent patches, and a host
  // that has since frozen one of them — a non-writable `globalThis.fetch`, a sealed XHR
  // prototype — throws on assignment. Sequentially, that first throw skipped every restore after
  // it, leaving the rest of the collector patched in with no teardown left to remove it.
  const step = (restore: () => void): boolean => {
    try {
      restore();
      return true;
    } catch {
      return false;
    }
  };

  return () => {
    let restored = true;

    if (shouldPatchFetch) {
      restored =
        step(() => {
          globalThis.fetch = originalFetch;
        }) && restored;
    }

    if (shouldPatchXHR && originalXHRMethods) {
      const methods = originalXHRMethods;
      restored =
        step(() => {
          xhrPrototype.open = methods.origOpen;
        }) && restored;
      restored =
        step(() => {
          xhrPrototype.send = methods.origSend;
        }) && restored;
      restored =
        step(() => {
          xhrPrototype.setRequestHeader = methods.origSetRequestHeader;
        }) && restored;
    }

    restored = step(() => unregisterPendingProvider?.()) && restored;
    restored = step(() => pending.clear()) && restored;

    // Reported, not swallowed: the caller's teardown handler is what stops a half-restored
    // collector from being installed over a second time.
    if (!restored)
      throw new Error("network collector could not fully restore its patches");
  };
}
