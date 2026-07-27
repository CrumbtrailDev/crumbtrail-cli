/** @stability stable — public SDK export surface (contract review, wargames/wargames/03-contract-decisions.md). */
export { createServer } from "./server";
export type { ServerConfig } from "./server";
export {
  DISTINCT_BUGS_SCHEMA_VERSION,
  groupDistinctBugs,
  buildDistinctBugSignature,
  computeDistinctBugSignatures,
  groupDistinctBugRecurrences,
} from "./distinct-bugs";
export type {
  DistinctBug,
  DistinctBugSeverity,
  DistinctBugEvidenceRef,
  DistinctBugRecurrence,
  DistinctBugRecurrenceInput,
  DistinctBugRecurrenceOccurrence,
} from "./distinct-bugs";
export {
  FilesystemSessionStore,
  defaultSessionStore,
  setSessionStore,
  resetSessionStore,
  getSessionStore,
} from "./session-store";
// The full SessionStore surface must be exported, not just the interface: an
// embedder implementing or decorating it (for example the hosted cloud's
// EncryptedSessionStore) needs these parameter/return types to type its methods.
export type {
  SessionStore,
  AppendEventsOptions,
  AppendEventsResult,
  ArtifactStat,
  ResolveSessionScope,
  SessionPartition,
} from "./session-store";
export {
  FilesystemMcpReadStore,
  RemoteMcpReadStore,
  selectMcpReadStore,
} from "./mcp-read-store";
export type { McpReadStore } from "./mcp-read-store";
export { SessionManager } from "./session";
export type { SessionFinalizationResult, SessionListItem } from "./session";
export {
  sweepIdleSessions,
  startSessionSweeper,
  DEFAULT_SWEEP_IDLE_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_SWEEP_CHECKPOINT_MS,
} from "./session-sweeper";
export type {
  SessionSweepOptions,
  SessionSweepResult,
  SessionSweeperHandle,
} from "./session-sweeper";
export {
  createFastFinalizeScheduler,
  isHighSeverityEvent,
  startFastFinalizer,
} from "./fast-finalize";
export type {
  FastFinalizeHandle,
  FastFinalizeOutcome,
  FastFinalizeScheduler,
  FastFinalizeSchedulerOptions,
  FastFinalizerOptions,
} from "./fast-finalize";
export { buildSessionSummary } from "./session-summary";
export type {
  SessionSummary,
  SessionFileFlags,
  Severity,
} from "./session-summary";
export { BugQueueManager } from "./bug-queue";
export type { BugReport as ServerBugReport, BugQueueConfig } from "./bug-queue";
export { McpServer } from "./mcp-server";
export type { McpServerConfig } from "./mcp-server";
export {
  buildFixContext,
  FixContextError,
  FIX_CONTEXT_SCHEMA_VERSION,
} from "./fix-context";
export type {
  FixContext,
  FixContextSession,
  FixContextReproHint,
  FixContextPrimaryWindow,
  FixContextDbDiff,
  FixContextDbRead,
  BuildFixContextOptions,
} from "./fix-context";
export { extractOpinionCodePointers } from "./code-pointers";
export type { CodePointer, CodePointerResolution } from "./code-pointers";
export {
  buildDbDiffEvent,
  buildDbReadBulkEvent,
  buildDbReadEvent,
  instrumentMssqlPool,
  instrumentMysqlClient,
  instrumentPgClient,
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
  resolveBackendRequestCorrelation,
} from "./backend-events";
export type {
  BackendRequestEventInput,
  BackendRequestEndEventInput,
  BackendRequestErrorEventInput,
  BackendRequestCorrelation,
  BackendRequestHeaders,
} from "./backend-events";
export { buildLlmBundle, writeLlmBundle } from "./llm-bundle";
export type {
  LlmBundle,
  LlmBundleCompleteness,
  SessionIndexLike,
  WriteLlmBundleInput,
} from "./llm-bundle";
export {
  postProcess,
  reanalyzeSession,
  type ReanalyzeSessionResult,
} from "./post-process";
export { inspectSession, formatInspection, InspectError } from "./inspect";
export type {
  SessionInspection,
  SessionInspectionArtifact,
  InspectSessionOptions,
} from "./inspect";
export { readPackageVersion } from "./version";
export {
  PROVIDER_IDS,
  PROVIDER_RECIPES,
  getProviderRecipe,
  isProviderId,
  renderProviderCliOutput,
  renderProviderConfig,
  renderProviderDoc,
  renderProviderReadme,
} from "./provider-recipes";
export type { ProviderId, ProviderRecipe } from "./provider-recipes";
export {
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
} from "./express";
export {
  HeadlessRequestError,
  startHeadlessSession,
} from "./headless-session";
export type {
  HeadlessSession,
  HeadlessSessionOptions,
} from "./headless-session";
export type {
  CrumbtrailExpressErrorMiddleware,
  CrumbtrailExpressErrorNext,
  CrumbtrailExpressMiddleware,
  CrumbtrailExpressNext,
  CrumbtrailExpressOptions,
  CrumbtrailExpressRequest,
  CrumbtrailExpressResponse,
  CrumbtrailExpressWarning,
  CrumbtrailExpressWarningKind,
} from "./express";
export {
  compareSessions,
  CompareError,
  SESSION_COMPARE_SCHEMA_VERSION,
} from "./compare";
export {
  comparisonTitle,
  formatComparisonSummary,
  renderCompareReport,
  sessionRefLabel,
} from "./compare/report";
export {
  buildRegressionContext,
  REGRESSION_CONTEXT_SCHEMA_VERSION,
} from "./compare/regression-context";
export type {
  CompareOptions,
  ComparisonConfidence,
  ComparisonVerdict,
  Divergence,
  EnvChannelDelta,
  EnvDiff,
  EnvValueChange,
  SessionComparison,
} from "./compare";
export type { RegressionContext } from "./compare/regression-context";
export type {
  EvidenceSourceDescriptor,
  EvidenceJoinKey,
} from "crumbtrail-core";
export {
  REPLAY_RESULT_SCHEMA_VERSION,
  buildReplayResult,
  parseReplayResult,
  writeReplayResult,
} from "./replay/result";
export type {
  ReplayDivergence,
  ReplayResult,
  ReplayStepResult,
  StepResolution,
} from "./replay/result";

// Replay adapters: the `Reproducer` seam, its policy, and the two adapters.
// `defaultReproducerFactory` is the production default, so `allowReproduction`
// is a live switch rather than an inert argument.
export { buildReplayFlow, flowCarriesSecret } from "./replay/flow";
export {
  DEFAULT_REPLAY_MAX_STEPS,
  DEFAULT_REPLAY_STEP_TIMEOUT_MS,
  defaultReplayPolicy,
  describeRefusal,
  evaluateReplayPolicy,
  replayPolicyFromEnv,
  resolveReplayPolicy,
} from "./replay/policy";
export { NoopReproducer } from "./replay/noop";
export {
  PlaywrightReproducer,
  loadPlaywrightDriver,
} from "./replay/playwright";
export {
  defaultReproducerFactory,
  runReproduction,
} from "./replay/factory";
export type {
  BuildReplayFlowInput,
  ReplayFlowEvent,
} from "./replay/flow";
export type {
  ReplayPolicy,
  ReplayRequestOptions,
  ReplayTargetAllowlistEntry,
} from "./replay/policy";
export type {
  PlaywrightDriver,
  PlaywrightLoader,
  PlaywrightReproducerOptions,
  ReplayBrowser,
  ReplayBrowserContext,
  ReplayBrowserType,
  ReplayLocator,
  ReplayPage,
} from "./replay/playwright";
export type {
  ReproducerContext,
  ReproducerFactory,
  ReproductionRequest,
} from "./replay/factory";
export type {
  ReplayAction,
  ReplayDecision,
  ReplayFlow,
  ReplayMode,
  ReplayRefusal,
  ReplayRefusalCode,
  ReplayStep,
  ReplayValueSource,
  Reproducer,
  ReproductionOutcome,
} from "./replay/types";

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

// ── CP4: OTLP/HTTP protobuf decoders ─────────────────────────────────────────
// Append-only block. Exported so the cloud edge (packages/cloud) can decode
// `application/x-protobuf` OTLP bodies at ingest and forward the JSON wire shape
// to the inner server, at parity with the local receiver's readOtlpBody.
export {
  decodeOtlpTraceProtobuf,
  decodeOtlpLogsProtobuf,
} from "./otel-protobuf";
export type {
  OtlpTraceRequest,
  OtlpLogsRequest,
  OtlpResourceSpans,
  OtlpResourceLogs,
} from "./otel-adapter";

// ── Node contract capability marker ──────────────────────────────────────────
// Append-only block. Do not reorder the exports above.
// The hosted cloud namespace-imports this package and reads
// NODE_CONTRACT_CAPABILITIES to decide whether the installed contract supports
// the tenant context factory and the provider neutral ticket comment. It fails
// closed when the marker is absent, so this re-export is load bearing and must
// survive bundling in both the ESM and CJS dist outputs.
export { NODE_CONTRACT_CAPABILITIES } from "./node-contract-capabilities";
