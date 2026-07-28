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
import { attributeCandidates } from "./causal-graph";
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
  const mutatingRequests = collectMutatingRequests(events);
  addDbDeltaMismatchCandidates(events, index, drafts, mutatingRequests);
  addClientSuppliedValueCandidates(events, index, drafts, mutatingRequests);
  addIneffectiveInputCandidates(events, index, drafts, mutatingRequests);
  addUiArithmeticMismatchCandidates(events, index, drafts);
  addUiApiDivergenceCandidates(events, index, drafts);
  addOtelDbActivityCandidates(events, index, drafts);

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
 * Replaces an earlier rank-tier partition (roots ahead of demoted high/medium symptoms) plus an
 * `enforceRootBeforeSymptom` sweep that undid it. The two disagreed by design, the sweep won, and
 * because it honored EVERY `rootCauseId` regardless of grade, the `low` tier's documented
 * "annotate only, order preserved" contract was not true of position.
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
   * A symptom→root link strong enough to bind the two into one ranked chain. `low` links are the
   * request spine's time ordering restated, so they annotate without binding — see the header.
   */
  const creditedParent = (draft: CandidateDraft): string | undefined => {
    if (draft.causalRole !== "symptom" || !draft.rootCauseId) return undefined;
    if (
      draft.attributionConfidence !== "high" &&
      draft.attributionConfidence !== "medium"
    )
      return undefined;
    return byKey.has(draft.rootCauseId) ? draft.rootCauseId : undefined;
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
    const requestId = safeText(event.d.id, 120);
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
      if (isHandledClientError(finiteNumber(event.d.st), event.d.body)) continue;
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

/** The pk values of a diff, as strings. */
function pkValuesOf(event: BugEvent): string[] {
  const pk = event.d.pk;
  if (!isRecord(pk)) return [];
  return Object.values(pk).map((value) => String(value));
}

/**
 * Do these two rows reference each other?
 *
 * Linkage is a foreign key match: one row's after image or pk carries a value
 * equal to the other row's primary key. This is the whole guard against
 * comparing unrelated rows that happen to share a column name — two different
 * customers' `orders` rows both have a `total_cents` and are supposed to
 * differ.
 */
function rowsAreLinked(left: BugEvent, right: BugEvent): boolean {
  const referencesPkOf = (from: BugEvent, target: BugEvent): boolean => {
    const targetPks = new Set(pkValuesOf(target));
    if (targetPks.size === 0) return false;
    const after = from.d.after;
    const candidates = [
      ...pkValuesOf(from),
      ...(isRecord(after) ? Object.values(after).map((v) => String(v)) : []),
    ];
    return candidates.some((value) => targetPks.has(value));
  };
  return referencesPkOf(left, right) || referencesPkOf(right, left);
}

/**
 * db_field_divergence: two linked rows written by ONE request disagree about
 * the same named value.
 *
 * The real case: a checkout wrote `products.price_cents=8900` and
 * `order_items.price_cents=7900` in one request, the order_items row
 * referencing the products row. Two prices for one product, written together,
 * neither one wrong on its own. No existing detector reads the `db.diff` set
 * as a set, so the candidate list was identical to the clean control's.
 *
 * Silent on ambiguity, by these guards:
 *  - both rows must carry a record `after` image;
 *  - the rows must be in DIFFERENT tables. Two rows of one table are siblings,
 *    not a contradiction, and are supposed to hold different values;
 *  - they must be linked by a foreign key match (see {@link rowsAreLinked});
 *  - the shared field must name a value, not an identity or a clock;
 *  - both values must be finite numbers. A string field disagreeing is not
 *    reliably a contradiction — two rows can legitimately hold different
 *    labels for one entity.
 */
function addDbFieldDivergenceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    if (diffs.length < 2) continue;
    for (let i = 0; i < diffs.length; i += 1) {
      for (let j = i + 1; j < diffs.length; j += 1) {
        const left = diffs[i];
        const right = diffs[j];
        const leftTable = safeText(left.d.table, 200);
        const rightTable = safeText(right.d.table, 200);
        if (!leftTable || !rightTable || leftTable === rightTable) continue;
        const leftAfter = left.d.after;
        const rightAfter = right.d.after;
        if (!isRecord(leftAfter) || !isRecord(rightAfter)) continue;
        if (!rowsAreLinked(left, right)) continue;

        for (const field of Object.keys(leftAfter)) {
          if (!(field in rightAfter)) continue;
          if (isIdentityOrClockField(field)) continue;
          const leftValue = toFiniteNumber(leftAfter[field]);
          const rightValue = toFiniteNumber(rightAfter[field]);
          if (leftValue === undefined || rightValue === undefined) continue;
          if (leftValue === rightValue) continue;

          const anchorEvent = left.t <= right.t ? left : right;
          drafts.push({
            detector: "db_field_divergence",
            title: `Linked rows disagree on ${field}: ${leftTable}.${field}=${leftValue} but ${rightTable}.${field}=${rightValue} in one request`,
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
              message: `${leftTable}.${field}=${leftValue} vs ${rightTable}.${field}=${rightValue} (rows linked by id, written by request ${requestId})`,
              source: normalizeDbEngine(anchorEvent.d.engine),
            }),
            // Table pair is ordered so the key does not depend on diff order.
            dedupeKey: `dbfielddiv:${requestId}:${field}:${[leftTable, rightTable].sort().join("|")}`,
          });
        }
      }
    }
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
      collectNumbersByPath(entry, path ? `${path}.${key}` : key, out, depth + 1);
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
        if (bodyPath === undefined) continue;

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
            message: `${request.method} ${request.url ?? ""} sent ${bodyPath}=${value}; ${table}.${field} stored ${value} (request ${requestId})`.trim(),
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
 * The comparable content of an insert: its after image minus the primary key,
 * canonicalized so two rows written in either key order compare equal.
 *
 * Returns undefined when nothing DISCRIMINATING survives the pk drop, because a
 * signature that cannot tell two different rows apart cannot be evidence that
 * they are one row written twice. Three cases are rejected:
 *
 *  - Nothing survives. The clean control run inserts two `shipments` rows whose
 *    after images are `{id: …}` alone, so they reduce to `{}` and a naive
 *    "identical inserts" rule fires on the control.
 *  - Every surviving value is zero or empty, which is the same absence wearing
 *    a column name.
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
    .filter(([key]) => !pkKeys?.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
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
        const anchorEvent = group.reduce((earliest, event) =>
          event.t < earliest.t ? event : earliest,
        );
        const label = scrubText(table, 100) ?? "table";
        const entries = entriesBySignature.get(signature) ?? [];
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

function collectRequests(events: BugEvent[]): Map<string, RequestInfo> {
  const requests = new Map<string, RequestInfo>();
  const navs = collectNavigationContext(events);
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const id = safeText(event.d.id, 120);
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
function isHandledClientError(status: number | undefined, body: unknown): boolean {
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
