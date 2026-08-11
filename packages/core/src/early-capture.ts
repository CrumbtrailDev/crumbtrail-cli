import {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER,
  W3C_TRACEPARENT_HEADER,
  canInjectCorrelationHeaders,
  resolveOutboundCorrelation,
} from "./correlation";
import { captureCodeOrigin } from "./code-origin";
import { createWebSessionStore } from "./session-store";
import { DEFAULT_CONFIG } from "./types";
import { generateSessionId } from "./utils";

/**
 * First-fetch capture, installed before the SDK exists.
 *
 * Adopters initialize Crumbtrail from an async import, so the requests that
 * render the first screen complete before the network patch is installed:
 * no `net.req`, no correlation header on the wire, and therefore no backend or
 * database evidence for the one request most likely to carry the bug.
 * `crumbtrail-core/early` is a side-effect import for the top of the entry
 * file. It patches `fetch` and `XMLHttpRequest` synchronously, stamps the same
 * correlation headers the live collector stamps, and parks bounded per-request
 * metadata on a well-known global until `Crumbtrail.init()` drains it through
 * the normal (redacting) capture pipeline.
 *
 * Invariants: no configuration, no network of its own, never throws into the
 * page, safe to import twice, and self-limiting — if `init()` never arrives
 * within {@link EARLY_IDLE_TIMEOUT_MS} the queue is cleared and recording
 * stops, leaving the patch installed as a pass-through.
 *
 * Body text rests in the queue unredacted, in page memory only. The single
 * path out is the drain, which runs every field through the same redaction the
 * live collector uses; anything not drained is discarded by `stop()`.
 */

/** Well-known global the SDK looks for at init. */
export const EARLY_GLOBAL_KEY = "__crumbtrailEarly";
/** Bumped when the queue record shape changes; a mismatch is ignored, not migrated. */
export const EARLY_QUEUE_VERSION = 1;
export const EARLY_MAX_ENTRIES = 50;
/** Hard ceiling on queued body text. Metadata keeps recording once it is hit. */
export const EARLY_MAX_BYTES = 2_097_152;
/** Per-body ceiling, matching the response-summary ceiling in the network collector. */
export const EARLY_MAX_BODY_BYTES = 32_768;
/** Recording window when `Crumbtrail.init()` never runs. */
export const EARLY_IDLE_TIMEOUT_MS = 60_000;

export interface EarlyRequestRecord {
  method: string;
  url: string;
  /** Request start, epoch ms — replayed verbatim as the `net.req` timestamp. */
  t: number;
  dur: number;
  transport: "fetch" | "xhr";
  sessionId: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  status?: number;
  /** Request content-type, needed to route the body through the right redaction. */
  reqCt?: string;
  /** Response content-type. */
  ct?: string;
  reqBody?: string;
  resBody?: string;
  /** Set instead of `status` when the request never produced a response. */
  err?: string;
  /**
   * App frames that issued this request, innermost first, as `url:line:col`.
   *
   * Captured here and not at the drain because by then the stack is gone: this
   * patch is the only code standing in the call path during the blind window,
   * and the blind window is where a page's first data load lives. Like the body
   * text above it, the value rests in page memory and leaves only through the
   * drain, which is where configuration exists to suppress it.
   */
  origin?: string[];
}

export interface EarlyCapture {
  readonly v: number;
  /**
   * Session id minted (or adopted from a persisted session) at import time and
   * stamped on every early request. `Crumbtrail.init()` adopts it so the
   * blind-window requests, the live events, and the backend events stamped by
   * those headers all land in one session.
   */
  readonly sessionId: string;
  entries: EarlyRequestRecord[];
  bytes: number;
  /** True once the SDK has drained: the patch takes no NEW requests. */
  deferred: boolean;
  stopped: boolean;
  /**
   * Hands over the queue. An optional `sink` receives the records that were
   * ALREADY IN FLIGHT when the drain ran and settle afterwards — without it
   * those requests are lost to both sides: the early patch has stopped taking
   * new work, and the live collector patched `fetch` after they were issued.
   * That window is where a page's first data load lives.
   */
  drain(sink?: LateRecordSink): EarlyRequestRecord[];
  stop(): void;
}

/** Receives a request that started under the early patch and settled after the drain. */
export type LateRecordSink = (record: EarlyRequestRecord) => void;

interface EarlyCaptureState extends EarlyCapture {
  _sink?: LateRecordSink;
  _timer?: ReturnType<typeof setTimeout>;
  _fetch?: typeof globalThis.fetch;
  _wrappedFetch?: typeof globalThis.fetch;
  _xhrOpen?: XMLHttpRequest["open"];
  _xhrSend?: XMLHttpRequest["send"];
  _wrappedXhrOpen?: XMLHttpRequest["open"];
  _wrappedXhrSend?: XMLHttpRequest["send"];
}

interface PreparedRequest {
  method: string;
  url: string;
  sessionId: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  reqBody?: string;
  reqCt?: string;
  origin?: string[];
}

const JSON_CONTENT_TYPE = /json/i;

function globalScope(): Record<string, unknown> | undefined {
  try {
    return typeof globalThis === "undefined"
      ? undefined
      : (globalThis as unknown as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/** Reads the queue a previous import installed. Returns undefined for a foreign or stale shape. */
export function readEarlyCapture(): EarlyCapture | undefined {
  try {
    const value = globalScope()?.[EARLY_GLOBAL_KEY];
    if (value == null || typeof value !== "object") return undefined;
    const candidate = value as EarlyCapture;
    if (candidate.v !== EARLY_QUEUE_VERSION) return undefined;
    if (!Array.isArray(candidate.entries)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

/** The session id early capture stamped on the wire, for `Crumbtrail.init()` to adopt. */
export function readEarlySessionId(): string | undefined {
  const capture = readEarlyCapture();
  const sessionId = capture?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : undefined;
}

/**
 * Hands the queued records to the SDK and defers the early patch permanently.
 * Returns an empty list when nothing was queued, the window already expired, or
 * the module was never imported.
 */
export function drainEarlyCapture(
  sink?: LateRecordSink,
): EarlyRequestRecord[] {
  const capture = readEarlyCapture();
  if (!capture || typeof capture.drain !== "function") return [];
  try {
    return capture.drain(sink);
  } catch {
    return [];
  }
}

function byteLength(text: string): number {
  try {
    if (typeof TextEncoder !== "undefined")
      return new TextEncoder().encode(text).length;
  } catch {
    // Fall through to the character-count approximation.
  }
  return text.length;
}

function recordedBytes(record: EarlyRequestRecord): number {
  return (
    (record.reqBody ? byteLength(record.reqBody) : 0) +
    (record.resBody ? byteLength(record.resBody) : 0)
  );
}

function recording(state: EarlyCaptureState): boolean {
  return !state.stopped && !state.deferred;
}

/**
 * May a request that STARTED while recording still be written down?
 *
 * Yes right up until `stop()`. Deferral means "take no new requests", not
 * "abandon the ones already on the wire": those already carry this session's
 * correlation headers, so the backend has recorded them and the browser side
 * would be the only place they are missing.
 */
function settling(state: EarlyCaptureState): boolean {
  return !state.stopped;
}

/**
 * The per-body ceiling without the queue's byte budget, for a record handed
 * straight to the sink. Nothing is being buffered, so there is no budget to
 * charge — only the size cap the collector applies to any body.
 */
function attachDirectBody(
  record: EarlyRequestRecord,
  field: "reqBody" | "resBody",
  text: string | undefined,
): void {
  if (!text) return;
  if (byteLength(text) > EARLY_MAX_BODY_BYTES) return;
  record[field] = text;
}

/**
 * How long a late record waits for its response body before being delivered
 * without one. A streaming or never-closed body must not cost the record.
 */
const LATE_BODY_TIMEOUT_MS = 3_000;

/** Delivers exactly once, however the body read ends. */
function deliverOnce(sink: LateRecordSink, record: EarlyRequestRecord) {
  let sent = false;
  return () => {
    if (sent) return;
    sent = true;
    try {
      sink(record);
    } catch {
      // A throwing sink never becomes the app's problem.
    }
  };
}

function pushRecord(
  state: EarlyCaptureState,
  record: EarlyRequestRecord,
): void {
  state.entries.push(record);
  state.bytes += recordedBytes(record);
  while (state.entries.length > EARLY_MAX_ENTRIES) {
    const dropped = state.entries.shift();
    if (dropped) state.bytes -= recordedBytes(dropped);
  }
}

function attachBody(
  state: EarlyCaptureState,
  record: EarlyRequestRecord,
  field: "reqBody" | "resBody",
  text: string,
): void {
  if (!recording(state)) return;
  if (!text) return;
  // A response body lands asynchronously; the record may already have been
  // evicted by the entry cap, in which case the bytes must not be charged.
  if (!state.entries.includes(record)) return;
  const size = byteLength(text);
  if (size > EARLY_MAX_BODY_BYTES) return;
  if (state.bytes + size > EARLY_MAX_BYTES) return;
  record[field] = text;
  state.bytes += size;
}

function resolveEarlySessionId(): string {
  try {
    // A reload inside the idle window continues the persisted session, exactly
    // as `Crumbtrail.init()` does, so early requests carry the session header
    // init will go on to use.
    const persisted = createWebSessionStore()?.read();
    if (
      persisted &&
      Date.now() - persisted.lastActivity <= DEFAULT_CONFIG.sessionIdleMs
    ) {
      return persisted.id;
    }
  } catch {
    // Storage denied in a sandboxed frame: mint a fresh id instead.
  }
  try {
    return generateSessionId();
  } catch {
    // generateSessionId requires crypto.getRandomValues. Without it the SDK
    // cannot run either, but early capture still must not throw into the page.
    return `ses_early_${Date.now().toString(36)}`;
  }
}

function extractUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  if (typeof Request !== "undefined" && input instanceof Request)
    return input.url;
  return String(input);
}

function extractMethod(input: unknown, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request)
    return input.method.toUpperCase();
  return "GET";
}

function readHeaders(input: unknown, init?: RequestInit): Headers | undefined {
  try {
    if (init?.headers !== undefined) return new Headers(init.headers);
    if (typeof Request !== "undefined" && input instanceof Request)
      return new Headers(input.headers);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stamps the correlation trio the live collector stamps, under the same
 * conditions: same-origin only (early capture has no config, so it cannot honor
 * a cross-origin backend allowlist), and never overwriting a header the caller
 * already set.
 */
function applyCorrelation(
  sessionId: string,
  url: string,
  headers: Headers,
): { requestId?: string; traceId?: string; spanId?: string } {
  if (!canInjectCorrelationHeaders(url)) return {};
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
  return {
    requestId: correlation.requestId,
    traceId: correlation.traceId,
    spanId: correlation.spanId,
  };
}

function isJsonContentType(contentType: string | null | undefined): boolean {
  return Boolean(contentType && JSON_CONTENT_TYPE.test(contentType));
}

function patchFetch(state: EarlyCaptureState): void {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") return;

  const wrapped = function earlyFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (!recording(state)) return originalFetch(input, init);

    let prepared: PreparedRequest | undefined;
    let nextInput: RequestInfo | URL = input;
    let nextInit = init;
    try {
      const url = extractUrl(input);
      const headers = readHeaders(input, init) ?? new Headers();
      const correlation = applyCorrelation(state.sessionId, url, headers);
      const rawBody = init?.body;
      // One frame out: this wrapper is what the app called.
      const origin = captureCodeOrigin(1);
      prepared = {
        method: extractMethod(input, init),
        url,
        sessionId: state.sessionId,
        ...correlation,
        ...(origin ? { origin } : {}),
        ...(typeof rawBody === "string" ? { reqBody: rawBody } : {}),
        ...(headers.get("content-type")
          ? { reqCt: headers.get("content-type") as string }
          : {}),
      };
      nextInit = { ...init, headers };
      nextInput = input;
    } catch {
      prepared = undefined;
      nextInput = input;
      nextInit = init;
    }

    const started = Date.now();
    const response = originalFetch(nextInput, nextInit);
    if (!prepared) return response;
    const request = prepared;

    return response.then(
      (result) => {
        try {
          recordFetchResponse(state, request, started, result);
        } catch {
          // Recording must never disturb the app's response.
        }
        return result;
      },
      (error: unknown) => {
        try {
          recordFailure(state, request, started, error);
        } catch {
          // Same: the page keeps its original rejection.
        }
        throw error;
      },
    );
  };

  globalThis.fetch = wrapped as typeof globalThis.fetch;
  state._fetch = originalFetch;
  state._wrappedFetch = globalThis.fetch;
}

function recordFetchResponse(
  state: EarlyCaptureState,
  request: PreparedRequest,
  started: number,
  response: Response,
): void {
  if (!settling(state)) return;
  const contentType = response.headers?.get("content-type") ?? undefined;
  const record: EarlyRequestRecord = {
    method: request.method,
    url: request.url,
    t: started,
    dur: Date.now() - started,
    transport: "fetch",
    sessionId: request.sessionId,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    ...(request.traceId ? { traceId: request.traceId } : {}),
    ...(request.spanId ? { spanId: request.spanId } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    status: response.status,
    ...(contentType ? { ct: contentType } : {}),
    ...(request.reqCt ? { reqCt: request.reqCt } : {}),
  };
  const sink = state.deferred ? state._sink : undefined;
  if (sink) {
    // In flight across the drain. Nothing is queued — the record goes straight
    // to the live collector, once, after its body has had its chance.
    attachDirectBody(record, "reqBody", request.reqBody);
    const send = deliverOnce(sink, record);
    if (!isJsonContentType(contentType)) {
      send();
      return;
    }
    try {
      setTimeout(send, LATE_BODY_TIMEOUT_MS);
    } catch {
      // No timer available: the body read below is the only path left.
    }
    try {
      response
        .clone()
        .text()
        .then((text) => {
          attachDirectBody(record, "resBody", text);
          send();
        })
        .catch(send);
    } catch {
      send();
    }
    return;
  }

  pushRecord(state, record);
  if (request.reqBody) attachBody(state, record, "reqBody", request.reqBody);
  if (!isJsonContentType(contentType)) return;

  // Read a clone so the app's stream is untouched, and do it off the response
  // path: the page never waits on capture.
  try {
    response
      .clone()
      .text()
      .then((text) => attachBody(state, record, "resBody", text))
      .catch(() => {});
  } catch {
    // Already-consumed or unclonable body: metadata only.
  }
}

function recordFailure(
  state: EarlyCaptureState,
  request: PreparedRequest,
  started: number,
  error: unknown,
): void {
  if (!settling(state)) return;
  const record: EarlyRequestRecord = {
    method: request.method,
    url: request.url,
    t: started,
    dur: Date.now() - started,
    transport: "fetch",
    sessionId: request.sessionId,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    ...(request.traceId ? { traceId: request.traceId } : {}),
    ...(request.spanId ? { spanId: request.spanId } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    err: error instanceof Error ? error.message : String(error),
    ...(request.reqCt ? { reqCt: request.reqCt } : {}),
  };
  const sink = state.deferred ? state._sink : undefined;
  if (sink) {
    attachDirectBody(record, "reqBody", request.reqBody);
    deliverOnce(sink, record)();
    return;
  }
  pushRecord(state, record);
  if (request.reqBody) attachBody(state, record, "reqBody", request.reqBody);
}

function patchXhr(state: EarlyCaptureState): void {
  const prototype = globalThis.XMLHttpRequest?.prototype;
  if (
    !prototype ||
    typeof prototype.open !== "function" ||
    typeof prototype.send !== "function"
  ) {
    return;
  }

  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const meta = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string; started: number }
  >();

  const wrappedOpen = function earlyXhrOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      meta.set(this, {
        method: String(method).toUpperCase(),
        url: typeof url === "string" ? url : String(url),
        started: 0,
      });
    } catch {
      // Never block the open.
    }
    return (
      originalOpen as unknown as (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...args: unknown[]
      ) => void
    ).call(this, method, url, ...rest);
  };

  const wrappedSend = function earlyXhrSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const entry = meta.get(this);
    if (!entry || !recording(state)) return originalSend.call(this, body);

    let request: PreparedRequest | undefined;
    try {
      const headers = new Headers();
      const correlation = applyCorrelation(
        state.sessionId,
        entry.url,
        headers,
      );
      headers.forEach((value, name) => {
        try {
          this.setRequestHeader(name, value);
        } catch {
          // Header rejected (wrong readyState): the request still goes out.
        }
      });
      // One frame out: `send()` is what the app called.
      const origin = captureCodeOrigin(1);
      request = {
        method: entry.method,
        url: entry.url,
        sessionId: state.sessionId,
        ...correlation,
        ...(origin ? { origin } : {}),
        ...(typeof body === "string" ? { reqBody: body } : {}),
      };
    } catch {
      request = undefined;
    }

    if (request) {
      const pending = request;
      entry.started = Date.now();
      const finish = () => {
        try {
          if (!settling(state)) return;
          const contentType =
            this.getResponseHeader?.("content-type") ?? undefined;
          const record: EarlyRequestRecord = {
            method: pending.method,
            url: pending.url,
            t: entry.started,
            dur: Date.now() - entry.started,
            transport: "xhr",
            sessionId: pending.sessionId,
            ...(pending.requestId ? { requestId: pending.requestId } : {}),
            ...(pending.traceId ? { traceId: pending.traceId } : {}),
            ...(pending.spanId ? { spanId: pending.spanId } : {}),
            ...(pending.origin ? { origin: pending.origin } : {}),
            status: this.status,
            ...(contentType ? { ct: contentType } : {}),
          };
          // responseText throws for a non-text responseType.
          const responseText = () => {
            try {
              return isJsonContentType(contentType)
                ? this.responseText
                : undefined;
            } catch {
              return undefined;
            }
          };

          const sink = state.deferred ? state._sink : undefined;
          if (sink) {
            // Already settled by the time we are here, so unlike fetch there is
            // nothing to wait for: body and record go together.
            attachDirectBody(record, "reqBody", pending.reqBody);
            attachDirectBody(record, "resBody", responseText());
            deliverOnce(sink, record)();
            return;
          }

          pushRecord(state, record);
          if (pending.reqBody)
            attachBody(state, record, "reqBody", pending.reqBody);
          const text = responseText();
          if (text) attachBody(state, record, "resBody", text);
        } catch {
          // Recording must never break the app's XHR handlers.
        }
      };
      try {
        this.addEventListener("loadend", finish);
      } catch {
        // Without loadend the request is simply not recorded.
      }
    }

    return originalSend.call(this, body);
  };

  prototype.open = wrappedOpen as XMLHttpRequest["open"];
  prototype.send = wrappedSend as XMLHttpRequest["send"];
  state._xhrOpen = originalOpen;
  state._xhrSend = originalSend;
  state._wrappedXhrOpen = prototype.open;
  state._wrappedXhrSend = prototype.send;
}

/**
 * Installs the patches and the queue. Idempotent: a second import (or a second
 * bundled copy) finds the existing queue on the global and returns it
 * untouched. Never throws.
 */
export function installEarlyCapture(): EarlyCapture | undefined {
  try {
    const scope = globalScope();
    if (!scope) return undefined;
    const existing = readEarlyCapture();
    if (existing) return existing;

    const state: EarlyCaptureState = {
      v: EARLY_QUEUE_VERSION,
      sessionId: resolveEarlySessionId(),
      entries: [],
      bytes: 0,
      deferred: false,
      stopped: false,
      drain(sink?: LateRecordSink) {
        this.deferred = true;
        this._sink = typeof sink === "function" ? sink : undefined;
        if (this._timer !== undefined) {
          clearTimeout(this._timer);
          this._timer = undefined;
        }
        const drained = this.entries;
        this.entries = [];
        this.bytes = 0;
        return drained;
      },
      stop() {
        this.stopped = true;
        this._sink = undefined;
        this.entries = [];
        this.bytes = 0;
        if (this._timer !== undefined) {
          clearTimeout(this._timer);
          this._timer = undefined;
        }
      },
    };

    Object.defineProperty(scope, EARLY_GLOBAL_KEY, {
      value: state,
      configurable: true,
      writable: true,
      enumerable: false,
    });

    patchFetch(state);
    patchXhr(state);

    // No init inside the window means no SDK is coming: drop what was recorded
    // rather than holding page memory for a session that will never exist. The
    // patches stay installed as pass-throughs — restoring them could clobber a
    // wrapper a third party installed on top of ours.
    state._timer = setTimeout(() => state.stop(), EARLY_IDLE_TIMEOUT_MS);

    return state;
  } catch {
    return undefined;
  }
}

/**
 * Removes the queue and restores the patches when they are still ours. Exists
 * for tests and for a host that tears the SDK down completely; the shipped
 * `crumbtrail-core/early` entry never calls it.
 */
export function uninstallEarlyCapture(): void {
  try {
    const state = readEarlyCapture() as EarlyCaptureState | undefined;
    const scope = globalScope();
    if (state) {
      state.stop();
      if (state._wrappedFetch && globalThis.fetch === state._wrappedFetch) {
        globalThis.fetch = state._fetch as typeof globalThis.fetch;
      }
      const prototype = globalThis.XMLHttpRequest?.prototype;
      if (prototype) {
        if (state._wrappedXhrOpen && prototype.open === state._wrappedXhrOpen)
          prototype.open = state._xhrOpen as XMLHttpRequest["open"];
        if (state._wrappedXhrSend && prototype.send === state._wrappedXhrSend)
          prototype.send = state._xhrSend as XMLHttpRequest["send"];
      }
    }
    if (scope) delete scope[EARLY_GLOBAL_KEY];
  } catch {
    // Teardown is best effort by design.
  }
}
