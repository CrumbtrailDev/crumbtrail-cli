import type { BugEvent, RedactionMetadata } from "crumbtrail-core";
import { mergeRedactionMetadata, redactNetworkTextBody } from "crumbtrail-core";
import {
  CRUMBTRAIL_REQUEST_HEADER,
  buildBackendRequestEndEvent,
  buildBackendRequestErrorEvent,
  buildBackendRequestStartEvent,
  type BackendRequestHeaders,
} from "./backend-events";
import {
  sendBackendEvent,
  type BackendIntakeWarning,
  type BackendIntakeWarningKind,
} from "./backend-intake";
import {
  buildBackendWarningEvent,
  installBackendWarningCapture,
  type BackendWarningCaptureHandle,
} from "./backend-warnings";

export type {
  BackendIntakeWarning as CrumbtrailExpressWarning,
  BackendIntakeWarningKind as CrumbtrailExpressWarningKind,
};

export type CrumbtrailExpressNext = (error?: unknown) => void;
export type CrumbtrailExpressErrorNext = (error: unknown) => void;

export interface CrumbtrailExpressRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  route?: string | { path?: unknown };
  headers?: BackendRequestHeaders;
  /** Populated by a body parser mounted before this middleware. */
  body?: unknown;
}

export interface CrumbtrailExpressResponse {
  statusCode?: number;
  once?: (event: "finish", listener: () => void) => unknown;
  /**
   * Present on a real ServerResponse. Typed as `unknown` rather than with
   * signatures: express's own `Response` declares overloaded `write` / `end`,
   * and any narrower declaration here makes the middleware unassignable to
   * `RequestHandler` at the host application's call site.
   */
  getHeader?: unknown;
  write?: unknown;
  end?: unknown;
}

export type CrumbtrailExpressMiddleware = (
  req: CrumbtrailExpressRequest,
  res: CrumbtrailExpressResponse,
  next: CrumbtrailExpressNext,
) => void;

export type CrumbtrailExpressErrorMiddleware = (
  error: unknown,
  req: CrumbtrailExpressRequest,
  res: CrumbtrailExpressResponse,
  next: CrumbtrailExpressErrorNext,
) => void;

type RequestValueResolver =
  string | undefined | ((req: CrumbtrailExpressRequest) => string | undefined);
type SessionStartedAtResolver =
  | number
  | Date
  | undefined
  | ((req: CrumbtrailExpressRequest) => number | Date | undefined);
type NowResolver = () => number;

type FetchLike = Parameters<typeof sendBackendEvent>[0]["fetch"];

export interface CrumbtrailExpressOptions {
  sessionId?: RequestValueResolver;
  requestId?: RequestValueResolver;
  endpoint?: string;
  authToken?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  sessionStartedAt?: SessionStartedAtResolver;
  now?: NowResolver;
  onWarning?: (warning: BackendIntakeWarning) => void;
  /**
   * Capture `process.on("warning")` runtime warnings (MaxListenersExceeded,
   * deprecations) into the session the middleware most recently saw. Default
   * on: these warnings are the platform naming a defect the application never
   * logs, and the express path was previously blind to them while the
   * autoCapture path recorded them.
   */
  captureRuntimeWarnings?: boolean;
  /**
   * Capture the request and response payloads onto `backend.req.end`, redacted
   * with the same policy the browser transport applies.
   *
   * Default on. Without it a backend-only exchange reaches the session as a
   * method, a URL, a status code and a duration — which settles a failure that
   * threw and nothing else. Every defect whose evidence is the VALUE the server
   * returned (a total that is an hour out, a sum that will not reconcile, an
   * expiry judged against the wrong clock) is undiagnosable from a status code,
   * and those requests are exactly the ones no browser made: jobs, webhooks,
   * service-to-service calls, CLIs.
   */
  captureBodies?: boolean;
  /** Cap on captured characters per payload. Default 4096, hard max 16384. */
  maxBodyChars?: number;
  /**
   * Field names exempted from the built-in name-based deny rules, and field
   * names always denied. Same semantics as the browser's
   * `config.redaction.keepFields` / `denyFields`, and passed to the same
   * classifier — a keep never disables the value-based checks, so a token or a
   * card number inside a kept field is still redacted.
   */
  keepFields?: string[];
  denyFields?: string[];
}

interface RequestState {
  startedAtMs: number;
  sessionId?: string;
  requestId: string;
  /** Response chunks accumulated by the write/end wrappers, already capped. */
  responseChunks?: string[];
  responseChars?: number;
  responseTruncated?: boolean;
}

const DEFAULT_MAX_BODY_CHARS = 4096;
const HARD_MAX_BODY_CHARS = 16_384;

/**
 * Content types worth reading. A response the app produced as text in any
 * structured dialect is evidence; an image, a font or a zip is bytes that would
 * cost the session its size budget and tell an agent nothing.
 *
 * Written as the set of text-bearing families rather than a list of exact types,
 * so a JSON:API, an ndjson stream, a SOAP envelope or a GraphQL response is
 * captured on the same terms as plain `application/json` — none of these needs
 * its own entry.
 */
const CAPTURABLE_CONTENT_TYPE =
  /^(text\/|application\/(json|xml|graphql|csv|yaml|x-ndjson|ld\+json|x-www-form-urlencoded)|application\/[\w.+-]*\+(json|xml))/i;

const requestStates = new WeakMap<CrumbtrailExpressRequest, RequestState>();

/** Exposed for tests: the gate that decides whether a payload is evidence. */
export function isCapturableContentTypeForTest(contentType: string): boolean {
  return CAPTURABLE_CONTENT_TYPE.test(contentType.trim());
}

/**
 * How long after the last request that carried a session a process warning is
 * still attributed to that session. A MaxListenersExceededWarning fires
 * synchronously inside the request that crossed the threshold, so the common
 * case is microseconds, not minutes; the window only bounds the tail so a
 * warning during a long idle gap is dropped rather than pinned to a session
 * that plausibly ended (matching autoCapture, which drops while dark).
 */
const WARNING_SESSION_FRESH_MS = 120_000;

export interface CrumbtrailExpressMiddlewareWithHandle
  extends CrumbtrailExpressMiddleware {
  /** Present when runtime warning capture installed; `stop()` releases it. */
  crumbtrailWarningCapture?: BackendWarningCaptureHandle;
}

export function createCrumbtrailExpressMiddleware(
  options: CrumbtrailExpressOptions = {},
): CrumbtrailExpressMiddlewareWithHandle {
  let lastSession: { sessionId: string; atMs: number } | undefined;

  const middleware: CrumbtrailExpressMiddlewareWithHandle =
    function crumbtrailExpressMiddleware(req, res, next) {
      const startedAtMs = readNow(options);
      const startEvent = buildBackendRequestStartEvent({
        ...readRequestInput(req, options),
        now: startedAtMs,
      });
      const state = stateFromEvent(startEvent, startedAtMs);
      requestStates.set(req, state);
      exposeRequestIdHeader(req, state);
      if (state.sessionId) {
        lastSession = { sessionId: state.sessionId, atMs: startedAtMs };
      }

      if (options.captureBodies !== false) captureResponseBody(res, state, options);
      attemptSend(startEvent, options, state.sessionId);
      attachFinishListener(req, res, options, state);

      next();
    };

  if (options.captureRuntimeWarnings !== false) {
    try {
      middleware.crumbtrailWarningCapture = installBackendWarningCapture({
        emit: (event) => {
          const now = readNow(options);
          const session =
            lastSession && now - lastSession.atMs <= WARNING_SESSION_FRESH_MS
              ? lastSession.sessionId
              : undefined;
          // No live session means nowhere for the event to land: the intake
          // path addresses an existing session, so an unattributed warning is
          // dropped rather than misfiled.
          if (!session) return;
          const stamped = buildBackendWarningEvent(
            {
              name: typeof event.d.name === "string" ? event.d.name : undefined,
              message:
                typeof event.d.message === "string"
                  ? event.d.message
                  : undefined,
              stack:
                typeof event.d.stack === "string" ? event.d.stack : undefined,
            },
            { sessionId: session, now },
          );
          attemptSend(stamped, options, session);
        },
      });
    } catch {
      // Warning capture is additive; its failure must not break the request path.
    }
  }

  return middleware;
}

export function createCrumbtrailExpressErrorMiddleware(
  options: CrumbtrailExpressOptions = {},
): CrumbtrailExpressErrorMiddleware {
  return function crumbtrailExpressErrorMiddleware(error, req, res, next) {
    const now = readNow(options);
    const existingState = requestStates.get(req);
    const state = existingState ?? createMinimalState(req, options, now);
    if (!existingState) requestStates.set(req, state);
    exposeRequestIdHeader(req, state);

    const errorEvent = buildBackendRequestErrorEvent({
      ...readRequestInput(req, options, state),
      now,
      statusCode: safeStatusCode(res.statusCode),
      durationMs: now - state.startedAtMs,
      error,
    });

    attemptSend(errorEvent, options, state.sessionId);
    next(error);
  };
}

function attachFinishListener(
  req: CrumbtrailExpressRequest,
  res: CrumbtrailExpressResponse,
  options: CrumbtrailExpressOptions,
  state: RequestState,
): void {
  if (typeof res.once !== "function") return;

  res.once("finish", () => {
    const now = readNow(options);
    const endEvent = buildBackendRequestEndEvent({
      ...readRequestInput(req, options, state),
      now,
      statusCode: safeStatusCode(res.statusCode),
      durationMs: now - state.startedAtMs,
      ...readBodies(req, res, state, options),
    });

    attemptSend(endEvent, options, state.sessionId);
  });
}

/**
 * Wraps `res.write` / `res.end` so the payload the application sent is
 * available at finish time. Chunks are accumulated as text up to the cap and
 * the wrappers always delegate, so a capture failure cannot change what the
 * client receives.
 */
function captureResponseBody(
  res: CrumbtrailExpressResponse,
  state: RequestState,
  options: CrumbtrailExpressOptions,
): void {
  const originalWrite = res.write;
  const originalEnd = res.end;
  if (typeof originalWrite !== "function" || typeof originalEnd !== "function")
    return;

  const cap = bodyCharCap(options);
  state.responseChunks = [];
  state.responseChars = 0;

  const absorb = (chunk: unknown): void => {
    if (chunk === undefined || chunk === null) return;
    if ((state.responseChars ?? 0) >= cap) {
      state.responseTruncated = true;
      return;
    }
    let text: string | undefined;
    if (typeof chunk === "string") text = chunk;
    else if (isBufferLike(chunk)) text = decodeBufferLike(chunk);
    if (text === undefined) return;
    const room = cap - (state.responseChars ?? 0);
    if (text.length > room) {
      state.responseTruncated = true;
      text = text.slice(0, room);
    }
    state.responseChunks?.push(text);
    state.responseChars = (state.responseChars ?? 0) + text.length;
  };

  res.write = function wrappedWrite(this: unknown, ...args: unknown[]) {
    try {
      absorb(args[0]);
    } catch {
      // Capture is additive; never let it break a response.
    }
    return (originalWrite as (...a: unknown[]) => unknown).apply(this, args);
  };

  res.end = function wrappedEnd(this: unknown, ...args: unknown[]) {
    try {
      if (typeof args[0] !== "function") absorb(args[0]);
    } catch {
      // As above.
    }
    return (originalEnd as (...a: unknown[]) => unknown).apply(this, args);
  };
}

function readBodies(
  req: CrumbtrailExpressRequest,
  res: CrumbtrailExpressResponse,
  state: RequestState,
  options: CrumbtrailExpressOptions,
): {
  body?: unknown;
  bodySummary?: unknown;
  reqBody?: unknown;
  reqBodySummary?: unknown;
  bodyRedaction?: RedactionMetadata;
} {
  if (options.captureBodies === false) return {};
  const out: {
    body?: unknown;
    bodySummary?: unknown;
    reqBody?: unknown;
    reqBodySummary?: unknown;
    bodyRedaction?: RedactionMetadata;
  } = {};
  const metadata: Array<RedactionMetadata | undefined> = [];

  try {
    const request = redactBodyValue(req.body, "reqBody", options);
    if (request) {
      out.reqBody = request.body;
      if (request.bodySummary) out.reqBodySummary = request.bodySummary;
      metadata.push(request.metadata);
    }
  } catch {
    // A body that cannot be serialized is simply not captured.
  }

  try {
    if (isCapturableResponse(res, state)) {
      const text = (state.responseChunks ?? []).join("");
      const response = redactBodyValue(text, "body", options);
      if (response) {
        out.body = response.body;
        if (response.bodySummary) out.bodySummary = response.bodySummary;
        metadata.push(response.metadata);
      }
    }
  } catch {
    // As above.
  }

  const merged = mergeRedactionMetadata(...metadata);
  if (merged) out.bodyRedaction = merged;
  return out;
}

function isCapturableResponse(
  res: CrumbtrailExpressResponse,
  state: RequestState,
): boolean {
  if (!state.responseChunks || state.responseChunks.length === 0) return false;
  const raw =
    typeof res.getHeader === "function"
      ? res.getHeader("content-type")
      : undefined;
  const contentType = Array.isArray(raw) ? raw[0] : raw;
  // No content type at all: a hand-rolled response is more likely text than a
  // binary blob, and the redactor handles whatever it turns out to be.
  if (typeof contentType !== "string") return true;
  return CAPTURABLE_CONTENT_TYPE.test(contentType.trim());
}

function redactBodyValue(
  value: unknown,
  path: string,
  options: CrumbtrailExpressOptions,
):
  | { body: unknown; bodySummary?: unknown; metadata?: RedactionMetadata }
  | undefined {
  const text = serializeBody(value, bodyCharCap(options));
  if (text === undefined) return undefined;
  const result = redactNetworkTextBody(text, {
    path,
    mode: "structured",
    ...(options.keepFields ? { keepFields: options.keepFields } : {}),
    ...(options.denyFields ? { denyFields: options.denyFields } : {}),
  } as Parameters<typeof redactNetworkTextBody>[1]);
  if (result.body === undefined && result.bodySummary === undefined)
    return undefined;
  return {
    body: result.body,
    ...(result.bodySummary ? { bodySummary: result.bodySummary } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

function serializeBody(value: unknown, cap: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string")
    return value.length > 0 ? value.slice(0, cap) : undefined;
  if (isBufferLike(value)) return decodeBufferLike(value)?.slice(0, cap);
  if (typeof value !== "object") return String(value).slice(0, cap);
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" && text !== "{}"
      ? text.slice(0, cap)
      : undefined;
  } catch {
    return undefined;
  }
}

function isBufferLike(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function decodeBufferLike(value: ArrayBufferView): string | undefined {
  try {
    const decoded = (value as { toString?: unknown }).toString;
    if (typeof decoded === "function")
      return (decoded as (enc: string) => string).call(value, "utf8");
  } catch {
    return undefined;
  }
  return undefined;
}

function bodyCharCap(options: CrumbtrailExpressOptions): number {
  const requested = options.maxBodyChars;
  if (!Number.isFinite(requested)) return DEFAULT_MAX_BODY_CHARS;
  return Math.max(0, Math.min(HARD_MAX_BODY_CHARS, Math.round(requested as number)));
}

function exposeRequestIdHeader(
  req: CrumbtrailExpressRequest,
  state: RequestState,
): void {
  if (!state.requestId) return;
  req.headers ??= {};
  const existingKey = Object.keys(req.headers).find(
    (key) => key.toLowerCase() === CRUMBTRAIL_REQUEST_HEADER,
  );
  if (!existingKey) req.headers[CRUMBTRAIL_REQUEST_HEADER] = state.requestId;
}

function createMinimalState(
  req: CrumbtrailExpressRequest,
  options: CrumbtrailExpressOptions,
  now: number,
): RequestState {
  const event = buildBackendRequestStartEvent({
    ...readRequestInput(req, options),
    now,
  });
  return stateFromEvent(event, now);
}

function stateFromEvent(event: BugEvent, startedAtMs: number): RequestState {
  const requestId =
    typeof event.d.requestId === "string" ? event.d.requestId : "unknown";
  const sessionId =
    typeof event.sessionId === "string"
      ? event.sessionId
      : typeof event.d.sessionId === "string"
        ? event.d.sessionId
        : undefined;
  return { startedAtMs, requestId, sessionId };
}

function readRequestInput(
  req: CrumbtrailExpressRequest,
  options: CrumbtrailExpressOptions,
  state?: RequestState,
) {
  return {
    method: req.method,
    url: req.url,
    originalUrl: req.originalUrl,
    path: req.path,
    route: readRoute(req),
    headers: req.headers,
    sessionId: state?.sessionId ?? resolveRequestValue(options.sessionId, req),
    requestId: state?.requestId ?? resolveRequestValue(options.requestId, req),
    sessionStartedAt: resolveSessionStartedAt(options.sessionStartedAt, req),
    ...(state
      ? {}
      : {
          emit: (event: BugEvent) =>
            attemptSend(event, options, event.sessionId),
        }),
  };
}

function readRoute(req: CrumbtrailExpressRequest): string | undefined {
  if (typeof req.route === "string") return req.route;
  if (req.route && typeof req.route.path === "string") return req.route.path;
  return undefined;
}

function resolveRequestValue(
  value: RequestValueResolver,
  req: CrumbtrailExpressRequest,
): string | undefined {
  try {
    return typeof value === "function" ? value(req) : value;
  } catch {
    return undefined;
  }
}

function resolveSessionStartedAt(
  value: SessionStartedAtResolver,
  req: CrumbtrailExpressRequest,
): number | Date | undefined {
  try {
    return typeof value === "function" ? value(req) : value;
  } catch {
    return undefined;
  }
}

function readNow(options: CrumbtrailExpressOptions): number {
  try {
    const value = options.now?.() ?? Date.now();
    return Number.isFinite(value) ? Math.round(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function safeStatusCode(statusCode: number | undefined): number | undefined {
  return Number.isFinite(statusCode) ? statusCode : undefined;
}

function attemptSend(
  event: BugEvent,
  options: CrumbtrailExpressOptions,
  sessionId?: string,
): void {
  void sendBackendEvent({
    event,
    sessionId,
    endpoint: options.endpoint,
    authToken: options.authToken,
    fetch: options.fetch,
    signal: options.signal,
    onWarning: options.onWarning,
  }).catch(() => {
    // sendBackendEvent is expected to resolve all degraded intake states. This
    // final catch keeps host application responses safe if that contract changes.
  });
}
