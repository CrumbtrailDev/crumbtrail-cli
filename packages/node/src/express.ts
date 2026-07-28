import type { BugEvent } from "crumbtrail-core";
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
}

export interface CrumbtrailExpressResponse {
  statusCode?: number;
  once?: (event: "finish", listener: () => void) => unknown;
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
}

interface RequestState {
  startedAtMs: number;
  sessionId?: string;
  requestId: string;
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
    });

    attemptSend(endEvent, options, state.sessionId);
  });
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
