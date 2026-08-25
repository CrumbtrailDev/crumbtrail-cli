import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_REDACTION_POLICY_V2,
  CAPTURE_GAP_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  normalizeFlagValue,
  redactInputValue,
  redactTokenLikeString,
  redactValue,
  unescapeRedactionMarker,
  type BugEvent,
  type DbEngine,
  type EnvCampaign,
  type EnvConnection,
  type EnvDevice,
  type EnvSnapshot,
} from "crumbtrail-core";
import {
  collectInteractiveElements,
  type InteractiveElement,
} from "./interactive-elements";
import { sanitizeSelector } from "./sanitize-selector";
import { groupDistinctBugs, type DistinctBug } from "./distinct-bugs";
import { redactedNetworkBodySnippet } from "./network-body";
import {
  clientCallsiteFromStack,
  clientCallsiteResolver,
} from "./client-callsite";
import type { EvidenceCandidate } from "./evidence-index";
import type { CausalConfidence } from "./causal-graph";
import { defaultSessionStore } from "./session-store";
import {
  measureDetectorPrevalence,
  type DetectorPrevalence,
} from "./detector-prevalence";

export const BROWSER_REDACTION_POLICY =
  "crumbtrail.browser-redaction.v1" as const;
type RedactionAction = "redacted" | "dropped" | "summarized";

const REDACTED_VALUE = "[REDACTED]";

export interface SessionIndexLike {
  id?: string;
  start?: number;
  end?: number;
  dur?: number;
  evts?: number;
  errs?: Array<{ t: number; msg: string }>;
  failedReqs?: Array<{
    t: number;
    m: string;
    url: string;
    st: number;
    id?: string | number;
    reason?: string;
    code?: string;
    message?: string;
    phase?: string;
  }>;
  networkErrors?: Array<{
    t: number;
    id?: string | number;
    m?: string;
    method?: string;
    url?: string;
    msg?: string;
    transport?: string;
    offsetMs?: number;
  }>;
  consoleErrors?: Array<{
    t: number;
    lv?: string;
    msg: string;
    source?: string;
    offsetMs?: number;
  }>;
  navs?: Array<{ t: number; to: string }>;
  stats?: Record<string, number>;
  tabBoundaries?: unknown[];
  pageProbe?: Partial<LlmBundlePageProbeSummary>;
  storageSummary?: unknown;
  redaction?: LlmBundleRedactionSummary;
  audio?: {
    artifact?: string;
    bytes?: number;
    upload?: Record<string, unknown>;
    transcription?: {
      state?: string;
      code?: string;
      message?: string;
      transcriptFile?: string;
      eventCount?: number;
    };
  };
  fullStackRequests?: unknown;
}

type LlmBundleFullStackGapKind =
  | "frontend-only"
  | "backend-only"
  | "backend-generated-request-id"
  | "backend-missing-session"
  | "backend-missing-request-id"
  | "backend-missing-session-and-request-id"
  | "client-missing-request-id";

export interface LlmBundleFullStackEventRef {
  t: number;
  iso?: string;
  offsetMs?: number;
  kind?: string;
}

export interface LlmBundleFrontendRequestEvidenceSummary {
  ref?: LlmBundleFullStackEventRef;
  requestId?: string;
  sessionId?: string;
  method?: string;
  url?: string;
  /**
   * Which GraphQL operation this request carried, when it carried one.
   *
   * `POST /graphql` is every request an application makes. Without the operation, a rendered
   * record shows one endpoint doing everything and a reader cannot tell the checkout mutation
   * from the search query.
   */
  gql?: { op: string; name?: string; batch?: number };
  status?: number;
  durationMs?: number;
  /**
   * Redacted snippet of what the browser sent, resolved from the session's own
   * `net.req` event by request id.
   *
   * A method, a path and a status code describe the shape of a request. On any
   * defect where the deciding value travelled in the payload — a client-supplied
   * price the server persisted, a stale form field, a unit the handler ignored —
   * that shape is a pointer to the problem rather than the problem.
   */
  requestBody?: string;
  /** Redacted snippet of what came back, from the matching `net.res` event. */
  responseBody?: string;
  /**
   * Where the application asked for this request, from the stack the browser
   * SDK captured at the call.
   *
   * The backend half of a linked request has carried a callsite for a while, on
   * `responseCallsite` and on the writes riding under `db.diff`. The frontend
   * half carried none, so a session whose defect never reached the server — or
   * reached it and got a correct answer back — produced a bundle naming only
   * server files. The reason written beside `responseCallsite` holds here
   * unchanged: a page that renders wrong without throwing had no pointer at all.
   *
   * Same shape as the database callsite, deliberately: it is the same question,
   * and `code_locations` already knows how to render a caller chain from it.
   */
  requestCallsite?: LlmBundleDbCallsite;
  error?: {
    message?: string;
    transport?: string;
  };
}

export interface LlmBundleBackendRequestEvidenceSummary {
  requestId?: string;
  sessionId?: string;
  correlation?: {
    status?: string;
    sessionIdSource?: string;
    requestIdSource?: string;
  };
  start?: LlmBundleFullStackEventRef;
  end?: LlmBundleFullStackEventRef;
  errorRef?: LlmBundleFullStackEventRef;
  method?: string;
  url?: string;
  pathname?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  /**
   * Redacted snippet of the response the handler sent, from the matching
   * `backend.req.end` event. Present only when the server SDK captured it.
   */
  responseBody?: string;
  /**
   * Where the app wrote a 5xx response. Callsites otherwise ride on `db.diff`,
   * so a handler that fails without writing had no pointer at all.
   */
  responseCallsite?: LlmBundleDbCallsite;
  error?: {
    name?: string;
    code?: string;
    message?: string;
    statusCode?: number;
  };
}

export interface LlmBundleLinkedFullStackRequestSummary {
  requestId: string;
  sessionId: string;
  frontend: LlmBundleFrontendRequestEvidenceSummary;
  backend: LlmBundleBackendRequestEvidenceSummary;
}

export interface LlmBundleFullStackRequestGapSummary {
  type: LlmBundleFullStackGapKind;
  requestId?: string;
  sessionId?: string;
  frontend?: LlmBundleFrontendRequestEvidenceSummary;
  backend?: LlmBundleBackendRequestEvidenceSummary;
}

export interface LlmBundleFullStackEvidence {
  schemaVersion: 1;
  summary: {
    frontendRequests: number;
    backendRequests: number;
    linked: number;
    gaps: number;
    gapTypes: Partial<Record<LlmBundleFullStackGapKind, number>>;
  };
  linked: LlmBundleLinkedFullStackRequestSummary[];
  gaps: LlmBundleFullStackRequestGapSummary[];
  limitations: string[];
}

export interface LlmBundleArtifact {
  path: string;
  role: "generated" | "source" | "index" | "media" | "derived" | "directory";
  description: string;
  exists: boolean;
  bytes?: number;
  entries?: number;
}

export interface LlmBundleTimelineMoment {
  t: number;
  iso?: string;
  offsetMs?: number;
  k: string;
  summary: string;
}

export interface LlmBundleDegradedCapability {
  capability: string;
  state: string;
  source: "metadata" | "event" | "post-process" | "artifact";
  code?: string;
  message?: string;
  phase?: string;
  retryable?: boolean;
  artifact?: string;
  t?: number;
  offsetMs?: number;
}

export interface LlmBundleRedactionSummary {
  policy: typeof BROWSER_REDACTION_POLICY;
  browserFirst: true;
  renderedBundleSanitization: string[];
  eventsWithRedactionEvidence: number;
  redactedFields: number;
  payloadSummaries: number;
  reasons: Record<string, number>;
  actions: Partial<Record<RedactionAction, number>>;
  notes: string[];
}

/**
 * Deterministic capture completeness summary. A session is `complete` with zero gaps. It is
 * `degraded` when at least one gap exists but both a backend request event and a database diff
 * still provide the core request to database join evidence. Every other nonzero gap state is
 * `fragmentary`, because the differentiated path has little or no join evidence.
 */
export interface LlmBundleCompleteness {
  gapCount: number;
  gapsBySurface: Record<string, number>;
  gapsByReason: Record<string, number>;
  /**
   * Events the gaps account for, summed across those that could count.
   *
   * `gapCount` is a number of holes, not a size. Three gap records covering six
   * thousand dropped events and three covering three are the same `gapCount`
   * and are not the same session.
   */
  droppedEventCount: number;
  grade: "complete" | "degraded" | "fragmentary";
}

export interface LlmBundleFailedRequestSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  method?: string;
  url?: string;
  status?: number;
  reason?: string;
  code?: string;
  message?: string;
  phase?: string;
  /** Bounded, redacted request payload evidence when it was captured. */
  requestBody?: string;
  /** Bounded, redacted response payload evidence when it was captured. */
  responseBody?: string;
  /** Number of same-signature entries this exemplar represents. Present only when >= 2. */
  count?: number;
  /** Earliest `t` across the compacted same-signature run. Present only when `count` is. */
  firstAt?: number;
  /** Latest `t` across the compacted same-signature run. Present only when `count` is. */
  lastAt?: number;
}

export interface LlmBundleNetworkErrorSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  method?: string;
  url?: string;
  message?: string;
  transport?: string;
  /** Bounded, redacted request payload evidence when it was captured. */
  requestBody?: string;
  /** Number of same-signature entries this exemplar represents. Present only when >= 2. */
  count?: number;
  /** Earliest `t` across the compacted same-signature run. Present only when `count` is. */
  firstAt?: number;
  /** Latest `t` across the compacted same-signature run. Present only when `count` is. */
  lastAt?: number;
}

export interface LlmBundleConsoleErrorSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  level: string;
  message: string;
  source?: string;
  /** Number of same-signature entries this exemplar represents. Present only when >= 2. */
  count?: number;
  /** Earliest `t` across the compacted same-signature run. Present only when `count` is. */
  firstAt?: number;
  /** Latest `t` across the compacted same-signature run. Present only when `count` is. */
  lastAt?: number;
}

export interface LlmBundlePageProbeErrorSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  phase?: string;
  message?: string;
  source?: string;
}

export interface LlmBundlePageProbeSummary {
  requested: boolean;
  readyEvents: number;
  errorEvents: number;
  frameContexts: number;
  startedContexts: number;
  limitedContexts: number;
  features: Record<string, boolean>;
  errors: LlmBundlePageProbeErrorSummary[];
  limitations: string[];
}

export interface LlmBundleTabBoundaryDecisionSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  signal?: string;
  decision?: string;
  reason?: string;
  capture?: boolean;
  nonCapture?: boolean;
  previousCapturedOrigin?: string;
  root?: LlmBundleTabBoundaryLocationSummary;
  current?: LlmBundleTabBoundaryLocationSummary;
  candidate?: LlmBundleTabBoundaryLocationSummary;
  prompt?: {
    origin?: string;
    outcome?: string;
  };
}

export interface LlmBundleTabBoundaryLocationSummary {
  origin?: string;
  host?: string;
  scheme?: string;
  valid?: boolean;
  restricted?: boolean;
  opaque?: boolean;
  isLocalhost?: boolean;
}

export interface LlmBundleTabBoundarySummary {
  total: number;
  decisionCounts: Record<string, number>;
  nonCaptureCount: number;
  decisions: LlmBundleTabBoundaryDecisionSummary[];
}

/**
 * One `k:'stor'` event: a local or session storage key that changed during the
 * session. Keys and values were redacted in the browser before capture; this
 * carries what survived rather than re-deriving anything.
 *
 * Counted-but-not-carried is the failure this closes. A session can hold
 * hundreds of storage writes, report them in `eventCounts`, and expose neither
 * the key nor the value — which makes any defect about state outliving its
 * owner (a draft restored after it was submitted, a cache never invalidated, a
 * flag never cleared) invisible in the artifact an agent reads.
 */
export interface LlmBundleStorageChange {
  t: number;
  iso?: string;
  offsetMs?: number;
  /** `local` or `session`, as the collector recorded it. */
  area?: string;
  /** `set`, `del`, or `clear`. */
  op?: string;
  key?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface LlmBundleBrowserEvidence {
  pageProbe: LlmBundlePageProbeSummary;
  failedRequests: LlmBundleFailedRequestSummary[];
  networkErrors: LlmBundleNetworkErrorSummary[];
  consoleErrors: LlmBundleConsoleErrorSummary[];
  tabBoundaries: LlmBundleTabBoundarySummary;
  interactiveElements: InteractiveElement[];
  /** Redaction-aware storage writes captured during the session; `[]` when none. */
  storageChanges: LlmBundleStorageChange[];
  /** Labeled numbers the page displayed, grouped by label; `[]` when none. */
  screenNumbers: LlmBundleScreenNumber[];
  /**
   * Requests that SUCCEEDED in the window before the first error-class event.
   *
   * `failedRequests` answers "which request broke", and for a large share of real
   * defects nothing did: the request returned 200 and carried the wrong value.
   * A cart that answers `{"items": null}` with a 200 is the bug, and every
   * handoff the product builds — the markdown export, the agent context, the
   * MCP fix context, the issue page's correlated-record counts — read only the
   * failed set, so that response was captured perfectly and then reached none
   * of them. The reader's only route to it was calling `getWindow` with two
   * epoch timestamps they had to work out themselves.
   *
   * These are deliberately NOT presented as suspects. Nothing here is known to
   * be wrong; they are what the page asked for and got back immediately before
   * it broke, which is the set a person reads first and the set an agent cannot
   * reconstruct from an error message. `[]` when the session recorded no error
   * to anchor on, or no successful request inside the window.
   */
  precedingRequests: LlmBundlePrecedingRequestSummary[];
}

/**
 * One request that completed successfully in the window before the failure.
 *
 * Same shape as a failed request minus the failure fields, because the reader
 * is doing the same thing with it: looking at what was sent and what came back.
 */
export interface LlmBundlePrecedingRequestSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  /** Milliseconds between this response and the first error-class event. */
  beforeErrorMs?: number;
  method?: string;
  url?: string;
  status?: number;
  /** Bounded, redacted request payload evidence when it was captured. */
  requestBody?: string;
  /** Bounded, redacted response payload evidence when it was captured. */
  responseBody?: string;
}

/**
 * One labeled number the page put in front of the user, and every value it took.
 *
 * Most correctness defects are a 200 carrying the wrong value, and the wrong value is the one the
 * user SAW. The `uiNumbers` collector has always captured these; nothing printed them, so the
 * bundle could describe every request in a session and never state the number on the screen that
 * made someone file the report.
 *
 * A label with more than one distinct value is listed first. That is usually the finding rather
 * than a step towards it: on a real gift-card capture the list said `GC-PARTIAL-002 $12.5` and the
 * detail page said `Balance $50` at the same instant, which is the entire defect in two rows.
 */
export interface LlmBundleScreenNumber {
  label: string;
  unit?: string;
  /** Distinct values in the order first seen, with the offset each was first observed at. */
  values: Array<{ value: number; offsetMs?: number }>;
  /** Where on the page, innermost region selector as the collector reported it. */
  regions: string[];
}

export const AGENT_CONTEXT_SCHEMA_VERSION =
  "crumbtrail.agent_context.v1" as const;

export interface LlmBundleAgentContextTimelineEntry {
  t: number;
  iso?: string;
  offsetMs?: number;
  kind:
    "navigation" | "error" | "failed-request" | "click" | "input" | "key-count";
  summary: string;
  target?: string;
  field?: string;
  count?: number;
  requestBody?: string;
  responseBody?: string;
}

export interface LlmBundleAgentContext {
  schemaVersion: typeof AGENT_CONTEXT_SCHEMA_VERSION;
  timeline: LlmBundleAgentContextTimelineEntry[];
}

/**
 * A flag value paired with the provider variant that produced it, when one is known.
 *
 * Mirrors `NormalizedFlag` in `packages/core/src/flags.ts`, which is deliberately not
 * re-exported from `crumbtrail-core`'s entry point (see the note at `crumbtrail.ts:68`), so
 * this side of the wire reads the shape rather than importing it.
 */
export interface LlmBundleFlagValue {
  value: unknown;
  /** Provider variant key, present only when the app declared a string one. */
  variant?: string;
}

/**
 * One flag moving, stamped with the `k:'env'` event that reported the move.
 *
 * This is a sequence rather than a map keyed by flag name on purpose. A flag that flips on and
 * back off inside one session is the single most diagnostic thing a flag can do, and a
 * last-write-wins map reports it as "unchanged" — the two moves collapse onto each other and
 * the artifact says nothing happened. Ordered entries keep both moves, in the order they
 * happened, next to the offset an agent can line up against the error timeline.
 */
export interface LlmBundleFlagChange {
  t: number;
  iso?: string;
  offsetMs?: number;
  /** Flag name, as the app declared it. */
  flag: string;
  /** State before the move. Absent means the flag did not exist yet. */
  from?: LlmBundleFlagValue;
  /** State after the move. Absent means the flag was removed. */
  to?: LlmBundleFlagValue;
}

/**
 * Merged, redaction-aware environment snapshot surfaced from the session's `k:'env'` events
 * (initial snapshot + any `setEnv` deltas). Device fields are best-effort; `flags`/`config`
 * were redacted in the browser before capture. `null` when no env was captured.
 */
export interface LlmBundleEnvironment {
  userAgent?: string;
  browser?: { name: string; version?: string };
  os?: string;
  viewport?: { w: number; h: number };
  locale?: string;
  timezone?: string;
  /**
   * Public client release identity declared by `<meta name="app-build">`, captured into the
   * `k:'env'` snapshot. An agent reasoning about a regression needs to know which build it
   * happened on, so this is carried through the whitelist rather than dropped.
   */
  appBuild?: string;
  flags?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** `document.referrer` at session start. Redacted through the normal URL path. */
  referrer?: string;
  /** First-party `utm_*` acquisition labels. Only present when capture had `campaign` enabled. */
  campaign?: EnvCampaign;
  /** Display characteristics that change how a rendering defect reproduces. */
  device?: EnvDevice;
  /** Network Information API view of the connection at session start. */
  connection?: EnvConnection;
  /** `navigator.deviceMemory` in GiB, where the runtime exposes it. */
  deviceMemory?: number;
  /** `navigator.hardwareConcurrency`. */
  hardwareConcurrency?: number;
  /**
   * Provider variant key per flag, for flags the app declared as `{ value, variant }` rather
   * than a bare value. Merged last-write-wins alongside `flags`, so it names the variant in
   * force at the end of the session.
   *
   * `flags` carries the declaration verbatim, which means a wrapped flag lands there as an
   * opaque object indistinguishable from a flag whose value simply is an object. An agent
   * asking "which arm of the experiment was this user in" needs the answer named, not encoded.
   */
  flagVariants?: Record<string, string>;
  /**
   * Every flag move the session reported, oldest first. Empty-to-absent: the key is omitted
   * when no `k:'env'` event carried a change. Values are redacted the same way `flags` is.
   */
  flagChanges?: LlmBundleFlagChange[];
}

/**
 * `EnvSnapshot` keys the bundle deliberately does not surface as its own environment field.
 *
 * - `kind` discriminates snapshot/delta/flag-snapshot at the wire level. The bundle merges those
 *   events into one environment, so the discriminator has no meaning after the merge.
 * - `redaction` is browser-side redaction bookkeeping, not evidence about the app.
 * - `flags` and `config` ARE carried, and are named here only because they are populated by the
 *   merge loop below rather than by the `removeUndefined` block. Listing them keeps the exclusion
 *   set readable: nothing in it is a silent drop.
 */
type EnvSnapshotDeliberatelyExcluded =
  | "kind"
  | "redaction"
  | "flags"
  | "config";

/** Any `EnvSnapshot` field that is neither carried into the bundle nor explicitly excluded. */
type UncarriedEnvSnapshotKey = Exclude<
  keyof EnvSnapshot,
  keyof LlmBundleEnvironment | EnvSnapshotDeliberatelyExcluded
>;

/**
 * Fail-loud guard on the environment whitelist.
 *
 * `buildEnvironment` is an explicit whitelist, so a field added to `EnvSnapshot` and captured on
 * the wire is silently discarded at bundle time unless someone remembers to widen the whitelist
 * too. That failure looks like a capture bug and gets debugged as one. This sentinel turns it into
 * a compile error instead: the moment an `EnvSnapshot` key is neither a key of
 * `LlmBundleEnvironment` nor named in `EnvSnapshotDeliberatelyExcluded`, `UncarriedEnvSnapshotKey`
 * stops being `never` and the annotation below resolves to `never`, which `true` cannot satisfy.
 */
const _envWhitelistIsExhaustive: UncarriedEnvSnapshotKey extends never
  ? true
  : never = true;
void _envWhitelistIsExhaustive;

/**
 * Redaction-aware summary of one `k:'db.diff'` event (a row that changed during a request),
 * correlated to the request via `requestId`. CP5 DB diffing. Sensitive columns were dropped in the
 * shim; bundle build re-runs the redaction policy as defense-in-depth.
 */
/**
 * One call the server made outward, from a `backend.http` event.
 *
 * The application's own semantic fields travel with it — `service`, `operation`, and whatever
 * else the integration named (a charge id, a charge status, an attempt number) — because those are
 * the fields that say what the call was FOR. A row reading "POST 200" proves reachability and
 * nothing else; "payments charge succeeded, ch_0001" is the evidence.
 */
export interface LlmBundleOutboundCall {
  t: number;
  iso?: string;
  offsetMs?: number;
  /** The integration the application named, e.g. `payments`, `pricing`. */
  service?: string;
  /** What it was doing, when the application said so, e.g. `charge`. */
  operation?: string;
  method?: string;
  url?: string;
  /** `0` on a call that never got a response — the transport failed. */
  status?: number;
  durationMs?: number;
  /** The transport-level failure, when there was one, e.g. `fetch failed`. */
  error?: string;
  /** The inbound request being served when this call went out. */
  requestId?: string;
  /** Redacted application-supplied fields beyond the transport ones above. */
  detail?: Record<string, unknown>;
}

export interface LlmBundleDbDiff {
  t: number;
  iso?: string;
  offsetMs?: number;
  engine: DbEngine;
  op: "insert" | "update" | "delete";
  table: string;
  pk: Record<string, unknown> | null;
  after?: Record<string, unknown>;
  before?: Record<string, unknown>;
  /**
   * Only set on an image-less statement-level fallback event (`pk: null`, no `after`/`before`)
   * where per-row images were unobtainable — records how many rows the statement changed so the
   * write stays visible to differencing.
   */
  rowCount?: number;
  requestId?: string;
  /**
   * Where the application issued this write: the innermost host frame plus the
   * app frames above it. Present only when the SDK was run with
   * `captureCallsite`.
   *
   * A diff says a row changed. Without this the agent still has to go looking
   * for the line that changed it, which on a defect like "the total is written
   * from the client's value" is the entire answer.
   */
  callsite?: LlmBundleDbCallsite;
}

/** One frame of a `db.diff` callsite chain, repo-relative where derivable. */
export interface LlmBundleDbCallsite {
  file: string;
  line?: number;
  column?: number;
  fn?: string;
  /**
   * The generated path `file` was resolved FROM, when a source map resolved it.
   *
   * Present only on a frame that actually moved. Its absence means the path is
   * as the runtime reported it — so a reader can tell a resolved location from an
   * unresolved one instead of having to trust that resolution ran, and the claim
   * stays checkable against the build.
   */
  minifiedFile?: string;
  /** App frames above this one, innermost first. Never nested further. */
  stack?: LlmBundleDbCallsite[];
}

export interface LlmBundleDbRead {
  t: number;
  iso?: string;
  offsetMs?: number;
  engine: DbEngine;
  table: string;
  pk: Record<string, unknown> | null;
  row: Record<string, unknown>;
  /**
   * Normalized shape of the SELECT that produced this row, when the adapter had the statement
   * text. Keywords, identifiers and placeholders only — every literal is replaced before it is
   * stored, so no bind value and no customer value travels here.
   *
   * Present because a row cannot be read against the question it answered otherwise. `row` says
   * what the database held; `shape` says what was asked for it, and a filter with the wrong
   * boolean grouping produces a perfectly correct-looking row from a perfectly successful query.
   */
  shape?: string;
  requestId?: string;
}

/**
 * One database statement the host issued that the database ACCEPTED (`k:'db.statement'`).
 *
 * The counterpart of {@link LlmBundleDbError}, and the plane that makes a successful query legible
 * at all. `databaseDiffs` and `databaseReads` describe a statement through what it returned, so a
 * statement returning nothing — a SELECT matching zero rows, a transaction boundary, an UPDATE
 * that matched nothing — left no trace, and one that DID return rows was described by the rows
 * rather than by what it asked. Every defect in what was ASKED lives here and nowhere else.
 *
 * Same subtractive contract as the failed plane: `shape` carries no literal, and `rowCount` is a
 * count and not a row.
 */
export interface LlmBundleDbStatement {
  t: number;
  iso?: string;
  offsetMs?: number;
  engine: DbEngine;
  op: string;
  table: string | null;
  shape: string;
  /** Rows returned or affected; `null` when the driver reported no count. `0` is meaningful. */
  rowCount: number | null;
  /** 1-based ordinal within the request, so execution order survives the sort. */
  seq?: number;
  requestId?: string;
}

/**
 * One database statement the host ATTEMPTED and the database REFUSED (`k:'db.error'`).
 *
 * Distinct from a capture gap, which says our own instrumentation broke. Every field is an
 * identifier, a classification or the database's own error code: no bind value and no driver
 * message reaches here, and `shape` is the statement with every literal replaced.
 */
export interface LlmBundleDbError {
  t: number;
  iso?: string;
  offsetMs?: number;
  engine: DbEngine;
  op: string;
  table: string | null;
  shape: string;
  code: string | null;
  errorName: string;
  requestId?: string;
}

export interface LlmBundleDbActivity {
  t: number;
  iso?: string;
  offsetMs?: number;
  evidenceType: "otel_db_activity_statements_not_row_diffs";
  system?: string;
  operation?: string;
  statement?: string;
  spanName?: string;
  serviceName?: string;
  requestId?: string;
  upgradeHint: string;
}

/**
 * The five Core Web Vitals the cloud reads, and nothing else.
 *
 * This vocabulary is a cross-repo contract: the cloud's normalizer accepts
 * exactly these keys and silently drops anything outside the set, so an extra
 * key here is not an error the reader ever sees, it is data thrown away.
 */
export type LlmBundleVitalName = "lcp" | "cls" | "inp" | "ttfb" | "fcp";

/** Core Web Vitals rating bands, as the specification names them. */
export type LlmBundleVitalRating = "good" | "needs_improvement" | "poor";

export interface LlmBundleVital {
  value: number;
  /**
   * Optional in the contract. Present here for all five metrics because all
   * five have published thresholds; a metric without a defensible threshold
   * would omit this rather than invent one.
   */
  rating?: LlmBundleVitalRating;
}

/**
 * Finalized web vitals for the session.
 *
 * Partial by design. A metric whose finalized score event never arrived is
 * OMITTED, never null and never zero: a page that produced no layout shift and
 * a page whose score was never reported are different facts, and a zero would
 * report the second as the first.
 */
export type LlmBundleVitals = Partial<
  Record<LlmBundleVitalName, LlmBundleVital>
>;

/**
 * Which `k:'perf'` metric name carries each canonical vital.
 *
 * The collector emits both a stream of raw per-entry candidates (`lcp`,
 * `cls`) and a single finalized score (`lcp.final`, `cls.score`). Only the
 * finalized events are aggregated. The raw `lcp` stream is a series of
 * ever-larger guesses, so its last member is whichever candidate happened to
 * arrive last rather than the one the collector froze as the answer; reading it
 * would produce a plausible number that is quietly wrong. The raw stream stays
 * in `events.ndjson` for a reader chasing a jumpy page.
 */
const VITAL_SOURCE_METRICS: Record<string, LlmBundleVitalName> = {
  "lcp.final": "lcp",
  "cls.score": "cls",
  inp: "inp",
  ttfb: "ttfb",
  fcp: "fcp",
};

/**
 * Core Web Vitals thresholds, in one table rather than at call sites.
 *
 * `good` is the upper bound of the good band inclusive; anything above `poor`
 * is poor, and the span between them is `needs_improvement`. Times are
 * milliseconds; CLS is unitless.
 */
const VITAL_THRESHOLDS: Record<
  LlmBundleVitalName,
  { good: number; poor: number }
> = {
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
};

function rateVital(
  name: LlmBundleVitalName,
  value: number,
): LlmBundleVitalRating {
  const { good, poor } = VITAL_THRESHOLDS[name];
  if (value <= good) return "good";
  if (value > poor) return "poor";
  return "needs_improvement";
}

/**
 * Projects the session's finalized `k:'perf'` score events onto the canonical
 * five vitals the cloud reads.
 *
 * Returns `undefined` — not an empty object — when no score event was captured,
 * so the `vitals` key is omitted entirely rather than present and empty. A
 * session ended in a way that discards the final batch simply reports fewer
 * metrics; every metric is independent and an absent one costs nothing.
 */
export function summarizeVitals(
  events: BugEvent[],
): LlmBundleVitals | undefined {
  const vitals: LlmBundleVitals = {};
  let found = false;

  for (const event of events) {
    if (event.k !== "perf") continue;
    const d = isRecord(event.d) ? event.d : undefined;
    if (!d) continue;
    const metric = typeof d.metric === "string" ? d.metric : undefined;
    if (metric === undefined) continue;
    const name = Object.prototype.hasOwnProperty.call(
      VITAL_SOURCE_METRICS,
      metric,
    )
      ? VITAL_SOURCE_METRICS[metric]
      : undefined;
    if (name === undefined) continue;
    const value = finiteNumber(d.value);
    if (value === undefined) continue;

    // Last finalized reading wins. Each score is emitted once per session, so
    // this only matters for a replayed or merged stream, where the later
    // reading is the more complete one.
    vitals[name] = { value, rating: rateVital(name, value) };
    found = true;
  }

  return found ? vitals : undefined;
}

export interface LlmBundle {
  schemaVersion: 1;
  kind: "crumbtrail.agent-session-bundle";
  generatedAt: number;
  generatedAtIso: string;
  /**
   * Earliest error-class evidence timestamp (ms) available at build time: failed requests,
   * network errors, console errors, and runtime errors from the index. Omitted entirely when
   * the session produced no error-class events.
   */
  firstErrorEventAt?: number;
  /**
   * Self-measured detect-to-bundle latency: `generatedAt - firstErrorEventAt`, clamped to >= 0.
   * Omitted whenever {@link LlmBundle.firstErrorEventAt} is omitted.
   */
  detectToBundleMs?: number;
  sessionDir: string;
  session: {
    id: string;
    name?: string;
    source?: string;
    app?: string;
    startMs: number;
    startIso?: string;
    endMs: number;
    endIso?: string;
    durationMs: number;
    metadata: Record<string, unknown>;
  };
  artifacts: LlmBundleArtifact[];
  eventCounts: Record<string, number>;
  keyTimelineMoments: LlmBundleTimelineMoment[];
  /** Compact, action-oriented context for coding agents. */
  agentContext: LlmBundleAgentContext;
  browserEvidence: LlmBundleBrowserEvidence;
  fullStackEvidence: LlmBundleFullStackEvidence;
  /**
   * Deterministic within-session grouping of detector signals into DISTINCT labeled bugs.
   * `[]` when no signals were detected. See {@link DistinctBug}.
   */
  distinctBugs: DistinctBug[];
  /**
   * How often each of this session's detectors fired in the OTHER sessions already in the store —
   * the one question a per-session analysis structurally cannot answer, because the answer is a
   * fact about the store. See {@link DetectorPrevalence}.
   *
   * ABSENT, rather than zero-filled, whenever the store holds too few prior sessions to say
   * anything: a first session has no priors, so unknown is this field's default state, and
   * consumers MUST render its absence as nothing at all. An absent base rate is not a low one.
   *
   * Additive disclosure. It is not an input to any ordering, score or severity, and
   * `distinctBugs` is the same list in the same order whether this is present or not.
   */
  detectorPrevalence?: LlmBundleDetectorPrevalence;
  /** Redaction-aware environment snapshot for the session, or `null` when none was captured. */
  environment: LlmBundleEnvironment | null;
  /**
   * Finalized Core Web Vitals for the session, keyed by {@link LlmBundleVitalName}.
   *
   * OMITTED entirely when the session captured no finalized score event, and
   * individual metrics are omitted the same way. Additive: nothing in the
   * bundle is ordered, scored or gated by it.
   */
  vitals?: LlmBundleVitals;
  /**
   * Root → symptom causal tree projected from detector signals' CP3 causal fields. Additive
   * and optional: absent when no candidate carries `causalRole: 'root'` with attributed symptoms.
   * Consumers MUST NOT treat its absence as "no bug"; it only means no root→symptom structure was
   * surfaced. Never recomputes attribution — a pure projection of `candidates`.
   */
  causalTree?: LlmBundleCausalRoot[];
  /** Redaction-aware row diffs captured during the session (`k:'db.diff'`); `[]` when none. */
  databaseDiffs: LlmBundleDbDiff[];
  /** Redaction-aware rows read during the session (`k:'db.read'`); `[]` when none. */
  databaseReads: LlmBundleDbRead[];
  /**
   * Statements that were attempted and SUCCEEDED (`k:'db.statement'`).
   *
   * Optional and OMITTED when empty rather than emitted as `[]`, matching `databaseErrors`: a
   * session captured by an SDK or an engine that does not record statements must not present as a
   * session that ran none.
   */
  databaseStatements?: LlmBundleDbStatement[];
  /**
   * Statements that were attempted and RAISED (`k:'db.error'`).
   *
   * Optional and OMITTED when empty, not emitted as `[]`. A session in which nothing failed must
   * serialize exactly as it did before this plane existed — the absence of a failure is not a
   * finding, and every existing bundle would otherwise gain a field that says nothing.
   */
  databaseErrors?: LlmBundleDbError[];
  /** OTel DB spans/statements (`db.*` attributes), explicitly not row diffs. */
  databaseActivity: LlmBundleDbActivity[];
  /**
   * Calls the SERVER made outward, to a third party or a sibling service (`k:'backend.http'`);
   * `[]` when none. Distinct from `fullStackEvidence`, which pairs a browser request with the
   * server handler that answered it — this is the leg beyond that handler, where a gateway, a
   * pricing service or a webhook lives.
   */
  outboundCalls: LlmBundleOutboundCall[];
  media: {
    alignment: {
      sessionStartMs: number;
      rules: string[];
    };
    video: MediaArtifactSummary;
    audio: MediaArtifactSummary & {
      upload?: Record<string, unknown>;
      transcription?: Record<string, unknown>;
    };
    transcript: MediaArtifactSummary & { eventCount: number };
    voiceMarkers: Array<{
      t: number;
      iso?: string;
      offsetMs?: number;
      label?: string;
      markerId?: string;
    }>;
  };
  degradedCapabilities: LlmBundleDegradedCapability[];
  /** Completeness contract derived only from the session's `capture_gap` events. */
  completeness: LlmBundleCompleteness;
  redaction: LlmBundleRedactionSummary;
  limitations: string[];
  inspectionGuide: Array<{ step: number; path: string; purpose: string }>;
}

/**
 * The cross-session base rate of the detectors THIS session produced, carried into the bundle so
 * the count and its denominator travel together. A bare proportion whose base a reader cannot see
 * is not a measurement they can weigh.
 *
 * Only detectors this session actually produced appear: the bundle describes this session, and the
 * store's full detector census belongs to the store, not to one incident's brief.
 */
export interface LlmBundleDetectorPrevalence {
  /** Sessions other than this one that the scan actually READ — the denominator. */
  priorSessions: number;
  /**
   * Present and true only when the store held more prior sessions than the scan is allowed to read
   * and the most recent were taken. Then `priorSessions` is the scanned slice, not the store, and
   * both the cell and the paragraph that explains it must name the slice. Omitted entirely when the
   * whole store was read, so a complete measurement carries no field at all rather than a `false`.
   */
  truncated?: boolean;
  /** Per detector present in this session, how many of those prior sessions it fired in. */
  detectors: Array<{ detector: string; priorSessionsFiredIn: number }>;
}

/** A downstream symptom nested under a root in {@link LlmBundleCausalRoot}. */
export interface LlmBundleCausalSymptom {
  id: string;
  detector: string;
  title: string;
  attributionConfidence?: CausalConfidence;
}

/** A root cause with its nested symptoms, built from detector signal causal fields (CP4). */
export interface LlmBundleCausalRoot {
  id: string;
  detector: string;
  title: string;
  symptoms: LlmBundleCausalSymptom[];
}

interface MediaArtifactSummary {
  path: string;
  exists: boolean;
  bytes?: number;
  eventCount: number;
  firstState?: string;
  lastState?: string;
}

export interface WriteLlmBundleInput {
  sessionDir: string;
  events: BugEvent[];
  index: SessionIndexLike;
  /** Ranked evidence candidates for the session; grouped into `distinctBugs`. Defaults to `[]`. */
  candidates?: EvidenceCandidate[];
  /**
   * Where to measure detector base rates ACROSS. Defaults to the store root derived from
   * `sessionDir`, which is correct for a deployment. Pass it when the corpus is somewhere else —
   * a session replayed or imported into a directory of its own would otherwise measure itself
   * against a corpus of one and report every detector as universal.
   *
   * Read only by {@link writeLlmBundle}, which does the scan; {@link buildLlmBundle} is pure and
   * takes the finished measurement through `prevalence` instead.
   */
  corpusRoot?: string;
  /**
   * A base-rate measurement made by the caller. When omitted, {@link writeLlmBundle} measures it
   * and {@link buildLlmBundle} renders no base rates at all — the absence renders as nothing,
   * never as zero.
   */
  prevalence?: DetectorPrevalence;
}

interface RedactionAccumulator {
  eventsWithRedactionEvidence: number;
  redactedFields: number;
  payloadSummaries: number;
  reasons: Record<string, number>;
  actions: Partial<Record<RedactionAction, number>>;
}

const KNOWN_ARTIFACTS: Array<{
  path: string;
  role: LlmBundleArtifact["role"];
  description: string;
  generated?: boolean;
}> = [
  {
    path: "CANDIDATES.md",
    role: "generated",
    description:
      "Primary deterministic ranked issue list; start here before raw replay artifacts.",
    generated: true,
  },
  {
    path: "candidates.jsonl",
    role: "generated",
    description:
      "Machine-readable normalized candidate rows with schemaVersion and stable candidate IDs.",
    generated: true,
  },
  {
    path: "timeline.md",
    role: "generated",
    description: "Five-minute bucketed session map for long recordings.",
    generated: true,
  },
  {
    path: "search.jsonl",
    role: "generated",
    description:
      "Redacted normalized grep friendly search corpus linked to detector signals.",
    generated: true,
  },
  {
    path: "windows",
    role: "directory",
    description: "Focused markdown evidence windows, one per candidate.",
    generated: true,
  },
  {
    path: "manifest.json",
    role: "index",
    description:
      "Hot-plane session manifest for ranked, bounded agent retrieval.",
    generated: true,
  },
  {
    path: "bundle.json",
    role: "generated",
    description: "V2 alias for the machine-readable agent bundle.",
    generated: true,
  },
  {
    path: "opinion.md",
    role: "generated",
    description:
      "Optional LLM produced opinion generated only when explicitly opted in.",
    generated: true,
  },
  {
    path: "opinion.json",
    role: "generated",
    description:
      "Machine readable optional LLM produced opinion generated only when explicitly opted in.",
    generated: true,
  },
  {
    path: "opinion.audit.json",
    role: "generated",
    description:
      "Audit record of the redacted evidence bundle and prompt sent for the optional opinion.",
    generated: true,
  },
  {
    path: "llm.md",
    role: "generated",
    description:
      "Human-readable guide for a future agent inspecting this session.",
    generated: true,
  },
  {
    path: "llm.json",
    role: "generated",
    description: "Machine-readable version of the agent inspection guide.",
    generated: true,
  },
  {
    path: "meta.json",
    role: "source",
    description: "Session metadata written by the local server.",
  },
  {
    path: "index.json",
    role: "index",
    description:
      "Post-processed event counts, navigation, failures, storage, and audio summary.",
  },
  {
    path: "events.ndjson",
    role: "source",
    description:
      "Raw timestamped event stream; inspect after reading the summaries and redaction notes.",
  },
  {
    path: "events.ndjson.zst",
    role: "source",
    description:
      "Cold-plane zstd-compressed, redaction-sanitized event stream generated at finalize.",
  },
  {
    path: "signatures.json",
    role: "index",
    description:
      "Cold-plane component signature dictionary used to deduplicate repeated element descriptors.",
  },
  {
    path: "capture-truncated.json",
    role: "index",
    description: "Session byte-cap marker written when capture stops early.",
  },
  {
    path: "recording.webm",
    role: "media",
    description: "Active-tab video recording, if video capture succeeded.",
  },
  {
    path: "audio.webm",
    role: "media",
    description:
      "Continuous microphone audio or voice-note-compatible audio, if captured.",
  },
  {
    path: "audio.json",
    role: "source",
    description: "Safe upload metadata for audio.webm.",
  },
  {
    path: "transcript.json",
    role: "derived",
    description: "Local speech-to-text output, if transcription succeeded.",
  },
  {
    path: "voice.webm",
    role: "media",
    description: "Legacy bug voice-note artifact, if present.",
  },
  {
    path: "frames",
    role: "directory",
    description: "Frame stills directory used by older snapshot/MCP workflows.",
  },
];

const IMPORTANT_EVENT_KINDS = new Set([
  "session.lifecycle",
  "nav",
  "tab.boundary",
  "err",
  "rej",
  "clk",
  "inp",
  "snap",
  "con",
  "probe.ready",
  "probe.error",
  "frame.ctx",
  "net.err",
  "perf",
  "media.video",
  "media.voice",
  // Push transports. A capture that patched fetch and XHR and then printed nothing a socket said
  // reads as "no traffic explains this", which for a socket-driven application is false.
  "net.sse",
  "net.ws",
  // Worker traffic. A worker is a second program this SDK cannot see inside, and its message
  // protocol is the only account of what it was asked to do and what it answered.
  "worker.msg",
  // Work outside a request. The request succeeded and the user saw a confirmation; whether the job
  // that confirmation promised ever ran is a separate fact, and often the whole defect.
  "backend.job.start",
  "backend.job.end",
  "backend.job.error",
  // A policy refusal is the quietest way for a feature to stop existing: no error, no request.
  "csp",
]);

// Writes through the SessionStore seam, not fs: llm.md/llm.json are finalize-time
// cold artifacts rendered from the same events as events.ndjson, so an embedder
// decorating storage (at-rest encryption) has to see them.
export async function writeLlmBundle(
  input: WriteLlmBundleInput,
): Promise<LlmBundle> {
  // Measured here rather than inside buildLlmBundle because it is the one part of the bundle that
  // reads OTHER sessions, and buildLlmBundle stays a pure function of this one. It never throws
  // and returns undefined on any failure, so a store that cannot be scanned costs the reader a
  // disclosure and never costs them a bundle.
  const prevalence =
    input.prevalence ??
    (await measureDetectorPrevalence({
      sessionDir: input.sessionDir,
      ...(input.corpusRoot !== undefined ? { corpusRoot: input.corpusRoot } : {}),
    }));
  const bundle = buildLlmBundle({
    ...input,
    ...(prevalence !== undefined ? { prevalence } : {}),
  });
  const markdown = renderLlmMarkdown(bundle);

  await defaultSessionStore.writeArtifact(input.sessionDir, "llm.md", markdown);
  await defaultSessionStore.writeArtifact(
    input.sessionDir,
    "llm.json",
    `${JSON.stringify(bundle, null, 2)}\n`,
  );

  return bundle;
}

export function buildLlmBundle({
  sessionDir,
  events,
  index,
  candidates,
  prevalence,
}: WriteLlmBundleInput): LlmBundle {
  const meta = readJsonRecord(path.join(sessionDir, "meta.json")) ?? {};
  const generatedAt = Date.now();
  const session = buildSessionSummary(sessionDir, meta, index, events);
  const artifacts = KNOWN_ARTIFACTS.map((artifact) =>
    describeArtifact(sessionDir, artifact),
  );
  const redaction = summarizeRedaction(events);
  const completeness = buildCompleteness(events);
  const degradedCapabilities = buildDegradedCapabilities(
    sessionDir,
    meta,
    index,
    events,
  );
  const browserEvidenceBase = buildBrowserEvidence(
    index,
    events,
    session.startMs,
  );
  // The error anchor is derived FROM the browser evidence, so the requests that
  // led up to it can only be attached once that evidence exists.
  const firstErrorEventAt = computeFirstErrorEventAt(browserEvidenceBase, index);
  const browserEvidence: LlmBundleBrowserEvidence = {
    ...browserEvidenceBase,
    precedingRequests: buildPrecedingRequests(
      events,
      session.startMs,
      firstErrorEventAt,
      browserEvidenceBase.failedRequests,
    ),
  };
  const fullStackEvidence = buildFullStackEvidence(
    index,
    session.startMs,
    buildFullStackPayloadIndex(events),
  );
  const media = buildMediaSummary(sessionDir, index, events, session.startMs);
  const limitations = buildLimitations(
    artifacts,
    events,
    redaction,
    degradedCapabilities,
    index,
    meta,
    browserEvidence,
    fullStackEvidence,
  );
  const causalTree = buildCausalTree(candidates ?? []);
  const databaseErrors = buildDatabaseErrors(events, session.startMs);
  const databaseStatements = buildDatabaseStatements(events, session.startMs);
  const distinctBugs = applyFlagNoteTitles(
    groupDistinctBugs(candidates ?? [], events),
    events,
  );
  const detectorPrevalence = projectDetectorPrevalence(
    distinctBugs,
    prevalence,
  );
  const vitals = summarizeVitals(events);

  return {
    schemaVersion: 1,
    kind: "crumbtrail.agent-session-bundle",
    generatedAt,
    generatedAtIso: iso(generatedAt) ?? new Date(generatedAt).toISOString(),
    // B5 self-measurement: both keys are omitted entirely when the session had no
    // error-class events (spread-conditional, matching the causalTree pattern below).
    ...(firstErrorEventAt !== undefined
      ? {
          firstErrorEventAt,
          detectToBundleMs: Math.max(0, generatedAt - firstErrorEventAt),
        }
      : {}),
    sessionDir: path.resolve(sessionDir),
    session,
    artifacts,
    eventCounts: stableStats(index.stats, events),
    keyTimelineMoments: buildKeyTimelineMoments(events, index, session.startMs),
    agentContext: buildAgentContext(events, index, session.startMs),
    browserEvidence,
    fullStackEvidence,
    distinctBugs,
    ...(detectorPrevalence !== undefined ? { detectorPrevalence } : {}),
    environment: buildEnvironment(events, session.startMs),
    ...(vitals !== undefined ? { vitals } : {}),
    ...(causalTree.length > 0 ? { causalTree } : {}),
    outboundCalls: buildOutboundCalls(events, session.startMs),
    databaseDiffs: buildDatabaseDiffs(events, session.startMs),
    databaseReads: buildDatabaseReads(events, session.startMs),
    ...(databaseErrors.length > 0 ? { databaseErrors } : {}),
    ...(databaseStatements.length > 0 ? { databaseStatements } : {}),
    databaseActivity: buildDatabaseActivity(events, session.startMs),
    media,
    degradedCapabilities,
    completeness,
    redaction,
    limitations,
    inspectionGuide: buildInspectionGuide(artifacts),
  };
}

function buildCompleteness(events: BugEvent[]): LlmBundleCompleteness {
  const gapsBySurface: Record<string, number> = {};
  const gapsByReason: Record<string, number> = {};
  let gapCount = 0;
  let droppedEventCount = 0;

  for (const event of events) {
    if (event.k !== CAPTURE_GAP_EVENT_KIND) continue;
    gapCount += 1;
    const payload = isRecord(event.d) ? event.d : {};
    const dropped = finiteNumber(payload.droppedEventCount);
    if (dropped !== undefined && dropped > 0) droppedEventCount += dropped;
    const surface =
      typeof payload.surface === "string" ? payload.surface : "unknown";
    const reason =
      typeof payload.reason === "string" ? payload.reason : "unknown";
    gapsBySurface[surface] = (gapsBySurface[surface] ?? 0) + 1;
    gapsByReason[reason] = (gapsByReason[reason] ?? 0) + 1;
  }

  const hasBackendEvidence = events.some((event) =>
    event.k.startsWith("backend.req."),
  );
  const hasDbDiffEvidence = events.some(
    (event) => event.k === DB_DIFF_EVENT_KIND,
  );
  const grade =
    gapCount === 0
      ? "complete"
      : hasBackendEvidence && hasDbDiffEvidence
        ? "degraded"
        : "fragmentary";

  return { gapCount, gapsBySurface, gapsByReason, droppedEventCount, grade };
}

/**
 * B5: earliest error-class evidence timestamp available at bundle-build time. Sources are the
 * already-built browser evidence summaries (a compacted exemplar carries its run's earliest
 * time in `firstAt`) plus runtime errors from the session index. Returns `undefined` when the
 * session produced no error-class events so the bundle omits the latency fields entirely.
 */
function computeFirstErrorEventAt(
  browserEvidence: LlmBundleBrowserEvidence,
  index: SessionIndexLike,
): number | undefined {
  let first: number | undefined;
  const consider = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return;
    if (first === undefined || value < first) first = value;
  };

  for (const entry of browserEvidence.failedRequests)
    consider(entry.firstAt ?? entry.t);
  for (const entry of browserEvidence.networkErrors)
    consider(entry.firstAt ?? entry.t);
  for (const entry of browserEvidence.consoleErrors)
    consider(entry.firstAt ?? entry.t);
  for (const entry of index.errs ?? []) consider(finiteNumber(entry?.t));

  return first;
}

/** Marker emitted by evidence detectors when an anchoring error's message was redacted away. */
const DEGRADED_TITLE_MARKER = "message unavailable";

/**
 * Replace degraded distinct-bug titles with the user's own `bug.flag` note when one exists
 * inside the bug's evidence window.
 *
 * When redaction empties the anchoring error's message, detector titles collapse to
 * placeholders like "Uncaught error: message unavailable". A user-authored flag note (which
 * survives redaction) is the best available human title for that bug, so it wins — but ONLY
 * for degraded titles; a real error message always beats the note. `representative` is left
 * untouched so the underlying evidence stays verbatim. Pure and deterministic: no flag events
 * (or no degraded titles) means the input is returned unchanged, and ties on distance to
 * `firstSeen` resolve to the earliest event in stream order.
 *
 * Only a flag a PERSON raised qualifies. An automatic capture states `origin: "auto"` and
 * carries the detector's own sentence in `reason` rather than a note, so it can never reach
 * here: promoting "Auto captured after request returned 500" to a title would state a
 * mechanism where a title must state a fault.
 */
function applyFlagNoteTitles(
  bugs: DistinctBug[],
  events: BugEvent[],
): DistinctBug[] {
  if (bugs.length === 0) return bugs;

  const flagNotes: Array<{ t: number; note: string }> = [];
  for (const event of events) {
    if (event.k !== "bug.flag") continue;
    if (event.d?.origin !== "user") continue;
    const note = event.d?.note;
    if (typeof note !== "string" || note.trim().length === 0) continue;
    const t = finiteNumber(event.t);
    if (t === undefined) continue;
    flagNotes.push({ t, note });
  }
  if (flagNotes.length === 0) return bugs;

  return bugs.map((bug) => {
    if (!bug.title.includes(DEGRADED_TITLE_MARKER)) return bug;

    let closest: { t: number; note: string } | undefined;
    for (const flag of flagNotes) {
      if (flag.t < bug.window.start || flag.t > bug.window.end) continue;
      if (
        closest === undefined ||
        Math.abs(flag.t - bug.firstSeen) < Math.abs(closest.t - bug.firstSeen)
      ) {
        closest = flag;
      }
    }
    if (closest === undefined) return bug;

    const title = safeText(closest.note, 100);
    if (title === undefined) return bug;
    return { ...bug, title };
  });
}

function buildSessionSummary(
  sessionDir: string,
  meta: Record<string, unknown>,
  index: SessionIndexLike,
  events: BugEvent[],
): LlmBundle["session"] {
  const firstEventTime =
    events.length > 0 ? finiteNumber(events[0].t) : undefined;
  const lastEventTime =
    events.length > 0 ? finiteNumber(events[events.length - 1].t) : undefined;
  const startMs =
    finiteNumber(index.start) ??
    finiteNumber(meta.start) ??
    firstEventTime ??
    0;
  const endMs =
    finiteNumber(index.end) ??
    finiteNumber(meta.end) ??
    lastEventTime ??
    startMs;
  const durationMs = finiteNumber(index.dur) ?? Math.max(0, endMs - startMs);

  return removeUndefined({
    id:
      safeText(meta.id, 120) ??
      safeText(index.id, 120) ??
      path.basename(sessionDir),
    name: safeText(meta.name, 160),
    source: safeText(meta.source, 120),
    app: safeText(meta.app, 120),
    startMs,
    startIso: iso(startMs),
    endMs,
    endIso: iso(endMs),
    durationMs,
    metadata: buildMetadataSummary(meta),
  });
}

function buildMetadataSummary(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  copySafeString(out, meta, "source");
  copySafeString(out, meta, "name");
  copySafeString(out, meta, "app");
  copySafeUrl(out, meta, "url");
  copySafeUrl(out, meta, "rootUrl");
  copySafeString(out, meta, "rootOrigin");
  copySafeNumber(out, meta, "startedAt");
  copySafeNumber(out, meta, "end");

  const capabilities = sanitizeBooleanRecord(meta.capabilities);
  if (capabilities) out.capabilities = capabilities;

  const collection = sanitizeCollection(meta.collection);
  if (collection) out.collection = collection;

  const degradedCollection = stringArray(meta.degradedCollection, 80);
  if (degradedCollection.length > 0)
    out.degradedCollection = degradedCollection;

  const allowedOrigins = stringArray(meta.allowedOrigins, 240).map(
    (origin) => safeUrl(origin, "metadata.allowedOrigins") ?? origin,
  );
  if (allowedOrigins.length > 0) out.allowedOrigins = allowedOrigins;

  const tabBoundary = sanitizeTabBoundary(meta.tabBoundary);
  if (tabBoundary) out.tabBoundary = tabBoundary;

  out.metadataKeys = Object.keys(meta).sort();

  return out;
}

function sanitizeCollection(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const entry = removeUndefined({
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
      degraded: typeof raw.degraded === "boolean" ? raw.degraded : undefined,
      reason: safeText(raw.reason, 120),
      source: safeText(raw.source, 80),
      redaction: safeText(raw.redaction, 120),
    });
    if (Object.keys(entry).length > 0) out[key] = entry;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTabBoundary(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out = removeUndefined({
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    eventKind: safeText(value.eventKind, 80),
    redaction: safeText(value.redaction, 120),
    rootOrigin: safeText(value.rootOrigin, 240),
    allowedOrigins: stringArray(value.allowedOrigins, 240).map(
      (origin) =>
        safeUrl(origin, "metadata.tabBoundary.allowedOrigins") ?? origin,
    ),
  });

  return Object.keys(out).length > 0 ? out : undefined;
}

function describeArtifact(
  sessionDir: string,
  artifact: {
    path: string;
    role: LlmBundleArtifact["role"];
    description: string;
    generated?: boolean;
  },
): LlmBundleArtifact {
  const artifactPath = path.join(sessionDir, artifact.path);
  if (fs.existsSync(artifactPath)) {
    const stat = fs.statSync(artifactPath);
    return removeUndefined({
      path: artifact.path,
      role: artifact.role,
      description: artifact.description,
      exists: true,
      bytes: stat.isFile() ? stat.size : undefined,
      entries: stat.isDirectory()
        ? fs.readdirSync(artifactPath).length
        : undefined,
    });
  }

  return {
    path: artifact.path,
    role: artifact.role,
    description: artifact.description,
    exists: artifact.generated === true,
  };
}

function stableStats(
  indexStats: Record<string, number> | undefined,
  events: BugEvent[],
): Record<string, number> {
  const stats =
    indexStats ??
    events.reduce<Record<string, number>>((acc, event) => {
      acc[event.k] = (acc[event.k] ?? 0) + 1;
      return acc;
    }, {});

  return Object.fromEntries(
    Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function buildKeyTimelineMoments(
  events: BugEvent[],
  index: SessionIndexLike,
  sessionStartMs: number,
): LlmBundleTimelineMoment[] {
  const moments: LlmBundleTimelineMoment[] = [];

  for (const event of events) {
    const summary = summarizeEvent(event, index);
    if (!summary) continue;
    moments.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        k: event.k,
        summary,
      }),
    );
  }

  if (
    events.length > 0 &&
    !moments.some(
      (moment) => moment.t === events[0].t && moment.k === events[0].k,
    )
  ) {
    const first = events[0];
    moments.unshift(
      removeUndefined({
        t: first.t,
        iso: iso(first.t),
        offsetMs:
          finiteNumber(first.offsetMs) ??
          offsetFromStart(first.t, sessionStartMs),
        k: first.k,
        summary: `first recorded event (${first.k})`,
      }),
    );
  }

  const last = events[events.length - 1];
  if (
    last &&
    !moments.some((moment) => moment.t === last.t && moment.k === last.k)
  ) {
    moments.push(
      removeUndefined({
        t: last.t,
        iso: iso(last.t),
        offsetMs:
          finiteNumber(last.offsetMs) ??
          offsetFromStart(last.t, sessionStartMs),
        k: last.k,
        summary: `last recorded event (${last.k})`,
      }),
    );
  }

  return moments.sort((a, b) => a.t - b.t).slice(0, 40);
}

const AGENT_CONTEXT_MAX_TIMELINE_ENTRIES = 80;
const AGENT_CONTEXT_MAX_INTERACTION_ENTRIES = 40;

function buildAgentContext(
  events: BugEvent[],
  index: SessionIndexLike,
  sessionStartMs: number,
): LlmBundleAgentContext {
  const timeline: LlmBundleAgentContextTimelineEntry[] = [];
  let keyCount = 0;
  let lastKeyEvent: BugEvent | undefined;

  for (const event of events) {
    if (event.k === "key") {
      keyCount += 1;
      lastKeyEvent = event;
      continue;
    }

    const base = {
      t: event.t,
      iso: iso(event.t),
      offsetMs:
        finiteNumber(event.offsetMs) ??
        offsetFromStart(event.t, sessionStartMs),
    };

    if (event.k === "nav") {
      timeline.push(
        removeUndefined({
          ...base,
          kind: "navigation" as const,
          summary: summarizeEvent(event, index) ?? "navigation captured",
        }),
      );
      continue;
    }

    if (event.k === "clk") {
      const target = interactionIdentifier(event);
      const integrity = describeClickIntegrity(event);
      const summary = joinParts([
        target ? `click ${target}` : "click captured",
        integrity,
      ]);
      timeline.push(
        removeUndefined({
          ...base,
          kind: "click" as const,
          target,
          summary,
        }),
      );
      continue;
    }

    if (event.k === "inp") {
      const field = interactionIdentifier(event);
      const typed = keptInputValue(event);
      const what = typed !== undefined ? `typed ${typed}` : "value redacted";
      timeline.push(
        removeUndefined({
          ...base,
          kind: "input" as const,
          field,
          summary: field ? `input ${field}; ${what}` : `input captured; ${what}`,
        }),
      );
      continue;
    }

    if (event.k === "net.res" && isFailedNetworkResponse(event)) {
      const request = requestForNetworkEvent(events, event);
      timeline.push(
        removeUndefined({
          ...base,
          kind: "failed-request" as const,
          summary: summarizeEvent(event, index) ?? "failed request",
          requestBody: request
            ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
            : undefined,
          responseBody: redactedNetworkBodySnippet(
            event.d.body,
            event.d.bodySummary,
          ),
        }),
      );
      continue;
    }

    if (event.k === "net.err") {
      const request = requestForNetworkEvent(events, event);
      timeline.push(
        removeUndefined({
          ...base,
          kind: "failed-request" as const,
          summary: summarizeEvent(event, index) ?? "network request error",
          requestBody: request
            ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
            : undefined,
        }),
      );
      continue;
    }

    if (isAgentContextError(event)) {
      const summary = summarizeEvent(event, index);
      if (summary) timeline.push({ ...base, kind: "error", summary });
    }
  }

  if (lastKeyEvent) {
    timeline.push(
      removeUndefined({
        t: lastKeyEvent.t,
        iso: iso(lastKeyEvent.t),
        offsetMs:
          finiteNumber(lastKeyEvent.offsetMs) ??
          offsetFromStart(lastKeyEvent.t, sessionStartMs),
        kind: "key-count" as const,
        count: keyCount,
        summary: `${keyCount} keystroke${keyCount === 1 ? "" : "s"} captured; values redacted`,
      }),
    );
  }

  return {
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    timeline: boundAgentContextTimeline(timeline),
  };
}

function isAgentContextError(event: BugEvent): boolean {
  if (event.k === "err" || event.k === "rej" || event.k === "probe.error")
    return true;
  return (
    event.k === "con" &&
    ["err", "error"].includes(consoleLevel(event.d.lv) ?? "")
  );
}

/**
 * What the click actually hit, when that differs from what it appears to have hit.
 *
 * `interaction.ts` captures three integrity facts alongside every click: `covered` (the elements
 * under the cursor, from `elementsFromPoint`), `deep` (the composed-path target, which differs
 * when the event crossed a shadow boundary) and `targetNotInStack` (the event's target is not
 * under the cursor at all). None of them were projected: the bundle rendered every click as
 * `click <selector>` and told the reader to "inspect the event descriptor", which is not in the
 * bundle. So a session where an overlay swallowed the checkout click carried the decisive fact in
 * events.ndjson and nothing whatsoever in llm.json — captured, then dropped between the two.
 *
 * Deliberately a plain rendering of what was captured rather than a verdict about overlays. The
 * reader is told which element was under the cursor and left to conclude what that means; a
 * detector that fires on "covered && no request followed" would be a narrower claim than the
 * evidence supports, and would hide the fact in every case it declined to fire on.
 */
function describeClickIntegrity(event: BugEvent): string | undefined {
  const parts: string[] = [];
  // `event.d`, not `event.d.el`: the collector puts the target's rect alongside the descriptor
  // rather than inside it. Reading the wrong path cost a whole eval batch — the covered element
  // rendered its box, the target silently did not, and the one fact the case turned on (the
  // target was full-viewport) was captured and still absent from the bundle.
  const box = describeElementBox(event.d);
  if (box) parts.push(`target ${box}`);
  const covered = event.d.covered;
  if (Array.isArray(covered) && covered.length > 0) {
    const first = covered.find((entry) => isRecord(entry));
    const selector = isRecord(first) ? interactionIdentifierOf(first) : undefined;
    const coveredBox = isRecord(first) ? describeElementBox(first) : undefined;
    if (selector)
      parts.push(coveredBox ? `over ${selector} (${coveredBox})` : `over ${selector}`);
    else parts.push(`over ${covered.length} covered element(s)`);
  }
  const deep = event.d.deep;
  if (isRecord(deep)) {
    const selector = interactionIdentifierOf(deep);
    if (selector) parts.push(`composed target ${selector}`);
  }
  if (event.d.targetNotInStack === true) {
    parts.push("event target was not under the cursor");
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * One element's captured box, as a short phrase.
 *
 * Reported as viewport coverage first because that is the fact a reader acts on: a covering
 * element at 99% of the viewport is an overlay, the same element at 4% is a badge that happens to
 * sit above a button. Absent for any element captured before geometry was recorded, which must
 * read as "not captured" rather than as a small element.
 */
function describeElementBox(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const box = value.box;
  if (!isRecord(box)) return undefined;
  const w = finiteNumber(box.w);
  const h = finiteNumber(box.h);
  const pct = finiteNumber(box.viewportPct);
  if (w === undefined || h === undefined) return undefined;
  return pct !== undefined
    ? `${w}x${h}px, ${pct}% of viewport`
    : `${w}x${h}px`;
}

/** The selector for one element descriptor, shared by the click integrity fields and the target. */
function interactionIdentifierOf(
  element: Record<string, unknown>,
): string | undefined {
  const selector =
    sanitizeSelector(element.path) ??
    sanitizeSelector(element.selector) ??
    sanitizeSelector(element.sig) ??
    sanitizeSelector(element.name, 120) ??
    sanitizeSelector(element.id, 120);
  return selector ? safeText(selector, 240) : undefined;
}

function interactionIdentifier(event: BugEvent): string | undefined {
  if (!isRecord(event.d.el)) return undefined;
  return interactionIdentifierOf(event.d.el);
}

function boundAgentContextTimeline(
  timeline: LlmBundleAgentContextTimelineEntry[],
): LlmBundleAgentContextTimelineEntry[] {
  if (timeline.length <= AGENT_CONTEXT_MAX_TIMELINE_ENTRIES)
    return timeline.sort((a, b) => a.t - b.t);

  const interactions = timeline
    .filter((entry) => ["click", "input", "key-count"].includes(entry.kind))
    .slice(-AGENT_CONTEXT_MAX_INTERACTION_ENTRIES);
  const nonInteractions = timeline
    .filter((entry) => !["click", "input", "key-count"].includes(entry.kind))
    .slice(-(AGENT_CONTEXT_MAX_TIMELINE_ENTRIES - interactions.length));
  return [...nonInteractions, ...interactions].sort((a, b) => a.t - b.t);
}

/**
 * One line for a stream event, whichever transport carried it.
 *
 * A socket frame prints its content; a server-sent event has none to print, because that collector
 * counts rather than quotes. The lifecycle lines matter on their own: an unclean close mid-session
 * is often the whole explanation for a page that simply stopped updating.
 */
function describeStreamEvent(event: BugEvent): string | undefined {
  const d = event.d;
  const transport = event.k === "net.ws" ? "socket" : "stream";
  const op = safeText(d.op, 20);
  const url = safeUrl(d.url, `event.${event.k}.url`);
  if (!op) return undefined;

  if (op === "msg" || op === "send") {
    const direction = op === "msg" ? "received" : "sent";
    const body = safeText(d.body, 400);
    const bytes = finiteNumber(d.bytes);
    return joinParts([
      `${transport} frame ${direction}`,
      url,
      d.binary === true
        ? `binary${bytes !== undefined ? `, ${bytes} bytes` : ""}`
        : body,
    ]);
  }

  const received = finiteNumber(d.received) ?? finiteNumber(d.count);
  const sent = finiteNumber(d.sent);
  const code = finiteNumber(d.code);
  return joinParts([
    `${transport} ${op}`,
    url,
    d.reopen === true ? "reconnect" : undefined,
    code !== undefined ? `code ${code}` : undefined,
    d.clean === false ? "unclean" : undefined,
    received !== undefined ? `${received} received` : undefined,
    sent !== undefined ? `${sent} sent` : undefined,
  ]);
}

/**
 * One line for a background job.
 *
 * `skipped` is printed as its own word rather than folded into an outcome, because a job that
 * decided there was nothing to do is the exact shape of work that was promised and never happened.
 */
function describeJobEvent(event: BugEvent): string | undefined {
  const d = event.d;
  const name = safeText(d.job, 160) ?? "job";
  const phase = event.k === "backend.job.start" ? "started" : undefined;
  const outcome = safeText(d.outcome, 20);
  const duration = finiteNumber(d.durationMs);
  const attempt = finiteNumber(d.attempt);
  const error = isRecord(d.error)
    ? joinParts([safeText(d.error.name, 120), safeText(d.error.message, 300)])
    : undefined;

  return joinParts([
    `job ${name}`,
    phase ?? outcome ?? (event.k === "backend.job.error" ? "failed" : undefined),
    safeText(d.queue, 160),
    attempt !== undefined && attempt > 1 ? `attempt ${attempt}` : undefined,
    duration !== undefined ? `${duration} ms` : undefined,
    error,
    safeText(d.result, 300),
  ]);
}

/** One line for a worker's lifecycle or one message of its protocol. */
function describeWorkerEvent(event: BugEvent): string | undefined {
  const d = event.d;
  const op = safeText(d.op, 20);
  const script = safeUrl(d.script, "event.worker.msg.script");
  if (!op) return undefined;

  if (op === "start") return joinParts(["worker started", script]);
  if (op === "error") {
    return joinParts([
      "worker error",
      script,
      safeText(d.msg, 300),
      "the page's own error handlers never saw this",
    ]);
  }
  if (op === "post" || op === "recv") {
    const direction = op === "post" ? "sent to worker" : "received from worker";
    return joinParts([
      `worker message ${direction}`,
      script,
      d.opaque === true ? "opaque payload" : safeText(d.body, 400),
    ]);
  }
  return undefined;
}

/** How many labels the bundle reports. Contradictions first, so a cut never drops one. */
const MAX_SCREEN_NUMBER_LABELS = 40;
/** How many distinct values one label reports before it is summarised by its ends. */
const MAX_SCREEN_NUMBER_VALUES = 6;

function buildScreenNumbers(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleScreenNumber[] {
  const byLabel = new Map<string, LlmBundleScreenNumber>();

  for (const event of events) {
    if (event.k !== "ui.num") continue;
    const items = event.d.items;
    if (!Array.isArray(items)) continue;
    const region = safeText(event.d.region, 120);
    const offsetMs = offsetFromStart(event.t, sessionStartMs);

    for (const item of items) {
      if (!isRecord(item)) continue;
      const label = safeText(item.label, 120);
      const value = finiteNumber(item.value);
      if (!label || value === undefined) continue;

      const existing = byLabel.get(label) ?? {
        label,
        ...(safeText(item.unit, 8) ? { unit: safeText(item.unit, 8) } : {}),
        values: [],
        regions: [],
      };
      if (!existing.values.some((seen) => seen.value === value)) {
        existing.values.push(removeUndefined({ value, offsetMs }));
      }
      if (region && !existing.regions.includes(region)) {
        existing.regions.push(region);
      }
      byLabel.set(label, existing);
    }
  }

  return [...byLabel.values()]
    .map((entry) =>
      entry.values.length > MAX_SCREEN_NUMBER_VALUES
        ? {
            ...entry,
            // Keep the ends: the first value and the last are what a reader compares. Dropping the
            // middle of a counter that ticked is not a loss; dropping either end is.
            values: [
              ...entry.values.slice(0, MAX_SCREEN_NUMBER_VALUES - 1),
              entry.values[entry.values.length - 1],
            ],
          }
        : entry,
    )
    // A label that took more than one value is ranked above one that held still, because a value
    // that moved is what someone is looking for and a truncation must never be what hides it.
    .sort((a, b) => b.values.length - a.values.length)
    .slice(0, MAX_SCREEN_NUMBER_LABELS);
}

function summarizeEvent(
  event: BugEvent,
  index: SessionIndexLike,
): string | undefined {
  const d = event.d;
  if (!IMPORTANT_EVENT_KINDS.has(event.k) && !isFailedNetworkResponse(event))
    return undefined;

  if (event.k === "session.lifecycle") {
    const action = safeText(d.action, 80) ?? "lifecycle";
    const reason = safeText(d.reason, 80);
    const root =
      safeUrl(d.rootUrl, "event.session.lifecycle.rootUrl") ??
      safeText(d.rootOrigin, 180);
    return joinParts([
      `session ${action}`,
      reason ? `reason ${reason}` : undefined,
      root ? `root ${root}` : undefined,
    ]);
  }

  if (event.k === "nav") {
    const to =
      safeUrl(d.to, "event.nav.to") ??
      safeText(d.to, 180) ??
      "unknown destination";
    return `navigation to ${to}`;
  }

  if (event.k === "tab.boundary") {
    if (!isRecord(d)) return "tab boundary event with malformed metadata";
    const decision = safeText(d.decision, 80) ?? "boundary decision";
    const reason = safeText(d.reason, 80);
    const candidate = isRecord(d.candidate)
      ? (safeOrigin(d.candidate.origin) ??
        safeOrigin(d.candidate.url) ??
        safeHost(d.candidate.host) ??
        safeText(d.candidate.scheme, 80))
      : undefined;
    return joinParts([
      `tab boundary ${decision}`,
      reason,
      candidate ? `candidate ${candidate}` : undefined,
    ]);
  }

  if (event.k === "probe.ready") {
    const features = isRecord(d.features)
      ? Object.entries(d.features)
          .filter(([, enabled]) => typeof enabled === "boolean" && enabled)
          .map(([name]) => safeText(name, 40))
          .filter((name): name is string => name !== undefined)
          .slice(0, 6)
          .join(", ")
      : undefined;
    return joinParts([
      "page probe ready",
      features ? `features ${features}` : undefined,
    ]);
  }

  if (event.k === "probe.error") {
    const phase = safeText(d.phase, 80);
    const message = safeText(d.message, 180) ?? "message unavailable";
    return joinParts([
      "page probe error",
      phase ? `phase ${phase}` : undefined,
      message,
    ]);
  }

  if (event.k === "frame.ctx") {
    const pageProbe = isRecord(d.pageProbe) ? d.pageProbe : undefined;
    if (!pageProbe) return "frame context captured";
    const requested =
      pageProbe.requested === true ? "requested" : "not requested";
    const started = pageProbe.started === true ? "started" : "not started";
    const reason = safeText(pageProbe.reason, 120);
    return joinParts([
      `page probe ${requested}`,
      started,
      pageProbe.limited === true ? "limited" : undefined,
      reason,
    ]);
  }

  if (event.k === "con") {
    const level = consoleLevel(d.lv);
    if (level !== "err" && level !== "error") return undefined;
    return `console error: ${consoleMessageFromPayload(d) ?? "message unavailable"}`;
  }

  if (event.k === "net.err") {
    const method = safeText(d.method, 20) ?? safeText(d.m, 20);
    const url = safeUrl(d.url, "event.net.err.url");
    const message = safeText(d.msg, 180);
    return joinParts(["network request error", method, url, message]);
  }

  if (event.k === "net.sse" || event.k === "net.ws") {
    return describeStreamEvent(event);
  }

  if (event.k === "csp") {
    const d2 = event.d;
    return joinParts([
      "content security policy blocked",
      safeText(d2.blockedUri, 300),
      safeText(d2.directive, 80),
      safeText(d2.disposition, 20) === "report"
        ? "report-only, not actually blocked"
        : undefined,
      safeUrl(d2.file, "event.csp.file"),
      "no error was thrown and no request was made",
    ]);
  }

  if (event.k.startsWith("backend.job.")) {
    return describeJobEvent(event);
  }

  if (event.k === "worker.msg") {
    return describeWorkerEvent(event);
  }

  if (event.k === "err" || event.k === "rej") {
    const msg = safeText(d.msg, 180) ?? "message unavailable";
    return `${event.k === "err" ? "error" : "rejection"}: ${msg}`;
  }

  if (event.k === "clk") {
    // Was a pointer to the "event descriptor", which the bundle does not contain.
    return joinParts([
      "user click",
      interactionIdentifier(event),
      describeClickIntegrity(event),
    ]);
  }

  if (event.k === "inp") {
    const field = interactionIdentifier(event);
    const typed = keptInputValue(event);
    if (typed === undefined) {
      return joinParts([
        "user input captured",
        field,
        "value withheld by the redaction policy",
      ]);
    }
    return joinParts(["user typed", field, typed]);
  }

  if (event.k === "perf") {
    const metric =
      safeText(d.metric, 40) ?? safeText(d.entryType, 40) ?? "performance";
    const name = safeUrl(d.name, "event.perf.name") ?? safeText(d.name, 120);
    const duration = finiteNumber(d.duration);
    return joinParts([
      `performance ${metric}`,
      name,
      duration !== undefined ? `${duration} ms` : undefined,
    ]);
  }

  if (event.k === "snap") {
    return "storage/cookie snapshot summarized in index.json; raw values are not repeated in this bundle";
  }

  if (event.k === "media.video" || event.k === "media.voice") {
    const capability =
      safeText(d.capability, 80) ??
      (event.k === "media.video" ? "video" : "audio");
    const state = safeText(d.state, 80) ?? "status";
    const code = safeText(d.code, 80);
    const label =
      event.k === "media.voice" && d.state === "marker-added"
        ? safeText(d.label, 120)
        : undefined;
    return joinParts([
      `${capability} ${state}`,
      code ? `code ${code}` : undefined,
      label ? `marker ${label}` : undefined,
    ]);
  }

  if (event.k === "net.res" && isFailedNetworkResponse(event)) {
    const failedReq = findFailedRequest(index, event);
    const url = failedReq
      ? safeUrl(failedReq.url, "index.failedReqs.url")
      : undefined;
    const reason = safeText(failedReq?.reason, 80);
    const code = safeText(failedReq?.code, 120);
    const message = safeText(failedReq?.message, 160);
    return joinParts([
      reason === "application_failure"
        ? `application failure response (${String(d.st)})`
        : `HTTP ${String(d.st)} response`,
      failedReq?.m ? failedReq.m : undefined,
      url,
      code,
      message,
    ]);
  }

  return undefined;
}

function findFailedRequest(
  index: SessionIndexLike,
  event: BugEvent,
):
  | {
      t: number;
      m: string;
      url: string;
      st: number;
      reason?: string;
      code?: string;
      message?: string;
      phase?: string;
    }
  | undefined {
  const failedReqs = Array.isArray(index.failedReqs) ? index.failedReqs : [];
  return failedReqs.find((req) => req.t === event.t && req.st === event.d.st);
}

function isFailedNetworkResponse(event: BugEvent): boolean {
  return (
    event.k === "net.res" &&
    ((typeof event.d.st === "number" && event.d.st >= 400) ||
      summarizeApplicationFailure(event) !== undefined)
  );
}

function buildBrowserEvidence(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleBrowserEvidence {
  return {
    pageProbe: buildPageProbeSummary(index, events, sessionStartMs),
    failedRequests: buildFailedRequestSummaries(index, events, sessionStartMs),
    networkErrors: buildNetworkErrorSummaries(index, events, sessionStartMs),
    consoleErrors: buildConsoleErrorSummaries(index, events, sessionStartMs),
    tabBoundaries: buildTabBoundarySummary(index, events, sessionStartMs),
    interactiveElements: collectInteractiveElements(events),
    storageChanges: buildStorageChanges(events, sessionStartMs),
    screenNumbers: buildScreenNumbers(events, sessionStartMs),
    // Filled by the caller, which is the only place the error anchor exists:
    // computeFirstErrorEventAt reads this very object, so the anchor cannot be
    // known until after it is built. Left empty rather than optional so the
    // field is never absent from a bundle.
    precedingRequests: [],
  };
}

/** How far back from the first error a successful request still counts as context. */
export const PRECEDING_REQUEST_WINDOW_MS = 15_000;
/** Upper bound on preceding requests carried, newest first. */
const MAX_PRECEDING_REQUESTS = 12;

/**
 * The successful responses immediately before the failure, newest first.
 *
 * Bounded three ways on purpose: a time window, a count cap, and exclusion of
 * anything already reported as a failure. A busy page issues far more requests
 * than a reader will look at, and repeating a failed request here would make
 * the same request read as two different findings.
 */
function buildPrecedingRequests(
  events: BugEvent[],
  sessionStartMs: number,
  firstErrorEventAt: number | undefined,
  failedRequests: LlmBundleFailedRequestSummary[],
): LlmBundlePrecedingRequestSummary[] {
  if (firstErrorEventAt === undefined) return [];
  const windowStart = firstErrorEventAt - PRECEDING_REQUEST_WINDOW_MS;
  const alreadyReported = new Set(
    failedRequests.map((entry) => `${entry.t}${SIGNATURE_SEPARATOR}${entry.url ?? ""}`),
  );

  const responses = events.filter((event) => {
    if (event.k !== "net.res") return false;
    if (!Number.isFinite(event.t)) return false;
    if (event.t > firstErrorEventAt || event.t < windowStart) return false;
    // Real capture writes `st`; OTLP-derived and hand-built events sometimes
    // carry `status`. Both are read so neither shape silently drops out.
    const status = finiteNumber(event.d.st) ?? finiteNumber(event.d.status);
    // No status is not a success. An unknown outcome belongs to whatever
    // recorded it, not to a list whose whole claim is "these came back fine".
    if (status === undefined || status >= 400) return false;
    return !alreadyReported.has(`${event.t}${SIGNATURE_SEPARATOR}${safeUrl(event.d.url, "net.res.url") ?? ""}`);
  });

  responses.sort((a, b) => b.t - a.t);

  return responses.slice(0, MAX_PRECEDING_REQUESTS).map((response) => {
    const request = requestForNetworkEvent(events, response);
    return removeUndefined({
      t: response.t,
      iso: iso(response.t),
      offsetMs: offsetFromStart(response.t, sessionStartMs),
      beforeErrorMs: Math.max(0, firstErrorEventAt - response.t),
      method:
        safeText(response.d.m, 20) ??
        safeText(response.d.method, 20) ??
        (request ? safeText(request.d.m, 20) : undefined),
      url:
        safeUrl(response.d.url, "net.res.url") ??
        (request ? safeUrl(request.d.url, "net.req.url") : undefined),
      status: finiteNumber(response.d.st) ?? finiteNumber(response.d.status),
      requestBody: request
        ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
        : undefined,
      responseBody: redactedNetworkBodySnippet(
        response.d.body,
        response.d.bodySummary,
      ),
    }) as LlmBundlePrecedingRequestSummary;
  });
}

const MAX_STORAGE_CHANGES = 200;

function buildStorageChanges(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleStorageChange[] {
  const changes: LlmBundleStorageChange[] = [];
  for (const event of events) {
    if (event.k !== "stor" || !isRecord(event.d)) continue;
    changes.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        area: safeText(event.d.type, 20),
        op: safeText(event.d.op, 20),
        // Already redacted by `redactStorageKey` at capture; re-run the value
        // policy as defense in depth, the same way db images are treated.
        key: safeText(event.d.key, 200),
        oldValue: redactValue(event.d.oldVal, "stor.oldVal").value,
        newValue: redactValue(event.d.newVal, "stor.newVal").value,
      }) as LlmBundleStorageChange,
    );
  }
  return changes.sort((a, b) => a.t - b.t).slice(0, MAX_STORAGE_CHANGES);
}

const MAX_FLAG_CHANGES = 200;

/**
 * What counts as the provider wrapper shape `{ value, variant? }`, rather than a flag value that
 * merely happens to be an object, is decided by `normalizeFlagValue` in `crumbtrail-core` — the
 * same function the browser SDK normalizes with before the event is ever written.
 *
 * A second copy of the rule lived here and had already drifted: it accepted a non-string
 * `variant` where core rejects it, so for `{ value: "a", variant: 42 }` the two modules
 * disagreed about what the flag's value even was. Any non-core producer of `d.flags` reaches
 * this path — the OTLP ingest and the four mobile SDKs among them.
 */

/** The variant a declared flag value names, or `undefined` when it names none. */
function flagVariantOf(value: unknown): string | undefined {
  const variant = normalizeFlagValue(value).variant;
  return variant === undefined ? undefined : safeText(variant, 120);
}

/**
 * Read one side of a wire `flagChanges` entry into a bundle flag value.
 *
 * `undefined` in, `undefined` out: an absent side means the flag did not exist on that side,
 * which is information, not a value to redact. The value is re-redacted under
 * `environment.flags` keyed by the flag's own name, so the key-aware policy sees the flag name
 * exactly as it does in the merged `flags` record — defense in depth over the browser-side
 * redaction that already ran.
 */
function readFlagSide(
  flag: string,
  side: unknown,
): LlmBundleFlagValue | undefined {
  if (side === undefined || side === null) return undefined;
  // Core emits `{ value, variant? }`; a raw or hand-written event may carry a bare value.
  // `normalizeFlagValue` folds both, by the same rule core applied at capture.
  const raw = normalizeFlagValue(side).value;
  const variant = flagVariantOf(side);
  const redacted = redactValue({ [flag]: raw }, "environment.flags").value as
    | Record<string, unknown>
    | undefined;
  const out: LlmBundleFlagValue = { value: redacted?.[flag] };
  if (variant !== undefined) out.variant = variant;
  return out;
}

/**
 * Flatten the session's `k:'env'` events into one ordered flag-change history.
 *
 * Every change on an event shares that event's timestamp, and events are visited in the order
 * the session recorded them, so the sort is stable within an event and chronological across
 * them.
 */
function buildFlagChanges(
  envEvents: BugEvent[],
  sessionStartMs: number,
): LlmBundleFlagChange[] {
  const changes: LlmBundleFlagChange[] = [];
  for (const event of envEvents) {
    const d = event.d as Partial<EnvSnapshot>;
    if (!isRecord(d.flagChanges)) continue;
    for (const flag of Object.keys(d.flagChanges)) {
      const change = d.flagChanges[flag];
      if (!isRecord(change)) continue;
      changes.push(
        removeUndefined({
          t: event.t,
          iso: iso(event.t),
          offsetMs:
            finiteNumber(event.offsetMs) ??
            offsetFromStart(event.t, sessionStartMs),
          flag,
          from: readFlagSide(flag, change.from),
          to: readFlagSide(flag, change.to),
        }) as LlmBundleFlagChange,
      );
    }
  }
  return changes
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_FLAG_CHANGES);
}

function buildEnvironment(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleEnvironment | null {
  const envEvents = events.filter((event) => event.k === "env");
  if (envEvents.length === 0) return null;

  // The initial snapshot carries device fields; later `setEnv` deltas only add flags/config.
  const base = (
    envEvents.find(
      (event) => (event.d as Partial<EnvSnapshot>).kind === "snapshot",
    ) ?? envEvents[0]
  ).d as Partial<EnvSnapshot>;

  const environment: LlmBundleEnvironment = removeUndefined({
    userAgent: safeText(base.userAgent, 400),
    browser: sanitizeBrowser(base.browser),
    os: safeText(base.os, 60),
    viewport: sanitizeViewport(base.viewport),
    locale: safeText(base.locale, 60),
    timezone: safeText(base.timezone, 80),
    // Capture already bounds this to 120 token-safe characters; bound it again here so a raw
    // event that bypassed the collector cannot widen the field.
    appBuild: safeText(base.appBuild, 120),
    // `document.referrer` is a URL, so it goes through the URL redaction path (query values
    // stripped, hash dropped) rather than plain text redaction.
    referrer: safeUrl(base.referrer, "environment.referrer"),
    campaign: sanitizeCampaign(base.campaign),
    device: sanitizeDevice(base.device),
    connection: sanitizeConnection(base.connection),
    deviceMemory: finiteNumber(base.deviceMemory),
    hardwareConcurrency: finiteNumber(base.hardwareConcurrency),
  });

  // Merge flags/config across the snapshot and every delta, last-write-wins. Flag CHANGES are
  // deliberately not merged this way — see `buildFlagChanges`, which keeps them ordered.
  const flags: Record<string, unknown> = {};
  const config: Record<string, unknown> = {};
  const flagVariants: Record<string, string> = {};
  let hasFlags = false;
  let hasConfig = false;
  for (const event of envEvents) {
    const d = event.d as Partial<EnvSnapshot>;
    if (isRecord(d.flags)) {
      Object.assign(flags, d.flags);
      hasFlags = true;
      for (const flag of Object.keys(d.flags)) {
        const variant = flagVariantOf(d.flags[flag]);
        if (variant !== undefined) flagVariants[flag] = variant;
      }
    }
    if (isRecord(d.config)) {
      Object.assign(config, d.config);
      hasConfig = true;
    }
    // A change record names the variant in force after the move even when the app never
    // re-declared the flag itself, so it is a second source for the same question.
    if (isRecord(d.flagChanges)) {
      for (const flag of Object.keys(d.flagChanges)) {
        const change = d.flagChanges[flag];
        if (!isRecord(change)) continue;
        const variant = flagVariantOf(change.to);
        if (variant !== undefined) flagVariants[flag] = variant;
      }
    }
  }
  // Defense-in-depth: flags/config are redacted in the browser, but re-run the redaction path
  // at bundle time so secret-looking values can never rest in the bundle even if a raw event
  // slipped through.
  if (hasFlags)
    environment.flags = redactValue(flags, "environment.flags").value;
  if (hasConfig)
    environment.config = redactValue(config, "environment.config").value;
  if (Object.keys(flagVariants).length > 0)
    environment.flagVariants = flagVariants;

  const flagChanges = buildFlagChanges(envEvents, sessionStartMs);
  if (flagChanges.length > 0) environment.flagChanges = flagChanges;

  return environment;
}

/** First-party `utm_*` labels only. Cross-site click ids are never captured upstream. */
function sanitizeCampaign(value: unknown): EnvCampaign | undefined {
  if (!isRecord(value)) return undefined;
  const campaign = removeUndefined({
    source: safeText(value.source, 120),
    medium: safeText(value.medium, 120),
    campaign: safeText(value.campaign, 120),
    term: safeText(value.term, 120),
    content: safeText(value.content, 120),
  }) as EnvCampaign;
  return Object.keys(campaign).length > 0 ? campaign : undefined;
}

function sanitizeDevice(value: unknown): EnvDevice | undefined {
  if (!isRecord(value)) return undefined;
  const device = removeUndefined({
    dpr: finiteNumber(value.dpr),
    // The screen is the same `{ w, h }` shape as the viewport and gets the same treatment.
    screen: sanitizeViewport(value.screen),
    orientation: safeText(value.orientation, 40),
  }) as EnvDevice;
  return Object.keys(device).length > 0 ? device : undefined;
}

function sanitizeConnection(value: unknown): EnvConnection | undefined {
  if (!isRecord(value)) return undefined;
  const connection = removeUndefined({
    effectiveType: safeText(value.effectiveType, 20),
    downlink: finiteNumber(value.downlink),
    rtt: finiteNumber(value.rtt),
    saveData: typeof value.saveData === "boolean" ? value.saveData : undefined,
  }) as EnvConnection;
  return Object.keys(connection).length > 0 ? connection : undefined;
}

/**
 * Projects a root → symptom causal tree from detector signal CP3 causal fields (`causalRole`,
 * `causes`, `attributionConfidence`). Pure and deterministic: never recomputes attribution.
 *
 * Ordering is stable and independent of map-iteration order: roots preserve the candidates' ranked
 * (root-first) file order; each root's symptoms follow that root's already-sorted `causes` list.
 * Returns `[]` when no candidate is a root with attributed symptoms.
 */
function buildCausalTree(
  candidates: EvidenceCandidate[],
): LlmBundleCausalRoot[] {
  const byId = new Map<string, EvidenceCandidate>();
  for (const candidate of candidates) byId.set(candidate.id, candidate);

  const roots: LlmBundleCausalRoot[] = [];
  // Iterate candidates in their emitted (ranked, root-first) order for deterministic root ordering.
  for (const candidate of candidates) {
    if (candidate.causalRole !== "root") continue;
    const causeIds = candidate.causes ?? [];
    if (causeIds.length === 0) continue;
    const symptoms: LlmBundleCausalSymptom[] = [];
    for (const id of causeIds) {
      const symptom = byId.get(id);
      if (!symptom) continue;
      symptoms.push(
        removeUndefined({
          id: symptom.id,
          detector: symptom.detector,
          title: symptom.title,
          attributionConfidence: symptom.attributionConfidence,
        }) as LlmBundleCausalSymptom,
      );
    }
    if (symptoms.length === 0) continue;
    roots.push({
      id: candidate.id,
      detector: candidate.detector,
      title: candidate.title,
      symptoms,
    });
  }
  return roots;
}

const DB_DIFF_OPS = new Set(["insert", "update", "delete"]);

const DB_ENGINES = new Set<DbEngine>(["postgres", "mysql", "mssql", "sqlite"]);

/**
 * Normalizes an event's `engine` tag to the {@link DbEngine} union. Legacy/unknown values default
 * to `"postgres"` — the only engine that ever emitted `db.diff`/`db.read` before multi-engine
 * support — so pre-existing sessions keep their (correct) postgres labeling. Shared by the
 * downstream db consumers (bundle, evidence index) so they stay engine-agnostic identically.
 */
export function normalizeDbEngine(value: unknown): DbEngine {
  return typeof value === "string" && DB_ENGINES.has(value as DbEngine)
    ? (value as DbEngine)
    : "postgres";
}

/**
 * Surfaces redaction-aware row diffs from the session's `k:'db.diff'` events. Sensitive columns
 * were already dropped in the shim; we re-run the shared redaction policy over each image as
 * defense-in-depth so secret-looking values can never rest in the bundle.
 */
/**
 * The value a user typed, when the redaction policy kept one.
 *
 * The renderer used to state "value redacted" for every input, unconditionally, and drop what the
 * event carried. That was true once and has not been for some time: the capture policy now runs
 * typed values through the same classifier as a request body, keeps numbers and short enum-like
 * strings, and ships a `captureInputValues` opt-out for deployments that want none of it. The
 * comment justifying that work names this exact case — the ceiling a shopper typed beside the
 * ceiling the request carried — and the bundle a reader gets held only the second one.
 *
 * Nothing here loosens redaction. It renders what policy already decided to keep, and says plainly
 * when policy kept nothing, so a withheld value cannot read as an absent one.
 *
 * Two gates, and the second is the one that matters. `valSummary.action === "redacted"` is the
 * policy's own verdict on the capture side and is authoritative when present — but only a REDACTED
 * value carries a summary, so its absence means either "policy kept this" or "nothing ever
 * classified this". Those are not the same, and a value that reached here unprocessed would be
 * rendered on trust alone.
 *
 * So the value is re-run through the same classifier regardless. `redactInputValue` is what the
 * capture side uses; agreeing with it costs a function call and removes the need to trust the
 * pipeline, in a renderer whose output is the thing that leaves the machine.
 */
function keptInputValue(event: BugEvent): string | undefined {
  const d = event.d;
  if (!isRecord(d)) return undefined;
  const summary = isRecord(d.valSummary) ? d.valSummary : undefined;
  if (summary?.action === "redacted") return undefined;
  const value = d.val;
  if (typeof value !== "string" || value.length === 0) return undefined;
  // An already-redacted value classifies as harmless, because it IS harmless — and "user typed
  // [REDACTED]" states nothing. Withheld is the honest rendering.
  if (value.includes(REDACTED_VALUE) || /^[*\s]+$/.test(value)) return undefined;

  const name = isRecord(d.el)
    ? (safeText(d.el.name, 80) ?? safeText(d.el.id, 80))
    : undefined;
  const reclassified = redactInputValue(value, { name });
  if (reclassified.value !== value) return undefined;
  return truncate(value, 120);
}

/** Transport fields rendered as columns; everything else the application attached goes to `detail`. */
const OUTBOUND_TRANSPORT_FIELDS = new Set([
  "service",
  "operation",
  "method",
  "url",
  "status",
  "durationMs",
  "error",
  "requestId",
]);

function buildOutboundCalls(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleOutboundCall[] {
  const calls: LlmBundleOutboundCall[] = [];
  for (const event of events) {
    if (event.k !== "backend.http" || !isRecord(event.d)) continue;

    const detail: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.d)) {
      if (OUTBOUND_TRANSPORT_FIELDS.has(key) || value === undefined) continue;
      detail[key] = value;
    }

    calls.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        service: safeText(event.d.service, 80),
        operation: safeText(event.d.operation, 80),
        method: safeText(event.d.method, 12),
        url: safeUrl(event.d.url, "event.backend.http.url"),
        status: finiteNumber(event.d.status),
        durationMs: finiteNumber(event.d.durationMs),
        error: safeText(event.d.error, 300),
        requestId: safeCorrelationId(event.d.requestId, 200),
        detail:
          Object.keys(detail).length > 0
            ? (redactValue(detail, "backend.http.detail").value as Record<
                string,
                unknown
              >)
            : undefined,
      }),
    );
  }
  return calls;
}

function buildDatabaseDiffs(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleDbDiff[] {
  const diffs: LlmBundleDbDiff[] = [];
  for (const event of events) {
    if (event.k !== "db.diff" || !isRecord(event.d)) continue;
    const op = safeText(event.d.op, 20);
    const table = safeText(event.d.table, 200);
    if (!op || !DB_DIFF_OPS.has(op) || !table) continue;

    diffs.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        engine: normalizeDbEngine(event.d.engine),
        op: op as LlmBundleDbDiff["op"],
        table,
        pk: isRecord(event.d.pk)
          ? (redactValue(event.d.pk, "db.diff.pk").value as Record<
              string,
              unknown
            >)
          : null,
        after: isRecord(event.d.after)
          ? (redactValue(event.d.after, "db.diff.after").value as Record<
              string,
              unknown
            >)
          : undefined,
        before: isRecord(event.d.before)
          ? (redactValue(event.d.before, "db.diff.before").value as Record<
              string,
              unknown
            >)
          : undefined,
        rowCount: finiteNumber(event.d.rowCount),
        requestId: safeCorrelationId(event.d.requestId, 200),
        callsite: normalizeDbCallsite(event.d.callsite),
      }) as LlmBundleDbDiff,
    );
  }
  return diffs.sort((a, b) => a.t - b.t).slice(0, 200);
}

/**
 * A callsite chain, bounded and stripped to the fields the contract declares.
 *
 * Paths are file locations the runtime already resolved against the repo root,
 * not user data, but they are length-capped like every other string that rests
 * here. Depth is capped at the innermost frame plus four callers so a deep
 * async stack cannot inflate a bundle.
 */
function normalizeDbCallsite(
  raw: unknown,
  depth = 0,
): LlmBundleDbCallsite | undefined {
  if (!isRecord(raw)) return undefined;
  const file = safeText(raw.file, 400);
  if (!file) return undefined;
  const stack =
    depth === 0 && Array.isArray(raw.stack)
      ? raw.stack
          .slice(0, 4)
          .map((frame) => normalizeDbCallsite(frame, depth + 1))
          .filter((frame): frame is LlmBundleDbCallsite => frame !== undefined)
      : undefined;
  return removeUndefined({
    file,
    line: finiteNumber(raw.line),
    column: finiteNumber(raw.column),
    fn: safeText(raw.fn, 200),
    stack: stack && stack.length > 0 ? stack : undefined,
  }) as LlmBundleDbCallsite;
}

function buildDatabaseReads(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleDbRead[] {
  const reads: LlmBundleDbRead[] = [];
  for (const event of events) {
    if (event.k !== "db.read" || !isRecord(event.d)) continue;
    const table = safeText(event.d.table, 200);
    if (!table || !isRecord(event.d.row)) continue;

    reads.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        engine: normalizeDbEngine(event.d.engine),
        table,
        pk: isRecord(event.d.pk)
          ? (redactValue(event.d.pk, "db.read.pk").value as Record<
              string,
              unknown
            >)
          : null,
        row: redactValue(event.d.row, "db.read.row").value as Record<
          string,
          unknown
        >,
        // Omitted, never emitted empty, when the adapter had no statement text: `removeUndefined`
        // drops it, so a reader is never handed a blank field that looks like "asked nothing".
        shape: safeText(event.d.shape, 400) || undefined,
        // A correlation key, not free text. `safeText` reads a 32 hex request
        // id as a long opaque token and redacts it, which collapses every read
        // into one bucket and makes per-request fan-out uncountable. `db.diff`
        // has always used the correlation-aware path; reads are the same field.
        requestId: safeCorrelationId(event.d.requestId, 200),
      }) as LlmBundleDbRead,
    );
  }
  return reads.sort((a, b) => a.t - b.t).slice(0, 200);
}

function buildDatabaseStatements(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleDbStatement[] {
  const statements: LlmBundleDbStatement[] = [];
  for (const event of events) {
    if (event.k !== "db.statement" || !isRecord(event.d)) continue;
    const shape = safeText(event.d.shape, 400);
    // A statement record whose whole content is the shape says nothing without one.
    if (!shape) continue;

    statements.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        engine: normalizeDbEngine(event.d.engine),
        op: safeText(event.d.op, 20) ?? "other",
        table: safeText(event.d.table, 200) ?? null,
        shape,
        // `?? null` and not `|| null`: zero rows is the answer this plane exists to carry.
        rowCount: finiteNumber(event.d.rowCount) ?? null,
        seq: finiteNumber(event.d.seq),
        requestId: safeCorrelationId(event.d.requestId, 200),
      }) as LlmBundleDbStatement,
    );
  }
  return statements.sort((a, b) => a.t - b.t).slice(0, 200);
}

function buildDatabaseErrors(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleDbError[] {
  const errors: LlmBundleDbError[] = [];
  for (const event of events) {
    if (event.k !== "db.error" || !isRecord(event.d)) continue;
    const shape = safeText(event.d.shape, 400);
    if (!shape) continue;

    errors.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        engine: normalizeDbEngine(event.d.engine),
        op: safeText(event.d.op, 20) ?? "other",
        table: safeText(event.d.table, 200) ?? null,
        shape,
        // A closed vocabulary of short codes, not free text, so it travels as a
        // correlation-style identifier rather than through the prose-shaped path.
        code: safeCorrelationId(event.d.code, 64) ?? null,
        errorName: safeText(event.d.errorName, 120) ?? "UnknownError",
        requestId: safeCorrelationId(event.d.requestId, 200),
      }) as LlmBundleDbError,
    );
  }
  return errors.sort((a, b) => a.t - b.t).slice(0, 200);
}

function buildDatabaseActivity(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleDbActivity[] {
  const activity: LlmBundleDbActivity[] = [];
  for (const event of events) {
    if (
      event.k !== "backend.otel.span" ||
      !isRecord(event.d) ||
      !isRecord(event.d.attributes)
    )
      continue;
    const attrs = event.d.attributes;
    const system =
      safeText(attrs["db.system"], 80) ?? safeText(attrs["db.name"], 80);
    const operation =
      safeText(attrs["db.operation"], 80) ??
      safeText(attrs["db.operation.name"], 80);
    const statementRaw =
      safeText(attrs["db.statement"], 1000) ??
      safeText(attrs["db.query.text"], 1000);
    if (!system && !operation && !statementRaw) continue;
    const statement = statementRaw
      ? (redactValue(statementRaw, "otel.db.statement").value as string)
      : undefined;

    activity.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        evidenceType: "otel_db_activity_statements_not_row_diffs" as const,
        system,
        operation,
        statement,
        spanName: safeText(event.d.name, 200),
        serviceName: safeText(event.d.serviceName, 120),
        requestId:
          safeText(event.d.traceId, 200) ?? safeText(event.d.requestId, 200),
        upgradeHint:
          "Statements only; row diffs unavailable from external OTLP. Add Crumbtrail DB instrumentation for before/after row state.",
      }) as LlmBundleDbActivity,
    );
  }
  return activity.sort((a, b) => a.t - b.t).slice(0, 200);
}

function sanitizeBrowser(
  value: unknown,
): { name: string; version?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const name = safeText(value.name, 60);
  if (!name) return undefined;
  return removeUndefined({ name, version: safeText(value.version, 60) }) as {
    name: string;
    version?: string;
  };
}

function sanitizeViewport(
  value: unknown,
): { w: number; h: number } | undefined {
  if (!isRecord(value)) return undefined;
  const w = finiteNumber(value.w);
  const h = finiteNumber(value.h);
  if (w === undefined || h === undefined) return undefined;
  return { w, h };
}

// One seam behind the index/event duality: prefer index entries, else `eventKind`
// events; map, drop undefined, optionally compact same-signature runs, cap.
// `excludeUntrusted` filters page-world-untrusted. `signatureOf` opts a call site in to
// run compaction (B3); call sites without it (tab boundaries) are byte-identical to before.
function selectSummaries<T extends { t: number }>(options: {
  indexEntries: unknown;
  fromIndex: (value: unknown) => T | undefined;
  events?: BugEvent[];
  eventKind?: string;
  fromEvent?: (event: BugEvent) => T | undefined;
  excludeUntrusted?: boolean;
  cap?: number;
  /** Opt-in run compaction: same-signature entries collapse to one annotated exemplar. */
  signatureOf?: (entry: T) => string;
}): T[] {
  const { events, fromEvent, eventKind, excludeUntrusted, cap, signatureOf } =
    options;
  const keepRecord = (entry: unknown) =>
    !excludeUntrusted || !isPageWorldUntrustedRecord(entry);
  const keepEvent = (event: BugEvent) =>
    (eventKind === undefined || event.k === eventKind) &&
    (!excludeUntrusted || !isPageWorldUntrustedEvent(event));

  const indexed = (
    Array.isArray(options.indexEntries) ? options.indexEntries : []
  )
    .filter(keepRecord)
    .map((entry) => options.fromIndex(entry))
    .filter((entry): entry is T => entry !== undefined);

  const selected =
    indexed.length > 0 || !events || !fromEvent
      ? indexed
      : events
          .filter(keepEvent)
          .map((event) => fromEvent(event))
          .filter((entry): entry is T => entry !== undefined);

  // Compact BEFORE the cap so the cap counts exemplars, not raw duplicates.
  const compacted = signatureOf
    ? compactSummaryRuns(selected, signatureOf)
    : selected;

  return cap === undefined ? compacted : compacted.slice(0, cap);
}

/**
 * B3 run compaction: collapses same-signature entries into ONE exemplar — a verbatim copy of
 * the earliest entry in stream order (already redacted upstream; nothing is synthesized or
 * merged) — annotated with `count` (run size), `firstAt` (min `t`), and `lastAt` (max `t`).
 * The annotations are added ONLY when a signature occurs 2+ times, so singleton entries stay
 * byte-identical to the uncompacted output. Deterministic: exemplars keep the stream-order
 * position of their signature's first occurrence.
 */
function compactSummaryRuns<T extends { t: number }>(
  entries: T[],
  signatureOf: (entry: T) => string,
): T[] {
  const groups = new Map<
    string,
    { exemplar: T; count: number; firstAt: number; lastAt: number }
  >();
  for (const entry of entries) {
    const signature = signatureOf(entry);
    const group = groups.get(signature);
    if (!group) {
      groups.set(signature, {
        exemplar: entry,
        count: 1,
        firstAt: entry.t,
        lastAt: entry.t,
      });
    } else {
      group.count += 1;
      group.firstAt = Math.min(group.firstAt, entry.t);
      group.lastAt = Math.max(group.lastAt, entry.t);
    }
  }

  return [...groups.values()].map((group) =>
    group.count < 2
      ? group.exemplar
      : {
          ...group.exemplar,
          count: group.count,
          firstAt: group.firstAt,
          lastAt: group.lastAt,
        },
  );
}

// Mirrors evidence-index.ts normalizeErrorSignature (module-private there, and that file is
// out of scope to edit; precedent: evidence-index.ts itself mirrors distinct-bugs.ts
// normalizeSignature). Lowercase, drop redaction markers, collapse digits to '#', normalize
// whitespace — so bundle-level run compaction keys the same way as candidate-level dedupe.
function normalizeSummarySignature(value: unknown): string {
  const text = safeText(value, 300);
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/\[redacted\]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

// Field separator for composite signature keys; a control character keeps distinct fields
// from colliding across boundaries (normalized summary text never contains it).
const SIGNATURE_SEPARATOR = "\u0000";

function failedRequestSignature(entry: LlmBundleFailedRequestSummary): string {
  return [
    entry.method ?? "",
    normalizeSummarySignature(entry.url),
    entry.status !== undefined ? String(entry.status) : "",
    entry.reason ?? "",
    entry.code ?? "",
    normalizeSummarySignature(entry.requestBody),
    normalizeSummarySignature(entry.responseBody),
  ].join(SIGNATURE_SEPARATOR);
}

function networkErrorSignature(entry: LlmBundleNetworkErrorSummary): string {
  return [
    entry.method ?? "",
    normalizeSummarySignature(entry.url),
    normalizeSummarySignature(entry.message),
    entry.transport ?? "",
    normalizeSummarySignature(entry.requestBody),
  ].join(SIGNATURE_SEPARATOR);
}

function consoleErrorSignature(entry: LlmBundleConsoleErrorSummary): string {
  return [
    entry.level,
    normalizeSummarySignature(entry.message),
    entry.source ?? "",
  ].join(SIGNATURE_SEPARATOR);
}

function buildFailedRequestSummaries(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleFailedRequestSummary[] {
  return selectSummaries({
    indexEntries: index.failedReqs,
    fromIndex: (req) => failedRequestFromIndex(req, events, sessionStartMs),
    excludeUntrusted: true,
    cap: 40,
    signatureOf: failedRequestSignature,
  });
}

function failedRequestFromIndex(
  value: unknown,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleFailedRequestSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;

  const networkEvent =
    safeText(value.reason, 80) === "network_error"
      ? networkErrorForIndex(events, value, t)
      : responseForFailedRequest(events, value, t);
  const request = networkEvent
    ? requestForNetworkEvent(events, networkEvent)
    : undefined;

  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs:
      finiteNumber(value.offsetMs) ?? offsetFromStart(t, sessionStartMs),
    method: safeText(value.m, 20) ?? safeText(value.method, 20),
    url: safeUrl(value.url, "index.failedReqs.url"),
    status: finiteNumber(value.st),
    reason: safeText(value.reason, 80),
    code: safeText(value.code, 120),
    message: safeText(value.message, 160),
    phase: safeText(value.phase, 120),
    requestBody: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
    responseBody: networkEvent?.k === "net.res"
      ? redactedNetworkBodySnippet(
          networkEvent.d.body,
          networkEvent.d.bodySummary,
        )
      : undefined,
  });
}

function requestForNetworkEvent(
  events: BugEvent[],
  event: BugEvent,
): BugEvent | undefined {
  const id = requestIdForEvent(event);
  if (!id) return undefined;
  return events.find(
    (candidate) =>
      candidate.k === "net.req" && requestIdForEvent(candidate) === id,
  );
}

function responseForFailedRequest(
  events: BugEvent[],
  value: Record<string, unknown>,
  t: number,
): BugEvent | undefined {
  const id = requestIdForValue(value);
  if (id) {
    const matches = events.filter(
      (event) => event.k === "net.res" && requestIdForEvent(event) === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  const matches = events.filter(
    (event) =>
      event.k === "net.res" &&
      event.t === t &&
      finiteNumber(event.d.st) === finiteNumber(value.st),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function requestIdForEvent(event: BugEvent | undefined): string | undefined {
  return event ? requestIdForValue(event.d) : undefined;
}

function requestIdForValue(value: Record<string, unknown>): string | undefined {
  const numericId = finiteNumber(value.id);
  return numericId !== undefined ? String(numericId) : safeText(value.id, 120);
}

function summarizeApplicationFailure(event: BugEvent):
  | {
      reason: "application_failure";
      code?: string;
      message?: string;
      phase?: string;
    }
  | undefined {
  const failure = findApplicationFailure(readResponseBody(event.d.body));
  if (!failure) return undefined;
  return removeUndefined({
    reason: "application_failure" as const,
    code: safeText(failure.code, 120),
    message: safeText(failure.message, 160),
    phase: safeText(failure.phase, 120),
  });
}

function readResponseBody(body: unknown): unknown {
  if (typeof body === "string") return body;
  if (isRecord(body) && body.dedup === true) return undefined;
  return body;
}

function findApplicationFailure(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") return findApplicationFailureInText(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = findApplicationFailure(item);
      if (failure) return failure;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  if (value.ok === false || value.status === "failed") return value;

  for (const nested of Object.values(value)) {
    const failure = findApplicationFailure(nested);
    if (failure) return failure;
  }

  return undefined;
}

function findApplicationFailureInText(
  text: string,
): Record<string, unknown> | undefined {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const failure = findApplicationFailure(JSON.parse(candidate));
      if (failure) return failure;
    } catch {
      // Framework response streams can include non-JSON chunks around JSON records.
    }
  }
  return undefined;
}

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = new Set<string>();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    candidates.add(trimmed);

  for (const line of trimmed.split(/\r?\n/)) {
    const chunk = line.trim();
    if (!chunk) continue;
    const framed = chunk.match(/^\d+:(.*)$/);
    const unframed = (framed?.[1] ?? chunk).trim();
    if (unframed.startsWith("{") || unframed.startsWith("["))
      candidates.add(unframed);
    const objectStart = unframed.indexOf("{");
    if (objectStart >= 0) candidates.add(unframed.slice(objectStart));
  }

  return [...candidates];
}

function buildNetworkErrorSummaries(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleNetworkErrorSummary[] {
  return selectSummaries({
    indexEntries: index.networkErrors,
    fromIndex: (entry) => networkErrorFromIndex(entry, events, sessionStartMs),
    events,
    eventKind: "net.err",
    fromEvent: (event) => networkErrorFromEvent(event, events, sessionStartMs),
    excludeUntrusted: true,
    cap: 40,
    signatureOf: networkErrorSignature,
  });
}

function networkErrorFromIndex(
  value: unknown,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleNetworkErrorSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;

  const networkError = networkErrorForIndex(events, value, t);
  const request = networkError
    ? requestForNetworkEvent(events, networkError)
    : undefined;

  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs:
      finiteNumber(value.offsetMs) ?? offsetFromStart(t, sessionStartMs),
    method: safeText(value.m, 20) ?? safeText(value.method, 20),
    url: safeUrl(value.url, "index.networkErrors.url"),
    message: safeText(value.msg, 180),
    transport: safeText(value.transport, 40),
    requestBody: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
  });
}

function networkErrorForIndex(
  events: BugEvent[],
  value: Record<string, unknown>,
  t: number,
): BugEvent | undefined {
  const id = requestIdForValue(value);
  const matches = events.filter(
    (event) =>
      event.k === "net.err" &&
      (id ? requestIdForEvent(event) === id : event.t === t),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function networkErrorFromEvent(
  event: BugEvent,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleNetworkErrorSummary | undefined {
  if (event.k !== "net.err") return undefined;
  const request = requestForNetworkEvent(events, event);
  return removeUndefined({
    t: event.t,
    iso: iso(event.t),
    offsetMs:
      finiteNumber(event.offsetMs) ?? offsetFromStart(event.t, sessionStartMs),
    method: safeText(event.d.method, 20) ?? safeText(event.d.m, 20),
    url: safeUrl(event.d.url, "event.net.err.url"),
    message: safeText(event.d.msg, 180),
    transport: safeText(event.d.transport, 40),
    requestBody: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
  });
}

function buildConsoleErrorSummaries(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleConsoleErrorSummary[] {
  return selectSummaries({
    indexEntries: index.consoleErrors,
    fromIndex: (entry) => consoleErrorFromIndex(entry, sessionStartMs),
    events,
    eventKind: "con",
    fromEvent: (event) => consoleErrorFromEvent(event, sessionStartMs),
    excludeUntrusted: true,
    cap: 40,
    signatureOf: consoleErrorSignature,
  });
}

function consoleErrorFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleConsoleErrorSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  const message = safeText(value.msg, 240);
  if (t === undefined || message === undefined) return undefined;

  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs:
      finiteNumber(value.offsetMs) ?? offsetFromStart(t, sessionStartMs),
    level: consoleLevel(value.lv) ?? "err",
    message,
    source: safeText(value.source, 80),
  });
}

function consoleErrorFromEvent(
  event: BugEvent,
  sessionStartMs: number,
): LlmBundleConsoleErrorSummary | undefined {
  const level = consoleLevel(event.d.lv);
  if (level !== "err" && level !== "error") return undefined;
  const message = consoleMessageFromPayload(event.d);
  if (!message) return undefined;

  return removeUndefined({
    t: event.t,
    iso: iso(event.t),
    offsetMs:
      finiteNumber(event.offsetMs) ?? offsetFromStart(event.t, sessionStartMs),
    level,
    message,
    source: safeText(event.d.source, 80),
  });
}

function consoleLevel(value: unknown): string | undefined {
  const level = safeText(value, 20)?.toLowerCase();
  if (!level) return undefined;
  return level === "error" ? "err" : level;
}

function consoleMessageFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  const msg = safeText(payload.msg, 240);
  if (msg) return msg;
  if (!Array.isArray(payload.args)) return undefined;

  const joined = payload.args
    .slice(0, 6)
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
    .filter(
      (arg): arg is string => typeof arg === "string" && arg.trim().length > 0,
    )
    .join(" ");
  return safeText(joined, 240);
}

function buildPageProbeSummary(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundlePageProbeSummary {
  const summary: LlmBundlePageProbeSummary = {
    requested: false,
    readyEvents: 0,
    errorEvents: 0,
    frameContexts: 0,
    startedContexts: 0,
    limitedContexts: 0,
    features: {},
    errors: [],
    limitations: [],
  };

  const hasPageProbeEvents = events.some(
    (event) =>
      event.k === "probe.ready" ||
      event.k === "probe.error" ||
      event.k === "frame.ctx",
  );
  if (!hasPageProbeEvents)
    applyIndexedPageProbeSummary(summary, index.pageProbe);

  for (const event of events) {
    if (event.k === "probe.ready") {
      summary.readyEvents += 1;
      summary.requested = true;
      copyBooleanFeatures(summary.features, event.d.features);
      continue;
    }

    if (event.k === "probe.error") {
      summary.errorEvents += 1;
      summary.requested = true;
      const error = pageProbeErrorFromEvent(event, sessionStartMs);
      if (error) summary.errors.push(error);
      continue;
    }

    if (event.k === "frame.ctx") {
      summary.frameContexts += 1;
      const pageProbe = isRecord(event.d.pageProbe)
        ? event.d.pageProbe
        : undefined;
      if (!pageProbe) continue;
      if (pageProbe.requested === true) summary.requested = true;
      if (pageProbe.started === true) summary.startedContexts += 1;
      if (pageProbe.limited === true) {
        summary.limitedContexts += 1;
        const reason = safeText(pageProbe.reason, 120);
        summary.limitations.push(
          reason
            ? `Page probe was limited: ${reason}.`
            : "Page probe was limited for at least one frame.",
        );
      }
    }
  }

  if (summary.requested && summary.readyEvents === 0) {
    summary.limitations.push(
      "Page probe was requested but no probe.ready event was captured.",
    );
  }
  if (summary.errorEvents > 0) {
    summary.limitations.push(
      `${summary.errorEvents} page probe error event(s) were captured.`,
    );
  }
  if (events.some(isPageWorldUntrustedEvent)) {
    summary.limitations.push(
      "Page-probe events are page-world-untrusted and are included only as corroboration hints, not authoritative evidence.",
    );
  }

  return {
    ...summary,
    features: Object.fromEntries(
      Object.entries(summary.features).sort(([a], [b]) => a.localeCompare(b)),
    ),
    errors: summary.errors.slice(0, 20),
    limitations: Array.from(new Set(summary.limitations)),
  };
}

function applyIndexedPageProbeSummary(
  summary: LlmBundlePageProbeSummary,
  value: unknown,
): void {
  if (!isRecord(value)) return;

  if (value.requested === true) summary.requested = true;
  summary.readyEvents = Math.max(
    summary.readyEvents,
    finiteNumber(value.readyEvents) ?? 0,
  );
  summary.errorEvents = Math.max(
    summary.errorEvents,
    finiteNumber(value.errorEvents) ?? 0,
  );
  summary.frameContexts = Math.max(
    summary.frameContexts,
    finiteNumber(value.frameContexts) ?? 0,
  );
  summary.startedContexts = Math.max(
    summary.startedContexts,
    finiteNumber(value.startedContexts) ?? 0,
  );
  summary.limitedContexts = Math.max(
    summary.limitedContexts,
    finiteNumber(value.limitedContexts) ?? 0,
  );
  copyBooleanFeatures(summary.features, value.features);

  if (Array.isArray(value.errors)) {
    for (const error of value.errors) {
      const sanitized = pageProbeErrorFromIndex(error);
      if (sanitized) summary.errors.push(sanitized);
    }
  }
  if (Array.isArray(value.limitations)) {
    for (const limitation of value.limitations) {
      const sanitized = safeText(limitation, 180);
      if (sanitized) summary.limitations.push(sanitized);
    }
  }
}

function pageProbeErrorFromEvent(
  event: BugEvent,
  sessionStartMs: number,
): LlmBundlePageProbeErrorSummary | undefined {
  return removeUndefined({
    t: event.t,
    iso: iso(event.t),
    offsetMs:
      finiteNumber(event.offsetMs) ?? offsetFromStart(event.t, sessionStartMs),
    phase: safeText(event.d.phase, 80),
    message: safeText(event.d.message, 180),
    source: safeText(event.d.source, 80),
  });
}

function pageProbeErrorFromIndex(
  value: unknown,
): LlmBundlePageProbeErrorSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;
  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs: finiteNumber(value.offsetMs),
    phase: safeText(value.phase, 80),
    message: safeText(value.message, 180),
    source: safeText(value.source, 80),
  });
}

function copyBooleanFeatures(
  target: Record<string, boolean>,
  value: unknown,
): void {
  if (!isRecord(value)) return;
  for (const [key, enabled] of Object.entries(value)) {
    const safeKey = safeText(key, 60);
    if (safeKey && typeof enabled === "boolean") target[safeKey] = enabled;
  }
}

function buildTabBoundarySummary(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleTabBoundarySummary {
  const decisions = selectSummaries({
    indexEntries: index.tabBoundaries,
    fromIndex: (entry) => tabBoundaryFromIndex(entry, sessionStartMs),
    events,
    eventKind: "tab.boundary",
    fromEvent: (event) => tabBoundaryFromEvent(event, sessionStartMs),
  });
  const decisionCounts: Record<string, number> = {};
  let nonCaptureCount = 0;

  for (const decision of decisions) {
    const key = decision.decision ?? "unknown";
    decisionCounts[key] = (decisionCounts[key] ?? 0) + 1;
    if (
      decision.nonCapture === true ||
      decision.capture === false ||
      (decision.decision !== undefined && decision.decision !== "follow")
    ) {
      nonCaptureCount += 1;
    }
  }

  return {
    total: decisions.length,
    decisionCounts: sortRecord(decisionCounts),
    nonCaptureCount,
    decisions: decisions.slice(0, 40),
  };
}

// One tab-boundary mapper; the wrappers only adapt source + the `t` guard.
function tabBoundaryDecision(
  record: Record<string, unknown>,
  t: number,
  offsetMs: number | undefined,
  sessionStartMs: number,
): LlmBundleTabBoundaryDecisionSummary {
  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs: offsetMs ?? offsetFromStart(t, sessionStartMs),
    signal: safeText(record.signal, 80),
    decision: safeText(record.decision, 80),
    reason: safeText(record.reason, 120),
    capture: typeof record.capture === "boolean" ? record.capture : undefined,
    nonCapture:
      typeof record.nonCapture === "boolean" ? record.nonCapture : undefined,
    previousCapturedOrigin: safeOrigin(record.previousCapturedOrigin),
    root: boundaryLocationFromValue(record.root),
    current: boundaryLocationFromValue(record.current),
    candidate: boundaryLocationFromValue(record.candidate),
    prompt: boundaryPromptFromValue(record.prompt),
  });
}

function tabBoundaryFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleTabBoundaryDecisionSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;
  const offset = finiteNumber(value.offsetMs);
  return tabBoundaryDecision(value, t, offset, sessionStartMs);
}

function tabBoundaryFromEvent(
  event: BugEvent,
  sessionStartMs: number,
): LlmBundleTabBoundaryDecisionSummary | undefined {
  const offset = finiteNumber(event.offsetMs);
  return tabBoundaryDecision(event.d, event.t, offset, sessionStartMs);
}

function boundaryLocationFromValue(
  value: unknown,
): LlmBundleTabBoundaryLocationSummary | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = removeUndefined({
    origin:
      safeOrigin(value.origin) ??
      safeOrigin(value.url) ??
      safeOrigin(value.href),
    host: safeHost(value.host),
    scheme: safeText(value.scheme, 40),
    valid: typeof value.valid === "boolean" ? value.valid : undefined,
    restricted:
      typeof value.restricted === "boolean" ? value.restricted : undefined,
    opaque: typeof value.opaque === "boolean" ? value.opaque : undefined,
    isLocalhost:
      typeof value.isLocalhost === "boolean" ? value.isLocalhost : undefined,
  });
  return Object.keys(candidate).length > 0 ? candidate : undefined;
}

function boundaryPromptFromValue(
  value: unknown,
): LlmBundleTabBoundaryDecisionSummary["prompt"] | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = removeUndefined({
    origin: safeOrigin(value.origin) ?? safeOrigin(value.url),
    outcome: safeText(value.outcome, 80),
  });
  return Object.keys(prompt).length > 0 ? prompt : undefined;
}

/**
 * Payload snippets for one request id, resolved from the session's events.
 *
 * `index.fullStackRequests` is a link table: it records that a frontend request
 * and a backend request are the same request, and carries no payloads. The
 * payloads are in the events the link table points at, so the join is done here
 * rather than widening the index.
 */
interface FullStackPayloads {
  frontendRequestBody?: string;
  frontendResponseBody?: string;
  frontendRequestCallsite?: LlmBundleDbCallsite;
  backendResponseBody?: string;
  backendResponseCallsite?: LlmBundleDbCallsite;
}

/**
 * Indexes redacted request and response snippets by correlation id.
 *
 * Every snippet goes through `redactedNetworkBodySnippet`, which re-runs the
 * capture-time policy, so this adds no new raw-payload path: it carries evidence
 * the session already holds into the artifact an agent actually reads.
 */
function buildFullStackPayloadIndex(
  events: BugEvent[],
): Map<string, FullStackPayloads> {
  const byRequest = new Map<string, FullStackPayloads>();
  // Built once for the whole index, not per event: the lookup carries the parsed
  // map cache, and a production chunk is expensive to parse exactly once.
  const resolveClient = clientCallsiteResolver();
  const entryFor = (requestId: string): FullStackPayloads => {
    const existing = byRequest.get(requestId);
    if (existing) return existing;
    const created: FullStackPayloads = {};
    byRequest.set(requestId, created);
    return created;
  };

  for (const event of events) {
    if (!isRecord(event.d)) continue;
    const requestId = safeCorrelationId(event.d.requestId);
    if (!requestId || requestId === REDACTED_VALUE) continue;

    if (event.k === "net.req") {
      const body = redactedNetworkBodySnippet(event.d.body, event.d.bodySummary);
      if (body) entryFor(requestId).frontendRequestBody ??= body;
      // Resolved HERE, at the single point a client callsite enters the bundle,
      // so `fullStackEvidence` and `code_locations` cannot disagree about which
      // file a reader should open.
      const parsed = clientCallsiteFromStack(event.d.stk);
      const callsite =
        parsed && resolveClient ? resolveClient(parsed) : parsed;
      if (callsite) entryFor(requestId).frontendRequestCallsite ??= callsite;
    } else if (event.k === "net.res") {
      const body = redactedNetworkBodySnippet(event.d.body, event.d.bodySummary);
      if (body) entryFor(requestId).frontendResponseBody ??= body;
    } else if (event.k === "backend.req.end") {
      const body = redactedNetworkBodySnippet(
        event.d.responseBody,
        event.d.responseBodySummary,
      );
      if (body) entryFor(requestId).backendResponseBody ??= body;
      const callsite = normalizeDbCallsite(event.d.responseCallsite);
      if (callsite) entryFor(requestId).backendResponseCallsite ??= callsite;
    }
  }

  return byRequest;
}

const FULL_STACK_SUMMARY_CAP = 40;

/**
 * Applies the cap by outcome rather than by arrival.
 *
 * A busy page issues far more requests than the cap keeps, and the ones that
 * failed are the reason anyone opens the bundle. Taking the first N by arrival
 * lets a session's only 500 fall off behind forty successful polls, which reads
 * as "nothing failed". Within a tier the original order is preserved, so a
 * session under the cap is unchanged.
 */
function keepFailuresFirst<
  T extends {
    frontend?: { status?: number };
    backend?: { statusCode?: number };
  },
>(entries: T[], cap: number): T[] {
  if (entries.length <= cap) return entries;
  const rank = (entry: T): number => {
    const status = entry.backend?.statusCode ?? entry.frontend?.status ?? 0;
    if (status >= 500) return 0;
    if (status >= 400) return 1;
    return 2;
  };
  return entries
    .map((entry, position) => ({ entry, position, rank: rank(entry) }))
    .sort((a, b) => a.rank - b.rank || a.position - b.position)
    .slice(0, cap)
    .sort((a, b) => a.position - b.position)
    .map(({ entry }) => entry);
}

function buildFullStackEvidence(
  index: SessionIndexLike,
  sessionStartMs: number,
  payloads: Map<string, FullStackPayloads>,
): LlmBundleFullStackEvidence {
  const empty: LlmBundleFullStackEvidence = {
    schemaVersion: 1,
    summary: {
      frontendRequests: 0,
      backendRequests: 0,
      linked: 0,
      gaps: 0,
      gapTypes: {},
    },
    linked: [],
    gaps: [],
    limitations: [],
  };

  if (!isRecord(index.fullStackRequests)) return empty;
  const summary = isRecord(index.fullStackRequests.summary)
    ? index.fullStackRequests.summary
    : {};
  const linked = Array.isArray(index.fullStackRequests.linked)
    ? keepFailuresFirst(
        index.fullStackRequests.linked
          .map((entry) =>
            linkedFullStackRequestFromIndex(entry, sessionStartMs, payloads),
          )
          .filter(
            (entry): entry is LlmBundleLinkedFullStackRequestSummary =>
              entry !== undefined,
          ),
        FULL_STACK_SUMMARY_CAP,
      )
    : [];
  const gaps = Array.isArray(index.fullStackRequests.gaps)
    ? keepFailuresFirst(
        index.fullStackRequests.gaps
          .map((entry) => fullStackGapFromIndex(entry, sessionStartMs, payloads))
          .filter(
            (entry): entry is LlmBundleFullStackRequestGapSummary =>
              entry !== undefined,
          ),
        FULL_STACK_SUMMARY_CAP,
      )
    : [];
  const summaryGapTypes = sanitizeGapTypes(summary.gapTypes);
  const gapTypes =
    Object.keys(summaryGapTypes).length > 0
      ? summaryGapTypes
      : countGapTypes(gaps);
  const frontendRequests = finiteNumber(summary.frontendRequests) ?? 0;
  const backendRequests = finiteNumber(summary.backendRequests) ?? 0;
  const linkedTotal = finiteNumber(summary.linked) ?? linked.length;
  const gapsTotal = finiteNumber(summary.gaps) ?? gaps.length;
  const limitations: string[] = [];

  if (linked.length < linkedTotal) {
    limitations.push(
      `Full-stack linked request summaries are capped at 40 of ${linkedTotal}.`,
    );
  }
  if (gaps.length < gapsTotal) {
    limitations.push(
      `Full-stack linkage gap summaries are capped at 40 of ${gapsTotal}.`,
    );
  }
  if (gapsTotal > 0) {
    limitations.push(
      "Partial full-stack linkage exists; do not assume every frontend request has backend evidence or every backend request has frontend evidence.",
    );
  }

  return {
    schemaVersion: 1,
    summary: {
      frontendRequests,
      backendRequests,
      linked: linkedTotal,
      gaps: gapsTotal,
      gapTypes,
    },
    linked,
    gaps,
    limitations,
  };
}

function linkedFullStackRequestFromIndex(
  value: unknown,
  sessionStartMs: number,
  payloads: Map<string, FullStackPayloads>,
): LlmBundleLinkedFullStackRequestSummary | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = safeCorrelationId(value.requestId);
  const sessionId = safeCorrelationId(value.sessionId);
  const payload = requestId ? payloads.get(requestId) : undefined;
  const frontend = frontendRequestEvidenceFromIndex(
    value.frontend,
    sessionStartMs,
    payload,
  );
  const backend = backendRequestEvidenceFromIndex(
    value.backend,
    sessionStartMs,
    payload,
  );
  if (!requestId || !sessionId || !frontend || !backend) return undefined;

  return { requestId, sessionId, frontend, backend };
}

function fullStackGapFromIndex(
  value: unknown,
  sessionStartMs: number,
  payloads: Map<string, FullStackPayloads>,
): LlmBundleFullStackRequestGapSummary | undefined {
  if (!isRecord(value) || !isFullStackGapKind(value.type)) return undefined;
  const requestId = safeCorrelationId(value.requestId);
  const payload = requestId ? payloads.get(requestId) : undefined;
  const gap = removeUndefined({
    type: value.type,
    requestId,
    sessionId: safeCorrelationId(value.sessionId),
    frontend: frontendRequestEvidenceFromIndex(
      value.frontend,
      sessionStartMs,
      payload,
    ),
    backend: backendRequestEvidenceFromIndex(
      value.backend,
      sessionStartMs,
      payload,
    ),
  });
  return gap.frontend || gap.backend || gap.requestId || gap.sessionId
    ? gap
    : undefined;
}

function frontendRequestEvidenceFromIndex(
  value: unknown,
  sessionStartMs: number,
  payload?: FullStackPayloads,
): LlmBundleFrontendRequestEvidenceSummary | undefined {
  if (!isRecord(value)) return undefined;
  const frontend = removeUndefined({
    ref: fullStackEventRefFromIndex(value.ref, sessionStartMs),
    requestId: safeCorrelationId(value.requestId),
    sessionId: safeCorrelationId(value.sessionId),
    method: safeText(value.method, 20),
    url: safeUrl(value.url, "index.fullStackRequests.frontend.url"),
    gql: graphqlIdentityFromIndex(value.gql),
    status: finiteNumber(value.status),
    durationMs: finiteNumber(value.durationMs),
    requestBody: payload?.frontendRequestBody,
    responseBody: payload?.frontendResponseBody,
    requestCallsite: payload?.frontendRequestCallsite,
    error: fullStackFrontendErrorFromIndex(value.error),
  });
  return Object.keys(frontend).length > 0 ? frontend : undefined;
}

function graphqlIdentityFromIndex(
  value: unknown,
): LlmBundleFrontendRequestEvidenceSummary["gql"] | undefined {
  if (!isRecord(value)) return undefined;
  const op = safeText(value.op, 20);
  if (!op) return undefined;
  const name = safeText(value.name, 120);
  const batch = finiteNumber(value.batch);
  return removeUndefined({ op, name, batch });
}

function backendRequestEvidenceFromIndex(
  value: unknown,
  sessionStartMs: number,
  payload?: FullStackPayloads,
): LlmBundleBackendRequestEvidenceSummary | undefined {
  if (!isRecord(value)) return undefined;
  const backend = removeUndefined({
    requestId: safeCorrelationId(value.requestId),
    sessionId: safeCorrelationId(value.sessionId),
    correlation: fullStackCorrelationFromIndex(value.correlation),
    start: fullStackEventRefFromIndex(value.start, sessionStartMs),
    end: fullStackEventRefFromIndex(value.end, sessionStartMs),
    errorRef: fullStackEventRefFromIndex(value.errorRef, sessionStartMs),
    method: safeText(value.method, 20),
    url: safeUrl(value.url, "index.fullStackRequests.backend.url"),
    pathname: safeUrl(
      value.pathname,
      "index.fullStackRequests.backend.pathname",
    ),
    route: safeText(value.route, 160),
    statusCode: finiteNumber(value.statusCode),
    durationMs: finiteNumber(value.durationMs),
    responseBody: payload?.backendResponseBody,
    responseCallsite: payload?.backendResponseCallsite,
    error: fullStackBackendErrorFromIndex(value.error),
  });
  return Object.keys(backend).length > 0 ? backend : undefined;
}

function fullStackEventRefFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleFullStackEventRef | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;
  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs:
      finiteNumber(value.offsetMs) ?? offsetFromStart(t, sessionStartMs),
    kind: safeText(value.k, 80) ?? safeText(value.kind, 80),
  });
}

function fullStackCorrelationFromIndex(
  value: unknown,
): LlmBundleBackendRequestEvidenceSummary["correlation"] | undefined {
  if (!isRecord(value)) return undefined;
  const correlation = removeUndefined({
    status: safeText(value.status, 80),
    sessionIdSource: safeText(value.sessionIdSource, 80),
    requestIdSource: safeText(value.requestIdSource, 80),
  });
  return Object.keys(correlation).length > 0 ? correlation : undefined;
}

function fullStackFrontendErrorFromIndex(
  value: unknown,
): LlmBundleFrontendRequestEvidenceSummary["error"] | undefined {
  if (!isRecord(value)) return undefined;
  const error = removeUndefined({
    message: safeText(value.message, 180),
    transport: safeText(value.transport, 40),
  });
  return Object.keys(error).length > 0 ? error : undefined;
}

function fullStackBackendErrorFromIndex(
  value: unknown,
): LlmBundleBackendRequestEvidenceSummary["error"] | undefined {
  if (!isRecord(value)) return undefined;
  const error = removeUndefined({
    name: safeText(value.name, 80),
    code: safeText(value.code, 120),
    message: safeText(value.message, 180),
    statusCode: finiteNumber(value.statusCode),
  });
  return Object.keys(error).length > 0 ? error : undefined;
}

function sanitizeGapTypes(
  value: unknown,
): Partial<Record<LlmBundleFullStackGapKind, number>> {
  if (!isRecord(value)) return {};
  const out: Partial<Record<LlmBundleFullStackGapKind, number>> = {};
  for (const [key, count] of Object.entries(value)) {
    if (isFullStackGapKind(key)) out[key] = finiteNumber(count) ?? 0;
  }
  return sortRecord(out as Record<string, number>) as Partial<
    Record<LlmBundleFullStackGapKind, number>
  >;
}

function countGapTypes(
  gaps: LlmBundleFullStackRequestGapSummary[],
): Partial<Record<LlmBundleFullStackGapKind, number>> {
  const out: Partial<Record<LlmBundleFullStackGapKind, number>> = {};
  for (const gap of gaps) out[gap.type] = (out[gap.type] ?? 0) + 1;
  return sortRecord(out as Record<string, number>) as Partial<
    Record<LlmBundleFullStackGapKind, number>
  >;
}

function isFullStackGapKind(
  value: unknown,
): value is LlmBundleFullStackGapKind {
  return (
    value === "frontend-only" ||
    value === "backend-only" ||
    value === "backend-generated-request-id" ||
    value === "backend-missing-session" ||
    value === "backend-missing-request-id" ||
    value === "backend-missing-session-and-request-id" ||
    value === "client-missing-request-id"
  );
}

function buildMediaSummary(
  sessionDir: string,
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundle["media"] {
  const videoEvents = events.filter((event) => event.k === "media.video");
  const voiceEvents = events.filter((event) => event.k === "media.voice");
  const transcriptEvents = events.filter((event) => event.k === "tx");
  const video = mediaArtifactSummary(sessionDir, "recording.webm", videoEvents);
  const audio = {
    ...mediaArtifactSummary(sessionDir, "audio.webm", voiceEvents),
    ...(isRecord(index.audio?.upload)
      ? { upload: sanitizeUploadMetadata(index.audio.upload) }
      : {}),
    ...(isRecord(index.audio?.transcription)
      ? { transcription: sanitizeTranscription(index.audio.transcription) }
      : {}),
  };
  const transcript = {
    ...mediaArtifactSummary(sessionDir, "transcript.json", transcriptEvents),
    eventCount:
      finiteNumber(index.audio?.transcription?.eventCount) ??
      transcriptEvents.length,
  };

  return {
    alignment: {
      sessionStartMs,
      rules: [
        "Event `t` values are absolute Unix epoch milliseconds.",
        "`offsetMs` is milliseconds elapsed from the session start clock when the recorder supplied it.",
        "For video/audio playback, compare a timeline moment offset to the same elapsed time in recording.webm or audio.webm.",
        "`media.video` and `media.voice` events show recorder state changes and upload/degradation moments.",
        "`tx` transcript events use the same event clock; transcript text stays in transcript.json/events.ndjson and is not repeated here.",
      ],
    },
    video,
    audio,
    transcript,
    voiceMarkers: voiceEvents
      .filter((event) => event.d.state === "marker-added")
      .map((event) =>
        removeUndefined({
          t: event.t,
          iso: iso(event.t),
          offsetMs:
            finiteNumber(event.offsetMs) ??
            offsetFromStart(event.t, sessionStartMs),
          label: safeText(event.d.label, 120),
          markerId: safeText(event.d.markerId, 120),
        }),
      ),
  };
}

function mediaArtifactSummary(
  sessionDir: string,
  relativePath: string,
  events: BugEvent[],
): MediaArtifactSummary {
  const artifactPath = path.join(sessionDir, relativePath);
  const exists = fs.existsSync(artifactPath);
  const stat = exists ? fs.statSync(artifactPath) : undefined;
  const states = events
    .map((event) => safeText(event.d.state, 80))
    .filter((state): state is string => state !== undefined);

  return removeUndefined({
    path: relativePath,
    exists,
    bytes: stat?.isFile() ? stat.size : undefined,
    eventCount: events.length,
    firstState: states[0],
    lastState: states[states.length - 1],
  });
}

function sanitizeUploadMetadata(
  upload: Record<string, unknown>,
): Record<string, unknown> {
  return removeUndefined({
    metadataFile: safeText(upload.metadataFile, 80),
    uploadedAt: finiteNumber(upload.uploadedAt),
    contentType: safeText(upload.contentType, 120),
    mimeType: safeText(upload.mimeType, 120),
    durationMs: finiteNumber(upload.durationMs),
    chunkCount: finiteNumber(upload.chunkCount),
    transcriptionRequested:
      typeof upload.transcriptionRequested === "boolean"
        ? upload.transcriptionRequested
        : undefined,
  });
}

function sanitizeTranscription(
  transcription: Record<string, unknown>,
): Record<string, unknown> {
  return removeUndefined({
    state: safeText(transcription.state, 120),
    code: safeText(transcription.code, 120),
    message: safeText(transcription.message, 240),
    transcriptFile: safeText(transcription.transcriptFile, 120),
    eventCount: finiteNumber(transcription.eventCount),
  });
}

function buildDegradedCapabilities(
  sessionDir: string,
  meta: Record<string, unknown>,
  index: SessionIndexLike,
  events: BugEvent[],
): LlmBundleDegradedCapability[] {
  const degraded: LlmBundleDegradedCapability[] = [];
  const seen = new Set<string>();
  const add = (entry: LlmBundleDegradedCapability): void => {
    const key = [
      entry.capability,
      entry.state,
      entry.code,
      entry.phase,
      entry.artifact,
      entry.t,
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    degraded.push(entry);
  };

  for (const capability of stringArray(meta.degradedCollection, 80)) {
    add({
      capability,
      state: "degraded-at-start",
      source: "metadata",
      message: "Session metadata listed this capability in degradedCollection.",
    });
  }

  if (isRecord(meta.collection)) {
    for (const [capability, raw] of Object.entries(meta.collection)) {
      if (!isRecord(raw)) continue;
      const enabled =
        typeof raw.enabled === "boolean" ? raw.enabled : undefined;
      const markedDegraded = raw.degraded === true || enabled === false;
      if (!markedDegraded) continue;
      add(
        removeUndefined({
          capability,
          state: enabled === false ? "disabled" : "degraded",
          source: "metadata" as const,
          message: safeText(raw.reason, 180),
        }),
      );
    }
  }

  for (const event of events) {
    if (event.k !== "media.video" && event.k !== "media.voice") continue;
    const state = safeText(event.d.state, 80);
    const code = safeText(event.d.code, 80);
    const isDegraded =
      state === "error" || state === "degraded" || code !== undefined;
    if (!isDegraded) continue;
    add(
      removeUndefined({
        capability:
          safeText(event.d.capability, 80) ??
          (event.k === "media.video" ? "video" : "audio"),
        state: state ?? "degraded",
        source: "event" as const,
        code,
        phase: safeText(event.d.phase, 80),
        message: safeText(event.d.message, 240),
        retryable:
          typeof event.d.retryable === "boolean"
            ? event.d.retryable
            : undefined,
        artifact: event.k === "media.video" ? "recording.webm" : "audio.webm",
        t: event.t,
        offsetMs: finiteNumber(event.offsetMs),
      }),
    );
  }

  for (const event of events) {
    if (event.k === "probe.error") {
      add(
        removeUndefined({
          capability: "page-probe",
          state: "error",
          source: "event" as const,
          code: safeText(event.d.phase, 80),
          message: safeText(event.d.message, 240),
          retryable:
            typeof event.d.retryable === "boolean"
              ? event.d.retryable
              : undefined,
          t: event.t,
          offsetMs: finiteNumber(event.offsetMs),
        }),
      );
      continue;
    }

    if (
      event.k === "frame.ctx" &&
      isRecord(event.d.pageProbe) &&
      event.d.pageProbe.limited === true
    ) {
      add(
        removeUndefined({
          capability: "page-probe",
          state: "limited",
          source: "event" as const,
          code: safeText(event.d.pageProbe.reason, 120),
          message: "Frame context reported limited page-probe collection.",
          t: event.t,
          offsetMs: finiteNumber(event.offsetMs),
        }),
      );
    }
  }

  const audioState = index.audio?.transcription?.state;
  if (
    audioState === "transcription-unavailable" ||
    audioState === "transcription-error"
  ) {
    add(
      removeUndefined({
        capability: "audio-transcription",
        state: audioState,
        source: "post-process" as const,
        code: safeText(index.audio?.transcription?.code, 120),
        message: safeText(index.audio?.transcription?.message, 240),
        artifact: "transcript.json",
      }),
    );
  }

  if (
    expectsCapability(meta, "video", events, "media.video") &&
    !fs.existsSync(path.join(sessionDir, "recording.webm"))
  ) {
    add({
      capability: "video",
      state: "artifact-missing",
      source: "artifact",
      artifact: "recording.webm",
      message:
        "Video was expected or emitted media.video events, but recording.webm is not present.",
    });
  }

  if (
    expectsCapability(meta, "audio", events, "media.voice") &&
    !fs.existsSync(path.join(sessionDir, "audio.webm"))
  ) {
    add({
      capability: "audio",
      state: "artifact-missing",
      source: "artifact",
      artifact: "audio.webm",
      message:
        "Audio was expected or emitted media.voice events, but audio.webm is not present.",
    });
  }

  return degraded;
}

function expectsCapability(
  meta: Record<string, unknown>,
  capability: string,
  events: BugEvent[],
  eventKind: string,
): boolean {
  if (events.some((event) => event.k === eventKind)) return true;

  if (isRecord(meta.capabilities) && meta.capabilities[capability] === true)
    return true;
  if (isRecord(meta.collection)) {
    const collectionEntry = meta.collection[capability];
    if (isRecord(collectionEntry) && collectionEntry.enabled === true)
      return true;
  }

  return false;
}

export function summarizeRedaction(
  events: BugEvent[],
): LlmBundleRedactionSummary {
  const acc: RedactionAccumulator = {
    eventsWithRedactionEvidence: 0,
    redactedFields: 0,
    payloadSummaries: 0,
    reasons: {},
    actions: {},
  };

  for (const event of events) {
    const beforeFields = acc.redactedFields;
    const beforeSummaries = acc.payloadSummaries;
    collectRedaction(event.d, acc);
    if (
      acc.redactedFields > beforeFields ||
      acc.payloadSummaries > beforeSummaries
    ) {
      acc.eventsWithRedactionEvidence += 1;
    }
  }

  const notes = [
    "Collectors are expected to redact sensitive data in the browser before persistence and attach redaction metadata when fields change.",
    "This bundle sanitizes rendered URLs and does not copy raw request/response bodies, storage values, input values, or transcript text.",
  ];
  if (acc.eventsWithRedactionEvidence === 0) {
    notes.push(
      "No event-level redaction evidence was found; inspect raw files as potentially sensitive despite bundle-level URL sanitization.",
    );
  }

  return {
    policy: BROWSER_REDACTION_POLICY,
    browserFirst: true,
    renderedBundleSanitization: [
      "navigation URLs",
      "failed request URLs",
      "full-stack request URLs and path-like fields",
      "timeline URL-like fields",
      "metadata URL-like fields",
      "token-like prose snippets in errors, media messages, and full-stack summaries",
    ],
    eventsWithRedactionEvidence: acc.eventsWithRedactionEvidence,
    redactedFields: acc.redactedFields,
    payloadSummaries: acc.payloadSummaries,
    reasons: sortRecord(acc.reasons),
    actions: acc.actions,
    notes,
  };
}

function collectRedaction(value: unknown, acc: RedactionAccumulator): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectRedaction(entry, acc);
    return;
  }

  if (!isRecord(value)) return;

  if (isRedactionMetadata(value)) {
    for (const field of value.fields) {
      const reason = safeText(field.reason, 120) ?? "unknown";
      const action = isRedactionAction(field.action)
        ? field.action
        : "redacted";
      acc.redactedFields += 1;
      acc.reasons[reason] = (acc.reasons[reason] ?? 0) + 1;
      acc.actions[action] = (acc.actions[action] ?? 0) + 1;
    }
    const summaries = Array.isArray(value.summaries) ? value.summaries : [];
    for (const summary of summaries) {
      if (isRecord(summary)) collectPayloadSummary(summary, acc);
    }
    return;
  }

  if (isPayloadSummary(value)) {
    collectPayloadSummary(value, acc);
    return;
  }

  for (const entry of Object.values(value)) collectRedaction(entry, acc);
}

function isRedactionMetadata(value: Record<string, unknown>): value is {
  policy: string;
  fields: Array<{ reason?: unknown; action?: unknown }>;
  summaries?: unknown[];
} {
  return (
    (value.policy === BROWSER_REDACTION_POLICY ||
      value.policy === BROWSER_REDACTION_POLICY_V2) &&
    Array.isArray(value.fields)
  );
}

function isPayloadSummary(
  value: Record<string, unknown>,
): value is { reason?: unknown; action?: unknown } {
  return (
    typeof value.kind === "string" &&
    typeof value.action === "string" &&
    typeof value.reason === "string"
  );
}

function collectPayloadSummary(
  value: { reason?: unknown; action?: unknown },
  acc: RedactionAccumulator,
): void {
  const reason = safeText(value.reason, 120) ?? "unknown";
  const action = isRedactionAction(value.action) ? value.action : "summarized";
  acc.payloadSummaries += 1;
  acc.reasons[reason] = (acc.reasons[reason] ?? 0) + 1;
  acc.actions[action] = (acc.actions[action] ?? 0) + 1;
}

function isRedactionAction(value: unknown): value is RedactionAction {
  return value === "redacted" || value === "dropped" || value === "summarized";
}

function buildLimitations(
  artifacts: LlmBundleArtifact[],
  events: BugEvent[],
  redaction: LlmBundleRedactionSummary,
  degradedCapabilities: LlmBundleDegradedCapability[],
  index: SessionIndexLike,
  meta: Record<string, unknown>,
  browserEvidence: LlmBundleBrowserEvidence,
  fullStackEvidence: LlmBundleFullStackEvidence,
): string[] {
  const limitations = new Set<string>();
  const artifact = (relativePath: string): LlmBundleArtifact | undefined =>
    artifacts.find((entry) => entry.path === relativePath);

  limitations.add(
    "This bundle is an inspection guide, not a replay UI; align raw media manually using the offset rules.",
  );

  if (events.length === 0 || index.evts === 0) {
    limitations.add(
      "No events were available during post-processing; events.ndjson is missing or empty.",
    );
  }

  if (
    expectsCapability(meta, "video", events, "media.video") &&
    artifact("recording.webm")?.exists !== true
  ) {
    limitations.add(
      "recording.webm is missing, so active-tab video cannot be inspected for this session.",
    );
  }

  if (
    expectsCapability(meta, "audio", events, "media.voice") &&
    artifact("audio.webm")?.exists !== true
  ) {
    limitations.add(
      "audio.webm is missing, so continuous microphone audio cannot be inspected for this session.",
    );
  }

  if (
    index.audio?.transcription?.state &&
    index.audio.transcription.state !== "transcription-ready"
  ) {
    limitations.add(
      `Audio transcription state is ${index.audio.transcription.state}; use audio.webm and media.voice markers for alignment.`,
    );
  }

  if (redaction.eventsWithRedactionEvidence === 0) {
    limitations.add(
      "No per-event redaction metadata was found in the event stream. Treat raw files as potentially sensitive.",
    );
  }

  for (const limitation of browserEvidence.pageProbe.limitations) {
    limitations.add(limitation);
  }

  if (browserEvidence.networkErrors.length > 0) {
    limitations.add(
      `${browserEvidence.networkErrors.length} network request error(s) occurred before an HTTP response was captured.`,
    );
  }

  if (browserEvidence.tabBoundaries.nonCaptureCount > 0) {
    limitations.add(
      `${browserEvidence.tabBoundaries.nonCaptureCount} tab-boundary decision(s) intentionally marked non-capture; outside-boundary pages were not silently recorded.`,
    );
  }

  for (const limitation of fullStackEvidence.limitations) {
    limitations.add(limitation);
  }

  for (const degraded of degradedCapabilities) {
    limitations.add(
      `${degraded.capability} is ${degraded.state}${degraded.code ? ` (${degraded.code})` : ""}.`,
    );
  }

  return Array.from(limitations);
}

function buildInspectionGuide(
  artifacts: LlmBundleArtifact[],
): LlmBundle["inspectionGuide"] {
  const exists = (relativePath: string): boolean =>
    artifacts.some(
      (artifact) => artifact.path === relativePath && artifact.exists,
    );
  const guide = [
    {
      step: 1,
      path: "CANDIDATES.md",
      purpose:
        "Start here for the deterministic ranked issue list and links to focused evidence windows.",
    },
    {
      step: 2,
      path: "search.jsonl",
      purpose:
        "Grep normalized, redacted candidate-linked evidence rows without opening raw payloads.",
    },
    {
      step: 3,
      path: "timeline.md",
      purpose: "Use five-minute buckets to orient inside long recordings.",
    },
    {
      step: 4,
      path: "llm.md",
      purpose:
        "Read the human-readable session map, media alignment rules, limitations, and redaction notes.",
    },
    {
      step: 5,
      path: "llm.json",
      purpose:
        "Use this machine-readable summary for automated triage or query planning.",
    },
    {
      step: 6,
      path: "index.json",
      purpose:
        "Inspect post-processed counts, errors, failed requests, navigation, storage summary, tab boundaries, and audio state.",
    },
    {
      step: 7,
      path: "events.ndjson",
      purpose:
        "Read raw chronological evidence only after candidate artifacts; one JSON event per line and potentially sensitive.",
    },
  ];

  if (exists("recording.webm")) {
    guide.push({
      step: guide.length + 1,
      path: "recording.webm",
      purpose:
        "Open around offsets called out in keyTimelineMoments to inspect the active-tab video.",
    });
  }
  if (exists("audio.webm")) {
    guide.push({
      step: guide.length + 1,
      path: "audio.webm",
      purpose:
        "Open around media.voice offsets and transcript event offsets to inspect continuous audio.",
    });
  }
  if (exists("transcript.json")) {
    guide.push({
      step: guide.length + 1,
      path: "transcript.json",
      purpose:
        "Inspect speech-to-text output; transcript text is intentionally not copied into llm.md.",
    });
  }

  return guide;
}

export function renderLlmMarkdown(bundle: LlmBundle): string {
  const lines = [
    `# Crumbtrail session ${bundle.session.id}`,
    "",
    "Agent-first inspection bundle generated by local post-processing.",
    "",
    "## Session",
    "",
    `- Session directory: \`${bundle.sessionDir}\``,
    `- Name: ${bundle.session.name ?? "not provided"}`,
    `- Source: ${bundle.session.source ?? "not provided"}`,
    `- App: ${bundle.session.app ?? "not provided"}`,
    `- Start: ${bundle.session.startIso ?? bundle.session.startMs}`,
    `- End: ${bundle.session.endIso ?? bundle.session.endMs}`,
    `- Duration: ${bundle.session.durationMs} ms`,
    // B5 latency mirror: present only when the bundle carries the self-measured fields.
    ...(bundle.detectToBundleMs !== undefined
      ? [`- Detect→bundle latency: ${bundle.detectToBundleMs} ms`]
      : []),
    "",
    ...renderEnvironmentSection(bundle.environment),
    "## Artifact Map",
    "",
    table(
      ["Path", "Role", "Status", "Description"],
      bundle.artifacts.map((artifact) => [
        `\`${artifact.path}\``,
        artifact.role,
        artifact.exists
          ? `present${artifact.bytes !== undefined ? ` (${artifact.bytes} bytes)` : artifact.entries !== undefined ? ` (${artifact.entries} entries)` : ""}`
          : "missing",
        artifact.description,
      ]),
    ),
    "",
    "## Event Counts",
    "",
    table(
      ["Kind", "Count"],
      Object.entries(bundle.eventCounts).map(([kind, count]) => [
        kind,
        String(count),
      ]),
    ),
    "",
    "## Browser Evidence Summary",
    "",
    `- Page probe: ${bundle.browserEvidence.pageProbe.requested ? "requested" : "not requested"}; ready events: ${bundle.browserEvidence.pageProbe.readyEvents}; errors: ${bundle.browserEvidence.pageProbe.errorEvents}; limited frame contexts: ${bundle.browserEvidence.pageProbe.limitedContexts}`,
    `- Failed requests: ${bundle.browserEvidence.failedRequests.length}`,
    `- Network request errors: ${bundle.browserEvidence.networkErrors.length}`,
    `- Console errors: ${bundle.browserEvidence.consoleErrors.length}`,
    `- Tab boundary decisions: ${bundle.browserEvidence.tabBoundaries.total}; non-capture decisions: ${bundle.browserEvidence.tabBoundaries.nonCaptureCount}`,
    "",
    ...(bundle.browserEvidence.failedRequests.length > 0
      ? [
          "### Failed Requests",
          "",
          table(
            [
              "Offset",
              "Method",
              "Status",
              "Reason",
              "Code",
              "URL",
              "Request body",
              "Response body",
            ],
            bundle.browserEvidence.failedRequests
              .slice(0, 10)
              .map((req) => [
                req.offsetMs !== undefined ? `${req.offsetMs} ms` : "unknown",
                req.method ?? "",
                req.status !== undefined ? String(req.status) : "",
                req.reason ?? "",
                req.code ?? req.message ?? "",
                req.url ?? "",
                req.requestBody ?? "",
                req.responseBody ?? "",
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.browserEvidence.precedingRequests.length > 0
      ? [
          "### Requests That Succeeded Just Before The Failure",
          "",
          "None of these failed. They are what the page asked for and got back in the seconds before the first error, because a correct-looking response carrying the wrong value is a defect no failure list can report.",
          "",
          table(
            [
              "Before error",
              "Method",
              "Status",
              "URL",
              "Request body",
              "Response body",
            ],
            bundle.browserEvidence.precedingRequests.map((req) => [
              req.beforeErrorMs !== undefined
                ? `${req.beforeErrorMs} ms`
                : "unknown",
              req.method ?? "",
              req.status !== undefined ? String(req.status) : "",
              req.url ?? "",
              req.requestBody ?? "",
              req.responseBody ?? "",
            ]),
          ),
          "",
        ]
      : []),
    "## Agent Context Timeline",
    "",
    `- Schema: ${bundle.agentContext.schemaVersion}`,
    ...(bundle.agentContext.timeline.length > 0
      ? [
          "",
          table(
            ["Offset", "Kind", "Summary"],
            bundle.agentContext.timeline
              .slice(0, 40)
              .map((entry) => [
                entry.offsetMs !== undefined
                  ? `${entry.offsetMs} ms`
                  : "unknown",
                entry.kind,
                entry.summary,
              ]),
          ),
        ]
      : [
          "",
          "_No navigation, error, failed request, or interaction events captured._",
        ]),
    "",
    ...(bundle.browserEvidence.networkErrors.length > 0
      ? [
          "### Network Errors",
          "",
          table(
            ["Offset", "Method", "Transport", "URL", "Message", "Request body"],
            bundle.browserEvidence.networkErrors
              .slice(0, 10)
              .map((entry) => [
                entry.offsetMs !== undefined
                  ? `${entry.offsetMs} ms`
                  : "unknown",
                entry.method ?? "",
                entry.transport ?? "",
                entry.url ?? "",
                entry.message ?? "",
                entry.requestBody ?? "",
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.browserEvidence.consoleErrors.length > 0
      ? [
          "### Console Errors",
          "",
          table(
            ["Offset", "Level", "Message", "Source"],
            bundle.browserEvidence.consoleErrors
              .slice(0, 10)
              .map((entry) => [
                entry.offsetMs !== undefined
                  ? `${entry.offsetMs} ms`
                  : "unknown",
                entry.level,
                entry.message,
                entry.source ?? "",
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.browserEvidence.screenNumbers.length > 0
      ? [
          "### On-screen Numbers",
          "",
          "What the page displayed, by label. A label carrying more than one value is listed first: the same label reading two different numbers is usually the defect rather than a step towards it.",
          "",
          table(
            ["Label", "Values", "Where"],
            bundle.browserEvidence.screenNumbers
              .slice(0, 25)
              .map((entry) => [
                entry.label,
                entry.values
                  .map(
                    (seen) =>
                      `${entry.unit ?? ""}${seen.value}${seen.offsetMs !== undefined ? ` (${seen.offsetMs} ms)` : ""}`,
                  )
                  .join(", "),
                entry.regions.join(", "),
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.browserEvidence.tabBoundaries.total > 0
      ? [
          "### Tab Boundary Decisions",
          "",
          table(
            [
              "Offset",
              "Decision",
              "Reason",
              "Root",
              "Current",
              "Candidate",
              "Prompt",
              "Capture",
            ],
            bundle.browserEvidence.tabBoundaries.decisions
              .slice(0, 10)
              .map((entry) => [
                entry.offsetMs !== undefined
                  ? `${entry.offsetMs} ms`
                  : "unknown",
                entry.decision ?? "",
                entry.reason ?? "",
                formatBoundaryLocation(entry.root),
                formatBoundaryLocation(entry.current),
                formatBoundaryLocation(entry.candidate),
                [entry.prompt?.outcome, entry.prompt?.origin]
                  .filter(Boolean)
                  .join(" "),
                entry.capture === true
                  ? "yes"
                  : entry.nonCapture === true || entry.capture === false
                    ? "no"
                    : "unknown",
              ]),
          ),
          "",
        ]
      : []),
    "## Full-Stack Request Evidence",
    "",
    `- Frontend requests: ${bundle.fullStackEvidence.summary.frontendRequests}`,
    `- Backend requests: ${bundle.fullStackEvidence.summary.backendRequests}`,
    `- Linked request moments: ${bundle.fullStackEvidence.summary.linked}`,
    `- Partial-linkage gaps: ${bundle.fullStackEvidence.summary.gaps}`,
    ...(Object.keys(bundle.fullStackEvidence.summary.gapTypes).length > 0
      ? [
          `- Gap types: ${Object.entries(
            bundle.fullStackEvidence.summary.gapTypes,
          )
            .map(([type, count]) => `${type}: ${count}`)
            .join(", ")}`,
        ]
      : []),
    ...(bundle.fullStackEvidence.summary.gaps > 0
      ? [
          "- Guidance: do not assume every frontend request has backend evidence when gaps exist; inspect index.json/events.ndjson for raw chronology only as needed.",
        ]
      : []),
    "",
    ...(bundle.fullStackEvidence.linked.length > 0
      ? [
          "### Linked Request Moments",
          "",
          table(
            [
              "Offset",
              "Request ID",
              "Session ID",
              "Frontend",
              "Backend",
              "Status",
            ],
            selectLinkedForRendering(
              bundle.fullStackEvidence.linked,
              MAX_RENDERED_PAYLOADS,
            )
              .map((entry) => [
                entry.frontend.ref?.offsetMs !== undefined
                  ? `${entry.frontend.ref.offsetMs} ms`
                  : entry.backend.start?.offsetMs !== undefined
                    ? `${entry.backend.start.offsetMs} ms`
                    : "unknown",
                entry.requestId,
                entry.sessionId,
                summarizeFrontendRequestForMarkdown(entry.frontend),
                summarizeBackendRequestForMarkdown(entry.backend),
                entry.frontend.status !== undefined ||
                entry.backend.statusCode !== undefined
                  ? [entry.frontend.status, entry.backend.statusCode]
                      .filter((status) => status !== undefined)
                      .join(" / ")
                  : "",
              ]),
          ),
          "",
          ...renderLinkedPayloads(bundle.fullStackEvidence.linked),
        ]
      : []),
    ...(bundle.fullStackEvidence.gaps.length > 0
      ? [
          "### Partial-Linkage Gaps",
          "",
          table(
            ["Type", "Request ID", "Session ID", "Frontend", "Backend"],
            bundle.fullStackEvidence.gaps
              .slice(0, 10)
              .map((entry) => [
                entry.type,
                entry.requestId ??
                  entry.frontend?.requestId ??
                  entry.backend?.requestId ??
                  "",
                entry.sessionId ??
                  entry.frontend?.sessionId ??
                  entry.backend?.sessionId ??
                  "",
                entry.frontend
                  ? summarizeFrontendRequestForMarkdown(entry.frontend)
                  : "",
                entry.backend
                  ? summarizeBackendRequestForMarkdown(entry.backend)
                  : "",
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.fullStackEvidence.limitations.length > 0
      ? [
          ...bundle.fullStackEvidence.limitations.map((entry) => `- ${entry}`),
          "",
        ]
      : []),
    ...renderOutboundCallsSection(bundle.outboundCalls),
    ...renderDatabaseErrorSection(bundle.databaseErrors ?? []),
    // What was ASKED, before what came back: the two statement planes sit together, and a reader
    // who can see the predicate does not have to infer it from the rows it selected.
    ...renderDatabaseStatementSection(bundle.databaseStatements ?? []),
    ...renderDatabaseDiffSection(bundle.databaseDiffs),
    ...renderDatabaseReadSection(bundle.databaseReads ?? []),
    ...renderDatabaseActivitySection(bundle.databaseActivity),
    ...renderDetectedSignalsSection(
      bundle.distinctBugs,
      bundle.detectorPrevalence,
    ),
    ...renderCausalStructureSection(bundle.causalTree),
    "## Key Timeline Moments",
    "",
    table(
      ["Offset", "Time", "Kind", "Summary"],
      bundle.keyTimelineMoments.map((moment) => [
        moment.offsetMs !== undefined ? `${moment.offsetMs} ms` : "unknown",
        moment.iso ?? String(moment.t),
        moment.k,
        moment.summary,
      ]),
    ),
    "",
    "## Media Alignment Rules",
    "",
    ...bundle.media.alignment.rules.map((rule) => `- ${rule}`),
    "",
    `- Video: ${bundle.media.video.exists ? `\`${bundle.media.video.path}\`` : "missing"}; events: ${bundle.media.video.eventCount}; last state: ${bundle.media.video.lastState ?? "unknown"}`,
    `- Audio: ${bundle.media.audio.exists ? `\`${bundle.media.audio.path}\`` : "missing"}; events: ${bundle.media.audio.eventCount}; last state: ${bundle.media.audio.lastState ?? "unknown"}`,
    `- Transcript: ${bundle.media.transcript.exists ? `\`${bundle.media.transcript.path}\`` : "missing"}; tx events: ${bundle.media.transcript.eventCount}`,
    "",
    "## Degraded Capabilities and Limitations",
    "",
    ...(bundle.limitations.length > 0
      ? bundle.limitations.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    "## Redaction Summary",
    "",
    `- Policy: \`${bundle.redaction.policy}\``,
    `- Events with redaction evidence: ${bundle.redaction.eventsWithRedactionEvidence}`,
    `- Redacted fields: ${bundle.redaction.redactedFields}`,
    `- Payload summaries: ${bundle.redaction.payloadSummaries}`,
    `- Bundle sanitizes: ${bundle.redaction.renderedBundleSanitization.join(", ")}`,
    "",
    ...(Object.keys(bundle.redaction.reasons).length > 0
      ? [
          table(
            ["Reason", "Count"],
            Object.entries(bundle.redaction.reasons).map(([reason, count]) => [
              reason,
              String(count),
            ]),
          ),
          "",
        ]
      : []),
    ...bundle.redaction.notes.map((note) => `- ${note}`),
    "",
    "## How to Inspect Raw Files",
    "",
    ...bundle.inspectionGuide.map(
      (step) => `${step.step}. \`${step.path}\` — ${step.purpose}`,
    ),
    "",
    "Raw artifacts may contain user workflow data. Prefer this summary and `index.json` first, then inspect raw files only as needed.",
    "",
  ];

  return lines.join("\n");
}

function renderEnvironmentSection(
  environment: LlmBundleEnvironment | null,
): string[] {
  if (!environment) return [];
  const lines = ["## Environment", ""];
  if (environment.userAgent)
    lines.push(`- User agent: ${environment.userAgent}`);
  if (environment.browser)
    lines.push(
      `- Browser: ${environment.browser.name}${environment.browser.version ? ` ${environment.browser.version}` : ""}`,
    );
  if (environment.os) lines.push(`- OS: ${environment.os}`);
  if (environment.viewport)
    lines.push(
      `- Viewport: ${environment.viewport.w}x${environment.viewport.h}`,
    );
  if (environment.locale) lines.push(`- Locale: ${environment.locale}`);
  if (environment.timezone) lines.push(`- Timezone: ${environment.timezone}`);
  if (environment.appBuild)
    lines.push(`- Release build: ${environment.appBuild}`);
  if (environment.referrer) lines.push(`- Referrer: ${environment.referrer}`);
  if (environment.campaign)
    lines.push(
      `- Campaign: ${Object.entries(environment.campaign)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
    );
  if (environment.device) {
    const { dpr, screen, orientation } = environment.device;
    const parts: string[] = [];
    if (screen) parts.push(`${screen.w}x${screen.h}`);
    if (dpr !== undefined) parts.push(`dpr ${dpr}`);
    if (orientation) parts.push(orientation);
    if (parts.length > 0) lines.push(`- Device: ${parts.join(", ")}`);
  }
  if (environment.connection) {
    const { effectiveType, downlink, rtt, saveData } = environment.connection;
    const parts: string[] = [];
    if (effectiveType) parts.push(effectiveType);
    if (downlink !== undefined) parts.push(`${downlink} Mbps`);
    if (rtt !== undefined) parts.push(`${rtt} ms rtt`);
    if (saveData !== undefined) parts.push(`saveData ${saveData}`);
    if (parts.length > 0) lines.push(`- Connection: ${parts.join(", ")}`);
  }
  if (environment.deviceMemory !== undefined)
    lines.push(`- Device memory: ${environment.deviceMemory} GB`);
  if (environment.hardwareConcurrency !== undefined)
    lines.push(`- CPU cores: ${environment.hardwareConcurrency}`);
  if (environment.flags)
    lines.push(
      `- Feature flags: ${Object.keys(environment.flags).sort().join(", ") || "none"} (values redacted in browser before capture)`,
    );
  if (environment.config)
    lines.push(
      `- Config keys: ${Object.keys(environment.config).sort().join(", ") || "none"} (values redacted in browser before capture)`,
    );
  if (environment.flagVariants)
    lines.push(
      `- Flag variants: ${Object.entries(environment.flagVariants)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([flag, variant]) => `${flag}=${variant}`)
        .join(", ")}`,
    );
  if (environment.flagChanges && environment.flagChanges.length > 0) {
    // One line per move, in order. A summary line naming the changed flags would re-lose the
    // on-then-off case the ordered history exists to keep.
    lines.push(
      "- Flags changed during session (values redacted in browser before capture):",
    );
    for (const change of environment.flagChanges) {
      lines.push(
        `  - ${formatFlagChangeTime(change)} ${change.flag}: ${formatFlagSide(change.from)} -> ${formatFlagSide(change.to)}`,
      );
    }
  }
  lines.push("");
  return lines;
}

/** `+1240ms` when the session start is known, otherwise the event's ISO stamp or raw epoch. */
function formatFlagChangeTime(change: LlmBundleFlagChange): string {
  if (change.offsetMs !== undefined) return `+${change.offsetMs}ms`;
  return change.iso ?? String(change.t);
}

/**
 * One side of a flag move as a short literal. `absent` rather than an empty string, because
 * "the flag did not exist" and "the flag was the empty string" are different findings.
 */
function formatFlagSide(side: LlmBundleFlagValue | undefined): string {
  if (side === undefined) return "absent";
  let rendered: string;
  try {
    rendered = JSON.stringify(side.value) ?? String(side.value);
  } catch {
    rendered = String(side.value);
  }
  if (rendered.length > 120) rendered = `${rendered.slice(0, 117)}...`;
  return side.variant === undefined
    ? rendered
    : `${rendered} (variant ${side.variant})`;
}

/** `insertReview server/src/repos/reviews-repo.js:5 < handler server/src/routes/reviews.js:41` */
function formatCallsiteChain(
  callsite: LlmBundleDbCallsite | undefined,
): string {
  if (!callsite) return "";
  const frames = [callsite, ...(callsite.stack ?? [])];
  return frames
    .map((frame) => {
      const at = frame.line === undefined ? frame.file : `${frame.file}:${frame.line}`;
      return frame.fn ? `${frame.fn} ${at}` : at;
    })
    .join(" < ");
}

/**
 * The rows that actually changed, which the markdown had no section for at all
 * — only OTel statement spans, which say a query ran but never what it wrote.
 *
 * The callsite column is the point of the table. A diff says a row changed; the
 * chain says which line changed it, innermost frame first, so a reader working
 * a ticket goes straight to the handler instead of grepping for the table name.
 */
/** How many distinct read rows the markdown renders. Everything is in `bundle.json` regardless. */
const MAX_RENDERED_DB_READS = 40;
/** Rows per table, so one wide read cannot spend every slot. */
const MAX_RENDERED_DB_READS_PER_TABLE = 5;

/**
 * Rows the session READ.
 *
 * `databaseReads` has been built, redacted and written to `bundle.json` all along, and the markdown
 * the reader is actually handed never printed a single one of them - the same shape of failure as
 * the response bodies before them: captured, present, unrendered.
 *
 * The section exists because rendering only rows that CHANGED encodes the assumption that a defect
 * is something the application did. A large class of defect is something it read: a promotion whose
 * validity window is stored back to front so no instant can fall inside it, a flag off for one
 * account, a price row in the wrong currency. Every request succeeds, nothing is written, and the
 * answer is a row the session already has. Measured on the promo-code case, where the captured
 * coupon row carries `valid_from` 2026-07-19 against `valid_until` 2026-07-18 - the entire defect,
 * in a row the bundle held and did not show.
 *
 * Deduplicated on table plus row content, so a page that reads the same product twenty times costs
 * one line, while a row whose VALUE changed between two reads is kept as two - that difference is
 * evidence in its own right.
 *
 * Then capped PER TABLE rather than globally. A catalogue read returns forty product rows and a
 * coupon lookup returns one, so a flat cap spends every slot on the catalogue and drops the single
 * row the session turned on. Breadth of tables first, depth within a table second: the reader learns
 * which tables the request consulted, and gets a sample of each.
 */
export function renderDatabaseReadSection(reads: LlmBundleDbRead[]): string[] {
  if (reads.length === 0) return [];

  const seen = new Set<string>();
  const perTable = new Map<string, LlmBundleDbRead[]>();
  for (const read of reads) {
    const key = `${read.table}\u0000${JSON.stringify(read.row)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = perTable.get(read.table) ?? [];
    rows.push(read);
    perTable.set(read.table, rows);
  }

  const shown = [...perTable.values()]
    .flatMap((rows) => rows.slice(0, MAX_RENDERED_DB_READS_PER_TABLE))
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_RENDERED_DB_READS);
  const deduped = seen.size;

  const lines = [
    "## Database Rows Read",
    "",
    "Rows this session's requests read, deduplicated and correlated to the request that read them. A request that answers 200 and writes nothing can still be answering out of a row that is wrong, so read these as the data the application acted on rather than as data it produced.",
    "",
    table(
      ["Offset", "Table", "Key", "Row", "Request ID"],
      shown.map((read) => [
        read.offsetMs !== undefined ? `${read.offsetMs} ms` : "unknown",
        read.table,
        read.pk ? JSON.stringify(read.pk) : "",
        truncate(JSON.stringify(read.row), 300),
        read.requestId ?? "",
      ]),
    ),
    "",
  ];
  if (deduped > shown.length) {
    lines.push(
      `${deduped - shown.length} further distinct row(s) are in \`bundle.json\` under \`databaseReads\`.`,
      "",
    );
  }
  return lines;
}

/** How many distinct statement shapes the markdown renders. All are in `bundle.json` regardless. */
const MAX_RENDERED_DB_STATEMENTS = 40;

/**
 * Statements the database ACCEPTED.
 *
 * Every other database section describes a statement by its RESULT: rows that changed, rows that
 * came back, spans a collector saw. That can only ever answer "what did the database hold", and a
 * large class of defect is in the QUESTION — a predicate whose boolean grouping binds the wrong
 * way, a filter that was dropped, a join that widened, a lookup keyed on the wrong column. Those
 * queries execute perfectly. They return rows that look right, or no rows at all, and until this
 * section existed the bundle recorded a successful request with nothing wrong in it.
 *
 * The zero-row case is why this is a section and not a column on the rows-read table: a SELECT
 * that matches nothing emits no row, so it appeared in no plane whatsoever. `Rows` of `0` here is
 * the difference between "the lookup missed" and "the lookup never happened".
 *
 * Deduplicated on request plus shape, so a statement that ran in a loop costs one line and carries
 * its own repeat count — which is itself the evidence in a fan-out.
 *
 * What is deliberately NOT here: bind values. `shape` is the statement with every literal
 * replaced, the same contract the failed-statement section keeps, and it is not relaxed because
 * the statement worked.
 */
function renderDatabaseStatementSection(
  statements: LlmBundleDbStatement[],
): string[] {
  if (statements.length === 0) return [];

  const grouped = new Map<
    string,
    { statement: LlmBundleDbStatement; runs: number; rows: number | null }
  >();
  for (const statement of statements) {
    const key = `${statement.requestId ?? ""}\u0000${statement.shape}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { statement, runs: 1, rows: statement.rowCount });
      continue;
    }
    existing.runs += 1;
    if (typeof statement.rowCount === "number") {
      existing.rows = (existing.rows ?? 0) + statement.rowCount;
    }
  }

  const shown = [...grouped.values()]
    .sort((a, b) => a.statement.t - b.statement.t)
    .slice(0, MAX_RENDERED_DB_STATEMENTS);

  const lines = [
    "## Database Statements That Ran",
    "",
    "What this session's requests ASKED the database, correlated to the request that asked it. Read these against the rows above: a statement that succeeded and returned the wrong rows — or no rows — is indistinguishable from a correct one until the predicate itself is visible. `Rows` of 0 means the statement matched nothing, which is evidence rather than absence. Bind values are deliberately not carried; every literal is replaced.",
    "",
    table(
      ["Offset", "Op", "Table", "Rows", "Runs", "Statement shape", "Request ID"],
      shown.map((entry) => [
        entry.statement.offsetMs !== undefined
          ? `${entry.statement.offsetMs} ms`
          : "unknown",
        entry.statement.op,
        entry.statement.table ?? "",
        entry.rows === null ? "unknown" : String(entry.rows),
        String(entry.runs),
        truncate(entry.statement.shape, 300),
        entry.statement.requestId ?? "",
      ]),
    ),
    "",
  ];
  if (grouped.size > shown.length) {
    lines.push(
      `${grouped.size - shown.length} further distinct statement(s) are in \`bundle.json\` under \`databaseStatements\`.`,
      "",
    );
  }
  return lines;
}

/** How many failed statements the markdown renders. Everything is in `bundle.json` regardless. */
const MAX_RENDERED_DB_ERRORS = 25;

/**
 * Statements the database REFUSED.
 *
 * This section exists because every other database section in this file can only describe
 * statements that SUCCEEDED. When a statement raised, the adapter's `await` rejected with it and
 * nothing was emitted at all — so an incident whose fault IS the failing statement rendered as a
 * request with no database evidence, and the reader had to infer the most decisive fact in the
 * session from its absence. Worse than absent, it was confidently incomplete: a request that ran
 * two statements and lost one showed the surviving one and said nothing about the other.
 *
 * It is rendered BEFORE row changes deliberately. A reader who sees that the write was rejected,
 * with the code the database returned, does not need to reason about the rows that did change.
 *
 * What is deliberately NOT here: bind values and the driver's error message. `shape` is the
 * statement with every literal replaced, and `code`/`errorName` are a closed-vocabulary code and a
 * class name. That is enough to find the statement in the repository and to know why it failed,
 * and it is the SDK's standing stance on error text everywhere else.
 */
function renderDatabaseErrorSection(errors: LlmBundleDbError[]): string[] {
  if (errors.length === 0) return [];
  const shown = errors.slice(0, MAX_RENDERED_DB_ERRORS);
  const lines = [
    "## Database Statements That Failed",
    "",
    "Statements this session issued that the database refused, correlated to the request that issued them. These are the application's own failures, not gaps in capture: each one ran and was rejected. Bind values and driver messages are deliberately not carried — the statement shape, the table and the database's own error code are what identify it.",
    "",
    table(
      ["Offset", "Op", "Table", "Error code", "Error class", "Statement shape", "Request ID"],
      shown.map((error) => [
        error.offsetMs !== undefined ? `${error.offsetMs} ms` : "unknown",
        error.op,
        error.table ?? "",
        error.code ?? "",
        error.errorName,
        truncate(error.shape, 300),
        error.requestId ?? "",
      ]),
    ),
    "",
  ];
  if (errors.length > shown.length) {
    lines.push(
      `${errors.length - shown.length} further failed statement(s) are in \`bundle.json\` under \`databaseErrors\`.`,
      "",
    );
  }
  return lines;
}

function renderDatabaseDiffSection(diffs: LlmBundleDbDiff[]): string[] {
  if (diffs.length === 0) return [];
  const shown = diffs.slice(0, 25);
  const hasCallsites = shown.some((diff) => diff.callsite);
  const lines = [
    "## Database Row Changes",
    "",
    "Before and after images for the rows this session wrote, correlated to the request that caused them.",
    "",
    table(
      [
        "Offset",
        "Op",
        "Table",
        "Key",
        "After",
        ...(hasCallsites ? ["Issued from"] : []),
        "Request ID",
      ],
      shown.map((diff) => [
        diff.offsetMs !== undefined ? `${diff.offsetMs} ms` : "unknown",
        diff.op,
        diff.table,
        diff.pk ? JSON.stringify(diff.pk) : "unresolved",
        diff.after ? truncate(JSON.stringify(diff.after), 300) : "",
        ...(hasCallsites ? [formatCallsiteChain(diff.callsite)] : []),
        diff.requestId ?? "",
      ]),
    ),
    "",
  ];
  if (diffs.length > shown.length) {
    lines.push(
      `${diffs.length - shown.length} further row change(s) are in \`bundle.json\` under \`databaseDiffs\`.`,
      "",
    );
  }
  if (!hasCallsites) {
    lines.push(
      "No callsites captured. Run the server SDK with `captureCallsite` to record which line issued each write.",
      "",
    );
  }
  return lines;
}

function renderDatabaseActivitySection(
  activity: LlmBundleDbActivity[],
): string[] {
  if (activity.length === 0) return [];
  return [
    "## Database Activity Statements",
    "",
    "OTel DB spans report statements and operations only; they are not before/after row diffs.",
    "",
    table(
      ["Offset", "System", "Operation", "Statement", "Request ID"],
      activity
        .slice(0, 20)
        .map((entry) => [
          entry.offsetMs !== undefined ? `${entry.offsetMs} ms` : "unknown",
          entry.system ?? "",
          entry.operation ?? "",
          entry.statement ?? entry.spanName ?? "",
          entry.requestId ?? "",
        ]),
    ),
    "",
    ...activity.slice(0, 3).map((entry) => `- ${entry.upgradeHint}`),
    "",
  ];
}

/**
 * Renders the deterministic root → symptom causal tree as ONE bounded section, inserted at a fixed
 * position (right after Full-Stack Request Evidence). Empty array → no section. Ordering mirrors
 * {@link buildCausalTree}: roots in ranked order, symptoms in each root's `causes` order.
 */
function renderCausalStructureSection(
  causalTree: LlmBundleCausalRoot[] | undefined,
): string[] {
  if (!causalTree || causalTree.length === 0) return [];
  const lines = ["## Causal Structure", ""];
  lines.push(
    "Root causes with the downstream symptoms attributed to them (deterministic; from detector signal causal fields).",
  );
  lines.push("");
  for (const root of causalTree) {
    lines.push(`- Root: ${root.id} · ${root.detector} — ${root.title}`);
    for (const symptom of root.symptoms) {
      const conf = symptom.attributionConfidence
        ? ` (attribution ${symptom.attributionConfidence})`
        : "";
      lines.push(
        `  - Symptom: ${symptom.id} · ${symptom.detector} — ${symptom.title}${conf}`,
      );
    }
  }
  lines.push("");
  return lines;
}

/** A bound on rendered outbound calls; the rest stay in `bundle.json`. */
const MAX_RENDERED_OUTBOUND_CALLS = 20;

/**
 * What the server called outward.
 *
 * `fullStackEvidence` pairs a browser request with the server handler that answered it and stops
 * there. The leg BEYOND that handler — the payment gateway, the pricing service, the webhook — was
 * captured as `backend.http` and rendered nowhere, so a bundle could hold a successful charge
 * against a gateway and a sibling service that never answered, and show a reader neither.
 *
 * That is the whole subject of a large class of defect: the third party said yes and the callback
 * never came, or the call failed and the application carried on as though it had not. Both are
 * invisible in the request/response pair, because the request succeeded.
 *
 * The application's own fields ride in `detail` rather than being dropped to a status code. A row
 * reading "POST 200" proves reachability; "payments charge succeeded, ch_0001" is the evidence.
 */
function renderOutboundCallsSection(
  calls: LlmBundleOutboundCall[] | undefined,
): string[] {
  if (!calls || calls.length === 0) return [];
  const shown = calls.slice(0, MAX_RENDERED_OUTBOUND_CALLS);
  const lines = [
    "## Outbound Service Calls",
    "",
    "Calls the server made outward, to a third party or a sibling service, correlated to the "
      + "inbound request that issued them. A call that SUCCEEDED is as much evidence as one that "
      + "failed: a gateway that accepted a charge and a callback that never arrived look identical "
      + "in the request that started them. Read `status: 0` as no response at all rather than a "
      + "zero-valued one.",
    "",
    table(
      ["Offset", "Service", "Operation", "Call", "Result", "Detail", "Request ID"],
      shown.map((call) => [
        call.offsetMs !== undefined ? `${call.offsetMs} ms` : "unknown",
        call.service ?? "",
        call.operation ?? "",
        [call.method, call.url].filter(Boolean).join(" ") || "",
        call.error
          ? `failed: ${call.error}`
          : [
              call.status !== undefined ? String(call.status) : "",
              call.durationMs !== undefined ? `${call.durationMs} ms` : "",
            ]
              .filter(Boolean)
              .join("; "),
        call.detail ? truncate(JSON.stringify(call.detail), 300) : "",
        call.requestId ?? "",
      ]),
    ),
    "",
  ];
  if (calls.length > shown.length) {
    lines.push(
      `${calls.length - shown.length} further outbound call(s) are in \`bundle.json\` under \`outboundCalls\`.`,
      "",
    );
  }
  return lines;
}

/**
 * A bound, not a ranking. `distinctBugs` arrives severity-ordered, and a session that produced more
 * than this many separate findings is one where the top of the list is what a reader can act on.
 */
const MAX_RENDERED_SIGNALS = 12;

/**
 * What the detectors found.
 *
 * The detectors run, group into distinct bugs, and land in `bundle.json` — and until now nothing
 * put them in the rendered bundle, so a reader with `llm.md` and nothing else never saw them. Only
 * the causal tree made it through, and that shows a finding solely when it is a ROOT with symptoms
 * attributed to it. A session whose findings are unrelated to each other renders no tree at all,
 * and every one of them is silently dropped.
 *
 * Measured on one capture: five findings computed, one rendered. The one that named the defect —
 * a click received by a full-viewport element covering the button beneath it — was among the four
 * discarded, while the reader was left inferring from a 401 on an unrelated endpoint.
 *
 * These are signals, not verdicts, and the wording says so: a detector reports a measurement, and
 * whether it explains the reported symptom is the reader's call. Understating that would trade one
 * failure mode for a worse one, since a confident wrong lead is more expensive than no lead.
 */
function renderDetectedSignalsSection(
  bugs: DistinctBug[] | undefined,
  prevalence: LlmBundleDetectorPrevalence | undefined,
): string[] {
  if (!bugs || bugs.length === 0) return [];
  const shown = bugs.slice(0, MAX_RENDERED_SIGNALS);
  // Whether ANY row of THIS bundle carries a base-rate measurement. A property of the data being
  // rendered, computed from the same cell function the table uses, so the column, its cells and
  // the paragraph that teaches it can never disagree about whether the measurement exists.
  const baseRateCells = shown.map((bug) => detectorBaseRateCell(bug, prevalence));
  const baseRateMeasured = baseRateCells.some((cell) => cell !== "");
  const lines = [
    "## Detected Signals",
    "",
    "What the detectors measured in this session, most severe first. Each is a measurement, not a "
      + "verdict: a signal can be a pre-existing condition unrelated to the reported symptom, and the "
      + "reported symptom can have no signal at all. Read them as leads to confirm against the "
      + "evidence above, and treat the absence of a signal as no evidence either way.",
    "",
    "`Support` is how much of THIS session's evidence stands behind the finding, which severity "
      + "cannot say: `corroborated` and `attached` mean the signal was connected to the rest of the "
      + "session, `unattached` means the tooling measured it but could not connect it to anything "
      + "here — so it may be a pre-existing condition rather than the cause of the reported symptom, "
      + "and it is not ranked any lower for it — and `not-assessed` means no causal attribution ran, "
      + "so the question was never asked.",
    "",
    // The grade stays whole — three states, no variants — and the reason sits BESIDE it. All three
    // causes mean the same thing for how far to trust a headline, which is why they must not fork
    // the grade; but they mean very different things for what to do next, which is why a reader
    // who is shown only the grade is under-informed. `no-node-family` and `no-compatible-node` say
    // the session held nothing of the kind this signal could attach to; `lost-contention` says it
    // DID, and another finding took it — an absence of connection, not an absence of evidence.
    "`Why unattached` is the reason the tooling could not connect an `unattached` finding: "
      + "`no-node-family` means this kind of signal has nothing in the session it could attach to, "
      + "`no-compatible-node` means there was nothing close enough in time or request to attach it "
      + "to, and `lost-contention` means there WAS — and another finding, named in the cell, holds "
      + "it instead. A blank cell is not a finding about the row: it means the question does not "
      + "arise, because the signal was connected or attribution never ran.",
    "",
    // The grade above says how well this signal connected to THIS session. It cannot say whether
    // the signal is peculiar to this session at all, and connectedness is exactly what a permanent
    // background condition has the most of — so the reassuring grade lands on the application's
    // wallpaper every time, at the top of the page, where it is read as the headline. The only
    // thing that separates the two is a fact about the OTHER sessions, which is why it arrives
    // here as its own disclosure rather than as an adjustment to anything above it.
    //
    // Emitted only when some row of THIS bundle actually carries the measurement. A bundle with no
    // prevalence at all renders every cell of the column blank, and teaching a reader how to weigh
    // a grade this bundle holds no value of spends their context on nothing — the lesson and the
    // measurement travel together or neither is emitted. When one row is measured this is
    // byte-identical to what shipped before the condition existed.
    ...(baseRateMeasured
      ? [
        "`Base rate` is how many of the sessions already recorded for this application, other than "
          + "this one, the same detector fired in. It answers what no grade above it can: whether the "
          + "finding is peculiar to this incident or a standing condition of the application. A "
          + "detector that fires in most sessions was firing before the reported symptom existed, "
          + "however severe it is and however well it is attached here, and a headline taken from one "
          + "is a lead pointing at the background. A blank cell means the value is UNKNOWN, not low: "
          + "too few sessions are recorded yet to say anything, which is where every application "
          + "starts. Read a low count as \"rarely seen in what has been recorded\" — the store knows "
          + "only the sessions it holds, so it is never proof that a finding is new. Nothing here "
          + "moves a row: the table is ordered exactly as it would be without this column."
          // Appended ONLY when the scan was capped, and the paragraph above is byte-identical when it
          // was not. The sentence above says the denominator is the sessions recorded for this
          // application; under a cap that is false, and a truthful cell under a false paragraph is
          // still a fabricated number. The count and its denominator travel together — so the
          // denominator's MEANING has to travel with them too.
          + (prevalence?.truncated === true
            ? " This store holds more sessions than one bundle is allowed to read, so the counts "
              + `above were measured over the ${prevalence.priorSessions} MOST RECENT prior sessions `
              + "only, chosen by their recorded date. The denominator names exactly what was read: "
              + "nothing here says anything about the older sessions, in either direction."
            : ""),
          "",
        ]
      : []),
    table(
      [
        "Offset",
        "Severity",
        "Detector",
        "Support",
        "Why unattached",
        ...(baseRateMeasured ? ["Base rate"] : []),
        "Finding",
        "Where",
      ],
      shown.map((bug, at) => [
        bug.window?.start !== undefined && bug.firstSeen !== undefined
          ? `${bug.firstSeen - bug.window.start} ms`
          : "unknown",
        bug.severity,
        bug.representative.detector,
        // Absent when the candidate predates the grade (an artifact written by an older SDK). That
        // reads the same way to the reader as a session nothing was attributed for: nobody told
        // them. It must never silently render as if the signal had been placed.
        bug.representative.support ?? "not-assessed",
        // Empty on every row where the question does not arise — which is most of them. Absence
        // renders as nothing rather than as a placeholder word: `none` or `n/a` in this cell would
        // read as an assertion about a row that was never isolated at all.
        isolationReasonCell(bug),
        // Empty on the rows this bundle holds no measurement for. Absence renders as nothing,
        // never as a zero or a percentage, because a default state that reads as an assertion is
        // worse than a silence — and when EVERY row is empty the column is gone entirely, on the
        // same condition as its header above and its paragraph before it, so a reader is never
        // shown a column of blanks with a lesson attached. One measured row keeps all three.
        ...(baseRateMeasured ? [baseRateCells[at]] : []),
        // Title AND message. A detector puts the specifics in whichever of the two it has — the
        // click detector names the covered control in its title and carries no message at all, so
        // preferring one over the other drops the part that identifies the defect.
        truncate(
          [
            bug.title,
            bug.representative.message && bug.representative.message !== bug.title
              ? bug.representative.message
              : undefined,
          ]
            .filter((part): part is string => Boolean(part))
            .join(" — "),
          400,
        ),
        bug.representative.frame
          ?? bug.representative.requestId
          ?? bug.representative.route
          ?? "",
      ]),
    ),
    "",
  ];
  if (bugs.length > shown.length) {
    lines.push(
      `${bugs.length - shown.length} further signal(s) are in \`bundle.json\` under \`distinctBugs\`.`,
      "",
    );
  }
  return lines;
}

/**
 * Narrow a whole-store measurement down to the detectors this session actually produced.
 *
 * `undefined` in, `undefined` out — a session rendered without a corpus, or in a store too small
 * to say anything yet, carries no field at all rather than a field full of zeros. Those two states
 * mean opposite things and a zero would report the wrong one.
 *
 * Detector order follows `distinctBugs`, so the projection introduces no ordering of its own.
 */
function projectDetectorPrevalence(
  bugs: DistinctBug[],
  prevalence: DetectorPrevalence | undefined,
): LlmBundleDetectorPrevalence | undefined {
  if (!prevalence) return undefined;
  const detectors: LlmBundleDetectorPrevalence["detectors"] = [];
  const seen = new Set<string>();
  for (const bug of bugs) {
    const detector = bug.representative.detector;
    if (!detector || seen.has(detector)) continue;
    seen.add(detector);
    detectors.push({
      detector,
      priorSessionsFiredIn: prevalence.firedIn[detector] ?? 0,
    });
  }
  return {
    priorSessions: prevalence.priorSessions,
    ...(prevalence.truncated === true ? { truncated: true } : {}),
    detectors,
  };
}

/**
 * The `Base rate` cell for one signal row.
 *
 * A count with its denominator, never a bare percentage: `3 of 47 prior sessions` can be argued
 * with, and `6%` cannot. Blank whenever the bundle carries no measurement, which is every session
 * in a store too new to have priors — and blank is the whole point. A cell reading `0%` or `first
 * occurrence` on a store nobody could measure would be an assertion manufactured out of an
 * absence, and this project has already paid once for a number that could not tell "we looked and
 * found nothing" from "we never looked".
 *
 * A measured zero, by contrast, IS printed: `0 of 47 prior sessions` is something the store
 * actually observed, and the difference between that and a blank cell is the difference between a
 * measurement and a missing one.
 *
 * When the scan was capped the cell names the SCANNED set and nothing else — `3 of 200 most recent
 * prior sessions`. It never names the store's size, because the scan did not look at the rest of
 * the store, and a denominator that quietly stands for sessions nobody read is the same fabricated
 * number this cell exists to avoid, wearing a bigger figure.
 */
function detectorBaseRateCell(
  bug: DistinctBug,
  prevalence: LlmBundleDetectorPrevalence | undefined,
): string {
  if (!prevalence) return "";
  const entry = prevalence.detectors.find(
    (row) => row.detector === bug.representative.detector,
  );
  if (!entry) return "";
  const scope = prevalence.truncated === true ? "most recent prior" : "prior";
  return `${entry.priorSessionsFiredIn} of ${prevalence.priorSessions} ${scope} sessions`;
}

/**
 * The `Why unattached` cell for one signal row.
 *
 * Keyed from the cluster REPRESENTATIVE, which is where the row's title, detector and support
 * already come from, while its severity is a cluster MAX. A reason taken from the best- or
 * worst-placed member would describe a different finding than the one the row names — this
 * codebase has paid for keying a reader-facing string on the wrong member of a group before.
 *
 * `lost-contention` names the holder, because "another finding took the node" is only actionable
 * if the reader can go and look at that finding. `${id} · ${detector}` matches how the Causal
 * Structure section of this same document refers to a candidate.
 */
function isolationReasonCell(bug: DistinctBug): string {
  const cause = bug.representative.isolationCause;
  if (!cause) return "";
  const holder = bug.representative.isolationHeldBy;
  return holder
    ? `${cause} — held by ${holder.candidateId} · ${holder.detector}`
    : cause;
}

/** How many linked requests may contribute a payload block, matching the table above it. */
const MAX_RENDERED_PAYLOADS = 10;

/**
 * Which linked requests get rendered, when there are more than the cap allows.
 *
 * The cap used to be `.slice(0, 10)` — the first ten, chronologically. A session opens with a burst
 * of page-load GETs, so those ten were always the boot sequence, and the request the user's action
 * produced was always past the cut. Measured: on the promo-code case, four readers out of four
 * asked for "the checkout request and response showing what discount the server computed" — a
 * request the session had captured, linked, and then declined to print, while printing ten reads of
 * the product list.
 *
 * Selection instead of truncation. A request that CHANGED something, or that failed, is kept
 * unconditionally; the remaining slots go to the most recent of the rest, because a defect is
 * noticed after it happens and the requests nearest the end are the ones nearest the report. Output
 * stays in chronological order either way, so a reader still gets a sequence rather than a ranking.
 */
export function selectLinkedForRendering(
  linked: LlmBundleLinkedFullStackRequestSummary[],
  limit: number,
): LlmBundleLinkedFullStackRequestSummary[] {
  if (linked.length <= limit) return linked;

  const timeOf = (entry: LlmBundleLinkedFullStackRequestSummary): number =>
    entry.frontend.ref?.offsetMs ?? entry.backend.start?.offsetMs ?? 0;
  const decisive = (entry: LlmBundleLinkedFullStackRequestSummary): boolean => {
    const method = (entry.frontend.method ?? "").toUpperCase();
    if (method && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return true;
    const status = entry.frontend.status ?? entry.backend.statusCode;
    return status !== undefined && status >= 400;
  };

  const kept = linked.filter(decisive).slice(-limit);
  const remaining = limit - kept.length;
  const filler =
    remaining > 0
      ? linked.filter((entry) => !kept.includes(entry)).slice(-remaining)
      : [];
  return [...kept, ...filler].sort((a, b) => timeOf(a) - timeOf(b));
}



/**
 * The payloads of the linked requests, as blocks under the table.
 *
 * ============================================================================
 * WHY THIS WAS THE LARGEST GAP IN THE BUNDLE
 * ============================================================================
 *
 * `Linked Request Moments` renders a request's SHAPE — method, path, timing, status — and stopped
 * there. Bodies were already captured, already redacted, and already present on these very entries
 * in `llm.json`; the markdown simply never printed them. Everything in the bundle that did carry a
 * body was failure-shaped (`LlmBundleFailedRequestSummary`, `LlmBundleNetworkErrorSummary`), which
 * encodes an assumption that does not survive contact with real defects: that a bug announces
 * itself with an error.
 *
 * Most correctness bugs are a 200 with the wrong value in it. A gift-card balance reading the
 * issuance amount instead of the current one is a 200. A search filter excluding a row at exactly
 * the boundary is a 200. In both, the request line is unremarkable and the answer is entirely in
 * the body.
 *
 * Measured, over 108 bundle-only reads of 36 sessions: 74% ended `insufficient`, and when each
 * reader was asked to name the ONE observation that would have settled it, three of the four
 * failing scenarios asked for a response body — four times out of four in the gift-card case,
 * naming the exact request that was already printed in the table one line above.
 *
 * Bounded to the same ten entries the table shows and printed only when a body exists, so a
 * session of shape-only requests renders exactly as before.
 */
function renderLinkedPayloads(
  linked: LlmBundleLinkedFullStackRequestSummary[],
): string[] {
  const withBodies = selectLinkedForRendering(linked, MAX_RENDERED_PAYLOADS)
    .filter(
      (entry) =>
        entry.frontend.requestBody !== undefined ||
        entry.frontend.responseBody !== undefined ||
        entry.backend.responseBody !== undefined ||
        entry.backend.responseCallsite !== undefined,
    );
  if (withBodies.length === 0) return [];

  const lines = [
    "#### Linked Request Payloads",
    "",
    "Redacted and bounded. A request whose status is 200 can still carry the defect in its body. A response can also be correct code reading wrong data, so treat a code location as where a value was produced rather than as the reason it was wrong.",
    "",
  ];
  for (const entry of withBodies) {
    const offset = entry.frontend.ref?.offsetMs;
    const heading = [
      entry.frontend.method,
      entry.frontend.url,
      entry.frontend.status !== undefined ? `— ${entry.frontend.status}` : undefined,
      offset !== undefined ? `(${offset} ms)` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`- **${heading}**`);
    if (entry.frontend.requestBody !== undefined) {
      lines.push(`  - request: \`${entry.frontend.requestBody}\``);
    }
    if (entry.frontend.responseBody !== undefined) {
      lines.push(`  - response: \`${entry.frontend.responseBody}\``);
    }
    // What the SERVER built, and where. The browser's copy has been through the network and the
    // client's own parsing; the server's is what the handler decided, and the callsite says which
    // line decided it. Both were already captured and neither was printed - measured, readers asked
    // for "the backend checkout response" and "the calculation trace" of a request the table above
    // already listed.
    if (
      entry.backend.responseBody !== undefined &&
      entry.backend.responseBody !== entry.frontend.responseBody
    ) {
      lines.push(`  - server response: \`${entry.backend.responseBody}\``);
    }
    if (entry.backend.responseCallsite !== undefined) {
      // The qualifier is load-bearing, and it is here because the unqualified line cost accuracy.
      // Measured across 126 bundle-only reads: printing the server response and this callsite
      // together took wrong answers from 7 to 17, concentrated in the two scenarios whose truth is
      // DATA rather than code. A reader handed a file and a line number names that line as the
      // cause. It is not one; it is where the answer was written, which is a different claim.
      lines.push(
        `  - response written at: \`${formatCallsiteChain(entry.backend.responseCallsite)}\` (where this response was produced, which is not by itself the cause)`,
      );
    }
  }
  lines.push("");
  return lines;
}

function summarizeFrontendRequestForMarkdown(
  frontend: LlmBundleFrontendRequestEvidenceSummary,
): string {
  return joinParts([
    frontend.method,
    frontend.url,
    describeGraphqlOperation(frontend.gql),
    frontend.durationMs !== undefined ? `${frontend.durationMs} ms` : undefined,
    frontend.error?.transport,
    frontend.error?.message,
  ]);
}

/** `mutation UpdateCart`, `query (2 in batch)`, or nothing at all. */
function describeGraphqlOperation(
  gql: LlmBundleFrontendRequestEvidenceSummary["gql"],
): string | undefined {
  if (!gql) return undefined;
  const batch = gql.batch !== undefined ? ` (${gql.batch} in batch)` : "";
  return `${gql.op}${gql.name ? ` ${gql.name}` : ""}${batch}`;
}

function summarizeBackendRequestForMarkdown(
  backend: LlmBundleBackendRequestEvidenceSummary,
): string {
  return joinParts([
    backend.method,
    backend.url ?? backend.pathname ?? backend.route,
    backend.durationMs !== undefined ? `${backend.durationMs} ms` : undefined,
    backend.correlation?.status,
    backend.error?.code ?? backend.error?.message,
  ]);
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function copySafeString(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = safeText(source[key], 180);
  if (value !== undefined) out[key] = value;
}

function copySafeUrl(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = safeUrl(source[key], `metadata.${key}`);
  if (value !== undefined) out[key] = value;
}

function copySafeNumber(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = finiteNumber(source[key]);
  if (value !== undefined) out[key] = value;
}

function sanitizeBooleanRecord(
  value: unknown,
): Record<string, boolean> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function safeUrl(value: unknown, _fieldPath: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return truncate(redactUrlLikeString(trimmed).replace(/\s+/g, " "), 240);
}

function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function safeHost(value: unknown): string | undefined {
  const text = safeText(value, 253)?.toLowerCase();
  if (!text || /[/\\?#@\s]/.test(text) || !/^[a-z0-9.:-]+$/.test(text))
    return undefined;
  return text;
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return undefined;
  return truncate(redactTokenLikeText(trimmed), maxLength);
}

// The only correlation identifiers that can bypass token redaction are formats that
// Crumbtrail itself mints plus the W3C identifiers it explicitly adopts. This must
// stay deliberately narrow: arbitrary URL-safe strings include API keys and JWTs.
const W3C_TRACE_ID_RE = /^[0-9a-f]{32}$/;
const W3C_SPAN_ID_RE = /^[0-9a-f]{16}$/;
const W3C_TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const CRUMBTRAIL_REQUEST_ID_RE = /^req_[a-z0-9]+_[a-z0-9]{12}$/;
const BACKEND_REQUEST_ID_RE = /^backend_req_[a-z0-9]+_[a-z0-9]{8}$/;
const CRUMBTRAIL_SESSION_ID_RE = /^ses_\d{8}_\d{6}_[0-9a-f]{12}$/;
const AWS_ACCESS_KEY_RE = /^(?:AKIA|ASIA)[0-9A-Z]{16}$/;
const TOKEN_PREFIX_RE = /^(?:sk|pk)_[A-Za-z0-9_-]{8,}$/;
const BEARER_TOKEN_RE = /^bearer\s+\S+$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LONG_OPAQUE_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{33,}$/;

function isSafeCorrelationId(value: string): boolean {
  return (
    W3C_TRACE_ID_RE.test(value) ||
    W3C_SPAN_ID_RE.test(value) ||
    W3C_TRACEPARENT_RE.test(value) ||
    CRUMBTRAIL_REQUEST_ID_RE.test(value) ||
    BACKEND_REQUEST_ID_RE.test(value) ||
    CRUMBTRAIL_SESSION_ID_RE.test(value)
  );
}

/**
 * Like {@link safeText} but does NOT run token-like redaction.
 *
 * Correlation ids that Crumbtrail mints or explicitly adopts are emitted verbatim. A
 * W3C trace id is exactly 32 lowercase hex and would otherwise be scrubbed by the
 * MD5/SHA shaped redaction rule, silently breaking front end to back end correlation in
 * the LLM bundle. Everything else uses normal token redaction before it can rest here.
 */
function safeCorrelationId(
  value: unknown,
  maxLength = 128,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (isSafeCorrelationId(trimmed)) return truncate(trimmed, maxLength);
  if (
    AWS_ACCESS_KEY_RE.test(trimmed) ||
    TOKEN_PREFIX_RE.test(trimmed) ||
    BEARER_TOKEN_RE.test(trimmed) ||
    JWT_RE.test(trimmed) ||
    LONG_OPAQUE_TOKEN_RE.test(trimmed)
  ) {
    return REDACTED_VALUE;
  }
  return safeText(trimmed, maxLength);
}

function redactUrlLikeString(value: string): string {
  const withNoHash = dropUrlHash(value);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(withNoHash);

  if (hasScheme) {
    try {
      const parsed = new URL(withNoHash);
      parsed.username = "";
      parsed.password = "";
      redactSearchParams(parsed.searchParams);
      return redactTokenLikeText(unescapeRedactionMarker(parsed.toString()));
    } catch {
      return redactRelativeUrlLikeString(withNoHash);
    }
  }

  return redactRelativeUrlLikeString(withNoHash);
}

function redactRelativeUrlLikeString(value: string): string {
  const queryIndex = value.indexOf("?");
  if (queryIndex < 0) return redactTokenLikeText(value);

  const base = value.slice(0, queryIndex);
  const query = value.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  redactSearchParams(params);
  const serialized = unescapeRedactionMarker(params.toString());
  return redactTokenLikeText(`${base}${serialized ? `?${serialized}` : ""}`);
}

function redactSearchParams(params: URLSearchParams): void {
  for (const key of Array.from(params.keys())) {
    const values = params.getAll(key);
    params.delete(key);
    for (const value of values) {
      params.append(key, value === "" ? "" : REDACTED_VALUE);
    }
  }
}

function dropUrlHash(value: string): string {
  const hashIndex = value.indexOf("#");
  return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
}

function redactTokenLikeText(value: string): string {
  return redactTokenLikeString(value).value;
}

function stringArray(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => safeText(entry, maxLength))
    .filter((entry): entry is string => entry !== undefined);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function offsetFromStart(t: number, startMs: number): number | undefined {
  if (!Number.isFinite(t) || !Number.isFinite(startMs) || startMs === 0)
    return undefined;
  return Math.max(0, t - startMs);
}

function iso(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  return value.length <= maxLength
    ? value
    : `${value.slice(0, truncateEnd(value, maxLength - 1))}…`;
}

function truncateEnd(value: string, maxLength: number): number {
  const end = Math.max(0, maxLength);
  const lastCodeUnit = value.charCodeAt(end - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? end - 1 : end;
}

function joinParts(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("; ");
}

function formatBoundaryLocation(
  value: LlmBundleTabBoundaryLocationSummary | undefined,
): string {
  if (!value) return "";
  return value.origin ?? value.host ?? value.scheme ?? "";
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_None._";
  return [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isPageWorldUntrustedEvent(event: BugEvent): boolean {
  return isPageWorldUntrustedRecord(event.d);
}

function isPageWorldUntrustedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.source === "page-probe" ||
      value.evidenceTrust === "page-world-untrusted")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
