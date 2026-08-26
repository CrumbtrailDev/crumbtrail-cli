export { Crumbtrail, PROBE_RESULT_EVENT_KIND } from "./crumbtrail";
export {
  CRUMBTRAIL_SDK_VERSION,
  readApplicationReleaseIdentity,
} from "./release-identity";
export type { ApplicationReleaseIdentity } from "./release-identity";
// Exported for `crumbtrail-node`, which reads the same provider flag shapes out
// of captured `env` events. One rule for what counts as a `{ value, variant }`
// wrapper, in one place: a second copy had already diverged on non-string
// variants, so the two packages disagreed about a flag's value.
export { normalizeFlagValue } from "./flags";
export type { NormalizedFlag } from "./flags";
export { EventBus } from "./event-bus";
export { RingBuffer } from "./ring-buffer";
export { HttpTransport, EventDeliveryError } from "./transports/http";
export {
  DEFAULT_SESSION_STORAGE_KEY,
  createWebSessionStore,
} from "./session-store";
export {
  WebTargetDescriptorResolver,
  webTargetDescriptorResolver,
} from "./target-resolver";
export * from "./redaction";
export {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_REQUEST_HEADER_LOWER,
  CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  CRUMBTRAIL_SESSION_HEADER,
  CRUMBTRAIL_SESSION_HEADER_LOWER,
  createCrumbtrailRequestHeaders,
  W3C_TRACEPARENT_HEADER,
  parseTraceparent,
  formatTraceparent,
  generateTraceId,
  generateSpanId,
  generateTraceContext,
  canInjectCorrelationHeaders,
  isCorrelationOriginHeaderRejected,
  resolveOutboundCorrelation,
} from "./correlation";
export type { W3CTraceContext, OutboundCorrelation } from "./correlation";
export { buildCaptureGapEvent } from "./capture-gap";
export type { BuildCaptureGapEventInput } from "./capture-gap";
export { normalizeStatementShape } from "./db-statement-shape";
export {
  buildMaskedDomSnapshot,
  isBlocked,
  isUnmasked,
  maskText,
} from "./masking";
export type {
  AddBugEventOptions,
  BugEvent,
  CaptureConfigPollingOptions,
  CrumbtrailCapabilities,
  CrumbtrailConfig,
  CrumbtrailIdentity,
  CrumbtrailPreset,
  CrumbtrailPlatform,
  CrumbtrailSdkDescriptor,
  CrumbtrailTransport,
  BugReport,
  CollectorCleanup,
  CollectorContext,
  DbDiffEventData,
  DbDiffBulkEventData,
  DbDiffOp,
  DbEngine,
  DbReadBulkEventData,
  DbReadEventData,
  DbErrorEventData,
  DbErrorOp,
  DbStatementEventData,
  DbStatementOp,
  CaptureGapEventData,
  EnvCampaign,
  EnvConnection,
  EnvDeclaration,
  EnvDevice,
  EnvSnapshot,
  FlagBugOptions,
  InteractionElementDescriptor,
  InteractionElementDescriptorFactory,
  TargetDescriptor,
} from "./types";
export type { PersistedSession, SessionStore } from "./session-store";
export type { TargetDescriptorResolver } from "./target-resolver";
export {
  environmentCollector,
  buildEnvSnapshot,
  buildEnvDelta,
} from "./collectors/environment";
export {
  CRUMBTRAIL_EVENT_KINDS,
  CRUMBTRAIL_SCHEMA_VERSION,
  DB_DIFF_BULK_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  DB_READ_BULK_EVENT_KIND,
  DB_READ_EVENT_KIND,
  DB_ERROR_EVENT_KIND,
  DB_STATEMENT_EVENT_KIND,
  CAPTURE_GAP_EVENT_KIND,
  UI_NUM_EVENT_KIND,
  UI_ERROR_EVENT_KIND,
  UI_LISTENERS_EVENT_KIND,
  UI_LAYOUT_EVENT_KIND,
  DEFAULT_CONFIG,
  PRESET_FULL,
  PRESET_LIGHT,
  PRESET_PASSIVE,
} from "./types";
export {
  computeElementSignature,
  computeElementPath,
  hashString,
} from "./signature";
export type { ElementSignature } from "./signature";
export { EVIDENCE_SCHEMA_VERSION } from "./evidence";
export type {
  EvidenceItem,
  EvidenceLane,
  EvidenceRef,
  IntentSignal,
} from "./evidence";
export { inferIntent } from "./intent";
export type { GitHostRef, CommitInfo, GitHostClient } from "./intent";
export { createAutoFlagController } from "./auto-flag";
export type { AutoFlagOptions, AutoFlagController } from "./auto-flag";
export {
  errorDetector,
  request5xxDetector,
  errorSignature,
  rageClickDetector,
  retryStormDetector,
  slowResponseDetector,
  abandonedFlowDetector,
  renderedErrorDetector,
} from "./signals";
export type {
  Signal,
  SignalDetector,
  ErrorDetectorOptions,
  RageClickOptions,
  RetryStormOptions,
  SlowResponseOptions,
  AbandonedFlowOptions,
} from "./signals";
export { FUSION_SCHEMA_VERSION, assembleBundle } from "./fusion";
export type {
  HypothesisKind,
  Symptom,
  Hypothesis,
  Verification,
  Located,
  ContextCompleteness,
  Escalation,
  EvidenceGap,
  RankedBundle,
  AssembleBundleInput,
} from "./fusion";
export { EVIDENCE_SOURCE_SCHEMA_VERSION } from "./evidence-source";
export type {
  EvidenceJoinKey,
  EvidenceSourceDescriptor,
  EvidenceQuery,
  EvidenceSourceResult,
} from "./evidence-source";
export {
  PROBE_NAMES,
  PROBE_DEFAULT_TIMEOUT_MS,
  PROBE_MAX_TIMEOUT_MS,
  PROBE_DEFAULT_MAX_ROWS,
  PROBE_MAX_MAX_ROWS,
  PROBE_DEFAULT_MAX_BYTES,
  PROBE_MAX_MAX_BYTES,
  isProbeName,
  runProbe,
} from "./probes";
export type {
  ProbeName,
  ProbeResult,
  ProbeContext,
  ProbeEnvDeclaration,
  ProbeStorageArea,
  ProbeStorageLike,
} from "./probes";
export { STACK_IDS } from "./stacks";
export { BRAND_FONT_STACK, BRAND_MONO_STACK } from "./brand-type";
export type { Stack } from "./stacks";
export {
  CAPSULE_SCHEMA_VERSION,
  GAP_REASONS,
  isGapReason,
  compileCapsuleV2,
} from "./capsule";
export type {
  KeyProvenance,
  GapReason,
  ExternalRef,
  CapsuleIdentity,
  CapsuleSymptom,
  OccurrenceImpact,
  CapsuleEvidence,
  JoinBasis,
  JoinEdge,
  JoinIsland,
  JoinGraph,
  JoinObservation,
  EvidenceProfile,
  GapDetail,
  Completeness,
  QualityReport,
  FixClass,
  AdvisoryOpinion,
  VerifiedFix,
  CapsuleMemory,
  CapsuleResolution,
  AgentDirections,
  CapsuleV2,
  CompileCapsuleV2Input,
} from "./capsule";
