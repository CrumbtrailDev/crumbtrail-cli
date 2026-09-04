import type { BugEvent, RedactionMetadata } from "crumbtrail-core";
import { appFramesFromStack, type DbCallsite } from "./db/callsite";
import { attachBackendRedactionMetadata } from "./redaction-plane";
import {
  CRUMBTRAIL_REQUEST_HEADER_LOWER as CORE_CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER_LOWER as CORE_CRUMBTRAIL_SESSION_HEADER,
  BACKEND_REDACTION_POLICY,
  W3C_TRACEPARENT_HEADER,
  buildCaptureGapEvent,
  mergeRedactionMetadata,
  parseTraceparent,
  redactNetworkTextBody,
  redactTokenLikeString,
  redactUrl,
} from "crumbtrail-core";

export const BACKEND_REQUEST_START_EVENT = "backend.req.start";
export const BACKEND_REQUEST_END_EVENT = "backend.req.end";
export const BACKEND_REQUEST_ERROR_EVENT = "backend.req.error";

export const BACKEND_JOB_START_EVENT = "backend.job.start";
export const BACKEND_JOB_END_EVENT = "backend.job.end";
export const BACKEND_JOB_ERROR_EVENT = "backend.job.error";

export const CRUMBTRAIL_SESSION_HEADER = CORE_CRUMBTRAIL_SESSION_HEADER;
export const CRUMBTRAIL_REQUEST_HEADER = CORE_CRUMBTRAIL_REQUEST_HEADER;

const MAX_ID_LENGTH = 128;
const MAX_METHOD_LENGTH = 24;
const MAX_ROUTE_LENGTH = 256;
const MAX_ERROR_NAME_LENGTH = 120;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const GENERATED_REQUEST_ID_PREFIX = "backend_req_";

type HeaderValue = string | number | readonly string[] | undefined;

export type BackendRequestHeaders = Record<string, HeaderValue>;

export type BackendCorrelationStatus =
  | "linked"
  | "missing-session"
  | "missing-request-id"
  | "generated-request-id"
  | "missing-session-and-request-id"
  /**
   * No browser correlated this request, so it was filed to the process's own
   * capture session. Distinct from `missing-session` (which means the event had
   * nowhere to land at all) and from `linked` (which claims a join that did not
   * happen).
   */
  | "process-session";

export type BackendCorrelationSource =
  "option" | "header" | "traceparent" | "generated" | "process" | "missing";

export interface BackendRequestEventInput {
  method?: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  route?: string;
  headers?: BackendRequestHeaders;
  sessionId?: string;
  requestId?: string;
  /**
   * The process's own capture session, used only when neither an explicit
   * `sessionId` nor a correlation header supplies one. Lets a backend with no
   * browser in front of it record its requests instead of having them refused
   * by the intake for having no session.
   */
  processSessionId?: string;
  sessionStartedAt?: number | Date;
  now?: number;
  /** Optional best-effort sink for completeness gaps discovered while resolving correlation. */
  emit?: (event: BugEvent) => void;
}

export interface BackendRequestEndEventInput extends BackendRequestEventInput {
  statusCode?: number;
  durationMs?: number;
  /**
   * The response the handler actually sent, already bounded by the caller.
   * Redacted here through the same policy the browser plane uses, so a backend
   * body is never held to a weaker standard than a captured one.
   */
  responseBody?: string;
  /** Allowlisted response headers, already filtered by the caller. */
  responseHeaders?: Record<string, string>;
  /** Whether the caller truncated `responseBody` at its cap. */
  responseBodyTruncated?: boolean;
  /**
   * The operands the caller sent, already bounded by the caller and never read
   * off the application's stream (see `backend-request-body.ts`).
   *
   * Redacted here under the same policy as the response body. It rides the END
   * event rather than the start event deliberately: `backend.req.start` is
   * where the request semantically belongs, but it is emitted before a single
   * body byte has been pushed into the readable and before any parser has run,
   * so at that moment nothing can say what the request contained. The terminal
   * event is the first point at which the operands and the answer they produced
   * can be stated together, which is also the join a reader wants.
   */
  requestBody?: string;
  /** Whether the caller truncated `requestBody` at its cap. */
  requestBodyTruncated?: boolean;
  /**
   * Where the application wrote a 5xx response, repo-relative where derivable.
   *
   * A failure that never touches the database has no `db.diff` and therefore no
   * callsite, which leaves a swallowed 500 with no pointer to any line. This is
   * the same shape as a db callsite so a reader treats both identically.
   */
  responseCallsite?: {
    file: string;
    line?: number;
    column?: number;
    fn?: string;
    stack?: unknown;
  };
  /**
   * Field names the application declares keepable, exactly as the browser SDK's
   * `redaction.keepFields`. Exempts a NAME from the name-based deny rules; every
   * value-based check still runs, and the list is carried in the event's policy
   * declaration so the capture server's re-classification applies the same
   * exemption instead of undoing it at rest.
   */
  keepFields?: readonly string[];
}

export interface BackendRequestErrorEventInput extends BackendRequestEndEventInput {
  error: unknown;
}

export interface BackendRequestCorrelation {
  sessionId?: string;
  requestId: string;
  status: BackendCorrelationStatus;
  sessionIdSource: BackendCorrelationSource;
  requestIdSource: BackendCorrelationSource;
}

type Correlation = BackendRequestCorrelation;

/**
 * Resolves the inbound request correlation (sessionId + requestId) from the same request-scope
 * inputs the backend.req.* events use: the `X-Crumbtrail-Request-Id` / `X-Crumbtrail-Session-Id`
 * headers (the request id already equals the W3C trace id, set by the browser) or explicit
 * options. Reused by the `db/` module so a `db.diff` produced inside a request carries the SAME
 * requestId as that request's backend events — never a parallel correlation scheme.
 */
export function resolveBackendRequestCorrelation(
  input: BackendRequestEventInput,
): BackendRequestCorrelation {
  return resolveCorrelation(input);
}

interface SanitizedUrl {
  url?: string;
  pathname?: string;
  metadata?: RedactionMetadata;
}

interface SanitizedRoute {
  route?: string;
  truncated?: boolean;
  metadata?: RedactionMetadata;
}

interface SanitizedError {
  name: string;
  message: string;
  code?: string;
  statusCode?: number;
  /**
   * Where the host application threw, innermost first. Structured frames only
   * (file, line, column, function) — the raw stack string never rests, so a
   * value that arrives on a `stack` property cannot leak through this field.
   */
  frames?: DbCallsite[];
  metadata?: RedactionMetadata;
}

/** How many app frames of a thrown error to keep. */
const MAX_ERROR_FRAMES = 4;

export function buildBackendRequestStartEvent(
  input: BackendRequestEventInput,
): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildBasePayload(input, correlation);
  return buildEvent(
    BACKEND_REQUEST_START_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

export function buildBackendRequestEndEvent(
  input: BackendRequestEndEventInput,
): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildBasePayload(input, correlation);
  if (Number.isFinite(input.statusCode)) payload.statusCode = input.statusCode;
  if (Number.isFinite(input.durationMs))
    payload.durationMs = Math.max(0, Math.round(input.durationMs as number));
  attachResponseEvidence(payload, input);
  // After the response attachment, and merging whatever it wrote: the payload
  // carries ONE redaction declaration, and both bodies have to appear in it.
  attachRequestEvidence(payload, input);
  return buildEvent(
    BACKEND_REQUEST_END_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

/**
 * Attaches the response the handler sent, redacted.
 *
 * Until this existed, a request that never passed through an instrumented
 * browser reached the bundle as a method, a path and a status code. On a corpus
 * where the defect IS the sentence the server returned — a constraint violation
 * naming neither column nor row, a migration failing "with an unspecified
 * error", a success message reporting a count nothing wrote — that is a pointer
 * to the problem rather than the problem.
 *
 * The body goes through `redactNetworkTextBody` under the same policy as the
 * browser plane, so the application's declared keep and deny fields govern both
 * planes identically and a backend body is never the weaker link. Headers are
 * allowlisted by the caller; nothing here widens that.
 */
function attachResponseEvidence(
  payload: Record<string, unknown>,
  input: BackendRequestEndEventInput,
): void {
  if (input.responseHeaders && Object.keys(input.responseHeaders).length > 0)
    payload.responseHeaders = { ...input.responseHeaders };

  if (input.responseCallsite && typeof input.responseCallsite.file === "string")
    payload.responseCallsite = input.responseCallsite;

  if (typeof input.responseBody !== "string" || input.responseBody === "")
    return;

  const contentType = headerValueOf(input.responseHeaders, "content-type");
  const result = redactNetworkTextBody(input.responseBody, {
    ...(contentType ? { contentType } : {}),
    path: "responseBody",
    // Structured explicitly, not by default: v2 keeps the shape a reader needs
    // and stamps the policy declaration that lets the at-rest sanitizer
    // recognise this as an already-redacted body instead of sweeping it whole.
    mode: "structured",
    ...(input.keepFields && input.keepFields.length > 0
      ? { keepFields: [...input.keepFields] }
      : {}),
  });
  if (result.body !== undefined) payload.responseBody = result.body;
  if (result.bodySummary) payload.responseBodySummary = result.bodySummary;
  if (input.responseBodyTruncated) payload.responseBodyTruncated = true;
  attachBackendRedactionMetadata(payload, result.metadata);
}

/**
 * Attaches what the caller sent, redacted.
 *
 * The response half of this pair says what came back. Without this half a
 * session investigating a wrong total holds the total and none of the numbers
 * it was computed from, which is a pointer to the defect rather than the
 * defect. Same engine, same policy declaration, same keep list as the response
 * body: the two directions of one request must never answer to two allowlists.
 *
 * The content type is read from the REQUEST's headers, which the caller passes
 * through untouched, so a form post is parsed as a form post and a JSON body as
 * JSON.
 */
function attachRequestEvidence(
  payload: Record<string, unknown>,
  input: BackendRequestEndEventInput,
): void {
  if (typeof input.requestBody !== "string" || input.requestBody === "") return;

  const contentType = requestHeaderValueOf(input.headers, "content-type");
  const result = redactNetworkTextBody(input.requestBody, {
    ...(contentType ? { contentType } : {}),
    path: "requestBody",
    mode: "structured",
    ...(input.keepFields && input.keepFields.length > 0
      ? { keepFields: [...input.keepFields] }
      : {}),
  });
  if (result.body !== undefined) payload.requestBody = result.body;
  if (result.bodySummary) payload.requestBodySummary = result.bodySummary;
  if (input.requestBodyTruncated) payload.requestBodyTruncated = true;
  // The backend plane, restamped over whatever the shared engine claimed, and
  // merged with any metadata an earlier attachment already wrote to the payload.
  attachBackendRedactionMetadata(
    payload,
    existingRedactionMetadata(payload),
    result.metadata,
  );
}

/** Redaction metadata already written onto a payload, so a later attachment merges instead of replacing. */
function existingRedactionMetadata(
  payload: Record<string, unknown>,
): RedactionMetadata | undefined {
  const existing = payload.redaction;
  return existing && typeof existing === "object"
    ? (existing as RedactionMetadata)
    : undefined;
}

/** {@link headerValueOf} over the inbound request's own headers, which may be arrays. */
function requestHeaderValueOf(
  headers: BackendRequestHeaders | undefined,
  name: string,
): string | undefined {
  const raw = readHeader(headers, name);
  return raw === undefined || raw === "" ? undefined : raw;
}

function headerValueOf(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  return key ? headers[key] : undefined;
}

export function buildBackendRequestErrorEvent(
  input: BackendRequestErrorEventInput,
): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildBasePayload(input, correlation);
  if (Number.isFinite(input.statusCode)) payload.statusCode = input.statusCode;
  if (Number.isFinite(input.durationMs))
    payload.durationMs = Math.max(0, Math.round(input.durationMs as number));

  const error = sanitizeError(input.error);
  payload.error = omitMetadata(error);
  attachBackendRedactionMetadata(payload, error.metadata);

  return buildEvent(
    BACKEND_REQUEST_ERROR_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

/* ------------------------------------------------------------------ */
/* Background jobs                                                     */
/* ------------------------------------------------------------------ */

/**
 * Work an application does OUTSIDE a request.
 *
 * Backend instrumentation was request-shaped throughout: a session recorded what the server did
 * while the user waited and nothing about what it did afterwards. Queues, cron, retries and
 * webhook fan-out are where a large share of enterprise defects live, and they share a signature
 * that is invisible without this - the request succeeded, the user saw a confirmation, and the work
 * the confirmation promised either failed, ran twice, or never ran. Measured on the
 * orders-complete-without-a-payment-record scenario, readers given the whole bundle asked for
 * exactly one thing: the payment-recording job's execution result. Nothing in the capture could
 * have carried it.
 *
 * The correlation is the point. A job carries the sessionId and requestId of the request that
 * enqueued it, resolved by the same function the request events use, so the job lands in the same
 * session as the click that caused it rather than in a parallel record nobody joins. An application
 * that puts those ids in its job payload gets that join for free; one that does not still gets the
 * job, uncorrelated and honestly labelled as such.
 */
export interface BackendJobEventInput extends BackendRequestEventInput {
  /** What the job is, e.g. `record-payment`. The stable name, not a per-run id. */
  name: string;
  /** This run's id, when the queue has one. */
  jobId?: string;
  /** Which queue or scheduler ran it. */
  queue?: string;
  /** 1 for a first run. A retry that finally succeeds is a different story from a clean run. */
  attempt?: number;
}

export interface BackendJobEndEventInput extends BackendJobEventInput {
  durationMs?: number;
  /**
   * How the run ended, as the application judged it.
   *
   * `skipped` is deliberately available and deliberately distinct from `success`: a job that
   * decided there was nothing to do is the exact shape of the work that was promised and never
   * happened, and collapsing it into success hides the defect this capability exists to expose.
   */
  outcome?: "success" | "failure" | "skipped";
  /** What the run produced or decided, already bounded by the caller. Redacted here. */
  result?: string;
  /** Whether the caller truncated `result` at its cap. */
  resultTruncated?: boolean;
  /** As `BackendRequestEndEventInput.keepFields`. */
  keepFields?: readonly string[];
}

export interface BackendJobErrorEventInput extends BackendJobEndEventInput {
  error: unknown;
}

export function buildBackendJobStartEvent(input: BackendJobEventInput): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildJobPayload(input, correlation);
  return buildEvent(
    BACKEND_JOB_START_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

export function buildBackendJobEndEvent(
  input: BackendJobEndEventInput,
): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildJobPayload(input, correlation);
  if (input.outcome) payload.outcome = input.outcome;
  if (Number.isFinite(input.durationMs))
    payload.durationMs = Math.max(0, Math.round(input.durationMs as number));
  attachJobResult(payload, input);
  return buildEvent(
    BACKEND_JOB_END_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

export function buildBackendJobErrorEvent(
  input: BackendJobErrorEventInput,
): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildJobPayload(input, correlation);
  payload.outcome = input.outcome ?? "failure";
  if (Number.isFinite(input.durationMs))
    payload.durationMs = Math.max(0, Math.round(input.durationMs as number));
  attachJobResult(payload, input);

  const error = sanitizeError(input.error);
  payload.error = omitMetadata(error);
  attachBackendRedactionMetadata(payload, error.metadata);

  return buildEvent(
    BACKEND_JOB_ERROR_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

function buildJobPayload(
  input: BackendJobEventInput,
  correlation: Correlation,
): Record<string, unknown> {
  const payload = buildBasePayload(input, correlation);
  const name = sanitizeRoute(input.name);
  // The name is the join key across runs, so an unusable one is worth saying out loud rather than
  // silently omitting: a job event with no name cannot be grouped with its own retries.
  payload.job = name.route ?? "unnamed";
  if (name.truncated) payload.jobNameTruncated = true;

  const jobId = normalizeId(input.jobId);
  if (jobId) payload.jobId = jobId;
  const queue = sanitizeRoute(input.queue);
  if (queue.route) payload.queue = queue.route;
  if (Number.isFinite(input.attempt))
    payload.attempt = Math.max(1, Math.round(input.attempt as number));

  attachBackendRedactionMetadata(payload, name.metadata, queue.metadata);
  return payload;
}

/** The same policy the response body answers to. A job result is not a weaker link. */
function attachJobResult(
  payload: Record<string, unknown>,
  input: BackendJobEndEventInput,
): void {
  if (typeof input.result !== "string" || input.result === "") return;
  const redacted = redactNetworkTextBody(input.result, {
    path: "result",
    mode: "structured",
    ...(input.keepFields && input.keepFields.length > 0
      ? { keepFields: [...input.keepFields] }
      : {}),
  });
  if (redacted.body !== undefined) payload.result = redacted.body;
  if (redacted.bodySummary) payload.resultSummary = redacted.bodySummary;
  if (input.resultTruncated) payload.resultTruncated = true;
  attachBackendRedactionMetadata(payload, redacted.metadata);
}

function buildEvent(
  kind: string,
  payload: Record<string, unknown>,
  now: number,
  sessionStartedAt: BackendRequestEventInput["sessionStartedAt"],
  sessionId?: string,
): BugEvent {
  const event: BugEvent = { t: now, k: kind, d: payload };
  if (sessionId) event.sessionId = sessionId;

  const startedAt = normalizeSessionStartedAt(sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);

  return event;
}

function buildBasePayload(
  input: BackendRequestEventInput,
  correlation: Correlation,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    requestId: correlation.requestId,
    correlation: {
      status: correlation.status,
      sessionIdSource: correlation.sessionIdSource,
      requestIdSource: correlation.requestIdSource,
    },
  };

  if (correlation.sessionId) payload.sessionId = correlation.sessionId;

  const method = sanitizeMethod(input.method);
  if (method) payload.method = method;

  const sanitizedUrl = sanitizeUrl(
    input.originalUrl ?? input.url ?? input.path,
  );
  if (sanitizedUrl.url) payload.url = sanitizedUrl.url;
  if (sanitizedUrl.pathname) payload.pathname = sanitizedUrl.pathname;

  const route = sanitizeRoute(input.route);
  if (route.route) {
    payload.route = route.route;
    if (route.truncated) payload.routeTruncated = true;
  }

  attachBackendRedactionMetadata(payload, sanitizedUrl.metadata, route.metadata);

  return payload;
}

function resolveCorrelation(input: BackendRequestEventInput): Correlation {
  const headerSessionId = readHeader(input.headers, CRUMBTRAIL_SESSION_HEADER);
  const headerRequestId = readHeader(input.headers, CRUMBTRAIL_REQUEST_HEADER);
  const traceparent = parseTraceparent(
    readHeader(input.headers, W3C_TRACEPARENT_HEADER),
  );
  const optionSessionId = normalizeId(input.sessionId);
  const optionRequestId = normalizeId(input.requestId);

  // What a caller or a browser correlated, before any process-level fallback.
  const correlatedSessionId = optionSessionId ?? normalizeId(headerSessionId);
  // The fallback is consulted only when nothing correlated the request, so a
  // browser-correlated request still lands in the browser's session.
  const processSessionId = correlatedSessionId
    ? undefined
    : normalizeId(input.processSessionId);
  const sessionId = correlatedSessionId ?? processSessionId;
  const crumbtrailRequestId = optionRequestId ?? normalizeId(headerRequestId);
  const rawRequestId = crumbtrailRequestId ?? traceparent?.traceId;
  const requestId = rawRequestId ?? generateBackendRequestId();

  const sessionIdSource: BackendCorrelationSource = optionSessionId
    ? "option"
    : headerSessionId && correlatedSessionId
      ? "header"
      : processSessionId
        ? "process"
        : "missing";
  const requestIdSource: BackendCorrelationSource = optionRequestId
    ? "option"
    : headerRequestId && rawRequestId
      ? "header"
      : traceparent && rawRequestId
        ? "traceparent"
        : "generated";

  let status: BackendCorrelationStatus;
  // A request the process claimed is never "linked": nothing joined it to a
  // browser, and saying otherwise would invent a correlation downstream.
  if (processSessionId) status = "process-session";
  else if (sessionId && rawRequestId) status = "linked";
  else if (sessionId && !rawRequestId) status = "generated-request-id";
  else if (!sessionId && rawRequestId) status = "missing-session";
  else status = "missing-session-and-request-id";

  // Judged on what the request itself carried: a traceparent whose session
  // header was stripped is still a correlation gap, whatever session the event
  // was finally filed to.
  if (traceparent && !correlatedSessionId) {
    emitCorrelationGap(input, {
      reason:
        !headerSessionId && !headerRequestId
          ? "header_stripped"
          : "missing_session_id",
      detail: "traceparent correlation",
    });
  }

  return { sessionId, requestId, status, sessionIdSource, requestIdSource };
}

function emitCorrelationGap(
  input: BackendRequestEventInput,
  gap: {
    reason: "missing_session_id" | "header_stripped";
    detail: string;
  },
): void {
  if (!input.emit) return;
  try {
    input.emit(
      buildCaptureGapEvent({
        surface: "backend_request",
        reason: gap.reason,
        detail: gap.detail,
        sessionId:
          normalizeId(input.sessionId) ??
          normalizeId(readHeader(input.headers, CRUMBTRAIL_SESSION_HEADER)),
        t: input.now,
        sessionStartedAt: input.sessionStartedAt,
      }),
    );
  } catch (error) {
    // Completeness reporting is best effort and cannot affect the application request.
    void error;
  }
}

function readHeader(
  headers: BackendRequestHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, rawValue] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value === undefined) return undefined;
    return String(value);
  }
  return undefined;
}

function normalizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_ID_LENGTH);
}

function generateBackendRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${GENERATED_REQUEST_ID_PREFIX}${time}_${random}`.slice(
    0,
    MAX_ID_LENGTH,
  );
}

function sanitizeMethod(method: string | undefined): string | undefined {
  const normalized = method?.trim().toUpperCase();
  if (!normalized) return undefined;
  return normalized.replace(/[^A-Z0-9_-]/g, "").slice(0, MAX_METHOD_LENGTH);
}

function sanitizeUrl(rawUrl: string | undefined): SanitizedUrl {
  const url = rawUrl?.trim();
  if (!url) return {};

  const redacted = redactUrl(url, "url");
  const pathname = extractPathname(url);
  return {
    url: redacted.value,
    ...(pathname ? { pathname } : {}),
    ...(redacted.metadata ? { metadata: redacted.metadata } : {}),
  };
}

function extractPathname(rawUrl: string): string | undefined {
  try {
    const parsed = /^[a-z][a-z\d+.-]*:/i.test(rawUrl)
      ? new URL(rawUrl)
      : new URL(
          rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`,
          "http://crumbtrail.local",
        );
    return parsed.pathname || "/";
  } catch {
    const withoutHash = rawUrl.split("#", 1)[0] ?? rawUrl;
    const withoutQuery = withoutHash.split("?", 1)[0] ?? withoutHash;
    return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  }
}

function sanitizeRoute(rawRoute: string | undefined): SanitizedRoute {
  const route = rawRoute?.trim();
  if (!route) return {};

  const tokenResult = redactTokenLikeString(route, "route");
  const truncated = tokenResult.value.length > MAX_ROUTE_LENGTH;
  const bounded = truncated
    ? `${tokenResult.value.slice(0, MAX_ROUTE_LENGTH)}…`
    : tokenResult.value;

  const metadata = truncated
    ? mergeRedactionMetadata(tokenResult.metadata, {
        policy: BACKEND_REDACTION_POLICY,
        fields: [
          { path: "route", reason: "route_too_long", action: "summarized" },
        ],
      })
    : tokenResult.metadata;

  return {
    route: bounded,
    ...(truncated ? { truncated } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function sanitizeError(error: unknown): SanitizedError {
  const errorRecord = isRecord(error) ? error : undefined;
  const name = sanitizeErrorText(
    typeof errorRecord?.name === "string"
      ? errorRecord.name
      : error instanceof Error
        ? error.name
        : typeof error,
    MAX_ERROR_NAME_LENGTH,
    "error.name",
  );
  const message = sanitizeErrorText(
    typeof errorRecord?.message === "string"
      ? errorRecord.message
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Non-Error thrown",
    MAX_ERROR_MESSAGE_LENGTH,
    "error.message",
  );

  const code =
    typeof errorRecord?.code === "string"
      ? sanitizeErrorText(errorRecord.code, MAX_ERROR_NAME_LENGTH, "error.code")
      : undefined;
  const statusCode =
    typeof errorRecord?.statusCode === "number"
      ? errorRecord.statusCode
      : typeof errorRecord?.status === "number"
        ? errorRecord.status
        : undefined;
  const metadata = mergeRedactionMetadata(
    name.metadata,
    message.metadata,
    code?.metadata,
  );

  // Parsed from the thrown error's own stack, which names where the fault is,
  // not the middleware that caught it. Library and runtime frames are dropped
  // by the shared walk, so an error thrown entirely inside a dependency
  // contributes nothing and the field is omitted rather than empty.
  const frames =
    typeof errorRecord?.stack === "string"
      ? appFramesFromStack(errorRecord.stack, process.cwd(), MAX_ERROR_FRAMES)
      : [];

  return {
    name: name.value || "Error",
    message: message.value || "Error",
    ...(code?.value ? { code: code.value } : {}),
    ...(Number.isFinite(statusCode) ? { statusCode } : {}),
    ...(frames.length > 0 ? { frames } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function sanitizeErrorText(
  value: string,
  maxLength: number,
  path: string,
): { value: string; metadata?: RedactionMetadata } {
  const tokenResult = redactTokenLikeString(value, path);
  if (tokenResult.value.length <= maxLength) return tokenResult;

  const truncated = `${tokenResult.value.slice(0, maxLength)}…`;
  const metadata = mergeRedactionMetadata(tokenResult.metadata, {
    policy: BACKEND_REDACTION_POLICY,
    fields: [{ path, reason: "error_field_too_long", action: "summarized" }],
  });

  return { value: truncated, metadata };
}

function omitMetadata<T extends { metadata?: RedactionMetadata }>(
  value: T,
): Omit<T, "metadata"> {
  const { metadata: _metadata, ...rest } = value;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeTimestamp(now: number | undefined): number {
  return Number.isFinite(now) ? Math.round(now as number) : Date.now();
}

function normalizeSessionStartedAt(
  startedAt: BackendRequestEventInput["sessionStartedAt"],
): number | undefined {
  if (startedAt instanceof Date) {
    const time = startedAt.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return Number.isFinite(startedAt)
    ? Math.round(startedAt as number)
    : undefined;
}
