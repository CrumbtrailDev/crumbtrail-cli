import { buildCaptureGapEvent, type BugEvent } from "crumbtrail-core";
import {
  attachResponseRecorder,
  readResponseEvidence,
  safeStatusCode,
  type ResponseRecorder,
} from "./backend-response";
import { claimBackendRequest } from "./backend-request-claim";
import { getProcessSessionId } from "./process-session";
import {
  getBackendRequestContext,
  runInBackendRequestContext,
  updateBackendRequestContext,
} from "./request-context";
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
import {
  installBackendLogCapture,
  type BackendLogCaptureHandle,
  type BackendLogCaptureOptions,
  type BackendLogLevel,
} from "./backend-logs";

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
}

export interface CrumbtrailExpressResponse {
  statusCode?: number;
  /**
   * True once the response body has been fully handed to the socket. Read on
   * `close` to tell a completed response from one the peer cut short.
   */
  writableEnded?: boolean;
  once?: (event: "finish" | "close", listener: () => void) => unknown;
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
   * Extra delivery attempts after a transport level rejection, forwarded to the
   * intake client. Defaults to the intake client's own default; set to 0 to
   * send each event exactly once.
   */
  retries?: number;
  /** Delay between delivery attempts, in milliseconds. */
  retryDelayMs?: number;
  /**
   * Capture `process.on("warning")` runtime warnings (MaxListenersExceeded,
   * deprecations) into the session the middleware most recently saw. Default
   * on: these warnings are the platform naming a defect the application never
   * logs, and the express path was previously blind to them while the
   * autoCapture path recorded them.
   */
  captureRuntimeWarnings?: boolean;
  /**
   * Capture structured log lines (pino, winston, bunyan) the process writes as
   * `backend.log` events in the session the middleware most recently saw.
   * Default on, and for the same reason as the warning capture above: a handled
   * failure is logged and answered, never thrown and never printed to the
   * console, so without this the middleware records the request's status code
   * and nothing about why.
   */
  captureLogs?: boolean;
  /** Lowest log level captured. Defaults to `warn`. */
  logLevel?: BackendLogLevel;
  /** Streams and `fs` the log capture patches (tests). Defaults to the process's. */
  logStreams?: Pick<
    BackendLogCaptureOptions,
    "stdout" | "stderr" | "fsImpl" | "maxEvents"
  >;
  /**
   * Whether to record the response body on `backend.req.end`.
   *
   * `"error"` (default) captures it for 4xx and 5xx only, which is where the
   * text that explains a failure lives and where a bundle is otherwise left
   * holding a status code. `"all"` also captures successful responses, for the
   * failures that answer 200 and lie about what they did. `"off"` restores the
   * previous behavior.
   *
   * Whatever is captured goes through the same redaction policy as the browser
   * plane before it is sent.
   */
  captureResponseBody?: "off" | "error" | "all";
  /**
   * Repo root used to make the 5xx response callsite repo-relative. Defaults to
   * `process.cwd()`, matching the database instrumentation's `callsiteRoot`.
   */
  callsiteRoot?: string;
  /** Cap on captured response bytes. Beyond it the body is truncated and marked. */
  responseBodyMaxBytes?: number;
  /**
   * Response headers to record, lowercase. Replaces the default allowlist
   * rather than extending it, so a caller can never widen it by accident.
   */
  responseHeaderAllowlist?: readonly string[];
  /**
   * Field names to exempt from the name-based redaction rules, the backend
   * counterpart of the browser SDK's `redaction.keepFields`.
   *
   * Give it the same list both planes, or the same field is readable in a
   * captured request and placeholdered in the response that answered it. The
   * exemption is name-scoped only: every value-based check still runs, so an
   * email, a card number or a high-entropy token under a kept name is still
   * redacted. The list is carried in the event's policy declaration, so the
   * capture server's re-classification honors it instead of undoing it at rest.
   */
  keepFields?: readonly string[];
}

/** Test seam for the content-type gate. Not part of the middleware's contract. */
export { isCapturableContentTypeForTest } from "./backend-response";

interface RequestState {
  startedAtMs: number;
  sessionId?: string;
  /**
   * True when `sessionId` is the process's own capture session rather than one
   * a browser or a caller correlated. Kept so the request's later events resolve
   * the same fallback instead of presenting it as an explicit option, and so a
   * process-owned request never becomes the session a runtime warning or a log
   * line is attributed to (`autoCapture` already records those itself).
   */
  sessionFromProcess?: boolean;
  requestId: string;
  /**
   * Set the moment the request's terminal event is built. `finish` and `close`
   * both fire for an ordinary response, so without this a request would report
   * two ends; with it, whichever fires first owns the terminal event.
   */
  settled?: boolean;
}

const requestStates = new WeakMap<CrumbtrailExpressRequest, RequestState>();

/**
 * How long after the last request that carried a session a process warning is
 * still attributed to that session. A MaxListenersExceededWarning fires
 * synchronously inside the request that crossed the threshold, so the common
 * case is microseconds, not minutes; the window only bounds the tail so a
 * warning during a long idle gap is dropped rather than pinned to a session
 * that plausibly ended (matching autoCapture, which drops while dark).
 */
const WARNING_SESSION_FRESH_MS = 120_000;

export interface CrumbtrailExpressMiddlewareWithHandle extends CrumbtrailExpressMiddleware {
  /** Present when runtime warning capture installed; `stop()` releases it. */
  crumbtrailWarningCapture?: BackendWarningCaptureHandle;
  /** Present when structured log capture installed; `stop()` restores the writes. */
  crumbtrailLogCapture?: BackendLogCaptureHandle;
}

export function createCrumbtrailExpressMiddleware(
  options: CrumbtrailExpressOptions = {},
): CrumbtrailExpressMiddlewareWithHandle {
  let lastSession: { sessionId: string; atMs: number } | undefined;

  const middleware: CrumbtrailExpressMiddlewareWithHandle =
    function crumbtrailExpressMiddleware(req, res, next) {
      // Take ownership before recording anything. `autoCapture` installs a
      // `node:http` recorder in most processes, and it defers its own events
      // until the response settles precisely so this claim can win: this
      // middleware knows the matched route and the error the handler threw.
      claimBackendRequest(req);
      const startedAtMs = readNow(options);
      const startEvent = buildBackendRequestStartEvent({
        ...readRequestInput(req, options),
        now: startedAtMs,
      });
      const state = stateFromEvent(startEvent, startedAtMs);
      requestStates.set(req, state);
      exposeRequestIdHeader(req, state);
      if (state.sessionId && !state.sessionFromProcess) {
        lastSession = { sessionId: state.sessionId, atMs: startedAtMs };
      }

      attemptSend(startEvent, options, state.sessionId);
      attachFinishListener(req, res, options, state);

      // The rest of the chain — every later middleware, the route handler, and
      // everything they await — runs knowing which request it is inside, so a
      // log line the handler writes carries THIS request's id rather than a
      // second one the logger minted. The claim above means this middleware's
      // ids are the ones the request's events carry, so they overwrite an http
      // recorder's store rather than deferring to it.
      const correlation = {
        requestId: state.requestId,
        sessionId: state.sessionId,
        sessionIdSource: sessionIdSourceOf(startEvent) ?? "missing",
      };
      if (getBackendRequestContext()) {
        updateBackendRequestContext(correlation);
        next();
        return;
      }
      runInBackendRequestContext(correlation, () => {
        next();
      });
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

  if (options.captureLogs !== false) {
    try {
      middleware.crumbtrailLogCapture = installBackendLogCapture({
        minLevel: options.logLevel,
        ...options.logStreams,
        emit: (event) => {
          const now = readNow(options);
          // A line written INSIDE a request already resolved its own session
          // and carries that request's id; the "most recent session" guess is
          // only for lines written between requests. Preferring the guess here
          // would refile a correlated line onto whichever session happened to
          // be last, which on a server handling two users at once is the wrong
          // one.
          const session =
            (typeof event.sessionId === "string" && event.sessionId
              ? event.sessionId
              : undefined) ??
            (lastSession && now - lastSession.atMs <= WARNING_SESSION_FRESH_MS
              ? lastSession.sessionId
              : undefined);
          // Same rule as the warning capture: the intake path addresses an
          // existing session, so a line with no live session is dropped rather
          // than misfiled onto one that plausibly ended.
          if (!session) return;
          attemptSend({ ...event, sessionId: session }, options, session);
        },
      });
    } catch {
      // Log capture is additive; its failure must not break the request path.
    }
  }

  return middleware;
}

export function createCrumbtrailExpressErrorMiddleware(
  options: CrumbtrailExpressOptions = {},
): CrumbtrailExpressErrorMiddleware {
  return function crumbtrailExpressErrorMiddleware(error, req, res, next) {
    // Also claims: an app that wired only the error middleware still owns its
    // requests, and the http recorder must not report them a second time.
    claimBackendRequest(req);
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

/**
 * Every started request has to reach a terminal event. `finish` covers the
 * ordinary response, `close` covers the response the peer aborted or the server
 * destroyed, and the `settled` flag makes sure exactly one of them emits. When
 * `close` arrives on a response that never finished writing there is no status
 * to report, so the request leaves a `capture_gap` naming itself rather than
 * simply disappearing from the session.
 */
function attachFinishListener(
  req: CrumbtrailExpressRequest,
  res: CrumbtrailExpressResponse,
  options: CrumbtrailExpressOptions,
  state: RequestState,
): void {
  if (typeof res.once !== "function") return;

  const recorder = attachResponseRecorder(res, options);

  res.once("finish", () => {
    if (state.settled) return;
    state.settled = true;
    emitRequestEnd(req, res, options, state, recorder);
  });

  res.once("close", () => {
    if (state.settled) return;
    state.settled = true;
    if (res.writableEnded) {
      emitRequestEnd(req, res, options, state, recorder);
      return;
    }
    emitRequestGap(options, state, "request_unterminated");
  });
}

function emitRequestEnd(
  req: CrumbtrailExpressRequest,
  res: CrumbtrailExpressResponse,
  options: CrumbtrailExpressOptions,
  state: RequestState,
  recorder: ResponseRecorder | undefined,
): void {
  const now = readNow(options);
  const endEvent = buildBackendRequestEndEvent({
    ...readRequestInput(req, options, state),
    now,
    statusCode: safeStatusCode(res.statusCode),
    durationMs: now - state.startedAtMs,
    ...readResponseEvidence(res, recorder, options),
  });

  attemptSend(endEvent, options, state.sessionId, (delivered) => {
    // The terminal event is the one whose loss reads as "nothing happened
    // here", so a delivery that never landed leaves a marker in its place.
    if (delivered) return;
    emitRequestGap(options, state, "delivery_failed");
  });
}

function emitRequestGap(
  options: CrumbtrailExpressOptions,
  state: RequestState,
  reason: "request_unterminated" | "delivery_failed",
): void {
  if (!state.sessionId) return;
  try {
    attemptSend(
      buildCaptureGapEvent({
        surface: "backend_request",
        reason,
        requestId: state.requestId,
        sessionId: state.sessionId,
        t: readNow(options),
      }),
      options,
      state.sessionId,
    );
  } catch {
    // Completeness reporting is best effort and never affects the response path.
  }
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

/** Where a built event's session id came from, per its own correlation record. */
function sessionIdSourceOf(event: BugEvent): string | undefined {
  const correlation = event.d.correlation;
  if (correlation === null || typeof correlation !== "object") return undefined;
  const source = (correlation as { sessionIdSource?: unknown }).sessionIdSource;
  return typeof source === "string" ? source : undefined;
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
  const correlation = event.d.correlation;
  const sessionFromProcess =
    correlation !== null &&
    typeof correlation === "object" &&
    (correlation as { sessionIdSource?: unknown }).sessionIdSource === "process";
  return {
    startedAtMs,
    requestId,
    sessionId,
    ...(sessionFromProcess ? { sessionFromProcess: true } : {}),
  };
}

function readRequestInput(
  req: CrumbtrailExpressRequest,
  options: CrumbtrailExpressOptions,
  state?: RequestState,
) {
  // A session the process owns is offered as the fallback, never as an explicit
  // option: the correlation record has to keep saying that nothing joined this
  // request to a browser.
  const correlatedSessionId = state
    ? state.sessionFromProcess
      ? undefined
      : state.sessionId
    : resolveRequestValue(options.sessionId, req);
  return {
    method: req.method,
    url: req.url,
    originalUrl: req.originalUrl,
    path: req.path,
    route: readRoute(req),
    headers: req.headers,
    sessionId: correlatedSessionId,
    // Pinned to what the request started with, so a capture stopped mid-request
    // cannot strand its terminal event in a different session or none at all.
    processSessionId: state?.sessionFromProcess
      ? state.sessionId
      : getProcessSessionId(),
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

function attemptSend(
  event: BugEvent,
  options: CrumbtrailExpressOptions,
  sessionId?: string,
  onSettled?: (delivered: boolean) => void,
): void {
  void sendBackendEvent({
    event,
    sessionId,
    endpoint: options.endpoint,
    authToken: options.authToken,
    fetch: options.fetch,
    signal: options.signal,
    onWarning: options.onWarning,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
  })
    .then((delivered) => onSettled?.(delivered))
    .catch(() => {
      // sendBackendEvent is expected to resolve all degraded intake states. This
      // final catch keeps host application responses safe if that contract changes.
      onSettled?.(false);
    });
}
