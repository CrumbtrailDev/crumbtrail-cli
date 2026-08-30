export { captureDbCallsite, type DbCallsite } from "./db/callsite";

export {
  CACHE_EVENT_KIND,
  AUTO_INSTRUMENT_CACHE_DRIVERS,
  autoInstrumentCacheClients,
  autoInstrumentCachePatchedAnything,
  buildCacheEvent,
  formatAutoInstrumentCacheReport,
  instrumentIoredisClient,
  instrumentNodeRedisClient,
} from "./cache";

export type {
  BuildCacheEventInput,
  AutoInstrumentCacheDriver,
  AutoInstrumentCacheDriverResult,
  AutoInstrumentCacheOptions,
  AutoInstrumentCacheReport,
  CacheDriver,
  CacheEventData,
  DuckTypedCacheClient,
  InstrumentCacheClientOptions,
} from "./cache";

export {
  buildDbDiffEvent,
  buildDbReadBulkEvent,
  buildDbReadEvent,
  // The explicit path for a client automatic instrumentation cannot reach: one
  // the host already built, or a driver in an ESM graph the factory patch does
  // not see. Routes to the running capture, in any call order.
  instrumentDatabaseClient,
  type InstrumentableDriver,
  type InstrumentDatabaseClientOptions,
  instrumentMssqlPool,
  instrumentMssqlTransaction,
  instrumentMysqlClient,
  instrumentNeonHttpQuery,
  instrumentPlanetScaleClient,
  instrumentPgClient,
  // Reachable from the package root on purpose: an ESM app loads postgres.js as
  // a different module instance than the one auto instrumentation can patch, so
  // the runtime tells those customers to call this themselves. A fix the message
  // names has to be importable from where it tells them to import it.
  instrumentPostgresSql,
  instrumentSqliteDatabase,
  resolveDbRequestContext,
  classifyStatement,
  leadingSqlKeyword,
  looksLikePotentialWrite,
  parseMutation,
  parseRead,
  DEFAULT_SENSITIVE_DB_COLUMNS,
} from "./db";

export type {
  BuildDbDiffEventInput,
  BuildDbReadBulkEventInput,
  BuildDbReadEventInput,
  DbRequestContext,
  DuckTypedMssqlPool,
  DuckTypedMssqlRequest,
  DuckTypedMssqlResult,
  DuckTypedMysqlClient,
  DuckTypedMysqlResultHeader,
  DuckTypedNeonHttpQuery,
  DuckTypedPlanetScaleClient,
  DuckTypedPlanetScaleConnection,
  DuckTypedPlanetScaleResult,
  DuckTypedPgClient,
  DuckTypedPgQueryResult,
  DuckTypedSqliteDatabase,
  DuckTypedSqliteRunResult,
  DuckTypedSqliteStatement,
  InstrumentDbClientOptions,
  InstrumentPgClientOptions,
  StatementClassification,
} from "./db";

export {
  buildBackendRequestStartEvent,
  buildBackendRequestEndEvent,
  buildBackendRequestErrorEvent,
  buildBackendJobStartEvent,
  buildBackendJobEndEvent,
  buildBackendJobErrorEvent,
  resolveBackendRequestCorrelation,
} from "./backend-events";

export type {
  BackendRequestEventInput,
  BackendRequestEndEventInput,
  BackendRequestErrorEventInput,
  BackendRequestCorrelation,
  BackendRequestHeaders,
  BackendJobEventInput,
  BackendJobEndEventInput,
  BackendJobErrorEventInput,
} from "./backend-events";

export {
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
} from "./express";

// Capture is fire-and-forget, so a process that exits right after its last
// request — a job, a CLI, a serverless invocation — needs a way to wait for the
// tail. `backendIntakeQueueStats` is for a health endpoint or a smoke test.
export { backendIntakeQueueStats, flushBackendEvents } from "./backend-intake";

export { HeadlessRequestError, startHeadlessSession } from "./headless-session";

export type {
  HeadlessSession,
  HeadlessSessionOptions,
} from "./headless-session";

export type {
  CrumbtrailExpressErrorMiddleware,
  CrumbtrailExpressErrorNext,
  CrumbtrailExpressMiddleware,
  CrumbtrailExpressMiddlewareWithHandle,
  CrumbtrailExpressNext,
  CrumbtrailExpressOptions,
  CrumbtrailExpressRequest,
  CrumbtrailExpressResponse,
  CrumbtrailExpressWarning,
  CrumbtrailExpressWarningKind,
} from "./express";

// ── CP1: auto-capture (crash + console.error) ────────────────────────────────
// Append-only block. Do not reorder the exports above.
export { autoCapture, AUTO_CAPTURE_ERROR_EVENT } from "./auto-capture";

export type {
  AutoCaptureErrorContext,
  AutoCaptureErrorPhase,
  AutoCaptureHandle,
  AutoCaptureOptions,
  AutoCaptureSource,
} from "./auto-capture";

// ── Node contract capability marker ──────────────────────────────────────────
// Append-only block. Do not reorder the exports above.
// The hosted cloud namespace-imports this package and reads
// NODE_CONTRACT_CAPABILITIES to decide whether the installed contract supports
// the tenant context factory and the provider neutral ticket comment. It fails
// closed when the marker is absent, so this re-export is load bearing and must
// survive bundling in both the ESM and CJS dist outputs.
export { NODE_CONTRACT_CAPABILITIES } from "./node-contract-capabilities";

// ── Node runtime warning capture ─────────────────────────────────────────────
// Append-only block. Do not reorder the exports above.
export {
  BACKEND_WARNING_EVENT,
  buildBackendWarningEvent,
  installBackendWarningCapture,
} from "./backend-warnings";

export type {
  BackendWarningCaptureHandle,
  BackendWarningCaptureOptions,
  RuntimeWarningLike,
} from "./backend-warnings";

// ── Structured backend log capture ───────────────────────────────────────────
// Append-only block. Do not reorder the exports above.
export {
  BACKEND_LOG_EVENT,
  BACKEND_LOG_LEVELS,
  buildBackendLogEvent,
  installBackendLogCapture,
  parseStructuredLogLine,
} from "./backend-logs";

export type {
  BackendLogCaptureHandle,
  BackendLogCaptureOptions,
  BackendLogLevel,
  ParsedStructuredLog,
} from "./backend-logs";

// ── Inbound HTTP request capture ─────────────────────────────────────────────
// Append-only block. Do not reorder the exports above.
// The zero-config half of frontend to backend correlation: it patches
// `http.Server` rather than any one framework, so express, hono, fastify, nest
// and a plain `createServer` all record inbound requests carrying the browser's
// correlation headers. `autoCapture` installs it, so a stock install needs none
// of these symbols; they are exported for a host that wires capture by hand.
export { installHttpRequestCapture } from "./http-server";

export type {
  HttpRequestCaptureHandle,
  HttpRequestCaptureOptions,
} from "./http-server";

export {
  claimBackendRequest,
  isBackendRequestClaimed,
} from "./backend-request-claim";

// The session an uncorrelated backend request is filed to. `autoCapture` sets
// this once its handshake succeeds; a host that runs its own headless session
// and wires the middleware by hand announces it here so its request events land
// somewhere too, instead of being refused for having no session.
export {
  setProcessSessionId,
  clearProcessSessionId,
  getProcessSessionId,
} from "./process-session";

export { isCapturableContentTypeForTest } from "./backend-response";

export type {
  BackendResponseCaptureOptions,
  BackendResponseLike,
} from "./backend-response";

// ── Ambient request context ──────────────────────────────────────────────────
// Append-only block. Do not reorder the exports above.
// The request a piece of backend evidence was produced inside, carried on the
// async path so a log line stamps the SAME request id as the request span that
// provoked it. The request recorders establish it; a host instrumenting its own
// background work (a queue consumer resuming a request's job) can establish one
// too, so that work's evidence joins the request that queued it.
export {
  getBackendRequestContext,
  readRequestCorrelation,
  runInBackendRequestContext,
  updateBackendRequestContext,
} from "./request-context";

export type { BackendRequestContext } from "./request-context";

// Capture-side utilities the pipeline tests reach for directly. They were
// internal while those tests lived beside them; now that the tests live with
// the analysis in the cloud repository, the boundary has to name them.
export { parseStackFrame } from "./db/callsite";
export { buildDbErrorEvent, captureDbErrorCode } from "./db/error-event";
export {
  DEFAULT_MAX_CALLSITES_PER_REQUEST,
  resetCallsiteBudgetForTests,
} from "./db/instrument-shared";
export { parseLimitOffset } from "./db/sql";
export { HeadlessTimeoutError } from "./headless-session";

export {
  withCrumbtrailAwsLambda,
  withCrumbtrailNetlify,
  withCrumbtrailVercel,
} from "./serverless";

export type {
  AwsApiGatewayV1Event,
  AwsApiGatewayV2Event,
  AwsCompatibleHttpEvent,
  AwsLambdaAsyncHandler,
  AwsLambdaContext,
  AwsLambdaHostHandler,
  AwsLambdaHttpEvent,
  AwsLambdaHttpEventBase,
  AwsLambdaRequestContext,
  NetlifyAsyncHandler,
  NetlifyFunctionContext,
  NetlifyFunctionEvent,
  NetlifyHostHandler,
  NodeServerlessAdapterOptions,
  VercelNodeAsyncHandler,
  VercelNodeHostHandler,
  VercelNodeRequest,
  VercelNodeResponse,
} from "./serverless";
