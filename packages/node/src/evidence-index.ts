import fs from "node:fs";
import path from "node:path";
import {
  CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  redactTokenLikeString,
  redactUrl as redactCoreUrl,
  type BrowserRedactionPolicy,
  type BugEvent,
  type TargetDescriptor,
} from "crumbtrail-core";
import { BROWSER_REDACTION_POLICY, normalizeDbEngine } from "./llm-bundle";
import { redactedNetworkBodySnippet } from "./network-body";
import { sanitizeSelector } from "./sanitize-selector";
import {
  attributeCandidates,
  CAUSAL_MAP_WINDOW_MS,
  namesFailureOnGenericPlane,
} from "./causal-graph";
import { defaultSessionStore } from "./session-store";
import type {
  CandidateAttribution,
  CausalConfidence,
  CausalGraph,
  ContentionLoss,
  IsolationCause,
} from "./causal-graph";
import {
  directorySourceMapLookup,
  resolveFrame,
  type SourceMap,
} from "./source-map";
import { normalizeUrl } from "./route-normalization";

export const CANDIDATE_SCHEMA_VERSION = 1 as const;

/**
 * How much of the session's evidence stands behind a signal — the SDK's own confidence that it
 * could ATTACH that signal to the session, expressed to the reader instead of thrown away.
 *
 * The ranker already computes this and then discards it: severity, a per-detector constant chosen
 * when the detector was written, decides the reader's headline on its own. Severity says how bad
 * this KIND of finding is; it cannot say whether THIS instance was connected to anything else that
 * happened. Two signals of identical severity, one placed in the causal chain and one the graph
 * could not place at all, render identically, and the reader has no way to tell which is which.
 *
 * - `not-assessed` — no causal attribution ran for this session, so the question was never asked.
 *   NOT the same as a failed attempt, and never collapsed into one.
 * - `unattached`   — attribution ran and could not connect this signal to anything else here. The
 *   measurement stands; what is missing is any link between it and the rest of the session.
 * - `attached`     — placed in the session's causal structure, with nothing further corroborating.
 * - `corroborated` — placed AND backed by another signal: a root that explains a symptom, or a
 *   symptom whose link to its root is graded above the request spine's bare time ordering.
 *
 * This is a QUALIFIER, never a rank. Nothing here reorders, demotes or rescores anything, and it
 * must stay that way: the SDK's own measurement is that a top-ranked candidate is very often
 * `isolated` AND is very often the detector that names the incident, so demoting unattached
 * signals would bury the correct finding in most sessions. The defect is that the reader is not
 * TOLD, not that the order is wrong.
 */
export type SupportGrade =
  | "not-assessed"
  | "unattached"
  | "attached"
  | "corroborated";

/**
 * What a failing operation's later session evidence establishes.
 *
 * `unknown` is intentionally different from `not_recovered`: a session that
 * ends at the failure has not observed enough of the future to make an
 * absence claim.
 */
export type FailureRecovery =
  | { status: "recovered"; afterMs: number }
  | { status: "not_recovered" }
  | {
      status: "unknown";
      reason: "session_ended" | "operation_not_identified";
    };

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

// A client-error consequence is bounded by the same post-anchor window readers receive for a
// normal candidate. This is intentionally a consequence window, not a status/path allowlist.
const CLIENT_ERROR_CONSEQUENCE_WINDOW_MS = 45_000;
const CLIENT_ERROR_RETRY_WINDOW_MS = 10_000;

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
    /** Pseudonymous caller identity declared by the session, when available. */
    identity?: {
      userId?: string;
      accountId?: string;
    };
    failedReqs?: Array<{
      t: number;
      m?: string;
      url?: string;
      st?: number;
      /** Browser-local sequence number, restarted at 1 on every page load. */
      id?: string | number;
      /** Shared correlation id, when the exchange carried one. See {@link requestIdForValue}. */
      requestId?: string;
      reason?: string;
      code?: string;
      message?: string;
      phase?: string;
    }>;
    networkErrors?: Array<{
      t: number;
      offsetMs?: number;
      /** Browser-local sequence number, restarted at 1 on every page load. */
      id?: string | number;
      /** Shared correlation id, when the exchange carried one. See {@link requestIdForValue}. */
      requestId?: string;
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
      /** React component path, set only for boundary-caught crashes. */
      componentStk?: string;
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
  /** Whether a later equivalent operation succeeded. */
  recovery?: FailureRecovery;
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
     * The database table the anchoring row belongs to, set by the database
     * detectors. Already emitted in every session — declared here because the
     * causal attribution now READS it (see `derivedNodeKinds`), and a field a
     * behaviour depends on must be in the type rather than only in the data.
     */
    table?: string;
    /**
     * The normalized, value-free shape of the statement this signal is about —
     * the same string `databaseErrors[].shape` renders, carried here so the
     * ranked opinion names the statement rather than only the table it touched.
     *
     * Produced by `normalizeStatementShape` at capture time, which is the one
     * place that guarantee is made; it is re-bounded here and otherwise passed
     * through unchanged, exactly as the rendering path does. Re-scrubbing it
     * would make the ranked list and the rendered evidence disagree about the
     * same string, which is worse than either treatment on its own.
     */
    statementShape?: string;
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
    /**
     * The React component path a render crash happened inside, present only for
     * a crash caught by a `CrumbtrailErrorBoundary`. A render crash's JS stack
     * names the reconciler frames that rethrew it; this names the components,
     * which is what tells a reader which file to open.
     */
    componentStack?: string;
    /** Existing element signature from d.el, when the capture supplied one. */
    elementSignature?: string;
    target?: TargetDescriptor;
  };
  /**
   * How much of this session's evidence stands behind this signal, DERIVED from the causal
   * attribution the re-rank already computed. Additive/optional; see {@link SupportGrade}.
   *
   * Optional because a candidate read back from an artifact written by an older SDK genuinely
   * does not carry one, and a reader must be able to tell that apart from a graded signal. Every
   * candidate this module emits carries it.
   */
  support?: SupportGrade;
  /** Causal role assigned by the confidence-gated re-rank (CP3). Additive/optional. */
  causalRole?: "root" | "symptom" | "isolated";
  /** For a symptom, the candidate id of its attributed root cause. */
  rootCauseId?: string;
  /** For a root, the sorted candidate ids of the symptoms attributed to it. */
  causes?: string[];
  /** Weakest edge confidence along the causal path from root to this symptom. */
  attributionConfidence?: CausalConfidence;
  /**
   * For an isolated candidate, WHY it is isolated. Additive/optional.
   *
   * `isolated` used to be one word for three different situations, one of which
   * — losing a one-candidate-per-node contest — is not an absence of evidence at
   * all. See {@link IsolationCause}.
   */
  isolationCause?: IsolationCause;
  /**
   * The node this candidate lost and the candidate that holds it, when
   * `isolationCause` is `lost-contention`. `heldBy` is a candidate id from THIS
   * artifact, so a reader can resolve it against the emitted candidates.
   */
  contention?: ContentionLoss;
  evidenceWindow: { start: number; end: number; windowId: string };
}

interface CandidateDraft extends Omit<
  EvidenceCandidate,
  "schemaVersion" | "id" | "evidenceWindow"
> {
  wideWindow?: boolean;
  dedupeKey: string;
  /**
   * Latest timestamp among the drafts that collapsed into this one, when that is later than
   * `anchor.t`. Dedupe deliberately keeps the EARLIEST anchor, so a finding about a repeated
   * sequence (four clicks on a dead button) is anchored at the first of them and looks, to anything
   * reading `anchor.t` alone, like it was over before the user's later actions. Ranking needs to
   * know when the evidence actually stopped, not when it started.
   */
  lastT?: number;
  causalRole?: "root" | "symptom" | "isolated";
  rootCauseId?: string;
  causes?: string[];
  attributionConfidence?: CausalConfidence;
  isolationCause?: IsolationCause;
  /** `heldBy` is a dedupeKey here, remapped to the emitted candidate id on emit. */
  contention?: ContentionLoss;
}

interface RequestInfo {
  id: string;
  t: number;
  offsetMs?: number;
  method?: string;
  url?: string;
  route?: string;
}

interface OperationObservation {
  t: number;
  requestId?: string;
  method?: string;
  url?: string;
  key?: string;
}

const RECOVERED_FAILURE_SCORE_CEILING = 40;
const FAILURE_RECOVERY_MATCH_WINDOW_MS = 2_000;

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
  return expandNativeNetworkEvents(
    events.flatMap((event) => {
      const t = finiteSafeTimestamp(event.t);
      const k =
        typeof event.k === "string" && event.k.length > 0 ? event.k : undefined;
      if (t === undefined || k === undefined) return [];
      return [{ ...event, t, k, d: isRecord(event.d) ? event.d : {} }];
    }),
  );
}

/**
 * Payload keys a native `net` event carries that are already understood on the
 * browser plane and must survive the rewrite verbatim.
 */
const NATIVE_NET_CARRIED_KEYS = [
  "sessionId",
  "requestId",
  "traceId",
  "spanId",
  "hdrs",
  "reqHdrs",
] as const;

/**
 * Rewrites native `k:"net"` events into the `net.req` / `net.res` pair the rest
 * of this file reads.
 *
 * `docs/specs/native-sdk-wire-contract.md` fixes ONE event per completed
 * request for every SDK that is not built on `crumbtrail-core` — Swift, Kotlin,
 * Dart — with the status under `d.status`. The browser collector emits three
 * events with the status under `d.st`. This file was written against the
 * browser spelling only, so before this normalisation every mobile session's
 * network plane indexed as an empty set: failed requests, latency outliers,
 * retry storms and every full stack join were computed over nothing, and a
 * session with a 500 on checkout was graded as if the request never happened.
 *
 * Normalising here rather than teaching forty odd predicates a second spelling
 * keeps one shape in the analyzer and one place for the next SDK to join.
 *
 * The array is returned untouched when no `net` event is present, so a browser
 * session takes no new code path at all.
 */
function expandNativeNetworkEvents(events: BugEvent[]): BugEvent[] {
  if (!events.some((event) => event.k === "net")) return events;

  const out: BugEvent[] = [];
  let synthesized = 0;
  for (const event of events) {
    if (event.k !== "net" || !isRecord(event.d)) {
      out.push(event);
      continue;
    }
    const d = event.d;
    const dur = finiteNumber(d.dur);
    // The transport-local join key. Native SDKs send no page-local sequence
    // number, so one is synthesised — deliberately NOT a bare run of digits,
    // which `requestIdForValue` reads as a browser counter.
    const id = networkRequestId(d.id) ?? `nat_${(synthesized += 1)}`;
    const carried: Record<string, unknown> = {};
    for (const key of NATIVE_NET_CARRIED_KEYS) {
      if (d[key] !== undefined) carried[key] = d[key];
    }
    const method = safeText(d.method, 20);
    const url = safeText(d.url, 400);
    const source = safeText(d.source, 40);

    // The request is dated by working back from the completion the SDK
    // reported. `dur` is the only thing that can place it, and a missing or
    // negative one collapses the exchange to a point rather than inventing a
    // start time before the session.
    const startedAt =
      dur !== undefined && dur >= 0 ? Math.max(0, event.t - dur) : event.t;

    out.push({
      ...event,
      t: startedAt,
      k: "net.req",
      d: removeUndefined({ id, method, url, source, ...carried }),
    });
    out.push({
      ...event,
      k: "net.res",
      d: removeUndefined({
        id,
        st: finiteNumber(d.status),
        dur,
        method,
        url,
        source,
        ok: typeof d.ok === "boolean" ? d.ok : undefined,
        body: d.body,
        ...carried,
      }),
    });
  }
  // Only the synthesised request start can be out of order, and only relative
  // to events the SDK reported while the request was in flight. Sorting is
  // confined to the expanded case so a browser session's ordering is byte for
  // byte what it was.
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Derives a candidate's {@link SupportGrade} from the causal attribution already attached to it.
 *
 * PURE, and a function of `causalRole` / `causes` / `attributionConfidence` ONLY. It reads what
 * attribution concluded and never re-decides it, so no detector can assert its own support: a
 * detector that set this field directly would be back to the per-detector constant this grade
 * exists to complement.
 *
 * The three states stay genuinely distinct because `applyCausalRerank` only attributes when a
 * non-empty graph exists. With no graph `causalRole` is left `undefined` — NOT `"isolated"` — so
 * "nothing was asked" cannot be mistaken for "I asked and could not place it".
 *
 * `isolationCause` deliberately does NOT change the grade. All three of its values mean the same
 * thing to a reader deciding how far to trust a headline: this signal was not connected to the
 * rest of the session. WHY it was not connected is a separate question, answered where the
 * candidate is described in full rather than by splitting this grade into variants that would
 * read as degrees of trust they are not.
 */
function supportGrade(draft: {
  causalRole?: "root" | "symptom" | "isolated";
  causes?: string[];
  attributionConfidence?: CausalConfidence;
}): SupportGrade {
  if (draft.causalRole === undefined) return "not-assessed";
  if (draft.causalRole === "isolated") return "unattached";
  if (draft.causalRole === "root") {
    // A root that explains a symptom has a second signal standing behind it; a root with nothing
    // attributed to it is placed but alone.
    return draft.causes !== undefined && draft.causes.length > 0
      ? "corroborated"
      : "attached";
  }
  // A symptom's link to its root is only as good as the weakest edge along it. A `low` link is the
  // request spine's time ordering restated — the ranker already refuses to let it bind a chain, so
  // it must not read here as corroboration either.
  return draft.attributionConfidence === "high" ||
    draft.attributionConfidence === "medium"
    ? "corroborated"
    : "attached";
}

/**
 * What the backend plane says a correlated request was aimed at.
 *
 * A frontend failure whose `net.req` did not survive the retained window has no
 * method and no url of its own, and every title minted from it read "HTTP 500
 * from request unknown URL" while the backend record for the SAME request — two
 * lines down in the same bundle — named the endpoint outright. The correlation
 * id is the join, so the display target is recovered rather than invented: the
 * value shown is the backend's own already-redacted `pathname`/`route`, not a
 * reconstruction.
 *
 * Newly captured sessions rarely need this — `net.res` now carries its own
 * method and url — but a session captured by an older SDK, or one whose
 * response arrived through a transport that reports no url, still joins here.
 */
function collectBackendRequestTargets(
  events: BugEvent[],
): Map<string, { method?: string; url?: string }> {
  const targets = new Map<string, { method?: string; url?: string }>();
  for (const event of events) {
    if (
      event.k !== "backend.req.start" &&
      event.k !== "backend.req.end" &&
      event.k !== "backend.req.error"
    )
      continue;
    const requestId = safeText(event.d.requestId, 120);
    if (!requestId) continue;
    const method = safeText(event.d.method, 20);
    const url =
      redactUrl(event.d.pathname) ??
      redactUrl(event.d.route) ??
      redactUrl(event.d.url);
    if (method === undefined && url === undefined) continue;
    const existing = targets.get(requestId);
    targets.set(
      requestId,
      removeUndefined({
        method: existing?.method ?? method,
        url: existing?.url ?? url,
      }),
    );
  }
  return targets;
}

export function buildEvidenceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  causalGraph?: CausalGraph,
): EvidenceCandidate[] {
  // Idempotent: the expansion leaves no `k:"net"` behind, so the pass
  // writeEvidenceIndex already made is a no-op here.
  events = expandNativeNetworkEvents(events);
  index = withNavigationContext(events, index);
  const requestById = collectRequests(events);
  const backendTargets = collectBackendRequestTargets(events);
  const outcomeIds = new Set<string>();
  const drafts: CandidateDraft[] = [];

  for (const event of events) {
    if (event.k === "net.res" || event.k === "net.err") {
      const id = networkRequestId(event.d.id);
      if (id) outcomeIds.add(id);
    }
  }
  for (const entry of index.networkErrors ?? []) {
    const id = networkRequestId(entry.id);
    if (id) outcomeIds.add(id);
  }

  for (const failed of index.failedReqs ?? []) {
    // Network-level failures (no HTTP response) are counted in failedReqs but
    // already surface as network_error candidates via index.networkErrors —
    // an "HTTP 0" candidate here would double-count the same failure.
    if (failed.reason === "network_error") continue;
    const response = responseForFailedRequest(events, failed);
    // Two different ids, deliberately. `requestById` is keyed by the transport's
    // own page-local sequence number, so the lookup has to use that; the anchor
    // publishes the shared correlation id, which is the only key the backend
    // plane also holds.
    const transportId = response ? networkRequestId(response.d.id) : undefined;
    const req = transportId ? requestById.get(transportId) : undefined;
    // The index entry carries the correlation id too, stamped at post-process
    // time. Fall back to it when the `net.res` event is missing — capture
    // truncation drops events long before it drops index entries, and an
    // anchor with no requestId is one the backend plane cannot join to.
    const reqId = requestIdForEvent(response) ?? requestIdForValue(failed);
    const detector =
      failed.reason === "application_failure"
        ? "app_2xx_failure"
        : "http_error";
    // The frontend's own view first; the backend's record of the same
    // correlated request only when the frontend view is blank.
    const backendTarget = reqId ? backendTargets.get(reqId) : undefined;
    const failedMethod =
      failed.m || req?.method || backendTarget?.method || undefined;
    const failedUrl =
      failed.url || req?.url || backendTarget?.url || undefined;
    const failedTarget = titleUrl(failedUrl ?? "") ?? "unknown URL";
    drafts.push({
      detector,
      title:
        failed.reason === "application_failure"
          ? `Application failure in ${failedMethod ?? "request"} ${failedTarget}`
          : `HTTP ${failed.st ?? "error"} from ${failedMethod ?? "request"} ${failedTarget}`,
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
        method: failedMethod,
        url: redactUrl(failedUrl),
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
    const backendTarget = requestId ? backendTargets.get(requestId) : undefined;
    const errMethod =
      entry.method || entry.m || backendTarget?.method || undefined;
    const errUrl = entry.url || backendTarget?.url || undefined;
    drafts.push({
      detector: "network_error",
      title: `Network error from ${errMethod ?? "request"} ${titleUrl(errUrl ?? "") ?? "unknown URL"}`,
      severity: "high",
      score: 86,
      confidence: "high",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs: entry.offsetMs ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        requestId,
        method: errMethod,
        url: redactUrl(errUrl),
        message: scrubText(entry.msg, 220),
        source: entry.transport,
      }),
      dedupeKey: `neterr:${requestId ?? entry.t}:${entry.method ?? entry.m ?? ""}:${entry.url ?? ""}:${entry.msg ?? ""}`,
    });
  }

  for (const entry of index.consoleErrors ?? []) {
    if (isCrumbtrailSelfDiagnostic(entry.msg)) continue;
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
        componentStack: scrubText(entry.componentStk, 600),
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

  addRepeatedClickCandidates(events, index, drafts, causalGraph);
  addSlowRequestCandidates(events, index, requestById, drafts);
  addPendingRequestCandidates(index, requestById, outcomeIds, drafts);
  addResponseRaceCandidates(events, index, requestById, drafts);
  addIneffectiveSubmitCandidates(events, index, drafts);
  addMediaDegradationCandidates(events, index, drafts);
  addVoiceMarkerCandidates(events, index, drafts);
  addTranscriptComplaintCandidates(events, index, drafts);
  addConsoleWarningCandidates(events, index, drafts);
  addOtelErrorCandidates(events, index, drafts);
  addBackendErrorCandidates(events, index, drafts);
  addDbErrorCandidates(events, index, drafts);
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
  addUnrequestedClearCandidates(events, index, drafts, mutatingRequests);
  addResponseCountMismatchCandidates(events, index, drafts, mutatingRequests);
  addRetryLoopAgainstSuccessCandidates(events, index, drafts);
  addWriteReadColumnSplitCandidates(events, index, drafts);
  addEmptyDownloadCandidates(events, index, drafts, requestById);
  addContentTypeBodyMismatchCandidates(events, index, drafts, requestById);
  addApiRouteReturnedDocumentCandidates(events, index, drafts, requestById);
  addAcknowledgedWriteNeverLandedCandidates(events, index, drafts);
  addLatencyOutlierCandidates(events, index, drafts, requestById);
  addIneffectiveInputCandidates(events, index, drafts, mutatingRequests);
  addUiArithmeticMismatchCandidates(events, index, drafts);
  addUiApiDivergenceCandidates(events, index, drafts);
  addOtelDbActivityCandidates(events, index, drafts);
  addSlowDependencySpanCandidates(events, index, drafts);

  // Full-recall detectors. Append-only: every rule above keeps its position and
  // its ranking, and these read evidence the pipeline already captured but no
  // rule had ever looked at.
  const exchanges = collectRequestExchanges(events);
  addWriteReadDivergenceCandidates(index, drafts, exchanges);
  addFilterContradictionCandidates(index, drafts, exchanges);
  addResultRowLossCandidates(events, index, drafts, exchanges);
  addUnownedReadCandidates(index, drafts, exchanges);
  addSharedStateBleedCandidates(events, index, drafts, exchanges);
  addAcknowledgedWriteLostCandidates(events, index, drafts, exchanges);
  addBatchImportCandidates(events, index, drafts, exchanges);
  addRelationalWriteIntegrityCandidates(events, index, drafts, exchanges);
  addOpsStateLifecycleCandidates(events, index, drafts, exchanges);
  addDataLifecycleIntegrityCandidates(events, index, drafts, exchanges);
  addBrowserNetworkIntegrityCandidates(events, index, drafts, exchanges);
  addRefundInvariantCandidates(events, index, drafts);
  addSessionCartInvariantCandidates(events, index, drafts, exchanges);
  attachDuplicateEffectFrames(events, drafts);
  addLocaleInputCandidates(index, drafts, exchanges);
  addRuntimeWarningCandidates(events, index, drafts);
  addBackendLogErrorCandidates(events, index, drafts);
  addClickInterceptedCandidates(events, index, drafts);
  addDeclinedPaymentOrderedCandidates(events, index, drafts);
  addCheckoutCorrectnessCandidates(events, index, drafts);
  addDownstreamSucceededAfterTimeoutCandidates(events, index, drafts);
  addInvalidWebhookSignatureAcceptedCandidates(
    events,
    index,
    drafts,
    exchanges,
  );
  addStoredActiveMarkupCandidates(events, index, drafts);
  addInputRevertedCandidates(events, index, drafts);
  addFormResetAfterErrorCandidates(events, index, drafts);
  addCurrencyLocaleMismatchCandidates(events, index, drafts);
  addStaleValueRenderedCandidates(events, index, drafts, exchanges);
  addDisplayedFieldMismatchCandidates(events, index, drafts, exchanges);
  addDisplayDateTimezoneMismatchCandidates(events, index, drafts);
  addLayoutOverflowCandidates(events, index, drafts);
  addStaleViewAfterPopCandidates(events, index, drafts);
  addListenerGrowthCandidates(events, index, drafts);
  addStreamDesyncCandidates(events, index, drafts, exchanges);
  addJobOutcomeCandidates(events, index, drafts);

  // Recovery is a property of the observed operation, not of one detector. Match every
  // failure-shaped candidate to the operation it names, so HTTP, transport, backend, and
  // future request failure detectors all receive the same three-state result.
  attachFailureRecovery(drafts, events, index, requestById);

  // Remove 4xx responses whose captured consequences are clean before dedupe. They remain in the
  // raw event stream, but cannot mint a candidate or a canonical issue.
  removeConsumedClientErrors(
    drafts,
    events,
    causalGraph,
    causalAttributionForDrafts(drafts, causalGraph),
  );

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
  capWithDetectorDiversity(ordered);

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
    const heldById = draft.contention
      ? idByDedupeKey.get(draft.contention.heldBy)
      : undefined;
    const contention =
      draft.contention && heldById
        ? { ...draft.contention, heldBy: heldById }
        : undefined;
    return {
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
      id,
      detector: draft.detector,
      // The single funnel every minted title passes through, so no detector can put a
      // one-occurrence id or an internal redaction marker into a permanent name.
      title: sanitizeTitle(draft.title),
      severity: draft.severity,
      score: draft.score,
      confidence: draft.confidence,
      ...(draft.recovery !== undefined ? { recovery: draft.recovery } : {}),
      // Emitted unconditionally, unlike the optional causal fields below: "not-assessed" is a real
      // answer and omitting it would leave a reader unable to tell an ungraded candidate from one
      // this SDK never graded. DERIVED here and nowhere else — no draft carries a `support`.
      support: supportGrade(draft),
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
      ...(draft.isolationCause ? { isolationCause: draft.isolationCause } : {}),
      // `heldBy` is a dedupeKey inside the attributor; the artifact speaks in
      // emitted candidate ids, exactly as `rootCauseId` above does. A key that
      // does not resolve (its candidate was capped out of the emitted set) drops
      // the whole record rather than shipping a dangling reference — the cause
      // then reads `lost-contention` with no incumbent named, which is true.
      ...(contention ? { contention } : {}),
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
/**
 * Thread-level ranking weights. Deliberately small relative to detector scores, which span 15..97:
 * these reorder threads that are already close, they do not let a weak thread overtake a strong one.
 */
export const THREAD_RANK_CONSTANTS = {
  /** Per additional evidence plane a thread spans, beyond the first. */
  PLANE_SPAN: 6,
  /** Cap, so a thread cannot win on breadth alone. */
  MAX_PLANE_SPAN: 18,
  /**
   * Applied to a thread that ENDS before the user's last action.
   *
   * Large enough to matter, because the effect it corrects is large: `n_plus_one_query` scores 78
   * and led twenty-five of thirty sessions while the decisive signal sat at 55. A term that cannot
   * cross a gap that size is decoration.
   *
   * It only ever moves a thread DOWN, and only one that is both entirely in the past and causally
   * unconnected to anything the user did afterwards — see {@link threadWeight} for why that
   * conjunction is what keeps a genuine earlier root cause safe.
   */
  ENDED_BEFORE_LAST_INTERACTION: -25,
} as const;

/**
 * Which evidence plane a finding lives on.
 *
 * Coarse on purpose. The question a thread's span answers is "how much of the stack does this
 * explain", and browser/network/backend/db are the divisions that carry that meaning; splitting
 * finer would inflate the span of threads that merely have varied detectors.
 */
function planeOfDraft(draft: CandidateDraft): string {
  const detector = draft.detector;
  if (detector.startsWith("db_") || detector.startsWith("otel_db")) return "db";
  if (detector.startsWith("backend_")) return "backend";
  if (detector.startsWith("otel_")) return "otel";
  if (draft.anchor.source === "backend") return "backend";
  if (
    detector.includes("http") ||
    detector.includes("request") ||
    detector.includes("network") ||
    detector.includes("response")
  )
    return "network";
  return "browser";
}

/**
 * When the user last did something.
 *
 * The best app-agnostic proxy available for "what the ticket is about". A person reports the thing
 * that happened when they acted; evidence from an earlier page load is, far more often than not,
 * ambient. Read from the graph's own `user.click`/`user.input` nodes, so it needs no extra input
 * and is undefined for a session with no interaction at all — in which case the term simply does
 * not apply and every thread is treated alike.
 */
function lastUserInteractionTime(graph?: CausalGraph): number | undefined {
  if (!graph) return undefined;
  let latest: number | undefined;
  for (const node of graph.nodes) {
    if (node.kind !== "user.click" && node.kind !== "user.input") continue;
    if (latest === undefined || node.t > latest) latest = node.t;
  }
  return latest;
}

/**
 * How much this thread looks like the incident, as opposed to a true observation about the app.
 *
 * Two terms, both properties of the THREAD rather than of any member:
 *
 *  - SPAN. A thread joining a click to a request to a database write explains more of what
 *    happened than one sitting entirely on a single plane. An N+1 query is real, and it is one
 *    plane wide in every session it appears in.
 *
 *  - REACH. A thread whose evidence extends to the user's last action is far likelier to be the
 *    thing they reported than one that closed during an earlier page load.
 *
 * Neither knows anything about the application, and neither asks whether a finding is "important".
 * They ask how much of this session's story the thread accounts for, which is the question the
 * primary slot is actually answering.
 */
function threadWeight(
  chainMembers: CandidateDraft[],
  lastInteractionT: number | undefined,
): number {
  const planes = new Set(chainMembers.map(planeOfDraft));
  const span = Math.min(
    THREAD_RANK_CONSTANTS.MAX_PLANE_SPAN,
    (planes.size - 1) * THREAD_RANK_CONSTANTS.PLANE_SPAN,
  );

  if (lastInteractionT === undefined) return span;

  // The conjunction matters. A real root cause very often PRECEDES its symptom — a bad write now,
  // a wrong number on screen later — and penalising everything in the past would bury exactly the
  // findings worth surfacing. What is safe to demote is a thread that is entirely in the past AND
  // has nothing attributed to it afterwards: an observation the user had already moved past by the
  // time they did the thing they are reporting. A genuine earlier cause escapes because its later
  // symptom is a member of its own chain, which puts a member at or after the interaction.
  const reaches = chainMembers.some(
    (draft) => Math.max(draft.anchor.t, draft.lastT ?? draft.anchor.t) >= lastInteractionT,
  );
  return (
    span +
    (reaches ? 0 : THREAD_RANK_CONSTANTS.ENDED_BEFORE_LAST_INTERACTION)
  );
}

function causalAttributionForDrafts(
  drafts: CandidateDraft[],
  causalGraph?: CausalGraph,
): Map<string, CandidateAttribution> | undefined {
  if (!causalGraph || causalGraph.nodes.length === 0) return undefined;
  const detectorByKey = new Map<string, string>();
  for (const draft of drafts)
    detectorByKey.set(draft.dedupeKey, draft.detector);
  return attributeCandidates(
    causalGraph,
    drafts.map((draft) => ({
      id: draft.dedupeKey,
      anchor: {
        t: draft.anchor.t,
        requestId: draft.anchor.requestId,
        route: draft.anchor.route,
        source: draft.anchor.source,
        table: draft.anchor.table,
        method: draft.anchor.method,
        url: draft.anchor.url,
      },
    })),
    (id) => detectorByKey.get(id),
  );
}

function applyCausalAttribution(
  ordered: CandidateDraft[],
  attribution: Map<string, CandidateAttribution> | undefined,
): void {
  if (!attribution) return;
  for (const draft of ordered) {
    const attr = attribution.get(draft.dedupeKey);
    if (!attr) continue;
    draft.causalRole = attr.causalRole;
    if (attr.rootCauseId !== undefined) draft.rootCauseId = attr.rootCauseId;
    if (attr.causes !== undefined) draft.causes = attr.causes;
    if (attr.attributionConfidence !== undefined)
      draft.attributionConfidence = attr.attributionConfidence;
    // Copied field by field like everything above it, so a new attribution
    // field is inert until it is listed HERE. That is why these two lines
    // exist: without them the contention record is born invisible and the
    // product still cannot say why a candidate is isolated.
    if (attr.isolationCause !== undefined)
      draft.isolationCause = attr.isolationCause;
    if (attr.contention !== undefined) draft.contention = attr.contention;
  }
}

function applyCausalRerank(
  ordered: CandidateDraft[],
  causalGraph?: CausalGraph,
): void {
  applyCausalAttribution(
    ordered,
    causalAttributionForDrafts(ordered, causalGraph),
  );

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

  // The chain LEADS with the member that placed it — its highest effective score — and the
  // root-first pre-order follows unchanged behind that head.
  //
  // The pre-order alone used to be the whole rule, on the guarantee that no member can precede the
  // cause it was attributed to. That guarantee is deliberately relaxed for the head, and only for
  // the head, because it costs the reader the thing the chain was ranked for. A chain is placed by
  // its strongest member (below), so when the root is a generic observation and the named failure
  // hangs off it, the pre-order hands the reader the WEAKEST statement of the incident as the
  // headline while the evidence that earned the position sits two to five rows down. Measured over
  // a frozen replay: of the sessions the ranker already ordered correctly, the first row was almost
  // always the chain's strongest member, and the incorrect ones concentrate in the shape above,
  // where a weaker root leads and the placing member sits below it. Promoting the placing member
  // costs nothing in the common case — a chain whose root
  // is already its strongest member is untouched — and in the defective case it puts the evidence
  // that named the fault first. Causality stays legible one line down: the head is MOVED, never
  // copied, so it appears exactly once, and the cause it was attributed to is the row immediately
  // after it. Ranking only; no score is mutated here.
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
    // First one wins on ties, which is the pre-order's own order and so the existing tie-break.
    let head = 0;
    for (let i = 1; i < out.length; i++)
      if (effectiveScore(out[i]!) > effectiveScore(out[head]!)) head = i;
    if (head > 0) out.unshift(...out.splice(head, 1));
    return out;
  };

  // A chain is placed by its STRONGEST member: a named failure pulls the chain that explains it up
  // to its own height rather than sinking to wherever its cause happened to rank.
  //
  // Plus two THREAD-level terms, which are properties of the incident rather than of any one
  // finding. Measured over thirty replayed sessions: with member score alone, `n_plus_one_query`
  // ranked first in twenty-five of them, across six unrelated defects — an overlay bug, a webhook
  // bug, a quantity-limit bug and a gift-card bug all led with the same performance observation.
  // The decisive signal was PRESENT in all thirty and first in five. Ordering, not capture.
  const lastInteractionT = lastUserInteractionTime(causalGraph);
  const chains = [...members.entries()].map(([topKey, chainMembers]) => ({
    top: byKey.get(topKey)!,
    score:
      Math.max(...chainMembers.map(effectiveScore)) +
      threadWeight(chainMembers, lastInteractionT),
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

const REPEATED_CLICK_COUNT = 3;
const REPEATED_CLICK_WINDOW_MS = 3_000;
const REPEATED_CLICK_QUIET_WINDOW_MS = 3_000;

interface ClickTargetIdentity {
  key: string;
  signature?: string;
}

/**
 * The stable identity already captured for an interaction. `d.el.sig` is the
 * key written to signatures.json. A structural path is the next safest
 * legacy value. Native target descriptors use only their stable identity
 * fields, never bounds or a generated id.
 */
function clickTargetIdentity(event: BugEvent): ClickTargetIdentity | undefined {
  const el = isRecord(event.d.el) ? event.d.el : undefined;
  const signature = safeText(el?.sig, 400);
  if (signature) return { key: `sig:${signature}`, signature };

  const elementPath = safeText(el?.path, 400);
  if (elementPath) return { key: `path:${elementPath}` };

  const target = targetForEvent(event);
  if (!target) return undefined;

  const identityFields = ["testID", "accessibilityId", "ancestryHash"] as const;
  const identity = identityFields
    .map((field) => [field, safeText(target[field], 240)] as const)
    .filter(([, value]) => value !== undefined);
  if (identity.length === 0) return undefined;

  return { key: `target:${JSON.stringify(identity)}` };
}

/**
 * Evidence that means the repeated activation was not dead. This is
 * intentionally broader than the detector's headline: an absence-based
 * signal should yield to any recorded indication that the page or its state
 * moved, even when that indication has its own detector.
 */
function isRepeatedClickConsequenceKind(event: BugEvent): boolean {
  return (
    event.k === "nav" ||
    event.k === "navigation" ||
    event.k === "net.req" ||
    event.k === "net.res" ||
    event.k === "net.err" ||
    event.k === "net.sse" ||
    event.k === "net.ws" ||
    event.k === "inp" ||
    event.k === "view-snapshot" ||
    event.k === "snap" ||
    event.k.startsWith("dom.") ||
    event.k.startsWith("state.") ||
    event.k.startsWith("ui.") ||
    event.k.startsWith("db.") ||
    event.k.startsWith("backend.req.") ||
    event.k === "backend.http" ||
    event.k === "con" ||
    event.k === "err" ||
    event.k === "rej" ||
    event.k === "probe.error"
  );
}

function graphRequestIdMatches(
  nodeRequestId: string | undefined,
  eventRequestId: string | undefined,
  graph: CausalGraph,
): boolean {
  if (!nodeRequestId || !eventRequestId) return false;
  return (
    nodeRequestId === eventRequestId ||
    graph.requestIdAliases?.[eventRequestId] === nodeRequestId
  );
}

function requestNodeForEvent(
  event: BugEvent,
  graph: CausalGraph,
): { id: string; requestId?: string } | undefined {
  const requestId = requestIdForEvent(event);
  const browserId = networkRequestId(event.d.id);
  return graph.nodes.find(
    (node) =>
      node.kind === "net.req" &&
      (node.t === event.t ||
        graphRequestIdMatches(node.requestId, requestId, graph) ||
        (browserId !== undefined && node.id.endsWith(`:b=${browserId}`))),
  );
}

function requestIdsInitiatedByClicks(
  clicks: BugEvent[],
  graph: CausalGraph | undefined,
): Set<string> | undefined {
  if (!graph || graph.nodes.length === 0) return undefined;
  const clickNodeIds = new Set(
    graph.nodes
      .filter(
        (node) =>
          node.kind === "user.click" &&
          clicks.some((click) => click.t === node.t),
      )
      .map((node) => node.id),
  );
  if (clickNodeIds.size === 0) return new Set();

  const requestNodeIds = new Set(
    graph.edges
      .filter(
        (edge) =>
          edge.kind === "interaction" && clickNodeIds.has(edge.from),
      )
      .map((edge) => edge.to),
  );
  const initiatedIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!requestNodeIds.has(node.id)) continue;
    initiatedIds.add(node.id);
    if (node.requestId) initiatedIds.add(node.requestId);
  }
  return initiatedIds;
}

function isRepeatedClickConsequence(
  event: BugEvent,
  firstClickT: number,
  lastClickT: number,
  quietUntil: number,
  initiatedRequestIds: Set<string> | undefined,
  graph: CausalGraph | undefined,
): boolean {
  if (event.t < firstClickT || event.t > quietUntil) return false;
  if (!isRepeatedClickConsequenceKind(event)) return false;

  if (event.k === "net.req" || event.k === "net.res" || event.k === "net.err") {
    if (initiatedRequestIds === undefined) return true;
    const requestId = requestIdForEvent(event);
    if (requestId && initiatedRequestIds.has(requestId)) return true;
    const requestNode = requestNodeForEvent(event, graph!);
    return requestNode !== undefined && initiatedRequestIds.has(requestNode.id);
  }

  if (event.k.startsWith("db.") || event.k.startsWith("backend.req.")) {
    if (initiatedRequestIds === undefined) return true;
    const requestId = safeText(event.d.requestId, 120);
    return requestId !== undefined && initiatedRequestIds.has(requestId);
  }

  // DOM, state, UI and runtime signals have no stable cross-plane request id.
  // Their position after the target's activations is the available evidence.
  return event.t > lastClickT || event.k === "nav" || event.k === "navigation";
}

function addRepeatedClickCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  causalGraph?: CausalGraph,
): void {
  const clicksByTarget = new Map<
    string,
    { identity: ClickTargetIdentity; clicks: BugEvent[] }
  >();
  for (const event of events) {
    if (event.k !== "clk") continue;
    const identity = clickTargetIdentity(event);
    if (!identity) continue;
    const entry = clicksByTarget.get(identity.key) ?? { identity, clicks: [] };
    entry.clicks.push(event);
    clicksByTarget.set(identity.key, entry);
  }

  for (const { identity, clicks } of clicksByTarget.values()) {
    clicks.sort((a, b) => a.t - b.t);
    let start = 0;
    let end = 0;
    while (start < clicks.length) {
      const first = clicks[start];
      while (
        end < clicks.length &&
        clicks[end].t - first.t <= REPEATED_CLICK_WINDOW_MS
      )
        end++;
      const groupLength = end - start;
      if (groupLength < REPEATED_CLICK_COUNT) {
        start++;
        if (end < start) end = start;
        continue;
      }

      const last = clicks[end - 1];
      const quietUntil = last.t + REPEATED_CLICK_QUIET_WINDOW_MS;
      const initiatedRequestIds = requestIdsInitiatedByClicks(
        clicks.slice(start, end),
        causalGraph,
      );
      const hasConsequence = events.some((event) =>
        isRepeatedClickConsequence(
          event,
          first.t,
          last.t,
          quietUntil,
          initiatedRequestIds,
          causalGraph,
        ),
      );
      if (hasConsequence) {
        start = end;
        continue;
      }

      const label = elementLabel(first);
      drafts.push({
        detector: "repeated_clicks",
        title: `Repeated clicks on ${titleElementLabel(first)} had no recorded consequence`,
        severity: "low",
        score: 45,
        confidence: "low",
        anchor: removeUndefined({
          t: first.t,
          offsetMs:
            offsetForEvent(first) ?? offsetFromStart(first.t, index.start),
          route: routeAt(index.navs ?? [], first.t),
          elementSignature: scrubText(identity.signature, 240),
          target: targetForEvent(first),
          elementLabel: scrubText(label, 160),
          message:
            `${groupLength} clicks within ${REPEATED_CLICK_WINDOW_MS / 1000}s; ` +
            `no navigation, request, DOM, or recorded state consequence within ` +
            `${REPEATED_CLICK_QUIET_WINDOW_MS / 1000}s of the last click`,
        }),
        // The group spans from the first click to the last; the anchor names the first. Without
        // this the finding reads as having ended at its own start, and thread ranking treats a
        // sequence the user was still performing as something they had moved past.
        lastT: last.t,
        dedupeKey: `repeat:${identity.key}:${first.t}`,
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
  outcomeIds: Set<string>,
  drafts: CandidateDraft[],
): void {
  const sessionEnd = finiteNumber(index.end) ?? 0;
  for (const req of requests.values()) {
    // A request with a net.err settled without an HTTP response. It is not pending, and emitting
    // this candidate beside network_error turns one failed operation into two misleading signals.
    if (outcomeIds.has(req.id)) continue;
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

function attachFailureRecovery(
  drafts: CandidateDraft[],
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  requests: Map<string, RequestInfo>,
): void {
  const failures = collectFailureOperations(events, index, requests);
  const successes = collectSuccessfulOperations(events, index, requests);
  const sessionEnd = sessionEndOf(events, index);

  for (const draft of drafts) {
    const failure = failureForDraft(draft, failures);
    if (!failure) continue;
    const key = operationKey(failure.method, failure.url);
    if (!key) {
      draft.recovery = {
        status: "unknown",
        reason: "operation_not_identified",
      };
      continue;
    }

    const recovered = successes
      .filter((success) => success.key === key && success.t > failure.t)
      .sort((a, b) => a.t - b.t)[0];
    if (recovered) {
      draft.recovery = {
        status: "recovered",
        afterMs: Math.max(0, Math.round(recovered.t - failure.t)),
      };
      // A failure that demonstrably recovered is still evidence, but should not outrank an
      // operation that remained broken. This applies to every failure detector using this helper.
      draft.severity = lowerSeverity(draft.severity);
      draft.score = Math.min(draft.score, RECOVERED_FAILURE_SCORE_CEILING);
    } else if (sessionEnd !== undefined && sessionEnd > failure.t) {
      draft.recovery = { status: "not_recovered" };
    } else {
      draft.recovery = { status: "unknown", reason: "session_ended" };
    }
  }
}

function collectFailureOperations(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  requests: Map<string, RequestInfo>,
): OperationObservation[] {
  const failures: OperationObservation[] = [];
  const add = (observation: OperationObservation): void => {
    failures.push({
      ...observation,
      key: operationKey(observation.method, observation.url),
    });
  };

  for (const event of events) {
    if (event.k === "net.err") {
      const request = requests.get(networkRequestId(event.d.id) ?? "");
      add({
        t: event.t,
        requestId: requestIdForEvent(event),
        method:
          safeText(event.d.method, 20) ??
          safeText(event.d.m, 20) ??
          request?.method,
        url: safeText(event.d.url, 400) ?? request?.url,
      });
      continue;
    }
    if (event.k !== "net.res") continue;
    const status = finiteNumber(event.d.st);
    if (status === undefined || status < 400) continue;
    const request = requests.get(networkRequestId(event.d.id) ?? "");
    add({
      t: event.t,
      requestId: requestIdForEvent(event),
      method:
        safeText(event.d.method, 20) ??
        safeText(event.d.m, 20) ??
        request?.method,
      url: safeText(event.d.url, 400) ?? request?.url,
    });
  }

  // Index entries survive event truncation, so they are also authoritative failure observations.
  for (const failed of index.failedReqs ?? []) {
    add({
      t: failed.t,
      requestId: requestIdForValue(failed),
      method: failed.m,
      url: failed.url,
    });
  }
  for (const entry of index.networkErrors ?? []) {
    add({
      t: entry.t,
      requestId: requestIdForValue(entry),
      method: entry.method ?? entry.m,
      url: entry.url,
    });
  }

  const backendSpans = collectBackendRequestSpans(events);
  for (const event of events) {
    if (
      event.k !== "backend.req.error" &&
      event.k !== "backend.req.end" &&
      event.k !== "backend.uncaught"
    )
      continue;
    const requestId = safeText(event.d.requestId, 120);
    const span = requestId
      ? backendSpans.find((candidate) => candidate.requestId === requestId)
      : backendRequestSpanAt(backendSpans, event.t);
    const status =
      finiteNumber(event.d.statusCode) ??
      (isRecord(event.d.error)
        ? finiteNumber(event.d.error.statusCode)
        : undefined) ??
      span?.status;
    if (event.k === "backend.req.end" && (status ?? 0) < 400) continue;
    if (event.k === "backend.uncaught" && span === undefined) continue;
    const url =
      safeText(event.d.pathname, 400) ??
      safeText(event.d.route, 400) ??
      span?.pathname ??
      span?.route;
    add({
      t: event.t,
      requestId: requestId ?? span?.requestId,
      method: safeText(event.d.method, 20) ?? span?.method,
      url,
    });
  }

  return failures;
}

function collectSuccessfulOperations(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  requests: Map<string, RequestInfo>,
): OperationObservation[] {
  const successes: OperationObservation[] = [];
  const failedRequestIds = new Set(
    (index.failedReqs ?? [])
      .map((failed) => requestIdForValue(failed))
      .filter((id): id is string => id !== undefined),
  );
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const status = finiteNumber(event.d.st);
    if (status === undefined || status < 200 || status >= 300) continue;
    const requestId = requestIdForEvent(event);
    const request = requests.get(networkRequestId(event.d.id) ?? "");
    const method =
      safeText(event.d.method, 20) ?? safeText(event.d.m, 20) ?? request?.method;
    const url = safeText(event.d.url, 400) ?? request?.url;
    const key = operationKey(method, url);
    if (
      (requestId !== undefined && failedRequestIds.has(requestId)) ||
      (index.failedReqs ?? []).some(
        (failed) =>
          failed.t === event.t &&
          failed.st === status &&
          operationKey(failed.m, failed.url) === key,
      )
    )
      continue;
    if (key) successes.push({ t: event.t, method, url, key });
  }

  // Backend-only sessions have no net.res event. A completed successful backend request is still
  // an equivalent operation, using the same method and concrete path fields as the failure.
  for (const span of collectBackendRequestSpans(events)) {
    if (span.status === undefined || span.status < 200 || span.status >= 300)
      continue;
    const url = span.pathname ?? span.route;
    const key = operationKey(span.method, url);
    if (key)
      successes.push({
        t: span.end,
        requestId: span.requestId,
        method: span.method,
        url,
        key,
      });
  }
  return successes;
}

function failureForDraft(
  draft: CandidateDraft,
  failures: OperationObservation[],
): OperationObservation | undefined {
  const requestId = draft.anchor.requestId;
  if (requestId) {
    const sameRequest = failures
      .filter(
        (failure) =>
          failure.requestId === requestId &&
          Math.abs(failure.t - draft.anchor.t) <= FAILURE_RECOVERY_MATCH_WINDOW_MS,
      )
      .sort(
        (a, b) =>
          Math.abs(a.t - draft.anchor.t) - Math.abs(b.t - draft.anchor.t),
      )[0];
    if (sameRequest) return sameRequest;
  }

  const key = operationKey(draft.anchor.method, draft.anchor.url);
  if (!key) return undefined;
  return failures.find(
    (failure) => failure.key === key && failure.t === draft.anchor.t,
  );
}

function operationKey(method: unknown, url: unknown): string | undefined {
  const normalizedMethod = safeText(method, 20)?.toUpperCase();
  const textUrl = safeText(url, 2_000);
  if (!normalizedMethod || !textUrl) return undefined;
  return `${normalizedMethod} ${normalizeUrl(textUrl)}`;
}

function sessionEndOf(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): number | undefined {
  const indexedEnd = finiteNumber(index.end);
  if (indexedEnd !== undefined) return indexedEnd;
  return events.reduce<number | undefined>(
    (latest, event) =>
      latest === undefined || event.t > latest ? event.t : latest,
    undefined,
  );
}

function lowerSeverity(
  severity: CandidateDraft["severity"],
): CandidateDraft["severity"] {
  if (severity === "critical") return "high";
  if (severity === "high") return "medium";
  if (severity === "medium") return "low";
  return "low";
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

/**
 * Crumbtrail's own console diagnostics, which are never a defect in the host
 * application.
 *
 * The SDK reports its own degraded states through the console — a refused
 * event batch, a CORS preflight that stripped the correlation headers, capture
 * disabled by Global Privacy Control — and every one of those lines is
 * prefixed with the package name. The console detectors scan raw console
 * output, so without this they turn Crumbtrail's own "capture is not working"
 * warning into a finding filed against the customer's app, at the exact moment
 * the session has the least evidence to explain it. Suppress them here rather
 * than at capture time: the events stay in the timeline, where they are the
 * true explanation for a thin bundle, and only their promotion to a candidate
 * signal is withheld.
 */
function isCrumbtrailSelfDiagnostic(message: string | undefined): boolean {
  if (!message) return false;
  return /^\s*\[crumbtrail(?:-[a-z0-9-]+)?\]/i.test(message);
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
    if (isCrumbtrailSelfDiagnostic(consoleMessage(event.d))) continue;
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

/**
 * A backend failure's headline, built from whatever actually distinguishes it.
 *
 * A request-shaped failure is named by the endpoint it happened on. A
 * request-LESS one — `backend.uncaught`, the auto-captured crash — has no
 * method and no route, and naming it by the two fields it does not have
 * produced the byte-identical line "Backend error from request" for every
 * crash in the process. Two unrelated faults (a `TypeError` reading a property
 * in one module, a thrown probe error in another) arrived as two findings a
 * reader could not tell apart, while the error class and message that separate
 * them were already computed and went only to the anchor.
 *
 * So the title falls back through what is available: error class, then the
 * first line of the message, then the status. Every input is derived from the
 * error itself, so the same crash titles identically on every run while
 * distinct crashes cannot collide. The class rides along on a routed title too
 * — one endpoint can fail in several distinct ways.
 */
function backendFailureTitle(parts: {
  status?: number;
  method?: string;
  route?: string;
  errorClass?: string;
  /** The error's headline, already stripped of stack frames by {@link errorHeadline}. */
  headline?: string;
}): string {
  const statusPart = parts.status ? `HTTP ${parts.status}` : "error";
  const detail = dropClassPrefix(parts.headline, parts.errorClass);
  if (parts.route) {
    // What the error SAID, not what class it was. A route already names the
    // endpoint, so the remaining job of the suffix is to separate one way that
    // endpoint fails from another — and `TypeError` separates far fewer of them
    // than "cannot read properties of undefined (reading 'total')" does. The
    // class stays on the anchor either way, and is still the suffix when the
    // error carried no message.
    const suffix = detail
      ? `: ${detail}`
      : parts.errorClass
        ? `: ${parts.errorClass}`
        : "";
    return `Backend ${statusPart} from ${parts.method ?? "request"} ${parts.route}${suffix}`;
  }
  const subject = parts.errorClass ?? (parts.status ? statusPart : undefined);
  if (subject && detail && detail !== subject)
    return `Backend ${subject}: ${detail}`;
  if (subject) return `Backend ${subject}`;
  if (detail) return `Backend error: ${detail}`;
  return `Backend ${statusPart} from ${parts.method ?? "request"}`;
}

/**
 * The one line of an error a title can carry: its message, without the stack.
 *
 * Two things conspired to put a whole stack in the title. `safeText` collapses
 * every run of whitespace to a single space before any of this runs, so a
 * newline-split was already a no-op by the time it was asked for; and a message
 * arriving with its frames appended (an error whose `message` IS the stack,
 * which is what a re-thrown or string-wrapped error produces) has no newline to
 * split on in the first place. The result was a 135 character title cut
 * mid-word, byte-similar for every error thrown from the same file, and unusable
 * as the scannable identity of a finding.
 *
 * So this reads the RAW value ahead of the collapse, takes its first line, and
 * then cuts at the first thing that looks like a stack frame — a `at …` run
 * followed by a `path:line:column`. The full message and the resolved frame both
 * remain on the anchor, where the stack belongs.
 */
function errorHeadline(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.split("\n")[0] ?? value;
  const withoutFrames = stripStackFrames(line);
  return scrubText(withoutFrames, max);
}

/** `at …` followed by a `path:line:column` — a stack frame, not prose. */
const STACK_FRAME_LOCATION_RE =
  /(?:[/\\]|file:|node:|https?:\/\/|<anonymous>)\S*:\d+:\d+/;
const STACK_FRAME_START_RE = /\s+at\s+(?=\S)/g;

function stripStackFrames(value: string): string {
  STACK_FRAME_START_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STACK_FRAME_START_RE.exec(value)) !== null) {
    // Bounded lookahead: one frame is well under this, and an unbounded test
    // over a very long collapsed stack is the only cost worth avoiding here.
    if (!STACK_FRAME_LOCATION_RE.test(value.slice(match.index, match.index + 400)))
      continue;
    const head = value.slice(0, match.index).trim();
    // A message that is nothing BUT frames keeps its frames: an empty title
    // says less than an ugly one.
    if (head) return head;
  }
  return value;
}

/**
 * Drops a leading `TypeError: ` from a detail that is about to be printed after
 * the very same class name. `Backend TypeError: TypeError: x is not a function`
 * spends a third of a title saying one thing twice.
 */
function dropClassPrefix(
  detail: string | undefined,
  errorClass: string | undefined,
): string | undefined {
  if (!detail) return undefined;
  if (!errorClass) return detail;
  const prefix = `${errorClass}: `;
  if (!detail.startsWith(prefix)) return detail;
  const rest = detail.slice(prefix.length).trim();
  return rest || detail;
}

/** The lowest status number that states, on its own, that something failed. */
const HTTP_FAILURE_STATUS = 400;

/**
 * A status number an error-path finding is allowed to assert.
 *
 * Error middleware runs BEFORE the error handler writes the response, so the
 * `res.statusCode` it can read at that instant is still the framework's default
 * 200 while the caller is about to receive a 500. A success status observed
 * there proves nothing about what was sent, and printing it mints a title that
 * says "HTTP 200" over a fault — a status lie the reader has no way to catch.
 *
 * A failure status is only ever set deliberately, so it stands. Anything else on
 * an error path is dropped, and the title falls back to saying "error" instead
 * of naming a number it cannot support.
 */
function assertableFailureStatus(
  status: number | undefined,
): number | undefined {
  return status !== undefined && status >= HTTP_FAILURE_STATUS
    ? status
    : undefined;
}

/** One backend request's span and identity, as the request events reported it. */
interface BackendRequestSpan {
  requestId?: string;
  start: number;
  end: number;
  method?: string;
  pathname?: string;
  route?: string;
  status?: number;
}

/**
 * The request a request-LESS backend crash happened inside.
 *
 * `backend.uncaught` is emitted by the process-level crash handler, which sees
 * an error and nothing else — no method, no route, no status. When the crash
 * happened inside a request the middleware DID record all three, on its own
 * events, and the finding still surfaced with an empty representative: the
 * reader was told the backend threw and not where. Worse, the two events
 * describing one fault keyed differently and arrived as two findings.
 *
 * The join is the request that was open at the instant of the crash, and only
 * when exactly ONE was. A server handling two requests concurrently cannot say
 * from timing alone which one crashed, and attributing the crash to the wrong
 * endpoint is worse evidence than attributing it to none — so an ambiguous
 * instant adopts nothing and the crash stays honestly request-less.
 */
function collectBackendRequestSpans(events: BugEvent[]): BackendRequestSpan[] {
  const open = new Map<string, BackendRequestSpan>();
  const spans: BackendRequestSpan[] = [];
  for (const event of events) {
    const kind = event.k;
    if (
      kind !== "backend.req.start" &&
      kind !== "backend.req.end" &&
      kind !== "backend.req.error"
    )
      continue;
    const requestId = safeText(event.d.requestId, 120);
    const key = requestId ?? `t:${event.t}`;
    if (kind === "backend.req.start") {
      const span: BackendRequestSpan = removeUndefined({
        requestId,
        start: event.t,
        end: Number.POSITIVE_INFINITY,
        method: safeText(event.d.method, 20),
        pathname: redactUrl(event.d.pathname),
        route: redactUrl(event.d.route),
      }) as BackendRequestSpan;
      open.set(key, span);
      spans.push(span);
      continue;
    }
    const span = open.get(key);
    if (!span) continue;
    span.end = event.t;
    const reported =
      finiteNumber(event.d.statusCode) ??
      (isRecord(event.d.error)
        ? finiteNumber(event.d.error.statusCode)
        : undefined);
    if (kind === "backend.req.end") {
      // The response is finished here, so what this event says is what the
      // caller received. It overrides anything read earlier in the request.
      span.status = reported ?? span.status;
      open.delete(key);
      continue;
    }
    // An error event is raised mid-request, before the status is written (see
    // assertableFailureStatus), so a success status on it is not the span's
    // outcome and is never adopted. The span deliberately stays OPEN so the end
    // event can still close it with the status the caller actually got.
    span.status = span.status ?? assertableFailureStatus(reported);
  }
  return spans;
}

function backendRequestSpanAt(
  spans: BackendRequestSpan[],
  t: number,
): BackendRequestSpan | undefined {
  let found: BackendRequestSpan | undefined;
  for (const span of spans) {
    if (span.start > t || span.end < t) continue;
    if (found) return undefined;
    found = span;
  }
  return found;
}

/** A backend error that names a fault: the loudest thing a session can carry. */
const BACKEND_ERROR_SCORE = 90;

/**
 * A backend `console.error` that names no fault.
 *
 * Level with the browser `console_error` detector (58) on purpose: worth
 * reading, never the answer.
 */
const BACKEND_CONSOLE_NOTICE_SCORE = 58;

/** Words a line reaches for when it is reporting a fault rather than narrating. */
const BACKEND_FAULT_TEXT =
  /\b(error|exception|failed|failing|failure|fatal|crash(?:ed|ing)?|panic|unhandled|uncaught|rejected|timed out|timeout|refused|denied|unavailable|unreachable|corrupt\w*|cannot|can't|could not|couldn't|unable to|invalid|missing)\b/i;

/**
 * Whether a captured backend error names a fault, or is just a log line.
 *
 * `backend.req.error` and a real process crash are events: the framework or the
 * runtime raised them because something went wrong, and they stay high on their
 * own kind. A backend `console.error` is neither — it is a log CALL, and an
 * application author reaches for the same call for a retried fetch, a recovered
 * cache miss, and a genuine fault alike. Ranking every one of them at the top of
 * a session hands the loudest finding to whichever log function somebody typed,
 * so a handled, retried, recovered condition outranks the fault that actually
 * broke the request.
 *
 * So a console line is tiered by what it says, the way the structured warn/error
 * levels already are (see BACKEND_LOG_WARN_SCORE). It stays high when it carries
 * the marks of a fault — an Error object, which the collector keeps the stack and
 * real class of, or text that names one. A bare informational line drops to the
 * console tier instead of being an automatic high.
 */
export function isFaultNamingBackendError(
  event: BugEvent,
  error: Record<string, unknown> | undefined,
): boolean {
  if (event.k !== "backend.uncaught") return true;
  // uncaughtException / unhandledRejection: the runtime raised it, not an author.
  if (safeText(event.d.source, 40) !== "console.error") return true;
  if (!error) return false;
  // The collector only carries a stack when an actual Error was logged; a
  // console.error of loose strings never has one.
  if (safeText(error.stack, 4000) !== undefined) return true;
  const name = safeText(error.name, 80);
  // "Error" is also the collector's fallback name for a plain string, so it
  // proves nothing on its own; any other error class was a real thrown value.
  if (name && name !== "Error" && /error|exception/i.test(name)) return true;
  const message = safeText(error.message, 400);
  return message !== undefined && BACKEND_FAULT_TEXT.test(message);
}

function addBackendErrorCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const spans = collectBackendRequestSpans(events);
  // The finished span for a request, by id: an error event raised inside a
  // request can read the status that request ended with instead of the default
  // its own middleware saw.
  const spanById = new Map<string, BackendRequestSpan>();
  for (const span of spans)
    if (span.requestId) spanById.set(span.requestId, span);
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
    // A crash the process-level handler reported carries no request context of
    // its own. When exactly one request was open at that instant, the
    // middleware's own record of it supplies the missing where — including the
    // correlation id, which makes the crash and the request error dedupe into
    // one finding instead of arriving as two descriptions of one fault.
    const eventRequestId = safeText(event.d.requestId, 120);
    const enclosing =
      event.k === "backend.uncaught"
        ? backendRequestSpanAt(spans, event.t)
        : event.k === "backend.req.error" && eventRequestId
          ? spanById.get(eventRequestId)
          : undefined;
    const reportedStatus = finiteNumber(event.d.statusCode);
    const errorStatus = finiteNumber(error?.statusCode);
    // An end event states the finished response, so it is read straight. An
    // error event is read before the status was written, so every source it can
    // offer is filtered through assertableFailureStatus and each is tried in
    // turn: the error's own declared status, then the status the request
    // actually finished with, then the middleware's pre-finalization reading.
    // When none of them names a failure, the finding says "error" and asserts no
    // number rather than claiming the default 200 the caller never received.
    const status = isEnd
      ? (reportedStatus ?? errorStatus ?? enclosing?.status)
      : (assertableFailureStatus(errorStatus) ??
        assertableFailureStatus(enclosing?.status) ??
        assertableFailureStatus(reportedStatus));
    const requestId = eventRequestId ?? enclosing?.requestId;

    let detector: string;
    let severity: CandidateDraft["severity"];
    let score: number;
    let confidence: CandidateDraft["confidence"] = "high";
    if (isError) {
      detector = "backend_request_error";
      if (isFaultNamingBackendError(event, error)) {
        severity = "high";
        score = BACKEND_ERROR_SCORE;
      } else {
        severity = "medium";
        score = BACKEND_CONSOLE_NOTICE_SCORE;
        confidence = "medium";
      }
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

    const method = safeText(event.d.method, 20) ?? enclosing?.method;
    // The concrete path first, the framework's route pattern only as a fallback.
    // A title reading "POST /:id/run" names five different endpoints at once, and
    // the same value keys the dedupe below, so distinct failing endpoints used to
    // collapse into one finding. `pathname` is on the same event.
    const pathname = redactUrl(event.d.pathname) ?? enclosing?.pathname;
    const routePattern = redactUrl(event.d.route) ?? enclosing?.route;
    const route = pathname ?? routePattern;
    const errorCode = safeText(error?.code, 160) ?? safeText(error?.name, 160);
    const message = scrubText(error?.message, 220);

    drafts.push({
      detector,
      title: backendFailureTitle({
        status,
        method,
        route: titleUrl(route),
        errorClass: safeText(error?.name, 80) ?? safeText(error?.code, 80),
        headline: errorHeadline(error?.message, 100),
      }),
      severity,
      score,
      confidence,
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route,
        url: route,
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

/**
 * A statement the application issued and the database REFUSED.
 *
 * The invariant, and it names no application: a request that asked the database to do something
 * and was told no did not do the thing it reported doing. That is a fault of the statement, not of
 * the tooling, and every field of the finding comes from the observable itself — the engine, the
 * operation, the table, the value-free statement shape, the database's own error code and the
 * driver's error class, all correlated to the request they happened inside.
 *
 * Why this is a CANDIDATE and not only a rendered row: `db.error` was collected and shown to the
 * reader as `databaseErrors`, and nothing that produces the ranked opinion could see it. So an
 * incident whose root cause is stated verbatim by a failing statement was ranked entirely by
 * per-detector severity constants belonging to whatever else happened to fire — the failing
 * statement could not promote anything, however decisive it was.
 *
 * Deliberately NOT the twin of `db_mutation`: that detector says a row changed. This one says a
 * row did not, which is why it carries its own node kind rather than borrowing the write plane's.
 */
function addDbErrorCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "db.error") continue;

    const requestId = safeText(event.d.requestId, 120);
    const op = safeText(event.d.op, 20) ?? "other";
    const table = safeText(event.d.table, 200);
    // The same treatment `buildDatabaseErrors` gives it: bounded, otherwise unchanged. The value
    // was made value-free by `normalizeStatementShape` at capture, and re-deriving that judgement
    // here would produce a second opinion about a string the reader already sees.
    const statementShape = safeText(event.d.shape, 400);
    // The database's own code first — a closed vocabulary — and the driver's error class name
    // only when the driver reported no code. Never a message: that is where values travel.
    const code = safeText(event.d.code, 64);
    const errorCode = code ?? safeText(event.d.errorName, 120);
    const subject = table ? `on ${table}` : "statement";
    // `other` is the op vocabulary's "did not parse to one of the known verbs". Printing it reads
    // as a claim about the statement; omitting it says the same thing without the false note. The
    // driver's error CLASS is omitted from the title for the same reason — `Error` names nothing —
    // while both stay on the anchor, where a reader can see exactly what was and was not reported.
    const verb = op === "other" ? "" : `${op} `;

    drafts.push({
      detector: "db_statement_failed",
      title:
        `Database ${verb}${subject} was refused${code ? ` (${code})` : ""}`.trim(),
      severity: "high",
      // Level with `backend_request_error`, on purpose. A refused statement is at least as
      // decisive as the request failure it usually produces, and claiming MORE would be an
      // ordering opinion about detectors this change did not measure.
      score: 90,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        table,
        statementShape,
        errorCode,
        // The engine name, matching what every other db-plane detector writes here.
        source: normalizeDbEngine(event.d.engine),
      }),
      // Keyed on the request and what was attempted, so one statement retried inside a request
      // collapses while two different failing statements in it stay two findings. Falls back to
      // the event time when the capture carried no request id, mirroring the backend path.
      dedupeKey: `dberror:${requestId ?? event.t}:${op}:${table ?? ""}:${statementShape ?? ""}`,
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
 * Failed requests that had no captured consequence, keyed by browser network id.
 * Shared by the filtering pass and by error-moment collection: a client error
 * that the app consumed is not an error a nearby database write should be graded
 * against.
 */
function consumedClientErrorRequestIds(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): Set<string> {
  const consumed = new Set<string>();
  for (const failed of index.failedReqs ?? []) {
    const id = requestIdForValue(failed);
    if (id === undefined) continue;
    if (
      isConsumedClientError(
        {
          t: failed.t,
          status: failed.st,
          method: failed.m,
          url: failed.url,
        },
        events,
      )
    )
      consumed.add(id);
  }
  return consumed;
}

function collectErrorMoments(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): ErrorMoment[] {
  const moments: ErrorMoment[] = [];
  const consumed = consumedClientErrorRequestIds(events, index);

  for (const event of events) {
    if (
      event.k === "net.res" &&
      finiteNumber(event.d.st) !== undefined &&
      (finiteNumber(event.d.st) ?? 0) >= 400
    ) {
      // A 4xx with no captured consequence is an outcome, not a fault, so a
      // write that happens to sit beside it is not thereby suspicious.
      if (
        isConsumedClientError(
          {
            t: event.t,
            status: finiteNumber(event.d.st),
            method: safeText(event.d.m, 20) ?? safeText(event.d.method, 20),
            url: safeText(event.d.url, 400),
          },
          events,
        )
      )
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
    if (id !== undefined && consumed.has(id)) continue;
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

/** Case- and separator-insensitive field key, so `dueDate` and `due_date` are one name. */
function fieldNameKey(name: string): string {
  return name.replace(/[_\-\s]/g, "").toLowerCase();
}

/** Every field name a request body mentions, at any nesting depth, normalized. */
function bodyFieldNames(body: unknown): Set<string> {
  const names = new Set<string>();
  for (const scope of collectObjectScopes(body)) {
    for (const key of Object.keys(scope)) names.add(fieldNameKey(key));
  }
  return names;
}

/** True for the empty end of a clear: null, undefined, or the empty string. */
function isClearedValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * db_unrequested_clear: a partial update destroyed a column the request never
 * named.
 *
 * The real case: a task form loaded before another user saved a description,
 * then PATCHed `{"status":"in_progress"}`. The route wrote the whole row back
 * from its stale model, so `tasks.description` went from
 * 'Acceptance criteria written by Alice' to null in the same statement. The
 * write succeeds, the response is 200, and the row is internally consistent —
 * the data loss is visible only by reading the request body next to the diff.
 * This is the shape of every lost-update bug, and no existing detector sees it:
 * `db_field_divergence` and `db_delta_mismatch` compare database rows to each
 * other, and `db_client_supplied_value` looks at what a body PUT IN, not at
 * what a body never asked to take out.
 *
 * Silent on ambiguity, by these guards:
 *  - body and diff must share a request id, and the body must parse as JSON —
 *    a redacted or opaque body cannot establish what was not named;
 *  - the diff must be an update carrying a `before` snapshot. An insert clears
 *    nothing, and without `before` there is no clear to observe;
 *  - the column must go from a non-empty value to empty. A column that merely
 *    changed (a counter, a server-computed status) is the ordinary business of
 *    a write;
 *  - identity and clock columns are excluded — a route rewriting `updated_at`
 *    without being asked is correct behavior;
 *  - the body must name at least one column the written row actually HAS.
 *    That is what makes this a partial update of the row the request
 *    addressed, rather than a server-side lifecycle write (a lock released, an
 *    error message reset) that merely shares a request id. Deliberately NOT
 *    "a named column must have CHANGED": in the captured case `status` was
 *    already `in_progress`, so the write's only effect was the data loss —
 *    the purest form of the bug, and the form that guard would have missed.
 */
function addUnrequestedClearCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  mutatingRequests: Map<string, CorrelatedRequest>,
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    const request = mutatingRequests.get(requestId);
    if (!request) continue;
    const parsed = parseStructuredBody(request.body);
    if (parsed === undefined) continue;
    const named = bodyFieldNames(parsed);
    if (named.size === 0) continue;

    for (const diff of diffs) {
      if (safeText(diff.d.op, 20)?.toLowerCase() !== "update") continue;
      const table = safeText(diff.d.table, 200);
      const after = diff.d.after;
      const before = diff.d.before;
      if (!table || !isRecord(after) || !isRecord(before)) continue;

      const cleared: string[] = [];
      const addressed: string[] = [];
      for (const [field, value] of Object.entries(after)) {
        if (named.has(fieldNameKey(field))) {
          addressed.push(field);
          continue;
        }
        if (isIdentityOrClockField(field)) continue;
        const priorValue = before[field];
        if (isClearedValue(value) && !isClearedValue(priorValue)) {
          cleared.push(field);
        }
      }
      // The request names nothing this row has, so it did not address this row.
      if (addressed.length === 0 || cleared.length === 0) continue;

      for (const field of cleared) {
        drafts.push({
          detector: "db_unrequested_clear",
          title: `Unrequested data loss: ${table}.${field} cleared by a request that only named ${addressed.join(", ")}`,
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
              `${request.method} ${request.url ?? ""} named ${addressed.join(", ")}; the same update also emptied ${table}.${field}, which the request never mentioned (was ${JSON.stringify(before[field])}) (request ${requestId})`.trim(),
            source: normalizeDbEngine(diff.d.engine),
          }),
          dedupeKey: `dbunreqclear:${requestId}:${table}:${field}`,
        });
      }
    }
  }
}

// ─── Response-plane invariant detectors (status ↔ headers ↔ body) ───
//
// These read a single net.res, or a net.res against the db.diff rows of the
// same request. Every one of them fires on a 2xx: the family they exist for is
// the response that reports success while contradicting itself.

/** Lowercased header lookup over a net.* event's `hdrs` record. */
function headerValue(event: BugEvent, name: string): string | undefined {
  const hdrs = event.d.hdrs;
  if (!isRecord(hdrs)) return undefined;
  for (const [key, value] of Object.entries(hdrs)) {
    if (key.toLowerCase() === name) return safeText(value, 400);
  }
  return undefined;
}

/** The media type without parameters: "text/csv; charset=utf-8" → "text/csv". */
function mediaType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const base = contentType.split(";")[0]?.trim().toLowerCase();
  return base || undefined;
}

/**
 * Content types that promise a downloadable document. Deliberately excludes
 * application/json and text/html: an empty JSON body or an empty HTML fragment
 * is ordinary, and a 200 serving one is not evidence of anything.
 */
const DOCUMENT_MEDIA_TYPE =
  /^(text\/csv|text\/tab-separated-values|application\/pdf|application\/zip|application\/gzip|application\/x-tar|application\/octet-stream|application\/vnd\.(ms-excel|ms-word|ms-powerpoint|openxmlformats-officedocument\..+|oasis\.opendocument\..+))$/;

/** Media types whose payload is binary and can never legitimately be a JSON document. */
const BINARY_MEDIA_TYPE =
  /^(application\/pdf|application\/zip|application\/gzip|application\/x-tar|image\/|audio\/|video\/|application\/vnd\.(ms-excel|ms-word|ms-powerpoint|openxmlformats-officedocument\..+|oasis\.opendocument\..+))/;

/**
 * download_empty_body: a 2xx served a document content type with nothing in it.
 *
 * The real case: an export route caught its own warnings, logged them, and
 * returned `res.status(200).send("")`. The browser downloads a 0-byte CSV, the
 * network panel shows green, and the user reports "the export is broken" with
 * nothing to attach. The contradiction is entirely inside one response —
 * `200`, `content-type: text/csv`, `content-length: 0`.
 *
 * Silent on: non-2xx (already flagged elsewhere), 204/205/304 (empty BY
 * DEFINITION), HEAD requests (a body is not expected), JSON and HTML (an empty
 * one is ordinary), and any response whose length cannot be read.
 */
function addEmptyDownloadCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  requestById: Map<string, RequestInfo>,
): void {
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const status = finiteNumber(event.d.st);
    if (status === undefined || status < 200 || status >= 300) continue;
    // A body is not expected for these, so its absence says nothing.
    if (status === 204 || status === 205) continue;
    const type = mediaType(headerValue(event, "content-type"));
    if (!type || !DOCUMENT_MEDIA_TYPE.test(type)) continue;
    // Header values are always strings on the wire, so this must be the
    // coercing parse — `finiteNumber` rejects "0" and silences the detector.
    const length = toFiniteNumber(headerValue(event, "content-length"));
    if (length === undefined || length > 0) continue;

    const transportId = networkRequestId(event.d.id);
    const req = transportId ? requestById.get(transportId) : undefined;
    if (req?.method && req.method.toUpperCase() === "HEAD") continue;
    const requestId = safeText(event.d.requestId, 120);

    drafts.push({
      detector: "download_empty_body",
      title:
        `Empty download: HTTP ${status} served ${type} with content-length 0${req?.url ? ` from ${titleUrl(req.url) ?? ""}` : ""}`.trim(),
      severity: "high",
      score: 78,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        method: req?.method,
        url: redactUrl(req?.url),
        status,
        message:
          `${req?.method ?? "GET"} ${redactUrl(req?.url) ?? ""} returned ${status} with content-type ${type} and an empty body — the request succeeded and delivered nothing`.trim(),
      }),
      // Keyed on the endpoint, not the request: a route that serves empty
      // downloads does it every time, and N copies of one finding is noise.
      dedupeKey: `emptydownload:${redactUrl(req?.url) ?? requestId ?? event.t}:${type}`,
    });
  }
}

/**
 * content_type_body_mismatch: the response declares a binary document and
 * ships JSON.
 *
 * The real case: an `.xlsx` export route never built a workbook — it fell
 * through to `res.json(...)` while the content type had already been set to the
 * spreadsheet MIME. Every client either downloads a corrupt file or renders
 * nothing, and the response is a 200 the whole way.
 *
 * Silent unless the declared type is unambiguously binary AND the captured body
 * parses as JSON. A redacted or opaque body proves nothing, and a JSON body
 * under a JSON or text content type is correct.
 */
function addContentTypeBodyMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  requestById: Map<string, RequestInfo>,
): void {
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const status = finiteNumber(event.d.st);
    if (status === undefined || status < 200 || status >= 300) continue;
    const type = mediaType(headerValue(event, "content-type"));
    if (!type || !BINARY_MEDIA_TYPE.test(type)) continue;
    if (parseStructuredBody(event.d.body) === undefined) continue;

    const transportId = networkRequestId(event.d.id);
    const req = transportId ? requestById.get(transportId) : undefined;
    const requestId = safeText(event.d.requestId, 120);

    drafts.push({
      detector: "content_type_body_mismatch",
      title:
        `Content type lies: response declared ${type} but the body is JSON${req?.url ? ` from ${titleUrl(req.url) ?? ""}` : ""}`.trim(),
      severity: "high",
      score: 80,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        method: req?.method,
        url: redactUrl(req?.url),
        status,
        message:
          `${req?.method ?? "GET"} ${redactUrl(req?.url) ?? ""} returned ${status} with content-type ${type}, but the captured body parses as JSON — the route never produced the format it promised`.trim(),
      }),
      // Endpoint-keyed for the same reason as download_empty_body.
      dedupeKey: `ctypemismatch:${redactUrl(req?.url) ?? requestId ?? event.t}:${type}`,
    });
  }
}

/** Response fields that report how many rows a mutation affected. */
const AFFECTED_COUNT_FIELD =
  /^(updated|modified|affected|changed|deleted|removed|inserted|created)(_?(count|rows|records|items))?$/i;

/**
 * response_count_mismatch: the response reports how many rows it changed, and
 * the database changed a different number.
 *
 * The real case: a bulk status update counted the ids it was GIVEN rather than
 * the rows it actually wrote, so a request naming a deleted id reported
 * `updated: 4` while three rows changed. The caller's UI then shows four items
 * moving and one silently snaps back on the next refresh.
 *
 * Distinct from `db_delta_mismatch`, which compares a quantity in the REQUEST
 * against a numeric column's delta. This compares a count the RESPONSE
 * asserted against the number of rows that actually changed.
 *
 * Silent on ambiguity: the response must parse and name exactly one affected-
 * count field at the top level, the request must have produced at least one
 * db.diff, and every diff counted must be a write of the same operation family
 * the field names (a field called `deleted` is not evidence about updates).
 */
function addResponseCountMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  mutatingRequests: Map<string, CorrelatedRequest>,
): void {
  const diffsByRequest = dbDiffsByRequest(events);
  for (const [requestId, diffs] of diffsByRequest) {
    const request = mutatingRequests.get(requestId);
    if (!request) continue;
    const body = parseStructuredBody(request.resBody);
    if (!isRecord(body)) continue;

    // Exactly one affected-count field, read at the top level only. Two of them
    // (or one nested in an unrelated object) is ambiguous — stay silent.
    const countFields = Object.entries(body).filter(
      ([key, value]) =>
        AFFECTED_COUNT_FIELD.test(key) && toFiniteNumber(value) !== undefined,
    );
    if (countFields.length !== 1) continue;
    const [field, rawClaimed] = countFields[0];
    const claimed = toFiniteNumber(rawClaimed);
    if (claimed === undefined) continue;

    // Count only the diffs whose operation matches what the field name claims.
    const wantsDelete = /^(deleted|removed)/i.test(field);
    const wantsInsert = /^(inserted|created)/i.test(field);
    const wantedOp = wantsDelete ? "delete" : wantsInsert ? "insert" : "update";
    const actual = diffs.filter(
      (diff) => safeText(diff.d.op, 20)?.toLowerCase() === wantedOp,
    );
    if (actual.length === 0) continue;
    if (actual.length === claimed) continue;

    const anchorEvent = actual[0];
    const table = safeText(anchorEvent.d.table, 200) ?? "unknown table";
    drafts.push({
      detector: "response_count_mismatch",
      title: `Response count lies: body reported ${field}=${claimed} but ${actual.length} row${actual.length === 1 ? "" : "s"} changed in ${table}`,
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
        method: request.method,
        url: redactUrl(request.url),
        message:
          `${request.method} ${redactUrl(request.url) ?? ""} responded ${field}=${claimed}, but only ${actual.length} ${wantedOp} row${actual.length === 1 ? "" : "s"} reached ${table} (request ${requestId})`.trim(),
        source: normalizeDbEngine(anchorEvent.d.engine),
      }),
      dedupeKey: `respcount:${requestId}:${field}`,
    });
  }
}

/** Columns that carry a retry counter. */
const ATTEMPT_COLUMN = /^(attempt|attempts|try|tries|retry_count|retries)$/i;
/** Columns that carry an upstream HTTP status code. */
const HTTP_STATUS_COLUMN =
  /^(http_status|status_code|response_status|http_code|resp_status)$/i;
/** Minimum escalating attempts before a retry sequence is a loop rather than a retry. */
const MIN_RETRY_LOOP_ATTEMPTS = 3;

/**
 * retry_loop_against_success: a delivery was retried, and the status it
 * recorded each time was a success code.
 *
 * The real case: a webhook sender treated anything that was not exactly `200`
 * as a failure. The receiver answered `204`, so every delivery was retried to
 * the cap — 25 attempts and 25 duplicate deliveries downstream, all from one
 * user action, with no error anywhere. The rows say it plainly: `attempt: 1..25`,
 * `status: 'retrying'`, `http_status: 204`.
 *
 * The 2xx is what makes this decisive rather than merely noisy: retrying a 500
 * is correct behavior, and retrying a 204 is a bug in the success check. The
 * attempt count is reported alongside so the blast radius is visible without a
 * second detector.
 *
 * Silent unless one request wrote at least MIN_RETRY_LOOP_ATTEMPTS rows to one
 * table carrying both an attempt counter and a recorded 2xx status.
 */
function addRetryLoopAgainstSuccessCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    // Group by table: two unrelated retry logs in one request stay separate.
    const byTable = new Map<string, BugEvent[]>();
    for (const diff of diffs) {
      const table = safeText(diff.d.table, 200);
      if (!table || !isRecord(diff.d.after)) continue;
      const list = byTable.get(table) ?? [];
      list.push(diff);
      byTable.set(table, list);
    }

    for (const [table, rows] of byTable) {
      const attempts = new Set<number>();
      const successStatuses = new Set<number>();
      let attemptField: string | undefined;
      let statusField: string | undefined;
      let sawNonSuccess = false;

      for (const row of rows) {
        const after = row.d.after;
        if (!isRecord(after)) continue;
        for (const [field, value] of Object.entries(after)) {
          if (ATTEMPT_COLUMN.test(field)) {
            const n = toFiniteNumber(value);
            if (n !== undefined) {
              attempts.add(n);
              attemptField ??= field;
            }
          } else if (HTTP_STATUS_COLUMN.test(field)) {
            const n = toFiniteNumber(value);
            if (n === undefined) continue;
            statusField ??= field;
            if (n >= 200 && n < 300) successStatuses.add(n);
            else sawNonSuccess = true;
          }
        }
      }

      // A mixed sequence (some 5xx, some 2xx) is an ordinary retry that
      // eventually succeeded. Only an all-success sequence is the bug.
      if (sawNonSuccess) continue;
      if (attempts.size < MIN_RETRY_LOOP_ATTEMPTS) continue;
      if (successStatuses.size === 0) continue;
      if (!attemptField || !statusField) continue;

      const anchorEvent = rows[rows.length - 1];
      const highest = Math.max(...attempts);
      const statusList = [...successStatuses].sort((a, b) => a - b).join(", ");
      drafts.push({
        detector: "retry_loop_against_success",
        title: `Retry loop against a success code: ${table} recorded ${attempts.size} attempts (up to ${attemptField}=${highest}) while ${statusField} stayed ${statusList}`,
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
          message: `One request wrote ${rows.length} rows to ${table} with ${attemptField} escalating to ${highest}, every one recording ${statusField}=${statusList} — a 2xx is being treated as a failure, so each retry is a duplicate delivery (request ${requestId})`,
          source: normalizeDbEngine(anchorEvent.d.engine),
        }),
        dedupeKey: `retryloop2xx:${requestId}:${table}`,
      });
    }
  }
}

/** Minimum requests before the session's own duration distribution means anything. */
const MIN_LATENCY_SAMPLES = 8;
/** How far above the session median a request must sit to be an outlier. */
const LATENCY_OUTLIER_FACTOR = 10;
/** Absolute floor, so a 4 ms request against a 0.2 ms median is never "slow". */
const MIN_LATENCY_OUTLIER_MS = 250;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * latency_outlier: one route took an order of magnitude longer than every
 * other request in the same session.
 *
 * `slow_request` exists but has a fixed 5,000 ms floor, which is the wrong
 * instrument for the failure this catches: a quadratic query that is instant on
 * a seeded dev board and takes 788 ms on a real one. Nothing crosses 5 s until
 * the largest customer complains, and by then the shape has been in production
 * for months. Measured against the session's OWN median (1 ms here), the same
 * request is a 700× outlier and obvious.
 *
 * Scale-dependent by design, so the guards are about having a distribution
 * worth comparing to: at least MIN_LATENCY_SAMPLES requests, at least
 * LATENCY_OUTLIER_FACTOR× the median, and at least MIN_LATENCY_OUTLIER_MS in
 * absolute terms so a fast session cannot manufacture outliers out of noise.
 * Scored below the DB invariants — this is a strong lead, not a proof.
 */
function addLatencyOutlierCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  requestById: Map<string, RequestInfo>,
): void {
  const samples: { event: BugEvent; dur: number }[] = [];
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const dur = finiteNumber(event.d.dur);
    if (dur === undefined || dur < 0) continue;
    samples.push({ event, dur });
  }
  if (samples.length < MIN_LATENCY_SAMPLES) return;

  const median = medianOf(samples.map((s) => s.dur));
  // A median of 0 makes the ratio meaningless; the absolute floor carries it.
  const threshold = Math.max(
    median * LATENCY_OUTLIER_FACTOR,
    MIN_LATENCY_OUTLIER_MS,
  );

  for (const { event, dur } of samples) {
    if (dur < threshold) continue;
    // Already covered, and at a higher score, by the absolute-threshold rule.
    if (dur >= 5_000) continue;
    const transportId = networkRequestId(event.d.id);
    const req = transportId ? requestById.get(transportId) : undefined;
    const requestId = safeText(event.d.requestId, 120);
    const ratio = median > 0 ? Math.round(dur / median) : undefined;

    drafts.push({
      detector: "latency_outlier",
      title: `Latency outlier: ${Math.round(dur)} ms${ratio ? ` (${ratio}× the session median of ${Math.round(median)} ms)` : ""}${req?.url ? ` on ${titleUrl(req.url) ?? ""}` : ""}`,
      severity: "medium",
      score: 68,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        method: req?.method,
        url: redactUrl(req?.url),
        status: finiteNumber(event.d.st),
        message:
          `${req?.method ?? "GET"} ${redactUrl(req?.url) ?? ""} took ${Math.round(dur)} ms against a session median of ${Math.round(median)} ms across ${samples.length} requests — far below any absolute slow-request threshold, but an outlier against this session's own distribution`.trim(),
      }),
      dedupeKey: `latencyoutlier:${requestId ?? transportId ?? event.t}`,
    });
  }
}

/** Minimum reads of a table before "no read ever selects this column" is a pattern. */
const MIN_READS_FOR_COLUMN_SPLIT = 3;

/**
 * db_write_read_column_split: writes populate one column, reads select a
 * different one, and the column the reads DO select was left empty by the write.
 *
 * The real case: a saved-view route inserted the filter preset into
 * `filters_json` while every read selected `filters`, which the insert left
 * null. The POST returns 201 with the filters echoed straight back out of the
 * request, so the UI confirms a save that will never load. Nothing throws, and
 * a single plane shows nothing wrong — the write is fine, the reads are fine.
 *
 * This is the case `db_unrequested_clear` was wrongly claimed to cover. Nothing
 * is cleared here and the request named exactly what it wrote; the failure is
 * only visible by reading the write against LATER reads of the same table.
 *
 * Silent unless: a write left column A non-empty and sibling column B empty in
 * the same row; at least MIN_READS_FOR_COLUMN_SPLIT reads of that table
 * followed; every one of those reads selected B; and NOT ONE of them ever
 * selected A. A single read that touches A means the column is wired up
 * somewhere and this is not a split.
 */
function addWriteReadColumnSplitCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // Reads first: which columns does any read of this table ever project?
  const readColumns = new Map<string, Set<string>>();
  const readCounts = new Map<string, number>();
  for (const event of events) {
    if (event.k !== "db.read") continue;
    const table = safeText(event.d.table, 200);
    const row = event.d.row;
    if (!table || !isRecord(row)) continue;
    const set = readColumns.get(table) ?? new Set<string>();
    for (const key of Object.keys(row)) set.add(key);
    readColumns.set(table, set);
    readCounts.set(table, (readCounts.get(table) ?? 0) + 1);
  }
  if (readColumns.size === 0) return;

  const seen = new Set<string>();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    const op = safeText(event.d.op, 20)?.toLowerCase();
    if (op !== "insert" && op !== "update") continue;
    const table = safeText(event.d.table, 200);
    const after = event.d.after;
    if (!table || !isRecord(after)) continue;

    const projected = readColumns.get(table);
    const reads = readCounts.get(table) ?? 0;
    if (!projected || reads < MIN_READS_FOR_COLUMN_SPLIT) continue;

    // A column this write populated that no read of the table ever selects.
    const written = Object.entries(after).filter(
      ([field, value]) =>
        !isIdentityOrClockField(field) &&
        !isClearedValue(value) &&
        !projected.has(field),
    );
    if (written.length === 0) continue;

    // A column the reads DO select that this same write left empty. Without
    // this the rule fires on every wide table with a narrow SELECT.
    const starved = Object.keys(after).filter(
      (field) =>
        !isIdentityOrClockField(field) &&
        projected.has(field) &&
        isClearedValue(after[field]),
    );
    if (starved.length === 0) continue;

    for (const [writtenField] of written) {
      for (const readField of starved) {
        const key = `${table}:${writtenField}:${readField}`;
        if (seen.has(key)) continue;
        seen.add(key);
        drafts.push({
          detector: "db_write_read_column_split",
          title: `Write and read disagree on a column: ${table}.${writtenField} was written, but every read selects ${table}.${readField}, which this write left empty`,
          severity: "high",
          score: DB_INVARIANT_SCORE,
          confidence: "high",
          anchor: removeUndefined({
            t: event.t,
            offsetMs:
              offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
            route: routeAt(index.navs ?? [], event.t),
            requestId: safeText(event.d.requestId, 120),
            message: `The ${op} populated ${table}.${writtenField} and left ${table}.${readField} empty; ${reads} later read${reads === 1 ? "" : "s"} of ${table} selected ${readField} and never once selected ${writtenField} — the value is stored where nothing looks for it`,
            source: normalizeDbEngine(event.d.engine),
          }),
          dedupeKey: `writereadsplit:${table}:${writtenField}:${readField}`,
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
 * lost_update: one request read a row, another request wrote it, and the first
 * request later wrote the row back from the earlier read.
 *
 * This is intentionally an event-order detector. A `db.diff` before-image is
 * the database state when the UPDATE ran, not the value the application read
 * before an await, so comparing before/after images cannot establish the
 * read-modify-write shape. The successful SELECT statement and request ids can.
 *
 * It requires both requests' database events in the same analyzed event
 * stream. A reader's session cannot discover a concurrent writer whose only
 * evidence is in another user's session. It also reports the weaker observable
 * shape: the events do not expose the value held in the application's local
 * variable, so they cannot prove that the later write was derived from a stale
 * value.
 */
interface LostUpdateRead {
  event: BugEvent;
  requestId: string;
  table: string;
  keyColumns: string[];
}

function selectKeyColumns(shape: string): string[] | undefined {
  const where = /\bwhere\b([\s\S]*)/i.exec(shape)?.[1];
  if (!where || /\b(?:or|union|select|join)\b/i.test(where)) return undefined;

  const predicates = where.split(/\band\b/i);
  const columns: string[] = [];
  for (const rawPredicate of predicates) {
    const predicate = rawPredicate
      .replace(
        /\b(?:group\s+by|order\s+by|limit|offset|for\s+update)\b[\s\S]*$/i,
        "",
      )
      .replace(/[()]/g, "")
      .trim();
    const match = /^(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*=\s*\?(?:::[A-Za-z_]\w*)?$/i.exec(
      predicate,
    );
    if (!match) return undefined;
    const column = match[1].toLowerCase();
    if (columns.includes(column)) return undefined;
    columns.push(column);
  }
  return columns.length > 0 ? columns : undefined;
}

function updateValueForColumn(
  event: BugEvent,
  column: string,
): string | undefined {
  const pk = isRecord(event.d.pk) ? event.d.pk : undefined;
  const after = isRecord(event.d.after) ? event.d.after : undefined;
  const before = isRecord(event.d.before) ? event.d.before : undefined;
  const afterEntry = after
    ? Object.entries(after).find(([name]) => name.toLowerCase() === column)
    : undefined;
  const beforeEntry = before
    ? Object.entries(before).find(([name]) => name.toLowerCase() === column)
    : undefined;
  const afterValue = afterEntry ? keyValueOf(afterEntry[1]) : undefined;
  const beforeValue = beforeEntry ? keyValueOf(beforeEntry[1]) : undefined;
  const pkEntry = pk
    ? Object.entries(pk).find(([name]) => name.toLowerCase() === column)
    : undefined;
  const pkValue = pkEntry ? keyValueOf(pkEntry[1]) : undefined;
  if (
    pkValue !== undefined &&
    ((afterValue !== undefined && afterValue !== pkValue) ||
      (beforeValue !== undefined && beforeValue !== pkValue))
  )
    return undefined;
  if (pkValue !== undefined) return pkValue;
  if (
    afterValue !== undefined &&
    beforeValue !== undefined &&
    afterValue !== beforeValue
  )
    return undefined;
  return afterValue ?? beforeValue;
}

function lostUpdateRowKey(
  event: BugEvent,
  table: string,
  keyColumns: string[],
): string | undefined {
  const values = keyColumns.map((column) =>
    updateValueForColumn(event, column),
  );
  if (values.some((value) => value === undefined)) return undefined;
  return `${bareTableName(table).toLowerCase()}\u0000${keyColumns
    .map((column, index) => `${column}=${values[index]}`)
    .join(",")}`;
}

function addLostUpdateCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const reads: LostUpdateRead[] = [];
  const updates: Array<{ event: BugEvent; requestId: string; table: string }> = [];
  for (const event of events) {
    if (
      event.k === "db.statement" &&
      safeText(event.d.op, 20)?.toLowerCase() === "select"
    ) {
      const requestId = safeText(event.d.requestId, 120);
      const table = safeText(event.d.table, 200);
      const shape = safeText(event.d.shape, 500);
      const keyColumns = shape ? selectKeyColumns(shape) : undefined;
      if (requestId && table && keyColumns) {
        reads.push({ event, requestId, table, keyColumns });
      }
    }
    if (
      event.k !== "db.diff" ||
      safeText(event.d.op, 20)?.toLowerCase() !== "update"
    )
      continue;
    const requestId = safeText(event.d.requestId, 120);
    const table = safeText(event.d.table, 200);
    if (requestId && table) updates.push({ event, requestId, table });
  }

  const emitted = new Set<string>();
  for (const read of reads) {
    const ownWrites = updates.filter(
      (update) =>
        update.requestId === read.requestId &&
        sameTable(update.table, read.table) &&
        update.event.t > read.event.t,
    );
    for (const own of ownWrites) {
      const ownRow = lostUpdateRowKey(own.event, read.table, read.keyColumns);
      if (!ownRow) continue;
      const interleaved = updates.filter(
        (update) =>
          update.requestId !== read.requestId &&
          sameTable(update.table, read.table) &&
          update.event.t > read.event.t &&
          update.event.t < own.event.t &&
          lostUpdateRowKey(update.event, read.table, read.keyColumns) === ownRow,
      );
      if (interleaved.length === 0 || emitted.has(`${read.requestId}:${ownRow}`))
        continue;
      emitted.add(`${read.requestId}:${ownRow}`);
      const tableLabel = scrubText(bareTableName(read.table), 100) ?? "table";
      const otherRequests = [
        ...new Set(interleaved.map((update) => update.requestId)),
      ];
      drafts.push({
        detector: "lost_update",
        title: `Possible lost update: ${tableLabel} was written between a read and its later write`,
        severity: "high",
        score: DB_INVARIANT_SCORE,
        confidence: "medium",
        anchor: removeUndefined({
          t: own.event.t,
          offsetMs:
            offsetForEvent(own.event) ?? offsetFromStart(own.event.t, index.start),
          route: routeAt(index.navs ?? [], own.event.t),
          requestId: read.requestId,
          message:
            `Request ${read.requestId} selected ${tableLabel} by ${read.keyColumns.join(", ")} at +${Math.round(offsetFromStart(read.event.t, index.start) ?? 0)} ms, ` +
            `request${otherRequests.length === 1 ? "" : "s"} ${otherRequests.join(", ")} wrote the same row before it later wrote again. ` +
            `The captured ordering is consistent with a read-modify-write using stale state, but the value held between the SELECT and UPDATE is not captured, so this is a possible rather than proven lost update.`,
          source: normalizeDbEngine(own.event.d.engine),
        }),
        dedupeKey: `lostupdate:${read.requestId}:${ownRow}`,
      });
    }
  }
}

function sameTable(left: string, right: string): boolean {
  return bareTableName(left).toLowerCase() === bareTableName(right).toLowerCase();
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

// ─── Slow backend dependencies ──────────────────────────────────────────────
//
// The gap this closes: a span was ranked only when it FAILED (otel_span_error
// fires on statusCode ERROR or HTTP 500 and above), while both slowness rules
// read browser `net.res` events and nothing else. So a database, cache, queue
// or outbound HTTP call that took 30 seconds and then SUCCEEDED reached the
// bundle, was rendered as activity, and produced no ranked issue. The reader
// got the browser symptom and never got the dependency that caused it.
//
// Everything below reuses the two thresholds the browser plane already uses,
// deliberately: MIN_LATENCY_SAMPLES, LATENCY_OUTLIER_FACTOR,
// MIN_LATENCY_OUTLIER_MS and the 5,000 ms absolute floor. A second, different
// definition of "slow" would put two numbers in the product for one idea, and a
// reader comparing a browser finding with a backend one would be comparing two
// gradings.

/** Absolute floor at which a call is slow whatever the session looked like. Mirrors `slow_request`. */
const SLOW_SPAN_MS = 5_000;
/** Where `slow_request` stops calling it medium. Same number, same reason. */
const VERY_SLOW_SPAN_MS = 15_000;

/** OTel SpanKind, as the OTLP wire encodes it. */
const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;
const SPAN_KIND_PRODUCER = 4;
const SPAN_KIND_CONSUMER = 5;

/** Cache engines that report themselves through the database attributes. */
const CACHE_SYSTEMS = new Set([
  "redis",
  "valkey",
  "memcached",
  "hazelcast",
  "aerospike",
]);

type SpanDependencyKind = "database" | "cache" | "queue" | "HTTP" | "dependency";

/**
 * What a span calls OUT to, or undefined when the span is not a dependency call.
 *
 * The `undefined` cases carry the design decision. A SERVER span IS the request,
 * so ranking it as slow would restate whatever already reported that request as
 * slow: the browser `net.res` for the same call, ranked by `slow_request` or
 * `latency_outlier`. That is the duplicate this returns undefined to avoid. An
 * INTERNAL span is in-process work, not an infrastructure dependency, and a span
 * that names no system and declares no kind is not identifiable as either.
 */
function otelSpanDependency(
  d: Record<string, unknown>,
): SpanDependencyKind | undefined {
  const kind = finiteNumber(d.kind);
  if (kind === SPAN_KIND_SERVER) return undefined;

  const attrs = isRecord(d.attributes) ? d.attributes : {};
  if (hasOtelDbAttributes(attrs)) {
    const system = safeText(attrs["db.system"], 80)?.toLowerCase();
    const name = safeText(attrs["db.system.name"], 80)?.toLowerCase();
    return CACHE_SYSTEMS.has(system ?? "") || CACHE_SYSTEMS.has(name ?? "")
      ? "cache"
      : "database";
  }
  if (
    safeText(attrs["messaging.system"], 80) !== undefined ||
    safeText(attrs["messaging.destination.name"], 200) !== undefined ||
    kind === SPAN_KIND_PRODUCER ||
    kind === SPAN_KIND_CONSUMER
  )
    return "queue";
  if (kind !== SPAN_KIND_CLIENT) return undefined;
  if (
    safeText(attrs["http.request.method"], 20) !== undefined ||
    safeText(attrs["http.method"], 20) !== undefined ||
    safeText(attrs["url.full"], 400) !== undefined ||
    safeText(attrs["http.url"], 400) !== undefined
  )
    return "HTTP";
  // A CLIENT span that names no system is still an outbound call the service
  // waited on, which is all this rule needs to be true.
  return "dependency";
}

/**
 * `otel_slow_dependency` and `otel_dependency_latency_outlier`: a backend call
 * out to infrastructure took long enough to be the incident, and returned fine.
 *
 * Two rules over one set of spans, exactly as the browser plane has two:
 *
 *  1. Absolute. At or above {@link SLOW_SPAN_MS} the call is slow on its own
 *     terms, whatever else the session did, and at or above
 *     {@link VERY_SLOW_SPAN_MS} it is high severity. Same numbers and same
 *     severities as `slow_request`, because it is the same judgement about the
 *     same unit: wall time a user waited on.
 *  2. Relative. Below that floor, a call is only slow against its own session:
 *     at least {@link MIN_LATENCY_SAMPLES} dependency calls to compare with, at
 *     least {@link LATENCY_OUTLIER_FACTOR} times their median, and at least
 *     {@link MIN_LATENCY_OUTLIER_MS} in absolute terms so a fast session cannot
 *     manufacture an outlier from noise. Copied from `latency_outlier`, and the
 *     same guard against overlap: anything over the absolute floor is left to
 *     rule 1 rather than reported twice.
 *
 * Error spans are skipped. `otel_span_error` already ranks those, and a call
 * that failed after 30 seconds is one finding, not two.
 */
function addSlowDependencySpanCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const samples: {
    event: BugEvent;
    dur: number;
    dependency: SpanDependencyKind;
  }[] = [];
  for (const event of events) {
    if (event.k !== OTEL_SPAN_KIND) continue;
    const status = otelHttpStatus(event.d.attributes);
    if (event.d.statusCode === "ERROR" || (status ?? 0) >= 500) continue;
    const dur = finiteNumber(event.d.durationMs);
    if (dur === undefined || dur < 0) continue;
    const dependency = otelSpanDependency(event.d);
    if (!dependency) continue;
    samples.push({ event, dur, dependency });
  }
  if (samples.length === 0) return;

  const median = medianOf(samples.map((sample) => sample.dur));
  const outlierThreshold = Math.max(
    median * LATENCY_OUTLIER_FACTOR,
    MIN_LATENCY_OUTLIER_MS,
  );

  for (const { event, dur, dependency } of samples) {
    const name = scrubText(event.d.name, 160);
    const service = safeText(event.d.serviceName, 80);
    const requestId =
      safeText(event.d.traceId, 120) ?? safeText(event.d.requestId, 120);
    const spanId = safeText(event.d.spanId, 120);
    const label = name ?? `${dependency} call`;
    const suffix = service ? ` [${service}]` : "";
    const anchorBase = {
      t: event.t,
      offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
      route: routeAt(index.navs ?? [], event.t),
      requestId,
      status: otelHttpStatus(event.d.attributes),
      source: service,
      frame: spanCodeFrame(event.d),
    };

    if (dur >= SLOW_SPAN_MS) {
      drafts.push({
        detector: "otel_slow_dependency",
        title: `Slow ${dependency} call: ${Math.round(dur)} ms ${label}${suffix}`,
        severity: dur >= VERY_SLOW_SPAN_MS ? "high" : "medium",
        score: dur >= VERY_SLOW_SPAN_MS ? 78 : 64,
        confidence: "high",
        anchor: removeUndefined({
          ...anchorBase,
          message: `${label} took ${Math.round(dur)} ms and returned without an error, so nothing failed and the time was spent inside this ${dependency} call`,
        }),
        dedupeKey: `otelslowdep:${spanId ?? event.t}`,
      });
      continue;
    }

    if (samples.length < MIN_LATENCY_SAMPLES) continue;
    if (dur < outlierThreshold) continue;
    const ratio = median > 0 ? Math.round(dur / median) : undefined;
    drafts.push({
      detector: "otel_dependency_latency_outlier",
      title: `${dependency} latency outlier: ${Math.round(dur)} ms${ratio ? ` (${ratio}× the session median of ${Math.round(median)} ms)` : ""} ${label}${suffix}`,
      severity: "medium",
      score: 68,
      confidence: "medium",
      anchor: removeUndefined({
        ...anchorBase,
        message: `${label} took ${Math.round(dur)} ms against a median of ${Math.round(median)} ms across ${samples.length} backend dependency calls in this session, far below any absolute threshold but an outlier against this session's own distribution`,
      }),
      dedupeKey: `oteldeplatency:${spanId ?? event.t}`,
    });
  }
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
  addBackendOnlyExchanges(events, exchanges);
  return exchanges;
}

/**
 * Adds exchanges for requests no browser made.
 *
 * A job, a webhook, a service-to-service call or a CLI produces
 * `backend.req.start` / `backend.req.end` and never a `net.req` / `net.res`
 * pair, so every detector that reads an exchange was blind to that traffic —
 * not because the evidence was weak but because it was filed under a different
 * event kind. The backend events now carry the same `body` field the browser
 * response carries, so the join is a rename, not a new evidence source.
 *
 * A browser-observed exchange always wins: when both planes saw the same
 * correlation id the frontend view is the richer one, and it is left alone.
 */
function addBackendOnlyExchanges(
  events: BugEvent[],
  exchanges: Map<string, RequestExchange>,
): void {
  for (const event of events) {
    if (event.k !== "backend.req.start" && event.k !== "backend.req.end")
      continue;
    const id = safeText(event.d.requestId, 200);
    if (!id || exchanges.has(id)) continue;
    exchanges.set(id, {
      requestId: id,
      req: event,
      method: (safeText(event.d.method, 20) ?? "GET").toUpperCase(),
      url: safeText(event.d.url, 400),
      body: event.d.reqBody,
    });
  }
  for (const event of events) {
    if (event.k !== "backend.req.end" && event.k !== "backend.req.error")
      continue;
    const id = safeText(event.d.requestId, 200);
    if (!id) continue;
    const entry = exchanges.get(id);
    // Only fill a slot this pass created: an exchange the browser owns keeps
    // the browser's own response.
    if (!entry || (entry.req.k !== "backend.req.start" && entry.req.k !== "backend.req.end"))
      continue;
    entry.res = event;
    if (event.d.body !== undefined) entry.resBody = event.d.body;
    if (event.d.reqBody !== undefined) entry.body = event.d.reqBody;
    const reported = finiteNumber(event.d.statusCode);
    // Only the end event knows what the caller received. The error event is
    // raised before the status is written (see assertableFailureStatus), so a
    // 2xx on it would record this exchange as a success that never happened.
    entry.status =
      event.k === "backend.req.end"
        ? reported
        : (assertableFailureStatus(reported) ?? entry.status);
  }
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
  return view ? responseCollectionFromView(view) : undefined;
}

function responseCollectionFromView(
  view: ResponseBodyView,
): BodyCollection | undefined {
  if (view.data === undefined) return undefined;
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

const WRITE_READ_DIVERGENCE_SCORE = 84;
const MAX_WRITE_READ_DIVERGENCE_CANDIDATES = 20;

function isComparableScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** A shared id-like scalar is the only identity anchor accepted by this detector. */
function isWriteReadIdentityField(name: string): boolean {
  return isIdLikeField(name) || /^uuid$/i.test(name) || /(?:Uuid|UUID)$/.test(name);
}

function redactedField(event: BugEvent, field: string): boolean {
  const redaction = event.d.redaction;
  if (!isRecord(redaction) || !Array.isArray(redaction.fields)) return false;
  return redaction.fields.some((entry) => {
    if (!isRecord(entry)) return false;
    const path = safeText(entry.path, 400);
    return (
      path === "body" ||
      path?.endsWith(`.${field}`) === true ||
      path?.endsWith(`[${field}]`) === true
    );
  });
}

function renderComparedScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return JSON.stringify(truncate(redactTokenLikeString(value, "network.body").value, 180));
  }
  return String(value);
}

function isPrefixTruncation(written: string, read: string): boolean {
  if (read.length >= written.length || read.length === 0) return false;
  return (
    written.startsWith(read) ||
    (read.endsWith("\uFFFD") && written.startsWith(read.slice(0, -1)))
  );
}

/**
 * Finds a successful write/read pair using only structured payload identity.
 * It refuses route, content-type and value-only guesses, ignores fields added
 * by the server, and treats redacted or capture-truncated values as unknown.
 */
function addWriteReadDivergenceCandidates(
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const ordered = [...exchanges.values()].sort(
    (a, b) =>
      (a.res?.t ?? Number.POSITIVE_INFINITY) -
        (b.res?.t ?? Number.POSITIVE_INFINITY) ||
      a.requestId.localeCompare(b.requestId),
  );
  let emitted = 0;

  for (const write of ordered) {
    if (emitted >= MAX_WRITE_READ_DIVERGENCE_CANDIDATES) return;
    if (write.res === undefined || !isSuccessStatus(write.status)) continue;
    const written = parseStructuredBody(write.body);
    if (written === undefined) continue;
    const writtenScopes = collectObjectScopes(written);

    for (const read of ordered) {
      if (emitted >= MAX_WRITE_READ_DIVERGENCE_CANDIDATES) return;
      if (
        read.requestId === write.requestId ||
        read.res === undefined ||
        read.res.t <= write.res.t ||
        !isSuccessStatus(read.status) ||
        (isRecord(read.resBodyMeta) && read.resBodyMeta.truncated === true)
      )
        continue;
      const response =
        parseStructuredBody(read.resBody) ??
        responsePayload(read.resBody, read.resBodyMeta);
      if (response === undefined) continue;
      const responseScopes = collectObjectScopes(response);

      for (const writtenScope of writtenScopes) {
        const identities = Object.entries(writtenScope).filter(
          ([name, value]) =>
            isWriteReadIdentityField(name) &&
            isComparableScalar(value) &&
            !isRedactedValue(value) &&
            !redactedField(write.req, name),
        );
        if (identities.length === 0) continue;
        const matches = responseScopes.filter((scope) =>
          identities.some(
            ([name, value]) =>
              isComparableScalar(scope[name]) &&
              !isRedactedValue(scope[name]) &&
              !redactedField(read.res!, name) &&
              scope[name] === value,
          ),
        );
        // Repeated identities are ambiguous, so do not choose a record by position.
        if (matches.length !== 1) continue;
        const readScope = matches[0];

        for (const [field, writtenValue] of Object.entries(writtenScope)) {
          if (
            !isComparableScalar(writtenValue) ||
            isRedactedValue(writtenValue) ||
            redactedField(write.req, field)
          )
            continue;
          if (!(field in readScope)) {
            if (redactedField(read.res, field)) continue;
            drafts.push({
              detector: "write_read_divergence",
              title: `Write/read divergence on ${field}: wrote ${renderComparedScalar(writtenValue)}, but the later response omitted the field`,
              severity: "high",
              score: WRITE_READ_DIVERGENCE_SCORE,
              confidence: "high",
              anchor: removeUndefined({
                t: read.res.t,
                offsetMs:
                  offsetForEvent(read.res) ?? offsetFromStart(read.res.t, index.start),
                route: routeAt(index.navs ?? [], read.res.t),
                requestId: read.requestId,
                method: read.method,
                url: redactUrl(read.url),
                status: read.status,
                message: `A successful write supplied ${field}=${renderComparedScalar(writtenValue)}; a later successful response contained the same identity object but omitted that field`,
              }),
              dedupeKey: `writeread:${write.requestId}:${read.requestId}:${field}:missing`,
            });
            emitted += 1;
            continue;
          }
          const readValue = readScope[field];
          if (
            !isComparableScalar(readValue) ||
            isRedactedValue(readValue) ||
            redactedField(read.res, field) ||
            readValue === writtenValue
          )
            continue;
          const writtenText = renderComparedScalar(writtenValue);
          const readText = renderComparedScalar(readValue);
          const truncated =
            typeof writtenValue === "string" &&
            typeof readValue === "string" &&
            isPrefixTruncation(writtenValue, readValue);
          drafts.push({
            detector: "write_read_divergence",
            title: truncated
              ? `Read-back truncation on ${field}: wrote ${writtenText}, but the later response returned the prefix ${readText}`
              : `Write/read divergence on ${field}: wrote ${writtenText}, but the later response returned ${readText}`,
            severity: "high",
            score: WRITE_READ_DIVERGENCE_SCORE,
            confidence: "high",
            anchor: removeUndefined({
              t: read.res.t,
              offsetMs:
                offsetForEvent(read.res) ?? offsetFromStart(read.res.t, index.start),
              route: routeAt(index.navs ?? [], read.res.t),
              requestId: read.requestId,
              method: read.method,
              url: redactUrl(read.url),
              status: read.status,
              message: truncated
                ? `A successful write supplied ${field}=${writtenText}; a later successful response returned ${readText}, a shorter prefix with a replacement character, consistent with byte truncation`
                : `A successful write supplied ${field}=${writtenText}; a later successful response returned ${readText}`,
            }),
            dedupeKey: `writeread:${write.requestId}:${read.requestId}:${field}`,
          });
          emitted += 1;
        }
      }
    }
  }
}

// ─── filter_contradiction ────────────────────────────────────────────────────

/** How many response constraints one session may carry. */
const MAX_FILTER_CONTRADICTION_CANDIDATES = 5;

/**
 * A response that contradicts its own echoed constraint is a hard contradiction
 * between two values in one successful response. It sits below database
 * invariants (90) and above runtime errors (82), since no request or response
 * failed and the claim needs no second event or application schema.
 */
const FILTER_CONTRADICTION_SCORE = 84;

const NO_CONSTRAINT_SENTINELS = new Set(["*", "all", "any"]);
const DEFERRED_CONSTRAINT_WORDS = new Set([
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
  "count",
  "total",
]);

function isDeferredConstraintName(name: string): boolean {
  return columnWords(name).some((word) => DEFERRED_CONSTRAINT_WORDS.has(word));
}

function isComparableConstraintScalar(value: unknown): boolean {
  return (
    (typeof value === "string" &&
      value.length > 0 &&
      !NO_CONSTRAINT_SENTINELS.has(value) &&
      !isRedactedValue(value)) ||
    typeof value === "boolean" ||
    finiteNumber(value) !== undefined
  );
}

/**
 * Collects objects that could echo constraints, excluding the selected result
 * collection and everything inside its rows. This keeps a returned row from
 * being mistaken for the response constraint object.
 */
function collectConstraintObjects(
  value: unknown,
  collectionItems: unknown[],
  out: Record<string, unknown>[] = [],
  depth = 0,
): Record<string, unknown>[] {
  if (depth > MAX_BODY_SCOPE_DEPTH) return out;
  if (Array.isArray(value)) {
    if (value === collectionItems) return out;
    for (const item of value)
      collectConstraintObjects(item, collectionItems, out, depth + 1);
    return out;
  }
  if (!isRecord(value) || isRedactedPlaceholder(value)) return out;
  out.push(value);
  for (const inner of Object.values(value)) {
    if (isRecord(inner) || Array.isArray(inner))
      collectConstraintObjects(inner, collectionItems, out, depth + 1);
  }
  return out;
}

interface ResponseConstraint {
  name: string;
  declared: string | number | boolean;
}

/**
 * Finds exactly one object that can be the response constraint echo. A key must
 * exist with the same spelling on every captured row, and the value must be a
 * non-empty, non-sentinel scalar. Multiple plausible echo objects are
 * ambiguous and produce no claim.
 */
function responseConstraints(
  payload: unknown,
  collection: BodyCollection,
): ResponseConstraint[] | undefined {
  if (collection.items.length === 0) return undefined;
  const rows = collection.items.map((item) =>
    isRecord(item) && !isRedactedPlaceholder(item) ? item : undefined,
  );
  if (rows.some((row) => row === undefined)) return undefined;
  const first = rows[0];
  if (!first) return undefined;

  const commonNames = new Set(Object.keys(first));
  for (const row of rows.slice(1)) {
    if (!row) return undefined;
    for (const name of commonNames)
      if (!Object.prototype.hasOwnProperty.call(row, name))
        commonNames.delete(name);
  }
  if (commonNames.size === 0) return undefined;

  const candidates = collectConstraintObjects(payload, collection.items)
    .map((scope) =>
      Object.entries(scope).filter(
        ([name, value]) =>
          commonNames.has(name) &&
          !isDeferredConstraintName(name) &&
          isComparableConstraintScalar(value),
      ),
    )
    .filter((entries) => entries.length > 0);
  if (candidates.length !== 1) return undefined;
  return candidates[0].map(([name, declared]) => ({
    name,
    declared: declared as string | number | boolean,
  }));
}

/**
 * Returns true for a proven mismatch, false for equality, and undefined when
 * deciding would require case folding or type coercion.
 */
function responseScalarContradiction(
  declared: string | number | boolean,
  actual: unknown,
): boolean | undefined {
  if (typeof declared !== typeof actual) return undefined;
  if (declared === actual) return false;
  if (
    typeof declared === "string" &&
    typeof actual === "string" &&
    declared.toLowerCase() === actual.toLowerCase()
  )
    return undefined;
  return true;
}

/**
 * filter_contradiction: a successful response echoes a scalar constraint and
 * includes a returned item with the same field set to a different scalar.
 *
 * The response body is the complete evidence. The detector deliberately does
 * not inspect query parameters, database rows, field aliases, ranges, counts,
 * or ordering, because each would add an application-specific assumption.
 */
function addFilterContradictionCandidates(
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const byConstraint = new Map<string, CandidateDraft>();
  for (const exchange of exchanges.values()) {
    if (!isSuccessStatus(exchange.status) || !exchange.res) continue;
    const view = responseBodyView(exchange.resBody, exchange.resBodyMeta);
    if (!view) continue;
    const collection = responseCollectionFromView(view);
    if (!collection) continue;
    const constraints = responseConstraints(view.data, collection);
    if (!constraints) continue;

    for (const constraint of constraints) {
      for (const item of collection.items) {
        if (!isRecord(item) || isRedactedPlaceholder(item)) continue;
        const actual = item[constraint.name];
        if (isRedactedValue(actual)) continue;
        if (actual !== null && typeof actual === "object") continue;
        if (
          typeof actual !== "string" &&
          typeof actual !== "number" &&
          typeof actual !== "boolean" &&
          actual !== null
        )
          continue;
        if (responseScalarContradiction(constraint.declared, actual) !== true)
          continue;

        const path = capturedUrlPath(exchange.url) ?? exchange.requestId;
        const dedupeKey = "filtercontradiction:" + path + ":" + constraint.name;
        if (byConstraint.has(dedupeKey)) break;
        byConstraint.set(dedupeKey, {
          detector: "filter_contradiction",
          title:
            "Response rows contradict an echoed constraint " + constraint.name,
          severity: "high",
          score: FILTER_CONTRADICTION_SCORE,
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
            message: scrubText(
              "The response declared constraint " +
                constraint.name +
                "=" +
                formatScalar(constraint.declared) +
                ", but a returned item carries " +
                constraint.name +
                "=" +
                formatScalar(actual) +
                ".",
              220,
            ),
            comparedColumns: [constraint.name],
          }),
          dedupeKey,
        });
        break;
      }
    }
  }

  drafts.push(
    ...[...byConstraint.values()]
      .sort((a, b) => a.anchor.t - b.anchor.t)
      .slice(0, MAX_FILTER_CONTRADICTION_CANDIDATES),
  );
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

// ─── unowned_read ────────────────────────────────────────────────────────────

/**
 * A successful response carried a non-empty record with an owner-shaped field
 * that did not identify the caller. This is deliberately narrower than a
 * general cross-user classifier: the caller identity must already be declared
 * on the session, and the response must expose the relationship that was
 * checked. A response without that shape is not enough to call catalogue data
 * a privacy defect.
 */
function addUnownedReadCandidates(
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const identity = index.identity;
  if (!identity) return;

  const ownerField = /^(user|owner|customer|account)(?:_id|Id)$/i;
  const identityValue = (value: unknown): string | undefined => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    return typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;
  };
  const callerForField = (field: string): string | undefined => {
    const family = field.replace(/(?:_id|Id)$/i, "").toLowerCase();
    if (family === "user") return identityValue(identity.userId);
    if (family === "account") return identityValue(identity.accountId);
    if (family === "customer")
      return identityValue(identity.accountId ?? identity.userId);
    return identityValue(identity.userId ?? identity.accountId);
  };

  for (const exchange of exchanges.values()) {
    if (!exchange.res || !isSuccessStatus(exchange.status)) continue;
    const payload = responsePayload(exchange.resBody, exchange.resBodyMeta);
    if (payload === undefined) continue;

    let finding: { field: string; value: string | undefined } | undefined;
    for (const scope of collectObjectScopes(payload)) {
      for (const [field, rawValue] of Object.entries(scope)) {
        if (!ownerField.test(field)) continue;
        if (
          Object.entries(scope).every(
            ([key, value]) =>
              key === field || value === null || value === undefined,
          )
        )
          continue;
        const caller = callerForField(field);
        if (caller === undefined) continue;
        const returned = identityValue(rawValue);
        if (returned !== caller) {
          finding = { field, value: returned };
          break;
        }
      }
      if (finding) break;
    }
    if (!finding) continue;

    const returned = finding.value === undefined ? "null" : finding.value;
    const identityText =
      identityValue(identity.userId) ??
      identityValue(identity.accountId) ??
      "unknown";
    const url = exchange.url;
    const path = capturedUrlPath(url) ?? "the request";
    drafts.push({
      detector: "unowned_read",
      title:
        "Read returned user-scoped state without a relationship to this identity",
      severity: "critical",
      score: 98,
      confidence: "high",
      anchor: removeUndefined({
        t: exchange.res.t,
        offsetMs:
          offsetForEvent(exchange.res) ??
          offsetFromStart(exchange.res.t, index.start),
        route: routeAt(index.navs ?? [], exchange.res.t),
        requestId: exchange.requestId,
        method: exchange.method,
        url: redactUrl(url),
        status: exchange.status,
        message: `An authenticated session for identity ${scrubText(identityText, 120)} received non-empty state from ${path} with ${finding.field}=${scrubText(returned, 120)}, but that owner value does not match the identity that asked. This is a user-scoped read with no relationship behind it and should be escalated as a possible privacy incident.`,
      }),
      dedupeKey: `unowned:${url ?? exchange.requestId}:${finding.field}:${returned}`,
    });
  }
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

// ─── relational write integrity ──────────────────────────────────────────────

const RELATIONAL_WRITE_INTEGRITY_SCORE = DB_INVARIANT_SCORE + 3;
const STALE_WRITEBACK_WINDOW_MS = 60_000;

function scalarChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  field: string,
): { before: string; after: string } | undefined {
  const previous = keyValueOf(before[field]);
  const next = keyValueOf(after[field]);
  return previous !== undefined && next !== undefined && previous !== next
    ? { before: previous, after: next }
    : undefined;
}

function rowIdentity(event: BugEvent): string | undefined {
  const table = safeText(event.d.table, 200);
  const pk = pkEntriesOf(event);
  if (!table || pk.length === 0) return undefined;
  return `${bareTableName(table).toLowerCase()}:${pk
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, value]) => `${field}=${value}`)
    .join("&")}`;
}

function addExistingChildrenReparentedCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    const parentInserts = diffs.filter(
      (event) =>
        safeText(event.d.op, 20)?.toLowerCase() === "insert" &&
        isRecord(event.d.after),
    );
    for (const parent of parentInserts) {
      const parentTable = safeText(parent.d.table, 200);
      if (!parentTable) continue;
      const parentPk = pkEntriesOf(parent);
      if (parentPk.length !== 1) continue;
      const moved = diffs.filter((child) => {
        if (
          safeText(child.d.op, 20)?.toLowerCase() !== "update" ||
          !isRecord(child.d.before) ||
          !isRecord(child.d.after)
        )
          return false;
        const before = child.d.before;
        const after = child.d.after;
        return Object.keys(after).some((field) => {
          if (!columnReferencesTable(field, parentTable)) return false;
          const change = scalarChanged(before, after, field);
          return change?.after === parentPk[0][1];
        });
      });
      if (moved.length === 0) continue;
      const childTable = safeText(moved[0].d.table, 200);
      if (
        !childTable ||
        moved.some(
          (event) => safeText(event.d.table, 200) !== childTable,
        ) ||
        diffs.some(
          (event) =>
            safeText(event.d.table, 200) === childTable &&
            safeText(event.d.op, 20)?.toLowerCase() === "insert",
        )
      )
        continue;
      const anchor = moved[0];
      drafts.push({
        detector: "existing_children_reparented_to_new_row",
        title: `${moved.length} existing ${bareTableName(childTable)} row${moved.length === 1 ? "" : "s"} moved to a newly inserted ${bareTableName(parentTable)}`,
        severity: "critical",
        score: RELATIONAL_WRITE_INTEGRITY_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: anchor.t,
          offsetMs:
            offsetForEvent(anchor) ?? offsetFromStart(anchor.t, index.start),
          route: routeAt(index.navs ?? [], anchor.t),
          requestId,
          table: childTable,
          source: normalizeDbEngine(anchor.d.engine),
          frame: dbCallsiteFrame(anchor.d.callsite),
          message:
            `The request inserted ${bareTableName(parentTable)} ${parentPk[0][1]}, then updated ` +
            `${moved.length} existing ${bareTableName(childTable)} row${moved.length === 1 ? "" : "s"} to reference it without inserting replacement child rows.`,
        }),
        dedupeKey: `reparented:${requestId}:${childTable}:${parentTable}`,
      });
    }
  }
}

function identifierTargetsTable(field: string, table: string): boolean {
  const entity = foreignKeyEntity(field);
  if (!entity) return false;
  const tableEntity = singularize(
    normalizeEntityName(bareTableName(table)),
  );
  return tableEntity === entity || tableEntity.endsWith(entity);
}

function addRequestTargetRowMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  for (const exchange of exchanges.values()) {
    if (!isSuccessStatus(exchange.status)) continue;
    const request = parseStructuredBody(exchange.body);
    if (!isRecord(request)) continue;
    const diffs = events.filter(
      (event) =>
        event.k === "db.diff" &&
        correlationIdOf(event) === exchange.requestId &&
        ["update", "delete"].includes(
          safeText(event.d.op, 20)?.toLowerCase() ?? "",
        ),
    );
    for (const diff of diffs) {
      const table = safeText(diff.d.table, 200);
      const pk = pkEntriesOf(diff);
      if (!table || pk.length !== 1) continue;
      const targets = Object.entries(request)
        .filter(([field]) => identifierTargetsTable(field, table))
        .map(([field, value]) => [field, keyValueOf(value)] as const)
        .filter(
          (entry): entry is readonly [string, string] =>
            entry[1] !== undefined,
        );
      if (targets.length !== 1 || targets[0][1] === pk[0][1]) continue;
      drafts.push({
        detector: "request_target_row_mismatch",
        title: `Request targeted ${targets[0][0]}=${targets[0][1]}, but updated ${bareTableName(table)} ${pk[0][0]}=${pk[0][1]}`,
        severity: "critical",
        score: RELATIONAL_WRITE_INTEGRITY_SCORE + 1,
        confidence: "high",
        anchor: removeUndefined({
          t: diff.t,
          offsetMs:
            offsetForEvent(diff) ?? offsetFromStart(diff.t, index.start),
          route: routeAt(index.navs ?? [], diff.t),
          requestId: exchange.requestId,
          method: exchange.method,
          url: redactUrl(exchange.url),
          status: exchange.status,
          table,
          source: normalizeDbEngine(diff.d.engine),
          frame: dbCallsiteFrame(diff.d.callsite),
          message:
            `The accepted request named ${targets[0][0]}=${targets[0][1]}, but its correlated database mutation targeted ${bareTableName(table)} ${pk[0][0]}=${pk[0][1]}.`,
        }),
        dedupeKey: `targetmismatch:${exchange.requestId}:${table}`,
      });
    }
  }
}

function addStaleValueWritebackCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const updates = events
    .filter(
      (event) =>
        event.k === "db.diff" &&
        safeText(event.d.op, 20)?.toLowerCase() === "update" &&
        isRecord(event.d.before) &&
        isRecord(event.d.after),
    )
    .sort((left, right) => left.t - right.t);
  const priorByRow = new Map<string, BugEvent[]>();
  const emitted = new Set<string>();
  for (const current of updates) {
    const identity = rowIdentity(current);
    if (!identity) continue;
    const prior = priorByRow.get(identity) ?? [];
    for (const previous of prior) {
      if (
        current.t - previous.t > STALE_WRITEBACK_WINDOW_MS ||
        correlationIdOf(current) === correlationIdOf(previous) ||
        !isRecord(previous.d.before) ||
        !isRecord(previous.d.after) ||
        !isRecord(current.d.before) ||
        !isRecord(current.d.after)
      )
        continue;
      for (const field of Object.keys(current.d.after)) {
        if (isIdentityOrClockField(field)) continue;
        const first = scalarChanged(previous.d.before, previous.d.after, field);
        const second = scalarChanged(current.d.before, current.d.after, field);
        if (
          !first ||
          !second ||
          first.before !== second.after ||
          first.after !== second.before
        )
          continue;
        const dedupeKey = `stalewriteback:${identity}:${field}`;
        if (emitted.has(dedupeKey)) continue;
        emitted.add(dedupeKey);
        const table = safeText(current.d.table, 200);
        drafts.push({
          detector: "stale_value_writeback",
          title: `${bareTableName(table ?? "row")}.${field} reverted to its prior value`,
          severity: "high",
          score: RELATIONAL_WRITE_INTEGRITY_SCORE - 1,
          confidence: "medium",
          anchor: removeUndefined({
            t: current.t,
            offsetMs:
              offsetForEvent(current) ??
              offsetFromStart(current.t, index.start),
            route: routeAt(index.navs ?? [], current.t),
            requestId: correlationIdOf(current),
            table,
            source: normalizeDbEngine(current.d.engine),
            frame: dbCallsiteFrame(current.d.callsite),
            message:
              `${bareTableName(table ?? "row")}.${field} changed from ${first.before} to ${first.after}, ` +
              `then a different request wrote the exact prior value ${second.after} back ${current.t - previous.t} ms later.`,
          }),
          dedupeKey,
        });
      }
    }
    prior.push(current);
    priorByRow.set(identity, prior.slice(-8));
  }
}

function addBatchAppliedCountMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    for (const batch of diffs) {
      const table = safeText(batch.d.table, 200);
      const after = isRecord(batch.d.after) ? batch.d.after : undefined;
      const applied = finiteNumber(after?.rows_applied);
      const batchId =
        keyValueOf(after?.id) ??
        (isRecord(batch.d.pk) ? keyValueOf(batch.d.pk.id) : undefined);
      if (
        !table ||
        !/batches?$/i.test(bareTableName(table)) ||
        applied === undefined ||
        applied < 1 ||
        !batchId
      )
        continue;
      const staged = diffs.filter((event) => {
        const stagedTable = safeText(event.d.table, 200);
        const row = isRecord(event.d.after) ? event.d.after : undefined;
        return (
          safeText(event.d.op, 20)?.toLowerCase() === "insert" &&
          stagedTable !== undefined &&
          /stag/i.test(bareTableName(stagedTable)) &&
          (keyValueOf(row?.batch_id) ?? keyValueOf(row?.batchId)) === batchId
        );
      });
      if (staged.length === 0 || applied <= staged.length) continue;
      drafts.push({
        detector: "batch_applied_count_exceeds_staged_rows",
        title: `Batch claimed ${applied} applied rows after staging only ${staged.length}`,
        severity: "high",
        score: RELATIONAL_WRITE_INTEGRITY_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: batch.t,
          offsetMs:
            offsetForEvent(batch) ?? offsetFromStart(batch.t, index.start),
          route: routeAt(index.navs ?? [], batch.t),
          requestId,
          table,
          source: normalizeDbEngine(batch.d.engine),
          frame: dbCallsiteFrame(batch.d.callsite),
          message:
            `${bareTableName(table)} ${batchId} recorded rows_applied=${applied}, but the same request inserted only ${staged.length} correlated staging row${staged.length === 1 ? "" : "s"}.`,
        }),
        dedupeKey: `batchapplied:${requestId}:${table}:${batchId}`,
      });
    }
  }
}

function addMissingEntityAuditCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const [requestId, diffs] of dbDiffsByRequest(events)) {
    const audits = diffs.filter(
      (event) =>
        safeText(event.d.op, 20)?.toLowerCase() === "insert" &&
        /audit/i.test(bareTableName(safeText(event.d.table, 200) ?? "")) &&
        isRecord(event.d.after),
    );
    if (audits.length === 0) continue;
    const mutationsByTable = new Map<string, BugEvent[]>();
    for (const event of diffs) {
      const table = safeText(event.d.table, 200);
      if (
        !table ||
        /audit/i.test(bareTableName(table)) ||
        !["insert", "update", "delete"].includes(
          safeText(event.d.op, 20)?.toLowerCase() ?? "",
        )
      )
        continue;
      const list = mutationsByTable.get(table) ?? [];
      list.push(event);
      mutationsByTable.set(table, list);
    }
    for (const [table, mutations] of mutationsByTable) {
      if (mutations.length < 2) continue;
      const entity = singularize(normalizeEntityName(bareTableName(table)));
      const matchingAudits = audits.filter((audit) => {
        if (!isRecord(audit.d.after)) return false;
        const auditedEntity = safeText(audit.d.after.entity, 160);
        return (
          auditedEntity !== undefined &&
          singularize(normalizeEntityName(auditedEntity)) === entity
        );
      });
      if (matchingAudits.length > 0) continue;
      const anchor = mutations[0];
      drafts.push({
        detector: "mutations_missing_entity_audit",
        title: `${mutations.length} ${bareTableName(table)} mutations had no matching entity audit`,
        severity: "high",
        score: RELATIONAL_WRITE_INTEGRITY_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: anchor.t,
          offsetMs:
            offsetForEvent(anchor) ?? offsetFromStart(anchor.t, index.start),
          route: routeAt(index.navs ?? [], anchor.t),
          requestId,
          table,
          source: normalizeDbEngine(anchor.d.engine),
          frame: dbCallsiteFrame(anchor.d.callsite),
          message:
            `The request mutated ${mutations.length} ${bareTableName(table)} rows and wrote ${audits.length} audit row${audits.length === 1 ? "" : "s"}, ` +
            `but none of those audits named the ${entity} entity.`,
        }),
        dedupeKey: `missingaudit:${requestId}:${table}`,
      });
    }
  }
}

function referencedEntityFromNote(
  note: unknown,
): { entity: string; id: string } | undefined {
  const text = safeText(note, 200);
  const match = text ? /\b([a-z][a-z0-9_-]*)\s*=\s*([a-z0-9_-]+)\b/i.exec(text) : null;
  return match ? { entity: match[1], id: match[2] } : undefined;
}

function addReportSourceContradictionCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const sourceRows = new Map<string, BugEvent>();
  const ordered = [...events].sort((left, right) => left.t - right.t);
  for (const event of ordered) {
    if (
      (event.k === "db.read" && isRecord(event.d.row)) ||
      (event.k === "db.diff" && isRecord(event.d.after))
    ) {
      const row =
        event.k === "db.read" && isRecord(event.d.row)
          ? event.d.row
          : isRecord(event.d.after)
            ? event.d.after
            : undefined;
      const table = safeText(event.d.table, 200);
      const id =
        keyValueOf(row?.id) ??
        (isRecord(event.d.pk) ? keyValueOf(event.d.pk.id) : undefined);
      if (row && table && id)
        sourceRows.set(
          `${singularize(normalizeEntityName(bareTableName(table)))}:${id}`,
          event,
        );
    }
    if (
      event.k !== "db.diff" ||
      safeText(event.d.op, 20)?.toLowerCase() !== "insert" ||
      !isRecord(event.d.after)
    )
      continue;
    const reference = referencedEntityFromNote(event.d.after.note);
    const reportedTotal =
      finiteNumber(event.d.after.total_cents) ??
      finiteNumber(event.d.after.totalCents);
    if (!reference || reportedTotal === undefined) continue;
    const source = sourceRows.get(
      `${singularize(normalizeEntityName(reference.entity))}:${reference.id}`,
    );
    const sourceRow =
      source?.k === "db.read" && isRecord(source.d.row)
        ? source.d.row
        : source?.k === "db.diff" && isRecord(source.d.after)
          ? source.d.after
          : undefined;
    const sourceTotal =
      finiteNumber(sourceRow?.total_cents) ??
      finiteNumber(sourceRow?.totalCents);
    if (sourceTotal === undefined || sourceTotal === reportedTotal) continue;
    const table = safeText(event.d.table, 200);
    drafts.push({
      detector: "report_total_contradicts_source_row",
      title: `Report total ${reportedTotal} disagreed with ${reference.entity} ${reference.id}'s stored total ${sourceTotal}`,
      severity: "high",
      score: RELATIONAL_WRITE_INTEGRITY_SCORE + 1,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId: correlationIdOf(event),
        table,
        source: normalizeDbEngine(event.d.engine),
        frame: dbCallsiteFrame(event.d.callsite),
        message:
          `The latest captured ${reference.entity} ${reference.id} row had total_cents=${sourceTotal}, ` +
          `but the subsequent report persisted total_cents=${reportedTotal}.`,
      }),
      dedupeKey: `reportsourcecontradiction:${reference.entity}:${reference.id}:${table ?? ""}`,
    });
  }
}

function addRelationalWriteIntegrityCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  addExistingChildrenReparentedCandidates(events, index, drafts);
  addRequestTargetRowMismatchCandidates(events, index, drafts, exchanges);
  addStaleValueWritebackCandidates(events, index, drafts);
  addBatchAppliedCountMismatchCandidates(events, index, drafts);
  addMissingEntityAuditCandidates(events, index, drafts);
  addReportSourceContradictionCandidates(events, index, drafts);
}

// ─── async state lifecycle integrity ─────────────────────────────────────────

const STATE_LIFECYCLE_SCORE = DB_INVARIANT_SCORE + 2;

function addDeferredDrainCandidates(
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  for (const exchange of exchanges.values()) {
    if (
      exchange.method !== "POST" ||
      !/\/jobs\/drain$/i.test(capturedUrlPath(exchange.url) ?? "") ||
      !isSuccessStatus(exchange.status) ||
      !exchange.res
    )
      continue;
    const response = parseStructuredBody(exchange.resBody);
    if (!isRecord(response)) continue;
    const remaining = finiteNumber(response.remaining);
    const deferred = finiteNumber(response.deferred);
    if (
      remaining === undefined ||
      deferred === undefined ||
      remaining < 1 ||
      deferred < 1
    )
      continue;
    drafts.push({
      detector: "job_drain_left_work_deferred",
      title: `Successful job drain deferred ${deferred} job${deferred === 1 ? "" : "s"} and left ${remaining} pending`,
      severity: "high",
      score: STATE_LIFECYCLE_SCORE,
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
        message:
          `The drain returned success but reported deferred=${deferred} and remaining=${remaining}. ` +
          `Work was neither completed nor failed.`,
      }),
      dedupeKey: `deferreddrain:${capturedUrlPath(exchange.url) ?? ""}`,
    });
  }
}

function parsedTimestamp(value: unknown): number | undefined {
  const text = safeText(value, 100);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function addRetryClockShiftCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const HOUR_MS = 60 * 60 * 1000;
  const CLOCK_SHIFT_TOLERANCE_MS = 2 * 60 * 1000;
  for (const event of events) {
    if (
      event.k !== "db.diff" ||
      bareTableName(safeText(event.d.table, 200) ?? "").toLowerCase() !==
        "jobs" ||
      safeText(event.d.op, 20)?.toLowerCase() !== "update" ||
      !isRecord(event.d.before) ||
      !isRecord(event.d.after)
    )
      continue;
    const attemptsBefore = finiteNumber(event.d.before.attempts);
    const attemptsAfter = finiteNumber(event.d.after.attempts);
    const runAt = parsedTimestamp(event.d.after.run_at);
    if (
      attemptsBefore === undefined ||
      attemptsAfter !== attemptsBefore + 1 ||
      safeText(event.d.after.status, 40)?.toLowerCase() !== "pending" ||
      !safeText(event.d.after.last_error, 300) ||
      runAt === undefined
    )
      continue;
    const delay = runAt - event.t;
    const roundedHours = Math.round(delay / HOUR_MS);
    if (
      roundedHours < 2 ||
      roundedHours > 14 ||
      Math.abs(delay - roundedHours * HOUR_MS) >
        CLOCK_SHIFT_TOLERANCE_MS
    )
      continue;
    drafts.push({
      detector: "retry_schedule_clock_shift",
      title: `Retry was shifted about ${roundedHours} hours into the future`,
      severity: "high",
      score: STATE_LIFECYCLE_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId: correlationIdOf(event),
        table: safeText(event.d.table, 200),
        source: normalizeDbEngine(event.d.engine),
        frame: dbCallsiteFrame(event.d.callsite),
        message:
          `After attempt ${attemptsAfter} failed, run_at landed ${roundedHours} whole hours ahead of the retry write. ` +
          `That hour-aligned displacement is characteristic of a local-time/UTC reconstruction, not a short retry backoff.`,
      }),
      dedupeKey: `retryclockshift:${rowIdentity(event) ?? event.t}`,
    });
  }
}

interface BackendRequestInterval {
  start: BugEvent;
  end?: BugEvent;
}

function backendRequestIntervals(
  events: BugEvent[],
): Map<string, BackendRequestInterval> {
  const intervals = new Map<string, BackendRequestInterval>();
  for (const event of events) {
    if (event.k !== "backend.req.start") continue;
    const requestId = correlationIdOf(event);
    if (requestId) intervals.set(requestId, { start: event });
  }
  for (const event of events) {
    if (event.k !== "backend.req.end") continue;
    const requestId = correlationIdOf(event);
    const interval = requestId ? intervals.get(requestId) : undefined;
    if (interval) interval.end = event;
  }
  return intervals;
}

function addInflightSessionInvalidationCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const intervals = [...backendRequestIntervals(events).entries()];
  for (const deletion of events) {
    if (
      deletion.k !== "db.diff" ||
      bareTableName(safeText(deletion.d.table, 200) ?? "").toLowerCase() !==
        "sessions" ||
      safeText(deletion.d.op, 20)?.toLowerCase() !== "delete"
    )
      continue;
    const deletedBy = correlationIdOf(deletion);
    const invalidated = intervals.find(([requestId, interval]) => {
      const status = finiteNumber(interval.end?.d.statusCode);
      return (
        requestId !== deletedBy &&
        interval.end !== undefined &&
        interval.start.t < deletion.t &&
        interval.end.t > deletion.t &&
        status === 401
      );
    });
    if (!invalidated?.[1].end) continue;
    const [requestId, interval] = invalidated;
    const end = interval.end;
    if (!end) continue;
    const url =
      safeText(interval.start.d.url, 400) ??
      safeText(interval.start.d.pathname, 400);
    drafts.push({
      detector: "inflight_request_invalidated_by_session_rotation",
      title: `An in-flight request became unauthorized after its session was deleted`,
      severity: "high",
      score: STATE_LIFECYCLE_SCORE + 1,
      confidence: "high",
      anchor: removeUndefined({
        t: end.t,
        offsetMs:
          offsetForEvent(end) ?? offsetFromStart(end.t, index.start),
        route: routeAt(index.navs ?? [], end.t),
        requestId,
        method: safeText(interval.start.d.method, 20)?.toUpperCase(),
        url: redactUrl(url),
        status: 401,
        source: "backend",
        message:
          `The request started ${deletion.t - interval.start.t} ms before a sessions row was deleted, ` +
          `remained in flight across that rotation, and then completed with HTTP 401.`,
      }),
      dedupeKey: `inflightsessioninvalidated:${requestId}`,
    });
  }
}

function addCachedEmptyAfterDataCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const reports = events
    .filter(
      (event) =>
        event.k === "db.diff" &&
        safeText(event.d.op, 20)?.toLowerCase() === "insert" &&
        isRecord(event.d.after) &&
        finiteNumber(event.d.after.rows_returned) === 0,
    )
    .sort((left, right) => left.t - right.t);
  for (let laterIndex = 1; laterIndex < reports.length; laterIndex += 1) {
    const later = reports[laterIndex];
    if (!isRecord(later.d.after)) continue;
    const note = safeText(later.d.after.note, 160)?.toLowerCase();
    const kind = keyValueOf(later.d.after.kind);
    if (!note?.includes("cache=hit") || !kind) continue;
    const earlier = reports
      .slice(0, laterIndex)
      .reverse()
      .find(
        (event) =>
          isRecord(event.d.after) &&
          keyValueOf(event.d.after.kind) === kind,
      );
    if (!earlier) continue;
    const reportTable = safeText(later.d.table, 200);
    const inserted = events.filter(
      (event) =>
        event.k === "db.diff" &&
        safeText(event.d.op, 20)?.toLowerCase() === "insert" &&
        event.t > earlier.t &&
        event.t < later.t &&
        safeText(event.d.table, 200) !== reportTable,
    );
    if (inserted.length === 0) continue;
    const sourceTables = [
      ...new Set(
        inserted
          .map((event) => safeText(event.d.table, 120))
          .filter((table): table is string => Boolean(table)),
      ),
    ];
    drafts.push({
      detector: "cached_empty_result_after_data_arrived",
      title: `Cached ${kind} result stayed empty after ${inserted.length} row inserts`,
      severity: "high",
      score: STATE_LIFECYCLE_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: later.t,
        offsetMs:
          offsetForEvent(later) ?? offsetFromStart(later.t, index.start),
        route: routeAt(index.navs ?? [], later.t),
        requestId: correlationIdOf(later),
        table: reportTable,
        source: normalizeDbEngine(later.d.engine),
        frame: dbCallsiteFrame(later.d.callsite),
        message:
          `A ${kind} read recorded zero rows, ${inserted.length} rows were then inserted into ` +
          `${sourceTables.join(", ") || "source tables"}, and the next report still recorded rows_returned=0 with cache=hit.`,
      }),
      dedupeKey: `cachedempty:${kind}:${reportTable ?? ""}`,
    });
  }
}

function addOpsStateLifecycleCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  addDeferredDrainCandidates(index, drafts, exchanges);
  addRetryClockShiftCandidates(events, index, drafts);
  addInflightSessionInvalidationCandidates(events, index, drafts);
  addCachedEmptyAfterDataCandidates(events, index, drafts);
}

// ─── data lifecycle integrity ────────────────────────────────────────────────

const DATA_LIFECYCLE_SCORE = DB_INVARIANT_SCORE + 2;
const FREE_TEXT_FIELDS = /^(body|comment|content|description|message|note|text)$/i;

function redactedLengthsByField(
  value: unknown,
  out = new Map<string, number[]>(),
  depth = 0,
): Map<string, number[]> {
  if (depth > MAX_BODY_SCOPE_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const item of value) redactedLengthsByField(item, out, depth + 1);
    return out;
  }
  if (!isRecord(value)) return out;
  for (const [field, child] of Object.entries(value)) {
    if (isRedactedPlaceholder(child)) {
      const length = finiteNumber((child as Record<string, unknown>).len);
      if (length !== undefined) {
        const values = out.get(field) ?? [];
        values.push(length);
        out.set(field, values);
      }
      continue;
    }
    redactedLengthsByField(child, out, depth + 1);
  }
  return out;
}

function addAcceptedTextTruncationCandidates(
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  for (const exchange of exchanges.values()) {
    if (
      !MUTATING_METHODS.has(exchange.method) ||
      !isSuccessStatus(exchange.status) ||
      !exchange.res
    ) continue;
    const request = parseStructuredBody(exchange.body);
    // The raw redacted JSON preserves placeholder length metadata. The bounded
    // bodyMeta view may intentionally collapse a sensitive nested string to the
    // scalar "[REDACTED]", so prefer the privacy-safe raw shape here.
    const response =
      parseStructuredBody(exchange.resBody) ??
      responsePayload(exchange.resBody, exchange.resBodyMeta);
    if (request === undefined || response === undefined) continue;
    const requested = redactedLengthsByField(request);
    const returned = redactedLengthsByField(response);
    for (const [field, requestLengths] of requested) {
      if (!FREE_TEXT_FIELDS.test(field)) continue;
      const responseLengths = returned.get(field);
      if (!responseLengths) continue;
      const requestLength = Math.max(...requestLengths);
      const responseLength = Math.max(...responseLengths);
      if (
        requestLength < 32 ||
        responseLength >= requestLength ||
        requestLength - responseLength < 4
      ) continue;
      drafts.push({
        detector: "accepted_text_was_truncated",
        title: `Successful write shortened ${field} from ${requestLength} to ${responseLength} characters`,
        severity: "high",
        score: DATA_LIFECYCLE_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: exchange.res.t,
          offsetMs: offsetForEvent(exchange.res) ?? offsetFromStart(exchange.res.t, index.start),
          route: routeAt(index.navs ?? [], exchange.res.t),
          requestId: exchange.requestId,
          method: exchange.method,
          url: redactUrl(exchange.url),
          status: exchange.status,
          message:
            `The accepted request carried a redacted ${field} with length ${requestLength}, ` +
            `but the successful response returned that field with length ${responseLength}.`,
        }),
        dedupeKey: `acceptedtexttruncated:${exchange.requestId}:${field}`,
      });
      break;
    }
  }
}

function addDerivedCountBelowObservedInsertsCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const inserts = events.filter(
    (event) =>
      event.k === "db.diff" &&
      safeText(event.d.op, 20)?.toLowerCase() === "insert" &&
      isRecord(event.d.after),
  );
  for (const cacheWrite of events) {
    if (
      cacheWrite.k !== "db.diff" ||
      !["insert", "update"].includes(
        safeText(cacheWrite.d.op, 20)?.toLowerCase() ?? "",
      ) ||
      !isRecord(cacheWrite.d.after)
    ) continue;
    const cacheTable = safeText(cacheWrite.d.table, 200);
    if (!cacheTable || !/(cache|rollup|summary|aggregate)/i.test(cacheTable))
      continue;
    const countEntry = Object.entries(cacheWrite.d.after).find(
      ([field, value]) =>
        /(?:^|_)count$/i.test(field) && finiteNumber(value) !== undefined,
    );
    const parentEntry =
      Object.entries(cacheWrite.d.after).find(
        ([field, value]) =>
          !ID_EXACT.test(field) &&
          isIdLikeField(field) &&
          keyValueOf(value) !== undefined,
      ) ??
      Object.entries(cacheWrite.d.after).find(
        ([field, value]) =>
          isIdLikeField(field) && keyValueOf(value) !== undefined,
      );
    if (!countEntry || !parentEntry) continue;
    const [countField, rawCount] = countEntry;
    const [parentField, rawParent] = parentEntry;
    const derivedCount = finiteNumber(rawCount);
    const parentId = keyValueOf(rawParent);
    if (derivedCount === undefined || !parentId) continue;
    const matching = inserts.filter((event) => {
      if (
        event.t > cacheWrite.t ||
        safeText(event.d.table, 200) === cacheTable ||
        !isRecord(event.d.after)
      ) return false;
      return Object.entries(event.d.after).some(
        ([field, value]) =>
          normalizeFieldName(field) === normalizeFieldName(parentField) &&
          keyValueOf(value) === parentId,
      );
    });
    if (matching.length <= derivedCount) continue;
    drafts.push({
      detector: "derived_count_below_observed_inserts",
      title: `${cacheTable}.${countField}=${derivedCount} after ${matching.length} matching rows were inserted`,
      severity: "high",
      score: DATA_LIFECYCLE_SCORE + 1,
      confidence: "high",
      anchor: removeUndefined({
        t: cacheWrite.t,
        offsetMs: offsetForEvent(cacheWrite) ?? offsetFromStart(cacheWrite.t, index.start),
        route: routeAt(index.navs ?? [], cacheWrite.t),
        requestId: correlationIdOf(cacheWrite),
        table: cacheTable,
        source: normalizeDbEngine(cacheWrite.d.engine),
        frame: dbCallsiteFrame(cacheWrite.d.callsite),
        message:
          `The session captured ${matching.length} inserted rows with ${parentField}=${parentId}, ` +
          `but the derived row subsequently stored ${countField}=${derivedCount}.`,
      }),
      dedupeKey: `derivedcountbelowinserts:${cacheTable}:${parentField}:${parentId}`,
    });
  }
}

function addResponseLimitExceededCandidates(
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  for (const exchange of exchanges.values()) {
    if (
      exchange.method !== "GET" ||
      !isSuccessStatus(exchange.status) ||
      !exchange.res
    ) continue;
    const parsed = parseCapturedUrl(exchange.url);
    const rawLimit = parsed?.searchParams.get("limit");
    if (!rawLimit) continue;
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 0) continue;
    const collection = responseCollection(exchange.resBody, exchange.resBodyMeta);
    if (!collection || collection.total <= limit) continue;
    drafts.push({
      detector: "response_exceeded_requested_limit",
      title: `Response returned ${collection.total} rows despite limit=${limit}`,
      severity: "high",
      score: DATA_LIFECYCLE_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: exchange.res.t,
        offsetMs: offsetForEvent(exchange.res) ?? offsetFromStart(exchange.res.t, index.start),
        route: routeAt(index.navs ?? [], exchange.res.t),
        requestId: exchange.requestId,
        method: exchange.method,
        url: redactUrl(exchange.url),
        status: exchange.status,
        message: `The request explicitly set limit=${limit}, but the captured response contained ${collection.total} collection rows.`,
      }),
      dedupeKey: `responselimitexceeded:${capturedUrlPath(exchange.url) ?? ""}:${limit}`,
    });
  }
}

function lifecycleType(value: unknown): string | undefined {
  const text = safeText(value, 120)?.toLowerCase();
  if (!text) return undefined;
  if (/(^|[_-])cancel(?:led|ed)?($|[_-])/.test(text)) return "cancelled";
  if (/(^|[_-])confirm(?:ed)?($|[_-])/.test(text)) return "confirmed";
  return undefined;
}

function addInvertedLifecycleNotificationCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const notifications = events
    .filter(
      (event) =>
        (event.k === "db.read" || event.k === "db.diff") &&
        bareTableName(safeText(event.d.table, 200) ?? "").toLowerCase() ===
          "notifications",
    )
    .flatMap((event) => {
      const row =
        event.k === "db.read"
          ? isRecord(event.d.row)
            ? event.d.row
            : undefined
          : isRecord(event.d.after)
            ? event.d.after
            : undefined;
      const orderId = row ? orderIdFromRow(row) : undefined;
      const kind = row
        ? lifecycleType(row.type) ?? lifecycleType(row.kind)
        : undefined;
      const status = row ? safeText(row.status, 40)?.toLowerCase() : undefined;
      return orderId && kind && (!status || status === "sent")
        ? [{ event, orderId, kind }]
        : [];
    })
    .sort((left, right) => left.event.t - right.event.t);
  const byOrder = new Map<string, typeof notifications>();
  for (const notification of notifications) {
    const list = byOrder.get(notification.orderId) ?? [];
    list.push(notification);
    byOrder.set(notification.orderId, list);
  }
  for (const [orderId, list] of byOrder) {
    const cancelled = list.find((entry) => entry.kind === "cancelled");
    const confirmed = list.find(
      (entry) =>
        entry.kind === "confirmed" &&
        cancelled !== undefined &&
        entry.event.t >= cancelled.event.t,
    );
    if (!cancelled || !confirmed) continue;
    drafts.push({
      detector: "notification_lifecycle_order_inverted",
      title: `Order ${orderId} was confirmed after its cancellation notification`,
      severity: "high",
      score: DATA_LIFECYCLE_SCORE + 1,
      confidence: "high",
      anchor: removeUndefined({
        t: confirmed.event.t,
        offsetMs: offsetForEvent(confirmed.event) ?? offsetFromStart(confirmed.event.t, index.start),
        route: routeAt(index.navs ?? [], confirmed.event.t),
        requestId: correlationIdOf(confirmed.event),
        table: safeText(confirmed.event.d.table, 200),
        source: normalizeDbEngine(confirmed.event.d.engine),
        message:
          `The captured notification history for order ${orderId} recorded a sent cancellation before a sent confirmation.`,
      }),
      dedupeKey: `notificationlifecycleinverted:${orderId}`,
    });
  }
}

function addDataLifecycleIntegrityCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  addAcceptedTextTruncationCandidates(index, drafts, exchanges);
  addDerivedCountBelowObservedInsertsCandidates(events, index, drafts);
  addResponseLimitExceededCandidates(index, drafts, exchanges);
  addInvertedLifecycleNotificationCandidates(events, index, drafts);
}

// ─── browser and network integrity ───────────────────────────────────────────

const BROWSER_NETWORK_SCORE = 85;

interface CasefoldIdentity {
  field: string;
  hash: string;
  casefoldHash: string;
  length: number;
}

function casefoldIdentityOf(value: unknown): CasefoldIdentity | undefined {
  for (const scope of collectObjectScopes(value)) {
    for (const [field, child] of Object.entries(scope)) {
      if (!/^(email|username|login|handle)$/i.test(field)) continue;
      if (!isRedactedPlaceholder(child)) continue;
      const shape = child as Record<string, unknown>;
      const hash = safeText(shape.hash8, 20);
      const casefoldHash = safeText(shape.casefoldHash8, 20) ?? hash;
      const length = finiteNumber(shape.len);
      if (!hash || !casefoldHash || length === undefined) continue;
      return { field, hash, casefoldHash, length };
    }
  }
  return undefined;
}

function addCasefoldIdentityCollisionCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const insertsByRequest = dbDiffsByRequest(events);
  const grouped = new Map<
    string,
    Array<{
      identity: CasefoldIdentity;
      exchange: RequestExchange;
      insert: BugEvent;
    }>
  >();
  for (const exchange of exchanges.values()) {
    if (
      exchange.method !== "POST" ||
      !isSuccessStatus(exchange.status) ||
      !exchange.res
    ) continue;
    const identity = casefoldIdentityOf(parseStructuredBody(exchange.body));
    if (!identity) continue;
    const inserts = (insertsByRequest.get(exchange.requestId) ?? []).filter(
      (event) =>
        safeText(event.d.op, 20)?.toLowerCase() === "insert" &&
        isRecord(event.d.after) &&
        Object.keys(event.d.after).some(
          (field) =>
            normalizeFieldName(field) === normalizeFieldName(identity.field),
        ),
    );
    if (inserts.length !== 1) continue;
    const insert = inserts[0];
    const table = safeText(insert.d.table, 200);
    if (!table) continue;
    const key = `${table}:${identity.field}:${identity.casefoldHash}:${identity.length}`;
    const list = grouped.get(key) ?? [];
    list.push({ identity, exchange, insert });
    grouped.set(key, list);
  }
  for (const [key, entries] of grouped) {
    const rawHashes = new Set(entries.map((entry) => entry.identity.hash));
    if (entries.length < 2 || rawHashes.size < 2) continue;
    entries.sort((left, right) => left.insert.t - right.insert.t);
    const first = entries[0];
    const last = entries[entries.length - 1];
    const table = safeText(last.insert.d.table, 200);
    drafts.push({
      detector: "casefold_duplicate_identity_accepted",
      title: `${entries.length} case-only variants of one ${first.identity.field} were inserted`,
      severity: "high",
      score: DATA_LIFECYCLE_SCORE + 2,
      confidence: "high",
      anchor: removeUndefined({
        t: last.insert.t,
        offsetMs: offsetForEvent(last.insert) ?? offsetFromStart(last.insert.t, index.start),
        route: routeAt(index.navs ?? [], last.insert.t),
        requestId: last.exchange.requestId,
        method: last.exchange.method,
        url: redactUrl(last.exchange.url),
        status: last.exchange.status,
        table,
        source: normalizeDbEngine(last.insert.d.engine),
        frame: dbCallsiteFrame(last.insert.d.callsite),
        message:
          `${entries.length} successful requests carried different salted fingerprints but the same ` +
          `case-fold fingerprint and length for ${first.identity.field}; each request inserted a ${bareTableName(table ?? "row")} row.`,
      }),
      dedupeKey: `casefoldcollision:${key}`,
    });
  }
}

/**
 * The first moment this session can show the user committed state: the
 * completion of the earliest non-GET request that succeeded.
 *
 * A control that claims to commit something is only interesting when there is
 * something to commit. The rule below used to spell that in one app's
 * vocabulary — a successful response from a single hardcoded shopping route,
 * read as "the basket is populated" — so it could not fire on an app that has
 * no such route. Every app has the same shape underneath: a signup, a saved
 * draft, an uploaded file, a configured booking. What the rule needs is not a
 * particular route, it is evidence that the click is acting on state this
 * session already put somewhere.
 */
function firstCommittedStateAt(
  exchanges: Map<string, RequestExchange>,
): number | undefined {
  let earliest: number | undefined;
  for (const exchange of exchanges.values()) {
    if (!MUTATING_METHODS.has(exchange.method)) continue;
    if (!isSuccessStatus(exchange.status)) continue;
    const completed = exchange.res?.t ?? exchange.req.t;
    if (earliest === undefined || completed < earliest) earliest = completed;
  }
  return earliest;
}

function addBlockedDependencyActionCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const blockedScripts = events.filter(
    (event) =>
      event.k === "perf" &&
      safeText(event.d.metric, 20) === "res" &&
      safeText(event.d.initiatorType, 40) === "script" &&
      finiteNumber(event.d.transferSize) === 0 &&
      /(?:vendor|analytics|tracker|tracking|pixel|tag|ads?)[/_.-]/i.test(
        safeText(event.d.name, 400) ?? "",
      ),
  );
  if (blockedScripts.length === 0) return;
  const committedStateAt = firstCommittedStateAt(exchanges);
  if (committedStateAt === undefined) return;
  for (const click of events) {
    if (click.k !== "clk" || !isRecord(click.d.el)) continue;
    // The state has to exist before the action that acts on it.
    if (click.t < committedStateAt) continue;
    const action = [
      safeText(click.d.el.path, 300),
      safeText(click.d.el.txt, 160),
    ]
      .filter(Boolean)
      .join(" ");
    if (!/(checkout|place[-_ ]?order|purchase|pay|submit)/i.test(action))
      continue;
    const deadline = click.t + 3_000;
    const progressed = events.some((event) => {
      if (event.t <= click.t || event.t > deadline) return false;
      if (isNavigationEvent(event)) return true;
      if (event.k !== "net.req") return false;
      const path = capturedUrlPath(safeText(event.d.url, 400)) ?? "";
      return /(?:checkout|orders?|payments?)/i.test(path);
    });
    if (progressed) continue;
    const blocked = [...blockedScripts]
      .reverse()
      .find((event) => event.t <= click.t);
    if (!blocked) continue;
    drafts.push({
      detector: "blocked_script_prevented_action",
      title: `Action control produced no request after a script failed to load`,
      severity: "high",
      score: BROWSER_NETWORK_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: click.t,
        offsetMs: offsetForEvent(click) ?? offsetFromStart(click.t, index.start),
        route: routeAt(index.navs ?? [], click.t),
        message:
          `An action control was clicked after this session had already committed state through a successful write, ` +
          `but no checkout/order/payment request or navigation followed within 3 seconds. ` +
          `A vendor-style script resource on this page transferred zero bytes.`,
        source: redactUrl(safeText(blocked.d.name, 400)),
      }),
      dedupeKey: `blockedaction:${safeText(click.d.el.path, 200) ?? click.t}`,
    });
  }
}

const MUTATED_STATE_FIELD =
  /^(active|available|count|enabled|inventory|quantity|qty|seq|sequence|state|status|stock|value)$/i;

function addAcknowledgedStateContradictionCandidates(
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const ordered = [...exchanges.values()].sort(
    (left, right) => left.req.t - right.req.t,
  );
  for (const mutation of ordered) {
    if (
      !MUTATING_METHODS.has(mutation.method) ||
      !isSuccessStatus(mutation.status) ||
      !mutation.res
    ) continue;
    const payload = parseStructuredBody(mutation.body);
    if (!isRecord(payload)) continue;
    const ids = Object.entries(payload).filter(
      ([field, value]) =>
        isIdLikeField(field) &&
        (typeof value === "string" || finiteNumber(value) !== undefined),
    );
    const states = Object.entries(payload).filter(
      ([field, value]) =>
        MUTATED_STATE_FIELD.test(field) &&
        (typeof value === "string" ||
          typeof value === "boolean" ||
          finiteNumber(value) !== undefined),
    );
    if (ids.length !== 1 || states.length !== 1) continue;
    const [idField, idValue] = ids[0];
    const [stateField, stateValue] = states[0];
    const mutationPath = capturedUrlPath(mutation.url);
    if (!mutationPath) continue;
    const root = apiPrefixOf(mutationPath);
    const read = ordered.find((exchange) => {
      if (
        exchange.method !== "GET" ||
        exchange.req.t <= mutation.res!.t ||
        !isSuccessStatus(exchange.status) ||
        !exchange.res ||
        !capturedUrlPath(exchange.url)?.startsWith(root)
      ) return false;
      const collection = responseCollection(exchange.resBody, exchange.resBodyMeta);
      if (!collection) return false;
      const row = findCollectionItem(collection.items, [String(idValue)]);
      if (!row) return false;
      const observed = Object.entries(row).find(
        ([field]) =>
          normalizeFieldName(field) === normalizeFieldName(stateField),
      );
      return observed !== undefined && !sameScalar(observed[1], stateValue);
    });
    if (!read?.res) continue;
    const collection = responseCollection(read.resBody, read.resBodyMeta);
    const row = collection
      ? findCollectionItem(collection.items, [String(idValue)])
      : undefined;
    const observed = row
      ? Object.entries(row).find(
          ([field]) =>
            normalizeFieldName(field) === normalizeFieldName(stateField),
        )
      : undefined;
    if (!observed) continue;
    drafts.push({
      detector: "acknowledged_state_contradicted_by_read",
      title: `Successful ${stateField}=${String(stateValue)} mutation was contradicted by the next read`,
      severity: "high",
      score: BROWSER_NETWORK_SCORE + 1,
      confidence: "high",
      anchor: removeUndefined({
        t: read.res.t,
        offsetMs: offsetForEvent(read.res) ?? offsetFromStart(read.res.t, index.start),
        route: routeAt(index.navs ?? [], read.res.t),
        requestId: read.requestId,
        method: mutation.method,
        url: redactUrl(mutation.url),
        status: mutation.status,
        message:
          `The server acknowledged ${idField}=${String(idValue)}, ${stateField}=${String(stateValue)}. ` +
          `The next related collection read returned ${stateField}=${String(observed[1])} for that same identity.`,
      }),
      dedupeKey: `statecontradiction:${root}:${idField}:${String(idValue)}:${stateField}`,
    });
  }
}

function addRequestBurstCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const byPath = new Map<string, BugEvent[]>();
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const path = capturedUrlPath(safeText(event.d.url, 400));
    if (!path) continue;
    const list = byPath.get(path) ?? [];
    list.push(event);
    byPath.set(path, list);
  }
  const failedIds = new Set(
    events
      .filter((event) => event.k === "net.err")
      .map((event) => requestIdForEvent(event))
      .filter((id): id is string => id !== undefined),
  );
  for (const [path, requests] of byPath) {
    requests.sort((left, right) => left.t - right.t);
    for (let start = 0; start < requests.length; start += 1) {
      const burst = requests.filter(
        (event) =>
          event.t >= requests[start].t && event.t <= requests[start].t + 250,
      );
      if (burst.length < 5) continue;
      const failed = burst.filter((event) =>
        failedIds.has(requestIdForEvent(event) ?? ""),
      ).length;
      if (failed < Math.ceil(burst.length / 2)) continue;
      const anchor = burst[burst.length - 1];
      drafts.push({
        detector: "request_reconnect_storm",
        title: `${burst.length} requests hit ${path} within ${anchor.t - burst[0].t} ms`,
        severity: "high",
        score: BROWSER_NETWORK_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: anchor.t,
          offsetMs: offsetForEvent(anchor) ?? offsetFromStart(anchor.t, index.start),
          route: routeAt(index.navs ?? [], anchor.t),
          requestId: requestIdForEvent(anchor),
          method: safeText(anchor.d.method, 20) ?? safeText(anchor.d.m, 20),
          url: redactUrl(safeText(anchor.d.url, 400)),
          message:
            `${burst.length} same-endpoint requests started inside 250 ms and ${failed} failed. ` +
            `The synchronized burst has no backoff or jitter.`,
        }),
        dedupeKey: `requestburst:${path}:${burst[0].t}`,
      });
      break;
    }
  }
}

function addStaleClientBuildCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const snapshots = events
    .filter(
      (event) =>
        event.k === "env" &&
        safeText(event.d.appBuild, 120) !== undefined,
    )
    .sort((left, right) => left.t - right.t);
  if (snapshots.length === 0) return;
  for (const exchange of exchanges.values()) {
    if (
      exchange.method !== "GET" ||
      capturedUrlPath(exchange.url) !== "/build-id.json" ||
      !isSuccessStatus(exchange.status) ||
      !exchange.res
    ) continue;
    const payload = responsePayload(exchange.resBody, exchange.resBodyMeta);
    if (!isRecord(payload)) continue;
    const serverBuild =
      safeText(payload.build, 120) ??
      safeText(payload.buildId, 120) ??
      safeText(payload.version, 120);
    if (!serverBuild) continue;
    const snapshot = [...snapshots]
      .reverse()
      .find((event) => event.t <= exchange.res!.t);
    const clientBuild = snapshot
      ? safeText(snapshot.d.appBuild, 120)
      : undefined;
    if (!clientBuild || clientBuild === serverBuild) continue;
    drafts.push({
      detector: "stale_client_build",
      title: `Client build ${clientBuild} disagreed with server build ${serverBuild}`,
      severity: "high",
      score: BROWSER_NETWORK_SCORE + 1,
      confidence: "high",
      anchor: removeUndefined({
        t: exchange.res.t,
        offsetMs: offsetForEvent(exchange.res) ?? offsetFromStart(exchange.res.t, index.start),
        route: routeAt(index.navs ?? [], exchange.res.t),
        requestId: exchange.requestId,
        method: exchange.method,
        url: redactUrl(exchange.url),
        status: exchange.status,
        message:
          `The running HTML shell declared app-build=${clientBuild}, while the no-cache build identity endpoint returned ${serverBuild}. The client is serving a stale release.`,
      }),
      dedupeKey: `stalebuild:${clientBuild}:${serverBuild}`,
    });
  }
}

function addRtlPhysicalLayoutCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (
      event.k !== "ui.layout" ||
      safeText(event.d.dir, 20)?.toLowerCase() !== "rtl" ||
      !Array.isArray(event.d.rtlPhysical)
    ) continue;
    const rules = event.d.rtlPhysical.filter(isRecord);
    if (rules.length < 2) continue;
    const properties = new Set(
      rules.flatMap((rule) =>
        Array.isArray(rule.properties)
          ? rule.properties
              .map((property) => safeText(property, 40))
              .filter((property): property is string => Boolean(property))
          : [],
      ),
    );
    const hasAnchor = properties.has("left") || properties.has("right");
    const hasSpacing = [...properties].some((property) =>
      /^(?:margin|padding|border)/.test(property),
    );
    if (!hasAnchor || !hasSpacing) continue;
    const sources = [
      ...new Set(
        rules
          .map((rule) => safeText(rule.source, 300))
          .filter((source): source is string => Boolean(source)),
      ),
    ];
    drafts.push({
      detector: "rtl_physical_layout_rules",
      title: `${rules.length} active RTL rules used physical left/right layout properties`,
      severity: "medium",
      score: 64,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        url: redactUrl(safeText(event.d.url, 400)),
        source: sources[0],
        message:
          `The RTL page matched ${rules.length} author CSS rules using physical anchoring and asymmetric physical spacing ` +
          `(${[...properties].sort().join(", ")}). These rules do not mirror with document direction.`,
      }),
      dedupeKey: `rtlphysical:${safeText(event.d.url, 300) ?? event.t}`,
    });
  }
}

function addBrowserNetworkIntegrityCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  addCasefoldIdentityCollisionCandidates(events, index, drafts, exchanges);
  addBlockedDependencyActionCandidates(events, index, drafts, exchanges);
  addAcknowledgedStateContradictionCandidates(index, drafts, exchanges);
  addRequestBurstCandidates(events, index, drafts);
  addStaleClientBuildCandidates(events, index, drafts, exchanges);
  addRtlPhysicalLayoutCandidates(events, index, drafts);
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

// ─── session-bound cart invariants ────────────────────────────────────────────

function cartItemsFromExchange(
  exchange: RequestExchange | undefined,
): Record<string, unknown>[] | undefined {
  if (!exchange?.res || !isSuccessStatus(exchange.status)) return undefined;
  const body = parseStructuredBody(exchange.resBody);
  if (!isRecord(body) || !Array.isArray(body.items)) return undefined;
  const items = body.items.filter(isRecord);
  return items.length === body.items.length ? items : undefined;
}

function itemIdentity(item: Record<string, unknown>): string | undefined {
  return (
    keyValueOf(item.productId) ??
    keyValueOf(item.product_id) ??
    keyValueOf(item.id) ??
    safeText(item.slug, 200)
  );
}

function hasDuplicateCartIdentity(items: Record<string, unknown>[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const identity = itemIdentity(item);
    if (!identity) continue;
    if (seen.has(identity)) return true;
    seen.add(identity);
  }
  return false;
}

function addSessionCartInvariantCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const ordered = [...exchanges.values()].sort(
    (a, b) => a.req.t - b.req.t,
  );
  const cartReads = ordered.filter(
    (exchange) =>
      exchange.method === "GET" &&
      capturedUrlPath(exchange.url) === "/api/cart",
  );

  for (const checkout of ordered) {
    if (
      checkout.method !== "POST" ||
      capturedUrlPath(checkout.url) !== "/api/checkout" ||
      !checkout.res
    )
      continue;
    const response = parseStructuredBody(checkout.resBody);
    if (
      !isRecord(response) ||
      safeText(response.error, 80) !== "empty_cart"
    )
      continue;
    const deletedSession = events.some(
      (event) =>
        event.k === "db.diff" &&
        safeText(event.d.requestId, 120) === checkout.requestId &&
        safeText(event.d.op, 20)?.toLowerCase() === "delete" &&
        bareTableName(safeText(event.d.table, 160) ?? "").toLowerCase() ===
          "sessions",
    );
    if (!deletedSession) continue;
    const before = [...cartReads]
      .reverse()
      .find((read) => read.res && read.res.t < checkout.req.t);
    const after = cartReads.find(
      (read) => read.req.t > (checkout.res?.t ?? checkout.req.t),
    );
    const beforeItems = cartItemsFromExchange(before);
    const afterItems = cartItemsFromExchange(after);
    if (
      !beforeItems ||
      beforeItems.length === 0 ||
      !afterItems ||
      afterItems.length !== 0
    )
      continue;
    drafts.push({
      detector: "cart_lost_after_session_expiry",
      title: `Session expiry erased a non-empty cart during checkout`,
      severity: "high",
      score: DB_INVARIANT_SCORE + 2,
      confidence: "high",
      anchor: removeUndefined({
        t: checkout.res.t,
        offsetMs:
          offsetForEvent(checkout.res) ??
          offsetFromStart(checkout.res.t, index.start),
        route: routeAt(index.navs ?? [], checkout.res.t),
        requestId: checkout.requestId,
        method: checkout.method,
        url: redactUrl(checkout.url),
        status: checkout.status,
        message: `The cart contained ${beforeItems.length} item line${beforeItems.length === 1 ? "" : "s"} immediately before checkout. That checkout deleted the active session and returned empty_cart; the next cart read was empty.`,
      }),
      dedupeKey: `sessioncartloss:${checkout.requestId}`,
    });
  }

  interface Login {
    exchange: RequestExchange;
    userId: string;
    mergedLines: number;
  }
  const logins: Login[] = [];
  for (const exchange of ordered) {
    if (
      exchange.method !== "POST" ||
      capturedUrlPath(exchange.url) !== "/api/login" ||
      !isSuccessStatus(exchange.status)
    )
      continue;
    const body = parseStructuredBody(exchange.resBody);
    if (!isRecord(body) || !isRecord(body.user)) continue;
    const userId = keyValueOf(body.user.id);
    const mergedLines = finiteNumber(body.mergedLines);
    if (userId && mergedLines !== undefined && mergedLines > 0)
      logins.push({ exchange, userId, mergedLines });
  }
  for (let i = 1; i < logins.length; i += 1) {
    const first = logins[i - 1];
    const second = logins[i];
    if (first.userId !== second.userId) continue;
    const firstCart = cartReads.find(
      (read) =>
        read.req.t > (first.exchange.res?.t ?? first.exchange.req.t) &&
        read.req.t < second.exchange.req.t,
    );
    const secondCart = cartReads.find(
      (read) =>
        read.req.t > (second.exchange.res?.t ?? second.exchange.req.t),
    );
    const firstItems = cartItemsFromExchange(firstCart);
    const secondItems = cartItemsFromExchange(secondCart);
    if (
      !firstItems ||
      firstItems.length === 0 ||
      !secondItems ||
      secondItems.length <= firstItems.length ||
      !hasDuplicateCartIdentity(secondItems)
    )
      continue;
    const cartWriteBetween = ordered.some(
      (exchange) =>
        exchange.req.t > (firstCart?.res?.t ?? first.exchange.req.t) &&
        exchange.req.t < (secondCart?.res?.t ?? Number.POSITIVE_INFINITY) &&
        exchange.method !== "GET" &&
        (capturedUrlPath(exchange.url)?.startsWith("/api/cart") ?? false),
    );
    if (cartWriteBetween) continue;
    drafts.push({
      detector: "cart_remerged_on_login",
      title: `Repeated login merged the same guest cart twice`,
      severity: "high",
      score: DB_INVARIANT_SCORE + 2,
      confidence: "high",
      anchor: removeUndefined({
        t: secondCart?.res?.t ?? second.exchange.res?.t ?? second.exchange.req.t,
        offsetMs:
          offsetForEvent(secondCart?.res ?? second.exchange.res) ??
          offsetFromStart(
            secondCart?.res?.t ??
              second.exchange.res?.t ??
              second.exchange.req.t,
            index.start,
          ),
        route: routeAt(
          index.navs ?? [],
          secondCart?.res?.t ??
            second.exchange.res?.t ??
            second.exchange.req.t,
        ),
        requestId: second.exchange.requestId,
        method: second.exchange.method,
        url: redactUrl(second.exchange.url),
        status: second.exchange.status,
        message: `Two successful logins for the same user each reported merged guest lines. The cart grew from ${firstItems.length} to ${secondItems.length} lines and now contains a duplicate product, with no add-to-cart request between the reads.`,
      }),
      dedupeKey: `cartremerge:${second.userId}`,
    });
  }
}

// ─── locale-sensitive input invariants ────────────────────────────────────────

function expectedLocalizedCents(
  raw: string,
  locale: string,
): number | undefined {
  let decimal = ".";
  let groups = new Set<string>();
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
    groups = new Set(
      parts
        .filter((part) => part.type === "group")
        .map((part) => part.value),
    );
  } catch {
    return undefined;
  }
  let normalized = raw.trim();
  for (const group of groups)
    normalized = normalized.split(group).join("");
  normalized = normalized.split(decimal).join(".");
  normalized = normalized.replace(/[^\d.+-]/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : undefined;
}

/**
 * Privacy-safe fallback for a redacted `d,dd` / `dd,dd` money input. The
 * collector retains only length and character class. If the client-submitted
 * cents decode to N whole units after stripping one locale decimal separator,
 * that shape proves the intended two-fraction-digit value was N cents.
 */
function expectedLocalizedCentsFromShape(
  raw: unknown,
  locale: string,
  actualCents: number,
): number | undefined {
  if (
    !isRecord(raw) ||
    !isRedactedPlaceholder(raw) ||
    finiteNumber(raw.len) === undefined ||
    safeText(raw.charset, 40) !== "mixed" ||
    actualCents <= 0 ||
    actualCents % 100 !== 0
  )
    return undefined;
  let decimal = ".";
  try {
    const formatter = new Intl.NumberFormat(locale);
    decimal =
      formatter
        .formatToParts(1.1)
        .find((part) => part.type === "decimal")?.value ?? ".";
  } catch {
    return undefined;
  }
  if (decimal === ".") return undefined;
  const digits = String(actualCents / 100);
  if (finiteNumber(raw.len) !== digits.length + decimal.length) return undefined;
  const expected = Number(digits);
  return Number.isFinite(expected) ? expected : undefined;
}

function addLocaleInputCandidates(
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  for (const exchange of exchanges.values()) {
    if (!exchange.res) continue;
    const request = parseStructuredBody(exchange.body);
    const response = parseStructuredBody(exchange.resBody);
    if (!isRecord(request) || !isRecord(response)) continue;

    const country = safeText(request.country, 20)?.toUpperCase();
    if (
      country &&
      country !== "US" &&
      exchange.status === 400 &&
      safeText(response.error, 80) === "validation_failed" &&
      isRecord(response.errors) &&
      /invalid postal/i.test(safeText(response.errors.postalCode, 160) ?? "")
    ) {
      drafts.push({
        detector: "country_postal_validation_mismatch",
        title: `${country} postal code was rejected by country-agnostic validation`,
        severity: "medium",
        score: 78,
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
          message: `The request explicitly selected country ${country} and supplied a postal code, but validation returned only a generic invalid-postal error. Country-specific formats cannot all satisfy one validation rule.`,
        }),
        dedupeKey: `postalcountry:${country}:${capturedUrlPath(exchange.url) ?? ""}`,
      });
    }

    const locale = safeText(request.locale, 40);
    const actual =
      finiteNumber(request.amountCents) ??
      finiteNumber(request.amount_cents);
    if (
      !isSuccessStatus(exchange.status) ||
      !locale ||
      actual === undefined
    )
      continue;
    const raw = safeText(request.raw, 120);
    const expected = raw
      ? expectedLocalizedCents(raw, locale)
      : expectedLocalizedCentsFromShape(request.raw, locale, actual);
    if (
      expected === undefined ||
      expected <= 0 ||
      actual === expected ||
      actual < expected * 10
    )
      continue;
    const ratio = actual / expected;
    if (!Number.isInteger(ratio)) continue;
    drafts.push({
      detector: "locale_decimal_scale_shift",
      title: `Localized amount was submitted ${ratio}× too large`,
      severity: "critical",
      score: DB_INVARIANT_SCORE + 3,
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
        message: `Locale ${locale} parses the submitted amount to ${expected} cents, but the client sent ${actual} cents and the server accepted it.`,
      }),
      dedupeKey: `localemoney:${locale}:${capturedUrlPath(exchange.url) ?? ""}`,
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

// ─── backend_log_error ───────────────────────────────────────────────────────

/**
 * An error the backend logged and handled sits just under one that escaped: the
 * process kept serving, so the reader is looking at a failure the application
 * expected, but it is still the application naming its own fault with a stack.
 * A fatal line means the app declared the process unusable, which reads at the
 * same level as an uncaught error.
 */
const BACKEND_LOG_FATAL_SCORE = 88;
const BACKEND_LOG_ERROR_SCORE = 82;
const BACKEND_LOG_WARN_SCORE = 52;

/** Field names a logger uses for the id that joins a log line to its request. */
const LOG_REQUEST_ID_FIELDS = [
  "reqId",
  "requestId",
  "request_id",
  "traceId",
  "trace_id",
  "correlationId",
  "x-request-id",
];

/**
 * backend_log_error: the backend logged a failure through its logger.
 *
 * This is what an ordinary server does with a failure it expected — catch it,
 * log it with the stack, answer the request with a status. It reaches no console
 * and crashes nothing, so before `backend.log` existed the whole class was
 * invisible: a session would carry the front end's 503 and no statement at all
 * about why, and a diagnosis had nothing to work from but the status code.
 */
function addBackendLogErrorCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "backend.log") continue;
    const level = safeText(event.d.level, 20);
    if (level !== "error" && level !== "fatal" && level !== "warn") continue;

    const logged = isRecord(event.d.error) ? event.d.error : undefined;
    const message = scrubText(event.d.message, 220);
    const errorMessage = scrubText(logged?.message, 220);
    // The logger's message names the operation ("request failed"); the error's
    // names the cause ("upstream 429"). A title carrying both is the difference
    // between a reader knowing something failed and knowing what did.
    const headline =
      message && errorMessage && errorMessage !== message
        ? `${truncate(message, 90)} — ${truncate(errorMessage, 90)}`
        : (message ?? errorMessage ?? "message unavailable");
    const fields = isRecord(event.d.fields) ? event.d.fields : undefined;
    // The SDK's own stamp is the join key the request span carries; the
    // logger's field (pino's uuid) names a different id space, so it is only
    // a fallback for logs captured outside any request.
    const requestId =
      safeText(event.d.requestId, 120) ??
      (fields
        ? safeText(
            LOG_REQUEST_ID_FIELDS.map((name) => fields[name]).find(
              (value) => typeof value === "string" || typeof value === "number",
            ),
            120,
          )
        : undefined);

    drafts.push({
      detector: "backend_log_error",
      title: `Backend logged ${level}: ${headline}`,
      severity: level === "warn" ? "medium" : "high",
      score:
        level === "fatal"
          ? BACKEND_LOG_FATAL_SCORE
          : level === "error"
            ? BACKEND_LOG_ERROR_SCORE
            : BACKEND_LOG_WARN_SCORE,
      confidence: level === "warn" ? "medium" : "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        status: finiteNumber(fields?.status ?? fields?.statusCode),
        errorCode: safeText(logged?.name, 120),
        message: errorMessage ?? message,
        source: "backend",
        frame: codeFrameOf({
          stk: typeof logged?.stack === "string" ? logged.stack : undefined,
        }),
      }),
      // Content signature, not the timestamp: an upstream that is down is logged
      // on every request and has to read as one finding, not as five hundred.
      dedupeKey: `backendlog:${level}:${normalizeErrorSignature(
        errorMessage ?? message,
      )}`,
    });
  }
}

// ─── click_target_intercepted ────────────────────────────────────────────────

/**
 * High enough to be read, deliberately not high enough to lead.
 *
 * A click landing on something other than the control under the cursor is a real
 * DOM-integrity fact, but on its own it is not a defect: overlays, modals and
 * consent banners intercept clicks correctly all day. It has to outrank the
 * ambient session noise a reader skims past and stay under anything that names an
 * actual fault, so the reader meets it while forming the picture rather than
 * being told it is the answer.
 */
const CLICK_INTERCEPTED_SCORE = 58;

/** How much of the viewport a covering element takes before it is worth saying so. */
const LARGE_COVER_VIEWPORT_PCT = 50;

/**
 * click_target_intercepted: the element that received a click was not the element
 * under the cursor.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY IT WAS NOT BUILT SOONER
 * ============================================================================
 *
 * The collector already captured everything this reads — `covered`, `deep`,
 * `targetNotInStack`, and the boxes — and the bundle already rendered it into the
 * timeline. It was deliberately left as a rendered fact rather than a detector,
 * on the reasoning that a candidate would claim more than the evidence supports.
 *
 * Four eval batches disagreed. In every one, a session whose defect WAS an overlay
 * swallowing the checkout click produced five candidates, none about the click,
 * and a causal structure headed by an unrelated 401 on an unrelated route. The
 * decisive fact sat in a timeline table while every ranked signal pointed
 * somewhere else, and every reader followed the ranked signals. Evidence that is
 * present but never ranked is, in practice, evidence that is absent.
 *
 * ============================================================================
 * WHAT IT CLAIMS
 * ============================================================================
 *
 * Only what was measured: this click landed somewhere other than where it looked
 * like it landed. It does NOT claim an overlay caused the bug, does not correlate
 * against whether a request followed, and does not fire harder when nothing
 * happened afterwards. Each of those would be a narrower, more confident claim
 * than the capture supports, and — worse — would silently decline to surface the
 * fact in every case where the extra condition failed to hold.
 *
 * Generic by construction. Nothing here knows what a checkout is: it reads the
 * hit-test stack the browser reported and says what it said. The same signal
 * covers consent banners over forms, invisible iframes, stale modals, z-index
 * regressions, and full-screen ad frames — the same failure wearing different
 * clothes in every application.
 */
function addClickInterceptedCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "clk") continue;

    const covered = Array.isArray(event.d.covered) ? event.d.covered : [];
    const targetNotInStack = event.d.targetNotInStack === true;
    if (covered.length === 0 && !targetNotInStack) continue;

    const target = isRecord(event.d.el)
      ? (sanitizeSelector(event.d.el.path) ??
        sanitizeSelector(event.d.el.sig) ??
        safeText(event.d.el.tag, 40))
      : undefined;
    const beneath = covered.find((entry) => isRecord(entry));
    const beneathSelector = isRecord(beneath)
      ? (sanitizeSelector(beneath.path) ??
        sanitizeSelector(beneath.sig) ??
        safeText(beneath.tag, 40))
      : undefined;

    const targetBox = isRecord(event.d.box) ? event.d.box : undefined;
    const viewportPct = finiteNumber(targetBox?.viewportPct);
    const dominatesViewport =
      viewportPct !== undefined && viewportPct >= LARGE_COVER_VIEWPORT_PCT;

    // Stated in the order a reader needs it: what took the click, what was under
    // it, and — only when measured — how much of the screen the receiver spans.
    const title = [
      targetNotInStack
        ? "Click landed on an element outside its own hit-test stack"
        : "Click landed on an element covering the control beneath it",
      target ? `received by ${target}` : undefined,
      dominatesViewport ? `spanning ${viewportPct}% of the viewport` : undefined,
      beneathSelector ? `over ${beneathSelector}` : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(", ");

    drafts.push({
      detector: "click_target_intercepted",
      title,
      // `medium` even when the receiver is full-viewport. A bigger covering
      // element makes the fact more legible, not more certainly a defect.
      severity: "medium",
      score: CLICK_INTERCEPTED_SCORE,
      // The measurement is exact; what it means for the application is not.
      confidence: dominatesViewport ? "medium" : "low",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        // The element that RECEIVED the click. `anchor.target` is a structured
        // descriptor rather than a selector string, so the selector belongs here.
        elementLabel: target,
        message: beneathSelector
          ? `covered ${beneathSelector}`
          : undefined,
        source: "browser",
      }),
      // Per target/covered pair, not per timestamp: a shopper clicking a dead
      // button four times is one finding, and four identical candidates would
      // read as four separate defects.
      dedupeKey: `clickintercepted:${target ?? ""}:${beneathSelector ?? ""}`,
    });
  }
}

// ─── checkout correctness ────────────────────────────────────────────────────

const CHECKOUT_CORRECTNESS_SCORE = DB_INVARIANT_SCORE + 5;

function insertedOrderForRequest(
  events: BugEvent[],
  requestId: string,
): BugEvent | undefined {
  return events.find(
    (event) =>
      event.k === "db.diff" &&
      correlationIdOf(event) === requestId &&
      safeText(event.d.op, 20)?.toLowerCase() === "insert" &&
      bareTableName(safeText(event.d.table, 200) ?? "").toLowerCase() ===
        "orders" &&
      isRecord(event.d.after),
  );
}

function addPricingOutcomeContradictionCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const pricing of events) {
    if (
      pricing.k !== "backend.http" ||
      safeText(pricing.d.service, 80)?.toLowerCase() !== "pricing"
    )
      continue;
    const requestId = correlationIdOf(pricing);
    if (!requestId) continue;
    const order = insertedOrderForRequest(events, requestId);
    if (!order || !isRecord(order.d.after)) continue;
    const orderTotal =
      finiteNumber(order.d.after.total_cents) ??
      finiteNumber(order.d.after.totalCents);
    if (orderTotal === undefined) continue;

    const pricingTotal =
      finiteNumber(pricing.d.totalCents) ??
      finiteNumber(pricing.d.total_cents);
    if (
      finiteNumber(pricing.d.status) === 200 &&
      pricingTotal !== undefined &&
      pricingTotal !== orderTotal
    ) {
      drafts.push({
        detector: "pricing_total_ignored_by_checkout",
        title: `Checkout stored ${orderTotal} after pricing returned ${pricingTotal}`,
        severity: "critical",
        score: CHECKOUT_CORRECTNESS_SCORE,
        confidence: "high",
        anchor: removeUndefined({
          t: order.t,
          offsetMs:
            offsetForEvent(order) ?? offsetFromStart(order.t, index.start),
          route: routeAt(index.navs ?? [], order.t),
          requestId,
          table: safeText(order.d.table, 200),
          source: normalizeDbEngine(order.d.engine),
          frame: dbCallsiteFrame(order.d.callsite),
          message:
            `The pricing service returned totalCents=${pricingTotal}, but the correlated orders insert persisted total_cents=${orderTotal}.`,
        }),
        dedupeKey: `pricingtotalignored:${requestId}`,
      });
    }

    const timedOut =
      finiteNumber(pricing.d.status) === 0 &&
      (safeText(pricing.d.errorKind, 80)?.toLowerCase() === "timeout" ||
        /timed?\s*out/i.test(safeText(pricing.d.error, 200) ?? ""));
    if (!timedOut) continue;
    drafts.push({
      detector: "checkout_committed_after_pricing_timeout",
      title: `Checkout committed an order after authoritative pricing timed out`,
      severity: "critical",
      score: CHECKOUT_CORRECTNESS_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: order.t,
        offsetMs:
          offsetForEvent(order) ?? offsetFromStart(order.t, index.start),
        route: routeAt(index.navs ?? [], order.t),
        requestId,
        table: safeText(order.d.table, 200),
        source: normalizeDbEngine(order.d.engine),
        frame: dbCallsiteFrame(order.d.callsite),
        message:
          `The pricing request timed out without returning an authoritative total, but the same request inserted an order with total_cents=${orderTotal}.`,
      }),
      dedupeKey: `pricingtimeoutcommit:${requestId}`,
    });
  }
}

function addNegativeInventoryOrderCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const order of events) {
    if (
      order.k !== "db.diff" ||
      safeText(order.d.op, 20)?.toLowerCase() !== "insert" ||
      bareTableName(safeText(order.d.table, 200) ?? "").toLowerCase() !==
        "orders"
    )
      continue;
    const requestId = correlationIdOf(order);
    if (!requestId) continue;
    const negative = events.find((event) => {
      if (
        event.k !== "db.diff" ||
        correlationIdOf(event) !== requestId ||
        !isRecord(event.d.after)
      )
        return false;
      return Object.entries(event.d.after).some(
        ([field, value]) =>
          /(?:inventory|stock|quantity|qty)/i.test(field) &&
          finiteNumber(value) !== undefined &&
          finiteNumber(value)! < 0,
      );
    });
    if (!negative || !isRecord(negative.d.after)) continue;
    const negativeField = Object.entries(negative.d.after).find(
      ([field, value]) =>
        /(?:inventory|stock|quantity|qty)/i.test(field) &&
        finiteNumber(value) !== undefined &&
        finiteNumber(value)! < 0,
    );
    if (!negativeField) continue;
    drafts.push({
      detector: "order_committed_with_negative_inventory",
      title: `Order committed while ${bareTableName(safeText(negative.d.table, 200) ?? "inventory")}.${negativeField[0]} was ${negativeField[1]}`,
      severity: "critical",
      score: CHECKOUT_CORRECTNESS_SCORE + 1,
      confidence: "high",
      anchor: removeUndefined({
        t: order.t,
        offsetMs:
          offsetForEvent(order) ?? offsetFromStart(order.t, index.start),
        route: routeAt(index.navs ?? [], order.t),
        requestId,
        table: safeText(order.d.table, 200),
        source: normalizeDbEngine(order.d.engine),
        frame: dbCallsiteFrame(order.d.callsite),
        message:
          `The request wrote ${negativeField[0]}=${negativeField[1]} and still inserted an orders row. The oversold checkout was not rolled back.`,
      }),
      dedupeKey: `negativeinventoryorder:${requestId}`,
    });
  }
}

function addCheckoutCorrectnessCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  addPricingOutcomeContradictionCandidates(events, index, drafts);
  addNegativeInventoryOrderCandidates(events, index, drafts);
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

// ─── downstream_succeeded_after_timeout ─────────────────────────────────────

const DOWNSTREAM_SUCCEEDED_AFTER_TIMEOUT_SCORE = 95;
const DOWNSTREAM_TIMEOUT_MATCH_WINDOW_MS = 2_000;

function backendHttpPath(event: BugEvent): string | undefined {
  return (
    capturedUrlPath(safeText(event.d.url, 400)) ??
    capturedUrlPath(safeText(event.d.operation, 200))
  );
}

function otelHttpPath(event: BugEvent): string | undefined {
  const attributes = isRecord(event.d.attributes)
    ? event.d.attributes
    : undefined;
  return (
    capturedUrlPath(safeText(attributes?.["http.target"], 400)) ??
    capturedUrlPath(safeText(attributes?.["http.route"], 400)) ??
    capturedUrlPath(safeText(attributes?.["http.url"], 400))
  );
}

/**
 * downstream_succeeded_after_timeout: the caller gave up, but the downstream
 * service's server span says the same operation completed successfully.
 *
 * This is stronger than a generic timeout: it proves the operation has an
 * ambiguous outcome and may already have committed its side effect.
 */
function addDownstreamSucceededAfterTimeoutCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const successfulServerSpans = events.filter((event) => {
    if (event.k !== OTEL_SPAN_KIND) return false;
    const status = otelHttpStatus(event.d.attributes);
    return status !== undefined && status >= 200 && status < 300;
  });

  for (const timeout of events) {
    if (
      timeout.k !== "backend.http" ||
      safeText(timeout.d.errorKind, 80)?.toLowerCase() !== "timeout" ||
      finiteNumber(timeout.d.status) !== 0
    )
      continue;
    const requestId = correlationIdOf(timeout);
    if (!requestId) continue;
    const path = backendHttpPath(timeout);
    if (!path) continue;
    const service = safeText(timeout.d.service, 120)?.toLowerCase();
    const completed = successfulServerSpans.find((span) => {
      if (correlationIdOf(span) !== requestId) return false;
      if (otelHttpPath(span) !== path) return false;
      if (
        Math.abs(span.t - timeout.t) > DOWNSTREAM_TIMEOUT_MATCH_WINDOW_MS
      )
        return false;
      const spanService = safeText(span.d.serviceName, 160)?.toLowerCase();
      return (
        !service ||
        !spanService ||
        spanService === service ||
        spanService.endsWith(`-${service}`) ||
        spanService.endsWith(`.${service}`)
      );
    });
    if (!completed) continue;
    const status = otelHttpStatus(completed.d.attributes);
    drafts.push({
      detector: "downstream_succeeded_after_timeout",
      title: `Downstream ${path} completed after its caller timed out`,
      severity: "critical",
      score: DOWNSTREAM_SUCCEEDED_AFTER_TIMEOUT_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: completed.t,
        offsetMs:
          offsetForEvent(completed) ??
          offsetFromStart(completed.t, index.start),
        route: routeAt(index.navs ?? [], completed.t),
        requestId,
        method:
          safeText(timeout.d.method, 20)?.toUpperCase() ??
          safeText(completed.d.name, 20)?.toUpperCase(),
        url: redactUrl(path),
        status,
        source: "backend",
        frame: otelCodeFrame(completed.d.attributes),
        message:
          `The caller recorded a timeout for ${service ? `${service} ` : ""}${path}, ` +
          `while the downstream server span completed with HTTP ${status}. ` +
          `The operation may have committed even though the caller treated it as failed.`,
      }),
      dedupeKey: `downstreamtimeout:${service ?? ""}:${path}`,
    });
  }
}

// ─── invalid_webhook_signature_accepted ──────────────────────────────────────

const INVALID_WEBHOOK_SIGNATURE_ACCEPTED_SCORE = 97;

function malformedSha256Signature(
  headers: unknown,
): { header: string; digestLength: number } | undefined {
  if (!isRecord(headers)) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (!/(?:^|-)signature$/i.test(name)) continue;
    const signature = safeText(value, 200);
    const match = signature ? /^sha256=(.*)$/i.exec(signature) : null;
    if (!match) continue;
    const digest = match[1] ?? "";
    if (/^[a-f\d]{64}$/i.test(digest)) continue;
    return { header: name.toLowerCase(), digestLength: digest.length };
  }
  return undefined;
}

function dbCallsiteFrame(callsite: unknown): string | undefined {
  if (!isRecord(callsite)) return undefined;
  return codeFrameOf({
    file: safeText(callsite.file, 300),
    line: finiteNumber(callsite.line),
    col: finiteNumber(callsite.column),
  });
}

/** Prefer the outermost valid host frame for repeated-effect findings. */
function duplicateEffectApplicationFrame(callsite: unknown): string | undefined {
  if (!isRecord(callsite)) return undefined;
  const frames = [
    callsite,
    ...(Array.isArray(callsite.stack) ? callsite.stack.filter(isRecord) : []),
  ];
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = dbCallsiteFrame(frames[index]);
    if (frame) return frame;
  }
  return undefined;
}

const DUPLICATE_EFFECT_DETECTORS = new Set([
  "cart_remerged_on_login",
  "concurrent_duplicate_mutation",
  "duplicate_write",
  "duplicate_charge",
  "duplicate_readback",
]);

function attachDuplicateEffectFrames(
  events: BugEvent[],
  drafts: CandidateDraft[],
): void {
  const diffsByRequest = dbDiffsByRequest(events);
  for (const draft of drafts) {
    if (
      !DUPLICATE_EFFECT_DETECTORS.has(draft.detector) ||
      draft.anchor.frame ||
      !draft.anchor.requestId
    )
      continue;
    const diffs = diffsByRequest.get(draft.anchor.requestId);
    if (!diffs) continue;

    let nearest: { t: number; frame: string } | undefined;
    for (const diff of diffs) {
      const frame = duplicateEffectApplicationFrame(diff.d.callsite);
      if (!frame) continue;
      if (
        !nearest ||
        Math.abs(diff.t - draft.anchor.t) < Math.abs(nearest.t - draft.anchor.t)
      ) {
        nearest = { t: diff.t, frame };
      }
    }
    if (nearest) draft.anchor.frame = nearest.frame;
  }
}

/**
 * invalid_webhook_signature_accepted: a webhook accepted a malformed SHA-256
 * signature and performed a database mutation in that same request.
 *
 * This does not try to recover or verify a secret. A SHA-256 digest has an
 * objective wire shape, so a non-64-hex digest is invalid before HMAC
 * comparison, and a 2xx plus a correlated write proves it was not rejected.
 */
function addInvalidWebhookSignatureAcceptedCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  for (const exchange of exchanges.values()) {
    if (
      exchange.method !== "POST" ||
      !/webhooks?(?:\/|$)/i.test(capturedUrlPath(exchange.url) ?? "") ||
      !isSuccessStatus(exchange.status)
    )
      continue;
    const malformed = malformedSha256Signature(exchange.req.d.hdrs);
    if (!malformed) continue;
    const mutation = events.find(
      (event) =>
        event.k === "db.diff" &&
        correlationIdOf(event) === exchange.requestId &&
        ["insert", "update", "delete"].includes(
          safeText(event.d.op, 20)?.toLowerCase() ?? "",
        ),
    );
    if (!mutation) continue;
    const table = safeText(mutation.d.table, 120);
    drafts.push({
      detector: "invalid_webhook_signature_accepted",
      title: `Webhook with a malformed SHA-256 signature changed the database`,
      severity: "critical",
      score: INVALID_WEBHOOK_SIGNATURE_ACCEPTED_SCORE,
      confidence: "high",
      anchor: removeUndefined({
        t: mutation.t,
        offsetMs:
          offsetForEvent(mutation) ??
          offsetFromStart(mutation.t, index.start),
        route: routeAt(index.navs ?? [], mutation.t),
        requestId: exchange.requestId,
        method: exchange.method,
        url: redactUrl(exchange.url),
        status: exchange.status,
        table,
        source: normalizeDbEngine(mutation.d.engine),
        frame: dbCallsiteFrame(mutation.d.callsite),
        message:
          `${malformed.header} carried a ${malformed.digestLength}-character SHA-256 digest ` +
          `(64 hexadecimal characters are required), but the webhook returned ${exchange.status}` +
          `${table ? ` and mutated ${table}` : " and mutated the database"}.`,
      }),
      dedupeKey:
        `invalidwebhooksig:${capturedUrlPath(exchange.url) ?? ""}:` +
        `${table ?? ""}`,
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

// ─── stale_value_rendered ────────────────────────────────────────────────────

/**
 * A number the page is still showing after the server told it a different one.
 *
 * This is the shape of a whole class of defect that no request-plane rule can see: every request
 * succeeded, every response was correct, and the screen is wrong. A balance updates and the header
 * keeps the old figure; a cache serves a superseded price; a component reads a prop it captured
 * before the mutation. Nothing in the network log looks like a failure, because nothing failed
 * there - the defect lives entirely in the disagreement between the last value sent and the value
 * displayed.
 *
 * The rule is deliberately narrow about what counts as evidence and broad about where it applies.
 * It fires only when the SAME field changed value during the session, so a constant is never a
 * finding, and only when the screen shows an EARLIER value of that field after a later one arrived.
 * A screen number matching nothing, or matching the current value, says nothing either way.
 */
const STALE_VALUE_RENDERED_SCORE = 88;
/** Distinct fields tracked. A response full of numbers must not become a session full of findings. */
const MAX_TRACKED_NUMERIC_FIELDS = 200;
/** Emissions per session. */
const MAX_STALE_VALUE_CANDIDATES = 5;
/** Deepest object level walked in a response body. */
const MAX_NUMERIC_WALK_DEPTH = 6;

/** One value a response carried for one field name, and when it arrived. */
interface NumericFieldObservation {
  value: number;
  t: number;
  path: string;
}

/**
 * Numeric leaves of a response body that name ONE quantity, keyed by endpoint and field name.
 *
 * Two scoping rules, and both are load-bearing rather than tidiness. Keyed by endpoint because
 * `total` on the cart and `total` on the ledger are different quantities that happen to share a
 * word. And a name that appears more than once in a SINGLE response is dropped outright: that is a
 * per-row field on a collection - a price on each of seven products - and comparing one row's value
 * against another row's over time reports every list as stale. That exact false positive is what
 * this function was rewritten to remove, after the first version reported five product prices and
 * missed the balance the case was about.
 */
function collectNumericFields(
  exchanges: Map<string, RequestExchange>,
): Map<string, NumericFieldObservation[]> {
  const byKey = new Map<string, NumericFieldObservation[]>();
  /** Keys proven to be per-row rather than scalar, and therefore not comparable over time. */
  const repeated = new Set<string>();

  for (const exchange of exchanges.values()) {
    if (!exchange.res || !isSuccessStatus(exchange.status)) continue;
    const payload = responsePayload(exchange.resBody, exchange.resBodyMeta);
    if (payload === undefined) continue;
    const endpoint = capturedUrlPath(exchange.url ?? "") ?? "";
    const t = exchange.res.t;
    const inThisResponse = new Map<string, NumericFieldObservation>();
    const countedHere = new Set<string>();

    const walk = (value: unknown, name: string, path: string, depth: number): void => {
      if (depth > MAX_NUMERIC_WALK_DEPTH) return;
      if (typeof value === "number") {
        if (!Number.isFinite(value) || !name) return;
        const key = `${endpoint}\u0000${name}`;
        if (countedHere.has(key)) {
          repeated.add(key);
          return;
        }
        countedHere.add(key);
        inThisResponse.set(key, { value, t, path });
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, name, path, depth + 1);
        return;
      }
      if (!isRecord(value)) return;
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, key.toLowerCase(), path ? `${path}.${key}` : key, depth + 1);
      }
    };

    walk(payload, "", "", 0);

    for (const [key, observation] of inThisResponse) {
      if (!byKey.has(key) && byKey.size >= MAX_TRACKED_NUMERIC_FIELDS) continue;
      const list = byKey.get(key) ?? [];
      list.push(observation);
      byKey.set(key, list);
    }
  }

  for (const key of repeated) byKey.delete(key);
  for (const list of byKey.values()) list.sort((a, b) => a.t - b.t);
  return byKey;
}

/**
 * Whether a displayed number and a stored number are the same quantity.
 *
 * The x100 relation is currency minor units, which is close to universal in payment and ledger
 * APIs: the server keeps cents and the screen shows dollars. Nothing else is allowed, because a
 * looser tolerance would let any two numbers of similar magnitude match and the rule would report
 * coincidences.
 */
function sameQuantity(shown: number, stored: number): boolean {
  if (shown === stored) return true;
  return Math.abs(shown * 100 - stored) < 0.5;
}

function addStaleValueRenderedCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const fields = collectNumericFields(exchanges);
  if (fields.size === 0) return;

  const emitted: CandidateDraft[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.k !== "ui.num") continue;
    for (const item of uiNumItems(event)) {
      for (const [key_, observations] of fields) {
        const name = key_.slice(key_.indexOf("\u0000") + 1);
        // A field that never changed cannot be shown stale, and checking it first keeps the common
        // case (ids, counts, constants) out of the inner comparison entirely.
        const before = observations.filter((entry) => entry.t <= event.t);
        if (before.length < 2) continue;
        const current = before[before.length - 1];
        const earlier = before
          .slice(0, -1)
          .find((entry) => entry.value !== current.value && sameQuantity(item.value, entry.value));
        if (!earlier) continue;
        if (sameQuantity(item.value, current.value)) continue;

        const key = `stalevalue:${name}:${item.label}`;
        if (seen.has(key)) continue;
        seen.add(key);

        emitted.push({
          detector: "stale_value_rendered",
          title: `The page is showing a superseded value for ${item.label}`,
          severity: "high",
          score: STALE_VALUE_RENDERED_SCORE,
          confidence: "high",
          anchor: removeUndefined({
            t: event.t,
            offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
            route: routeAt(index.navs ?? [], event.t),
            elementLabel: scrubText(item.label, 120),
            message: scrubText(
              `\`${item.label}\` reads ${item.value} on screen. The last value the server sent for ` +
                `\`${current.path || name}\` was ${current.value}, ${Math.round(event.t - current.t)} ms ` +
                `earlier; ${earlier.value} is what that field held before it changed. Every request ` +
                `succeeded, so the disagreement is between the response and what was rendered from it.`,
              400,
            ),
          }),
          dedupeKey: key,
        });
      }
    }
  }

  drafts.push(
    ...emitted
      .sort((a, b) => a.anchor.t - b.anchor.t)
      .slice(0, MAX_STALE_VALUE_CANDIDATES),
  );
}

// ─── displayed_field_mismatch ────────────────────────────────────────────────

/**
 * The page put the wrong field of the right record on screen.
 *
 * A gift card labelled "Balance" showing the amount it was issued with. A cart labelled "Total"
 * showing the subtotal. An account labelled "Available" showing the limit. Every request succeeded
 * and every response was correct, so nothing on the request plane is a finding - and the value on
 * screen is not stale either, because the server never sent it for that field. It sent it for a
 * DIFFERENT field of the same record, which is the whole defect and also names its own fix.
 *
 * The rule needs three things to agree before it says anything: a label that matches one field of a
 * record by name, a displayed value that does not match that field, and a sibling field of the same
 * record that it does match. Two of the three is a coincidence; all three is a wiring mistake.
 */
const DISPLAYED_FIELD_MISMATCH_SCORE = 92;
/** Emissions per session. */
const MAX_DISPLAYED_FIELD_MISMATCH_CANDIDATES = 5;

/** Numeric fields of one record from one response, with whatever identifies the record. */
interface ResponseRecord {
  /** Field name (lowercased, no separators) to value. */
  fields: Map<string, number>;
  /** Original field names, for a message that quotes what the developer wrote. */
  originalNames: Map<string, string>;
  /** Human identity of the record, when it carries one. */
  identity?: string;
  t: number;
}

/** `balance_cents` / `balanceCents` / `BalanceCents` all compare as `balance`. */
function comparableFieldName(name: string): string {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Minor-unit and quantity suffixes name the representation, not the quantity. Stripping them is
  // what lets a label of "Balance" reach a field called `balanceCents`.
  return compact.replace(/(cents|amount|value|count|qty|quantity)$/, "") || compact;
}

/** Records carried by every successful response in the session. */
function collectResponseRecords(
  exchanges: Map<string, RequestExchange>,
): ResponseRecord[] {
  const records: ResponseRecord[] = [];

  const walk = (value: unknown, depth: number, t: number): void => {
    if (depth > MAX_NUMERIC_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1, t);
      return;
    }
    if (!isRecord(value)) return;

    const fields = new Map<string, number>();
    const originalNames = new Map<string, string>();
    let identity: string | undefined;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        const name = comparableFieldName(key);
        // First occurrence wins, so `balance` is not overwritten by a later `balanceDue`.
        if (!fields.has(name)) {
          fields.set(name, entry);
          originalNames.set(name, key);
        }
      } else if (
        typeof entry === "string" &&
        identity === undefined &&
        /^(code|sku|reference|number|name|title|label)$/.test(key.toLowerCase())
      ) {
        identity = safeText(entry, 60);
      } else {
        walk(entry, depth + 1, t);
      }
    }
    // Two numeric fields minimum: a record with one number has no sibling to be confused with.
    if (fields.size >= 2) {
      records.push(removeUndefined({ fields, originalNames, identity, t }) as ResponseRecord);
    }
  };

  for (const exchange of exchanges.values()) {
    if (!exchange.res || !isSuccessStatus(exchange.status)) continue;
    const payload = responsePayload(exchange.resBody, exchange.resBodyMeta);
    if (payload === undefined) continue;
    walk(payload, 0, exchange.res.t);
  }

  return records;
}

function addDisplayedFieldMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  exchanges: Map<string, RequestExchange>,
): void {
  const records = collectResponseRecords(exchanges);
  if (records.length === 0) return;

  const emitted: CandidateDraft[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.k !== "ui.num") continue;
    for (const item of uiNumItems(event)) {
      const labelName = comparableFieldName(item.label);
      if (labelName.length < 3) continue;

      for (const record of records) {
        if (record.t > event.t) continue;
        const named = record.fields.get(labelName);
        if (named === undefined || sameQuantity(item.value, named)) continue;

        const sibling = [...record.fields].find(
          ([name, value]) => name !== labelName && sameQuantity(item.value, value),
        );
        if (!sibling) continue;

        const key = `displayedfield:${item.label}:${sibling[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const namedField = record.originalNames.get(labelName) ?? labelName;
        const siblingField = record.originalNames.get(sibling[0]) ?? sibling[0];
        emitted.push({
          detector: "displayed_field_mismatch",
          title: `\`${item.label}\` on screen is showing \`${siblingField}\`, not \`${namedField}\``,
          severity: "high",
          score: DISPLAYED_FIELD_MISMATCH_SCORE,
          confidence: "high",
          anchor: removeUndefined({
            t: event.t,
            offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
            route: routeAt(index.navs ?? [], event.t),
            elementLabel: scrubText(item.label, 120),
            message: scrubText(
              `The page shows ${item.value} beside "${item.label}"` +
                (record.identity ? ` for ${record.identity}` : "") +
                `. The response carries \`${namedField}\` = ${named} and \`${siblingField}\` = ${sibling[1]} ` +
                `on that same record, and what is displayed is the second one. Every request ` +
                `succeeded and the response is correct, so the wrong field is being read where it ` +
                `is rendered.`,
              400,
            ),
          }),
          dedupeKey: key,
        });
      }
    }
  }

  drafts.push(
    ...emitted
      .sort((a, b) => a.anchor.t - b.anchor.t)
      .slice(0, MAX_DISPLAYED_FIELD_MISMATCH_CANDIDATES),
  );
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

/**
 * Cumulative registrations and removals per event type, when the capture
 * carries them.
 *
 * `undefined` means the reading does not record churn — an older SDK, or a
 * bundle captured before the collector kept these counters. It NEVER means the
 * counters were zero, and no caller may render it as zero: "nothing was
 * removed" and "removals were not counted" are different statements, and only
 * one of them is evidence.
 */
function listenerChurnByType(
  event: BugEvent,
): Map<string, { added: number; removed: number }> | undefined {
  const churnByType = event.d.churnByType;
  if (!Array.isArray(churnByType)) return undefined;
  const churn = new Map<string, { added: number; removed: number }>();
  for (const entry of churnByType) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const type = safeText(entry[0], 60);
    const added = finiteNumber(entry[1]);
    const removed = finiteNumber(entry[2]);
    if (!type || added === undefined || removed === undefined) continue;
    churn.set(type, { added, removed });
  }
  return churn.size > 0 ? churn : undefined;
}

/**
 * What the census RECORDED about one event type between two readings, as a
 * sentence — or the honest statement that it recorded nothing, when either
 * reading lacks the counters.
 *
 * The span is the whole session between the two readings rather than the path
 * they were taken on, and that is stated.
 *
 * The counters are cumulative and monotone WITHIN one instrumented run, and
 * that is the only condition under which the two readings describe one span:
 * registrations minus removals over it is then exactly the change in the live
 * count. A capture where the collector was torn down and started again mid-page
 * breaks it — the later reading's counters begin at zero, so subtracting gives
 * a negative or an incoherent pair. That is checked here rather than assumed,
 * and a span that fails the check is UNMEASURED, which reads as the degraded
 * wording. Clamping the subtraction instead would have manufactured the exact
 * false zero this whole change exists to remove.
 */
function describeListenerChurn(
  type: string,
  first: BugEvent,
  last: BugEvent,
  liveDelta: number,
): string {
  const before = listenerChurnByType(first)?.get(type);
  const after = listenerChurnByType(last)?.get(type);
  const added = after && before ? after.added - before.added : undefined;
  const removed = after && before ? after.removed - before.removed : undefined;
  if (
    added === undefined ||
    removed === undefined ||
    added < 0 ||
    removed < 0 ||
    added - removed !== liveDelta
  ) {
    return (
      `This capture records the live count only — registrations and removals were not ` +
      `counted separately over that span — so whether any cleanup ran is not observed here. ` +
      `The same rising curve is produced by a subscription per mount that is never removed, ` +
      `and by one whose removals simply do not keep up.`
    );
  }
  const observed =
    `Over that span the census recorded ${added} registration${added === 1 ? "" : "s"} ` +
    `of a "${type}" listener and ${removed} removal${removed === 1 ? "" : "s"}, across the whole session.`;
  if (removed === 0) {
    return (
      `${observed} No removal of a "${type}" listener was recorded at any point in it, so ` +
      `nothing in the session was seen to release one.`
    );
  }
  return `${observed} Removals were recorded, but fewer than registrations over the same span.`;
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
      const first = readings[0].event;
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
            `${describeListenerChurn(type, first, last, series[series.length - 1] - series[0])} ` +
            `Every handler still registered fires again on each event, so the work is ` +
            `repeated once per earlier visit.`,
        }),
        dedupeKey: `listenerstaircase:${path}:${type}`,
      });
    }
  }
}

// ─── job_did_not_complete ────────────────────────────────────────────────────

/** How many job findings one session may carry. */
const MAX_JOB_CANDIDATES = 3;
/** A job that failed outright. */
const JOB_FAILED_SCORE = 66;
/** A job that decided there was nothing to do. */
const JOB_SKIPPED_SCORE = 58;
/** A job that started and never reported an ending. */
const JOB_UNFINISHED_SCORE = 52;

/**
 * job_did_not_complete: the request succeeded and the work it promised did not happen.
 *
 * This is the signature of a large share of enterprise defects and it is invisible from the request
 * plane alone: the user clicked, the server answered 200, the confirmation appeared, and the job
 * behind it failed, skipped itself, or never reported back. Nothing in the session looks wrong.
 * The order simply has no payment against it.
 *
 * A `skipped` run is ranked as a finding rather than as normal operation on purpose. "Nothing to do"
 * is exactly what a job says when the record it was supposed to act on is missing, and treating it
 * as success is how the defect stays hidden.
 */
function addJobOutcomeCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const started = new Map<string, BugEvent>();
  const emitted: CandidateDraft[] = [];

  const keyOf = (event: BugEvent): string =>
    `${safeText(event.d.job, 160) ?? "job"}:${safeText(event.d.jobId, 128) ?? ""}`;

  for (const event of events) {
    if (event.k === "backend.job.start") {
      started.set(keyOf(event), event);
      continue;
    }
    if (event.k !== "backend.job.end" && event.k !== "backend.job.error")
      continue;

    started.delete(keyOf(event));
    const job = safeText(event.d.job, 160) ?? "job";
    const outcome = safeText(event.d.outcome, 20);
    const failed = event.k === "backend.job.error" || outcome === "failure";
    if (!failed && outcome !== "skipped") continue;

    const detail = isRecord(event.d.error)
      ? (safeText(event.d.error.message, 300) ?? safeText(event.d.error.name, 120))
      : safeText(event.d.result, 300);

    emitted.push({
      detector: "job_did_not_complete",
      title: failed
        ? `Background job ${job} failed after the request had already succeeded`
        : `Background job ${job} decided there was nothing to do`,
      severity: failed ? "high" : "medium",
      score: failed ? JOB_FAILED_SCORE : JOB_SKIPPED_SCORE,
      confidence: failed ? "high" : "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        requestId: safeText(event.d.requestId, 128),
        message: scrubText(
          failed
            ? `The job ${job} ran and failed. The request that enqueued it had already returned, so the session shows a success the application never finished delivering.${detail ? ` It reported: ${detail}` : ""}`
            : `The job ${job} ran and skipped its work. "Nothing to do" is what a job says when the record it was meant to act on is missing, so the confirmation the user saw may describe work that never happened.${detail ? ` It reported: ${detail}` : ""}`,
          400,
        ),
      }),
      dedupeKey: `jobincomplete:${job}:${outcome ?? "failed"}`,
    });
  }

  // A job that started and never ended is the same finding arrived at from the other side: nothing
  // says it failed, and nothing says it worked.
  for (const [, event] of started) {
    const job = safeText(event.d.job, 160) ?? "job";
    emitted.push({
      detector: "job_did_not_complete",
      title: `Background job ${job} started and never reported an ending`,
      severity: "medium",
      score: JOB_UNFINISHED_SCORE,
      confidence: "low",
      anchor: removeUndefined({
        t: event.t,
        offsetMs: offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        requestId: safeText(event.d.requestId, 128),
        message: scrubText(
          `The job ${job} started and the session ended with no completion, failure or error recorded against it. Whether the work happened cannot be told from this capture; that it was not reported is itself the finding.`,
          400,
        ),
      }),
      dedupeKey: `jobunfinished:${job}`,
    });
  }

  emitted
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_JOB_CANDIDATES)
    .forEach((draft) => drafts.push(draft));
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
    // Both push transports, because the finding is a property of a STREAM and not of a protocol:
    // it dropped, it came back, and nothing replayed the gap. Server-sent events and WebSockets
    // report the same `op`/`reopen` shape for exactly this reason.
    if (event.k !== "net.sse" && event.k !== "net.ws") continue;
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
  if (Array.isArray(frames)) {
    const innermost = frames[0];
    if (isRecord(innermost)) {
      const framed = codeFrameOf({
        file: safeText(innermost.file, 300),
        line: finiteNumber(innermost.line),
        col: finiteNumber(innermost.column),
      });
      if (framed) return framed;
    }
  }
  // A console.error'd Error carries a raw stack but no structured frames, so
  // the anchor pointed at nothing while the file:line sat in the string. Unlike
  // structured frames, a raw stack is unfiltered — skip runtime and dependency
  // lines so the frame is one the reader's own tree contains. Read raw, NOT
  // through safeText: it collapses the newlines this split depends on.
  const stack =
    typeof error.stack === "string" ? error.stack.slice(0, 8000) : undefined;
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes("node_modules") || line.includes("node:")) continue;
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

/** Context used to judge a client-error response by its captured consequences. */
interface ClientErrorContext {
  t: number;
  requestId?: string;
  status?: number;
  method?: string;
  url?: string;
}

function isClientErrorStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status <= 499;
}

function eventMethod(event: BugEvent): string | undefined {
  return (
    safeText(event.d.m, 20) ??
    safeText(event.d.method, 20) ??
    safeText(event.d.httpMethod, 20)
  )?.toUpperCase();
}

function eventTarget(event: BugEvent): string | undefined {
  return (
    redactUrl(event.d.url) ??
    redactUrl(event.d.pathname) ??
    redactUrl(event.d.route)
  );
}

function sameOperation(
  context: ClientErrorContext,
  event: BugEvent,
): boolean {
  const method = context.method?.toUpperCase();
  const target = context.url;
  return (
    method !== undefined &&
    target !== undefined &&
    eventMethod(event) === method &&
    eventTarget(event) === target
  );
}

function sameRequestId(
  left: string | undefined,
  right: string | undefined,
  graph?: CausalGraph,
): boolean {
  if (!left || !right) return false;
  return (
    left === right ||
    graph?.requestIdAliases?.[left] === right ||
    graph?.requestIdAliases?.[right] === left
  );
}

function causalNodeKindForEvent(event: BugEvent): string | undefined {
  if (event.k === "err" || event.k === "rej") return "frontend.error";
  if (event.k === "con") {
    return safeText(event.d.lv, 20)?.toLowerCase().startsWith("err")
      ? "console.error"
      : undefined;
  }
  if (event.k === "backend.req.error" || event.k === "backend.uncaught")
    return "backend.error";
  if (event.k === "backend.req.start" || event.k === "backend.req.end")
    return "backend.req";
  if (event.k === "backend.otel.span") return "otel.span";
  if (event.k === "backend.otel.log") return "otel.log";
  if (event.k === "net.res") return "net.res";
  return undefined;
}

function eventNodeForCausalGraph(
  event: BugEvent,
  graph: CausalGraph,
): { id: string; requestId?: string } | undefined {
  const kind = causalNodeKindForEvent(event);
  if (!kind) return undefined;
  const requestId = requestIdForEvent(event);
  return graph.nodes.find(
    (node) =>
      node.kind === kind &&
      (node.t === event.t ||
        sameRequestId(node.requestId, requestId, graph)),
  );
}

function hasCausalPath(
  graph: CausalGraph,
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const pending = [from];
  const visited = new Set([from]);
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      if (next === to) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(next);
    }
  }
  return false;
}

function eventIsCausalClientErrorConsequence(
  context: ClientErrorContext,
  event: BugEvent,
  causalGraph?: CausalGraph,
): boolean {
  if (!isFailureSurfaceEvent(event)) return false;
  if (sameRequestId(context.requestId, requestIdForEvent(event), causalGraph))
    return true;
  if (causalGraph) {
    const source = causalGraph.nodes.find(
      (node) =>
        node.kind === "net.res" &&
        node.t === context.t &&
        sameRequestId(node.requestId, context.requestId, causalGraph),
    );
    const target = eventNodeForCausalGraph(event, causalGraph);
    return source !== undefined && target !== undefined
      ? hasCausalPath(causalGraph, source.id, target.id)
      : false;
  }
  // Legacy callers do not pass the graph. Keep close surfaced errors
  // compatible, but do not reuse the 45-second candidate window.
  return event.t >= context.t && event.t - context.t <= CAUSAL_MAP_WINDOW_MS;
}

function isFailureSurfaceEvent(event: BugEvent): boolean {
  if (
    event.k === "err" ||
    event.k === "rej" ||
    event.k === "net.err" ||
    event.k === "backend.req.error" ||
    event.k === "backend.uncaught" ||
    event.k === "native-crash"
  )
    return true;
  if (event.k === "con") {
    return safeText(event.d.lv, 20)?.toLowerCase().startsWith("err") ?? false;
  }
  if (event.k === "net.res") {
    return (finiteNumber(event.d.st) ?? 0) >= 500;
  }
  if (event.k === "backend.req.end") {
    return (finiteNumber(event.d.statusCode) ?? 0) >= 500;
  }
  if (event.k === "backend.otel.span") {
    return (
      event.d.statusCode === "ERROR" ||
      (otelHttpStatus(event.d.attributes) ?? 0) >= 500
    );
  }
  if (event.k === "backend.otel.log") {
    const severityNumber = finiteNumber(event.d.severityNumber);
    const severityText = safeText(event.d.severityText, 40)?.toUpperCase();
    return (
      (severityNumber !== undefined && severityNumber >= 17) ||
      severityText === "ERROR" ||
      severityText === "FATAL"
    );
  }
  return false;
}

/**
 * A 4xx is consumed when the captured consequence is clean. The rule is
 * deliberately status-agnostic inside 4xx: no route, body, endpoint, or
 * application name can make a response routine.
 *
 * Required negative evidence:
 * - no later surfaced failure or server failure in the candidate window
 * - no repeat of the same operation, which is the observable retry signal
 *
 * The capture has no source-level branch event, so treating a completed
 * response with no adverse consequence as consumed is the only generic
 * decision available. A session that ends immediately after it is still not
 * evidence that a person saw a defect.
 */
function isConsumedClientError(
  context: ClientErrorContext,
  events: BugEvent[],
  causalGraph?: CausalGraph,
): boolean {
  if (!isClientErrorStatus(context.status)) return false;
  const end = context.t + CLIENT_ERROR_CONSEQUENCE_WINDOW_MS;
  for (const event of events) {
    if (event.t < context.t || event.t > end) continue;
    if (eventIsCausalClientErrorConsequence(context, event, causalGraph))
      return false;
    if (
      event.t > context.t &&
      event.t <= context.t + CLIENT_ERROR_RETRY_WINDOW_MS &&
      (event.k === "net.req" || event.k === "backend.req.start") &&
      sameOperation(context, event)
    )
      return false;
  }
  return true;
}

function isClientErrorDraft(draft: CandidateDraft): boolean {
  return (
    (draft.detector === "http_error" ||
      draft.detector === "backend_http_client_error") &&
    isClientErrorStatus(draft.anchor.status)
  );
}

function sameClientErrorOperation(
  left: CandidateDraft,
  right: CandidateDraft,
): boolean {
  return (
    left.anchor.method !== undefined &&
    left.anchor.method === right.anchor.method &&
    (left.anchor.url ?? left.anchor.route) !== undefined &&
    (left.anchor.url ?? left.anchor.route) ===
      (right.anchor.url ?? right.anchor.route)
  );
}

function draftsAreCausallyRelated(
  left: CandidateDraft,
  right: CandidateDraft,
  attribution: Map<string, CandidateAttribution> | undefined,
  causalGraph?: CausalGraph,
): boolean {
  if (sameRequestId(left.anchor.requestId, right.anchor.requestId, causalGraph))
    return true;
  const leftAttr = attribution?.get(left.dedupeKey);
  const rightAttr = attribution?.get(right.dedupeKey);
  return (
    leftAttr?.rootCauseId === right.dedupeKey ||
    rightAttr?.rootCauseId === left.dedupeKey ||
    leftAttr?.causes?.includes(right.dedupeKey) === true ||
    rightAttr?.causes?.includes(left.dedupeKey) === true
  );
}

/**
 * Remove consumed client errors before dedupe so they cannot mint a candidate
 * or a canonical issue. A different detector keeps the 4xx only when it shares
 * the failed request or a causal graph thread, never because its anchor happens
 * to fall inside the reader's evidence window.
 */
function removeConsumedClientErrors(
  drafts: CandidateDraft[],
  events: BugEvent[],
  causalGraph?: CausalGraph,
  attribution?: Map<string, CandidateAttribution>,
): void {
  const kept: CandidateDraft[] = [];
  for (const draft of drafts) {
    if (!isClientErrorDraft(draft)) {
      kept.push(draft);
      continue;
    }

    const context: ClientErrorContext = {
      t: draft.anchor.t,
      requestId: draft.anchor.requestId,
      status: draft.anchor.status,
      method: draft.anchor.method,
      url: draft.anchor.url ?? draft.anchor.route,
    };
    const otherDetectorFired = drafts.some(
      (other) =>
        other !== draft &&
        !isClientErrorDraft(other) &&
        draftsAreCausallyRelated(draft, other, attribution, causalGraph),
    );
    const operationRetried = drafts.some(
      (other) =>
        other !== draft &&
        isClientErrorDraft(other) &&
        sameClientErrorOperation(draft, other) &&
        Math.abs(other.anchor.t - draft.anchor.t) <=
          CLIENT_ERROR_RETRY_WINDOW_MS,
    );
    if (
      isConsumedClientError(context, events, causalGraph) &&
      !otherDetectorFired &&
      !operationRetried
    )
      continue;

    // Preserve one counted finding for an operation that had a consequence. The
    // request id distinguishes attempts for evidence, not separate defects.
    draft.dedupeKey = `client4xx:${draft.detector}:${draft.anchor.method ?? ""}:${draft.anchor.url ?? draft.anchor.route ?? ""}:${draft.anchor.status ?? ""}`;
    kept.push(draft);
  }
  drafts.splice(0, drafts.length, ...kept);
}

// ─── acknowledged_write_never_landed ─────────────────────────────────────────

/**
 * One under {@link DB_INVARIANT_SCORE}: the contradiction is between an HTTP
 * acknowledgement and the database plane rather than between two images of the
 * same row, exactly as {@link ACKNOWLEDGED_WRITE_LOST_SCORE} is.
 */
const ACKNOWLEDGED_WRITE_NEVER_LANDED_SCORE = 88;

/** Mutating methods whose 2xx is a promise that something was stored. */
const CREATING_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * acknowledged_write_never_landed: the server said "created" and stored nothing.
 *
 * A mutating request answered 201 — or 2xx with a created-entity id in its body —
 * that read the instrumented database during the request and wrote nothing to it.
 * The client is handed an id it can neither fetch nor use again. Nothing errors,
 * no counter disagrees, and the row is simply absent, so the report arrives days
 * later as "the record I saved is gone".
 *
 * Both halves are already captured and were never joined: the acknowledgement is
 * on `backend.req.end`, and the absence of any `db.diff` under the same request
 * id is the other half.
 *
 * Silent unless the session wrote SOMETHING somewhere — without that, an absence
 * only means write instrumentation was never live. Reads under the request id
 * raise confidence rather than gate the finding: a handler that aborts before its
 * first statement, which is exactly the swallowed-transaction shape this targets,
 * leaves no read behind either.
 */
function addAcknowledgedWriteNeverLandedCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const wrote = new Set<string>();
  const read = new Set<string>();
  for (const event of events) {
    const requestId = safeText(event.d.requestId, 120);
    if (!requestId) continue;
    if (event.k === "db.diff") wrote.add(requestId);
    else if (event.k === "db.read" || event.k === "db.read.bulk")
      read.add(requestId);
  }
  // No writes anywhere means no write instrumentation. An absence proves nothing.
  if (wrote.size === 0) return;

  for (const event of events) {
    if (event.k !== "backend.req.end") continue;
    const method = safeText(event.d.method, 20);
    if (!method || !CREATING_METHODS.has(method.toUpperCase())) continue;
    const status = finiteNumber(event.d.statusCode);
    if (!isSuccessStatus(status)) continue;
    // 201 is the unambiguous case: the status itself claims a resource exists
    // now. A plain 200 needs the body to make the same claim, and a backend-only
    // request has no captured body, so it is left alone.
    if (status !== 201) continue;

    const requestId = safeText(event.d.requestId, 120);
    if (!requestId) continue;
    if (wrote.has(requestId)) continue;
    const readDuringRequest = read.has(requestId);

    const target =
      redactUrl(event.d.pathname) ?? redactUrl(event.d.route) ?? "the endpoint";
    drafts.push({
      detector: "acknowledged_write_never_landed",
      title: `Created nothing: ${method} ${target} answered 201 with no database write`,
      severity: "high",
      score: ACKNOWLEDGED_WRITE_NEVER_LANDED_SCORE,
      confidence: readDuringRequest ? "high" : "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        method,
        url: target,
        status,
        message:
          `${method} ${target} answered 201, so the client was told a record now exists. ` +
          `The request produced no write to any table${readDuringRequest ? ", though it did read one" : ""}, ` +
          `while other requests in this session did write — the acknowledgement is the only trace of it.`,
        source: "backend",
      }),
      // Endpoint-keyed: a form submitted four times produces one finding.
      dedupeKey: `ackwritenever:${target}:${method}`,
    });
  }
}

// ─── api_route_returned_document ─────────────────────────────────────────────

/** Paths a client parses as data rather than rendering. */
const API_PATH = /(^|\/)(api|graphql|rest|v\d+)(\/|$)/i;

/** A response body that is an HTML document rather than data. */
const HTML_DOCUMENT = /^\s*(<!doctype html|<html[\s>])/i;

/**
 * api_route_returned_document: a data endpoint answered with a web page.
 *
 * The mirror of {@link addContentTypeBodyMismatchCandidates}, and the more
 * expensive direction. A route under `/api` is served by a static or catch-all
 * handler that renders the application shell, so the call succeeds — 200 or 201,
 * the work committed — and the client's `JSON.parse` throws. Whatever the client
 * does with a parse failure is what the user reports: a generic error page, a
 * failed-upload toast, a retry loop. The operation worked every time.
 *
 * Fires on the content type alone when the path is an API path, because a
 * redacted body is the normal case and the declared type is already proof. When
 * the body did survive capture, it has to look like a document.
 */
function addApiRouteReturnedDocumentCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  requestById: Map<string, RequestInfo>,
): void {
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const status = finiteNumber(event.d.st);
    if (!isSuccessStatus(status)) continue;
    const type = mediaType(headerValue(event, "content-type"));
    if (type !== "text/html") continue;

    const transportId = networkRequestId(event.d.id);
    const req = transportId ? requestById.get(transportId) : undefined;
    const url = redactUrl(req?.url);
    if (!url || !API_PATH.test(url)) continue;

    // A body that survived redaction has to corroborate. A redacted one is
    // neither corroboration nor a disproof, so the content type stands alone.
    const body = typeof event.d.body === "string" ? event.d.body : undefined;
    if (body && !HTML_DOCUMENT.test(body) && !/\[REDACTED\]/.test(body))
      continue;

    drafts.push({
      detector: "api_route_returned_document",
      title: `Data endpoint returned a web page: ${req?.method ?? "GET"} ${titleUrl(req?.url) ?? url}`,
      severity: "high",
      score: 82,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId: safeText(event.d.requestId, 120),
        method: req?.method,
        url,
        status,
        message:
          `${req?.method ?? "GET"} ${url} returned ${status} with content-type text/html. ` +
          `The call succeeded and any write it performed is committed, but a caller parsing ` +
          `this as JSON throws — the failure the user sees belongs to the parse, not to the request.`,
      }),
      // Path only: the query is the request's data, not the endpoint's identity,
      // so one endpoint serving HTML is one finding however it was parameterised.
      dedupeKey: `apidocument:${titleUrl(url) ?? url}`,
    });
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
  // The span the key covers, which the surviving draft's own anchor cannot report: it is the
  // earliest by construction.
  const lastTByKey = new Map<string, number>();
  for (const draft of drafts) {
    countByKey.set(draft.dedupeKey, (countByKey.get(draft.dedupeKey) ?? 0) + 1);
    const seenLast = lastTByKey.get(draft.dedupeKey);
    if (seenLast === undefined || draft.anchor.t > seenLast)
      lastTByKey.set(draft.dedupeKey, draft.anchor.t);
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
    const latest = lastTByKey.get(draft.dedupeKey);
    if (latest !== undefined && latest > draft.anchor.t) draft = { ...draft, lastT: latest };
    // Emitted only when it says something: `occurrences: 1` on every candidate
    // is noise in a payload an agent has to read.
    return count > 1 ? { ...draft, occurrences: count } : draft;
  });
}

/**
 * How many candidates one detector may hold before the rest of its output is
 * deferred behind every other detector's first findings.
 *
 * Measured problem: a session with a repeating failure spends the cap on it. In
 * one 19k-event capture, `http_error` (76), `backend_http_client_error` (41),
 * `backend_http_error` (34) and `network_error` (19) took 170 of 200 slots,
 * overwhelmingly the same two URLs — and the only candidate naming the actual
 * frontend race was pushed off the end. The 71st copy of one 404 tells an agent
 * nothing the 10th did not; a detector that fired once may be the answer.
 */
const DETECTOR_FAIR_SHARE = 10;

/**
 * Truncates to the cap, but rations by detector first.
 *
 * Pass one takes each detector's best `DETECTOR_FAIR_SHARE` in rank order; pass
 * two backfills the remaining room with everything deferred, still in rank
 * order. With few detectors firing this is exactly the old behaviour — the
 * rationing only binds when one detector is crowding others out.
 */
function capWithDetectorDiversity(ordered: CandidateDraft[]): void {
  if (ordered.length <= MAX_EVIDENCE_CANDIDATES) return;

  const rank = new Map<CandidateDraft, number>();
  ordered.forEach((draft, position) => rank.set(draft, position));
  const perDetector = new Map<string, number>();
  const kept: CandidateDraft[] = [];
  const deferred: CandidateDraft[] = [];

  for (const draft of ordered) {
    const seen = perDetector.get(draft.detector) ?? 0;
    if (seen < DETECTOR_FAIR_SHARE && kept.length < MAX_EVIDENCE_CANDIDATES) {
      perDetector.set(draft.detector, seen + 1);
      kept.push(draft);
    } else {
      deferred.push(draft);
    }
  }

  for (const draft of deferred) {
    if (kept.length >= MAX_EVIDENCE_CANDIDATES) break;
    kept.push(draft);
  }

  // Restore rank order: the two passes interleave detectors, and consumers read
  // this list as ranked.
  kept.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  ordered.splice(0, ordered.length, ...kept);
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
      if (candidate.recovery) {
        lines.push(
          `* Recovery: ${
            candidate.recovery.status === "recovered"
              ? `recovered ${candidate.recovery.afterMs} ms later`
              : candidate.recovery.status === "not_recovered"
                ? "not recovered in the observed session"
                : `unknown (${candidate.recovery.reason.replaceAll("_", " ")})`
          }`,
        );
      }
      // The file and line is the shortest path from "something broke" to an open
      // editor, and it was reaching candidates.jsonl but not the markdown this
      // file tells every reader to start from.
      if (candidate.anchor.frame)
        lines.push(`* Source: ${candidate.anchor.frame}`);
      if (candidate.anchor.elementLabel)
        lines.push(`* Element: ${candidate.anchor.elementLabel}`);
      if (candidate.anchor.elementSignature)
        lines.push(`* Element signature: ${candidate.anchor.elementSignature}`);
      // Causal structure (CP4): additive per-candidate lines from the CP3 re-rank fields.
      if (candidate.causalRole)
        lines.push(`* Causal role: ${candidate.causalRole}`);
      // WHY an isolated candidate is isolated has been computed and recorded since the attributor
      // learned to tell the three cases apart, and no document ever printed it — so a reader of
      // this file saw `isolated` and could not tell "nothing of this kind was in the session" from
      // "something was, and this candidate lost it to another signal". The support grade in the
      // rendered bundle says how far to trust the finding; this line says what produced that.
      if (candidate.causalRole === "isolated" && candidate.isolationCause)
        lines.push(`* Isolation cause: ${candidate.isolationCause}`);
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
    ...(candidate.recovery
      ? [
          `- Recovery: ${
            candidate.recovery.status === "recovered"
              ? `recovered ${candidate.recovery.afterMs} ms later`
              : candidate.recovery.status === "not_recovered"
                ? "not recovered in the observed session"
                : `unknown (${candidate.recovery.reason.replaceAll("_", " ")})`
          }`,
        ]
      : []),
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

/**
 * A browser-local network id is a bare run of digits — `nextId++` from the page's
 * network collector. A shared correlation id never is: it is either a 32 hex
 * character W3C trace id or a `req_`-prefixed token. Consumers on the other side
 * of the bundle read the shape to tell the two apart, so a correlation id that
 * happened to be all digits would be read as a page counter and is refused here.
 */
const LOCAL_NETWORK_ID_SHAPE = /^\d+$/;

/**
 * The identity to join one network exchange on.
 *
 * Prefers the shared correlation id (`X-Crumbtrail-Request-Id`, stamped on the
 * request, response and error of the same exchange by the browser collector and
 * echoed by the backend), because that is the only id both planes hold. The
 * browser-local sequence number is the fallback for an exchange that carried no
 * correlation headers — it restarts at 1 on every page load, so it can only ever
 * join browser events to each other.
 */
function requestIdForValue(value: Record<string, unknown>): string | undefined {
  const correlationId = safeText(
    value.requestId,
    CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  );
  if (
    correlationId !== undefined &&
    !LOCAL_NETWORK_ID_SHAPE.test(correlationId)
  )
    return correlationId;

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

/**
 * A typed redaction marker: `[REDACTED]`, or the capture policy's richer
 * `[REDACTED:email:17]` form naming the class it removed and how long it was.
 */
const TYPED_REDACTION_MARKER = /\[redacted(?::([a-z_-]+))?(?::\d+)?\]/gi;

/** An email address inside prose. */
const EMAIL_IN_TEXT =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** A v4-shaped uuid. */
const UUID_IN_TEXT =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** A run of hex long enough to be a digest, a chunk hash or a request id. */
const LONG_HEX_IN_TEXT = /\b[0-9a-f]{12,}\b/gi;

/**
 * A prefixed opaque id — `ord_7885f1c8`, `cus_a91f`, `req_0f2c8d`. The prefix is a
 * type name, the suffix is one occurrence, and only the prefix means anything to a
 * reader.
 */
const PREFIXED_ID_IN_TEXT = /\b[a-z][a-z0-9]{1,9}_([a-z0-9]{6,})\b/gi;

/**
 * The suffix must carry a digit: that is what separates a generated id from an ordinary
 * snake_case identifier, and `payment_declined` names a fault a title should keep.
 */
function dropPrefixedIds(source: string): string {
  return source.replace(PREFIXED_ID_IN_TEXT, (match, suffix: string) =>
    /\d/.test(suffix) ? REMOVED : match,
  );
}

/**
 * A headline stripped of everything that belongs to ONE occurrence rather than to the
 * fault itself.
 *
 * A title is a permanent name. `Backend HTTP 500 from GET /varying: Checkout failed for
 * order ord_7885f1c8 (user [REDACTED:email:17], flag "beta_pricing" enabled)` promoted
 * one order's id and an internal marker — a thing the capture policy wrote for machines
 * — into that name, so the next eight occurrences of the same fault each proposed a
 * different name for it.
 *
 * Typed markers become the class word they named (`[REDACTED:email:17]` → `email`), which
 * keeps the sentence readable where deleting it would leave "user ,". A bare `[REDACTED]`
 * and every volatile token are dropped outright, then the punctuation the removal
 * stranded is tidied so the result reads as a sentence rather than as wreckage.
 */
/**
 * Where a volatile token stood. A private-use code point, so the tidy pass can tell
 * punctuation stranded by a removal from punctuation the message's author wrote, and so
 * nothing in an ordinary message can be mistaken for it.
 */
const REMOVED = "\uE000";

/** A bracket group holding nothing but removals and the punctuation between them. */
const EMPTIED_GROUP = /[([][\uE000\s,;]*[)\]]/g;

function sanitizeTitle(title: string): string {
  const stripped = dropPrefixedIds(
    title
      .replace(TYPED_REDACTION_MARKER, (_match, kind?: string) =>
        kind ? kind.toLowerCase().replace(/[_-]+/g, " ") : REMOVED,
      )
      .replace(EMAIL_IN_TEXT, REMOVED)
      .replace(UUID_IN_TEXT, REMOVED)
      .replace(LONG_HEX_IN_TEXT, REMOVED),
  );
  if (!stripped.includes(REMOVED)) return title;

  const tidied = stripped
    // A bracket group left holding nothing but removals goes with them. Matched on the
    // marker rather than on emptiness, so `Buffer() is deprecated` — where the empty
    // parentheses ARE the message — keeps its own.
    .replace(EMPTIED_GROUP, (group) => (group.includes(REMOVED) ? "" : group))
    .split(REMOVED)
    .join("")
    .replace(/\s+([,;.)\]])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .replace(/,\s*(?=[,;)\]])/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\s:,;-]+$/, "")
    .trim();

  // A title emptied by the strip says less than the one it replaced, so the original
  // stands in that case — the same trade `titleElementLabel` already makes.
  return tidied || title;
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
