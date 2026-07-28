import fs from "node:fs";
import path from "node:path";
import {
  redactTokenLikeString,
  redactUrl as redactCoreUrl,
  type BrowserRedactionPolicy,
  type BugEvent,
  type TargetDescriptor,
} from "crumbtrail-core";
import { BROWSER_REDACTION_POLICY, normalizeDbEngine } from "./llm-bundle";
import { redactedNetworkBodySnippet } from "./network-body";
import {
  attributeCandidates,
  namesFailureOnGenericPlane,
} from "./causal-graph";
import { defaultSessionStore } from "./session-store";
import type { CausalConfidence, CausalGraph } from "./causal-graph";
import {
  directorySourceMapLookup,
  resolveFrame,
  type SourceMap,
} from "./source-map";

export const CANDIDATE_SCHEMA_VERSION = 1 as const;
const MAX_EVIDENCE_CANDIDATES = 200;

/**
 * Tunable constants for confidence-gated causal re-ranking (CP3).
 *  - MAP_WINDOW_MS: temporal window for candidate→node fallback mapping (mirrors CAUSAL_MAP_WINDOW_MS
 *    in causal-graph.ts; 2s matches the graph's own edge WINDOW_MS so a symptom that got a graph edge
 *    is reliably mappable).
 *  - MAX_BLAST_BOOST: hard cap on how much a root's *ranking* score can rise from its symptom cluster,
 *    so a root with many symptoms cannot leapfrog an unrelated higher-severity issue by an unbounded
 *    amount. 12 keeps a boosted 90-score backend root under a 100+ hypothetical while comfortably
 *    clearing the 58/82 FE-symptom scores it must outrank.
 *  - BLAST_PER_SYMPTOM: per-symptom contribution before weighting; 2 × severity weight.
 *  - SEVERITY_WEIGHT: keyed to the EvidenceCandidate severity enum ('critical'|'high'|'medium'|'low').
 */
export const CAUSAL_RANK_CONSTANTS = {
  MAP_WINDOW_MS: 2000,
  MAX_BLAST_BOOST: 12,
  BLAST_PER_SYMPTOM: 2,
  SEVERITY_WEIGHT: { critical: 4, high: 3, medium: 2, low: 1 },
} as const;

/**
 * Heuristic denylist of third-party analytics / advertising beacon host patterns. A "Failed to
 * fetch" (or network error) whose target host matches one of these is almost never the user facing
 * bug: it is a tracking or ads beacon blocked by the browser's tracking prevention or an ad blocker.
 * Such failures are downranked and their severity reduced (never suppressed) so they cannot drown a
 * genuine first-party failure.
 *
 * This list is intentionally non-exhaustive and safe to extend. Matching is case-insensitive and
 * host-suffix based, so subdomains (for example `www.google-analytics.com`) are covered. A pattern
 * containing a `/` is matched against `host + pathname` so collector paths on otherwise generic
 * hosts (for example `google.com/g/collect`) can be flagged without denylisting the whole host.
 */
export const TRACKER_BEACON_HOST_PATTERNS: readonly string[] = [
  // Google analytics / tag manager / ads
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "googletagservices.com",
  "googlesyndication.com",
  "pagead2.googlesyndication.com",
  "doubleclick.net",
  "stats.g.doubleclick.net",
  "adservice.google.com",
  "google.com/g/collect",
  "google.com/pagead",
  "google.com/ads",
  // Meta / Facebook
  "connect.facebook.net",
  "graph.facebook.com",
  "facebook.com/tr",
  // Product analytics / session replay
  "hotjar.com",
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "cdn.mxpnl.com",
  "amplitude.com",
  "cdn.amplitude.com",
  "fullstory.com",
  "clarity.ms",
  "quantserve.com",
  "scorecardresearch.com",
];

// Correlation window: a fetch-level rejection fired within this many ms of a blocked beacon request
// is treated as that beacon's downstream rejection. Kept tight so we only fold in the beacon's own
// unhandled rejection, not an unrelated failure that merely happened nearby.
const TRACKER_BEACON_CORRELATION_MS = 2_000;

// Ceiling score applied to a confirmed tracker-beacon failure. Low enough to sit beneath a
// first-party 4xx (70) while staying above pure-noise signals, so it is reordered, not hidden.
const TRACKER_BEACON_SCORE = 15;

// Ceiling score applied to a 4xx the application deliberately returned. Sits below a first-party
// console warning (50) so a real defect that only warns still outranks a whole session of expected
// rejections, and above tracker-beacon noise (15) because an expected rejection is at least
// first-party behavior worth reading. Demoted, never dropped: "login 401s for every user" has to
// stay findable.
const HANDLED_CLIENT_ERROR_SCORE = 30;

// 4xx statuses that are an authentication or authorization challenge. Answering one is how the
// protocol works — an unauthenticated visitor polling /api/me gets a 401 on every page load — so
// these need no body evidence to count as deliberate. Deliberately excludes 408/429: a timeout or a
// throttle is a real operational signal, and only a structured body demotes those.
const AUTH_CHALLENGE_STATUSES = new Set([401, 403]);

// Keys whose presence in a JSON response body proves a handler chose this outcome and named it,
// rather than something failing its way into a 4xx. `type` + `title` covers RFC 9457 problem
// details. A bare `message` is not enough: unhandled framework errors serialize that way too.
const STRUCTURED_ERROR_KEYS = ["error", "errors", "code"] as const;

// Fetch-level rejection detectors that carry no url of their own, so they must be correlated to a
// nearby blocked beacon request to be recognised as beacon noise.
const FETCH_REJECTION_DETECTORS = new Set([
  "unhandled_rejection",
  "uncaught_error",
]);

// Messages that indicate a bare network/fetch failure (the shape a blocked beacon produces). Used
// only to gate the nearby-beacon correlation, never on its own.
const FETCH_FAILURE_MESSAGE_PATTERN =
  /failed to fetch|networkerror|load failed|fetch failed|err_(?:blocked|failed|network)|net::err|blocked by client/i;

export interface EvidenceIndexInput {
  sessionDir: string;
  events: BugEvent[];
  index: {
    id?: string;
    start?: number;
    end?: number;
    dur?: number;
    failedReqs?: Array<{
      t: number;
      m?: string;
      url?: string;
      st?: number;
      id?: string | number;
      reason?: string;
      code?: string;
      message?: string;
      phase?: string;
    }>;
    networkErrors?: Array<{
      t: number;
      offsetMs?: number;
      id?: string | number;
      method?: string;
      m?: string;
      url?: string;
      msg?: string;
      transport?: string;
    }>;
    consoleErrors?: Array<{
      t: number;
      offsetMs?: number;
      lv?: string;
      msg?: string;
      source?: string;
      /** Stack synthesized by the console collector. See post-process.ts. */
      stk?: string;
    }>;
    errs?: Array<{
      t: number;
      msg?: string;
      requestId?: string | number;
      method?: string;
      url?: string;
      file?: string;
      line?: number;
      col?: number;
      stk?: string;
    }>;
    navs?: Array<{ t: number; to?: string }>;
    tabBoundaries?: Array<{
      t: number;
      offsetMs?: number;
      decision?: string;
      reason?: string;
      nonCapture?: boolean;
      capture?: boolean;
      root?: unknown;
      current?: unknown;
      candidate?: unknown;
      prompt?: unknown;
    }>;
    pageProbe?: {
      errors?: Array<{
        t: number;
        offsetMs?: number;
        phase?: string;
        message?: string;
        source?: string;
      }>;
    };
  };
  /**
   * Optional causal graph (index.causalGraph) used ONLY to re-rank candidates so a downstream
   * symptom cannot outrank its backend root. Treated as read-only; absence → today's behavior.
   */
  causalGraph?: CausalGraph;
}

export interface EvidenceCandidate {
  schemaVersion: typeof CANDIDATE_SCHEMA_VERSION;
  id: string;
  detector: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  score: number;
  confidence: "high" | "medium" | "low";
  /**
   * How many drafts collapsed into this candidate, set only when more than one
   * did. Four rejected sign-in attempts and one are the same defect but not the
   * same event, and a grouped signal that dropped the count would read as a
   * single incident.
   */
  occurrences?: number;
  anchor: {
    t: number;
    offsetMs?: number;
    route?: string;
    elementLabel?: string;
    requestId?: string;
    method?: string;
    url?: string;
    status?: number;
    errorCode?: string;
    message?: string;
    /**
     * Free-form provenance label: where this signal came from, not where the
     * code is. Values include "backend", a transport name, a probe phase. Do
     * NOT read this as a code location; use `frame`.
     */
    source?: string;
    /**
     * Column names a row-identity comparison rested on, sorted. Set by the
     * database detectors that claim two rows are the same, so a reader can see
     * what was compared instead of taking the claim on faith.
     */
    comparedColumns?: string[];
    /**
     * The after image the compared rows shared, restricted to
     * {@link EvidenceCandidate.anchor.comparedColumns}. Already redacted and
     * size-bounded at capture time; re-scrubbed here before it is re-shipped.
     */
    sharedAfterImage?: Record<string, unknown>;
    /**
     * Source location of the failing code as `file:line:col`, when one was
     * captured. Resolved through the build's source map when a map is
     * available, so this names a file in the repository rather than a bundler
     * chunk; see `minifiedFrame` for what the runtime originally reported.
     */
    frame?: string;
    /**
     * The generated location `frame` was resolved FROM, set only when source
     * map resolution actually replaced it. Kept so a reader can verify the
     * mapping rather than trust it, and so a wrong map is detectable instead of
     * silently sending someone to the wrong file.
     */
    minifiedFrame?: string;
    target?: TargetDescriptor;
  };
  /** Causal role assigned by the confidence-gated re-rank (CP3). Additive/optional. */
  causalRole?: "root" | "symptom" | "isolated";
  /** For a symptom, the candidate id of its attributed root cause. */
  rootCauseId?: string;
  /** For a root, the sorted candidate ids of the symptoms attributed to it. */
  causes?: string[];
  /** Weakest edge confidence along the causal path from root to this symptom. */
  attributionConfidence?: CausalConfidence;
  evidenceWindow: { start: number; end: number; windowId: string };
}

interface CandidateDraft extends Omit<
  EvidenceCandidate,
  "schemaVersion" | "id" | "evidenceWindow"
> {
  wideWindow?: boolean;
  dedupeKey: string;
  causalRole?: "root" | "symptom" | "isolated";
  rootCauseId?: string;
  causes?: string[];
  attributionConfidence?: CausalConfidence;
}

interface RequestInfo {
  id: string;
  t: number;
  offsetMs?: number;
  method?: string;
  url?: string;
  route?: string;
}

// Every artifact here goes through the SessionStore seam rather than fs directly:
// these are finalize-time cold-plane files, and an embedder that decorates the
// store (the hosted cloud's at-rest envelope encryption) must see them, or they
// stay plaintext on the volume while the rest of the session is sealed.
/**
 * Rewrites every candidate's `frame` to the original source location, keeping
 * the generated one as `minifiedFrame`.
 *
 * Config gated on `CRUMBTRAIL_SOURCEMAP_DIR`, a directory of build output
 * holding the `.map` files. Off by default: without it this is a no-op and the
 * generated frame stands, which is the honest result rather than a silent
 * half-resolution.
 *
 * Failure is always "leave the frame alone". A frame pointed at the wrong file
 * is worse than a frame a reader knows is minified, so an unreadable, corrupt
 * or non-covering map changes nothing.
 */
function resolveCandidateFrames(
  candidates: EvidenceCandidate[],
): EvidenceCandidate[] {
  const dir = process.env.CRUMBTRAIL_SOURCEMAP_DIR?.trim();
  if (!dir) return candidates;
  if (!candidates.some((candidate) => candidate.anchor.frame)) {
    return candidates;
  }

  const lookup = directorySourceMapLookup(dir);
  // Shared across candidates: a session's failures usually sit in a handful of
  // chunks, and parsing a production map is the expensive part.
  const cache = new Map<string, SourceMap | undefined>();

  return candidates.map((candidate) => {
    const frame = candidate.anchor.frame;
    if (!frame) return candidate;
    const resolved = resolveFrame(frame, lookup, cache);
    if (!resolved || resolved === frame) return candidate;
    return {
      ...candidate,
      anchor: { ...candidate.anchor, frame: resolved, minifiedFrame: frame },
    };
  });
}

export async function writeEvidenceIndex(
  input: EvidenceIndexInput,
): Promise<EvidenceCandidate[]> {
  const events = normalizeEvidenceEvents(input.events);
  const index = withNavigationContext(events, input.index);
  const candidates = resolveCandidateFrames(
    buildEvidenceCandidates(events, index, input.causalGraph),
  );
  const normalizedInput = { ...input, index };
  const windowsDir = path.join(input.sessionDir, "windows");
  fs.rmSync(windowsDir, { recursive: true, force: true });
  fs.mkdirSync(windowsDir, { recursive: true });

  await defaultSessionStore.writeArtifact(
    input.sessionDir,
    "CANDIDATES.md",
    renderCandidatesMarkdown(candidates, normalizedInput),
  );
  await defaultSessionStore.writeArtifact(
    input.sessionDir,
    "candidates.jsonl",
    renderCandidatesJsonl(candidates),
  );
  await defaultSessionStore.writeArtifact(
    input.sessionDir,
    "timeline.md",
    renderTimelineMarkdown(events, index),
  );
  await defaultSessionStore.writeArtifact(
    input.sessionDir,
    "search.jsonl",
    renderSearchJsonl(events, candidates, index),
  );

  for (const candidate of candidates) {
    await defaultSessionStore.writeArtifact(
      input.sessionDir,
      `windows/${candidate.id}.md`,
      renderWindowMarkdown(candidate, events, index),
    );
  }

  return candidates;
}

function normalizeEvidenceEvents(events: BugEvent[]): BugEvent[] {
  return events.flatMap((event) => {
    const t = finiteSafeTimestamp(event.t);
    const k =
      typeof event.k === "string" && event.k.length > 0 ? event.k : undefined;
    if (t === undefined || k === undefined) return [];
    return [{ ...event, t, k, d: isRecord(event.d) ? event.d : {} }];
  });
}

export function buildEvidenceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  causalGraph?: CausalGraph,
): EvidenceCandidate[] {
  index = withNavigationContext(events, index);
  const requestById = collectRequests(events);
  const responseIds = new Set<string>();
  const drafts: CandidateDraft[] = [];

  for (const event of events) {
    if (event.k === "net.res") responseIds.add(String(event.d.id ?? ""));
  }

  for (const failed of index.failedReqs ?? []) {
    // Network-level failures (no HTTP response) are counted in failedReqs but
    // already surface as network_error candidates via index.networkErrors —
    // an "HTTP 0" candidate here would double-count the same failure.
    if (failed.reason === "network_error") continue;
    const response = responseForFailedRequest(events, failed);
    const reqId = requestIdForEvent(response);
    const req = reqId ? requestById.get(reqId) : undefined;
    const detector =
      failed.reason === "application_failure"
        ? "app_2xx_failure"
        : "http_error";
    drafts.push({
      detector,
      title:
        failed.reason === "application_failure"
          ? `Application failure in ${failed.m || req?.method || "request"} ${titleUrl(failed.url || req?.url || "") ?? "unknown URL"}`
          : `HTTP ${failed.st ?? "error"} from ${failed.m || req?.method || "request"} ${titleUrl(failed.url || req?.url || "") ?? "unknown URL"}`,
      severity:
        failed.reason === "application_failure" || (failed.st ?? 0) >= 500
          ? "high"
          : "medium",
      score:
        failed.reason === "application_failure"
          ? 95
          : (failed.st ?? 0) >= 500
            ? 90
            : 70,
      confidence: "high",
      anchor: removeUndefined({
        t: failed.t,
        offsetMs:
          offsetForEvent(response) ?? offsetFromStart(failed.t, index.start),
        route: routeAt(index.navs ?? [], failed.t),
        requestId: reqId,
        method: failed.m || req?.method,
        url: redactUrl(failed.url || req?.url),
        status: failed.st,
        errorCode: scrubText(failed.code, 160),
        message: scrubText(failed.message, 220),
        source: failed.reason,
      }),
      dedupeKey: `failed:${reqId ?? failed.t}:${failed.reason ?? ""}:${failed.st ?? ""}:${failed.code ?? ""}`,
    });
  }

  for (const entry of index.networkErrors ?? []) {
    const requestId = requestIdForValue(entry);
    drafts.push({
      detector: "network_error",
      title: `Network error from ${entry.method || entry.m || "request"} ${titleUrl(entry.url || "") ?? "unknown URL"}`,
      severity: "high",
      score: 86,
      confidence: "high",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs: entry.offsetMs ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        requestId,
        method: entry.method || entry.m,
        url: redactUrl(entry.url),
        message: scrubText(entry.msg, 220),
        source: entry.transport,
      }),
      dedupeKey: `neterr:${requestId ?? entry.t}:${entry.method ?? entry.m ?? ""}:${entry.url ?? ""}:${entry.msg ?? ""}`,
    });
  }

  for (const entry of index.consoleErrors ?? []) {
    drafts.push({
      detector: "console_error",
      title: `Console error: ${scrubText(entry.msg, 100) ?? "message unavailable"}`,
      severity: "medium",
      score: 58,
      confidence: "medium",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs: entry.offsetMs ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        message: scrubText(entry.msg, 220),
        source: entry.source,
        // The console collector synthesizes a stack at `console.error` time, so
        // a framework that reports through the console instead of throwing
        // still yields a code location. Without this the slot reads as a
        // capture gap while the stack sits in the index unread.
        frame: codeFrameOf({ stk: entry.stk }),
      }),
      // Key on content signature (message+route), not the volatile timestamp, so a component that
      // re-renders and re-logs the same console error collapses into one candidate (dedupeDrafts
      // keeps the earliest anchor). Aligns with distinct-bugs.ts normalizeSignature.
      dedupeKey: `console:${normalizeErrorSignature(entry.msg)}:${routeAt(index.navs ?? [], entry.t) ?? ""}`,
    });
  }

  for (const entry of index.errs ?? []) {
    const event = events.find(
      (candidate) =>
        candidate.t === entry.t &&
        (candidate.k === "err" || candidate.k === "rej"),
    );
    // A "Failed to fetch" rejection carries no location of its own. When the
    // page probe could key the thrown error to its failed request, the errs
    // entry inherits that request's id/method/url, so surface it on the anchor
    // (mirrors the http_error anchor above) to restore request identity.
    const requestId =
      entry.requestId != null ? String(entry.requestId) : undefined;
    drafts.push({
      detector: event?.k === "rej" ? "unhandled_rejection" : "uncaught_error",
      title: `${event?.k === "rej" ? "Unhandled rejection" : "Uncaught error"}: ${scrubText(entry.msg, 100) ?? "message unavailable"}`,
      severity: "high",
      score: 82,
      confidence: "high",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        requestId,
        method: entry.method,
        url: redactUrl(entry.url),
        message: scrubText(entry.msg, 220),
        frame: codeFrameOf(entry),
      }),
      // Content-signature dedupe: a repeatedly re-thrown TypeError (same message + route) collapses
      // to one candidate instead of one-per-timestamp. Keep err vs rej distinct (different bug type).
      dedupeKey: `runtime:${event?.k === "rej" ? "rej" : "err"}:${normalizeErrorSignature(entry.msg)}:${routeAt(index.navs ?? [], entry.t) ?? ""}`,
    });
  }

  for (const entry of index.pageProbe?.errors ?? []) {
    drafts.push({
      detector: "page_probe_failure",
      title: `Page probe failure${entry.phase ? ` during ${entry.phase}` : ""}`,
      severity: "medium",
      score: 62,
      confidence: "high",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs: entry.offsetMs ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        message: scrubText(entry.message, 220),
        source: entry.source ?? entry.phase,
      }),
      dedupeKey: `probe:${entry.t}:${entry.phase ?? ""}:${entry.message ?? ""}`,
    });
  }

  for (const boundary of index.tabBoundaries ?? []) {
    if (boundary.nonCapture !== true && boundary.capture !== false) continue;
    drafts.push({
      detector: "tab_boundary_gap",
      title: `Tab boundary non-capture${boundary.reason ? `: ${boundary.reason}` : ""}`,
      severity: "low",
      score: 35,
      confidence: "high",
      anchor: removeUndefined({
        t: boundary.t,
        offsetMs: boundary.offsetMs ?? offsetFromStart(boundary.t, index.start),
        route: routeAt(index.navs ?? [], boundary.t),
        message: scrubText(boundary.reason, 180),
        source: boundary.decision,
      }),
      dedupeKey: `tab:${boundary.t}:${boundary.decision ?? ""}:${boundary.reason ?? ""}`,
    });
  }

  addRepeatedClickCandidates(events, index, drafts);
  addSlowRequestCandidates(events, index, requestById, drafts);
  addPendingRequestCandidates(index, requestById, responseIds, drafts);
  addResponseRaceCandidates(events, index, requestById, drafts);
  addIneffectiveSubmitCandidates(events, index, drafts);
  addMediaDegradationCandidates(events, index, drafts);
  addVoiceMarkerCandidates(events, index, drafts);
  addTranscriptComplaintCandidates(events, index, drafts);
  addConsoleWarningCandidates(events, index, drafts);
  addOtelErrorCandidates(events, index, drafts);
  addBackendErrorCandidates(events, index, drafts);
  addDbDiffCandidates(events, index, drafts);
  addDbFieldDivergenceCandidates(events, index, drafts);
  addDuplicateWriteCandidates(events, index, drafts);
  addInterpolationArtifactCandidates(events, index, drafts);
  addStateFlipFlopCandidates(events, index, drafts);
  addDuplicateChargeCandidates(events, index, drafts);
  addMoneyScaleShiftCandidates(events, index, drafts);
  addCrossUserReadCandidates(events, index, drafts);
  addDuplicateReadbackCandidates(events, index, drafts);
  addOrphanedReferenceCandidates(events, index, drafts);
  addLostUpdateCandidates(events, index, drafts);
  addCounterContradictionCandidates(events, index, drafts);
  addNPlusOneCandidates(events, index, drafts);
  addPaginationOffsetCandidates(events, index, drafts);
  addListenerTypeStaircaseCandidates(events, index, drafts);
  const mutatingRequests = collectMutatingRequests(events);
  addConcurrentDuplicateMutationCandidates(events, index, drafts, mutatingRequests);
  addDbDeltaMismatchCandidates(events, index, drafts, mutatingRequests);
  addClientSuppliedValueCandidates(events, index, drafts, mutatingRequests);
  addIneffectiveInputCandidates(events, index, drafts, mutatingRequests);
  addUiArithmeticMismatchCandidates(events, index, drafts);
  addUiApiDivergenceCandidates(events, index, drafts);
  addOtelDbActivityCandidates(events, index, drafts);

  // Full-recall detectors. Append-only: every rule above keeps its position and
  // its ranking, and these read evidence the pipeline already captured but no
  // rule had ever looked at.
  const exchanges = collectRequestExchanges(events);
  addFilterContradictionCandidates(events, index, drafts, exchanges);
  addResultRowLossCandidates(events, index, drafts, exchanges);
  addSharedStateBleedCandidates(events, index, drafts, exchanges);
  addAcknowledgedWriteLostCandidates(events, index, drafts, exchanges);
  addBatchImportCandidates(events, index, drafts, exchanges);
  addRefundInvariantCandidates(events, index, drafts);
  addRuntimeWarningCandidates(events, index, drafts);
  addDeclinedPaymentOrderedCandidates(events, index, drafts);
  addStoredActiveMarkupCandidates(events, index, drafts);
  addInputRevertedCandidates(events, index, drafts);
  addFormResetAfterErrorCandidates(events, index, drafts);
  addCurrencyLocaleMismatchCandidates(events, index, drafts);
  addDisplayDateTimezoneMismatchCandidates(events, index, drafts);
  addLayoutOverflowCandidates(events, index, drafts);
  addStaleViewAfterPopCandidates(events, index, drafts);
  addListenerGrowthCandidates(events, index, drafts);
  addStreamDesyncCandidates(events, index, drafts, exchanges);

  // Demote the 4xx responses the application returned deliberately (auth challenges, structured
  // error bodies) before dedupe so their grouped keys collapse. Ranking-only, like the beacon pass.
  demoteHandledClientErrors(drafts, events);

  // Downrank known third-party analytics/ads beacon failures before dedupe/ranking so a blocked
  // tracker beacon cannot outrank (or drown) a genuine first-party failure. Ranking-only in spirit:
  // it lowers score/severity for beacon noise but never removes a candidate.
  downrankTrackerBeacons(drafts, events, index);

  const deduped = dedupeDrafts(drafts);
  // Baseline order (score desc, anchor.t asc, dedupeKey asc). The causal re-rank below only reorders
  // symptoms relative to their roots; absent a graph it is a no-op and this order is preserved.
  const ordered = deduped.sort(
    (a, b) =>
      b.score - a.score ||
      a.anchor.t - b.anchor.t ||
      a.dedupeKey.localeCompare(b.dedupeKey),
  );

  // --- Confidence-gated causal re-rank ---------------------------------------------------------
  // Ranking-only: never mutates the emitted `score`. Uses dedupeKey as the stable per-candidate id
  // (final cand_XXXX ids do not exist yet). Absent/empty graph → attribution is all-isolated → the
  // comparator degrades to the baseline order above.
  applyCausalRerank(ordered, causalGraph);

  // Cap emitted candidates after re-ranking so the highest-priority items survive the truncation.
  ordered.splice(MAX_EVIDENCE_CANDIDATES);

  const windows = mergeWindowRanges(
    ordered.map((draft) => ({
      start: Math.max(0, draft.anchor.t - (draft.wideWindow ? 30_000 : 15_000)),
      end: draft.anchor.t + (draft.wideWindow ? 90_000 : 45_000),
    })),
  );

  // Map dedupeKey → final candidate id (available only after ordering) so rootCauseId/causes can
  // reference emitted ids rather than internal dedupe keys.
  const idByDedupeKey = new Map<string, string>();
  ordered.forEach((draft, index) =>
    idByDedupeKey.set(
      draft.dedupeKey,
      `cand_${String(index + 1).padStart(4, "0")}`,
    ),
  );

  return ordered.map((draft, index) => {
    const id = `cand_${String(index + 1).padStart(4, "0")}`;
    const window = windows.find(
      (candidateWindow) =>
        draft.anchor.t >= candidateWindow.start &&
        draft.anchor.t <= candidateWindow.end,
    ) ?? { start: draft.anchor.t, end: draft.anchor.t };
    const rootCauseId = draft.rootCauseId
      ? idByDedupeKey.get(draft.rootCauseId)
      : undefined;
    const causes = draft.causes
      ? draft.causes
          .map((key) => idByDedupeKey.get(key))
          .filter((v): v is string => v !== undefined)
          .sort((a, b) => a.localeCompare(b))
      : undefined;
    return {
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
      id,
      detector: draft.detector,
      title: draft.title,
      severity: draft.severity,
      score: draft.score,
      confidence: draft.confidence,
      ...(draft.occurrences !== undefined
        ? { occurrences: draft.occurrences }
        : {}),
      anchor: draft.anchor,
      ...(draft.causalRole ? { causalRole: draft.causalRole } : {}),
      ...(rootCauseId ? { rootCauseId } : {}),
      ...(causes && causes.length > 0 ? { causes } : {}),
      ...(draft.attributionConfidence
        ? { attributionConfidence: draft.attributionConfidence }
        : {}),
      evidenceWindow: {
        start: window.start,
        end: window.end,
        windowId: `win_${String(windows.indexOf(window) + 1).padStart(4, "0")}`,
      },
    };
  });
}

/**
 * Causal-graph-driven re-rank. RANKING-ONLY: mutates draft ordering (and the additive causal tag
 * fields) but NEVER the emitted `score`. Uses `dedupeKey` as each draft's stable identity. With
 * no/empty graph, attribution is all-isolated and the baseline order is preserved byte for byte.
 *
 * Drafts are ranked as CAUSAL CHAINS, not individually. A chain is a set of drafts connected by
 * CREDITED symptom→root links; it is placed by the score of its strongest member and laid out
 * internally root first. So a high-scoring symptom lifts its whole chain to the height it deserves
 * and still appears under its own cause — the two rules that used to fight.
 *
 * A link is CREDITED when its `attributionConfidence` is `high` or `medium`. A `low` link is an
 * annotation ("these ran in sequence"), it binds nothing, and its symptom ranks on its own score.
 * That is the whole point: the graph's spine chains a request's nodes in time order, so an ordinary
 * checkout emits one long low-confidence chain of writes. Letting those links decide position is
 * what buried a score-90 named failure under a score-40 "Database update on products" — the write
 * that merely happened first. Causality is still expressed, as a link, in the emitted fields.
 *
 * Ordering within one chain is root-before-symptom by construction (pre-order walk from the chain's
 * top), so no corrective sweep is needed and a symptom can never precede its own cause.
 *
 * A second rule sits alongside the grade, and it is about WHAT the two drafts say rather than how
 * strongly they are linked: a generic plane surfacing never leads a chain containing a named failure
 * (see {@link namesFailureOnGenericPlane}). The grade alone does not cover this — a `db.write` symptom
 * of an `otel_db_activity` root is not a write-to-write claim, so nothing clamps it, and "a database
 * span exists" would be read first. Such a link is left uncredited, so the named failure ranks on its
 * own score.
 *
 * Replaces an earlier rank-tier partition (roots ahead of demoted high/medium symptoms) plus an
 * `enforceRootBeforeSymptom` sweep that undid it. The two disagreed by design, the sweep won, and
 * because it honored EVERY `rootCauseId` regardless of grade, the `low` tier's documented
 * "annotate only, order preserved" contract was not true of position. The sweep's own exemption for
 * the generic/named pair is preserved above, as a rule about which links bind rather than about which
 * lifts are allowed.
 *
 * The comparator produces a total, deterministic order derived solely from per-draft fields.
 */
function applyCausalRerank(
  ordered: CandidateDraft[],
  causalGraph?: CausalGraph,
): void {
  if (causalGraph && causalGraph.nodes.length > 0) {
    const detectorByKey = new Map<string, string>();
    for (const draft of ordered)
      detectorByKey.set(draft.dedupeKey, draft.detector);

    const attribution = attributeCandidates(
      causalGraph,
      ordered.map((draft) => ({
        id: draft.dedupeKey,
        anchor: {
          t: draft.anchor.t,
          requestId: draft.anchor.requestId,
          route: draft.anchor.route,
        },
      })),
      (id) => detectorByKey.get(id),
    );

    for (const draft of ordered) {
      const attr = attribution.get(draft.dedupeKey);
      if (!attr) continue;
      draft.causalRole = attr.causalRole;
      if (attr.rootCauseId !== undefined) draft.rootCauseId = attr.rootCauseId;
      if (attr.causes !== undefined) draft.causes = attr.causes;
      if (attr.attributionConfidence !== undefined)
        draft.attributionConfidence = attr.attributionConfidence;
    }
  }

  const byKey = new Map<string, CandidateDraft>(
    ordered.map((draft) => [draft.dedupeKey, draft]),
  );

  /**
   * A symptom→root link strong enough to bind the two into one ranked chain. Two ways to fail:
   *
   *  - GRADE. A `low` link is the request spine's time ordering restated, so it annotates without
   *    binding — see the header.
   *  - WHAT THE DRAFTS SAY. A generic plane surfacing never leads a chain containing the named
   *    failure it is the nominal root of. The grade does not cover this on its own: an
   *    `otel_db_activity` root is not a database write, so a write-to-write clamp never reaches the
   *    link, and "a database span exists" would be read ahead of the invariant violation under it.
   *
   * Either way the draft becomes its own chain top and ranks on its own score, keeping its
   * `causalRole` and `rootCauseId` so the relation is still readable.
   */
  const creditedParent = (draft: CandidateDraft): string | undefined => {
    if (draft.causalRole !== "symptom" || !draft.rootCauseId) return undefined;
    if (
      draft.attributionConfidence !== "high" &&
      draft.attributionConfidence !== "medium"
    )
      return undefined;
    const root = byKey.get(draft.rootCauseId);
    if (root === undefined) return undefined;
    if (namesFailureOnGenericPlane(root.detector, draft.detector))
      return undefined;
    return draft.rootCauseId;
  };

  // Blast-radius boost (ranking-only): each root's effective score rises by a bounded amount driven
  // by the severity of the symptoms it explains. Only CREDITED symptoms count — a link too weak to
  // set position is too weak to argue the root has a blast radius. Symptoms/isolated get no boost.
  const boostByKey = new Map<string, number>();
  for (const draft of ordered) {
    if (
      draft.causalRole !== "root" ||
      !draft.causes ||
      draft.causes.length === 0
    )
      continue;
    let raw = 0;
    for (const symptomKey of draft.causes) {
      const symptom = byKey.get(symptomKey);
      if (!symptom || creditedParent(symptom) !== draft.dedupeKey) continue;
      raw +=
        CAUSAL_RANK_CONSTANTS.SEVERITY_WEIGHT[symptom.severity] *
        CAUSAL_RANK_CONSTANTS.BLAST_PER_SYMPTOM;
    }
    if (raw > 0)
      boostByKey.set(
        draft.dedupeKey,
        Math.min(CAUSAL_RANK_CONSTANTS.MAX_BLAST_BOOST, raw),
      );
  }

  const effectiveScore = (draft: CandidateDraft): number =>
    draft.score + (boostByKey.get(draft.dedupeKey) ?? 0);

  // Sibling / singleton order, and the tie-break everywhere else: higher effective score, then the
  // historical anchor-time and dedupeKey keys.
  const byRank = (a: CandidateDraft, b: CandidateDraft): number => {
    const sa = effectiveScore(a);
    const sb = effectiveScore(b);
    if (sa !== sb) return sb - sa;
    if (a.anchor.t !== b.anchor.t) return a.anchor.t - b.anchor.t;
    return a.dedupeKey.localeCompare(b.dedupeKey);
  };

  // --- Chain assembly ---------------------------------------------------------------------------
  // Walk each draft up its credited parents to the chain's top. The guard bounds a cycle the
  // attribution should never produce (it classifies over a DAG's ancestry) but which must not hang
  // the ranker if a future edge rule introduces one; a draft in a cycle becomes its own chain top.
  const topOf = new Map<string, string>();
  for (const draft of ordered) {
    let current = draft;
    const seen = new Set<string>([current.dedupeKey]);
    for (;;) {
      const parentKey = creditedParent(current);
      if (parentKey === undefined || seen.has(parentKey)) break;
      seen.add(parentKey);
      current = byKey.get(parentKey)!;
    }
    topOf.set(draft.dedupeKey, current.dedupeKey);
  }

  const childrenOf = new Map<string, CandidateDraft[]>();
  for (const draft of ordered) {
    const parentKey = creditedParent(draft);
    if (
      parentKey === undefined ||
      topOf.get(draft.dedupeKey) === draft.dedupeKey
    )
      continue;
    const siblings = childrenOf.get(parentKey) ?? [];
    siblings.push(draft);
    childrenOf.set(parentKey, siblings);
  }

  const members = new Map<string, CandidateDraft[]>();
  for (const draft of ordered) {
    const top = topOf.get(draft.dedupeKey)!;
    const list = members.get(top) ?? [];
    list.push(draft);
    members.set(top, list);
  }

  // Root first, then each subtree in sibling-rank order. Pre-order, so no member can precede the
  // cause it was attributed to.
  const layout = (top: CandidateDraft): CandidateDraft[] => {
    const out: CandidateDraft[] = [];
    const walk = (draft: CandidateDraft): void => {
      out.push(draft);
      for (const child of [...(childrenOf.get(draft.dedupeKey) ?? [])].sort(
        byRank,
      ))
        walk(child);
    };
    walk(top);
    return out;
  };

  // A chain is placed by its STRONGEST member: a named failure pulls the chain that explains it up
  // to its own height rather than sinking to wherever its cause happened to rank.
  const chains = [...members.entries()].map(([topKey, chainMembers]) => ({
    top: byKey.get(topKey)!,
    score: Math.max(...chainMembers.map(effectiveScore)),
    t: Math.min(...chainMembers.map((draft) => draft.anchor.t)),
  }));
  chains.sort(
    (a, b) =>
      b.score - a.score ||
      a.t - b.t ||
      a.top.dedupeKey.localeCompare(b.top.dedupeKey),
  );

  const ranked = chains.flatMap((chain) => layout(chain.top));
  // Defensive: a draft dropped by a chain-assembly bug would silently vanish from the output. Keep
  // the emitted set identical to the input set no matter what.
  if (ranked.length === ordered.length)
    ordered.splice(0, ordered.length, ...ranked);
  else ordered.sort(byRank);
}

function addRepeatedClickCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const clicksByLabel = new Map<string, BugEvent[]>();
  for (const event of events) {
    if (event.k !== "clk") continue;
    const label = elementLabel(event) ?? "unknown element";
    const clicks = clicksByLabel.get(label) ?? [];
    clicks.push(event);
    clicksByLabel.set(label, clicks);
  }

  for (const [label, clicks] of clicksByLabel) {
    clicks.sort((a, b) => a.t - b.t);
    let start = 0;
    let end = 0;
    while (start < clicks.length) {
      const first = clicks[start];
      while (end < clicks.length && clicks[end].t - first.t <= 3_000) end++;
      const groupLength = end - start;
      if (groupLength < 3) {
        start++;
        if (end < start) end = start;
        continue;
      }
      drafts.push({
        detector: "repeated_clicks",
        title: `Repeated clicks on ${titleElementLabel(first)}`,
        severity: "medium",
        score: 55 + Math.min(10, groupLength),
        confidence: "medium",
        anchor: removeUndefined({
          t: first.t,
          offsetMs:
            offsetForEvent(first) ?? offsetFromStart(first.t, index.start),
          route: routeAt(index.navs ?? [], first.t),
          target: targetForEvent(first),
          elementLabel: scrubText(label, 160),
          message: `${groupLength} clicks within 3s`,
        }),
        dedupeKey: `repeat:${label}:${first.t}`,
      });
      start = end;
    }
  }
}

function addSlowRequestCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  requests: Map<string, RequestInfo>,
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const dur = finiteNumber(event.d.dur);
    if (dur === undefined || dur < 5_000) continue;
    const requestId = networkRequestId(event.d.id);
    const req = requestId ? requests.get(requestId) : undefined;
    drafts.push({
      detector: "slow_request",
      title: [
        "Slow request",
        req?.method,
        titleUrl(req?.url ?? "") ?? "unknown URL",
      ]
        .filter(Boolean)
        .join(" "),
      severity: dur >= 15_000 ? "high" : "medium",
      score: dur >= 15_000 ? 78 : 64,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        method: req?.method,
        url: redactUrl(req?.url),
        status: finiteNumber(event.d.st),
        message: `${Math.round(dur)} ms`,
      }),
      dedupeKey: `slow:${requestId ?? event.t}`,
    });
  }
}

function addPendingRequestCandidates(
  index: EvidenceIndexInput["index"],
  requests: Map<string, RequestInfo>,
  responseIds: Set<string>,
  drafts: CandidateDraft[],
): void {
  const sessionEnd = finiteNumber(index.end) ?? 0;
  for (const req of requests.values()) {
    if (responseIds.has(req.id)) continue;
    drafts.push({
      detector: "pending_request",
      title:
        `Pending request ${req.method ?? ""} ${redactUrl(req.url ?? "")}`.trim(),
      severity: "medium",
      score: 60,
      confidence: "high",
      anchor: removeUndefined({
        t: sessionEnd > 0 ? sessionEnd : req.t,
        offsetMs: offsetFromStart(
          sessionEnd > 0 ? sessionEnd : req.t,
          index.start,
        ),
        route: routeAt(index.navs ?? [], req.t),
        requestId: req.id,
        method: req.method,
        url: redactUrl(req.url),
        message: "Request had no matching response by session end",
      }),
      dedupeKey: `pending:${req.id}`,
    });
  }
}

/**
 * Two requests to the same endpoint were in flight together and came back in the
 * opposite order to the one they were sent in.
 *
 * This is the shape behind every "the search box shows results for what I typed
 * three keystrokes ago" report: the app fires one request per keystroke, the
 * earlier and narrower query happens to take longer, and whichever response
 * lands last wins the render. Nothing errors, nothing is slow, and the gate
 * stays green — the only trace is the ordering, which is fully visible here and
 * invisible from inside the app unless it was already sequencing responses.
 *
 * Reported as a race rather than as a bug: an app that tags each response and
 * drops the stale one has the same event shape and is correct. The evidence is
 * the ordering; whether the UI stomped is the reader's call, and the message
 * says so rather than asserting it.
 */
function addResponseRaceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  requests: Map<string, RequestInfo>,
  drafts: CandidateDraft[],
): void {
  // Order is the whole signal here, and timestamps alone cannot carry it: two
  // calls fired from the same tick share a millisecond, so a comparison on `t`
  // reads the real race below as no race at all. Capture order is what actually
  // records which went first, so both orders are taken from the event stream and
  // timestamps are used only to prove the two overlapped.
  const sentAt = new Map<string, number>();
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const id = networkRequestId(event.d.id);
    if (id && !sentAt.has(id)) sentAt.set(id, sentAt.size);
  }

  // Responses in arrival order, joined back to the request that opened them.
  const arrivals: {
    req: RequestInfo;
    res: BugEvent;
    ok: boolean;
    sentSeq: number;
    backSeq: number;
  }[] = [];
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const id = networkRequestId(event.d.id);
    const req = id ? requests.get(id) : undefined;
    const sentSeq = id ? sentAt.get(id) : undefined;
    if (!req?.url || sentSeq === undefined) continue;
    const status = finiteNumber(event.d.st);
    arrivals.push({
      req,
      res: event,
      ok: status !== undefined && status >= 200 && status < 300,
      sentSeq,
      backSeq: arrivals.length,
    });
  }

  // Same endpoint means same method and path. The query string is the part that
  // differs between the racing calls, so keying on the full URL would put every
  // keystroke in its own bucket and find nothing.
  const byEndpoint = new Map<string, typeof arrivals>();
  for (const arrival of arrivals) {
    const key = `${arrival.req.method ?? "GET"} ${requestPathOf(arrival.req.url ?? "")}`;
    const bucket = byEndpoint.get(key) ?? [];
    bucket.push(arrival);
    byEndpoint.set(key, bucket);
  }

  for (const [endpoint, bucket] of byEndpoint) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const first = bucket[i];
        const second = bucket[j];
        // Equal send sequence means both responses joined the SAME request
        // record — the browser restarts its request ids on navigation, so a
        // page reload replays id 1 and the second response has no request of
        // its own. The race claim rests entirely on send order, and for such
        // a pair send order does not exist; report nothing.
        if (first.sentSeq === second.sentSeq) continue;
        // `earlier` and `later` are by send order; the race is that `later`
        // also came back first.
        const later = second.sentSeq > first.sentSeq ? second : first;
        const earlier = later === second ? first : second;
        if (later.backSeq >= earlier.backSeq) continue;
        // A genuine overlap, not two sequential calls: the second was sent
        // before the first had answered. A pair where either half failed is a
        // different signal that the error detectors own.
        if (later.req.t > earlier.res.t) continue;
        if (!first.ok || !second.ok) continue;
        // An out-of-order pair is only evidence when the user could tell the
        // difference. Two byte-identical requests whose responses carry the
        // same status and byte count render the same thing in either order —
        // and interval pollers (build checks, heartbeats) overlap routinely,
        // so without this check every polling endpoint tops the ranking.
        if (
          earlier.req.url !== undefined &&
          earlier.req.url === later.req.url &&
          responsesLookIdentical(earlier.res, later.res)
        )
          continue;
        const gapMs = Math.round(earlier.res.t - later.res.t);
        drafts.push({
          detector: "response_race",
          title: `Out of order responses from ${titleUrl(earlier.req.url ?? "") ?? endpoint}`,
          severity: "medium",
          score: 72,
          confidence: "high",
          anchor: removeUndefined({
            t: earlier.res.t,
            offsetMs:
              offsetForEvent(earlier.res) ??
              offsetFromStart(earlier.res.t, index.start),
            route: routeAt(index.navs ?? [], earlier.res.t),
            requestId: earlier.req.id,
            method: earlier.req.method,
            url: redactUrl(earlier.req.url),
            // Identified by send time rather than by URL: the part that differs
            // between racing calls is the query string, which redaction blanks
            // unless the app declared those fields keepable. Offsets always
            // survive, so the pair stays distinguishable at any policy.
            message: `Two requests to this endpoint overlapped and returned in the opposite order. The one sent at +${Math.round(offsetFromStart(earlier.req.t, index.start) ?? 0)} ms came back ${gapMs} ms after the one sent at +${Math.round(offsetFromStart(later.req.t, index.start) ?? 0)} ms (${redactUrl(later.req.url) ?? "later request"}). Whatever the app rendered last is the older result, unless it discards responses that no longer match the current input.`,
          }),
          dedupeKey: `race:${earlier.req.id}:${later.req.id}`,
        });
      }
    }
  }
}

/**
 * Whether two responses are indistinguishable to the page: same status and the
 * same byte count. Bytes come from bodyMeta (post-capture) or the summary's
 * originalLength; when neither response carries a size, the answer is false so
 * the race stays reported — suppression needs positive evidence.
 */
function responsesLookIdentical(a: BugEvent, b: BugEvent): boolean {
  const statusA = finiteNumber(a.d.st);
  if (statusA === undefined || statusA !== finiteNumber(b.d.st)) return false;
  const bytesOf = (event: BugEvent): number | undefined => {
    const meta = event.d.bodyMeta;
    const fromMeta = isRecord(meta) ? finiteNumber(meta.bytes) : undefined;
    if (fromMeta !== undefined) return fromMeta;
    const summary = event.d.bodySummary;
    return isRecord(summary) ? finiteNumber(summary.originalLength) : undefined;
  };
  const bytesA = bytesOf(a);
  return bytesA !== undefined && bytesA === bytesOf(b);
}

/**
 * A first-page request ran its SELECT with a fractional-page OFFSET.
 *
 * Off-by-one pagination is the canonical "the first item just isn't there"
 * report: the request carries no paging parameter (or asks for page 1), the
 * query runs `OFFSET 1`, and every row of output is real and correct except
 * the one that never appears on any page. Nothing errors and no count
 * contradicts, so the window on the read event is the only evidence.
 *
 * The guard `0 < offset < limit` is what keeps this quiet on legitimate
 * queries: a real page 2 runs with offset === limit, a ranked pick
 * ("second-highest") runs LIMIT 1 OFFSET 1 where offset === limit, and cursor
 * pagination carries no OFFSET at all. Requests that page by cursor-style
 * parameters are skipped outright, because their window arithmetic is not
 * derivable from the URL.
 */
const PAGINATION_OFFSET_SCORE = 68;
const PAGE_PARAM_NAMES = new Set(["page", "p", "pageindex", "pagenumber"]);
const OFFSET_PARAM_NAMES = new Set(["offset", "skip", "start"]);
const CURSOR_PARAM_NAMES = new Set(["cursor", "after", "before", "pagetoken"]);

function addPaginationOffsetCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const requestsById = new Map<string, BugEvent>();
  for (const event of events) {
    // A backend only application has no net.req plane, and first paint can
    // reach the server before the browser collector has drained its early
    // queue. backend.req.start carries the same correlation id and URL, so it
    // is an equally valid request anchor for a database pagination invariant.
    if (event.k !== "net.req" && event.k !== "backend.req.start") continue;
    const id = safeText(event.d.requestId, 120) ?? requestIdForEvent(event);
    if (id && !requestsById.has(id)) requestsById.set(id, event);
  }

  for (const event of events) {
    if (event.k !== "db.read" && event.k !== "db.read.bulk") continue;
    const shape = isRecord(event.d.q) ? event.d.q : undefined;
    const limit = finiteNumber(shape?.limit);
    const offset = finiteNumber(shape?.offset);
    if (
      limit === undefined ||
      offset === undefined ||
      offset <= 0 ||
      offset >= limit
    )
      continue;
    const requestId = safeText(event.d.requestId, 120);
    const request = requestId ? requestsById.get(requestId) : undefined;
    if (!request) continue;
    const url = safeText(request.d.url, 400);
    if (!url) continue;

    let params: URLSearchParams;
    try {
      params = new URL(url, "http://local").searchParams;
    } catch {
      continue;
    }
    let firstPage = true;
    let cursorStyle = false;
    for (const [name, value] of params) {
      const key = name.toLowerCase();
      if (CURSOR_PARAM_NAMES.has(key)) cursorStyle = true;
      // Query values are routinely redacted at capture ("[REDACTED]"), so only
      // a READABLE later-page value disproves first-page; an unreadable value
      // proves nothing either way. The window guard above already excludes
      // every aligned window a genuine later page would run (page N's offset
      // is a multiple of limit, never 0 < offset < limit), so treating an
      // unreadable value as unknown cannot admit legitimate paging.
      if (
        PAGE_PARAM_NAMES.has(key) &&
        /^\d+$/.test(value) &&
        value !== "1" &&
        value !== "0"
      )
        firstPage = false;
      if (OFFSET_PARAM_NAMES.has(key) && /^\d+$/.test(value) && value !== "0")
        firstPage = false;
    }
    if (!firstPage || cursorStyle) continue;

    const table = safeText(event.d.table, 120) ?? "table";
    drafts.push({
      detector: "pagination_first_page_offset",
      title: `First page of ${table} skips ${offset} row${offset === 1 ? "" : "s"}`,
      severity: "medium",
      score: PAGINATION_OFFSET_SCORE,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        method: safeText(request.d.method, 20),
        url: redactUrl(url),
        message:
          `This request asks for the first page, but its ${table} SELECT ran with ` +
          `OFFSET ${offset} (LIMIT ${limit}). The first ${offset} row${offset === 1 ? "" : "s"} of the ` +
          `table's order are skipped before the page starts, so they are returned to no page at all.`,
      }),
      dedupeKey: `pageoffset:${requestId}:${table}:${offset}`,
    });
  }
}

/**
 * The same mutation was in flight twice at once and both copies succeeded.
 *
 * This is the transport shape of both halves of a read-modify-write race: a
 * client that double-fires a submit, or two tabs/users hitting a shared
 * resource, sends byte-identical mutations whose handling overlaps, and the
 * store applies both. The symptom downstream is a duplicated line or a lost
 * increment — invisible to every error detector because both requests returned
 * 2xx. Sequential retries are excluded on purpose (a retry after a failure is
 * the client behaving correctly); only pairs whose lifetimes overlap qualify.
 *
 * Bodies must be readable to group: a redacted body collapses distinct payloads
 * into one signature, which would manufacture duplicates, so any body carrying
 * a redaction marker is skipped rather than trusted.
 */
const CONCURRENT_DUPLICATE_MUTATION_SCORE = 72;
const REDACTION_MARKER = "[REDACTED]";

function addConcurrentDuplicateMutationCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  mutatingRequests: Map<string, CorrelatedRequest>,
): void {
  // Response arrival times, keyed the same way collectMutatingRequests keys its
  // entries, so a request's lifetime is [reqEvent.t, resT].
  const resAt = new Map<string, number>();
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const id = safeText(event.d.requestId, 120) ?? requestIdForEvent(event);
    if (id && !resAt.has(id)) resAt.set(id, event.t);
  }

  const groups = new Map<string, CorrelatedRequest[]>();
  for (const entry of mutatingRequests.values()) {
    if (!entry.url) continue;
    if (entry.status === undefined || entry.status < 200 || entry.status >= 300)
      continue;
    const body =
      typeof entry.body === "string"
        ? entry.body
        : entry.body === undefined || entry.body === null
          ? undefined
          : JSON.stringify(entry.body);
    if (!body || body.includes(REDACTION_MARKER)) continue;
    const key = `${entry.method} ${entry.url} ${body.slice(0, 2_000)}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }

  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => a.reqEvent.t - b.reqEvent.t);
    // The earliest overlapping pair anchors the finding; more copies only
    // raise the count, not the number of candidates.
    let anchor: [CorrelatedRequest, CorrelatedRequest] | undefined;
    let overlapping = 0;
    for (let i = 0; i + 1 < bucket.length; i += 1) {
      const first = bucket[i];
      const second = bucket[i + 1];
      const firstBack = resAt.get(first.requestId);
      if (firstBack === undefined || second.reqEvent.t > firstBack) continue;
      overlapping += 1;
      anchor ??= [first, second];
    }
    if (!anchor) continue;
    const [first, second] = anchor;
    const firstRes =
      typeof first.resBody === "string"
        ? first.resBody
        : JSON.stringify(first.resBody);
    const secondRes =
      typeof second.resBody === "string"
        ? second.resBody
        : JSON.stringify(second.resBody);
    const divergence =
      firstRes !== undefined && secondRes !== undefined && firstRes !== secondRes
        ? " Their responses describe different resulting states, so each write observed a store the other had not finished changing."
        : "";
    drafts.push({
      detector: "concurrent_duplicate_mutation",
      title: `Identical ${first.method} ${titleUrl(first.url ?? "") ?? "mutation"} in flight twice at once`,
      severity: "medium",
      score: CONCURRENT_DUPLICATE_MUTATION_SCORE,
      confidence: "medium",
      anchor: removeUndefined({
        t: second.reqEvent.t,
        offsetMs:
          offsetForEvent(second.reqEvent) ??
          offsetFromStart(second.reqEvent.t, index.start),
        route: routeAt(index.navs ?? [], second.reqEvent.t),
        requestId: second.requestId,
        method: first.method,
        url: redactUrl(first.url),
        message:
          `${bucket.length} identical ${first.method} calls to this endpoint succeeded, ` +
          `${overlapping + 1} of them overlapping in flight. A read-modify-write behind this ` +
          `endpoint applies each copy against the state it read, so the result is a duplicated ` +
          `entry or a lost increment rather than an error.${divergence}`,
      }),
      dedupeKey: `dupmutation:${first.method}:${first.requestId}`,
    });
  }
}

/** Path portion of a request URL, for grouping calls that differ only by query. */
function requestPathOf(url: string): string {
  const withoutHash = url.split("#")[0] ?? url;
  return withoutHash.split("?")[0] ?? withoutHash;
}

function addIneffectiveSubmitCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const activityTimes = events
    .filter(
      (event) =>
        isNavigationEvent(event) ||
        event.k === "net.req" ||
        event.k === "net.res",
    )
    .map((event) => event.t)
    .sort((a, b) => a - b);
  for (const event of events) {
    if (event.k !== "clk") continue;
    const label = elementLabel(event) ?? "";
    if (
      !/(submit|save|sync|continue|checkout|send|create|update|confirm)/i.test(
        label,
      )
    )
      continue;
    const hasActivity = hasActivityWithin(activityTimes, event.t, 3_000);
    if (hasActivity) continue;
    drafts.push({
      detector: "ineffective_submit",
      title: `Submit-like click had no navigation or network activity: ${titleElementLabel(event)}`,
      severity: "medium",
      score: 52,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        target: targetForEvent(event),
        elementLabel: scrubText(label, 160),
        message: "No nav, net.req, or net.res within 3s",
      }),
      dedupeKey: `ineffective:${event.t}:${label}`,
    });
  }
}

function hasActivityWithin(
  activityTimes: number[],
  t: number,
  windowMs: number,
): boolean {
  let lo = 0;
  let hi = activityTimes.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (activityTimes[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo < activityTimes.length && activityTimes[lo] - t <= windowMs;
}

function addMediaDegradationCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "media.video" && event.k !== "media.voice") continue;
    const state = safeText(event.d.state, 80);
    const code = safeText(event.d.code, 120);
    if (state !== "error" && state !== "degraded" && code === undefined)
      continue;
    const capability =
      safeText(event.d.capability, 80) ??
      (event.k === "media.video" ? "video" : "audio");
    drafts.push({
      detector: "media_degradation",
      title: `${capability} capture degraded${code ? `: ${code}` : ""}`,
      severity: event.k === "media.video" ? "medium" : "low",
      score: event.k === "media.video" ? 56 : 42,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        errorCode: scrubText(code, 160),
        message: scrubText(event.d.message, 220),
        source: capability,
      }),
      dedupeKey: `media:${event.t}:${event.k}:${code ?? state ?? ""}`,
    });
  }
}

function addVoiceMarkerCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "media.voice" || event.d.state !== "marker-added") continue;
    const label = safeText(event.d.label, 160);
    drafts.push({
      detector: "user_marker",
      title: `User marker${label ? `: ${scrubText(label, 100)}` : ""}`,
      severity: "low",
      score: 45,
      confidence: "high",
      wideWindow: true,
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        message: scrubText(label, 220),
        source: safeText(event.d.markerId, 120),
      }),
      dedupeKey: `marker:${event.t}:${label ?? ""}`,
    });
  }
}

function addTranscriptComplaintCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const complaintPattern =
    /\b(error|failed|failure|broken|stuck|not working|doesn'?t work|can't|cannot|won't|problem|issue)\b/i;
  for (const event of events) {
    if (event.k !== "tx") continue;
    const text = safeText(event.d.text, 500);
    if (!text || !complaintPattern.test(text)) continue;
    drafts.push({
      detector: "transcript_complaint",
      title: `Transcript complaint: ${scrubText(text, 100)}`,
      severity: "low",
      score: 48,
      confidence: "medium",
      wideWindow: true,
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        message: scrubText(text, 220),
      }),
      dedupeKey: `tx:${event.t}:${text}`,
    });
  }
}

const OTEL_SPAN_KIND = "backend.otel.span";
const OTEL_LOG_KIND = "backend.otel.log";

/** Upper bound on a stack scanned for a code frame. Deep async stacks are long. */
const MAX_STACK_CHARS = 8000;

function otelHttpStatus(attributes: unknown): number | undefined {
  if (!isRecord(attributes)) return undefined;
  return (
    finiteNumber(attributes["http.response.status_code"]) ??
    finiteNumber(attributes["http.status_code"])
  );
}

/**
 * `file:line:col` for a backend signal, read from OTel attributes. Both the
 * current (`code.file.path`) and the older (`code.filepath`) semantic
 * convention names are accepted, since exporters in the field emit either.
 *
 * Falls back to `exception.stacktrace`, which is where a recorded exception
 * puts its frames when the SDK sets it as an attribute rather than a span
 * event. Returns undefined rather than a partial location, matching
 * {@link codeFrameOf}: a path with no line is not a starting point.
 */
function otelCodeFrame(attributes: unknown): string | undefined {
  if (!isRecord(attributes)) return undefined;
  const file =
    safeText(attributes["code.file.path"], 300) ??
    safeText(attributes["code.filepath"], 300);
  const line =
    finiteNumber(attributes["code.line.number"]) ??
    finiteNumber(attributes["code.lineno"]);
  if (file && line !== undefined) {
    const column =
      finiteNumber(attributes["code.column.number"]) ??
      finiteNumber(attributes["code.column"]);
    return safeText(
      `${file}:${line}${column !== undefined ? `:${column}` : ""}`,
      300,
    );
  }
  // Deliberately NOT safeText: it collapses runs of whitespace, which flattens
  // a stack onto one line and leaves codeFrameOf nothing to split on (it skips
  // the header line, so a flattened stack yields no frames at all). Pass the
  // raw string, bounded, and let codeFrameOf truncate the location it returns.
  const stack = attributes["exception.stacktrace"];
  if (typeof stack !== "string") return undefined;
  return codeFrameOf({ stk: stack.slice(0, MAX_STACK_CHARS) });
}

/**
 * A code frame for a span, preferring its own attributes and falling back to a
 * recorded exception span event.
 *
 * `recordException()` is how a backend normally reports a failure, and it puts
 * exception.stacktrace on a span EVENT rather than on the span. Reading only
 * span attributes therefore left the common case with no code location.
 */
function spanCodeFrame(d: Record<string, unknown>): string | undefined {
  const fromAttributes = otelCodeFrame(d.attributes);
  if (fromAttributes) return fromAttributes;

  if (!Array.isArray(d.spanEvents)) return undefined;
  for (const spanEvent of d.spanEvents) {
    if (!isRecord(spanEvent)) continue;
    const frame = otelCodeFrame(spanEvent.attributes);
    if (frame) return frame;
  }
  return undefined;
}

function addConsoleWarningCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // Maximum visibility: surface every console.warn (deduped by content), not just errors.
  // console.warn is never summarized into the index, so scan raw events.
  for (const event of events) {
    if (event.k !== "con") continue;
    if (!safeText(event.d.lv, 20)?.toLowerCase().startsWith("warn")) continue;
    const message = scrubText(consoleMessage(event.d), 220);
    drafts.push({
      detector: "console_warning",
      title: `Console warning: ${scrubText(consoleMessage(event.d), 100) ?? "message unavailable"}`,
      severity: "low",
      score: 50,
      confidence: "low",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        message,
        source: safeText(event.d.source, 80),
      }),
      // Content-signature dedupe (message + route), not the volatile timestamp, so a warning that
      // re-fires every render (React key/deprecation warnings) collapses into one candidate.
      // Mirrors the console_error/runtime dedupe above; dedupeDrafts keeps the earliest anchor.
      dedupeKey: `conwarn:${normalizeErrorSignature(consoleMessage(event.d))}:${routeAt(index.navs ?? [], event.t) ?? ""}`,
    });
  }
}

function addBackendErrorCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // Backend errors are NOT summarized into the SessionIndex — scan raw events.
  // Shared dedupe namespace collapses a request that emits both backend.req.error
  // and backend.req.end into a single candidate (the higher score wins via dedupeDrafts).
  for (const event of events) {
    // backend.uncaught (auto-captured crash) is request-less but still a backend
    // error: fold it into the same high-severity backend_request_error candidate
    // path as backend.req.error (its dedupeKey falls back to the event time).
    const isError =
      event.k === "backend.req.error" || event.k === "backend.uncaught";
    const isEnd = event.k === "backend.req.end";
    if (!isError && !isEnd) continue;

    const error = isRecord(event.d.error) ? event.d.error : undefined;
    const status =
      finiteNumber(event.d.statusCode) ?? finiteNumber(error?.statusCode);
    const requestId = safeText(event.d.requestId, 120);

    let detector: string;
    let severity: CandidateDraft["severity"];
    let score: number;
    if (isError) {
      detector = "backend_request_error";
      severity = "high";
      score = 90;
    } else if ((status ?? 0) >= 500) {
      detector = "backend_http_error";
      severity = "high";
      score = 89;
    } else if ((status ?? 0) >= 400) {
      detector = "backend_http_client_error";
      severity = "medium";
      score = 66;
    } else {
      continue;
    }

    const method = safeText(event.d.method, 20);
    const route = redactUrl(event.d.route) ?? redactUrl(event.d.pathname);
    const errorCode = safeText(error?.code, 160) ?? safeText(error?.name, 160);
    const message = scrubText(error?.message, 220);

    drafts.push({
      detector,
      title:
        `Backend ${status ? `HTTP ${status}` : "error"} from ${method ?? "request"} ${route ?? ""}`.trim(),
      severity,
      score,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route,
        requestId,
        method,
        status,
        errorCode,
        message,
        source: "backend",
        frame: backendErrorFrame(error),
      }),
      // Key on requestId alone (not status): a thrown error event often carries no statusCode
      // while the response's end event carries e.g. 500 — including status would split one
      // request into two candidates. dedupeDrafts keeps the higher-scored error.
      dedupeKey: `backend:${requestId ?? event.t}`,
    });
  }
}

function addOtelErrorCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k === OTEL_SPAN_KIND) {
      const status = otelHttpStatus(event.d.attributes);
      const isError = event.d.statusCode === "ERROR" || (status ?? 0) >= 500;
      if (!isError) continue;
      const name = scrubText(event.d.name, 160);
      const service = safeText(event.d.serviceName, 80);
      const traceId = safeText(event.d.traceId, 120);
      drafts.push({
        detector: "otel_span_error",
        title: `OTel span error${status ? ` (HTTP ${status})` : ""}: ${name ?? "span"}${service ? ` [${service}]` : ""}`,
        severity: "high",
        score: 88,
        confidence: "high",
        anchor: removeUndefined({
          t: event.t,
          offsetMs:
            offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId: traceId,
          status,
          message:
            scrubText(event.d.statusMessage, 220) ?? scrubText(name, 220),
          source: service,
          frame: spanCodeFrame(event.d),
        }),
        dedupeKey: `otelspan:${safeText(event.d.spanId, 120) ?? event.t}:${event.d.statusCode ?? ""}:${status ?? ""}`,
      });
    } else if (event.k === OTEL_LOG_KIND) {
      const severityNumber = finiteNumber(event.d.severityNumber);
      const severityText = safeText(event.d.severityText, 40)?.toUpperCase();
      const isError =
        (severityNumber !== undefined && severityNumber >= 17) ||
        severityText === "ERROR" ||
        severityText === "FATAL";
      if (!isError) continue;
      const service = safeText(event.d.serviceName, 80);
      const traceId = safeText(event.d.traceId, 120);
      const body = scrubText(event.d.body, 100);
      drafts.push({
        detector: "otel_log_error",
        title: `OTel ${severityText ?? "error"} log: ${body ?? "message unavailable"}`,
        severity: "high",
        score: 80,
        confidence: "high",
        anchor: removeUndefined({
          t: event.t,
          offsetMs:
            offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId: traceId,
          message: scrubText(event.d.body, 220),
          source: service,
          frame: otelCodeFrame(event.d.attributes),
        }),
        dedupeKey: `otellog:${event.t}:${traceId ?? ""}:${body ?? ""}`,
      });
    }
  }
}

const DB_DIFF_ADJACENCY_MS = 5_000;

interface ErrorMoment {
  t: number;
  requestId?: string;
}

/**
 * How strongly a database write is tied to an error in the same session.
 *
 *  - `request`  the write and an error carry the SAME request id. Explicit
 *               correlation, the strongest link the capture can express.
 *  - `temporal` the write is inside {@link DB_DIFF_ADJACENCY_MS} of an error
 *               whose linkage cannot be decided, because one side or the other
 *               carries no request id. Suggestive, not established.
 *  - `none`     neither holds.
 */
type DbErrorLinkage = "request" | "temporal" | "none";

/**
 * One ranking table for both database planes. `db.diff` (row images) and
 * `otel_db_activity` (statements) describe the same writes from two capture
 * sources, so a reader comparing them must not see two different gradings of
 * the same linkage.
 */
const DB_LINKAGE_SEVERITY: Record<
  DbErrorLinkage,
  EvidenceCandidate["severity"]
> = {
  request: "high",
  temporal: "medium",
  none: "low",
};
const DB_LINKAGE_SCORE: Record<DbErrorLinkage, number> = {
  request: 88,
  temporal: 64,
  none: 40,
};
const DB_LINKAGE_CONFIDENCE: Record<
  DbErrorLinkage,
  EvidenceCandidate["confidence"]
> = {
  request: "high",
  temporal: "medium",
  none: "low",
};

/**
 * Grade a write against the session's error moments.
 *
 * The rule this replaced was `sameRequestId OR within 5s of any error`, which
 * made the time window an independent promoter: any write landing near an
 * error reached the top tier even when both sides carried request ids that
 * disagreed. In a real session a background job drain 2942ms after an unrelated
 * checkout error was lifted to `high`/88 on the time window alone.
 *
 * Two request ids that are both present and different are positive evidence of
 * NON linkage, not missing evidence, so the window must not override them. The
 * window survives only where correlation genuinely cannot be decided: one of
 * the two sides has no request id to compare. That is the whole change — a
 * write correlated to the error keeps the top tier, a write correlated AWAY
 * from it drops to the standalone tier, and only the undecidable middle sits
 * between them.
 *
 * Note what this deliberately does NOT do: it does not discriminate between
 * writes that share the error's request id. Inside one request the error
 * usually precedes every write, so temporal distance collapses to write order,
 * which application code chooses freely and which says nothing about which
 * write is at fault. Ranking on it produces confident nonsense — in the
 * duplicate redemption session it scored the two culprit `coupon_redemptions`
 * inserts BELOW the innocent `products` update, purely because checkout writes
 * coupons later. Discriminating inside a request is the job of a detector that
 * reads an observable property of the rows themselves.
 */
function gradeDbErrorLinkage(
  eventT: number,
  requestId: string | undefined,
  errorMoments: ErrorMoment[],
): DbErrorLinkage {
  let temporal = false;
  for (const moment of errorMoments) {
    if (
      requestId !== undefined &&
      moment.requestId !== undefined &&
      moment.requestId === requestId
    )
      return "request";
    const undecidable =
      requestId === undefined || moment.requestId === undefined;
    if (undecidable && Math.abs(moment.t - eventT) <= DB_DIFF_ADJACENCY_MS)
      temporal = true;
  }
  return temporal ? "temporal" : "none";
}

/**
 * Response bodies by browser network id, so a failed request can be judged
 * against what the server actually said.
 */
function responseBodyByRequestId(events: BugEvent[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const id = requestIdForEvent(event);
    if (id !== undefined) out.set(id, event.d.body);
  }
  return out;
}

/**
 * Failed requests that are a deliberate application outcome, keyed by browser
 * network id. Shared by the demotion pass and by error-moment collection: a 4xx
 * the app chose to return is not an error a nearby database write should be
 * graded against.
 */
function handledClientErrorRequestIds(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): Set<string> {
  const bodies = responseBodyByRequestId(events);
  const handled = new Set<string>();
  for (const failed of index.failedReqs ?? []) {
    const id = requestIdForValue(failed);
    if (id === undefined) continue;
    if (isHandledClientError(failed.st, bodies.get(id))) handled.add(id);
  }
  return handled;
}

function collectErrorMoments(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): ErrorMoment[] {
  const moments: ErrorMoment[] = [];
  const handled = handledClientErrorRequestIds(events, index);

  for (const event of events) {
    if (
      event.k === "net.res" &&
      finiteNumber(event.d.st) !== undefined &&
      (finiteNumber(event.d.st) ?? 0) >= 400
    ) {
      // A 4xx the application chose to return is an outcome, not a fault, so a
      // write that happens to sit beside it is not thereby suspicious.
      if (isHandledClientError(finiteNumber(event.d.st), event.d.body))
        continue;
      moments.push({ t: event.t, requestId: safeText(event.d.requestId, 120) });
    } else if (event.k === "err" || event.k === "rej") {
      moments.push({ t: event.t });
    } else if (
      event.k === "backend.req.error" ||
      event.k === "backend.uncaught"
    ) {
      // backend.uncaught carries no requestId; safeText returns undefined then.
      moments.push({ t: event.t, requestId: safeText(event.d.requestId, 120) });
    } else if (event.k === "net.err") {
      moments.push({ t: event.t });
    } else if (
      event.k === "con" &&
      safeText(event.d.lv, 20)?.toLowerCase().startsWith("err")
    ) {
      moments.push({ t: event.t });
    } else if (event.k === "backend.otel.span") {
      const status = otelHttpStatus(event.d.attributes);
      if (event.d.statusCode === "ERROR" || (status ?? 0) >= 500) {
        moments.push({
          t: event.t,
          requestId:
            safeText(event.d.traceId, 120) ?? safeText(event.d.requestId, 120),
        });
      }
    } else if (event.k === "backend.otel.log") {
      const severityNumber = finiteNumber(event.d.severityNumber);
      const severityText = safeText(event.d.severityText, 40)?.toUpperCase();
      if (
        (severityNumber !== undefined && severityNumber >= 17) ||
        severityText === "ERROR" ||
        severityText === "FATAL"
      ) {
        moments.push({ t: event.t, requestId: safeText(event.d.traceId, 120) });
      }
    }
  }

  for (const failed of index.failedReqs ?? []) {
    const id = requestIdForValue(failed);
    if (id !== undefined && handled.has(id)) continue;
    moments.push({ t: failed.t });
  }
  for (const entry of index.networkErrors ?? []) moments.push({ t: entry.t });
  for (const entry of index.consoleErrors ?? []) moments.push({ t: entry.t });
  for (const entry of index.errs ?? []) moments.push({ t: entry.t });

  return moments;
}

function addDbDiffCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const dbDiffs = events.filter((event) => event.k === "db.diff");
  if (dbDiffs.length === 0) return;

  // Maximum visibility: always surface db.diffs (the subtle data-correctness bugs a logger
  // most wants to catch). A diff correlated to an error by request id ranks high (88); one
  // merely near an error whose linkage cannot be decided ranks medium (64); a standalone diff
  // ranks low (40) so it never buries real errors but still appears — and, absent any error,
  // becomes ranked[0] so its evidence window covers the diff for fix-context.
  const errorMoments = collectErrorMoments(events, index);

  for (const event of dbDiffs) {
    const requestId = safeText(event.d.requestId, 120);
    const op = safeText(event.d.op, 20) ?? "mutation";
    const table = safeText(event.d.table, 200) ?? "unknown table";

    const linkage = gradeDbErrorLinkage(event.t, requestId, errorMoments);
    const label = scrubText(table, 100) ?? "table";

    drafts.push({
      detector: "db_mutation",
      title:
        linkage === "request"
          ? `Database ${op} on ${label} in a failed request`
          : linkage === "temporal"
            ? `Database ${op} on ${label} near an error`
            : `Database ${op} on ${label}`,
      severity: DB_LINKAGE_SEVERITY[linkage],
      score: DB_LINKAGE_SCORE[linkage],
      confidence: DB_LINKAGE_CONFIDENCE[linkage],
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        message: `${op} on ${table}`,
        source: normalizeDbEngine(event.d.engine),
      }),
      dedupeKey: `dbdiff:${event.t}:${requestId ?? ""}:${op}:${table}`,
    });
  }
}

// ─── Cross-plane invariant detectors (payload ↔ db.diff ↔ response) ───
//
// Both detectors operate per requestId on the correlated triple
// net.req ↔ net.res ↔ db.diff[] and are deliberately silent on ANY ambiguity:
// unparseable or legacy "[REDACTED]" bodies, fuzzy id matches, multi-column
// diffs, and composite pks all produce no signal rather than a guess.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/**
 * Id-like field names: exactly "id"/"ID", snake_case "*_id", or camelCase
 * "*Id" (case-SENSITIVE suffix so "paid"/"valid"/"grid" never match).
 */
const ID_EXACT = /^id$/i;
const ID_CAMEL_SUFFIX = /[a-z0-9]Id$/;
const ID_SNAKE_SUFFIX = /_id$/i;
function isIdLikeField(name: string): boolean {
  return (
    ID_EXACT.test(name) ||
    ID_CAMEL_SUFFIX.test(name) ||
    ID_SNAKE_SUFFIX.test(name)
  );
}
const QTY_LIKE_FIELD = /^(qty|quantity|count|units)$/i;
/** Field names whose values must never be echoed or reasoned about (deny-biased superset of the redaction v2 deny list). */
const SENSITIVE_INPUT_FIELD =
  /pass|pwd|token|secret|auth|key|card|cvv|cvc|ssn|social|email|phone|tel|address|account|iban|pin|otp|credential|session|cookie|bearer/i;
/**
 * Extensible stem→synonym map for ineffective_input. A payload field stem on the
 * left matches response fields / db.diff table names containing the stem itself
 * or any listed synonym.
 */
const INEFFECTIVE_INPUT_STEM_SYNONYMS: Readonly<
  Record<string, readonly string[]>
> = {
  coupon: ["discount", "redemption", "promo"],
  search: ["results"],
  query: ["results"],
};
const MAX_INEFFECTIVE_INPUT_CANDIDATES = 3;
const MAX_BODY_SCOPE_DEPTH = 6;

/** Parses a structured (JSON) network body. Legacy "[REDACTED]", non-JSON, or missing bodies → undefined (no evidence). */
function parseStructuredBody(value: unknown): unknown | undefined {
  if (isRecord(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text === "[REDACTED]") return undefined;
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for structured-redaction v2 placeholders
 * ({ $redacted: "[REDACTED]", len, charset, hash8? }). These are opaque
 * redacted leaves — their shape metadata must never be enumerated as if it
 * were payload data.
 */
function isRedactedPlaceholder(value: unknown): boolean {
  return isRecord(value) && "$redacted" in value;
}

/** Collects every object scope (top level plus array elements / nested objects) up to a bounded depth. Redacted-placeholder objects are opaque leaves. */
function collectObjectScopes(
  value: unknown,
  out: Record<string, unknown>[] = [],
  depth = 0,
): Record<string, unknown>[] {
  if (depth > MAX_BODY_SCOPE_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectScopes(item, out, depth + 1);
    return out;
  }
  if (!isRecord(value) || isRedactedPlaceholder(value)) return out;
  out.push(value);
  for (const inner of Object.values(value)) {
    if (isRecord(inner) || Array.isArray(inner)) {
      collectObjectScopes(inner, out, depth + 1);
    }
  }
  return out;
}

interface CorrelatedRequest {
  requestId: string;
  reqEvent: BugEvent;
  method: string;
  url?: string;
  body: unknown;
  resBody?: unknown;
  status?: number;
}

/** Maps requestId → mutating net.req (+ correlated net.res body/status). */
function collectMutatingRequests(
  events: BugEvent[],
): Map<string, CorrelatedRequest> {
  const requests = new Map<string, CorrelatedRequest>();
  // db.diff correlation runs on the propagated correlation id (d.requestId),
  // not the transport-local counter (d.id) — browser events carry both and the
  // counter never matches a diff. Legacy fixtures without d.requestId fall back
  // to the transport id so old sessions keep whatever correlation they had.
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const id = safeText(event.d.requestId, 120) ?? requestIdForEvent(event);
    if (!id) continue;
    const method = (
      safeText(event.d.m, 20) ??
      safeText(event.d.method, 20) ??
      ""
    ).toUpperCase();
    if (!MUTATING_METHODS.has(method)) continue;
    requests.set(id, {
      requestId: id,
      reqEvent: event,
      method,
      url: safeText(event.d.url, 400),
      body: event.d.body,
    });
  }
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const id = safeText(event.d.requestId, 120) ?? requestIdForEvent(event);
    if (!id) continue;
    const entry = requests.get(id);
    if (!entry) continue;
    entry.resBody = event.d.body;
    entry.status = finiteNumber(event.d.st);
  }
  return requests;
}

interface PayloadIdQty {
  idField: string;
  qtyField: string;
  qtySum: number;
  lines: number;
}

/**
 * Extracts unambiguous (id, qty) pairs from a structured payload. A scope
 * contributes only when it has EXACTLY one id-like and EXACTLY one qty-like
 * field; multiple payload lines targeting the same id are aggregated (summed).
 */
function extractIdQtyPairs(payload: unknown): Map<string, PayloadIdQty> {
  const pairs = new Map<string, PayloadIdQty>();
  for (const scope of collectObjectScopes(payload)) {
    const idEntries = Object.entries(scope).filter(
      ([name, value]) =>
        isIdLikeField(name) &&
        (typeof value === "string" || toFiniteNumber(value) !== undefined),
    );
    const qtyEntries = Object.entries(scope).filter(
      ([name, value]) =>
        QTY_LIKE_FIELD.test(name) && toFiniteNumber(value) !== undefined,
    );
    if (idEntries.length !== 1 || qtyEntries.length !== 1) continue;
    const [idField, idValue] = idEntries[0];
    const [qtyField, qtyValue] = qtyEntries[0];
    const qty = toFiniteNumber(qtyValue);
    if (qty === undefined || qty < 0) continue;
    const key = String(idValue);
    const existing = pairs.get(key);
    if (existing) {
      if (existing.idField !== idField || existing.qtyField !== qtyField) {
        // Conflicting field names for the same id — ambiguous, drop the id entirely.
        pairs.set(key, { idField, qtyField, qtySum: Number.NaN, lines: 0 });
        continue;
      }
      existing.qtySum += qty;
      existing.lines += 1;
    } else {
      pairs.set(key, { idField, qtyField, qtySum: qty, lines: 1 });
    }
  }
  for (const [key, value] of pairs) {
    if (!Number.isFinite(value.qtySum)) pairs.delete(key);
  }
  return pairs;
}

interface InterpretedDiff {
  event: BugEvent;
  table: string;
  column: string;
  delta: number;
}

/**
 * Interprets one db.diff as a single-numeric-column update for the given pk
 * value. Returns undefined when the diff does not target the pk; returns null
 * when it targets the pk but is ambiguous (composite pk, missing images, more
 * than one changed column, or a non-numeric change) — ambiguity silences the pk.
 */
function interpretDiffForPk(
  event: BugEvent,
  pkValue: string,
): InterpretedDiff | null | undefined {
  if (safeText(event.d.op, 20) !== "update") return undefined;
  const pk = event.d.pk;
  if (!isRecord(pk)) return undefined;
  const pkEntries = Object.entries(pk);
  const matches = pkEntries.some(([, value]) => String(value) === pkValue);
  if (!matches) return undefined;
  if (pkEntries.length !== 1) return null; // composite pk → ambiguous
  const before = event.d.before;
  const after = event.d.after;
  if (!isRecord(before) || !isRecord(after)) return null;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (String(before[key]) !== String(after[key])) changed.push(key);
  }
  if (changed.length !== 1) return null;
  const column = changed[0];
  const beforeNum = toFiniteNumber(before[column]);
  const afterNum = toFiniteNumber(after[column]);
  if (beforeNum === undefined || afterNum === undefined) return null;
  const table = safeText(event.d.table, 200) ?? "unknown table";
  // Signed per-diff delta; the aggregation takes |sum| so compensated writes net out.
  return { event, table, column, delta: afterNum - beforeNum };
}

/**
 * db_delta_mismatch: payload says "change by qty", the correlated db.diff changed a
 * single numeric column by a different amount. Exact-pairing only; silent on
 * any ambiguity. Uncapped — exact by construction.
 */
function addDbDeltaMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  mutatingRequests: Map<string, CorrelatedRequest>,
): void {
  const dbDiffs = events.filter((event) => event.k === "db.diff");
  if (dbDiffs.length === 0) return;
  const diffsByRequest = new Map<string, BugEvent[]>();
  for (const event of dbDiffs) {
    const requestId = safeText(event.d.requestId, 120);
    if (!requestId) continue;
    const list = diffsByRequest.get(requestId) ?? [];
    list.push(event);
    diffsByRequest.set(requestId, list);
  }

  for (const request of mutatingRequests.values()) {
    const diffs = diffsByRequest.get(request.requestId);
    if (!diffs || diffs.length === 0) continue;
    const payload = parseStructuredBody(request.body);
    if (payload === undefined) continue; // redacted/unparseable → no evidence
    for (const [pkValue, pair] of extractIdQtyPairs(payload)) {
      let ambiguous = false;
      const matched: InterpretedDiff[] = [];
      for (const diff of diffs) {
        const interpreted = interpretDiffForPk(diff, pkValue);
        if (interpreted === null) {
          ambiguous = true;
          break;
        }
        if (interpreted) matched.push(interpreted);
      }
      if (ambiguous || matched.length === 0) continue;
      // All matched diffs must describe the same table.column, otherwise the
      // summed delta mixes unrelated writes — ambiguous, stay silent.
      const table = matched[0].table;
      const column = matched[0].column;
      if (
        matched.some((diff) => diff.table !== table || diff.column !== column)
      )
        continue;
      // |sum of signed deltas|: compensated writes cancel; epsilon absorbs FP artifacts.
      const deltaSum = Math.abs(
        matched.reduce((sum, diff) => sum + diff.delta, 0),
      );
      if (Math.abs(deltaSum - pair.qtySum) <= 1e-9) continue;
      const anchorEvent = matched[0].event;
      // pkValue comes from a request payload — scrub and length-cap it before
      // echoing into human-readable draft text (same policy as other drafts).
      const safePk = scrubText(pkValue, 120) ?? "[REDACTED]";
      drafts.push({
        detector: "db_delta_mismatch",
        title: `DB delta mismatch: payload ${pair.qtyField}=${pair.qtySum} but ${table}.${column} changed by ${deltaSum}`,
        severity: "high",
        score: 72,
        confidence: "high",
        anchor: removeUndefined({
          t: anchorEvent.t,
          offsetMs:
            offsetForEvent(anchorEvent) ??
            offsetFromStart(anchorEvent.t, index.start),
          route: routeAt(index.navs ?? [], anchorEvent.t),
          requestId: request.requestId,
          method: request.method,
          url: redactUrl(request.url),
          message: `payload ${pair.idField}=${safePk} ${pair.qtyField}=${pair.qtySum} (${pair.lines} line${pair.lines === 1 ? "" : "s"}) vs ${table}.${column} |after−before|=${deltaSum}`,
          source: normalizeDbEngine(anchorEvent.d.engine),
        }),
        dedupeKey: `dbdelta:${request.requestId}:${pkValue}:${table}:${column}`,
      });
    }
  }
}

// ─── Per-request db.diff invariant detectors ──────────────────────────────
//
// Both read one request's whole `db.diff` set rather than a single diff, and
// both are deliberately silent on ambiguity. They exist because the generic
// `db_mutation` surfacing says only "a write happened", which cannot tell a
// reader WHICH of eight writes in a failed request is the bug. These name the
// bug from a property of the rows themselves, so they are scored above the
// `db_mutation` ceiling of 88: a reader working the ranked list downward must
// reach the named invariant violation before the generic plane dump.

const DB_INVARIANT_SCORE = 90;

/** Group a session's `db.diff` events by request id. Diffs with no request id are dropped: every rule here is per request, and an uncorrelated diff cannot join one. */
function dbDiffsByRequest(events: BugEvent[]): Map<string, BugEvent[]> {
  const byRequest = new Map<string, BugEvent[]>();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    const requestId = safeText(event.d.requestId, 120);
    if (!requestId) continue;
    const list = byRequest.get(requestId) ?? [];
    list.push(event);
    byRequest.set(requestId, list);
  }
  return byRequest;
}

/** Field names that identify or timestamp a row rather than carry a value. Comparing them across two rows is meaningless: they are SUPPOSED to differ. */
function isIdentityOrClockField(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "id" ||
    lower.endsWith("_id") ||
    lower.endsWith("id") ||
    lower.endsWith("_at") ||
    lower.endsWith("_on") ||
    lower.includes("timestamp") ||
    lower.includes("created") ||
    lower.includes("updated") ||
    lower === "uuid" ||
    lower === "guid"
  );
}

/**
 * A value that can stand as a key, canonicalized for comparison. Only scalars
 * qualify: a db.diff after image renders a Date as `{}`, and two of those
 * stringify alike, so `String(value)` on arbitrary content invents key matches
 * out of structural noise. Booleans are excluded for the same reason — nothing
 * joins on `true`.
 */
function keyValueOf(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
  }
  return undefined;
}

/** The pk of a diff as `[column, value]` pairs, scalar values only. */
function pkEntriesOf(event: BugEvent): Array<[string, string]> {
  const pk = event.d.pk;
  if (!isRecord(pk)) return [];
  const entries: Array<[string, string]> = [];
  for (const [column, raw] of Object.entries(pk)) {
    const value = keyValueOf(raw);
    if (value !== undefined) entries.push([column, value]);
  }
  return entries;
}

/** The bare table name: `"public"."order_items"` → `order_items`. */
function bareTableName(table: string): string {
  const segments = table.split(".");
  return segments[segments.length - 1] ?? table;
}

/** Lowercased and stripped of separators, so `order_items` and `OrderItems` compare equal. */
function normalizeEntityName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A rough singular form, used ONLY to compare a foreign key column's prefix
 * with a table name. Both sides pass through it, so a word it mangles
 * (`status` → `statu`) still matches itself; the function has to be consistent,
 * not linguistically correct.
 */
function singularize(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * The entity a foreign key column names: `product_id` → `product`,
 * `productId` → `product`. Returns undefined for a column that identifies THIS
 * row rather than referencing another (`id`, `uuid`), and for every column that
 * is not a key at all.
 */
function foreignKeyEntity(column: string): string | undefined {
  const match = /^(.+?)(?:_id|_uuid|Id|ID|Uuid|UUID)$/.exec(column.trim());
  if (!match) return undefined;
  const entity = normalizeEntityName(match[1]);
  return entity.length > 0 ? singularize(entity) : undefined;
}

/** Does this column name a reference to that table? `product_id` → `products`. */
function columnReferencesTable(column: string, table: string): boolean {
  const entity = foreignKeyEntity(column);
  if (entity === undefined) return false;
  return entity === singularize(normalizeEntityName(bareTableName(table)));
}

/** One row's foreign key reference to another row. */
interface RowLinkage {
  /** The row carrying the foreign key. */
  child: BugEvent;
  /** The row whose primary key it references. */
  parent: BugEvent;
  /** The foreign key column on the child, e.g. `product_id`. */
  column: string;
  /** The primary key column it resolves to on the parent, e.g. `id`. */
  parentColumn: string;
}

/**
 * Does `from` carry a foreign key to `target`?
 *
 * The column name has to NAME the target table. Matching on value alone —
 * "some value in this row equals some primary key of that row" — is what made
 * this detector report a live two-line checkout as a bug: on a freshly seeded
 * store every table's key sequence starts at 1, so `order_items.order_id=1`
 * collided with `products.id=1` and linked a line item to a product it has
 * nothing to do with. Requiring `product_id` to be the column that reaches
 * `products` is the difference between a join and a coincidence.
 *
 * The pk is searched alongside the after image because a composite key can BE
 * the foreign key (`order_items` keyed by `{order_id, product_id}`).
 */
function foreignKeyLinkTo(
  from: BugEvent,
  target: BugEvent,
): { column: string; parentColumn: string } | undefined {
  const targetTable = safeText(target.d.table, 200);
  if (!targetTable) return undefined;
  const targetPk = pkEntriesOf(target);
  if (targetPk.length === 0) return undefined;
  const after = from.d.after;
  const columns: Array<[string, unknown]> = [
    ...(isRecord(from.d.pk) ? Object.entries(from.d.pk) : []),
    ...(isRecord(after) ? Object.entries(after) : []),
  ];

  for (const [column, raw] of columns) {
    if (!columnReferencesTable(column, targetTable)) continue;
    const value = keyValueOf(raw);
    if (value === undefined) continue;
    // A single-column key is unambiguous. A composite one is not: the foreign
    // key has to say WHICH column it means, or the match is a guess.
    const candidates =
      targetPk.length === 1
        ? targetPk
        : targetPk.filter(
            ([key]) => key.toLowerCase() === column.toLowerCase(),
          );
    const hit = candidates.find(([, targetValue]) => targetValue === value);
    if (hit) return { column, parentColumn: hit[0] };
  }
  return undefined;
}

/**
 * Are these two rows joined by a foreign key, and in which direction?
 *
 * This is the whole guard against comparing unrelated rows that happen to share
 * a column name — two different customers' `orders` rows both have a
 * `total_cents` and are supposed to differ.
 */
function linkRows(left: BugEvent, right: BugEvent): RowLinkage | undefined {
  const leftToRight = foreignKeyLinkTo(left, right);
  if (leftToRight) return { child: left, parent: right, ...leftToRight };
  const rightToLeft = foreignKeyLinkTo(right, left);
  if (rightToLeft) return { child: right, parent: left, ...rightToLeft };
  return undefined;
}

/** Cites the join a candidate rests on, so a reader can check it rather than take it. */
function describeLinkage(linkage: RowLinkage): string {
  const childTable = safeText(linkage.child.d.table, 200) ?? "?";
  const parentTable = safeText(linkage.parent.d.table, 200) ?? "?";
  return `${childTable}.${linkage.column} = ${parentTable}.${linkage.parentColumn}`;
}

/** Two rows of one request joined by a foreign key, kept in write order. */
interface LinkedRowPair {
  /** The two rows in the order they were written, so messages read chronologically. */
  first: BugEvent;
  second: BugEvent;
  linkage: RowLinkage;
}

/**
 * Every foreign key join among one request's rows.
 *
 * Guards shared by both rules below:
 *  - both rows must carry a record `after` image;
 *  - the rows must be in DIFFERENT tables. Two rows of one table are siblings,
 *    not a contradiction, and are supposed to hold different values;
 *  - they must be joined by a real foreign key (see {@link linkRows}).
 */
function linkedRowPairs(diffs: BugEvent[]): LinkedRowPair[] {
  const pairs: LinkedRowPair[] = [];
  for (let i = 0; i < diffs.length; i += 1) {
    for (let j = i + 1; j < diffs.length; j += 1) {
      const first = diffs[i];
      const second = diffs[j];
      const firstTable = safeText(first.d.table, 200);
      const secondTable = safeText(second.d.table, 200);
      if (!firstTable || !secondTable || firstTable === secondTable) continue;
      if (!isRecord(first.d.after) || !isRecord(second.d.after)) continue;
      const linkage = linkRows(first, second);
      if (!linkage) continue;
      pairs.push({ first, second, linkage });
    }
  }
  return pairs;
}

/**
 * db_field_divergence: two rows joined by a foreign key and written by ONE
 * request hold contradictory values.
 *
 * Two rules, each with its own guards:
 *  - {@link addSharedFieldDivergence} — the rows disagree on the SAME named
 *    field;
 *  - {@link addSettlementDivergence} — a settlement row does not match the
 *    total of the row it settles, under different column names.
 */
function addDbFieldDivergenceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    if (diffs.length < 2) continue;
    const pairs = linkedRowPairs(diffs);
    for (const pair of pairs)
      addSharedFieldDivergence(pair, requestId, index, drafts);
    addSettlementDivergence(pairs, requestId, index, drafts);
  }
}

/**
 * Two linked rows disagree about the same named value.
 *
 * The real case: a checkout wrote `products.price_cents=8900` and
 * `order_items.price_cents=7900` in one request, the order_items row
 * referencing the products row. Two prices for one product, written together,
 * neither one wrong on its own. No existing detector reads the `db.diff` set
 * as a set, so the candidate list was identical to the clean control's.
 *
 * Silent on ambiguity, beyond the shared guards in {@link linkedRowPairs}:
 *  - the shared field must name a value, not an identity or a clock;
 *  - both values must be finite numbers. A string field disagreeing is not
 *    reliably a contradiction — two rows can legitimately hold different
 *    labels for one entity.
 */
function addSharedFieldDivergence(
  pair: LinkedRowPair,
  requestId: string,
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const { first, second, linkage } = pair;
  const firstTable = safeText(first.d.table, 200);
  const secondTable = safeText(second.d.table, 200);
  const firstAfter = first.d.after;
  const secondAfter = second.d.after;
  if (!firstTable || !secondTable) return;
  if (!isRecord(firstAfter) || !isRecord(secondAfter)) return;

  for (const field of Object.keys(firstAfter)) {
    if (!(field in secondAfter)) continue;
    if (isIdentityOrClockField(field)) continue;
    const firstValue = toFiniteNumber(firstAfter[field]);
    const secondValue = toFiniteNumber(secondAfter[field]);
    if (firstValue === undefined || secondValue === undefined) continue;
    if (firstValue === secondValue) continue;

    const anchorEvent = first.t <= second.t ? first : second;
    drafts.push({
      detector: "db_field_divergence",
      title: `Linked rows disagree on ${field}: ${firstTable}.${field}=${firstValue} but ${secondTable}.${field}=${secondValue} in one request`,
      severity: "high",
      score: DB_INVARIANT_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: anchorEvent.t,
        offsetMs:
          offsetForEvent(anchorEvent) ??
          offsetFromStart(anchorEvent.t, index.start),
        route: routeAt(index.navs ?? [], anchorEvent.t),
        requestId,
        message: `${firstTable}.${field}=${firstValue} vs ${secondTable}.${field}=${secondValue} (rows linked by ${describeLinkage(linkage)}, written by request ${requestId})`,
        source: normalizeDbEngine(anchorEvent.d.engine),
      }),
      // Table pair is ordered so the key does not depend on diff order.
      dedupeKey: `dbfielddiv:${requestId}:${field}:${[firstTable, secondTable].sort().join("|")}`,
    });
  }
}

/**
 * Tables whose rows SETTLE the row they reference rather than compose it. A
 * payment is supposed to equal the order total; a coupon redemption, a tax line
 * or an order item carries the same `amount_cents` column and the same
 * `order_id` foreign key and is supposed to DIFFER from it. Nothing in a column
 * name separates those two cases, so the table name has to, and the list is
 * deliberately short: a table not on it is read as a component, which is the
 * silent answer.
 */
const SETTLEMENT_TABLES = new Set([
  "payment",
  "paymentintent",
  "charge",
  "capture",
  "settlement",
  "receipt",
]);

function isSettlementTable(table: string): boolean {
  return SETTLEMENT_TABLES.has(
    singularize(normalizeEntityName(bareTableName(table))),
  );
}

/** Currency and scale suffixes. `total_cents` and `total_usd` are not the same quantity. */
const MONEY_UNIT_SUFFIXES = [
  "cents",
  "cent",
  "minor",
  "micros",
  "usd",
  "eur",
  "gbp",
];

/**
 * Splits a money column into the quantity it names and the unit it is in:
 * `total_cents` → base `total`, unit `cents`. An unsuffixed column has unit "".
 */
function splitMoneyColumn(column: string): { base: string; unit: string } {
  const normalized = normalizeEntityName(column);
  for (const unit of MONEY_UNIT_SUFFIXES) {
    if (normalized.length > unit.length && normalized.endsWith(unit)) {
      return { base: normalized.slice(0, -unit.length), unit };
    }
  }
  return { base: normalized, unit: "" };
}

/**
 * Column bases that name what a row is worth IN FULL, on either side of a
 * settlement.
 *
 * Deliberately excluded, because each is SUPPOSED to differ from a total:
 * `subtotal` (pre-tax by definition), `balance` (what is left after paying),
 * `price` (a unit price), and every component — tax, discount, shipping, fee.
 */
const SETTLEMENT_MONEY_BASES = new Set([
  "total",
  "grandtotal",
  "ordertotal",
  "totalamount",
  "totaldue",
  "amountdue",
  "amount",
  "amountpaid",
  "amountcaptured",
  "amountcharged",
  "paidamount",
  "chargedamount",
]);

/** The money value a row states it is worth in full, if it states one. */
function settlementMoneyOf(
  after: Record<string, unknown>,
): { column: string; unit: string; value: number } | undefined {
  for (const [column, raw] of Object.entries(after)) {
    if (isIdentityOrClockField(column)) continue;
    const { base, unit } = splitMoneyColumn(column);
    if (!SETTLEMENT_MONEY_BASES.has(base)) continue;
    const value = toFiniteNumber(raw);
    if (value === undefined) continue;
    return { column, unit, value };
  }
  return undefined;
}

/**
 * A settlement row does not match the total of the row it settles.
 *
 * The real case: one checkout request wrote `orders.total_cents=70894` and
 * `payments.amount_cents=60500` against it. A genuine divergence over a real
 * join key, and invisible to every DB-plane rule the pipeline had: the columns
 * are named differently, so {@link addSharedFieldDivergence} cannot compare
 * them, and each row is internally consistent, so nothing else names it either.
 * It reached the reader only because the application happened to call
 * `console.warn` — delete that one log line and the underpayment disappeared
 * from the ranking entirely.
 *
 * Silent on ambiguity, beyond the shared guards in {@link linkedRowPairs}:
 *  - the child must be a settlement row (see {@link SETTLEMENT_TABLES}), not a
 *    component of the parent's total;
 *  - exactly ONE settlement row of that table may reference the parent in this
 *    request. A split payment or an installment settles a total across several
 *    rows, and no single one of them is supposed to equal it;
 *  - both columns must name a full amount (see {@link SETTLEMENT_MONEY_BASES})
 *    in the SAME unit;
 *  - the two columns must be named differently — an identical name is
 *    {@link addSharedFieldDivergence}'s to report, and reporting it here too
 *    would say one thing twice.
 *
 * Confidence is `medium`, not `high`: within a single request a deliberate
 * deposit or partial capture is indistinguishable from an underpayment. The
 * score stays at {@link DB_INVARIANT_SCORE} regardless, because a finding a
 * reader never reaches is worth nothing — below the `db_mutation` ceiling of 88
 * this would rank under the generic dump of the very writes it is about.
 */
function addSettlementDivergence(
  pairs: LinkedRowPair[],
  requestId: string,
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const rowIdentity = (event: BugEvent): string =>
    `${safeText(event.d.table, 200) ?? "?"}#${pkEntriesOf(event)
      .map(([column, value]) => `${column}=${value}`)
      .join(",")}`;

  // How many rows of one table settle a given parent row. Counted across the
  // whole request before any of them is judged: a second payment is what makes
  // the first one uncomparable.
  const settlementCounts = new Map<string, number>();
  for (const { linkage } of pairs) {
    const childTable = safeText(linkage.child.d.table, 200);
    if (!childTable || !isSettlementTable(childTable)) continue;
    const key = `${rowIdentity(linkage.parent)}|${childTable}`;
    settlementCounts.set(key, (settlementCounts.get(key) ?? 0) + 1);
  }

  for (const { linkage } of pairs) {
    const { child, parent } = linkage;
    const childTable = safeText(child.d.table, 200);
    const parentTable = safeText(parent.d.table, 200);
    if (!childTable || !parentTable) continue;
    if (!isSettlementTable(childTable)) continue;
    if (settlementCounts.get(`${rowIdentity(parent)}|${childTable}`) !== 1)
      continue;

    const childAfter = child.d.after;
    const parentAfter = parent.d.after;
    if (!isRecord(childAfter) || !isRecord(parentAfter)) continue;
    const settled = settlementMoneyOf(childAfter);
    const owed = settlementMoneyOf(parentAfter);
    if (!settled || !owed) continue;
    if (settled.unit !== owed.unit) continue;
    if (settled.column === owed.column) continue;
    if (settled.value === owed.value) continue;

    const anchorEvent = child.t <= parent.t ? child : parent;
    drafts.push({
      detector: "db_field_divergence",
      title: `Linked rows disagree on the amount owed: ${parentTable}.${owed.column}=${owed.value} but ${childTable}.${settled.column}=${settled.value} in one request`,
      severity: "high",
      score: DB_INVARIANT_SCORE,
      confidence: "medium",
      anchor: removeUndefined({
        t: anchorEvent.t,
        offsetMs:
          offsetForEvent(anchorEvent) ??
          offsetFromStart(anchorEvent.t, index.start),
        route: routeAt(index.navs ?? [], anchorEvent.t),
        requestId,
        message: `${parentTable}.${owed.column}=${owed.value} vs ${childTable}.${settled.column}=${settled.value} (rows linked by ${describeLinkage(linkage)}, written by request ${requestId})`,
        source: normalizeDbEngine(anchorEvent.d.engine),
      }),
      dedupeKey: `dbsettlement:${requestId}:${[`${parentTable}.${owed.column}`, `${childTable}.${settled.column}`].sort().join("|")}`,
    });
  }
}

/**
 * A money column, by name. Deliberately narrow: this detector reports a trust
 * boundary violation, and the cost of a false positive on a non-money column is
 * an engineer chasing a value the client was always allowed to choose.
 */
function looksLikeMoneyField(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith("_cents") ||
    lower.includes("amount") ||
    lower.includes("total") ||
    lower.includes("price") ||
    lower.includes("subtotal") ||
    lower.includes("balance")
  );
}

/**
 * Smallest client value worth matching. Carts are full of 1s and 2s — a qty of
 * 1 colliding with a money column that happens to hold 1 is noise, and cents
 * amounts that low are not real money.
 */
const MIN_CLIENT_SUPPLIED_VALUE = 100;

/** Every finite number anywhere in a parsed request body, with its key path. */
function collectNumbersByPath(
  value: unknown,
  path: string,
  out: Map<number, string>,
  depth = 0,
): void {
  if (depth > 6) return;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !out.has(value)) out.set(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) =>
      collectNumbersByPath(entry, `${path}[${i}]`, out, depth + 1),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collectNumbersByPath(
        entry,
        path ? `${path}.${key}` : key,
        out,
        depth + 1,
      );
    }
  }
}

/**
 * db_client_supplied_value: a money value from the request body is persisted
 * verbatim by the same request.
 *
 * The real case: a checkout posted `{"total":23319,...}` and `orders.total_cents`
 * came back as exactly 23319 — the price the CLIENT named, stored as though the
 * server had computed it. Nothing in the session looks broken from any single
 * plane: the write succeeds, the response is 200, and the row is internally
 * consistent. Only the pairing of body and diff shows the server never did the
 * arithmetic. db_field_divergence cannot see it (that needs two linked rows
 * disagreeing on a SHARED field name), and ui_arithmetic_mismatch cannot either
 * (each rendered region is self-consistent).
 *
 * Silent on ambiguity, by these guards:
 *  - body and diff must share a request id — a value echoed by some other
 *    request is not evidence it crossed this trust boundary;
 *  - the body must parse as JSON; redacted or opaque bodies say nothing;
 *  - the persisted column must name money. product_id and qty coming from the
 *    client is the entire point of a cart;
 *  - the column must not be an identity or a clock;
 *  - the value must be >= MIN_CLIENT_SUPPLIED_VALUE, so cart-sized integers do
 *    not collide their way into a high-severity finding.
 */
function addClientSuppliedValueCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  mutatingRequests: Map<string, CorrelatedRequest>,
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    const request = mutatingRequests.get(requestId);
    if (!request) continue;

    const raw = typeof request.body === "string" ? request.body : undefined;
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // redacted, truncated, or not JSON — say nothing
    }
    const clientNumbers = new Map<number, string>();
    collectNumbersByPath(parsed, "", clientNumbers);
    if (clientNumbers.size === 0) continue;

    for (const diff of diffs) {
      const table = safeText(diff.d.table, 200);
      const after = diff.d.after;
      if (!table || !isRecord(after)) continue;

      for (const [field, rawValue] of Object.entries(after)) {
        if (isIdentityOrClockField(field)) continue;
        if (!looksLikeMoneyField(field)) continue;
        const value = toFiniteNumber(rawValue);
        if (value === undefined) continue;
        if (Math.abs(value) < MIN_CLIENT_SUPPLIED_VALUE) continue;
        const bodyPath = clientNumbers.get(value);
        if (bodyPath === undefined) {
          const roundedClientValue = [...clientNumbers.entries()].find(
            ([clientValue, clientPath]) =>
              !Number.isInteger(clientValue) &&
              Math.round(clientValue) === value &&
              field.toLowerCase().endsWith("_cents") &&
              looksLikeMoneyField(clientPath),
          );
          if (!roundedClientValue) continue;
          const [clientValue, clientPath] = roundedClientValue;
          drafts.push({
            detector: "fractional_cent_rounding",
            title: `Fractional cents rounded at persistence: request body ${clientPath}=${clientValue} became ${table}.${field}=${value}`,
            severity: "high",
            score: DB_INVARIANT_SCORE,
            confidence: "high",
            anchor: removeUndefined({
              t: diff.t,
              offsetMs:
                offsetForEvent(diff) ??
                offsetFromStart(diff.t, index.start),
              route: routeAt(index.navs ?? [], diff.t),
              requestId,
              message:
                `${request.method} ${request.url ?? ""} sent the non-integer cent value ${clientPath}=${clientValue}; ${table}.${field} stored Math.round(${clientValue})=${value} (request ${requestId})`.trim(),
              source: normalizeDbEngine(diff.d.engine),
            }),
            dedupeKey: `fractionalcents:${requestId}:${table}:${field}`,
          });
          continue;
        }

        drafts.push({
          detector: "db_client_supplied_value",
          title: `Client-supplied value persisted: request body ${bodyPath}=${value} written to ${table}.${field} unchanged`,
          severity: "high",
          score: DB_INVARIANT_SCORE,
          confidence: "high",
          anchor: removeUndefined({
            t: diff.t,
            offsetMs:
              offsetForEvent(diff) ?? offsetFromStart(diff.t, index.start),
            route: routeAt(index.navs ?? [], diff.t),
            requestId,
            message:
              `${request.method} ${request.url ?? ""} sent ${bodyPath}=${value}; ${table}.${field} stored ${value} (request ${requestId})`.trim(),
            source: normalizeDbEngine(diff.d.engine),
          }),
          dedupeKey: `dbclientvalue:${requestId}:${table}:${field}`,
        });
      }
    }
  }
}

/** Cap on columns re-shipped as duplicate-write evidence. */
const MAX_COMPARED_COLUMNS = 24;

/**
 * Whether a column name points at a parent row rather than identifying this
 * one. Every child row written by one request shares its parent's key: the
 * three `order_items` of a single order all carry the same `order_id`, so a
 * match on that column alone says they belong to one order, which we already
 * knew from the request id.
 */
function looksLikeForeignKey(column: string): boolean {
  return /(^|_)id$|Id$/.test(column);
}

/**
 * A column that carries row STATE rather than row identity: lifecycle enums,
 * money and quantity magnitudes, flags. Two different rows sharing state is
 * ordinary — eight bulk-created orders legitimately share
 * {status: "placed", total_cents: N} — so state columns cannot anchor a
 * duplicate-write claim. Anything else (a foreign key, a coupon code, a
 * tracking number, a name) is treated as identifying. Deny-listing state is
 * deliberate over allow-listing identity: business keys are unenumerable,
 * and an unknown column wrongly treated as identifying costs one candidate,
 * while one wrongly treated as state silences a real duplicate.
 */
function looksLikeStateColumn(column: string): boolean {
  return (
    /(^|_)(status|state|type|kind|phase|stage|flag|enabled|active|visible|archived)$/i.test(
      column,
    ) ||
    /(^|_)(amount|total|price|cost|balance|qty|quantity|count|cents)(_cents|_amount)?s?$/i.test(
      column,
    )
  );
}

/**
 * True for a column the database fills in on write — a row timestamp. These are
 * generated, exactly like the primary key, so two writes of the same row differ
 * there for the same uninteresting reason and identity must not rest on them.
 *
 * Load bearing for determinism: a retry storm that lands both inserts inside one
 * millisecond would otherwise be reported while the identical storm a
 * millisecond slower is not, making the detector a coin flip on machine speed.
 * The value is still captured and still shipped in the after image — it is
 * evidence a reader wants, just not evidence of sameness.
 */
function looksLikeGeneratedTimestamp(column: string): boolean {
  return /^(created|updated|modified|inserted|deleted)_?(at|on|time|timestamp)$|^(timestamp|created|updated)$/i.test(
    column,
  );
}

/**
 * The comparable content of an insert: its after image minus the columns the
 * database generated (the primary key and row timestamps), canonicalized so two
 * rows written in either key order compare equal. Dropping timestamps is what
 * makes the verdict deterministic; see {@link looksLikeGeneratedTimestamp}.
 *
 * Returns undefined when nothing DISCRIMINATING survives the pk drop, because a
 * signature that cannot tell two different rows apart cannot be evidence that
 * they are one row written twice. Four cases are rejected:
 *
 *  - A column arrived structurally empty (`{}` / `[]`). That is a value the
 *    capture could not represent, not a value the row does not have: a Date, a
 *    Buffer, or a driver wrapper renders that way. The rows may well differ
 *    exactly there, so identity is UNKNOWN and the detector must stay silent
 *    rather than claim a match from the columns that happen to have survived.
 *    A live run reported eight genuinely distinct orders as "6 identical rows"
 *    because an unserializable `created_at` had reduced to `{}` on every one.
 *    A scalar `null` or `""` is NOT this case — that is a real captured value,
 *    and nullable columns are far too common to treat as evidence loss.
 *
 *  - Nothing survives. The clean control run inserts two `shipments` rows whose
 *    after images are `{id: …}` alone, so they reduce to `{}` and a naive
 *    "identical inserts" rule fires on the control.
 *  - The only surviving column is a foreign key. A live run reported three
 *    demonstrably different `order_items` rows (different product, quantity and
 *    price) as "3 identical rows" because the captured after image had reduced
 *    to `{id, order_id}` and every row of one order shares `order_id`. A
 *    partial capture must read as unknown, never as a duplicate.
 */
function insertSignature(event: BugEvent): string | undefined {
  return comparedInsertColumns(event)?.signature;
}

/**
 * The signature plus the entries it rests on, so a detector can ship the
 * evidence for its own claim rather than asserting it.
 */
function comparedInsertColumns(
  event: BugEvent,
): { signature: string; entries: Array<[string, unknown]> } | undefined {
  const after = event.d.after;
  if (!isRecord(after)) return undefined;
  const pkKeys = isRecord(event.d.pk) ? new Set(Object.keys(event.d.pk)) : null;
  const entries = Object.entries(after)
    .filter(([key]) => !pkKeys?.has(key) && !looksLikeGeneratedTimestamp(key))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
  if (entries.some(([, value]) => isUnrepresentedValue(value)))
    return undefined;
  if (entries.every(([, value]) => isZeroOrEmpty(value))) return undefined;
  if (entries.length === 1 && looksLikeForeignKey(entries[0][0]))
    return undefined;
  return { signature: JSON.stringify(entries), entries };
}

/** Re-scrubs an after image for re-shipping inside a candidate anchor. */
function sharedAfterImageOf(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries.slice(0, MAX_COMPARED_COLUMNS)) {
    out[key] = typeof value === "string" ? scrubText(value, 200) : value;
  }
  return out;
}

/**
 * duplicate_write: one request inserted the same row into one table more than
 * once.
 *
 * The real case: a retry storm with no idempotency key wrote two identical
 * `coupon_redemptions` rows for one order under a single request id. Both rows
 * are individually valid, so nothing else in the pipeline names them.
 *
 * Identity is the after image minus the primary key — a duplicate differs only
 * by whatever the database generated. See {@link insertSignature} for the
 * non trivial guard that keeps this silent on the clean control.
 */
function addDuplicateWriteCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    // table → signature → the inserts sharing it
    const byTable = new Map<string, Map<string, BugEvent[]>>();
    // signature → the entries that produced it, so the emitted candidate can
    // carry the compared columns without recomputing them.
    const entriesBySignature = new Map<string, Array<[string, unknown]>>();
    for (const event of diffs) {
      if (safeText(event.d.op, 20) !== "insert") continue;
      const table = safeText(event.d.table, 200);
      if (!table) continue;
      const compared = comparedInsertColumns(event);
      if (compared === undefined) continue;
      entriesBySignature.set(compared.signature, compared.entries);
      const signatures = byTable.get(table) ?? new Map<string, BugEvent[]>();
      const group = signatures.get(compared.signature) ?? [];
      group.push(event);
      signatures.set(compared.signature, group);
      byTable.set(table, signatures);
    }

    for (const [table, signatures] of byTable) {
      for (const [signature, group] of signatures) {
        if (group.length < 2) continue;
        const entries = entriesBySignature.get(signature) ?? [];
        // "The same row written twice" is a claim about identity, and identity
        // needs an anchor: some non-null, non-boolean column that is not mere
        // row STATE. A bulk insert of eight orders sharing only
        // {status: "placed", total_cents: 35700, user_id: null} matches on
        // everything captured and is still eight different orders — while two
        // coupon_redemptions sharing a non-null order_id and code are one
        // redemption written twice. Without the anchor, stay silent: a partial
        // capture reads as unknown, never as a duplicate.
        const hasEntityAnchor = entries.some(
          ([key, value]) =>
            value !== null &&
            value !== undefined &&
            value !== "" &&
            typeof value !== "boolean" &&
            !looksLikeStateColumn(key),
        );
        if (!hasEntityAnchor) continue;
        const anchorEvent = group.reduce((earliest, event) =>
          event.t < earliest.t ? event : earliest,
        );
        const label = scrubText(table, 100) ?? "table";
        const columns = entries.map(([key]) => key);
        drafts.push({
          detector: "duplicate_write",
          title: `Duplicate write: ${group.length} identical rows inserted into ${label} in one request`,
          severity: "high",
          score: DB_INVARIANT_SCORE,
          confidence: "high",
          anchor: removeUndefined({
            t: anchorEvent.t,
            offsetMs:
              offsetForEvent(anchorEvent) ??
              offsetFromStart(anchorEvent.t, index.start),
            route: routeAt(index.navs ?? [], anchorEvent.t),
            requestId,
            // Name the columns the claim rests on. "share one after image" alone
            // sent a reader looking for row data the bundle never carried.
            message: `${group.length} inserts into ${table} in request ${requestId} match on every non-key column captured (${columns.join(", ")})`,
            source: normalizeDbEngine(anchorEvent.d.engine),
            comparedColumns: columns.slice(0, MAX_COMPARED_COLUMNS),
            sharedAfterImage: sharedAfterImageOf(entries),
          }),
          dedupeKey: `dupwrite:${requestId}:${table}:${signature}`,
        });
      }
    }
  }
}

/**
 * The literal fingerprints an interpolation bug leaves in rendered text: a
 * JavaScript value that was never looked up ("undefined"), never a number
 * ("NaN"), never stringified ("[object Object]"), or a template that was never
 * rendered at all ({{name}}, ${name}). Word-bounded so "undefined_behavior" in
 * prose does not match. "null" is deliberately absent: a whole-column null is
 * an ordinary database value, and the word appears in legitimate text far too
 * often to anchor a high-confidence claim.
 */
const INTERPOLATION_ARTIFACT_PATTERN =
  /\bundefined\b|\bNaN\b|\[object Object\]|\{\{\s*[\w.]+\s*\}\}|\$\{[\w.]+\}/;

/** First artifact match in a string value, for the candidate's own evidence. */
function interpolationArtifactIn(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return INTERPOLATION_ARTIFACT_PATTERN.exec(value)?.[0] ?? undefined;
}

/**
 * interpolation_artifact: persisted text carries a template-rendering fault.
 *
 * The real case: a notification row stored
 * `subject: "Hi undefined, your order #1 was cancelled"` — the template
 * rendered, the row inserted, the mail queued, every status code 200. The
 * defect is visible ONLY in the value itself, which makes it invisible to
 * every structural detector and glaring to this one. These fingerprints are
 * near-zero-entropy: real user text containing a word-bounded "undefined" or
 * an unrendered "{{name}}" exists, but a ROW WRITTEN BY THE APP containing one
 * is an interpolation bug until proven otherwise.
 *
 * Scans both planes that carry persisted values — db.diff after images
 * (writes) and db.read rows (reads) — because the write that stored the broken
 * text often happened in an earlier request or a job, and the session at hand
 * only ever reads it back. One candidate per table+column, anchored at the
 * first sighting.
 */
function addInterpolationArtifactCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.k !== "db.diff" && event.k !== "db.read") continue;
    const table = safeText(event.d.table, 200);
    if (!table) continue;
    const image = event.k === "db.diff" ? event.d.after : event.d.row;
    if (!isRecord(image)) continue;
    for (const [column, value] of Object.entries(image)) {
      const artifact = interpolationArtifactIn(value);
      if (artifact === undefined) continue;
      const key = `${table}:${column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const requestId = safeText(event.d.requestId, 200);
      const snippet = scrubText(String(value), 160);
      drafts.push({
        detector: "interpolation_artifact",
        title: `Interpolation artifact persisted: ${table}.${column} contains "${artifact}"`,
        severity: "high",
        score: DB_INVARIANT_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: event.t,
          offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId,
          message: `${table}.${column} ${event.k === "db.diff" ? "was written with" : "read back"} "${snippet}" — "${artifact}" is a template value that never resolved`,
          source: normalizeDbEngine(event.d.engine),
        }),
        dedupeKey: `interpolation:${key}`,
      });
    }
  }
}

/** Columns that carry a lifecycle: status/state/phase/stage, bare or suffixed.
 *  Deliberately narrower than {@link looksLikeStateColumn}: flag/enabled/
 *  active/visible are legitimate user toggles, and a toggle flipped twice is
 *  A→B→A by design. Lifecycles are not supposed to go backward. */
function looksLikeLifecycleColumn(column: string): boolean {
  return /(^|_)(status|state|phase|stage)$/i.test(column);
}

/**
 * state_flip_flop: one row's lifecycle column returned to a value it had
 * already left.
 *
 * The live case: order #1's status went placed → delivered → placed →
 * refunded → shipped inside 31 ms. No error fired, every write succeeded, and
 * the only structural signal was four generic "Database update on orders"
 * candidates at the bottom of the ranking. The domain-free invariant is the
 * revisit: whatever the app's state machine is, a value that was held, left,
 * and held again means either an invalid transition or two writers fighting.
 * Restricted to string-valued lifecycle columns so boolean and enum toggles
 * the user can legitimately flip twice stay out.
 */
function addStateFlipFlopCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // (table, pk, column) → observed value chain, in event order.
  const chains = new Map<
    string,
    { table: string; column: string; values: string[]; first: BugEvent; last: BugEvent }
  >();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    if (safeText(event.d.op, 20) !== "update") continue;
    const table = safeText(event.d.table, 200);
    if (!table) continue;
    const pk = event.d.pk;
    if (!isRecord(pk)) continue;
    const before = isRecord(event.d.before) ? event.d.before : undefined;
    const after = isRecord(event.d.after) ? event.d.after : undefined;
    if (!after) continue;
    for (const [column, afterValue] of Object.entries(after)) {
      if (!looksLikeLifecycleColumn(column)) continue;
      if (typeof afterValue !== "string" || afterValue.length === 0) continue;
      const key = `${table} ${JSON.stringify(pk)} ${column}`;
      const chain = chains.get(key) ?? {
        table,
        column,
        values: [],
        first: event,
        last: event,
      };
      const beforeValue = before?.[column];
      if (
        chain.values.length === 0 &&
        typeof beforeValue === "string" &&
        beforeValue.length > 0
      ) {
        chain.values.push(beforeValue);
      }
      if (chain.values[chain.values.length - 1] !== afterValue) {
        chain.values.push(afterValue);
      }
      chain.last = event;
      chains.set(key, chain);
    }
  }

  for (const chain of chains.values()) {
    // A revisit: some value appears again after a different value intervened.
    const seen = new Set<string>();
    let left: string | undefined;
    let revisited: string | undefined;
    for (const value of chain.values) {
      if (seen.has(value)) {
        revisited = value;
        break;
      }
      if (left !== undefined) seen.add(left);
      left = value;
    }
    if (revisited === undefined) continue;
    const label = scrubText(chain.table, 100) ?? "table";
    const spanMs = Math.max(0, chain.last.t - chain.first.t);
    const path = chain.values.map((v) => scrubText(v, 60)).join(" → ");
    drafts.push({
      detector: "state_flip_flop",
      title: `State went backward: ${label}.${chain.column} returned to "${revisited}"`,
      severity: "high",
      score: DB_INVARIANT_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: chain.first.t,
        offsetMs:
          offsetForEvent(chain.first) ??
          offsetFromStart(chain.first.t, index.start),
        route: routeAt(index.navs ?? [], chain.first.t),
        requestId: safeText(chain.first.d.requestId, 200),
        message: `${chain.table} row ${scrubText(JSON.stringify(chain.first.d.pk), 120)} moved ${path} over ${spanMs} ms. "${revisited}" was held, left, and reached again — an invalid transition or two writers fighting, whatever the intended state machine is.`,
        source: normalizeDbEngine(chain.first.d.engine),
      }),
      dedupeKey: `flipflop:${chain.table}:${chain.column}:${scrubText(JSON.stringify(chain.first.d.pk), 120)}`,
    });
  }
}

/** Columns that carry money. Narrower than looksLikeStateColumn's value arm:
 *  qty/count are excluded because doubling a quantity is commerce, not a unit
 *  bug. */
function looksLikeMoneyColumn(column: string): boolean {
  return /(^|_)(amount|total|price|cost|balance)(_cents|_amount)?s?$|_cents$/i.test(
    column,
  );
}

/** Success-shaped status values, for claims about settled writes. */
function looksSettled(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(succeeded|success|captured|settled|paid|completed?|confirmed|ok)$/i.test(value)
  );
}

/**
 * duplicate_charge: two settled rows for the same reference and the same
 * amount.
 *
 * The live case: an idempotency key generated inside the retry loop, so the
 * gateway saw attempt 2 as a brand-new charge — two payments rows with the
 * same order_id, order_ref and amount_cents, both succeeded, differing only
 * in gateway_charge_id. duplicate_write is structurally blind to this: the
 * gateway id differs by design, so the after images never match. The claim
 * here rests on the business identity instead: same non-null reference
 * column, same money amount, both settled, different primary keys.
 */
function addDuplicateChargeCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // The grouping key is ONE reference column at a time, never the composite:
  // the duplicating row legitimately differs in its gateway-assigned id
  // (which also ends in _id), so a composite key would never collide. Actor
  // columns (user_id, customer_id...) are excluded: the same customer settling
  // the same amount twice for two different orders is commerce, not a
  // duplicate.
  const isTransactionRef = (key: string): boolean =>
    /(^|_)(ref|reference)$|_id$/i.test(key) &&
    !/^id$/i.test(key) &&
    !/(^|_)(user|customer|account|actor|owner|creator|created_by|updated_by)_?id$/i.test(
      key,
    ) &&
    !/(^|_)(gateway|external|provider|processor|charge|txn|transaction)_/i.test(key);

  interface SettledRow {
    event: BugEvent;
    pk: string;
    refs: Array<[string, string]>;
    amountText: string;
  }
  const rowsByTable = new Map<string, SettledRow[]>();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    if (safeText(event.d.op, 20) !== "insert") continue;
    const table = safeText(event.d.table, 200);
    if (!table) continue;
    const after = isRecord(event.d.after) ? event.d.after : undefined;
    if (!after) continue;
    const settled = Object.entries(after).some(
      ([key, value]) => looksLikeStateColumn(key) && looksSettled(value),
    );
    if (!settled) continue;
    const refs = Object.entries(after)
      .filter(
        ([key, value]) =>
          value !== null && value !== undefined && value !== "" && isTransactionRef(key),
      )
      .map(([key, value]): [string, string] => [key, String(value)]);
    const amounts = Object.entries(after)
      .filter(
        ([key, value]) => looksLikeMoneyColumn(key) && finiteNumber(value) !== undefined,
      )
      .map(([key, value]) => `${key}=${String(value)}`)
      .sort();
    if (refs.length === 0 || amounts.length === 0) continue;
    const rows = rowsByTable.get(table) ?? [];
    rows.push({
      event,
      pk: JSON.stringify(event.d.pk ?? rows.length),
      refs,
      amountText: amounts.join(", "),
    });
    rowsByTable.set(table, rows);
  }

  for (const [table, rows] of rowsByTable) {
    if (rows.length < 2) continue;
    // column=value + identical amounts: the rows claiming the same event.
    const byRef = new Map<string, SettledRow[]>();
    for (const row of rows) {
      for (const [column, value] of row.refs) {
        const key = `${column}=${value} ${row.amountText}`;
        const group = byRef.get(key) ?? [];
        group.push(row);
        byRef.set(key, group);
      }
    }
    // The same pair of rows usually collides on several reference columns
    // (order_id AND order_ref); one finding per distinct row set.
    const reported = new Set<string>();
    for (const [key, group] of byRef) {
      if (group.length < 2) continue;
      const pkSet = group
        .map((row) => row.pk)
        .sort()
        .join(",");
      if (reported.has(pkSet)) continue;
      reported.add(pkSet);
      const first = group.reduce((earliest, row) =>
        row.event.t < earliest.event.t ? row : earliest,
      );
      const label = scrubText(table, 100) ?? "table";
      drafts.push({
        detector: "duplicate_charge",
        title: `Duplicate settlement: ${group.length} settled ${label} rows for one reference`,
        severity: "high",
        score: DB_INVARIANT_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: first.event.t,
          offsetMs:
            offsetForEvent(first.event) ??
            offsetFromStart(first.event.t, index.start),
          route: routeAt(index.navs ?? [], first.event.t),
          requestId: safeText(first.event.d.requestId, 200),
          message: `${group.length} rows inserted into ${table} share ${scrubText(key.split(" ")[0] ?? key, 200)} with identical ${scrubText(first.amountText, 120)}, every one in a settled state. One business event settled ${group.length} times — on a payments table that is a double charge.`,
          source: normalizeDbEngine(first.event.d.engine),
        }),
        dedupeKey: `dupcharge:${table}:${scrubText(key, 200)}`,
      });
    }
  }
}

/**
 * money_scale_shift: one row's money column changed by exactly a power of a
 * hundred.
 *
 * The live case: capturePayment divided by 100 before sending and the gateway
 * read the field as cents, so the captured amount landed as 199 where the
 * charge said 19900. A legitimate 100.00x price change exists; a payment,
 * total or balance moving by exactly 100x in one UPDATE is a unit bug — the
 * cents/dollars boundary was crossed once too often or too rarely.
 */
function addMoneyScaleShiftCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    if (safeText(event.d.op, 20) !== "update") continue;
    const table = safeText(event.d.table, 200);
    if (!table) continue;
    const before = isRecord(event.d.before) ? event.d.before : undefined;
    const after = isRecord(event.d.after) ? event.d.after : undefined;
    if (!before || !after) continue;
    for (const [column, afterRaw] of Object.entries(after)) {
      if (!looksLikeMoneyColumn(column)) continue;
      const to = finiteNumber(afterRaw);
      const from = finiteNumber(before[column]);
      if (from === undefined || to === undefined) continue;
      if (from <= 0 || to <= 0) continue;
      const ratio = from > to ? from / to : to / from;
      if (ratio !== 100 && ratio !== 10_000) continue;
      const key = `${table}:${column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const direction = from > to ? "shrank" : "grew";
      drafts.push({
        detector: "money_scale_shift",
        title: `Money moved by exactly ${ratio}x: ${table}.${column} ${direction} ${from} → ${to}`,
        severity: "high",
        score: DB_INVARIANT_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: event.t,
          offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId: safeText(event.d.requestId, 200),
          message: `${table}.${column} went from ${from} to ${to} in one update — an exact ${ratio}x shift, the fingerprint of a cents/dollars conversion applied once too often or too rarely.`,
          source: normalizeDbEngine(event.d.engine),
        }),
        dedupeKey: `moneyscale:${key}`,
      });
    }
  }
}

/**
 * cross_user_read: a request served one user another user's row.
 *
 * The live case: GET /api/orders/1 loaded the order by id alone — no user_id
 * predicate — so the "Stranger" account read the "Owner" account's order with
 * a clean 200. The session stream carries both halves: the login wrote
 * sessions.user_id = 4, and the later read returned orders.user_id = 1.
 *
 * The active user comes ONLY from writes/reads on a sessions-shaped table, so
 * flows with no session trail (anonymous browsing, ops consoles on token
 * auth) never establish one and stay silent — which also keeps legitimate
 * admin flows out. This is a targeted authorization signal, not a general
 * ownership policy: it claims exactly "this session's user got a row owned by
 * someone else", and shows both ids so the reader can judge.
 */
function addCrossUserReadCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const isSessionTable = (table: string): boolean =>
    /(^|_)(sessions?|auth_sessions?|user_sessions?)$/i.test(table);
  const ownerOf = (row: Record<string, unknown>): unknown =>
    row.user_id ?? row.owner_id ?? row.customer_id ?? row.account_id;

  const seen = new Set<string>();
  let activeUser: unknown;
  let establishedAt: number | undefined;
  for (const event of events) {
    if (event.k !== "db.diff" && event.k !== "db.read") continue;
    const table = safeText(event.d.table, 200);
    if (!table) continue;
    const image = event.k === "db.diff" ? event.d.after : event.d.row;
    if (!isRecord(image)) continue;
    if (isSessionTable(table)) {
      const sessionUser = image.user_id;
      if (sessionUser !== null && sessionUser !== undefined) {
        activeUser = sessionUser;
        establishedAt = event.t;
      }
      continue;
    }
    if (activeUser === undefined) continue;
    if (event.k !== "db.read") continue;
    if (/(^|_)users?$/i.test(table)) continue;
    const owner = ownerOf(image);
    if (owner === null || owner === undefined) continue;
    if (String(owner) === String(activeUser)) continue;
    const key = `${table}:${String(owner)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      detector: "cross_user_read",
      title: `Cross-user read: ${table} row owned by user ${scrubText(String(owner), 60)} served to user ${scrubText(String(activeUser), 60)}`,
      severity: "high",
      score: 85,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId: safeText(event.d.requestId, 200),
        message: `The active session belongs to user ${scrubText(String(activeUser), 60)} (established at +${Math.round(offsetFromStart(establishedAt ?? event.t, index.start) ?? 0)} ms), yet this request read a ${table} row owned by user ${scrubText(String(owner), 60)}. If this endpoint is not meant to serve other users' data, the query is missing an ownership predicate.`,
        source: normalizeDbEngine(event.d.engine),
      }),
      dedupeKey: `crossuser:${key}`,
    });
  }
}

/**
 * duplicate_readback: two rows read back identical on every meaningful column.
 *
 * The live case: a fulfillment worker retried after a transient failure and
 * inserted a second shipments row for order 1 — but the INSERT after images
 * were captured thin ({id} only), so duplicate_write had nothing to compare.
 * The read-back rows carry the full picture: two shipments rows, different
 * primary keys, identical on order_id and status, differing only in pk and
 * created_at. The claim mirrors duplicate_write's: identity needs an entity
 * anchor, and generated columns (pk, timestamps) are excluded from the
 * signature. Rows that differ in ANY captured business column — two
 * order_items lines with different product_ids — never group.
 */
function addDuplicateReadbackCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const isGeneratedColumn = (key: string): boolean =>
    /^id$|(^|_)(created_at|updated_at|inserted_at|timestamp|created|updated)$/i.test(key);
  // table → signature → {pks, first event}
  const byTable = new Map<
    string,
    Map<string, { pks: Set<string>; first: BugEvent; entries: Array<[string, unknown]> }>
  >();
  for (const event of events) {
    if (event.k !== "db.read") continue;
    const table = safeText(event.d.table, 200);
    if (!table) continue;
    const row = isRecord(event.d.row) ? event.d.row : undefined;
    if (!row) continue;
    const pkCols = isRecord(event.d.pk) ? new Set(Object.keys(event.d.pk)) : new Set<string>();
    const pkText = isRecord(event.d.pk) ? JSON.stringify(event.d.pk) : safeText(row.id, 60);
    if (!pkText) continue;
    const entries = Object.entries(row)
      .filter(([key]) => !pkCols.has(key) && !isGeneratedColumn(key))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    if (entries.length < 2) continue;
    const signature = JSON.stringify(entries);
    const signatures = byTable.get(table) ?? new Map();
    const group = signatures.get(signature) ?? { pks: new Set<string>(), first: event, entries };
    group.pks.add(pkText);
    if (event.t < group.first.t) group.first = event;
    signatures.set(signature, group);
    byTable.set(table, signatures);
  }

  for (const [table, signatures] of byTable) {
    for (const [signature, group] of signatures) {
      if (group.pks.size < 2) continue;
      // Same anchor rule as duplicate_write: some non-null, non-boolean column
      // that is not mere row state must tie the rows to one business entity.
      const hasEntityAnchor = group.entries.some(
        ([key, value]) =>
          value !== null &&
          value !== undefined &&
          value !== "" &&
          typeof value !== "boolean" &&
          !looksLikeStateColumn(key),
      );
      if (!hasEntityAnchor) continue;
      const label = scrubText(table, 100) ?? "table";
      const columns = group.entries.map(([key]) => key);
      drafts.push({
        detector: "duplicate_readback",
        title: `Duplicate rows: ${group.pks.size} ${label} rows identical on every business column`,
        severity: "high",
        score: DB_INVARIANT_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: group.first.t,
          offsetMs:
            offsetForEvent(group.first) ??
            offsetFromStart(group.first.t, index.start),
          route: routeAt(index.navs ?? [], group.first.t),
          requestId: safeText(group.first.d.requestId, 200),
          message: `${group.pks.size} distinct ${table} rows read back identical on ${columns.join(", ")} — different primary keys, same business content. One event produced ${group.pks.size} rows; on a fulfillment or settlement table that is a non-idempotent retry.`,
          source: normalizeDbEngine(group.first.d.engine),
        }),
        dedupeKey: `dupreadback:${table}:${scrubText(signature, 200)}`,
      });
    }
  }
}

/**
 * orphaned_reference: a child row was written with a null reference to a
 * parent that was created afterwards.
 *
 * The live case: the fulfillment worker's dependent writes were reordered, so
 * inventory_ledger got its row with shipment_id = null and the shipments row
 * appeared milliseconds LATER — the ledger row references nothing, forever.
 * The domain-free signal is the write order: a null *_id column whose parent
 * table (by name: shipment_id → shipments) receives an INSERT later in the
 * same session. A nullable reference that stays null with no parent ever
 * created is a data-model choice; a null reference whose parent shows up
 * after the child was committed is an ordering bug.
 */
function addOrphanedReferenceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const parentTablesOf = (column: string): string[] => {
    const stem = column.replace(/_id$/i, "");
    if (!stem || stem === column) return [];
    return [stem, `${stem}s`, `${stem.replace(/y$/i, "ies")}`, `${stem}es`];
  };
  interface NullRef {
    event: BugEvent;
    table: string;
    column: string;
    parents: string[];
  }
  const nullRefs: NullRef[] = [];
  const insertTimes = new Map<string, number[]>();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    if (safeText(event.d.op, 20) !== "insert") continue;
    const table = safeText(event.d.table, 200);
    if (!table) continue;
    const times = insertTimes.get(table.toLowerCase()) ?? [];
    times.push(event.t);
    insertTimes.set(table.toLowerCase(), times);
    const after = isRecord(event.d.after) ? event.d.after : undefined;
    if (!after) continue;
    for (const [column, value] of Object.entries(after)) {
      if (value !== null) continue;
      if (!/_id$/i.test(column)) continue;
      const parents = parentTablesOf(column.toLowerCase());
      if (parents.length === 0) continue;
      nullRefs.push({ event, table, column, parents });
    }
  }

  const seen = new Set<string>();
  for (const ref of nullRefs) {
    const parentTable = ref.parents.find((p) => insertTimes.has(p));
    if (!parentTable) continue;
    const laterInsert = (insertTimes.get(parentTable) ?? []).find(
      (t) => t > ref.event.t,
    );
    if (laterInsert === undefined) continue;
    const key = `${ref.table}:${ref.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      detector: "orphaned_reference",
      title: `Orphaned reference: ${ref.table}.${ref.column} written null before ${parentTable} existed`,
      severity: "high",
      score: DB_INVARIANT_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: ref.event.t,
        offsetMs:
          offsetForEvent(ref.event) ?? offsetFromStart(ref.event.t, index.start),
        route: routeAt(index.navs ?? [], ref.event.t),
        requestId: safeText(ref.event.d.requestId, 200),
        message: `${ref.table} was inserted with ${ref.column} = null, and a ${parentTable} row was created ${Math.round(laterInsert - ref.event.t)} ms AFTER it. The dependent writes ran in the wrong order, so this row references nothing — and unless something backfills it, it never will.`,
        source: normalizeDbEngine(ref.event.d.engine),
      }),
      dedupeKey: `orphanref:${key}`,
    });
  }
}

/**
 * lost_update: a read-modify-write raced itself and one writer's change vanished.
 *
 * The signature is exact and does not need to know anything about the app: two
 * UPDATEs land on the same table and primary key, and the later one's BEFORE
 * image still shows the value the earlier one had already replaced. Both writes
 * succeeded, both rows are individually valid, and the final row silently holds
 * one increment instead of two. Nothing else in the pipeline names it — the
 * generic `db_mutation` surfacing says only "a row changed", which is exactly
 * as true of the correct outcome.
 *
 * This is the one detector here that deliberately crosses request boundaries:
 * a lost update is *made of* two concurrent requests, so a per-request rule can
 * never see it. Requiring a stale before-image is what keeps that safe — two
 * unrelated sequential updates chain correctly and stay silent.
 *
 * Needs `captureBefore: true`; without before images there is nothing to
 * compare and the rule cannot fire at all.
 */
function addLostUpdateCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // table + pk → the update diffs against that row, in capture order.
  const byRow = new Map<string, BugEvent[]>();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    if (safeText(event.d.op, 20) !== "update") continue;
    if (!isRecord(event.d.before) || !isRecord(event.d.after)) continue;
    const table = safeText(event.d.table, 200);
    const pk = pkEntriesOf(event);
    if (!table || pk.length === 0) continue;
    const key = `${table}\u0000${pk.map(([c, v]) => `${c}=${v}`).join(",")}`;
    const list = byRow.get(key) ?? [];
    list.push(event);
    byRow.set(key, list);
  }

  for (const [key, updates] of byRow) {
    if (updates.length < 2) continue;
    const ordered = [...updates].sort((a, b) => a.t - b.t);
    for (let i = 1; i < ordered.length; i += 1) {
      const earlier = ordered[i - 1];
      const later = ordered[i];
      // Two writes from the same request are a sequence the app wrote on
      // purpose, not a race.
      const earlierRequest = safeText(earlier.d.requestId, 120);
      const laterRequest = safeText(later.d.requestId, 120);
      if (earlierRequest && laterRequest && earlierRequest === laterRequest)
        continue;

      const earlierAfter = earlier.d.after as Record<string, unknown>;
      const laterBefore = later.d.before as Record<string, unknown>;
      const laterAfter = later.d.after as Record<string, unknown>;
      for (const [column, wrote] of Object.entries(earlierAfter)) {
        if (isIdentityOrClockField(column)) continue;
        if (!Object.hasOwn(laterBefore, column)) continue;
        const sawBefore = laterBefore[column];
        // The later writer read a value the earlier writer had already
        // replaced, so its own write was computed from stale state.
        if (sameScalar(sawBefore, wrote)) continue;
        const earlierBefore = earlier.d.before as Record<string, unknown>;
        if (!sameScalar(sawBefore, earlierBefore[column])) continue;
        // ...and both writers, from that one read, computed the SAME new value.
        // That coincidence is the read-modify-write fingerprint: two increments
        // of 1 both produced 2, so the row holds 2 where it should hold 3. When
        // the two writes disagree the rule stays silent, because an absolute
        // `SET qty = n` from a stale read is indistinguishable from a correct
        // one and guessing would put a false claim above the plane dump.
        if (!sameScalar(laterAfter[column], wrote)) continue;

        const label = scrubText(bareTableName(key.split("\u0000")[0]), 100) ?? "table";
        drafts.push({
          detector: "lost_update",
          title: `Lost update: a second writer overwrote ${label}.${column} from a stale read`,
          severity: "high",
          score: DB_INVARIANT_SCORE,
          confidence: "high",
          anchor: removeUndefined({
            t: later.t,
            offsetMs:
              offsetForEvent(later) ?? offsetFromStart(later.t, index.start),
            route: routeAt(index.navs ?? [], later.t),
            requestId: laterRequest,
            message: `${label}.${column}: one writer set ${formatScalar(wrote)}, a concurrent writer had already read ${formatScalar(sawBefore)} and wrote ${formatScalar(laterAfter[column])}`,
            source: normalizeDbEngine(later.d.engine),
          }),
          dedupeKey: `lostupdate:${key}:${column}`,
        });
        break; // One claim per row pair; the first stale column carries it.
      }
    }
  }
}

/**
 * Vocabulary for the two halves of a recorded counter pair: what the
 * application set out to do, and what it reports having done. Matched on
 * word segments rather than substrings, so `completed_at` does not read as
 * an achievement count.
 */
const INTENDED_COUNTER_WORDS = new Set([
  "expected",
  "claimed",
  "requested",
  "planned",
  "target",
  "advertised",
  "intended",
  "total",
]);
const ACHIEVED_COUNTER_WORDS = new Set([
  "written",
  "returned",
  "delivered",
  "processed",
  "actual",
  "completed",
  "succeeded",
  "applied",
  "sent",
  "inserted",
  "exported",
  "seen",
]);

/**
 * Columns whose units are not a row count. `total_cents` is an amount, and
 * pairing it against a row count would fire on every ordinary order that costs
 * more cents than it has line items. Duration and size columns are excluded for
 * the same reason.
 */
const NON_COUNT_UNIT_WORDS =
  /(cents|amount|price|cost|fee|tax|bytes|ms|millis|seconds|duration|balance)/i;

/** `rows_expected` → ["rows","expected"]; `rowsExpected` → ["rows","expected"]. */
function columnWords(column: string): string[] {
  return column
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** A non-negative integer that is plausibly a row count, or undefined. */
function counterValueOf(column: string, value: unknown): number | undefined {
  if (NON_COUNT_UNIT_WORDS.test(column)) return undefined;
  const numeric = finiteNumber(value);
  if (numeric === undefined) return undefined;
  if (!Number.isInteger(numeric) || numeric < 0) return undefined;
  return numeric;
}

/** How many contradiction claims one session may carry. */
const MAX_COUNTER_CONTRADICTION_CANDIDATES = 5;

/**
 * Status values that mean the work is over, so its counters have to agree.
 * Deny-biased: a status outside this set, including one this does not
 * recognise, reads as still in flight and the row is left alone.
 */
const TERMINAL_STATUS_VALUES = new Set([
  "done",
  "complete",
  "completed",
  "finished",
  "success",
  "succeeded",
  "failed",
  "failure",
  "errored",
  "cancelled",
  "canceled",
  "aborted",
]);

/** Column names that carry a row's lifecycle state. */
function isStatusColumn(column: string): boolean {
  return columnWords(column).some(
    (word) => word === "status" || word === "state" || word === "phase",
  );
}

/**
 * Whether a row is making a finished claim about itself.
 *
 * A row that carries a lifecycle column answers this itself, and only a
 * terminal value counts: a batch inserted `pending` with nothing applied is a
 * plan, and one `running` half way through is progress. Neither is a
 * contradiction, and both are the ordinary shape of every job table.
 *
 * A row with no lifecycle column at all is a write-once record — an export
 * receipt, a report line — so it is finished by the time it exists. Requiring
 * it to have achieved something keeps a placeholder row, written ahead of the
 * work it describes, from reading as a failure to do the work.
 */
function recordsFinishedWork(
  after: Record<string, unknown>,
  achievedValue: number,
): boolean {
  const statusEntry = Object.entries(after).find(([column]) =>
    isStatusColumn(column),
  );
  if (statusEntry) {
    const value = safeText(statusEntry[1], 40);
    return value !== undefined && TERMINAL_STATUS_VALUES.has(value.toLowerCase());
  }
  return achievedValue > 0;
}

/**
 * counter_contradiction: one written row records both what the application
 * meant to do and what it did, and the two disagree.
 *
 * `rows_expected: 8, rows_written: 3` in a single inserted row is the whole
 * signal. Nothing has to be correlated, no clock is involved, and no knowledge
 * of the application is needed — the app chose to persist both numbers, which
 * is itself the statement that it cares whether they match. Without this the
 * ranker says only "Database update on order_exports", which is exactly as true
 * of a correct export.
 *
 * Deliberately calibrated below the invariant detectors. What is certain is
 * that two recorded counters disagree; whether that is a defect is the reader's
 * call, so the claim is phrased as the two numbers rather than as a verdict.
 *
 * The one thing that must be right is WHEN to ask, because a job table spends
 * its whole life with its counters disagreeing on purpose. {@link
 * recordsFinishedWork} is that gate: the row has to be claiming the work is
 * over. An earlier revision keyed on the operation instead, firing on every
 * insert, and measuring it across 37 captured sessions showed the mistake in
 * both directions — it fired on seven unrelated sessions that had merely
 * inserted a `pending` batch with nothing applied yet, and it stayed silent on
 * the batch that finished `done` having applied one row of two, which was the
 * actual defect in that session.
 */
function addCounterContradictionCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  let emitted = 0;
  for (const event of events) {
    if (emitted >= MAX_COUNTER_CONTRADICTION_CANDIDATES) return;
    if (event.k !== "db.diff") continue;
    const op = safeText(event.d.op, 20);
    if (op !== "insert" && op !== "update") continue;
    if (!isRecord(event.d.after)) continue;
    const table = safeText(event.d.table, 200);
    if (!table) continue;

    const intended: Array<[string, number]> = [];
    const achieved: Array<[string, number]> = [];
    for (const [column, raw] of Object.entries(event.d.after)) {
      const words = columnWords(column);
      const isIntended = words.some((word) =>
        INTENDED_COUNTER_WORDS.has(word),
      );
      const isAchieved = words.some((word) =>
        ACHIEVED_COUNTER_WORDS.has(word),
      );
      // A column reading as both halves names nothing in particular.
      if (isIntended === isAchieved) continue;
      const value = counterValueOf(column, raw);
      if (value === undefined) continue;
      (isIntended ? intended : achieved).push([column, value]);
    }
    if (intended.length === 0 || achieved.length === 0) continue;

    intended.sort(([a], [b]) => a.localeCompare(b));
    achieved.sort(([a], [b]) => a.localeCompare(b));
    const [intendedColumn, intendedValue] = intended[0];
    const [achievedColumn, achievedValue] = achieved[0];
    if (intendedValue === achievedValue) continue;
    if (!recordsFinishedWork(event.d.after, achievedValue)) continue;

    const label = scrubText(bareTableName(table), 100) ?? "table";
    const comparedColumns = [...intended, ...achieved]
      .map(([column]) => column)
      .sort();
    drafts.push({
      detector: "counter_contradiction",
      title: `${label} recorded ${intendedColumn} ${intendedValue} but ${achievedColumn} ${achievedValue}`,
      severity: "medium",
      score: 68,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId: safeText(event.d.requestId, 120),
        message: scrubText(
          `${label}: \`${intendedColumn}\`=${intendedValue} against \`${achievedColumn}\`=${achievedValue}, recorded in one inserted row`,
          220,
        ),
        comparedColumns,
        source: normalizeDbEngine(event.d.engine),
      }),
      dedupeKey: `countercontradiction:${table}:${intendedColumn}:${achievedColumn}`,
    });
    emitted += 1;
  }
}

/** Scalar equality that treats 1 and "1" as the same stored value. */
function sameScalar(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined)
    return false;
  if (typeof a === "object" || typeof b === "object") return false;
  return String(a) === String(b);
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "absent";
  if (typeof value === "string") return scrubText(value, 80) ?? "[REDACTED]";
  if (typeof value === "object") return "[object]";
  return String(value);
}

/** SELECT statements against one table in one request before it reads as a fan-out. */
const N_PLUS_ONE_STATEMENT_THRESHOLD = 8;

/**
 * n_plus_one_query: one request issued a separate SELECT per item.
 *
 * The classic listing defect. A catalog handler loops the rows it just fetched
 * and asks the database one more question per row, so a page that should cost
 * two round trips costs fifty-one. It is invisible to every other signal here:
 * each query is fast, correct and individually unremarkable, the response is a
 * 200, and the page renders exactly the right data. Only the shape of the
 * request as a whole is wrong.
 *
 * Counted in SELECT *statements*, not rows. Rows are emitted one `db.read`
 * event each, so a single SELECT returning fifty rows and fifty SELECTs
 * returning one row produce the same number of events — `d.stmt` is what tells
 * them apart, and without it this rule cannot run.
 *
 * Needs `captureReads: true`. Read caps bound the count, so the finding
 * understates a large fan-out rather than overstating it.
 */
function addNPlusOneCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // requestId + table → the distinct statement ordinals seen, and the first event.
  const byTable = new Map<
    string,
    { statements: Set<number>; first: BugEvent; requestId: string; table: string }
  >();
  for (const event of events) {
    if (event.k !== "db.read") continue;
    const requestId = safeText(event.d.requestId, 120);
    const table = safeText(event.d.table, 200);
    const stmt = event.d.stmt;
    if (!requestId || !table || !Number.isInteger(stmt)) continue;
    const key = `${requestId}\u0000${table}`;
    const entry = byTable.get(key) ?? {
      statements: new Set<number>(),
      first: event,
      requestId,
      table,
    };
    entry.statements.add(stmt as number);
    if (event.t < entry.first.t) entry.first = event;
    byTable.set(key, entry);
  }

  // One candidate per table, not one per request. The same missing JOIN fires
  // on every request that walks the same code path, and a session that paged
  // through four screens would otherwise fill the entire top of the ranking
  // with four copies of one finding — crowding out whatever else the session
  // caught. The worst request anchors the claim; the rest become a count.
  const worstPerTable = new Map<
    string,
    {
      worst: { statements: Set<number>; first: BugEvent; requestId: string; table: string };
      requests: number;
    }
  >();
  for (const entry of byTable.values()) {
    if (entry.statements.size < N_PLUS_ONE_STATEMENT_THRESHOLD) continue;
    const agg = worstPerTable.get(entry.table);
    if (!agg) {
      worstPerTable.set(entry.table, { worst: entry, requests: 1 });
    } else {
      agg.requests += 1;
      if (entry.statements.size > agg.worst.statements.size) agg.worst = entry;
    }
  }

  for (const { worst, requests } of worstPerTable.values()) {
    const count = worst.statements.size;
    const label = scrubText(bareTableName(worst.table), 100) ?? "table";
    const recurrence =
      requests > 1 ? ` The same pattern ran in ${requests} requests this session.` : "";
    drafts.push({
      detector: "n_plus_one_query",
      title: `N+1 query: one request ran ${count} separate SELECTs against ${label}`,
      severity: "medium",
      score: 78,
      confidence: "high",
      anchor: removeUndefined({
        t: worst.first.t,
        offsetMs:
          offsetForEvent(worst.first) ??
          offsetFromStart(worst.first.t, index.start),
        route: routeAt(index.navs ?? [], worst.first.t),
        requestId: worst.requestId,
        message: `${count} SELECT statements against ${label} in one request, one per row rather than one for all of them. Read caps bound this count, so the real fan-out may be larger.${recurrence}`,
        source: normalizeDbEngine(worst.first.d.engine),
      }),
      dedupeKey: `nplus1:${worst.table}`,
    });
  }
}

/** Stems a payload field name: lowercased leading token of camel/snake case (couponCode → coupon). */
function stemFieldName(name: string): string {
  const tokens = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
  return tokens[0] ?? name.toLowerCase();
}

function matchTermsForStem(stem: string): string[] {
  return [stem, ...(INEFFECTIVE_INPUT_STEM_SYNONYMS[stem] ?? [])];
}

/** Collects lowercase field-name → value entries from a parsed JSON body. */
function collectFieldEntries(
  value: unknown,
  out: Array<[string, unknown]> = [],
  depth = 0,
): Array<[string, unknown]> {
  if (depth > MAX_BODY_SCOPE_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectFieldEntries(item, out, depth + 1);
    return out;
  }
  if (!isRecord(value) || isRedactedPlaceholder(value)) return out;
  for (const [name, inner] of Object.entries(value)) {
    out.push([name.toLowerCase(), inner]);
    collectFieldEntries(inner, out, depth + 1);
  }
  return out;
}

/**
 * Collects numeric [fieldName, value] entries from a parsed JSON body,
 * placeholder-opaque like collectFieldEntries but PRESERVING the original
 * casing so camelCase names ("totalItems") still stem correctly ("total").
 */
function collectNumericFieldEntries(
  value: unknown,
  out: Array<[string, number]> = [],
  depth = 0,
): Array<[string, number]> {
  if (depth > MAX_BODY_SCOPE_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectNumericFieldEntries(item, out, depth + 1);
    return out;
  }
  if (!isRecord(value) || isRedactedPlaceholder(value)) return out;
  for (const [name, inner] of Object.entries(value)) {
    const num = toFiniteNumber(inner);
    if (num !== undefined) out.push([name, num]);
    else collectNumericFieldEntries(inner, out, depth + 1);
  }
  return out;
}

/**
 * True when a captured column value is a structurally empty object or array —
 * the shape a value takes when the capture could not represent it (a Date, a
 * Buffer, a driver's numeric wrapper). Distinct from {@link isZeroOrEmpty},
 * which asks whether a value is blank: `null` and `""` are real answers about
 * the row, while `{}` is the absence of an answer.
 */
function isUnrepresentedValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function isZeroOrEmpty(value: unknown): boolean {
  if (value === null || value === false) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" || toFiniteNumber(trimmed) === 0;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * ineffective_input: a user-input-shaped string field was accepted (2xx) but neither the
 * response body nor any touched db table shows a trace of it. Hint-grade:
 * confidence low, capped at 3 per session, deduped by field name.
 */
function addIneffectiveInputCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  mutatingRequests: Map<string, CorrelatedRequest>,
): void {
  const tablesByRequest = new Map<string, string[]>();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    const requestId = safeText(event.d.requestId, 120);
    const table = safeText(event.d.table, 200);
    if (!requestId || !table) continue;
    const list = tablesByRequest.get(requestId) ?? [];
    list.push(table.toLowerCase());
    tablesByRequest.set(requestId, list);
  }

  const byField = new Map<string, CandidateDraft>();
  for (const request of mutatingRequests.values()) {
    if (
      request.status === undefined ||
      request.status < 200 ||
      request.status >= 300
    )
      continue;
    const payload = parseStructuredBody(request.body);
    if (payload === undefined) continue; // legacy "[REDACTED]"/unparseable → silent
    const responseBody = parseStructuredBody(request.resBody);
    if (responseBody === undefined) continue; // no readable response → no evidence
    const responseEntries = collectFieldEntries(responseBody);
    const touchedTables = tablesByRequest.get(request.requestId) ?? [];

    for (const scope of collectObjectScopes(payload)) {
      for (const [name, value] of Object.entries(scope)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (!trimmed || trimmed.length > 64 || trimmed === "[REDACTED]")
          continue;
        if (isIdLikeField(name) || QTY_LIKE_FIELD.test(name)) continue;
        if (SENSITIVE_INPUT_FIELD.test(name)) continue;
        const stem = stemFieldName(name);
        if (SENSITIVE_INPUT_FIELD.test(stem)) continue;
        const terms = matchTermsForStem(stem);
        const matchesTerm = (candidate: string): boolean =>
          terms.some((term) => candidate.includes(term));

        if (touchedTables.some(matchesTerm)) continue; // effect visible in db
        const matchingResponse = responseEntries.filter(([fieldName]) =>
          matchesTerm(fieldName),
        );
        const hasEffect = matchingResponse.some(
          ([, fieldValue]) => !isZeroOrEmpty(fieldValue),
        );
        if (hasEffect) continue;

        const anchorEvent = request.reqEvent;
        const existing = byField.get(name);
        if (existing && existing.anchor.t <= anchorEvent.t) continue;
        byField.set(name, {
          detector: "ineffective_input",
          title: `Input \`${name}\` accepted (${request.status}) but produced no observable effect`,
          severity: "medium",
          score: 55,
          confidence: "low",
          anchor: removeUndefined({
            t: anchorEvent.t,
            offsetMs:
              offsetForEvent(anchorEvent) ??
              offsetFromStart(anchorEvent.t, index.start),
            route: routeAt(index.navs ?? [], anchorEvent.t),
            requestId: request.requestId,
            method: request.method,
            url: redactUrl(request.url),
            status: request.status,
            message: `field \`${name}\` (stem \`${stem}\`) has no matching non-empty response field and no touched table match`,
          }),
          dedupeKey: `ineffinput:${name}`,
        });
      }
    }
  }

  const emitted = [...byField.values()]
    .sort((a, b) => a.anchor.t - b.anchor.t)
    .slice(0, MAX_INEFFECTIVE_INPUT_CANDIDATES);
  drafts.push(...emitted);
}

// ─── Display detectors (ui.num snapshots): ui_arithmetic_mismatch / ui_api_divergence ───
//
// Both operate on `ui.num` snapshots ({region, items:[{label, value, unit?}]})
// emitted by the browser ui-numbers collector. Same deny-biased posture as the
// cross-plane detectors: redacted labels, ambiguous roles, and conflicting response fields
// silence the detector rather than guess.

const MAX_UI_API_DIVERGENCE_CANDIDATES = 3;
/** One cent: the display tolerance unit for on-screen currency comparisons. */
const UI_CENT_EPSILON = 0.01;
/** Absorbs binary-float artifacts on exact-boundary comparisons. */
const UI_FLOAT_SLACK = 1e-9;
const SUBTOTAL_LABEL_RE = /sub[\s_-]?total/i;
const TOTAL_LABEL_RE = /\btotal\b/i;
/** Count-style labels ("Total items", "Item count", "Qty") are counts, never currency totals. */
const COUNT_LABEL_RE = /\b(items?|counts?|qty|quantity|units?)\b/i;
type UiComponentRole = "subtotal" | "tax" | "fee" | "shipping" | "discount";
const UI_COMPONENT_ROLES: ReadonlyArray<[UiComponentRole, RegExp]> = [
  ["subtotal", SUBTOTAL_LABEL_RE],
  ["tax", /\btax(es)?\b/i],
  ["fee", /\bfees?\b/i],
  ["shipping", /\bshipping\b/i],
  ["discount", /\bdiscount\b/i],
];

interface UiNumItem {
  label: string;
  value: number;
  unit?: string;
}

/** Extracts well-formed {label, value, unit?} items from a ui.num snapshot; malformed entries are dropped. */
function uiNumItems(event: BugEvent): UiNumItem[] {
  const items = event.d.items;
  if (!Array.isArray(items)) return [];
  const out: UiNumItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const label = safeText(item.label, 120);
    const value = finiteNumber(item.value);
    if (label === undefined || value === undefined) continue;
    const unit = safeText(item.unit, 20);
    out.push(unit === undefined ? { label, value } : { label, value, unit });
  }
  return out;
}

/**
 * Maps a display label to its arithmetic role. Component patterns are checked
 * before the bare total pattern so "Subtotal"/"Sub Total" never reads as a
 * total and qualified totals like "Total tax"/"Total fees"/"Total discount"
 * classify as the component they name, not as THE total. Count-style total
 * labels ("Total items") are counts, not totals → no role.
 */
function uiLabelRole(label: string): UiComponentRole | "total" | undefined {
  for (const [role, pattern] of UI_COMPONENT_ROLES) {
    if (pattern.test(label)) return role;
  }
  if (TOTAL_LABEL_RE.test(label)) {
    if (COUNT_LABEL_RE.test(label)) return undefined;
    return "total";
  }
  return undefined;
}

function formatCents(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * ui_arithmetic_mismatch: within one ui.num snapshot the labeled component amounts
 * (subtotal/tax/fee/shipping, minus discount) disagree with the labeled total
 * beyond ε = 1 cent per component. Arithmetic either holds or it doesn't →
 * confidence high, uncapped. Silent on redacted labels, ambiguous roles
 * (no total, multiple totals, or no components), and unit disagreement.
 * qty×price vs line total deferred — ui.num items carry no per-line pairing;
 * the playground display-total regression only needs component-vs-total.
 */
function addUiArithmeticMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "ui.num") continue;
    const items = uiNumItems(event);
    if (items.length === 0) continue;
    if (items.some((item) => item.label.includes("[REDACTED]"))) continue;
    const region = safeText(event.d.region, 200) ?? "unknown region";

    const totals: UiNumItem[] = [];
    const components: Array<UiNumItem & { role: UiComponentRole }> = [];
    for (const item of items) {
      const role = uiLabelRole(item.label);
      if (role === "total") totals.push(item);
      else if (role !== undefined) components.push({ ...item, role });
    }
    // Ambiguous roles → silent: exactly one total and at least one component required.
    if (totals.length !== 1 || components.length === 0) continue;
    const total = totals[0];
    // When units are present they must agree: a count total vs $ components
    // (or any mixed units among total+components) is not an arithmetic claim.
    const units = new Set(
      [total, ...components]
        .map((item) => item.unit?.trim().toLowerCase())
        .filter((unit): unit is string => unit !== undefined && unit !== ""),
    );
    if (units.size > 1) continue;
    // Discounts are displayed either as positive amounts ("Discount 20") or
    // already-negated ("Discount −20"); subtract the magnitude either way.
    const sum = components.reduce(
      (acc, item) =>
        acc + (item.role === "discount" ? -Math.abs(item.value) : item.value),
      0,
    );
    const epsilon = UI_CENT_EPSILON * components.length;
    if (Math.abs(sum - total.value) <= epsilon + UI_FLOAT_SLACK) continue;

    // Evidence: the snapshot items verbatim (labels already passed the capture-side classifier).
    const itemsText = items
      .map((item) => `${item.label}:${item.value}`)
      .join(", ");
    drafts.push({
      detector: "ui_arithmetic_mismatch",
      title: `UI arithmetic mismatch in ${region}: components sum to ${formatCents(sum)} but ${total.label} shows ${formatCents(total.value)}`,
      severity: "medium",
      score: 60,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        message: scrubText(itemsText, 220),
      }),
      // Region + the two mismatch amounts: re-emits of the same broken region collapse.
      dedupeKey: `uiarith:${region}:${formatCents(sum)}:${formatCents(total.value)}`,
    });
  }
}

/** Normalizes a label/field name for exact matching: lowercase, separators stripped. */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

const COUNT_SUFFIX_RE = /^(items?|counts?|qty|nums?|numbers?)\b/i;

/**
 * Resolves which response-field entries a UI label compares against. Exact
 * case-normalized full-name matches win; the stem fallback applies only when
 * exactly one distinct same-stem field name exists AND that name does not
 * continue with a count-like suffix ("totalItems"/"totalCount" are counts,
 * not the on-screen amount).
 */
function resolveDivergenceMatches(
  label: string,
  stem: string,
  entries: Array<{ name: string; value: number; requestId?: string }>,
): Array<{ name: string; value: number; requestId?: string }> | undefined {
  const target = normalizeFieldName(label);
  const exact = entries.filter(
    (entry) => normalizeFieldName(entry.name) === target,
  );
  if (exact.length > 0) return exact;
  const stemMatches = entries.filter(
    (entry) => stemFieldName(entry.name) === stem,
  );
  if (stemMatches.length === 0) return undefined;
  const distinctNames = new Set(
    stemMatches.map((entry) => normalizeFieldName(entry.name)),
  );
  if (distinctNames.size !== 1) return undefined;
  const suffix = stemMatches[0].name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .slice(1)
    .join(" ");
  if (suffix && COUNT_SUFFIX_RE.test(suffix)) return undefined;
  return stemMatches;
}

/**
 * Cents/dollars unit-equivalence guard. A pervasive API convention returns
 * currency as integer minor units (cents) — `total: 10800` — while the same
 * amount renders on screen in major units — `108.00`. The raw numbers differ
 * by a factor of 100 yet describe the identical amount, so a naive comparison
 * flags a false divergence. Treat the pair as equivalent (→ stay silent) when
 * either side, multiplied by 100, lands within one cent of the other. The
 * ×100 reading is only applied when the *larger* side is an integer, because
 * real minor-unit fields are always whole numbers: this refuses to silence
 * e.g. 1.08 vs 108.5, where neither reading is a clean cents value. The
 * comparison runs in cents space, where one cent of tolerance equals 1.
 *
 * Accepted trade-off: a genuine display bug that is off by exactly ×100 (the
 * UI shows 108.00 while the true amount really is 10800.00) is silenced by
 * design. That coincidence is far rarer than the cents/dollars convention, and
 * the detector's deny-biased posture prefers a miss to a false alarm.
 */
function isCentsDollarsEquivalent(uiValue: number, apiValue: number): boolean {
  const centsTolerance = 1 + UI_FLOAT_SLACK; // one cent, in cents space
  // API in cents, UI in dollars: apiValue ≈ uiValue × 100, apiValue integer.
  if (
    Number.isInteger(apiValue) &&
    Math.abs(apiValue - uiValue * 100) <= centsTolerance
  )
    return true;
  // UI in cents, API in dollars: uiValue ≈ apiValue × 100, uiValue integer.
  if (
    Number.isInteger(uiValue) &&
    Math.abs(uiValue - apiValue * 100) <= centsTolerance
  )
    return true;
  return false;
}

/**
 * C2: a labeled on-screen number differs by more than one cent from a
 * matching numeric field in a net.res body received since the last
 * navigation. Exact (case-normalized) field-name matches are preferred; a
 * stem match is a fallback only when it is unambiguous and not count-like.
 * Silent when no response body parses, the label is redacted, or multiple
 * candidate response fields conflict. Confidence medium, capped at 3 per
 * session, deduped by label stem.
 */
function addUiApiDivergenceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const uiEvents = events.filter((event) => event.k === "ui.num");
  if (uiEvents.length === 0) return;
  const responses = events.filter((event) => event.k === "net.res");
  const navs = index.navs ?? [];

  const byStem = new Map<string, CandidateDraft>();
  for (const event of uiEvents) {
    // Only responses received since the last navigation before this snapshot
    // count. `navs` is assumed sorted ascending by t. A response at the nav
    // instant belongs to the old page, so the boundary is exclusive (<=).
    let navBoundary = Number.NEGATIVE_INFINITY;
    for (const nav of navs) {
      if (nav.t > event.t) break;
      navBoundary = nav.t;
    }

    const fieldEntries: Array<{
      name: string;
      value: number;
      requestId?: string;
    }> = [];
    for (const response of responses) {
      if (response.t <= navBoundary || response.t > event.t) continue;
      const body = parseStructuredBody(response.d.body);
      if (body === undefined) continue; // unreadable response → no evidence
      const requestId = requestIdForEvent(response);
      for (const [name, value] of collectNumericFieldEntries(body)) {
        fieldEntries.push(
          requestId === undefined
            ? { name, value }
            : { name, value, requestId },
        );
      }
    }
    if (fieldEntries.length === 0) continue;

    for (const item of uiNumItems(event)) {
      if (item.label.includes("[REDACTED]")) continue;
      const stem = stemFieldName(item.label);
      if (byStem.has(stem)) continue; // dedupe by label stem, keep the earliest
      const matches = resolveDivergenceMatches(item.label, stem, fieldEntries);
      if (!matches || matches.length === 0) continue;
      // Conflicting candidate response values → ambiguous, stay silent.
      const apiValue = matches[0].value;
      if (
        matches.some(
          (candidate) =>
            Math.abs(candidate.value - apiValue) >
            UI_CENT_EPSILON + UI_FLOAT_SLACK,
        )
      )
        continue;
      if (Math.abs(item.value - apiValue) <= UI_CENT_EPSILON + UI_FLOAT_SLACK)
        continue;
      // A cents/dollars unit-convention match is not a divergence — the values
      // describe the same amount under a ×100 minor-unit reading, so stay silent.
      if (isCentsDollarsEquivalent(item.value, apiValue)) continue;

      byStem.set(stem, {
        detector: "ui_api_divergence",
        title: `UI shows ${item.label} ${formatCents(item.value)} but the API reported ${formatCents(apiValue)}`,
        severity: "medium",
        score: 55,
        confidence: "medium",
        anchor: removeUndefined({
          t: event.t,
          offsetMs:
            offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId: matches[0].requestId,
          message: scrubText(
            `on-screen \`${item.label}\`=${item.value} vs response field stem \`${stem}\`=${apiValue}`,
            220,
          ),
        }),
        dedupeKey: `uidiverge:${stem}`,
      });
    }
  }

  const emitted = [...byStem.values()]
    .sort((a, b) => a.anchor.t - b.anchor.t)
    .slice(0, MAX_UI_API_DIVERGENCE_CANDIDATES);
  drafts.push(...emitted);
}

function addOtelDbActivityCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const dbSpans = events.filter(
    (event) =>
      event.k === OTEL_SPAN_KIND &&
      isRecord(event.d.attributes) &&
      hasOtelDbAttributes(event.d.attributes),
  );
  if (dbSpans.length === 0) return;

  const errorMoments = collectErrorMoments(events, index);
  for (const event of dbSpans) {
    const attrs = event.d.attributes as Record<string, unknown>;
    const requestId =
      safeText(event.d.traceId, 120) ?? safeText(event.d.requestId, 120);
    const system =
      safeText(attrs["db.system"], 80) ??
      safeText(attrs["db.name"], 80) ??
      "database";
    const operation =
      safeText(attrs["db.operation"], 80) ??
      safeText(attrs["db.operation.name"], 80);
    const statement =
      scrubText(attrs["db.statement"], 220) ??
      scrubText(attrs["db.query.text"], 220);
    const linkage = gradeDbErrorLinkage(event.t, requestId, errorMoments);
    const label = operation ?? statement ?? system;

    drafts.push({
      detector: "otel_db_activity",
      title:
        linkage === "request"
          ? `OTel DB activity in a failed request: ${label}`
          : linkage === "temporal"
            ? `OTel DB activity near an error: ${label}`
            : `OTel DB activity: ${label}`,
      severity: DB_LINKAGE_SEVERITY[linkage],
      score: DB_LINKAGE_SCORE[linkage],
      confidence: DB_LINKAGE_CONFIDENCE[linkage],
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        message: statement ?? operation ?? system,
        source: `otel db activity (${system}); statements, not row diffs`,
      }),
      dedupeKey: `oteldb:${safeText(event.d.spanId, 120) ?? event.t}:${requestId ?? ""}:${operation ?? ""}:${statement ?? ""}`,
    });
  }
}

function hasOtelDbAttributes(attrs: Record<string, unknown>): boolean {
  return (
    safeText(attrs["db.system"], 80) !== undefined ||
    safeText(attrs["db.statement"], 220) !== undefined ||
    safeText(attrs["db.operation"], 80) !== undefined ||
    safeText(attrs["db.operation.name"], 80) !== undefined ||
    safeText(attrs["db.query.text"], 220) !== undefined
  );
}

// ═══ Full-recall detectors ══════════════════════════════════════════════════
//
// A recall sweep across a planted-bug corpus produced a set of defects whose
// evidence the capture already carried while no rule read it: a response that
// contradicts its own query string, rows read and never rendered, a stream that
// reconnected past a change, a value the app quietly took back off the user.
// Every rule below is written against events that already exist, and every one
// of them stays silent rather than guessing — an unreadable body, an ambiguous
// array, a redacted value, or a second plausible explanation ends the claim.
//
// Ranking discipline: the hard contradictions (a filter the response defies, an
// acknowledged write the collection never received) sit with the database
// invariants near the top; the heuristics (a currency symbol read against a
// language tag, a listener count read across navigations) sit below the console
// plane and say in their own detail text that they are heuristics.

/**
 * The propagated correlation id, falling back to the transport-local counter.
 *
 * Mirrors {@link collectMutatingRequests}: `d.requestId` is the id a `db.read`
 * or a backend event carries, while `d.id` is the browser's per-transport
 * counter. Joining on the wrong one silently matches nothing.
 */
function correlationIdOf(event: BugEvent): string | undefined {
  return safeText(event.d.requestId, 120) ?? requestIdForEvent(event);
}

/** A request and its response, correlated on {@link correlationIdOf}. */
interface RequestExchange {
  requestId: string;
  req: BugEvent;
  method: string;
  url?: string;
  body: unknown;
  res?: BugEvent;
  /** `net.res d.body`: the redacted response body, as text. */
  resBody?: unknown;
  /** `net.res d.bodyMeta`: the bounded parsed view, when the browser built one. */
  resBodyMeta?: unknown;
  status?: number;
}

/**
 * Every request in the session (not only the mutating ones
 * {@link collectMutatingRequests} keeps), joined to its response.
 */
function collectRequestExchanges(
  events: BugEvent[],
): Map<string, RequestExchange> {
  const exchanges = new Map<string, RequestExchange>();
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const id = correlationIdOf(event);
    if (!id) continue;
    exchanges.set(id, {
      requestId: id,
      req: event,
      method: (
        safeText(event.d.m, 20) ??
        safeText(event.d.method, 20) ??
        "GET"
      ).toUpperCase(),
      url: safeText(event.d.url, 400),
      body: event.d.body,
    });
  }
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const id = correlationIdOf(event);
    if (!id) continue;
    const entry = exchanges.get(id);
    if (!entry) continue;
    entry.res = event;
    entry.resBody = event.d.body;
    entry.resBodyMeta = event.d.bodyMeta;
    entry.status = finiteNumber(event.d.st);
  }
  return exchanges;
}

function isSuccessStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 300;
}

/** Parsed URL of a captured request/navigation url, relative or absolute. */
function parseCapturedUrl(url: string | undefined): URL | undefined {
  const text = url?.trim();
  if (!text) return undefined;
  try {
    return /^[a-z][a-z\d+.-]*:/i.test(text)
      ? new URL(text)
      : new URL(text.startsWith("/") ? text : `/${text}`, "http://crumbtrail.local");
  } catch {
    return undefined;
  }
}

/** Path portion of a captured url, origin and query removed. */
function capturedUrlPath(url: string | undefined): string | undefined {
  const parsed = parseCapturedUrl(url);
  return parsed ? parsed.pathname : undefined;
}

/**
 * The API root a url belongs to: its path with the last segment dropped.
 * `/api/cart/items` → `/api/cart`, so a mutation of the collection and a read of
 * it are recognisably the same area of the server.
 */
function apiPrefixOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) return `/${segments.join("/")}`;
  return `/${segments.slice(0, -1).join("/")}`;
}

/** Paths that look like a data call rather than a document or a static asset. */
const API_PATH_RE = /(^|\/)(api|apis|graphql|gql|rest|v[0-9]+)(\/|$)/i;

function looksLikeApiRequest(url: string | undefined): boolean {
  const path = capturedUrlPath(url);
  return path !== undefined && API_PATH_RE.test(path);
}

/** Conventional names for the collection inside a JSON response object. */
const COLLECTION_BODY_KEYS = new Set([
  "items",
  "data",
  "results",
  "rows",
  "records",
  "list",
  "entries",
  "nodes",
]);

/** JSONPath of the root value in `bodyMeta.arrayTotal`. */
const BODY_ROOT_PATH = "$";

/**
 * The structured view of a response body.
 *
 * `net.res` carries two things and they are not interchangeable. `d.body` is the
 * redacted body as TEXT — the long-standing contract every older consumer reads.
 * `d.bodyMeta` is the browser's bounded parsed view: `{ ct, bytes?, truncated?,
 * data?, arrayTotal? }`, present only for a same-origin JSON response under
 * 32KB that survived redaction and parsing.
 *
 * Prefer `d.bodyMeta.data`, because it is already parsed, depth-bounded and
 * array-capped, and because it is the only place the true lengths of capped
 * arrays are recorded. Fall back to parsing the `d.body` text, which is what a
 * backend-captured, replayed or pre-`bodyMeta` session has — and where nothing
 * was capped, so the captured lengths are exact.
 */
interface ResponseBodyView {
  /** The parsed payload. Undefined when neither source yielded one. */
  data: unknown;
  /**
   * True length of every array the capture capped, keyed by JSONPath —
   * `{"$": 25}` for a top-level array, `{"$.items": 57}` for a nested one. Empty
   * when nothing was capped, in which case the captured lengths are the true
   * ones.
   */
  arrayTotal: Record<string, number>;
}

function responseBodyView(
  body: unknown,
  bodyMeta: unknown,
): ResponseBodyView | undefined {
  if (isRecord(bodyMeta) && bodyMeta.data !== undefined) {
    const arrayTotal: Record<string, number> = {};
    if (isRecord(bodyMeta.arrayTotal)) {
      for (const [path, value] of Object.entries(bodyMeta.arrayTotal)) {
        const total = finiteNumber(value);
        if (total !== undefined) arrayTotal[path] = total;
      }
    }
    return { data: bodyMeta.data, arrayTotal };
  }
  const parsed = parseStructuredBody(body);
  if (parsed === undefined) return undefined;
  return { data: parsed, arrayTotal: {} };
}

/** The structured payload of a captured response, from either source. */
function responsePayload(body: unknown, bodyMeta?: unknown): unknown | undefined {
  return responseBodyView(body, bodyMeta)?.data;
}

/**
 * The one collection a response body carries, with its TRUE length.
 *
 * `total` reads the array's own entry in `bodyMeta.arrayTotal` when the capture
 * capped it, and the captured length otherwise — core writes an entry only for
 * an array it actually shortened, so the absence of one means the length in hand
 * is the real length. Note that `bodyMeta.truncated` is NOT a usable guard here:
 * it is also set by the string-length and depth caps, which say nothing about
 * how many items an array had.
 *
 * Undefined — never a guess — when the body does not parse, carries no array, or
 * carries more than one candidate array, because then nothing maps a count back
 * to the rows it should describe.
 */
interface BodyCollection {
  /** True length of the collection, capped items accounted for. */
  total: number;
  /** The items actually captured — the first 20 when the array was capped. */
  items: unknown[];
  /**
   * True when `items` IS the collection rather than a prefix of it. Any rule
   * that reasons about which items are present (rather than how many there are)
   * has to check this: two capped arrays share their first twenty entries no
   * matter how differently they end.
   */
  complete: boolean;
}

function collectionOf(items: unknown[], total: number): BodyCollection {
  return { total, items, complete: items.length === total };
}

function responseCollection(
  body: unknown,
  bodyMeta?: unknown,
): BodyCollection | undefined {
  const view = responseBodyView(body, bodyMeta);
  if (!view || view.data === undefined) return undefined;
  const payload = view.data;

  if (Array.isArray(payload)) {
    return collectionOf(
      payload,
      view.arrayTotal[BODY_ROOT_PATH] ?? payload.length,
    );
  }
  if (!isRecord(payload) || isRedactedPlaceholder(payload)) return undefined;

  const arrays = Object.entries(payload).filter(([, value]) =>
    Array.isArray(value),
  ) as Array<[string, unknown[]]>;
  if (arrays.length === 0) return undefined;
  const named = arrays.filter(([name]) =>
    COLLECTION_BODY_KEYS.has(name.toLowerCase()),
  );
  const chosen =
    named.length === 1 ? named[0] : arrays.length === 1 ? arrays[0] : undefined;
  if (!chosen) return undefined;
  const [name, items] = chosen;
  return collectionOf(
    items,
    view.arrayTotal[`${BODY_ROOT_PATH}.${name}`] ?? items.length,
  );
}

/**
 * The id-like value of every item in a collection, in order. Undefined when any
 * item has no unambiguous identity, so a set comparison is never made up.
 */
function collectionIdentities(items: unknown[]): string[] | undefined {
  const ids: string[] = [];
  for (const item of items) {
    if (!isRecord(item) || isRedactedPlaceholder(item)) return undefined;
    const entry = Object.entries(item).find(
      ([name, value]) =>
        isIdLikeField(name) &&
        (typeof value === "string" || toFiniteNumber(value) !== undefined),
    );
    if (!entry) return undefined;
    ids.push(String(entry[1]));
  }
  return ids;
}

function sameIdentitySet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, i) => value === b[i]);
}

/** The single quantity-like number a record carries, or undefined if ambiguous. */
function soleQuantityOf(value: unknown): number | undefined {
  if (!isRecord(value) || isRedactedPlaceholder(value)) return undefined;
  const quantities = Object.entries(value)
    .filter(([name]) => QTY_LIKE_FIELD.test(name))
    .map(([, raw]) => toFiniteNumber(raw))
    .filter((qty): qty is number => qty !== undefined);
  return quantities.length === 1 ? quantities[0] : undefined;
}

/** True for a captured value that is a redaction placeholder rather than data. */
function isRedactedValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "[REDACTED]";
  return isRedactedPlaceholder(value);
}

// ─── filter_contradiction ────────────────────────────────────────────────────

/** How many contradicted filters one session may carry. */
const MAX_FILTER_CONTRADICTION_CANDIDATES = 5;

/**
 * A response that contradicts its request's own filter, or a request whose rows
 * never reached the response, is a hard contradiction between two things the
 * capture recorded — one tier under the database invariants (90), because the
 * join rests on a name match rather than on two images of one row, and above the
 * runtime errors (82) because nothing here errored at all.
 */
const FILTER_CONTRADICTION_SCORE = 84;

/**
 * Query parameters that carry free text. `?q=desk` is a search term the server
 * is free to interpret, not a declaration that every row will have `q = "desk"`.
 */
const FREE_TEXT_QUERY_PARAMS = new Set([
  "q",
  "query",
  "search",
  "searchterm",
  "term",
  "keyword",
  "keywords",
  "text",
  "s",
  "filter",
  "filters",
]);

/**
 * Parameters that page, sort or shape a response rather than filter it. Matched
 * on the whole normalized name, so a column genuinely called `order` in a table
 * is unaffected — this is about the parameter, not the column.
 */
const NON_FILTER_QUERY_PARAMS = new Set([
  "limit",
  "offset",
  "page",
  "pagesize",
  "perpage",
  "cursor",
  "sort",
  "sortby",
  "order",
  "orderby",
  "direction",
  "fields",
  "select",
  "include",
  "expand",
  "format",
  "callback",
  "locale",
  "lang",
  "token",
  "key",
  "apikey",
  "signature",
  "nonce",
]);

/**
 * Word segments that make a parameter a range bound. `maxPrice=200` says rows
 * are ≤ 200, not that every row costs exactly 200, so an equality reading of it
 * would fire on every correct response.
 */
const RANGE_PARAM_WORDS = new Set([
  "min",
  "max",
  "from",
  "to",
  "before",
  "after",
  "since",
  "until",
  "start",
  "end",
  "lt",
  "lte",
  "gt",
  "gte",
  "range",
  "between",
]);

const TRUE_TOKENS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "n", "off"]);

/**
 * The one name family this detector reads across a rename: a boolean
 * availability filter against the stock column the row actually carries.
 * `?inStock=true` returning a row whose `inventory` is 0 is the canonical shape
 * of the defect, and the two names never match textually. Deliberately narrow —
 * a boolean parameter and a count column, nothing else — because every entry
 * here is an assumption about someone else's schema.
 */
const AVAILABILITY_PARAM_NAMES = new Set([
  "instock",
  "instockonly",
  "available",
  "isavailable",
  "hasstock",
  "instocked",
]);
const AVAILABILITY_ROW_FIELDS = new Set([
  "instock",
  "available",
  "isavailable",
  "inventory",
  "stock",
  "stockcount",
  "stocklevel",
  "quantityavailable",
  "availablequantity",
]);

interface DeclaredFilter {
  /** Parameter name as written in the query string. */
  name: string;
  /** Normalized name used for matching a row field. */
  key: string;
  /** Accepted values; more than one when the query repeats or comma-lists it. */
  values: string[];
  /** True when every accepted value reads as a boolean. */
  boolean: boolean;
}

/**
 * The equality-ish filters a request declared in its own query string.
 *
 * Deny-biased at every step: a free-text parameter, a paging parameter, a range
 * bound, an empty value and a redacted value all contribute nothing, because the
 * whole claim rests on the request having stated something the response can
 * contradict.
 */
function declaredFilters(url: string | undefined): DeclaredFilter[] {
  const parsed = parseCapturedUrl(url);
  if (!parsed) return [];
  const byKey = new Map<string, DeclaredFilter>();
  for (const [rawName, rawValue] of parsed.searchParams) {
    const name = safeText(rawName, 80);
    if (!name) continue;
    const key = normalizeFieldName(name);
    if (FREE_TEXT_QUERY_PARAMS.has(key)) continue;
    if (NON_FILTER_QUERY_PARAMS.has(key)) continue;
    if (columnWords(name).some((word) => RANGE_PARAM_WORDS.has(word))) continue;
    const value = safeText(rawValue, 200);
    if (!value || isRedactedValue(value)) continue;
    // A repeated or comma-listed parameter is a set: a row matching any member
    // satisfies it, so only a row matching none is a contradiction.
    const values = value.includes(",")
      ? value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
      : [value];
    if (values.length === 0) continue;
    const existing = byKey.get(key);
    if (existing) existing.values.push(...values);
    else
      byKey.set(key, {
        name,
        key,
        values,
        boolean: false,
      });
  }
  for (const filter of byKey.values()) {
    filter.boolean = filter.values.every((value) => {
      const token = value.trim().toLowerCase();
      return TRUE_TOKENS.has(token) || FALSE_TOKENS.has(token);
    });
  }
  return [...byKey.values()];
}

/** The row field a declared filter is about, when the row carries one. */
function rowFieldForFilter(
  filter: DeclaredFilter,
  row: Record<string, unknown>,
): { field: string; value: unknown } | undefined {
  const direct = Object.entries(row).find(
    ([name]) => normalizeFieldName(name) === filter.key,
  );
  if (direct) return { field: direct[0], value: direct[1] };
  if (!filter.boolean || !AVAILABILITY_PARAM_NAMES.has(filter.key))
    return undefined;
  const availability = Object.entries(row).find(([name]) =>
    AVAILABILITY_ROW_FIELDS.has(normalizeFieldName(name)),
  );
  return availability
    ? { field: availability[0], value: availability[1] }
    : undefined;
}

/** Truthiness of a stored value read as an availability flag. */
function availabilityTruth(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const numeric = finiteNumber(value);
  if (numeric !== undefined) return numeric > 0;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (TRUE_TOKENS.has(token)) return true;
    if (FALSE_TOKENS.has(token)) return false;
    const parsed = toFiniteNumber(token);
    if (parsed !== undefined) return parsed > 0;
  }
  if (value === null) return false;
  return undefined;
}

/**
 * Whether a read row contradicts a filter the request declared, and how.
 * Returns the sentence for the candidate's detail, or undefined when the row
 * satisfies the filter or cannot be compared against it.
 */
function filterContradictionOf(
  filter: DeclaredFilter,
  field: string,
  value: unknown,
): string | undefined {
  if (value === undefined || isRedactedValue(value)) return undefined;
  if (typeof value === "object" && value !== null) return undefined;

  if (filter.boolean) {
    const wanted = TRUE_TOKENS.has(filter.values[0].trim().toLowerCase());
    const actual = availabilityTruth(value);
    if (actual === undefined || actual === wanted) return undefined;
    return `the request declared \`${filter.name}=${filter.values[0]}\` and the row read back carries \`${field}\`=${formatScalar(value)}`;
  }

  const actual = String(value).trim().toLowerCase();
  const accepted = filter.values.map((entry) => entry.trim().toLowerCase());
  if (accepted.includes(actual)) return undefined;
  // A comma-listed value may also have been stored verbatim.
  if (accepted.length > 1 && actual === filter.values.join(",").toLowerCase())
    return undefined;
  return `the request declared \`${filter.name}=${filter.values.join(",")}\` and the row read back carries \`${field}\`=${formatScalar(value)}`;
}

/**
 * filter_contradiction: a 2xx response was built from rows that defy the
 * request's own query string.
 *
 * `GET /products?category=audio` answering with a row whose `category` is
 * `desk` is a contradiction with no second reading: the request declared the
 * constraint, the server acknowledged with a 200, and the row it read says
 * otherwise. Nothing else in the pipeline sees it — the request is fine, the
 * response is fine, the query is fast, and the page renders exactly the wrong
 * products without a single error.
 *
 * The join is the request's own correlation id, so the rows compared are the
 * rows THAT request read, not rows that happened to be read nearby.
 */
function addFilterContradictionCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const readsByRequest = new Map<string, BugEvent[]>();
  for (const event of events) {
    if (event.k !== "db.read") continue;
    if (!isRecord(event.d.row)) continue;
    const id = correlationIdOf(event);
    if (!id) continue;
    const list = readsByRequest.get(id) ?? [];
    list.push(event);
    readsByRequest.set(id, list);
  }
  if (readsByRequest.size === 0) return;

  const byFilter = new Map<string, CandidateDraft>();
  for (const exchange of exchanges.values()) {
    if (!isSuccessStatus(exchange.status)) continue;
    const reads = readsByRequest.get(exchange.requestId);
    if (!reads || reads.length === 0) continue;
    const filters = declaredFilters(exchange.url);
    if (filters.length === 0) continue;

    for (const filter of filters) {
      for (const read of reads) {
        const row = read.d.row as Record<string, unknown>;
        const match = rowFieldForFilter(filter, row);
        if (!match) continue;
        const contradiction = filterContradictionOf(
          filter,
          match.field,
          match.value,
        );
        if (!contradiction) continue;

        const path = capturedUrlPath(exchange.url) ?? exchange.requestId;
        const dedupeKey = `filtercontradiction:${path}:${filter.key}`;
        if (byFilter.has(dedupeKey)) break;
        const table =
          scrubText(bareTableName(safeText(read.d.table, 200) ?? ""), 100) ??
          "the table";
        byFilter.set(dedupeKey, {
          detector: "filter_contradiction",
          title: `Response rows contradict the request's own filter \`${filter.name}\``,
          severity: "high",
          score: FILTER_CONTRADICTION_SCORE,
          confidence: "high",
          anchor: removeUndefined({
            t: read.t,
            offsetMs:
              offsetForEvent(read) ?? offsetFromStart(read.t, index.start),
            route: routeAt(index.navs ?? [], read.t),
            requestId: exchange.requestId,
            method: exchange.method,
            url: redactUrl(exchange.url),
            status: exchange.status,
            message: scrubText(
              `${contradiction} (read from ${table} inside this request). The response was a ${exchange.status}, so nothing downstream had reason to doubt it.`,
              220,
            ),
            comparedColumns: [match.field],
            source: normalizeDbEngine(read.d.engine),
          }),
          dedupeKey,
        });
        break; // One claim per declared filter.
      }
    }
  }

  const emitted = [...byFilter.values()]
    .sort((a, b) => a.anchor.t - b.anchor.t)
    .slice(0, MAX_FILTER_CONTRADICTION_CANDIDATES);
  drafts.push(...emitted);
}

// ─── result_row_loss ─────────────────────────────────────────────────────────

/** How many row-loss claims one session may carry. */
const MAX_RESULT_ROW_LOSS_CANDIDATES = 5;
/**
 * The count of on-screen numbers is not a row count. When the response body is
 * unreadable and a `ui.num` snapshot is all there is, the claim drops to the
 * display plane's own tier and says so.
 */
const RESULT_ROW_LOSS_UI_SCORE = 64;

/** Parameter names whose value is the page size the server was asked for. */
const PAGE_SIZE_PARAMS = new Set(["limit", "pagesize", "perpage", "take", "count"]);

/** The page size a request asked for, when it asked for one. */
function requestedPageSize(url: string | undefined): number | undefined {
  const parsed = parseCapturedUrl(url);
  if (!parsed) return undefined;
  for (const [name, value] of parsed.searchParams) {
    if (!PAGE_SIZE_PARAMS.has(normalizeFieldName(name))) continue;
    const size = toFiniteNumber(value);
    if (size !== undefined) return size;
  }
  return undefined;
}

/**
 * result_row_loss: the backend read rows the response never carried.
 *
 * A handler that reads twelve rows and answers with eight has dropped four, and
 * the four the user never saw are the defect. Everything else in the session
 * says the request succeeded, because it did — the loss happens between the
 * database and the serializer, where no error is raised and no status changes.
 *
 * Restricted to non-mutating requests on purpose. A POST reads rows to validate
 * its input and answers with a single object; comparing those two numbers would
 * fire on every correct write in every session.
 *
 * Aggregates are excluded by requiring `d.pk`: a `count(*)` row has no primary
 * key, and counting it as a returned row would invent a loss.
 */
function addResultRowLossCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  // requestId → table → the row reads against it.
  const readsByRequest = new Map<string, Map<string, BugEvent[]>>();
  for (const event of events) {
    if (event.k !== "db.read") continue;
    // A row read carries the primary key of the row it read. A count/aggregate
    // row does not, and must never be counted as a row the user should have
    // seen.
    if (event.d.pk == null || !isRecord(event.d.pk)) continue;
    const id = correlationIdOf(event);
    const table = safeText(event.d.table, 200);
    if (!id || !table) continue;
    const byTable = readsByRequest.get(id) ?? new Map<string, BugEvent[]>();
    const list = byTable.get(table) ?? [];
    list.push(event);
    byTable.set(table, list);
    readsByRequest.set(id, byTable);
  }
  if (readsByRequest.size === 0) return;

  // The true row count when the capture capped per-row emission.
  const bulkRowCount = new Map<string, number>();
  for (const event of events) {
    if (event.k !== "db.read.bulk") continue;
    const id = correlationIdOf(event);
    const table = safeText(event.d.table, 200);
    const rows = finiteNumber(event.d.rowCount);
    if (!id || !table || rows === undefined) continue;
    bulkRowCount.set(`${id} ${table}`, rows);
  }

  const uiSnapshots = events
    .filter((event) => event.k === "ui.num")
    .sort((a, b) => a.t - b.t);
  const navTimes = (index.navs ?? []).map((nav) => nav.t).sort((a, b) => a - b);

  const emitted: CandidateDraft[] = [];
  for (const exchange of exchanges.values()) {
    if (MUTATING_METHODS.has(exchange.method)) continue;
    if (!isSuccessStatus(exchange.status) || !exchange.res) continue;
    const byTable = readsByRequest.get(exchange.requestId);
    // More than one table read in the request means no honest mapping from a
    // response array back to the rows it should have carried.
    if (!byTable || byTable.size !== 1) continue;
    const [table, reads] = [...byTable.entries()][0];
    const rowsRead = Math.max(
      reads.length,
      bulkRowCount.get(`${exchange.requestId} ${table}`) ?? 0,
    );
    if (rowsRead < 1) continue;

    const collection = responseCollection(exchange.resBody, exchange.resBodyMeta);
    let shown: number | undefined;
    let basis: "body" | "ui" | undefined;
    if (collection) {
      shown = collection.total;
      basis = "body";
    } else {
      // No readable body: the next display snapshot on this page is the only
      // record of what the user was actually shown.
      const nextNav = navTimes.find((t) => t > exchange.res!.t);
      const snapshot = uiSnapshots.find(
        (event) =>
          event.t >= exchange.res!.t &&
          (nextNav === undefined || event.t < nextNav),
      );
      const items = snapshot ? uiNumItems(snapshot) : [];
      if (items.length > 0) {
        shown = items.length;
        basis = "ui";
      }
    }
    if (shown === undefined || basis === undefined) continue;
    if (shown >= rowsRead) continue;
    // The server was asked for a page and returned exactly that page: the rows
    // beyond it were read for the count, not lost.
    if (requestedPageSize(exchange.url) === shown) continue;

    const label = scrubText(bareTableName(table), 100) ?? "the table";
    emitted.push({
      detector: "result_row_loss",
      title: `${rowsRead - shown} of ${rowsRead} rows read from ${label} never reached the user`,
      severity: basis === "body" ? "high" : "medium",
      score:
        basis === "body" ? FILTER_CONTRADICTION_SCORE : RESULT_ROW_LOSS_UI_SCORE,
      confidence: basis === "body" ? "high" : "low",
      anchor: removeUndefined({
        t: exchange.res.t,
        offsetMs:
          offsetForEvent(exchange.res) ??
          offsetFromStart(exchange.res.t, index.start),
        route: routeAt(index.navs ?? [], exchange.res.t),
        requestId: exchange.requestId,
        method: exchange.method,
        url: redactUrl(exchange.url),
        status: exchange.status,
        message:
          basis === "body"
            ? `The request read ${rowsRead} rows from ${table} and its response body carried ${shown}. Read caps bound the count, so the loss may be larger, never smaller.`
            : `The request read ${rowsRead} rows from ${table}; the response body was unreadable, and the next on-screen number snapshot showed ${shown} values. A count of rendered numbers is not a row count — treat this as a pointer to check the response, not as a proven count.`,
        source: normalizeDbEngine(reads[0].d.engine),
      }),
      dedupeKey: `rowloss:${capturedUrlPath(exchange.url) ?? exchange.requestId}:${table}`,
    });
  }

  drafts.push(
    ...emitted
      .sort((a, b) => a.anchor.t - b.anchor.t)
      .slice(0, MAX_RESULT_ROW_LOSS_CANDIDATES),
  );
}

// ─── shared_state_bleed ──────────────────────────────────────────────────────

/**
 * Two reads of one URL that disagree, with nothing this session did in between,
 * is a strong observation with a weaker conclusion: another writer moved the
 * data. That could be a second user, a leaked session, or a legitimate
 * background job, so the score sits under the hard contradictions and the
 * confidence says medium.
 */
const SHARED_STATE_BLEED_SCORE = 80;

/**
 * shared_state_bleed: the same read answered differently while this session did
 * nothing.
 *
 * Two GETs of one URL, both 200, the second holding more (or different) items,
 * and no POST/PUT/PATCH/DELETE from this session anywhere between them. Server
 * state moved under a session that only looked at it — the shape of a cart, a
 * draft or a filter that is keyed on something shared rather than on the caller.
 *
 * Gated on the URL being stateful at all: some earlier mutating request in this
 * session must have addressed the same API root. Without that gate every
 * read-only dashboard polling a live feed reads as a defect, which is the
 * opposite of the finding.
 */
function addSharedStateBleedCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const mutations: Array<{ t: number; path: string }> = [];
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const method = (
      safeText(event.d.m, 20) ??
      safeText(event.d.method, 20) ??
      ""
    ).toUpperCase();
    if (!MUTATING_METHODS.has(method)) continue;
    const path = capturedUrlPath(safeText(event.d.url, 400));
    if (!path) continue;
    mutations.push({ t: event.t, path });
  }
  if (mutations.length === 0) return;

  interface Read {
    exchange: RequestExchange;
    res: BugEvent;
    collection: BodyCollection;
  }
  const byUrl = new Map<string, Read[]>();
  for (const exchange of exchanges.values()) {
    if (exchange.method !== "GET") continue;
    if (!isSuccessStatus(exchange.status) || !exchange.res) continue;
    const url = exchange.url;
    if (!url) continue;
    const collection = responseCollection(exchange.resBody, exchange.resBodyMeta);
    if (!collection) continue;
    const list = byUrl.get(url) ?? [];
    list.push({ exchange, res: exchange.res, collection });
    byUrl.set(url, list);
  }

  for (const [url, reads] of byUrl) {
    if (reads.length < 2) continue;
    reads.sort((a, b) => a.res.t - b.res.t);
    const path = capturedUrlPath(url);
    if (!path) continue;
    const prefix = apiPrefixOf(path);
    // Stateful gate: this session has written to this area before.
    const firstMutationToArea = mutations
      .filter((mutation) => mutation.path.startsWith(prefix))
      .sort((a, b) => a.t - b.t)[0];
    if (!firstMutationToArea) continue;

    for (let i = 1; i < reads.length; i += 1) {
      const before = reads[i - 1];
      const after = reads[i];
      if (firstMutationToArea.t >= before.exchange.req.t) continue;
      // Anything this session wrote anywhere in the span could explain the
      // change, so the span has to be clean end to end.
      const wroteInBetween = mutations.some(
        (mutation) =>
          mutation.t >= before.exchange.req.t && mutation.t <= after.res.t,
      );
      if (wroteInBetween) continue;

      const grew = after.collection.total > before.collection.total;
      // The item-set comparison needs both collections whole. The capture keeps
      // the first twenty entries of a longer array, and two different
      // twenty-first-onward tails share an identical prefix, so comparing
      // prefixes as sets would report agreement that was never established.
      const comparable =
        before.collection.complete && after.collection.complete;
      const beforeIds = comparable
        ? collectionIdentities(before.collection.items)
        : undefined;
      const afterIds = comparable
        ? collectionIdentities(after.collection.items)
        : undefined;
      const setChanged =
        beforeIds !== undefined &&
        afterIds !== undefined &&
        !sameIdentitySet(beforeIds, afterIds);
      if (!grew && !setChanged) continue;

      drafts.push({
        detector: "shared_state_bleed",
        title: `Server state changed between two identical reads this session never wrote to`,
        severity: "high",
        score: SHARED_STATE_BLEED_SCORE,
        confidence: "medium",
        anchor: removeUndefined({
          t: after.res.t,
          offsetMs:
            offsetForEvent(after.res) ??
            offsetFromStart(after.res.t, index.start),
          route: routeAt(index.navs ?? [], after.res.t),
          requestId: after.exchange.requestId,
          method: "GET",
          url: redactUrl(url),
          status: after.exchange.status,
          message: grew
            ? `Two GETs of this URL returned ${before.collection.total} then ${after.collection.total} items with no POST, PUT, PATCH or DELETE from this session anywhere between them. The session had written to ${prefix} earlier, so this URL is session-scoped state that moved on its own.`
            : `Two GETs of this URL returned the same number of items but a different set, with no POST, PUT, PATCH or DELETE from this session anywhere between them. The session had written to ${prefix} earlier, so this URL is session-scoped state that moved on its own.`,
        }),
        dedupeKey: `statebleed:${path}`,
      });
    }
  }
}

// ─── correlated batch imports ────────────────────────────────────────────────

interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** Small RFC-4180 parser for captured import bodies; malformed CSV is ignored. */
function parseCapturedCsv(value: unknown): ParsedCsv | undefined {
  if (typeof value !== "string" || !value.includes("\n")) return undefined;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '"') {
      if (quoted && value[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      record.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && value[i + 1] === "\n") i += 1;
      record.push(field);
      if (record.some((item) => item.length > 0)) records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) return undefined;
  record.push(field);
  if (record.some((item) => item.length > 0)) records.push(record);
  if (records.length < 2) return undefined;
  const width = records[0].length;
  if (width < 2 || records.some((row) => row.length !== width)) return undefined;
  return {
    headers: records[0].map((header) => header.replace(/^\uFEFF/, "").trim()),
    rows: records.slice(1),
  };
}

function csvColumn(
  csv: ParsedCsv,
  pattern: RegExp,
): number | undefined {
  const index = csv.headers.findIndex((header) => pattern.test(header));
  return index >= 0 ? index : undefined;
}

function scalarPkText(event: BugEvent): string | undefined {
  const entries = pkEntriesOf(event);
  if (entries.length !== 1) return undefined;
  return `${entries[0][0]}=${entries[0][1]}`;
}

/**
 * Names three high-signal batch contradictions using only one correlated
 * request: a response that claims more rows than it describes, one row updated
 * twice, and values shifted forward by one CSV row.
 */
function addBatchImportCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const diffs = dbDiffsByRequest(events);
  for (const exchange of exchanges.values()) {
    if (!isSuccessStatus(exchange.status) || !exchange.res) continue;
    const csv = parseCapturedCsv(exchange.body);
    if (!csv) continue;
    const response = parseStructuredBody(exchange.resBody);
    const requestDiffs = diffs.get(exchange.requestId) ?? [];

    if (isRecord(response)) {
      const applied =
        finiteNumber(response.applied) ?? finiteNumber(response.rows_applied);
      const total =
        finiteNumber(response.total) ?? finiteNumber(response.rows_total);
      const rows = response.rows;
      const errors = response.errors;
      if (
        applied !== undefined &&
        applied > 0 &&
        (total === undefined || total === csv.rows.length) &&
        applied === csv.rows.length &&
        Array.isArray(rows) &&
        rows.length < applied &&
        Array.isArray(errors) &&
        errors.length === 0
      ) {
        drafts.push({
          detector: "acknowledged_batch_rows_missing",
          title: `Batch reported ${applied} applied rows but described only ${rows.length}`,
          severity: "high",
          score: DB_INVARIANT_SCORE,
          confidence: "high",
          anchor: removeUndefined({
            t: exchange.res.t,
            offsetMs:
              offsetForEvent(exchange.res) ??
              offsetFromStart(exchange.res.t, index.start),
            route: routeAt(index.navs ?? [], exchange.res.t),
            requestId: exchange.requestId,
            method: exchange.method,
            url: redactUrl(exchange.url),
            status: exchange.status,
            message: `The CSV contained ${csv.rows.length} data rows. The successful response claimed ${applied} applied with no errors, but its result list contained ${rows.length}.`,
          }),
          dedupeKey: `batchmissing:${exchange.requestId}`,
        });
      }
    }

    const repeated = new Map<string, BugEvent[]>();
    for (const diff of requestDiffs) {
      if (safeText(diff.d.op, 20)?.toLowerCase() !== "update") continue;
      const table = safeText(diff.d.table, 160);
      const pk = scalarPkText(diff);
      if (!table || !pk) continue;
      const key = `${table}\u0000${pk}`;
      const group = repeated.get(key) ?? [];
      group.push(diff);
      repeated.set(key, group);
    }
    for (const [key, group] of repeated) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.t - b.t);
      const last = group[group.length - 1];
      const [table, pk] = key.split("\u0000");
      drafts.push({
        detector: "same_request_row_rewritten",
        title: `${bareTableName(table)} row ${pk} was updated ${group.length} times by one batch request`,
        severity: "high",
        score: DB_INVARIANT_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: last.t,
          offsetMs:
            offsetForEvent(last) ?? offsetFromStart(last.t, index.start),
          route: routeAt(index.navs ?? [], last.t),
          requestId: exchange.requestId,
          method: exchange.method,
          url: redactUrl(exchange.url),
          message: `One successful CSV request rewrote the same ${bareTableName(table)} primary key ${group.length} times. Distinct input rows collided on one database row, so an earlier imported value was overwritten before the response returned.`,
          source: normalizeDbEngine(last.d.engine),
        }),
        dedupeKey: `batchrewrite:${exchange.requestId}:${table}:${pk}`,
      });
    }

    const identityColumn = csvColumn(csv, /^(sku|slug|key|code)$/i);
    const valueColumn = csvColumn(
      csv,
      /(?:price|amount|total|cost|value)(?:_?cents?)?$/i,
    );
    if (identityColumn === undefined || valueColumn === undefined) continue;
    let shifted = 0;
    let anchor: BugEvent | undefined;
    for (let rowIndex = 0; rowIndex + 1 < csv.rows.length; rowIndex += 1) {
      const identity = csv.rows[rowIndex][identityColumn]?.trim();
      const expected = Number(csv.rows[rowIndex][valueColumn]);
      const next = Number(csv.rows[rowIndex + 1][valueColumn]);
      if (!identity || !Number.isFinite(expected) || !Number.isFinite(next))
        continue;
      const match = requestDiffs.find((diff) => {
        const after = isRecord(diff.d.after) ? diff.d.after : undefined;
        if (!after) return false;
        const dbIdentity =
          safeText(after.slug, 240) ??
          safeText(after.sku, 240) ??
          safeText(after.key, 240) ??
          safeText(after.code, 240);
        if (dbIdentity !== identity) return false;
        const actual =
          finiteNumber(after[csv.headers[valueColumn]]) ??
          finiteNumber(after.price_cents) ??
          finiteNumber(after.amount_cents);
        return actual === next && actual !== expected;
      });
      if (match) {
        shifted += 1;
        anchor = match;
      }
    }
    if (shifted >= 2 && anchor) {
      drafts.push({
        detector: "batch_value_shift",
        title: `${shifted} batch rows were written with the next CSV row's value`,
        severity: "high",
        score: DB_INVARIANT_SCORE + 2,
        confidence: "high",
        anchor: removeUndefined({
          t: anchor.t,
          offsetMs:
            offsetForEvent(anchor) ?? offsetFromStart(anchor.t, index.start),
          route: routeAt(index.navs ?? [], anchor.t),
          requestId: exchange.requestId,
          method: exchange.method,
          url: redactUrl(exchange.url),
          message: `${shifted} database updates matched a CSV row's identity but used the following row's ${csv.headers[valueColumn]} value. This is a consistent one-row shift, not an isolated mismatch.`,
          source: normalizeDbEngine(anchor.d.engine),
        }),
        dedupeKey: `batchshift:${exchange.requestId}:${csv.headers[valueColumn]}`,
      });
    }
  }
}

// ─── refund and return invariants ─────────────────────────────────────────────

interface RefundInsert {
  event: BugEvent;
  orderId: string;
  amount: number;
}

function orderIdFromRow(row: Record<string, unknown>): string | undefined {
  return keyValueOf(row.order_id) ?? keyValueOf(row.orderId);
}

/**
 * Cross-request lifecycle invariants: cumulative issued refunds may not exceed
 * the order total, and returning then refunding one order may not restock the
 * same item twice.
 */
function addRefundInvariantCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const orderTotals = new Map<string, number>();
  const refunds: RefundInsert[] = [];

  for (const event of events) {
    const table = safeText(event.d.table, 160);
    if (!table) continue;
    const bare = bareTableName(table).toLowerCase();
    const row =
      event.k === "db.read"
        ? isRecord(event.d.row)
          ? event.d.row
          : undefined
        : event.k === "db.diff" && isRecord(event.d.after)
          ? event.d.after
          : undefined;
    if (!row) continue;

    if (bare === "orders") {
      const orderId =
        keyValueOf(row.id) ??
        (isRecord(event.d.pk) ? keyValueOf(event.d.pk.id) : undefined);
      const total =
        finiteNumber(row.total_cents) ?? finiteNumber(row.totalCents);
      if (orderId && total !== undefined && total >= 0)
        orderTotals.set(orderId, total);
    }
    if (
      bare === "refunds" &&
      event.k === "db.diff" &&
      safeText(event.d.op, 20)?.toLowerCase() === "insert"
    ) {
      const orderId = orderIdFromRow(row);
      const amount =
        finiteNumber(row.amount_cents) ?? finiteNumber(row.amountCents);
      if (orderId && amount !== undefined && amount > 0)
        refunds.push({ event, orderId, amount });
    }
  }

  const refundsByOrder = new Map<string, RefundInsert[]>();
  for (const refund of refunds) {
    const list = refundsByOrder.get(refund.orderId) ?? [];
    list.push(refund);
    refundsByOrder.set(refund.orderId, list);
  }
  for (const [orderId, entries] of refundsByOrder) {
    const total = orderTotals.get(orderId);
    if (total === undefined) continue;
    entries.sort((a, b) => a.event.t - b.event.t);
    let refunded = 0;
    let exceeded: RefundInsert | undefined;
    for (const entry of entries) {
      refunded += entry.amount;
      if (refunded > total) {
        exceeded = entry;
        break;
      }
    }
    if (!exceeded) continue;
    drafts.push({
      detector: "refund_total_exceeded",
      title: `Issued refunds exceeded order ${orderId}'s total`,
      severity: "critical",
      score: DB_INVARIANT_SCORE + 4,
      confidence: "high",
      anchor: removeUndefined({
        t: exceeded.event.t,
        offsetMs:
          offsetForEvent(exceeded.event) ??
          offsetFromStart(exceeded.event.t, index.start),
        route: routeAt(index.navs ?? [], exceeded.event.t),
        requestId: safeText(exceeded.event.d.requestId, 120),
        message: `${entries.length} issued refund rows total ${refunded} cents against an order total of ${total} cents. The cumulative ledger exceeded the maximum refundable balance.`,
        source: normalizeDbEngine(exceeded.event.d.engine),
      }),
      dedupeKey: `overrefund:${orderId}`,
    });
  }

  interface Restock {
    event: BugEvent;
    requestId: string;
    orderId: string;
    productId: string;
    quantity: number;
    source: "return" | "refund";
  }
  const byRequest = dbDiffsByRequest(events);
  const readsByRequest = new Map<string, BugEvent[]>();
  for (const event of events) {
    if (event.k !== "db.read") continue;
    const requestId = safeText(event.d.requestId, 120);
    if (!requestId) continue;
    const list = readsByRequest.get(requestId) ?? [];
    list.push(event);
    readsByRequest.set(requestId, list);
  }

  const restocks: Restock[] = [];
  for (const [requestId, requestDiffs] of byRequest) {
    let orderId: string | undefined;
    let source: Restock["source"] | undefined;
    for (const diff of requestDiffs) {
      const table = bareTableName(safeText(diff.d.table, 160) ?? "").toLowerCase();
      const after = isRecord(diff.d.after) ? diff.d.after : undefined;
      if (!after) continue;
      if (
        table === "orders" &&
        safeText(after.status, 40)?.toLowerCase() === "returned"
      ) {
        orderId =
          keyValueOf(after.id) ??
          (isRecord(diff.d.pk) ? keyValueOf(diff.d.pk.id) : undefined);
        source = "return";
      } else if (
        table === "refunds" &&
        safeText(diff.d.op, 20)?.toLowerCase() === "insert"
      ) {
        orderId = orderIdFromRow(after);
        source = "refund";
      }
    }
    if (!orderId || !source) continue;

    const itemReads = (readsByRequest.get(requestId) ?? []).flatMap((read) => {
      if (
        bareTableName(safeText(read.d.table, 160) ?? "").toLowerCase() !==
          "order_items" ||
        !isRecord(read.d.row)
      )
        return [];
      const productId =
        keyValueOf(read.d.row.product_id) ?? keyValueOf(read.d.row.productId);
      const quantity =
        finiteNumber(read.d.row.qty) ?? finiteNumber(read.d.row.quantity);
      return productId && quantity !== undefined && quantity > 0
        ? [{ productId, quantity }]
        : [];
    });
    for (const diff of requestDiffs) {
      if (
        bareTableName(safeText(diff.d.table, 160) ?? "").toLowerCase() !==
        "products"
      )
        continue;
      const before = isRecord(diff.d.before) ? diff.d.before : undefined;
      const after = isRecord(diff.d.after) ? diff.d.after : undefined;
      if (!before || !after) continue;
      const previous = finiteNumber(before.inventory);
      const current = finiteNumber(after.inventory);
      const productId =
        keyValueOf(after.id) ??
        (isRecord(diff.d.pk) ? keyValueOf(diff.d.pk.id) : undefined);
      if (
        previous === undefined ||
        current === undefined ||
        !productId ||
        current <= previous
      )
        continue;
      const quantity = current - previous;
      if (
        !itemReads.some(
          (item) =>
            item.productId === productId && item.quantity === quantity,
        )
      )
        continue;
      restocks.push({
        event: diff,
        requestId,
        orderId,
        productId,
        quantity,
        source,
      });
    }
  }

  const groupedRestocks = new Map<string, Restock[]>();
  for (const restock of restocks) {
    const key = `${restock.orderId}\u0000${restock.productId}`;
    const list = groupedRestocks.get(key) ?? [];
    list.push(restock);
    groupedRestocks.set(key, list);
  }
  for (const [key, entries] of groupedRestocks) {
    if (
      entries.length < 2 ||
      !entries.some((entry) => entry.source === "return") ||
      !entries.some((entry) => entry.source === "refund")
    )
      continue;
    entries.sort((a, b) => a.event.t - b.event.t);
    const last = entries[entries.length - 1];
    const [orderId, productId] = key.split("\u0000");
    const totalQuantity = entries.reduce(
      (sum, entry) => sum + entry.quantity,
      0,
    );
    drafts.push({
      detector: "duplicate_restock",
      title: `Order ${orderId} restocked product ${productId} twice`,
      severity: "high",
      score: DB_INVARIANT_SCORE + 2,
      confidence: "high",
      anchor: removeUndefined({
        t: last.event.t,
        offsetMs:
          offsetForEvent(last.event) ??
          offsetFromStart(last.event.t, index.start),
        route: routeAt(index.navs ?? [], last.event.t),
        requestId: last.requestId,
        message: `The return transition restored this order item's quantity, then a separate refund request restored it again. ${entries.length} inventory increases added ${totalQuantity} units for the same order and product.`,
        source: normalizeDbEngine(last.event.d.engine),
      }),
      dedupeKey: `duplicaterestock:${orderId}:${productId}`,
    });
  }
}

// ─── acknowledged_write_lost ─────────────────────────────────────────────────

/**
 * Two 200s and one row is data loss the client was explicitly promised would
 * not happen, so this sits with `lost_update` and `duplicate_write` rather than
 * below them. One point under {@link DB_INVARIANT_SCORE} because the comparison
 * is made across HTTP rather than across two images of the same row.
 */
const ACKNOWLEDGED_WRITE_LOST_SCORE = 88;

/**
 * The stable target a mutating request addressed, from its own body.
 *
 * A REQUEST body has no `bodyMeta` — that summary is built for responses only —
 * so this parses the captured text, which is exact because nothing capped it.
 */
function bodyTargetKey(body: unknown): string | undefined {
  const payload = responsePayload(body);
  if (payload === undefined) return undefined;
  const ids: string[] = [];
  for (const scope of collectObjectScopes(payload)) {
    for (const [name, value] of Object.entries(scope)) {
      if (!isIdLikeField(name)) continue;
      if (typeof value !== "string" && toFiniteNumber(value) === undefined)
        continue;
      ids.push(`${normalizeFieldName(name)}=${String(value)}`);
    }
  }
  if (ids.length === 0) return undefined;
  return [...new Set(ids)].sort().join("&");
}

/** The id value a target key names, for matching an item inside a collection. */
function targetIdValues(targetKey: string): string[] {
  return targetKey
    .split("&")
    .map((entry) => entry.split("=")[1])
    .filter((value): value is string => value !== undefined && value !== "");
}

/**
 * acknowledged_write_lost: the server said yes twice and kept one.
 *
 * Two POSTs to the same collection endpoint with the same target, both answered
 * 2xx, and a later read of that collection holding fewer items — or a smaller
 * quantity on the target row — than those acknowledgements imply. The client was
 * told both writes landed. One did.
 *
 * The comparison is anchored on a read taken BEFORE the writes wherever one
 * exists, so the claim is about the delta this session caused rather than about
 * an absolute count the detector would have to assume started at zero. Without a
 * pre-read only the quantity comparison runs, and it treats the starting
 * quantity as zero, which under-claims rather than over-claims.
 */
function addAcknowledgedWriteLostCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  interface Ack {
    exchange: RequestExchange;
    res: BugEvent;
    quantity?: number;
  }
  const groups = new Map<string, Ack[]>();
  for (const exchange of exchanges.values()) {
    // Additive semantics only. A PUT replaces and a DELETE removes, so "two
    // acknowledgements imply two items" is simply untrue for them.
    if (exchange.method !== "POST") continue;
    if (!isSuccessStatus(exchange.status) || !exchange.res) continue;
    if (!exchange.url) continue;
    const target = bodyTargetKey(exchange.body) ?? "";
    const key = `${exchange.url} ${target}`;
    const list = groups.get(key) ?? [];
    // Request body again: parsed from the captured text, with no `bodyMeta`.
    const payload = responsePayload(exchange.body);
    const quantity = collectObjectScopes(payload)
      .map((scope) => soleQuantityOf(scope))
      .find((value) => value !== undefined);
    list.push(
      quantity === undefined
        ? { exchange, res: exchange.res }
        : { exchange, res: exchange.res, quantity },
    );
    groups.set(key, list);
  }

  // Every readable collection read in the session, keyed by collection path.
  interface CollectionRead {
    exchange: RequestExchange;
    res: BugEvent;
    collection: BodyCollection;
  }
  const readsByPath = new Map<string, CollectionRead[]>();
  for (const exchange of exchanges.values()) {
    if (exchange.method !== "GET") continue;
    if (!isSuccessStatus(exchange.status) || !exchange.res) continue;
    const path = capturedUrlPath(exchange.url);
    if (!path) continue;
    const collection = responseCollection(exchange.resBody, exchange.resBodyMeta);
    if (!collection) continue;
    const list = readsByPath.get(path) ?? [];
    list.push({ exchange, res: exchange.res, collection });
    readsByPath.set(path, list);
  }

  for (const [key, acks] of groups) {
    if (acks.length < 2) continue;
    acks.sort((a, b) => a.exchange.req.t - b.exchange.req.t);
    const first = acks[0];
    const last = acks[acks.length - 1];
    const path = capturedUrlPath(first.exchange.url);
    if (!path) continue;
    const reads = (readsByPath.get(path) ?? []).sort((a, b) => a.res.t - b.res.t);
    if (reads.length === 0) continue;

    const baseline = [...reads]
      .reverse()
      .find((read) => read.res.t < first.exchange.req.t);
    const observed = reads.find(
      (read) => read.exchange.req.t > last.res.t,
    );
    if (!observed) continue;

    const targetKey = key.split(" ")[1] ?? "";
    const targetIds = targetIdValues(targetKey);
    const quantities = acks.map((ack) => ack.quantity);
    const impliedQuantity = quantities.every(
      (quantity): quantity is number => quantity !== undefined,
    )
      ? quantities.reduce((sum, quantity) => sum + quantity, 0)
      : undefined;

    const observedRow = findCollectionItem(observed.collection.items, targetIds);
    const baselineRow = baseline
      ? findCollectionItem(baseline.collection.items, targetIds)
      : undefined;
    const observedQuantity = soleQuantityOf(observedRow);
    const baselineQuantity = soleQuantityOf(baselineRow) ?? 0;

    let message: string | undefined;
    if (impliedQuantity !== undefined && observedQuantity !== undefined) {
      if (observedQuantity < baselineQuantity + impliedQuantity) {
        message = `${acks.length} POSTs to this endpoint were each answered ${first.exchange.status}, adding ${impliedQuantity} in total to a starting quantity of ${baselineQuantity}. The next read of the collection shows ${observedQuantity}.`;
      }
    } else if (baseline) {
      if (observed.collection.total < baseline.collection.total + acks.length) {
        message = `${acks.length} POSTs to this endpoint were each answered ${first.exchange.status}. The collection held ${baseline.collection.total} items before them and ${observed.collection.total} after, which is ${baseline.collection.total + acks.length - observed.collection.total} fewer than the acknowledgements imply.`;
      }
    }
    if (!message) continue;

    drafts.push({
      detector: "acknowledged_write_lost",
      title: `${acks.length} writes were acknowledged but the collection kept fewer`,
      severity: "high",
      score: ACKNOWLEDGED_WRITE_LOST_SCORE,
      confidence: baseline ? "high" : "medium",
      anchor: removeUndefined({
        t: observed.res.t,
        offsetMs:
          offsetForEvent(observed.res) ??
          offsetFromStart(observed.res.t, index.start),
        route: routeAt(index.navs ?? [], observed.res.t),
        requestId: last.exchange.requestId,
        method: "POST",
        url: redactUrl(first.exchange.url),
        status: last.exchange.status,
        message: scrubText(message, 300),
      }),
      dedupeKey: `ackwritelost:${path}:${targetKey}`,
    });
  }
}

/** The item in a collection whose id-like value matches one of `ids`. */
function findCollectionItem(
  items: unknown[],
  ids: string[],
): Record<string, unknown> | undefined {
  const records = items.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) && !isRedactedPlaceholder(item),
  );
  if (records.length === 0) return undefined;
  if (ids.length === 0) return records.length === 1 ? records[0] : undefined;
  return records.find((item) =>
    Object.entries(item).some(
      ([name, value]) =>
        isIdLikeField(name) &&
        (typeof value === "string" || toFiniteNumber(value) !== undefined) &&
        ids.includes(String(value)),
    ),
  );
}

// ─── runtime_warning ─────────────────────────────────────────────────────────

/**
 * A `MaxListenersExceededWarning` is the platform stating, with a threshold
 * behind it, that something subscribes and never unsubscribes. That outranks a
 * console warning the app chose to print and sits under an actual fault. Every
 * other warning class keeps the medium tier: real, but a statement about the
 * code rather than about this session.
 */
const MAX_LISTENERS_WARNING_SCORE = 74;
const RUNTIME_WARNING_SCORE = 54;
const MAX_LISTENERS_WARNING_NAME = "MaxListenersExceededWarning";

/**
 * runtime_warning: the Node runtime announced a defect the application never
 * logged.
 *
 * `process.on("warning")` is a channel almost no application reads. A leaked
 * listener, an API already scheduled for removal, a deprecated buffer
 * constructor — the runtime says all of it out loud, into a stream that goes
 * nowhere. Identical warnings collapse into one candidate carrying the count,
 * because a leak's whole signature is the same warning firing over and over.
 */
function addRuntimeWarningCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "backend.warning") continue;
    const name = safeText(event.d.name, 120) ?? "Warning";
    const message = scrubText(event.d.message, 220);
    const isListenerLeak = name === MAX_LISTENERS_WARNING_NAME;
    drafts.push({
      detector: "runtime_warning",
      title: `Node runtime warning: ${name}${message ? ` — ${truncate(message, 90)}` : ""}`,
      severity: isListenerLeak ? "high" : "medium",
      score: isListenerLeak
        ? MAX_LISTENERS_WARNING_SCORE
        : RUNTIME_WARNING_SCORE,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId: safeText(event.d.requestId, 120),
        errorCode: name,
        message,
        source: "backend",
        frame: codeFrameOf({
          stk: typeof event.d.stack === "string" ? event.d.stack : undefined,
        }),
      }),
      // Content signature, not the timestamp: a leak re-warns on every request
      // and has to read as one finding with a count, not as fifty findings.
      dedupeKey: `runtimewarning:${name}:${normalizeErrorSignature(event.d.message)}`,
    });
  }
}

// ─── declined_payment_ordered ───────────────────────────────────────────────

const DECLINED_PAYMENT_ORDERED_SCORE = 94;
const DECLINED_PAYMENT_ORDERED_WINDOW_MS = 10_000;

/**
 * declined_payment_ordered: a payment gateway explicitly declined a charge,
 * but the same request lifecycle still inserted an order.
 */
function addDeclinedPaymentOrderedCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const declined = events.filter(
    (event) =>
      event.k === "backend.http" &&
      safeText(event.d.service, 80)?.toLowerCase() === "payments" &&
      safeText(event.d.chargeStatus, 80)?.toLowerCase() === "declined",
  );
  for (const failure of declined) {
    const order = events.find(
      (event) =>
        event.k === "db.diff" &&
        event.d.table === "orders" &&
        event.d.op === "insert" &&
        event.t >= failure.t &&
        event.t <= failure.t + DECLINED_PAYMENT_ORDERED_WINDOW_MS,
    );
    if (!order) continue;
    drafts.push({
      detector: "declined_payment_ordered",
      title: `An order was placed after its payment was declined`,
      severity: "critical",
      score: DECLINED_PAYMENT_ORDERED_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: order.t,
        offsetMs:
          offsetForEvent(order) ?? offsetFromStart(order.t, index.start),
        route: routeAt(index.navs ?? [], order.t),
        requestId: correlationIdOf(order),
        table: "orders",
        source: normalizeDbEngine(order.d.engine),
        message:
          `The payments service returned chargeStatus=declined` +
          `${safeText(failure.d.failureCode, 80) ? ` (${safeText(failure.d.failureCode, 80)})` : ""}, ` +
          `then an orders row was inserted ${order.t - failure.t} ms later.`,
      }),
      dedupeKey: `declinedordered:${correlationIdOf(order) ?? order.t}`,
    });
  }
}

// ─── stored_active_markup ───────────────────────────────────────────────────

const STORED_ACTIVE_MARKUP_SCORE = 96;
const ACTIVE_MARKUP_RE =
  /<(?:script|iframe|object|embed)\b|<[^>]+\bon[a-z]+\s*=|javascript\s*:/i;

/**
 * stored_active_markup: a database write persisted markup that can execute in
 * a browser. The value itself is never repeated in the candidate.
 */
function addStoredActiveMarkupCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "db.diff" || event.d.op === "delete") continue;
    const after = event.d.after;
    if (!isRecord(after)) continue;
    const field = collectFieldEntries(after).find(
      ([, value]) => typeof value === "string" && ACTIVE_MARKUP_RE.test(value),
    );
    if (!field) continue;
    const table = safeText(event.d.table, 120) ?? "a database table";
    drafts.push({
      detector: "stored_active_markup",
      title: `Executable markup was persisted to ${table}.${field[0]}`,
      severity: "critical",
      score: STORED_ACTIVE_MARKUP_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId: correlationIdOf(event),
        table,
        source: normalizeDbEngine(event.d.engine),
        message:
          `A ${event.d.op} wrote a string containing an executable HTML construct ` +
          `to ${table}.${field[0]}. The stored value is omitted from this finding.`,
      }),
      dedupeKey: `storedmarkup:${table}:${field[0]}`,
    });
  }
}

// ─── input_reverted ──────────────────────────────────────────────────────────

/** How long after a user keystroke a programmatic write still reads as a revert. */
const INPUT_REVERT_WINDOW_MS = 10_000;
/**
 * The app taking back what the user typed is a defect they can see and cannot
 * work around, so it ranks with the response-level failures. Confidence stays
 * medium because the comparison is usually made on redacted lengths: a
 * controlled component legitimately rewriting a formatted value has the same
 * shape as a field being cleared.
 */
const INPUT_REVERTED_SCORE = 80;

/** The field an `inp` event is about, stable across events. */
function inputFieldKey(event: BugEvent): string | undefined {
  const el = isRecord(event.d.el) ? event.d.el : undefined;
  return (
    safeText(el?.name, 120) ??
    safeText(el?.id, 120) ??
    safeText(el?.sig, 120) ??
    safeText(el?.path, 200) ??
    elementLabel(event)
  );
}

/** The length of the value an `inp` event carried, redacted or not. */
function inputValueLength(event: BugEvent): number | undefined {
  const summary = isRecord(event.d.valSummary) ? event.d.valSummary : undefined;
  const declared = finiteNumber(summary?.originalLength);
  if (declared !== undefined) return declared;
  const value = event.d.val;
  if (typeof value !== "string") return undefined;
  if (isRedactedValue(value)) return undefined;
  return value.length;
}

/** The comparable value of an `inp` event, when it was not redacted away. */
function inputComparableValue(event: BugEvent): string | undefined {
  const value = event.d.val;
  if (typeof value !== "string" || isRedactedValue(value)) return undefined;
  if (/^[*•]+$/.test(value)) return undefined; // masked, not a value
  return value;
}

/**
 * input_reverted: the application overwrote what the user typed.
 *
 * Two `inp` events on one field: a trusted one (the user's keystrokes) and,
 * within ten seconds, an untrusted one (the app writing to the field) that
 * shortens or replaces the value. It is the mechanism behind every "it keeps
 * clearing my form" report, and no other signal names it — nothing fails, no
 * request is made, and the field simply is not what the user left it as.
 *
 * Values are usually redacted, so the comparison is made on
 * `valSummary.originalLength`. A programmatic write that lengthens the value is
 * ignored: autocompletion and formatting do that, and neither is a revert.
 */
function addInputRevertedCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const inputs = events
    .filter((event) => event.k === "inp")
    .sort((a, b) => a.t - b.t);
  if (inputs.length < 2) return;

  const lastTrusted = new Map<string, BugEvent>();
  for (const event of inputs) {
    const field = inputFieldKey(event);
    if (!field) continue;
    const trusted = event.d.trusted;
    if (trusted === true) {
      lastTrusted.set(field, event);
      continue;
    }
    if (trusted !== false) continue; // no provenance captured → no claim
    const typed = lastTrusted.get(field);
    if (!typed || event.t - typed.t > INPUT_REVERT_WINDOW_MS) continue;

    const before = inputValueLength(typed);
    const after = inputValueLength(event);
    if (before === undefined || after === undefined) continue;

    let how: string | undefined;
    if (after < before) {
      how =
        after === 0
          ? `cleared the field (${before} characters typed, 0 left)`
          : `shortened the value from ${before} to ${after} characters`;
    } else if (after === before) {
      const typedValue = inputComparableValue(typed);
      const writtenValue = inputComparableValue(event);
      if (
        typedValue !== undefined &&
        writtenValue !== undefined &&
        typedValue !== writtenValue
      ) {
        how = `replaced the value with a different one of the same length (${after} characters)`;
      }
    }
    if (!how) continue;

    const label = scrubText(elementLabel(event) ?? field, 100) ?? "a field";
    drafts.push({
      detector: "input_reverted",
      title: `The app overwrote what the user typed into ${label}`,
      severity: "high",
      score: INPUT_REVERTED_SCORE,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        target: targetForEvent(event),
        elementLabel: scrubText(elementLabel(event), 160),
        message: `A user keystroke on this field was followed ${event.t - typed.t} ms later by a programmatic write (untrusted event) that ${how}. Values are redacted, so the comparison is on captured lengths.`,
      }),
      dedupeKey: `inputreverted:${field}`,
    });
  }
}

// ─── form_reset_after_error ─────────────────────────────────────────────────

const FORM_RESET_AFTER_ERROR_WINDOW_MS = 2_000;
const FORM_RESET_AFTER_ERROR_SCORE = 79;

/**
 * form_reset_after_error: a failed submit was followed by multiple controls
 * being silently cleared. The interaction collector emits `ev:"state"` only
 * when a snapshotted control changed without a user input event, including
 * framework remounts, so two empty controls after a 4xx response is the
 * high-signal "one validation error wiped my form" shape.
 */
function addFormResetAfterErrorCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const ordered = [...events].sort((a, b) => a.t - b.t);
  for (const submit of ordered) {
    if (submit.k !== "inp" || submit.d.ev !== "submit") continue;
    const failure = ordered.find(
      (event) =>
        event.k === "net.res" &&
        event.t >= submit.t &&
        event.t <= submit.t + FORM_RESET_AFTER_ERROR_WINDOW_MS &&
        (finiteNumber(event.d.st) ?? 0) >= 400 &&
        (finiteNumber(event.d.st) ?? 0) < 500,
    );
    if (!failure) continue;

    const cleared = ordered.filter(
      (event) =>
        event.k === "inp" &&
        event.d.ev === "state" &&
        event.d.trusted === false &&
        event.t >= failure.t &&
        event.t <= submit.t + FORM_RESET_AFTER_ERROR_WINDOW_MS &&
        inputValueLength(event) === 0,
    );
    const fields = [
      ...new Set(
        cleared
          .map(inputFieldKey)
          .filter((field): field is string => field !== undefined),
      ),
    ];
    if (fields.length < 2) continue;

    drafts.push({
      detector: "form_reset_after_error",
      title: `A failed submit silently cleared ${fields.length} form fields`,
      severity: "high",
      score: FORM_RESET_AFTER_ERROR_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: cleared[0].t,
        offsetMs:
          offsetForEvent(cleared[0]) ??
          offsetFromStart(cleared[0].t, index.start),
        route: routeAt(index.navs ?? [], cleared[0].t),
        requestId: correlationIdOf(failure),
        target: targetForEvent(submit),
        message:
          `The submit received HTTP ${finiteNumber(failure.d.st)}, then the app ` +
          `changed ${fields.length} snapshotted controls to empty without user input. ` +
          `Fields are identified structurally; their values remain redacted.`,
      }),
      dedupeKey: `formreset:${routeAt(index.navs ?? [], submit.t) ?? "unknown"}`,
    });
  }
}

// ─── display_date_timezone_mismatch ─────────────────────────────────────────

const DISPLAY_DATE_TIMEZONE_MISMATCH_SCORE = 76;
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function epochDayInTimezone(instant: string, timezone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);
    if (![year, month, day].every(Number.isFinite)) return undefined;
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  } catch {
    return undefined;
  }
}

/**
 * display_date_timezone_mismatch: the page rendered an API timestamp's UTC
 * calendar day even though that instant belongs to another day locally.
 *
 * The browser collector represents a visible YYYY-MM-DD as an epoch-day
 * number under `unit:"iso-day"`. API timestamps remain canonical ISO strings.
 * Matching the visible day to the instant's UTC day while it differs from the
 * session timezone's day is direct evidence of `toISOString().slice(0, 10)`
 * style formatting.
 */
function addDisplayDateTimezoneMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const timezone = events
    .filter((event) => event.k === "env")
    .map((event) => safeText(event.d.timezone, 80))
    .find((value): value is string => value !== undefined);
  if (!timezone) return;

  const sources: Array<{
    utcDay: number;
    localDay: number;
    requestId?: string;
  }> = [];
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const payload = responsePayload(event.d.body, event.d.bodyMeta);
    if (payload === undefined) continue;
    for (const [name, value] of collectFieldEntries(payload)) {
      if (!/(?:^|_)(?:created|updated|placed|occurred)_?at$/.test(name)) continue;
      if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) continue;
      const at = Date.parse(value);
      const localDay = epochDayInTimezone(value, timezone);
      if (!Number.isFinite(at) || localDay === undefined) continue;
      sources.push({
        utcDay: Math.floor(at / 86_400_000),
        localDay,
        requestId: correlationIdOf(event),
      });
    }
  }
  if (sources.length === 0) return;

  for (const event of events) {
    if (event.k !== "ui.num") continue;
    for (const item of uiNumItems(event)) {
      if (item.unit !== "iso-day") continue;
      const source = sources.find(
        (entry) =>
          entry.utcDay === item.value && entry.localDay !== entry.utcDay,
      );
      if (!source) continue;
      drafts.push({
        detector: "display_date_timezone_mismatch",
        title: `A date was rendered in UTC instead of ${timezone}`,
        severity: "high",
        score: DISPLAY_DATE_TIMEZONE_MISMATCH_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: event.t,
          offsetMs:
            offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId: source.requestId,
          elementLabel: scrubText(item.label, 120),
          message:
            `The displayed day for ${scrubText(item.label, 100) ?? "this item"} ` +
            `matches the API timestamp's UTC calendar day, but that instant falls ` +
            `on a different day in the captured browser timezone (${timezone}).`,
        }),
        dedupeKey: `displaydatetz:${timezone}:${item.label}`,
      });
      return;
    }
  }
}

// ─── currency_locale_mismatch ────────────────────────────────────────────────

/**
 * A currency symbol read against a language tag is a guess about intent, not a
 * measurement, so it ranks below the console plane and its detail text says so
 * outright.
 */
const CURRENCY_LOCALE_MISMATCH_SCORE = 52;
/** Symbols this rule is willing to reason about. */
const CURRENCY_SYMBOLS = new Set(["$", "€", "£", "¥"]);
/** Language prefixes whose default presentation currency is the euro. */
const EURO_LANGUAGE_PREFIXES = new Set(["de", "fr", "es", "it", "nl"]);

/**
 * The currency symbol a page's language tag implies.
 *
 * Frankly approximate: `de-CH` bills in francs and an English page can price in
 * anything it likes. The mapping is only ever used to notice that a page
 * declaring one locale is rendering another locale's symbol, which is the
 * mis-localised-price defect; it is never used to assert what the price should
 * be.
 */
function expectedCurrencyForLang(lang: string): string | undefined {
  const parts = lang.trim().toLowerCase().split(/[-_]/).filter(Boolean);
  const base = parts[0];
  if (!base) return undefined;
  const region = parts[1]?.toUpperCase();
  if (EURO_LANGUAGE_PREFIXES.has(base)) return "€";
  if (region === "EU") return "€";
  if (base === "en" && region === "GB") return "£";
  if (base === "ja") return "¥";
  if (base === "en") return "$";
  return undefined;
}

/**
 * currency_locale_mismatch: the page declares one locale and prices in another
 * locale's currency.
 *
 * Heuristic by construction, and gated to match: it needs a declared `lang`, a
 * symbol it recognises, and either two mismatching amounts in one snapshot or
 * the same mismatch surviving into a second snapshot. One stray symbol on one
 * render is not enough.
 */
function addCurrencyLocaleMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const snapshots = events
    .filter((event) => event.k === "ui.num")
    .sort((a, b) => a.t - b.t);
  if (snapshots.length === 0) return;

  // (lang, rendered symbol) → the emission that first showed it.
  const pending = new Map<string, { event: BugEvent; expected: string }>();
  for (const event of snapshots) {
    const lang = safeText(event.d.lang, 40);
    if (!lang) continue;
    const expected = expectedCurrencyForLang(lang);
    if (!expected) continue;

    const mismatched = new Map<string, number>();
    for (const item of uiNumItems(event)) {
      const unit = item.unit?.trim();
      if (!unit || !CURRENCY_SYMBOLS.has(unit)) continue;
      if (unit === expected) continue;
      mismatched.set(unit, (mismatched.get(unit) ?? 0) + 1);
    }

    for (const [unit, count] of mismatched) {
      const key = `${lang} ${unit}`;
      const earlier = pending.get(key);
      // Two amounts in one snapshot, or the same mismatch on two consecutive
      // emissions. Either way the page is consistently rendering the wrong
      // symbol rather than carrying one odd number.
      if (count < 2 && !earlier) {
        pending.set(key, { event, expected });
        continue;
      }
      const anchor = earlier?.event ?? event;
      drafts.push({
        detector: "currency_locale_mismatch",
        title: `Page declares lang "${lang}" but prices in ${unit}`,
        severity: "medium",
        score: CURRENCY_LOCALE_MISMATCH_SCORE,
        confidence: "low",
        anchor: removeUndefined({
          t: anchor.t,
          offsetMs:
            offsetForEvent(anchor) ?? offsetFromStart(anchor.t, index.start),
          route: routeAt(index.navs ?? [], anchor.t),
          message: `The document declares \`lang="${lang}"\`, whose usual presentation currency is ${expected}, while ${count > 1 ? `${count} on-screen amounts render` : "the on-screen amounts render"} in ${unit}. This is a heuristic: the language a page is written in does not decide what currency it may bill in, so read this as a prompt to check the formatter, not as a proven defect.`,
        }),
        dedupeKey: `currencylocale:${lang}:${unit}`,
      });
      pending.delete(key);
    }
  }
}

// ─── layout_overflow ─────────────────────────────────────────────────────────

/** Horizontal overflow below this many pixels is measurement noise. */
const LAYOUT_OVERFLOW_MIN_PX = 24;
const LAYOUT_OVERFLOW_SCORE = 56;
/**
 * Right-to-left layout is where horizontal overflow stops being cosmetic: a
 * mirrored axis usually means content is running off the side the reader starts
 * from, so it is not merely ugly, it is unreachable.
 */
const LAYOUT_OVERFLOW_RTL_SCORE = 70;

/**
 * layout_overflow: the document is wider than its viewport.
 *
 * `scrollWidth - clientWidth` is a measured number, not an opinion, which is why
 * this carries high confidence at a modest score: the overflow certainly exists,
 * and whether it matters depends on the design. One candidate per URL, carrying
 * the worst measurement seen there.
 */
function addLayoutOverflowCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const worstByUrl = new Map<string, { event: BugEvent; overflow: number }>();
  for (const event of events) {
    if (event.k !== "ui.layout") continue;
    const overflow = finiteNumber(event.d.overflowX);
    if (overflow === undefined || overflow <= LAYOUT_OVERFLOW_MIN_PX) continue;
    const url = safeText(event.d.url, 400) ?? "unknown URL";
    const existing = worstByUrl.get(url);
    if (existing && existing.overflow >= overflow) continue;
    worstByUrl.set(url, { event, overflow });
  }

  for (const [url, worst] of worstByUrl) {
    const dir = safeText(worst.event.d.dir, 20)?.toLowerCase() ?? "ltr";
    const isRtl = dir === "rtl";
    const scrollW = finiteNumber(worst.event.d.scrollW);
    const clientW = finiteNumber(worst.event.d.clientW);
    drafts.push({
      detector: "layout_overflow",
      title: `Page overflows its viewport by ${Math.round(worst.overflow)} px (dir ${dir})`,
      severity: isRtl ? "high" : "medium",
      score: isRtl ? LAYOUT_OVERFLOW_RTL_SCORE : LAYOUT_OVERFLOW_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: worst.event.t,
        offsetMs:
          offsetForEvent(worst.event) ??
          offsetFromStart(worst.event.t, index.start),
        route: routeAt(index.navs ?? [], worst.event.t),
        url: redactUrl(url),
        message: `dir=${dir}, horizontal overflow ${Math.round(worst.overflow)} px${
          scrollW !== undefined && clientW !== undefined
            ? ` (scrollWidth ${Math.round(scrollW)} vs clientWidth ${Math.round(clientW)})`
            : ""
        } at ${redactUrl(url) ?? "unknown URL"}.${
          isRtl
            ? " The axis is mirrored, so the overflowing edge is the one the reader starts from."
            : ""
        }`,
      }),
      dedupeKey: `layoutoverflow:${url}`,
    });
  }
}

// ─── stale_view_after_pop ────────────────────────────────────────────────────

/** How long after a navigation the view's data call is expected to start. */
const STALE_VIEW_REACTION_MS = 2_000;
/**
 * How far BEFORE a navigation event its own data call may sit and still belong
 * to it.
 *
 * Routers do not commit first and fetch second. A handler typically starts the
 * fetch and then calls `pushState`, so a live session reads
 * `net.req /api/search?q=sonar&category=audio` at T and
 * `nav push /search?q=sonar&category=audio` at T+100. An earlier revision
 * required the request to land strictly AFTER the nav event and therefore
 * concluded the view had never been shown to react at all, which silenced the
 * detector on the exact signature it exists to catch.
 */
const STALE_VIEW_REACTION_LEAD_MS = 750;
/**
 * The same allowance on the pop side, deliberately much smaller.
 *
 * On this side a nearby request is a reason to STAY SILENT, so a generous
 * lookback suppresses real findings: a call issued a second before the user
 * pressed back was serving the previous state and says nothing about whether
 * the pop was handled. 250 ms covers only a pop whose own fetch raced its nav
 * event, which is the one case a lookback is here to forgive.
 */
const STALE_VIEW_POP_LEAD_MS = 250;
const STALE_VIEW_SCORE = 78;

/**
 * Whether an API request plausibly serves a navigation, judged on their query
 * strings.
 *
 * One shared parameter is enough — a route's `?q=sonar&category=audio` and its
 * call's `/api/search?q=sonar&category=audio` agree on both, and a route that
 * carries a `page` its API spells differently still agrees on the rest.
 * Deliberately permissive in the other direction: when either side carries no
 * query at all, or a value was redacted away, there is nothing to disagree
 * about, so this must not veto.
 */
function navigationQueryRelated(
  navUrl: URL,
  requestUrl: string | undefined,
): boolean {
  const request = parseCapturedUrl(requestUrl);
  if (!request) return true;
  const navPairs = [...navUrl.searchParams];
  const requestPairs = [...request.searchParams];
  if (navPairs.length === 0 || requestPairs.length === 0) return true;
  return navPairs.some(([name, value]) =>
    requestPairs.some(([otherName, otherValue]) => {
      if (normalizeFieldName(name) !== normalizeFieldName(otherName))
        return false;
      // A redacted value on either side is an unknown, not a disagreement.
      if (isRedactedValue(value) || isRedactedValue(otherValue)) return true;
      return value === otherValue;
    }),
  );
}

/**
 * stale_view_after_pop: the back button changed the URL and nothing else.
 *
 * The same page had already proved it reacts to a parameter change — a
 * navigation to this path with different parameters had a data call around it.
 * Then the user pressed back, the URL changed again, and no call followed. The
 * address bar and the screen now disagree, and the app reports nothing at all:
 * this is the one navigation class where the router is doing its job and the
 * view is not.
 *
 * The two windows are asymmetric on purpose, because finding a request means
 * opposite things on the two sides. On the reactive side a request is what
 * establishes the precondition, so the window reaches back far enough to catch
 * a fetch that beat its own `pushState`. On the pop side a request is what
 * withdraws the claim, so the window reaches back only far enough to forgive
 * the same race, and no further.
 */
function addStaleViewAfterPopCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const navs = events
    .filter(isNavigationEvent)
    .sort((a, b) => a.t - b.t)
    .map((event) => ({
      event,
      url: safeText(event.d.to, 400) ?? safeText(event.d.path, 400),
      transition: safeText(event.d.tr, 20),
    }))
    .filter(
      (
        entry,
      ): entry is {
        event: BugEvent;
        url: string;
        transition: string | undefined;
      } => entry.url !== undefined,
    );
  if (navs.length < 2) return;

  const apiRequests = events
    .filter(
      (event) =>
        event.k === "net.req" &&
        looksLikeApiRequest(safeText(event.d.url, 400)),
    )
    .map((event) => ({ t: event.t, url: safeText(event.d.url, 400) }))
    .sort((a, b) => a.t - b.t);

  /**
   * A data call this navigation plausibly caused: inside the window around the
   * nav commit, and sharing something with the nav's own query string.
   */
  const provedReactionTo = (navAt: number, navUrl: URL): boolean =>
    apiRequests.some(
      (request) =>
        request.t >= navAt - STALE_VIEW_REACTION_LEAD_MS &&
        request.t <= navAt + STALE_VIEW_REACTION_MS &&
        navigationQueryRelated(navUrl, request.url),
    );

  /**
   * Any data call near the pop. Deliberately blind to the query string: on this
   * side a request withdraws the claim, and refusing to count one because its
   * parameters look unrelated would manufacture findings.
   */
  const anyRequestAroundPop = (
    popAt: number,
    popUrl: URL,
    previousNavAt: number,
  ): boolean =>
    apiRequests.some(
      (request) => {
        if (
          request.t < popAt - STALE_VIEW_POP_LEAD_MS ||
          request.t > popAt + STALE_VIEW_REACTION_MS
        ) {
          return false;
        }
        if (request.t >= popAt) return true;

        // A request that beats its own pop event only excuses the pop when its
        // query is the state being restored. A request for the state the user
        // is leaving commonly lands a few milliseconds before the pop too; it
        // must not hide the stale view.
        const requestUrl = parseCapturedUrl(request.url);
        return (
          request.t >= previousNavAt &&
          requestUrl?.search === popUrl.search
        );
      },
    );

  for (let i = 1; i < navs.length; i += 1) {
    const pop = navs[i];
    if (pop.transition !== "pop") continue;
    const previous = navs[i - 1];
    const popUrl = parseCapturedUrl(pop.url);
    const previousUrl = parseCapturedUrl(previous.url);
    if (!popUrl || !previousUrl) continue;
    // Only a parameter change: a pop to a different page is an ordinary
    // navigation and the router owns re-mounting the view.
    if (popUrl.pathname !== previousUrl.pathname) continue;
    if (popUrl.search === previousUrl.search) continue;

    // The same view, earlier in the session, demonstrably reacting to a
    // different set of parameters. Without that proof the absence of a call
    // after the pop says nothing.
    const provedReactive = navs.slice(0, i).some((earlier) => {
      const url = parseCapturedUrl(earlier.url);
      if (!url) return false;
      if (url.pathname !== popUrl.pathname) return false;
      if (url.search === popUrl.search) return false;
      return provedReactionTo(earlier.event.t, url);
    });
    if (!provedReactive) continue;
    if (anyRequestAroundPop(pop.event.t, popUrl, previous.event.t)) continue;

    drafts.push({
      detector: "stale_view_after_pop",
      title: `Back navigation changed the URL but the view never refetched`,
      severity: "high",
      score: STALE_VIEW_SCORE,
      confidence: "medium",
      anchor: removeUndefined({
        t: pop.event.t,
        offsetMs:
          offsetForEvent(pop.event) ??
          offsetFromStart(pop.event.t, index.start),
        route: routeAt(index.navs ?? [], pop.event.t),
        url: redactUrl(pop.url),
        message: `A history pop changed the query string on ${popUrl.pathname} and no API request followed within ${STALE_VIEW_REACTION_MS} ms. An earlier navigation to this same path with different parameters did trigger one, so the view reacts to parameter changes in general — just not to this one. The URL and what is on screen now disagree.`,
      }),
      dedupeKey: `staleview:${popUrl.pathname}`,
    });
  }
}

// ─── listener_growth ─────────────────────────────────────────────────────────

/** Navigations that must carry a gauge before growth is a trend rather than noise. */
const LISTENER_GROWTH_MIN_EPOCHS = 3;
/** Cumulative growth ratio from the first gauge to the last. */
const LISTENER_GROWTH_MIN_RATIO = 1.5;
/** Absolute growth floor, so a page that goes 4 → 6 listeners is not a leak. */
const LISTENER_GROWTH_MIN_ABSOLUTE = 30;
const LISTENER_GROWTH_SCORE = 58;

/**
 * listener_growth: event listeners accumulate across navigations and never come
 * back down.
 *
 * The signature of subscribe-without-cleanup. Each page adds its handlers, none
 * of them are removed on unmount, and the count climbs until the tab is slow and
 * every handler runs N times. Nothing errors and nothing is slow enough to
 * measure early — the only evidence is the shape of the curve, which is exactly
 * what a gauge per navigation records.
 *
 * Requires the count to never shrink: a single drop proves cleanup runs
 * somewhere, and a count that oscillates is a page doing its job.
 */
function addListenerGrowthCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const navTimes = events
    .filter(isNavigationEvent)
    .map((event) => event.t)
    .sort((a, b) => a - b);
  const gauges = events
    .filter(
      (event) =>
        event.k === "ui.listeners" && finiteNumber(event.d.total) !== undefined,
    )
    .sort((a, b) => a.t - b.t);
  if (gauges.length < LISTENER_GROWTH_MIN_EPOCHS) return;

  // One gauge per navigation epoch — the last, which is the settled count for
  // that page. Two gauges on one page are one observation, not two.
  const byEpoch = new Map<number, BugEvent>();
  for (const gauge of gauges) {
    const epoch = navTimes.filter((t) => t <= gauge.t).length;
    byEpoch.set(epoch, gauge);
  }
  const series = [...byEpoch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, event]) => event);
  if (series.length < LISTENER_GROWTH_MIN_EPOCHS) return;

  const totals = series.map((event) => finiteNumber(event.d.total) as number);
  for (let i = 1; i < totals.length; i += 1) {
    if (totals[i] < totals[i - 1]) return; // cleanup ran somewhere → not a leak
  }
  const first = totals[0];
  const last = totals[totals.length - 1];
  if (last - first < LISTENER_GROWTH_MIN_ABSOLUTE) return;
  if (first > 0 && last < first * LISTENER_GROWTH_MIN_RATIO) return;

  const firstEvent = series[0];
  const lastEvent = series[series.length - 1];
  const growthByType = describeListenerGrowth(firstEvent, lastEvent);
  drafts.push({
    detector: "listener_growth",
    title: `Event listeners grew from ${first} to ${last} across ${series.length} navigations without ever shrinking`,
    severity: "medium",
    score: LISTENER_GROWTH_SCORE,
    confidence: "medium",
    anchor: removeUndefined({
      t: lastEvent.t,
      offsetMs:
        offsetForEvent(lastEvent) ?? offsetFromStart(lastEvent.t, index.start),
      route: routeAt(index.navs ?? [], lastEvent.t),
      url: redactUrl(safeText(lastEvent.d.url, 400)),
      message: `First gauge: ${first} listeners at +${Math.round(offsetForEvent(firstEvent) ?? offsetFromStart(firstEvent.t, index.start) ?? 0)} ms on ${redactUrl(safeText(firstEvent.d.url, 400)) ?? "an earlier page"}. Last gauge: ${last} listeners at +${Math.round(offsetForEvent(lastEvent) ?? offsetFromStart(lastEvent.t, index.start) ?? 0)} ms on ${redactUrl(safeText(lastEvent.d.url, 400)) ?? "this page"}. The count never dropped between them${growthByType ? `; ${growthByType}` : ""}.`,
    }),
    dedupeKey: `listenergrowth:${safeText(lastEvent.d.url, 400) ?? "session"}`,
  });
}

/** The listener types that account for the growth between two gauges. */
function describeListenerGrowth(
  first: BugEvent,
  last: BugEvent,
): string | undefined {
  const before = listenerCountsByType(first);
  const after = listenerCountsByType(last);
  if (!before || !after) return undefined;
  const deltas = [...after.entries()]
    .map(([type, count]) => [type, count - (before.get(type) ?? 0)] as const)
    .filter(([, delta]) => delta > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (deltas.length === 0) return undefined;
  return `largest growth by type: ${deltas.map(([type, delta]) => `${type} +${delta}`).join(", ")}`;
}

function listenerCountsByType(
  event: BugEvent,
): Map<string, number> | undefined {
  const byType = event.d.byType;
  if (!Array.isArray(byType)) return undefined;
  const counts = new Map<string, number>();
  for (const entry of byType) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const type = safeText(entry[0], 60);
    const count = finiteNumber(entry[1]);
    if (!type || count === undefined) continue;
    counts.set(type, count);
  }
  return counts.size > 0 ? counts : undefined;
}

/** Arrivals at one path that must show the staircase before it is a trend. */
const LISTENER_STAIRCASE_MIN_VISITS = 3;
/** Minimum growth for one event type across those arrivals. */
const LISTENER_STAIRCASE_MIN_DELTA = 2;
const LISTENER_STAIRCASE_SCORE = 70;

/**
 * The session-total check above is deliberately deaf to slow leaks: its
 * absolute floor and ratio guard exist so a busy page's organic listener churn
 * never reads as a defect. But the classic per-mount leak adds ONE handler per
 * visit — an EventSource subscription, a store callback — and at one per visit
 * the totals never clear those guards inside a normal session. Scoped to a
 * single event type on a single path, the same staircase is high signal at a
 * delta of two: legitimate long-lived subscriptions register once and hold
 * flat, and cleanup that runs at all produces a dip somewhere in the series.
 */
function addListenerTypeStaircaseCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const byPath = new Map<
    string,
    Array<{ event: BugEvent; byType: Map<string, number> }>
  >();
  for (const event of events) {
    if (event.k !== "ui.listeners") continue;
    const url = safeText(event.d.url, 400);
    if (!url) continue;
    let path: string;
    try {
      path = new URL(url, "http://local").pathname;
    } catch {
      continue;
    }
    const byType = listenerCountsByType(event);
    if (!byType) continue;
    const bucket = byPath.get(path) ?? [];
    bucket.push({ event, byType });
    byPath.set(path, bucket);
  }

  for (const [path, readings] of byPath) {
    if (readings.length < LISTENER_STAIRCASE_MIN_VISITS) continue;
    const types = new Set<string>();
    for (const reading of readings)
      for (const type of reading.byType.keys()) types.add(type);
    for (const type of types) {
      const series = readings.map((r) => r.byType.get(type) ?? 0);
      let monotone = true;
      for (let i = 1; i < series.length; i += 1) {
        if (series[i] < series[i - 1]) {
          monotone = false;
          break;
        }
      }
      const delta = series[series.length - 1] - series[0];
      if (!monotone || delta < LISTENER_STAIRCASE_MIN_DELTA) continue;
      const last = readings[readings.length - 1].event;
      drafts.push({
        detector: "listener_growth",
        title: `"${type}" listeners grow on every visit to ${path}`,
        severity: "medium",
        score: LISTENER_STAIRCASE_SCORE,
        confidence: "medium",
        anchor: removeUndefined({
          t: last.t,
          offsetMs:
            offsetForEvent(last) ?? offsetFromStart(last.t, index.start),
          route: routeAt(index.navs ?? [], last.t),
          message:
            `Across ${readings.length} arrivals at ${path}, live "${type}" listeners ` +
            `went ${series[0]} → ${series[series.length - 1]} and never decreased. ` +
            `A subscription made on every mount with no cleanup on unmount produces exactly ` +
            `this staircase; each leaked handler still fires, so work is repeated once per ` +
            `earlier visit.`,
        }),
        dedupeKey: `listenerstaircase:${path}:${type}`,
      });
    }
  }
}

// ─── stream_desync ───────────────────────────────────────────────────────────

/** How many reconnect findings one session may carry. */
const MAX_STREAM_DESYNC_CANDIDATES = 3;
/** A reconnect that provably skipped a change. */
const STREAM_DESYNC_SCORE = 56;
/** A reconnect whose replay could not be checked from the captured events. */
const STREAM_RECONNECT_SCORE = 38;

/**
 * stream_desync: a stream dropped, came back, and never said what it missed.
 *
 * Server-sent events are a promise that the client will be told about changes.
 * A reconnect breaks that promise for the length of the gap unless the server
 * replays it, and almost none do by default. When the session also shows the
 * underlying resource holding a different value after the gap than before, the
 * missed change is no longer hypothetical: the client was out of date for as
 * long as it took someone to reload.
 *
 * When the resource cannot be compared from the captured events the reconnect
 * is still reported, at low severity, saying exactly that — a reconnect is worth
 * knowing about even when the consequence cannot be proved.
 */
function addStreamDesyncCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const streams = new Map<string, BugEvent[]>();
  for (const event of events) {
    if (event.k !== "net.sse") continue;
    const url = safeText(event.d.url, 400);
    if (!url) continue;
    const list = streams.get(url) ?? [];
    list.push(event);
    streams.set(url, list);
  }
  if (streams.size === 0) return;

  const observations = collectResourceObservations(events, exchanges);
  const emitted: CandidateDraft[] = [];

  for (const [url, stream] of streams) {
    stream.sort((a, b) => a.t - b.t);
    const path = capturedUrlPath(url);
    if (!path) continue;
    const root = apiPrefixOf(path);

    for (let i = 0; i < stream.length; i += 1) {
      const gap = stream[i];
      const op = safeText(gap.d.op, 20);
      if (op !== "error" && op !== "close") continue;
      const reopen = stream
        .slice(i + 1)
        .find((event) => event.d.reopen === true || event.d.reopen === 1);
      if (!reopen) continue;

      const drift = firstResourceDrift(observations, root, gap.t, reopen.t);
      const confirmed = drift !== undefined;
      emitted.push({
        detector: "stream_desync",
        title: confirmed
          ? `Stream reconnected without replay and the resource had changed`
          : `Stream reconnected without any replay of what it missed`,
        severity: confirmed ? "medium" : "low",
        score: confirmed ? STREAM_DESYNC_SCORE : STREAM_RECONNECT_SCORE,
        confidence: confirmed ? "medium" : "low",
        anchor: removeUndefined({
          t: reopen.t,
          offsetMs:
            offsetForEvent(reopen) ?? offsetFromStart(reopen.t, index.start),
          route: routeAt(index.navs ?? [], reopen.t),
          url: redactUrl(url),
          message: scrubText(
            confirmed
              ? `The stream ${op}d and reopened ${Math.round(reopen.t - gap.t)} ms later with no replay. Across that gap ${drift} — a change the stream never delivered, so anything rendered from it was stale until the next full read.`
              : `The stream ${op}d and reopened ${Math.round(reopen.t - gap.t)} ms later with no replay. Whether anything changed during the gap could not be verified: the session carries no read of ${root} on both sides of it. The reconnect itself is the finding.`,
            300,
          ),
        }),
        dedupeKey: `streamdesync:${path}:${gap.t}`,
      });
    }
  }

  drafts.push(
    ...emitted
      .sort((a, b) => b.score - a.score || a.anchor.t - b.anchor.t)
      .slice(0, MAX_STREAM_DESYNC_CANDIDATES),
  );
}

/** One recorded value of one logical resource at one moment. */
interface ResourceObservation {
  /** Path used to decide whether the observation belongs to a stream's root. */
  path: string;
  /** Stable identity of the thing observed, so two moments are comparable. */
  key: string;
  t: number;
  value: string;
  label: string;
}

/**
 * Every readable value of a resource in the session: response bodies, and the
 * rows the requests behind them read. Bounded and summarized, never the raw
 * payload.
 */
function collectResourceObservations(
  events: BugEvent[],
  exchanges: Map<string, RequestExchange>,
): ResourceObservation[] {
  const observations: ResourceObservation[] = [];
  const pathByRequest = new Map<string, string>();

  for (const exchange of exchanges.values()) {
    const path = capturedUrlPath(exchange.url);
    if (!path) continue;
    pathByRequest.set(exchange.requestId, path);
    if (!exchange.res || !isSuccessStatus(exchange.status)) continue;
    const payload = responsePayload(exchange.resBody, exchange.resBodyMeta);
    if (payload === undefined) continue;
    observations.push({
      path,
      key: `res:${path}`,
      t: exchange.res.t,
      value: summarizeObservedValue(payload),
      label: `the response body for ${path}`,
    });
  }

  for (const event of events) {
    if (event.k !== "db.read") continue;
    if (!isRecord(event.d.row)) continue;
    const id = correlationIdOf(event);
    const path = id ? pathByRequest.get(id) : undefined;
    const table = safeText(event.d.table, 200);
    if (!path || !table) continue;
    const pk = pkEntriesOf(event)
      .map(([column, value]) => `${column}=${value}`)
      .join(",");
    observations.push({
      path,
      key: `row:${table}:${pk}`,
      t: event.t,
      value: summarizeObservedValue(event.d.row),
      label: `${bareTableName(table)}${pk ? ` (${pk})` : ""}`,
    });
  }

  return observations;
}

function summarizeObservedValue(value: unknown): string {
  try {
    return truncate(JSON.stringify(summarizePayload(value)) ?? "", 400);
  } catch {
    return "";
  }
}

/**
 * The first resource under `root` whose value differs on the two sides of a
 * stream gap, described for the candidate's detail. Undefined when nothing was
 * observed on both sides — an absence of evidence, reported as such.
 */
function firstResourceDrift(
  observations: ResourceObservation[],
  root: string,
  gapAt: number,
  reopenedAt: number,
): string | undefined {
  const byKey = new Map<string, ResourceObservation[]>();
  for (const observation of observations) {
    if (!observation.path.startsWith(root)) continue;
    const list = byKey.get(observation.key) ?? [];
    list.push(observation);
    byKey.set(observation.key, list);
  }

  for (const [, list] of [...byKey.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    list.sort((a, b) => a.t - b.t);
    const before = [...list].reverse().find((entry) => entry.t <= gapAt);
    const after = list.find((entry) => entry.t >= reopenedAt);
    if (!before || !after) continue;
    if (before.value === after.value) continue;
    return `${before.label} changed`;
  }
  return undefined;
}

function collectRequests(events: BugEvent[]): Map<string, RequestInfo> {
  const requests = new Map<string, RequestInfo>();
  const navs = collectNavigationContext(events);
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const id = networkRequestId(event.d.id);
    if (!id) continue;
    requests.set(
      id,
      removeUndefined({
        id,
        t: event.t,
        offsetMs: offsetForEvent(event),
        method: safeText(event.d.m, 20) ?? safeText(event.d.method, 20),
        url: safeText(event.d.url, 400),
        route: routeAt(navs, event.t),
      }),
    );
  }
  return requests;
}

function withNavigationContext(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): EvidenceIndexInput["index"] {
  const eventNavs = collectNavigationContext(events);
  if (eventNavs.length === 0) return index;
  const navs = [...(index.navs ?? []), ...eventNavs].sort((a, b) => a.t - b.t);
  return { ...index, navs };
}

function collectNavigationContext(
  events: BugEvent[],
): Array<{ t: number; to?: string }> {
  return events.filter(isNavigationEvent).map((event) =>
    removeUndefined({
      t: event.t,
      to:
        safeText(event.d.to, 240) ??
        safeText(event.d.route, 240) ??
        safeText(event.d.screen, 240) ??
        safeText(event.d.path, 240) ??
        safeText(event.d.name, 240),
    }),
  );
}

function isNavigationEvent(event: BugEvent): boolean {
  return event.k === "nav" || event.k === "navigation";
}

/**
 * Matches the location tail of a stack frame: `file:line:col`, in either the V8
 * (`at fn (URL:12:3)`) or SpiderMonkey (`fn@URL:12:3`) shape. Anchored on the
 * trailing digits so a bare `https://host/a.js` with no position never matches
 * and no half-location is reported as a code frame.
 */
const STACK_FRAME_LOCATION =
  /((?:https?:\/\/|\/|[A-Za-z]:\\|\w)[^\s()]*?:\d+:\d+)/;

/**
 * The `file:line:col` of the failing code, or undefined when the session never
 * captured one. Prefers the browser's explicit ErrorEvent fields; falls back to
 * the top frame of the stack, which is the only source a rejection has.
 *
 * Returns undefined rather than a partial location: a file with no line sends a
 * reader to the top of a minified bundle, which is not a starting point.
 */
function codeFrameOf(entry: {
  file?: string;
  line?: number;
  col?: number;
  stk?: string;
}): string | undefined {
  if (entry.file && typeof entry.line === "number") {
    const col = typeof entry.col === "number" ? `:${entry.col}` : "";
    return safeText(`${entry.file}:${entry.line}${col}`, 300);
  }
  if (typeof entry.stk !== "string") return undefined;
  // Skip the header line ("TypeError: ..."), which can itself contain a URL.
  for (const line of entry.stk.split("\n").slice(1)) {
    const match = STACK_FRAME_LOCATION.exec(line);
    if (match) return safeText(match[1], 300);
  }
  return undefined;
}

/**
 * The `file:line:col` a backend error's own frames name, or undefined when the
 * error rested without any.
 *
 * The innermost app frame is used because that is where the throw happened. The
 * frames are already filtered to the host application at capture time (library,
 * node_modules and runtime frames are dropped), so the first entry is the line
 * a reader opens, not the driver that called it. Same output shape as
 * {@link codeFrameOf}, and undefined for a partial location for the same
 * reason: a file with no line is not a starting point.
 */
function backendErrorFrame(error: Record<string, unknown> | undefined) {
  if (!error) return undefined;
  const frames = error.frames;
  if (!Array.isArray(frames)) return undefined;
  const innermost = frames[0];
  if (!isRecord(innermost)) return undefined;
  return codeFrameOf({
    file: safeText(innermost.file, 300),
    line: finiteNumber(innermost.line),
    col: finiteNumber(innermost.column),
  });
}

// Normalizes an error message into a stable content signature for dedupe: lowercased, redaction
// markers dropped, digits collapsed to '#', whitespace normalized. Mirrors distinct-bugs.ts
// normalizeSignature so candidate-level dedupe and downstream bug grouping agree.
function normalizeErrorSignature(value: unknown): string {
  const text = safeText(value, 300);
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/\[redacted\]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduces the score/severity of candidates that are (or correlate to) a blocked third-party
 * analytics/ads beacon. Two paths, both conservative:
 *  - Direct: a candidate whose own failing request targets a denylisted tracker host (network_error /
 *    http_error carry the url or request id).
 *  - Correlated: a bare fetch-level rejection (no url of its own) fired within
 *    {@link TRACKER_BEACON_CORRELATION_MS} of a blocked beacon request.
 * Candidates with unknown or first-party targets are left untouched.
 */
/**
 * True when `body` is a JSON object naming its own failure — the signature of a
 * handler that returned this status on purpose.
 *
 * Parses rather than pattern-matches: a redacted or truncated body, an HTML
 * error page and a framework stack trace all fail to parse, and every one of
 * those is a case where we must NOT claim the outcome was deliberate.
 */
function bodyNamesItsOwnError(body: unknown): boolean {
  if (typeof body !== "string") return false;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (STRUCTURED_ERROR_KEYS.some((key) => parsed[key] !== undefined))
    return true;
  // RFC 9457 problem details: the pair is the proof, since `title` alone is a
  // common field on perfectly ordinary payloads.
  return parsed.type !== undefined && parsed.title !== undefined;
}

/**
 * Whether a status/body pair is a 4xx the application chose to return.
 *
 * Conservative on purpose. The cost of a false positive here is a real defect
 * demoted out of sight, so an unexplained 4xx — a 404 with no body, a 409 whose
 * body never reached the capture — is left at full weight.
 */
function isHandledClientError(
  status: number | undefined,
  body: unknown,
): boolean {
  if (status === undefined || status < 400 || status > 499) return false;
  if (AUTH_CHALLENGE_STATUSES.has(status)) return true;
  return bodyNamesItsOwnError(body);
}

/**
 * Demotes and groups the 4xx responses an application returned deliberately.
 *
 * Ranking-only, in the same spirit as {@link downrankTrackerBeacons}: severity,
 * confidence, score and the dedupe key change so these sort beneath real
 * defects and collapse by route, but no candidate is removed.
 *
 * Runs over both planes. The frontend view carries the response body, which is
 * the evidence; the backend `backend.req.end` event carries only a status code,
 * so a backend 4xx is demoted either on its own auth-challenge status or by
 * sharing a correlation id with a frontend response already judged handled.
 * Without that join one expected rejection keeps producing two rows.
 */
function demoteHandledClientErrors(
  drafts: CandidateDraft[],
  events: BugEvent[],
): void {
  // Shared correlation ids (net.res `d.requestId`, not the browser-local `d.id`)
  // whose frontend response was judged handled.
  const handledSharedIds = new Set<string>();
  const bodyByBrowserId = responseBodyByRequestId(events);
  const sharedIdByBrowserId = new Map<string, string>();
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const browserId = requestIdForEvent(event);
    if (browserId === undefined) continue;
    const sharedId = safeText(event.d.requestId, 120);
    if (sharedId) sharedIdByBrowserId.set(browserId, sharedId);
  }

  const demote = (draft: CandidateDraft, groupKey: string): void => {
    draft.severity = "low";
    draft.confidence = "low";
    draft.score = Math.min(draft.score, HANDLED_CLIENT_ERROR_SCORE);
    draft.dedupeKey = groupKey;
  };

  for (const draft of drafts) {
    if (draft.detector !== "http_error") continue;
    const browserId = draft.anchor.requestId;
    const body = browserId ? bodyByBrowserId.get(browserId) : undefined;
    if (!isHandledClientError(draft.anchor.status, body)) continue;
    if (browserId) {
      const sharedId = sharedIdByBrowserId.get(browserId);
      if (sharedId) handledSharedIds.add(sharedId);
    }
    // Group by what the outcome IS — method, target, status — dropping the
    // per-attempt request id that kept four identical rejections apart.
    demote(
      draft,
      `handled4xx:${draft.anchor.method ?? ""}:${draft.anchor.url ?? ""}:${draft.anchor.status ?? ""}`,
    );
  }

  for (const draft of drafts) {
    if (draft.detector !== "backend_http_client_error") continue;
    const sharedId = draft.anchor.requestId;
    const handled =
      AUTH_CHALLENGE_STATUSES.has(draft.anchor.status ?? 0) ||
      (sharedId !== undefined && handledSharedIds.has(sharedId));
    if (!handled) continue;
    demote(
      draft,
      `handled4xx:backend:${draft.anchor.method ?? ""}:${draft.anchor.route ?? ""}:${draft.anchor.status ?? ""}`,
    );
  }
}

function downrankTrackerBeacons(
  drafts: CandidateDraft[],
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): void {
  const beaconFailures = collectTrackerBeaconFailures(events, index);
  if (beaconFailures.length === 0) return;
  const beaconRequestIds = new Set(
    beaconFailures
      .map((failure) => failure.requestId)
      .filter((id): id is string => id !== undefined),
  );
  for (const draft of drafts) {
    if (!isTrackerBeaconDraft(draft, beaconFailures, beaconRequestIds))
      continue;
    draft.score = Math.min(draft.score, TRACKER_BEACON_SCORE);
    draft.severity = "low";
  }
}

function isTrackerBeaconDraft(
  draft: CandidateDraft,
  beaconFailures: Array<{ t: number; requestId?: string }>,
  beaconRequestIds: Set<string>,
): boolean {
  // Direct: this candidate IS the blocked beacon request.
  if (draft.anchor.requestId && beaconRequestIds.has(draft.anchor.requestId)) {
    return true;
  }
  if (matchTrackerBeaconHost(draft.anchor.url)) return true;
  // Correlated: a bare fetch failure rejection fired next to a blocked beacon.
  if (
    FETCH_REJECTION_DETECTORS.has(draft.detector) &&
    FETCH_FAILURE_MESSAGE_PATTERN.test(draft.anchor.message ?? draft.title)
  ) {
    return beaconFailures.some(
      (failure) =>
        Math.abs(failure.t - draft.anchor.t) <= TRACKER_BEACON_CORRELATION_MS,
    );
  }
  return false;
}

function collectTrackerBeaconFailures(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): Array<{ t: number; requestId?: string }> {
  const failures: Array<{ t: number; requestId?: string }> = [];
  for (const event of events) {
    if (event.k !== "net.err") continue;
    if (matchTrackerBeaconHost(safeText(event.d.url, 400))) {
      failures.push(
        removeUndefined({ t: event.t, requestId: requestIdForEvent(event) }),
      );
    }
  }
  for (const entry of index.networkErrors ?? []) {
    if (matchTrackerBeaconHost(entry.url)) {
      failures.push(
        removeUndefined({ t: entry.t, requestId: requestIdForValue(entry) }),
      );
    }
  }
  for (const failed of index.failedReqs ?? []) {
    if (matchTrackerBeaconHost(failed.url)) {
      failures.push(
        removeUndefined({ t: failed.t, requestId: requestIdForValue(failed) }),
      );
    }
  }
  return failures;
}

/** True when the url's host (or host+path) matches the heuristic tracker-beacon denylist. */
function matchTrackerBeaconHost(url: unknown): boolean {
  if (typeof url !== "string" || url.trim().length === 0) return false;
  const raw = url.trim();
  let host: string;
  let hostPath: string;
  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(raw)
        ? raw
        : `https://${raw.replace(/^\/+/, "")}`,
    );
    host = parsed.host.toLowerCase();
    hostPath = `${host}${parsed.pathname.toLowerCase()}`;
  } catch {
    return false;
  }
  if (!host) return false;
  return TRACKER_BEACON_HOST_PATTERNS.some((pattern) =>
    pattern.includes("/")
      ? hostPath.includes(pattern)
      : host === pattern || host.endsWith(`.${pattern}`),
  );
}

function collectResponsesByTimeStatus(
  events: BugEvent[],
): Map<string, BugEvent> {
  const responses = new Map<string, BugEvent>();
  for (const event of events) {
    if (event.k !== "net.res") continue;
    responses.set(responseLookupKey(event.t, event.d.st), event);
    responses.set(responseLookupKey(event.t, undefined), event);
  }
  return responses;
}

function responseLookupKey(t: number, status: unknown): string {
  return `${t}:${status === undefined ? "*" : String(status)}`;
}

function dedupeDrafts(drafts: CandidateDraft[]): CandidateDraft[] {
  const byKey = new Map<string, CandidateDraft>();
  // Counted separately from the surviving draft: the winner can be replaced as
  // better-scoring drafts arrive, and the count belongs to the key either way.
  const countByKey = new Map<string, number>();
  for (const draft of drafts) {
    countByKey.set(draft.dedupeKey, (countByKey.get(draft.dedupeKey) ?? 0) + 1);
    const existing = byKey.get(draft.dedupeKey);
    if (
      !existing ||
      draft.score > existing.score ||
      (draft.score === existing.score && draft.anchor.t < existing.anchor.t)
    ) {
      byKey.set(draft.dedupeKey, draft);
    }
  }
  return [...byKey.values()].map((draft) => {
    const count = countByKey.get(draft.dedupeKey) ?? 1;
    // Emitted only when it says something: `occurrences: 1` on every candidate
    // is noise in a payload an agent has to read.
    return count > 1 ? { ...draft, occurrences: count } : draft;
  });
}

function mergeWindowRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function renderCandidatesMarkdown(
  candidates: EvidenceCandidate[],
  input: EvidenceIndexInput,
): string {
  const lines = [
    `# Signal Evidence Index`,
    "",
    "Deterministic, redacted issue signals generated from local Crumbtrail events. This uppercase entry point is intentional: start here before raw replay artifacts.",
    "",
    `* Schema version: ${CANDIDATE_SCHEMA_VERSION}`,
    `* Session: ${input.index.id ?? path.basename(input.sessionDir)}`,
    `* Signals: ${candidates.length}`,
    `* Ordering: causal chains ranked by their highest-scoring member (score desc, anchor time asc, deterministic dedupe key asc); within a chain a cause is listed before what it explains. Only high/medium attributions form a chain — a low one is a sequence note and does not move anything. Stable signal IDs are assigned after ranking.`,
    "",
    "## Signals",
    "",
  ];

  if (candidates.length === 0) {
    lines.push("_No deterministic issue signals were detected._", "");
  } else {
    for (const candidate of candidates) {
      lines.push(`### ${candidate.id} · ${candidate.title}`);
      lines.push("");
      lines.push(`* Detector: ${candidate.detector}`);
      lines.push(`* Severity: ${candidate.severity}`);
      lines.push(`* basis: "heuristic"`);
      lines.push(`* baseScore: ${candidate.score}`);
      lines.push(`* Confidence: ${candidate.confidence}`);
      lines.push(
        `* Anchor: ${formatOffset(candidate.anchor.offsetMs, candidate.anchor.t)}${candidate.anchor.route ? ` on ${candidate.anchor.route}` : ""}`,
      );
      if (
        candidate.anchor.method ||
        candidate.anchor.status ||
        candidate.anchor.url
      )
        lines.push(
          `* Request: ${[candidate.anchor.method, candidate.anchor.status, candidate.anchor.url].filter((part) => part !== undefined && part !== "").join(" ")}`,
        );
      if (candidate.anchor.errorCode)
        lines.push(`* Error code: ${candidate.anchor.errorCode}`);
      if (candidate.anchor.message)
        lines.push(`* Message: ${candidate.anchor.message}`);
      // The file and line is the shortest path from "something broke" to an open
      // editor, and it was reaching candidates.jsonl but not the markdown this
      // file tells every reader to start from.
      if (candidate.anchor.frame)
        lines.push(`* Source: ${candidate.anchor.frame}`);
      if (candidate.anchor.elementLabel)
        lines.push(`* Element: ${candidate.anchor.elementLabel}`);
      // Causal structure (CP4): additive per-candidate lines from the CP3 re-rank fields.
      if (candidate.causalRole)
        lines.push(`* Causal role: ${candidate.causalRole}`);
      if (candidate.causalRole === "symptom" && candidate.rootCauseId) {
        // A `low` attribution is the request spine's time ordering, not an established cause. The
        // ranker does not let it set position (see applyCausalRerank), so this document must not
        // announce it as a root cause either — a reader cannot see the grade in the heading.
        if (candidate.attributionConfidence === "low") {
          lines.push(
            `* Follows: ${candidate.rootCauseId} (same request — sequence only, not an established cause)`,
          );
        } else {
          lines.push(`* Root cause: ${candidate.rootCauseId}`);
          if (candidate.attributionConfidence)
            lines.push(
              `* Attribution confidence: ${candidate.attributionConfidence}`,
            );
        }
      }
      lines.push(
        `* Evidence window: [windows/${candidate.id}.md](windows/${candidate.id}.md)`,
      );
      lines.push("");
    }
  }

  lines.push("## Search corpus");
  lines.push("");
  lines.push(
    "Use `search.jsonl` for normalized, redacted grep friendly rows linked back to signals. It is not a replacement for `events.ndjson`; it avoids raw payloads, storage values, auth material, and raw input values.",
  );
  lines.push("");
  return lines.join("\n");
}

function renderCandidatesJsonl(candidates: EvidenceCandidate[]): string {
  return (
    candidates.map((candidate) => JSON.stringify(candidate)).join("\n") +
    (candidates.length > 0 ? "\n" : "")
  );
}

function renderTimelineMarkdown(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): string {
  const validTimes = events
    .map((event) => finiteSafeTimestamp(event.t))
    .filter((time): time is number => time !== undefined);
  const fallbackStart = validTimes[0] ?? 0;
  const start = finiteSafeTimestamp(index.start) ?? fallbackStart;
  const rawEnd =
    finiteSafeTimestamp(index.end) ??
    validTimes[validTimes.length - 1] ??
    start;
  const bucketMs = 5 * 60 * 1000;
  const maxBuckets = 288;
  const end = Math.min(rawEnd, start + bucketMs * (maxBuckets - 1));
  const lines = [
    "# Session Timeline",
    "",
    "Five-minute deterministic buckets for long-session navigation and evidence discovery.",
    "",
  ];

  for (
    let bucketStart = start, bucketIndex = 0;
    bucketStart <= end && bucketIndex < maxBuckets;
    bucketIndex += 1
  ) {
    const bucketEnd = Math.min(bucketStart + bucketMs, end);
    const bucketEvents = events.filter((event) => {
      const eventTime = finiteSafeTimestamp(event.t);
      return (
        eventTime !== undefined &&
        eventTime >= bucketStart &&
        eventTime <= bucketEnd
      );
    });
    lines.push(
      `## ${formatOffset(offsetFromStart(bucketStart, start), bucketStart)} - ${formatOffset(offsetFromStart(bucketEnd, start), bucketEnd)}`,
    );
    lines.push("");
    if (bucketEvents.length === 0) {
      lines.push("- No events captured.");
    } else {
      const counts = countBy(bucketEvents.map((event) => event.k));
      lines.push(
        `- Events: ${bucketEvents.length} (${Object.entries(counts)
          .map(([kind, count]) => `${kind}:${count}`)
          .join(", ")})`,
      );
      const notable = bucketEvents.filter(isTimelineNotable).slice(0, 12);
      for (const event of notable)
        lines.push(
          `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, start), event.t)} ${event.k}: ${eventSummary(event)}`,
        );
    }
    lines.push("");
    const nextBucketStart = bucketStart + bucketMs;
    if (nextBucketStart <= bucketStart) break;
    bucketStart = nextBucketStart;
  }
  return lines.join("\n");
}

function finiteSafeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 8_640_000_000_000_000
    ? value
    : undefined;
}

function renderSearchJsonl(
  events: BugEvent[],
  candidates: EvidenceCandidate[],
  index: EvidenceIndexInput["index"],
): string {
  const rows: Array<Record<string, unknown>> = [];
  const candidateIdsByEventIndex = buildCandidateIdsByEventIndex(
    events,
    candidates,
  );
  for (const candidate of candidates) {
    rows.push(
      removeUndefined({
        schemaVersion: CANDIDATE_SCHEMA_VERSION,
        type: "candidate",
        candidateId: candidate.id,
        detector: candidate.detector,
        t: candidate.anchor.t,
        offsetMs: candidate.anchor.offsetMs,
        route: candidate.anchor.route,
        text: scrubText(
          [
            candidate.title,
            candidate.anchor.errorCode,
            candidate.anchor.message,
            candidate.anchor.elementLabel,
            candidate.anchor.url,
          ]
            .filter(Boolean)
            .join(" "),
          500,
        ),
      }),
    );
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    const text = eventSummary(event);
    if (!text) continue;
    rows.push(
      removeUndefined({
        schemaVersion: CANDIDATE_SCHEMA_VERSION,
        type: "event",
        k: event.k,
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        candidateIds: candidateIdsByEventIndex.get(eventIndex) ?? [],
        text: scrubText(text, 500),
      }),
    );
  }

  return (
    rows.map((row) => JSON.stringify(row)).join("\n") +
    (rows.length > 0 ? "\n" : "")
  );
}

function buildCandidateIdsByEventIndex(
  events: BugEvent[],
  candidates: EvidenceCandidate[],
): Map<number, string[]> {
  const indexedEvents = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.t - b.event.t);
  const indexedCandidates = candidates
    .slice()
    .sort((a, b) => a.evidenceWindow.start - b.evidenceWindow.start);
  const result = new Map<number, string[]>();
  let candidateStart = 0;

  for (const { event, index } of indexedEvents) {
    while (
      candidateStart < indexedCandidates.length &&
      indexedCandidates[candidateStart].evidenceWindow.end < event.t
    ) {
      candidateStart++;
    }
    const ids: string[] = [];
    for (
      let i = candidateStart;
      i < indexedCandidates.length &&
      indexedCandidates[i].evidenceWindow.start <= event.t;
      i++
    ) {
      if (event.t <= indexedCandidates[i].evidenceWindow.end)
        ids.push(indexedCandidates[i].id);
    }
    result.set(index, ids);
  }

  return result;
}

function renderWindowMarkdown(
  candidate: EvidenceCandidate,
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): string {
  const windowEvents = events.filter(
    (event) =>
      event.t >= candidate.evidenceWindow.start &&
      event.t <= candidate.evidenceWindow.end,
  );
  const lines = [
    `# Evidence Window ${candidate.id}`,
    "",
    `- Candidate: ${candidate.title}`,
    `- Detector: ${candidate.detector}`,
    `- Anchor: ${formatOffset(candidate.anchor.offsetMs, candidate.anchor.t)}`,
    `- Window: ${formatOffset(offsetFromStart(candidate.evidenceWindow.start, index.start), candidate.evidenceWindow.start)} to ${formatOffset(offsetFromStart(candidate.evidenceWindow.end, index.start), candidate.evidenceWindow.end)}`,
    "",
    "## Compact event timeline",
    "",
  ].filter((line): line is string => line !== undefined);

  if (windowEvents.length === 0) lines.push("_No events in this window._");
  else
    for (const event of selectCompactTimelineEvents(candidate, windowEvents))
      lines.push(
        `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, index.start), event.t)} ${event.k}: ${eventSummary(event)}`,
      );

  lines.push("", "## Network summaries", "");
  const networkEvents = windowEvents.filter(
    (event) =>
      event.k === "net.req" || event.k === "net.res" || event.k === "net.err",
  );
  if (networkEvents.length === 0)
    lines.push("_No network events in this window._");
  else
    for (const event of networkEvents.slice(0, 80))
      lines.push(
        `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, index.start), event.t)} ${eventSummary(event)}`,
      );

  const failedRequestBodies = failedRequestBodySnippets(
    candidate,
    windowEvents,
  );
  if (failedRequestBodies.request || failedRequestBodies.response) {
    lines.push("", "## Failed request bodies", "");
    if (failedRequestBodies.request)
      lines.push(`- Request body: ${failedRequestBodies.request}`);
    if (failedRequestBodies.response)
      lines.push(`- Response body: ${failedRequestBodies.response}`);
  }

  lines.push("", "## Console and runtime errors", "");
  const errorEvents = windowEvents.filter(
    (event) =>
      event.k === "con" ||
      event.k === "err" ||
      event.k === "rej" ||
      event.k === "probe.error",
  );
  if (errorEvents.length === 0)
    lines.push("_No console/runtime errors in this window._");
  else
    for (const event of errorEvents.slice(0, 80))
      lines.push(
        `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, index.start), event.t)} ${event.k}: ${eventSummary(event)}`,
      );

  lines.push("", "## Transcript slice", "");
  const txEvents = windowEvents.filter((event) => event.k === "tx");
  if (txEvents.length === 0)
    lines.push("_No transcript events in this window._");
  else
    for (const event of txEvents.slice(0, 40))
      lines.push(
        `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, index.start), event.t)} ${scrubText(event.d.text, 220)}`,
      );

  lines.push("", "## Media offsets", "");
  lines.push(
    `- Review video/audio around ${formatOffset(candidate.anchor.offsetMs, candidate.anchor.t)} if media artifacts exist.`,
  );
  return lines.join("\n") + "\n";
}

const COMPACT_TIMELINE_MAX_EVENTS = 120;
const COMPACT_TIMELINE_BUDGETS = {
  errors: 36,
  interactions: 24,
  network: 24,
  lowSignal: 18,
  context: 15,
} as const;

function selectCompactTimelineEvents(
  candidate: EvidenceCandidate,
  windowEvents: BugEvent[],
): BugEvent[] {
  // Preserve the complete chronology when it already fits. Per-kind quotas only
  // shape an overflowed timeline; they must not discard useful context otherwise.
  if (windowEvents.length <= COMPACT_TIMELINE_MAX_EVENTS) return windowEvents;

  const indexedEvents = windowEvents.map((event, index) => ({ event, index }));
  const selected = new Set<number>();
  const add = (entry: { event: BugEvent; index: number } | undefined) => {
    if (entry && selected.size < COMPACT_TIMELINE_MAX_EVENTS)
      selected.add(entry.index);
  };
  const byProximity = (entries: typeof indexedEvents) =>
    entries
      .slice()
      .sort(
        (a, b) =>
          Math.abs(a.event.t - candidate.anchor.t) -
            Math.abs(b.event.t - candidate.anchor.t) ||
          a.event.t - b.event.t ||
          a.index - b.index,
      );
  const firstMatching = (
    predicate: (event: BugEvent) => boolean,
  ): { event: BugEvent; index: number } | undefined =>
    byProximity(indexedEvents.filter(({ event }) => predicate(event)))[0];
  const requestId = candidate.anchor.requestId;
  const response = findResponseEvent(
    collectResponsesByTimeStatus(windowEvents),
    candidate.anchor.t,
    candidate.anchor.status,
  );
  const responseEntry = response
    ? indexedEvents.find(({ event }) => event === response)
    : undefined;
  const detectorAnchorKind = compactAnchorEventKind(candidate.detector);
  const anchor = requestId
    ? (firstMatching(
        (event) =>
          event.t === candidate.anchor.t &&
          requestIdForEvent(event) === requestId,
      ) ??
      responseEntry ??
      firstMatching((event) => event.t === candidate.anchor.t))
    : ((detectorAnchorKind
        ? firstMatching((event) => event.k === detectorAnchorKind)
        : undefined) ??
      responseEntry ??
      firstMatching((event) => event.t === candidate.anchor.t) ??
      firstMatching(() => true));
  add(anchor);

  const correlatedRequestId = requestId ?? requestIdForEvent(anchor?.event);
  if (correlatedRequestId) {
    add(
      firstMatching(
        (event) =>
          event.k === "net.req" &&
          requestIdForEvent(event) === correlatedRequestId,
      ),
    );
    add(
      firstMatching(
        (event) =>
          event.k === "net.res" &&
          requestIdForEvent(event) === correlatedRequestId,
      ),
    );
  }

  const addBudgeted = (
    budget: number,
    predicate: (event: BugEvent) => boolean,
  ) => {
    const remaining = COMPACT_TIMELINE_MAX_EVENTS - selected.size;
    for (const entry of byProximity(
      indexedEvents.filter(
        ({ event, index }) => !selected.has(index) && predicate(event),
      ),
    ).slice(0, Math.min(budget, remaining)))
      add(entry);
  };

  addBudgeted(COMPACT_TIMELINE_BUDGETS.errors, isCompactErrorEvent);
  addBudgeted(COMPACT_TIMELINE_BUDGETS.interactions, (event) =>
    ["clk", "inp", "key"].includes(event.k),
  );
  addBudgeted(
    COMPACT_TIMELINE_BUDGETS.network,
    (event) =>
      event.k === "net.req" || event.k === "net.res" || event.k === "net.err",
  );
  addBudgeted(COMPACT_TIMELINE_BUDGETS.lowSignal, isCompactLowSignalEvent);
  addBudgeted(
    COMPACT_TIMELINE_BUDGETS.context,
    (event) =>
      !isCompactErrorEvent(event) &&
      !["clk", "inp", "key", "net.req", "net.res", "net.err"].includes(
        event.k,
      ) &&
      !isCompactLowSignalEvent(event),
  );

  // Quotas preserve a useful mix, then unused capacity goes to the events most
  // relevant to the candidate rather than leaving the compact timeline sparse.
  for (const entry of byProximity(
    indexedEvents.filter(({ index }) => !selected.has(index)),
  ).slice(0, COMPACT_TIMELINE_MAX_EVENTS - selected.size))
    add(entry);

  return indexedEvents
    .filter(({ index }) => selected.has(index))
    .sort((a, b) => a.event.t - b.event.t || a.index - b.index)
    .map(({ event }) => event);
}

function compactAnchorEventKind(detector: string): BugEvent["k"] | undefined {
  if (detector === "unhandled_rejection") return "rej";
  if (detector === "console_error") return "con";
  if (detector === "uncaught_error") return "err";
  return undefined;
}

function requestIdForEvent(event: BugEvent | undefined): string | undefined {
  if (!event) return undefined;
  return requestIdForValue(event.d);
}

function requestIdForValue(value: Record<string, unknown>): string | undefined {
  const numericId = finiteNumber(value.id);
  return numericId !== undefined ? String(numericId) : safeText(value.id, 120);
}

function responseForFailedRequest(
  events: BugEvent[],
  failed: NonNullable<EvidenceIndexInput["index"]["failedReqs"]>[number],
): BugEvent | undefined {
  const id = requestIdForValue(failed);
  if (id) {
    const matches = events.filter(
      (event) => event.k === "net.res" && requestIdForEvent(event) === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  const matches = events.filter(
    (event) =>
      event.k === "net.res" &&
      requestIdForEvent(event) === undefined &&
      event.t === failed.t &&
      finiteNumber(event.d.st) === finiteNumber(failed.st),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function networkAnchorForCandidate(
  candidate: EvidenceCandidate,
  windowEvents: BugEvent[],
): BugEvent | undefined {
  const id = candidate.anchor.requestId;
  if (id) {
    const matches = windowEvents.filter(
      (event) =>
        (event.k === "net.res" || event.k === "net.err") &&
        requestIdForEvent(event) === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  const matches = windowEvents.filter(
    (event) =>
      event.t === candidate.anchor.t &&
      (event.k === "net.res" || event.k === "net.err") &&
      (candidate.anchor.status === undefined ||
        event.k !== "net.res" ||
        event.d.st === candidate.anchor.status),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function failedRequestBodySnippets(
  candidate: EvidenceCandidate,
  windowEvents: BugEvent[],
): { request?: string; response?: string } {
  const anchor = networkAnchorForCandidate(candidate, windowEvents);
  if (!anchor) return {};

  const requestId = candidate.anchor.requestId ?? requestIdForEvent(anchor);
  const request = requestId
    ? windowEvents.find(
        (event) =>
          event.k === "net.req" && requestIdForEvent(event) === requestId,
      )
    : undefined;

  return removeUndefined({
    request: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
    response:
      anchor.k === "net.res"
        ? redactedNetworkBodySnippet(anchor.d.body, anchor.d.bodySummary)
        : undefined,
  });
}

function isCompactErrorEvent(event: BugEvent): boolean {
  return ["con", "err", "rej", "probe.error", "native-crash"].includes(event.k);
}

function isCompactLowSignalEvent(event: BugEvent): boolean {
  return ["stor", "cookie", "perf", "hb", "snap"].includes(event.k);
}

function findResponseEvent(
  responses: Map<string, BugEvent>,
  t: number,
  status: unknown,
): BugEvent | undefined {
  return (
    responses.get(responseLookupKey(t, status)) ??
    responses.get(responseLookupKey(t, undefined))
  );
}

function routeAt(
  navs: Array<{ t: number; to?: string }>,
  t: number,
): string | undefined {
  let route: string | undefined;
  for (const nav of navs) {
    if (nav.t > t) break;
    route = redactUrl(nav.to);
  }
  return route;
}

/**
 * A label safe to put in a headline. `scrubText` correctly masks token-like and
 * regulated text, but a title of `**********` tells a reader nothing, so fall
 * back to the element's structural identity (role, then component, then tag)
 * and finally to a plain phrase. The unmasked-but-scrubbed label still lives on
 * the anchor for anyone who needs it.
 */
function titleElementLabel(event: BugEvent): string {
  const scrubbed = scrubText(elementLabel(event), 100);
  // Usable only if something survives once every mask token is removed — the
  // maskers emit both `[REDACTED]` and runs of `*`, and either can consume the
  // whole label.
  const unmasked = scrubbed?.replace(/\[REDACTED\]|[*•]/g, "").trim();
  if (scrubbed && unmasked) return scrubbed;

  const target = targetForEvent(event);
  const structural =
    safeText(target?.role, 60) ??
    safeText(target?.componentName, 60) ??
    safeText(target?.testID ?? target?.testId, 60);
  return structural ? `a ${structural}` : "an unlabeled element";
}

function elementLabel(event: BugEvent): string | undefined {
  const d = event.d;
  const el = isRecord(d.el) ? d.el : undefined;
  const target = targetForEvent(event);
  return (
    safeText(target?.label, 180) ??
    safeText(target?.accessibilityId, 180) ??
    safeText(target?.role, 180) ??
    safeText(target?.testID, 180) ??
    safeText(target?.componentName, 180) ??
    safeText(target?.routePath, 180) ??
    safeText(target?.ancestryHash, 180) ??
    safeText(target?.text, 180) ??
    safeText(target?.accessibilityLabel, 180) ??
    safeText(target?.testId, 180) ??
    safeText(target?.selector, 180) ??
    safeText(target?.viewName, 180) ??
    safeText(el?.txt, 180) ??
    safeText(el?.aria, 180) ??
    safeText(el?.label, 180) ??
    safeText(d.tgt, 180) ??
    safeText(d.selector, 180)
  );
}

function targetForEvent(event: BugEvent): TargetDescriptor | undefined {
  if (isRecord(event.target)) return event.target as TargetDescriptor;
  if (isRecord(event.d.target)) return event.d.target as TargetDescriptor;
  return undefined;
}

function eventSummary(event: BugEvent): string {
  const d = isRecord(event.d) ? event.d : {};
  const kind = typeof event.k === "string" ? event.k : "unknown";
  if (!isRecord(event.d)) return `${kind} event with malformed payload`;
  if (kind === "nav" || kind === "navigation")
    return `navigation to ${redactUrl(d.to ?? d.route ?? d.screen ?? d.path ?? d.name) ?? "unknown"}`;
  if (kind === "app-lifecycle")
    return `app lifecycle ${safeText(d.state, 80) ?? safeText(d.phase, 80) ?? "unknown"}`;
  if (kind === "native-crash") {
    const screenshot = scrubText(d.screenshotUri ?? d.screenshot ?? d.uri, 180);
    return [
      "native crash",
      scrubText(d.message, 220) ??
        safeText(d.exceptionType, 120) ??
        "message unavailable",
      screenshot ? `screenshot ${screenshot}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (kind === "view-snapshot")
    return `view snapshot ${
      scrubText(elementLabel(event), 180) ??
      safeText(d.screen ?? d.routePath ?? d.uri, 120) ??
      "unknown view"
    }`;
  if (kind === "clk")
    return `click ${scrubText(elementLabel(event), 180) ?? "unknown element"}`;
  if (kind === "inp") return "input changed; raw value omitted";
  if (kind === "perf")
    return `performance ${safeText(d.metric, 40) ?? safeText(d.entryType, 40) ?? "entry"} ${redactUrl(d.name) ?? ""}`.trim();
  if (kind === "net.req")
    return `request ${safeText(d.m, 20) ?? safeText(d.method, 20) ?? ""} ${redactUrl(d.url) ?? ""}`.trim();
  if (kind === "net.res")
    return `response ${safeText(d.id, 80) ?? ""} status ${finiteNumber(d.st) ?? "unknown"} dur ${finiteNumber(d.dur) ?? "unknown"} ms`;
  if (kind === "net.err")
    return `network error ${safeText(d.method, 20) ?? safeText(d.m, 20) ?? ""} ${redactUrl(d.url) ?? ""} ${scrubText(d.msg, 180) ?? ""}`.trim();
  if (kind === "backend.otel.span")
    return `otel span ${scrubText(d.name, 120) ?? ""} [${safeText(d.serviceName, 80) ?? "service"}] status ${safeText(d.statusCode, 20) ?? "UNSET"}`.trim();
  if (kind === "backend.otel.log")
    return `otel log ${safeText(d.severityText, 40) ?? ""}: ${scrubText(d.body, 220) ?? "message unavailable"}`.trim();
  if (kind === "tab.boundary") {
    const decision = safeText(d.decision, 80) ?? "unknown";
    const reason = safeText(d.reason, 120);
    const candidate = isRecord(d.candidate)
      ? (safeOriginSummary(d.candidate.origin) ??
        safeOriginSummary(d.candidate.url) ??
        safeOriginSummary(d.candidate.href) ??
        safeText(d.candidate.scheme, 40))
      : undefined;
    const prompt = isRecord(d.prompt)
      ? safeText(d.prompt.outcome, 80)
      : undefined;
    return [
      "tab boundary",
      decision,
      reason,
      candidate ? `candidate ${candidate}` : undefined,
      prompt ? `prompt ${prompt}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (kind === "con")
    return `console ${safeText(d.lv, 20) ?? ""}: ${scrubText(consoleMessage(d), 220) ?? "message unavailable"}`;
  if (kind === "err" || kind === "rej")
    return `${kind}: ${scrubText(d.msg, 220) ?? "message unavailable"}`;
  if (kind === "probe.error")
    return `page probe error ${safeText(d.phase, 80) ?? ""}: ${scrubText(d.message, 220) ?? "message unavailable"}`;
  if (kind === "media.voice" && d.state === "marker-added")
    return `voice marker ${scrubText(d.label, 180) ?? safeText(d.markerId, 80) ?? ""}`.trim();
  if (kind === "tx") return `transcript: ${scrubText(d.text, 220) ?? ""}`;
  if (kind === "snap") return "storage/cookie snapshot; values omitted";
  return scrubText(JSON.stringify(summarizePayload(d)), 220) ?? kind;
}

function isTimelineNotable(event: BugEvent): boolean {
  return [
    "session.lifecycle",
    "nav",
    "navigation",
    "app-lifecycle",
    "native-crash",
    "view-snapshot",
    "clk",
    "inp",
    "snap",
    "net.req",
    "net.res",
    "net.err",
    "con",
    "err",
    "rej",
    "probe.error",
    "perf",
    "media.voice",
    "media.video",
    "tx",
    "backend.otel.span",
    "backend.otel.log",
  ].includes(event.k);
}

function consoleMessage(data: Record<string, unknown>): string | undefined {
  const msg = safeText(data.msg, 300);
  if (msg) return msg;
  if (!Array.isArray(data.args)) return undefined;
  return data.args
    .slice(0, 6)
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : JSON.stringify(summarizePayload(entry)),
    )
    .join(" ");
}

function summarizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 6).map(summarizePayload);
  if (!isRecord(value))
    return typeof value === "string" ? scrubText(value, 100) : value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/cookie|storage|token|authorization|password|secret|value/i.test(key))
      out[key] = "[REDACTED]";
    else if (typeof entry === "string")
      out[key] = scrubText(
        key === "url" || key === "to" ? redactUrl(entry) : entry,
        100,
      );
    else if (typeof entry === "number" || typeof entry === "boolean")
      out[key] = entry;
  }
  return out;
}

function safeOriginSummary(value: unknown): string | undefined {
  const text = safeText(value, 2_000);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function scrubText(value: unknown, maxLength: number): string | undefined {
  const text = safeText(value, 10_000);
  if (!text) return undefined;
  return truncate(redactTokenLikeText(redactUrlLikeText(text)), maxLength);
}

function redactUrl(value: unknown): string | undefined {
  const text = safeText(value, 2_000);
  if (!text) return undefined;
  return truncate(redactTokenLikeText(redactCoreUrl(text).value), 240);
}

/**
 * URL shortened for use inside a human-readable title: origin plus path only.
 * The query string is where redaction expands hardest (every value becomes an
 * escaped `[REDACTED]`), which turns a title into a several-hundred-character
 * line that reads as noise and breaks any layout showing it. The full redacted
 * URL is still carried on the anchor, so nothing is lost from the evidence.
 */
function titleUrl(value: unknown): string | undefined {
  const redacted = redactUrl(value);
  if (!redacted) return undefined;
  const withoutHash = redacted.split("#")[0] ?? redacted;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  const trimmed = withoutQuery.trim();
  if (!trimmed) return undefined;
  return truncate(trimmed, 120);
}

function redactUrlLikeText(value: string): string {
  return value.replace(
    /https?:\/\/[^\s)\]}>,]+|\/[A-Za-z0-9._~!$&'()*+,;:@%-]+(?:[/?#][^\s)\]}>,]*)?/g,
    (match) => {
      try {
        return redactCoreUrl(match).value;
      } catch {
        return redactTokenLikeText(
          match.replace(/([?&][^=&#\s]+)=([^&#\s]+)/g, "$1=[REDACTED]"),
        );
      }
    },
  );
}

function redactTokenLikeText(value: string): string {
  return redactTokenLikeString(value).value;
}

/**
 * A network event's correlation id, as a string.
 *
 * The browser SDK numbers its in-flight requests, so `d.id` arrives as a number
 * on every browser captured session while a backend or a replayed session sends
 * a string. Reading it as a string only looked correct against the backend
 * fixtures and silently dropped every browser request on the floor, which took
 * `slow_request`, `pending_request` and `response_race` with it: their request
 * table was simply empty. Both shapes are valid capture, so both are accepted.
 */
function networkRequestId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return safeText(value, 120);
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return truncate(trimmed, maxLength);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Coercing variant of `finiteNumber`: also parses numeric strings ("3" → 3); strict `finiteNumber` accepts numbers only. */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function offsetForEvent(event: BugEvent | undefined): number | undefined {
  if (!event) return undefined;
  return (
    finiteNumber(event.offsetMs) ??
    (isRecord(event.d) ? finiteNumber(event.d.offsetMs) : undefined)
  );
}

function offsetFromStart(t: number, start: unknown): number | undefined {
  const startMs = finiteNumber(start);
  return startMs === undefined ? undefined : Math.max(0, t - startMs);
}

function formatOffset(offsetMs: number | undefined, t: unknown): string {
  const safeOffset = finiteNumber(offsetMs);
  if (safeOffset !== undefined) return `${safeOffset} ms`;
  const safeTime = finiteSafeTimestamp(t);
  return safeTime === undefined
    ? "unknown time"
    : new Date(safeTime).toISOString();
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
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

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Baseline policy tag for evidence produced by this indexer. Typed as the
 * v1|v2 union: individual events may carry either tag (structured v2 network
 * bodies included), even though the indexer's own baseline remains v1.
 */
export function evidenceRedactionPolicy(): BrowserRedactionPolicy {
  return BROWSER_REDACTION_POLICY;
}
