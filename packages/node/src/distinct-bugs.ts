import { hashString } from "crumbtrail-core";
import type { BugEvent, TargetDescriptor } from "crumbtrail-core";
import type {
  EvidenceCandidate,
  FailureRecovery,
  SupportGrade,
} from "./evidence-index";
import type { IsolationCause } from "./causal-graph";
import { redactedNetworkBodySnippet } from "./network-body";

export const DISTINCT_BUGS_SCHEMA_VERSION = 1 as const;

export type DistinctBugSeverity = EvidenceCandidate["severity"];

/**
 * A reference back to one ranked {@link EvidenceCandidate} that contributed to a distinct bug.
 * Carries only already-redacted, candidate-derived fields so the grouped view re-exposes nothing.
 */
export interface DistinctBugEvidenceRef {
  candidateId: string;
  detector: string;
  t: number;
  offsetMs?: number;
  requestId?: string;
  method?: string;
  status?: number;
  route?: string;
  /**
   * The failing REQUEST's url, already redacted at candidate-build time. Kept
   * beside `route` (the page the request was made from) rather than folded into
   * it: on a single-page app every request shares one page route, so the page
   * alone cannot tell two unrelated failures apart.
   */
  url?: string;
  target?: TargetDescriptor;
  message?: string;
}

/**
 * One DISTINCT, labeled bug a single session hit, grouped deterministically from the ranked
 * evidence candidates. Front-end and back-end evidence are split so the bug carries its correlated
 * window; correlated requests/traces share one bug via {@link DistinctBug.requestIds}.
 */
export interface DistinctBug {
  schemaVersion: typeof DISTINCT_BUGS_SCHEMA_VERSION;
  bugId: string;
  title: string;
  severity: DistinctBugSeverity;
  firstSeen: number;
  lastSeen: number;
  window: { start: number; end: number };
  requestIds: string[];
  representative: {
    title: string;
    detector: string;
    severity: DistinctBugSeverity;
    message?: string;
    route?: string;
    /**
     * The failing REQUEST's url, carried from the winning candidate's anchor
     * and already redacted there (query values are stripped before it is ever
     * set). `route` is the PAGE; this is the resource that failed, and it is
     * what a consumer needs to key one incident to one endpoint instead of
     * merging every failure that happened on one single-page-app page.
     */
    url?: string;
    method?: string;
    status?: number;
    target?: TargetDescriptor;
    requestId?: string;
    /**
     * `file:line:col` of the failing code, carried from the winning candidate's
     * anchor. This is the one field that answers "where do I open the editor",
     * so it travels with the bug rather than staying behind on the candidate.
     */
    frame?: string;
    /**
     * How much of the session's evidence stands behind THIS representative — carried from the
     * representative candidate, never aggregated over the cluster.
     *
     * It lives here, beside `title` and `detector`, because those come from the representative too
     * while `DistinctBug.severity` is a cluster MAX. A support grade taken as a cluster max would
     * print a reassuring word next to a headline belonging to a member the graph could not place
     * at all — the same defect this field exists to close, one field over. Keying a reader-facing
     * string on the wrong member of a group is a mistake this codebase has already made and paid
     * for once.
     */
    support?: SupportGrade;
    /** Whether the failing operation recovered later in the observed session. */
    recovery?: FailureRecovery;
    /**
     * WHY the representative could not be attached, carried from the representative candidate for
     * exactly the reasons `support` above is — and only ever set when `support` is `unattached`,
     * because the question does not arise otherwise.
     *
     * The grade says how far to trust the headline; this says what produced that grade, which is
     * the difference between "nothing of this kind was in the session" and "something was, and
     * this signal lost it to another finding". Those call for opposite next moves and the reader
     * was being shown neither.
     */
    isolationCause?: IsolationCause;
    /**
     * What holds the node this representative lost, when `isolationCause` is `lost-contention`.
     *
     * Resolved against the FULL emitted candidate list, whose id space `contention.heldBy` already
     * speaks, so the name is exact rather than inferred. Absent when the holder is not among the
     * emitted candidates — the reason then stands alone, which is true, rather than naming an
     * incumbent that cannot be resolved.
     */
    isolationHeldBy?: { candidateId: string; detector: string };
    /** Bounded, redacted payload evidence for this representative's failed request. */
    bodySnippet?: { request?: string; response?: string };
  };
  frontendEvidence: DistinctBugEvidenceRef[];
  backendEvidence: DistinctBugEvidenceRef[];
  dbDiffs?: DistinctBugEvidenceRef[];
  candidateIds: string[];
  /**
   * Number of distinct occurrences that collapsed into this bug when the same signal recurred across
   * multiple page URLs (for example one blocked-beacon rejection per navigation). Present only when
   * the collapse spanned more than one URL; a single-URL bug omits it.
   */
  occurrenceCount?: number;
  /** Sorted, already-redacted list of the affected page routes when a bug spans multiple URLs. */
  affectedUrls?: string[];
}

export interface DistinctBugRecurrenceInput {
  bug: DistinctBug;
  session: {
    sessionId: string;
    dir?: string;
    app?: string;
    tenant?: string;
    release?: string;
    build?: string;
    start?: number;
  };
}

export interface DistinctBugRecurrenceOccurrence {
  sessionId: string;
  bugId: string;
  title: string;
  severity: DistinctBugSeverity;
  firstSeen: number;
  lastSeen: number;
  app?: string;
  tenant?: string;
  release?: string;
  build?: string;
  dir?: string;
}

/**
 * A label rollup that distinguishes "no sessions carried this label" from
 * "sessions carried it and we do not know the value".
 *
 * A bare `string[]` cannot: a session finalized without `meta.app` contributed
 * nothing to the list and left no marker, so `apps: []` answered "which apps
 * does this affect" with "none" when the true answer was "one, unnamed". A
 * person reading a dashboard sees a blank; an agent reading JSON sees zero.
 */
export interface DistinctBugRecurrenceLabels {
  /** Distinct label values, sorted. */
  known: string[];
  /** Sessions in this recurrence whose label was not recorded. */
  unknown: number;
}

export interface DistinctBugRecurrence {
  signature: string;
  title: string;
  severity: DistinctBugSeverity;
  first_seen: number;
  last_seen: number;
  session_count: number;
  release_span?: { first: string; last: string; label: string };
  apps: DistinctBugRecurrenceLabels;
  /**
   * Omitted entirely when no session in the recurrence carried a tenant, which
   * is every self-hosted single-tenant store. `tenants: []` there was a claim
   * about a dimension that does not exist in that deployment.
   */
  tenants?: DistinctBugRecurrenceLabels;
  occurrences: DistinctBugRecurrenceOccurrence[];
}

/**
 * Detectors whose evidence is a row image, named outside the `db_` convention.
 *
 * The per-request invariant detectors belong on the db plane with the generic
 * surfacing: their evidence IS a row image, so a reader filtering a distinct
 * bug's db evidence must see the detector that named the bug, not only the
 * writes around it. `db_mutation` and `db_field_divergence` are carried by the
 * prefix; `duplicate_write` is the one that is not.
 */
const DB_PLANE_DETECTORS = new Set(["duplicate_write"]);

/**
 * Which plane observed a detector's evidence, decided by the detector's NAME.
 *
 * This used to be a two-entry allowlist (`otel_span_error`, `otel_log_error`)
 * with everything else filed as frontend, so the entire first-party server
 * lane — every `backend_*` detector — landed in `frontendEvidence`. An issue
 * titled "Backend HTTP 500 from POST /internal/invoices/finalize" persisted
 * `{frontend: 1, backend: 0}`, telling a reader the server plane recorded
 * nothing about a failure the server plane is the only witness to.
 *
 * Naming is the authority because the SDK's own detector vocabulary already
 * follows it, and because the cloud (`canonical-evidence.ts#detectorPlane`)
 * now attributes planes by exactly these prefixes. Deciding it the same way at
 * both ends means a detector added on either side is counted correctly the day
 * it ships, with no list to keep in sync. A detector outside the prefixes was
 * observed in the page: network failures are seen by the browser even when the
 * fault is server-side, and full-stack linkage already ties those to the
 * server plane through `requestId`.
 */
export type EvidencePlane = "frontend" | "backend" | "db";

export function detectorPlane(detector: string | undefined): EvidencePlane {
  if (!detector) return "frontend";
  const name = detector.toLowerCase();
  if (
    name.startsWith("db_") ||
    name.startsWith("otel_db_") ||
    DB_PLANE_DETECTORS.has(name)
  )
    return "db";
  if (name.startsWith("backend_") || name.startsWith("otel_")) return "backend";
  return "frontend";
}

// Detectors whose failures share one root cause regardless of which page they fired on. A blocked
// third-party fetch (classic "Unhandled rejection: Failed to fetch") repeats once per navigation, so
// its per-URL candidates must collapse into ONE ranked bug (with an occurrence count and the list of
// affected URLs) instead of N separate high-severity entries. These cluster by
// `(detector + normalized signature)` ONLY — route and time-window are ignored — so every occurrence
// folds together while per-occurrence evidence windows are preserved on the merged bug.
const ROUTE_AGNOSTIC_DETECTORS = new Set(["unhandled_rejection"]);

// Two non-correlated candidates with the same normalized signature but anchored more than this far
// apart are treated as separate bugs ("nearby time window" clustering). Correlated candidates
// (shared requestId/traceId) always collapse into one bug regardless of spacing.
const CLUSTER_WINDOW_MS = 60_000;

const SEVERITY_RANK: Record<DistinctBugSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

interface ClusterMember {
  candidate: EvidenceCandidate;
}

interface Cluster {
  /** Stable, deterministic dedup key; hashed into the bugId. Never embeds a wall-clock value. */
  key: string;
  members: ClusterMember[];
}

/**
 * Groups detector signals into DISTINCT bugs deterministically.
 *
 * Grouping key heuristics (deterministic, order-independent):
 *  - Candidates sharing a correlated `anchor.requestId` (Crumbtrail request id or W3C trace id)
 *    collapse into ONE bug, so the front-end signal and its back-end span/log land together.
 *  - Remaining candidates cluster by `(detector + normalized message/error signature + component
 *    signature)` within a {@link CLUSTER_WINDOW_MS} time window. Identical signatures far apart in
 *    time become separate bugs (disambiguated with a stable `#n` suffix so their ids never collide).
 *
 * The `bugId` is `bug_<hash>` where the hash is a stable FNV-1a digest of the dedup key — identical
 * input always yields identical ids and ordering. Bugs are sorted by severity desc, then firstSeen
 * asc, then bugId asc.
 */
export function groupDistinctBugs(
  candidates: EvidenceCandidate[],
  events: BugEvent[] = [],
): DistinctBug[] {
  // Deterministic processing order: time asc, score desc, id asc. Independent of input order.
  const ordered = [...candidates].sort(
    (a, b) =>
      a.anchor.t - b.anchor.t || b.score - a.score || a.id.localeCompare(b.id),
  );

  const byRequest = new Map<string, Cluster>();
  const routeAgnosticBySignature = new Map<string, Cluster>();
  const openBySignature = new Map<string, Cluster>();
  const signatureUseCount = new Map<string, number>();
  const clusters: Cluster[] = [];

  for (const candidate of ordered) {
    const requestId = candidate.anchor.requestId;
    if (requestId) {
      const key = `req:${requestId}`;
      let cluster = byRequest.get(key);
      if (!cluster) {
        cluster = { key, members: [] };
        byRequest.set(key, cluster);
        clusters.push(cluster);
      }
      cluster.members.push({ candidate });
      continue;
    }

    // Route-agnostic collapse: same detector + normalized signature folds into ONE bug across every
    // page URL and any time gap (no component/route or CLUSTER_WINDOW split). This is what pulls the
    // N per-navigation "Failed to fetch" rejections into a single ranked signal.
    if (ROUTE_AGNOSTIC_DETECTORS.has(candidate.detector)) {
      const key = `sig:${candidate.detector}|${normalizeSignature(candidate)}`;
      let cluster = routeAgnosticBySignature.get(key);
      if (!cluster) {
        cluster = { key, members: [] };
        routeAgnosticBySignature.set(key, cluster);
        clusters.push(cluster);
      }
      cluster.members.push({ candidate });
      continue;
    }

    const base = `sig:${candidate.detector}|${normalizeSignature(candidate)}|${componentSignature(candidate)}`;
    const open = openBySignature.get(base);
    if (open && candidate.anchor.t - lastSeenOf(open) <= CLUSTER_WINDOW_MS) {
      open.members.push({ candidate });
      continue;
    }

    const used = signatureUseCount.get(base) ?? 0;
    signatureUseCount.set(base, used + 1);
    const key = used === 0 ? base : `${base}#${used}`;
    const cluster: Cluster = { key, members: [{ candidate }] };
    openBySignature.set(base, cluster);
    clusters.push(cluster);
  }

  // Built over EVERY candidate, not over a cluster: the node a candidate lost is routinely held by
  // a finding that clustered elsewhere.
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate] as const),
  );
  const bugs = foldRepeatedRequestClusters(clusters).map((cluster) =>
    buildBug(cluster, events, candidatesById),
  );
  bugs.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.firstSeen - b.firstSeen ||
      a.bugId.localeCompare(b.bugId),
  );
  return bugs;
}

/**
 * Folds request-keyed clusters whose members carry the same signatures into one
 * bug.
 *
 * Clustering keys on the request id first, which is right for an incident whose
 * evidence spans planes: that request's frontend response, backend status and
 * database write belong together. It is wrong for a failure that simply
 * repeated. Four identical `Network error from GET /api/claims/coverage`
 * rejections arrive on four request ids and became four bugs carrying the
 * *same* recurrence signature — the signature was computed and then not grouped
 * on, so a caller asking "what distinct bugs are in this session" was handed the
 * same one four times.
 *
 * A repeat is not always a singleton: an intermittent write path that trips two
 * detectors per attempt produces N request clusters of two members each, all
 * describing one defect. So the fold key is the whole member signature set, not
 * just the one candidate — request clusters that agree on every member collapse,
 * and a cluster whose combination of signals is unique stays on its own.
 */
function foldRepeatedRequestClusters(clusters: Cluster[]): Cluster[] {
  const out: Cluster[] = [];
  const foldedBySignature = new Map<string, Cluster>();

  for (const cluster of clusters) {
    if (!cluster.key.startsWith("req:")) {
      out.push(cluster);
      continue;
    }
    const key = clusterSignatureKey(cluster);
    const existing = foldedBySignature.get(key);
    if (existing) {
      existing.members.push(...cluster.members);
      continue;
    }
    // Keyed on the signature rather than the request, so the bugId is stable
    // across runs where the same failure lands on different request ids.
    const folded: Cluster = { key, members: [...cluster.members] };
    foldedBySignature.set(key, folded);
    out.push(folded);
  }

  return out;
}

/** Order-independent identity of everything a request cluster observed. */
function clusterSignatureKey(cluster: Cluster): string {
  const parts = cluster.members
    .map(
      ({ candidate }) =>
        `${candidate.detector}|${normalizeSignature(candidate)}|${componentSignature(candidate)}`,
    )
    .sort();
  return `sig:${parts.join(" ")}`;
}

export function buildDistinctBugSignature(
  bug: Pick<DistinctBug, "title" | "representative">,
): string {
  return computeDistinctBugSignatures(bug).current;
}

/**
 * Computes the versioned recurrence signature and the pre-versioning value for
 * a bug. Consumers can use `legacy` to match rows created before route and
 * message normalization was tightened.
 */
export function computeDistinctBugSignatures(
  bug: Pick<DistinctBug, "title" | "representative">,
): { current: string; legacy: string } {
  const detector = bug.representative?.detector ?? "unknown";
  const route = bug.representative?.route ?? "";
  const message =
    bug.representative?.message ?? bug.representative?.title ?? bug.title;
  return {
    current: `bugsig2:${hashString(`${detector}|${normalizeRecurrenceText(message)}|${normalizeRecurrenceRoute(route)}`)}`,
    legacy: `bugsig:${hashString(`${detector}|${normalizeLegacyRecurrenceText(message)}|${normalizeLegacyRecurrenceText(route)}`)}`,
  };
}

export function groupDistinctBugRecurrences(
  inputs: DistinctBugRecurrenceInput[],
): DistinctBugRecurrence[] {
  const bySignature = new Map<string, DistinctBugRecurrenceOccurrence[]>();
  for (const input of inputs) {
    const signature = buildDistinctBugSignature(input.bug);
    const occurrence = removeUndefined({
      sessionId: input.session.sessionId,
      bugId: input.bug.bugId,
      title: input.bug.title,
      severity: input.bug.severity,
      firstSeen: absoluteSeen(input.bug.firstSeen, input.session.start),
      lastSeen: absoluteSeen(input.bug.lastSeen, input.session.start),
      app: input.session.app,
      tenant: input.session.tenant,
      release: input.session.release,
      build: input.session.build,
      dir: input.session.dir,
    }) as DistinctBugRecurrenceOccurrence;
    bySignature.set(signature, [
      ...(bySignature.get(signature) ?? []),
      occurrence,
    ]);
  }

  const recurrences: DistinctBugRecurrence[] = [];
  for (const [signature, occurrences] of bySignature) {
    const ordered = [...occurrences].sort(
      (a, b) =>
        a.firstSeen - b.firstSeen ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.bugId.localeCompare(b.bugId),
    );
    const uniqueSessions = new Set(
      ordered.map((occurrence) => occurrence.sessionId),
    );
    const releaseSpan = buildReleaseSpan(
      ordered
        .map((occurrence) => occurrence.release)
        .filter((value): value is string => Boolean(value)),
    );
    const severity = ordered
      .map((occurrence) => occurrence.severity)
      .reduce(
        (max, current) =>
          SEVERITY_RANK[current] > SEVERITY_RANK[max] ? current : max,
        "low" as DistinctBugSeverity,
      );
    recurrences.push(
      removeUndefined({
        signature,
        title: ordered[0]?.title ?? signature,
        severity,
        first_seen: Math.min(
          ...ordered.map((occurrence) => occurrence.firstSeen),
        ),
        last_seen: Math.max(
          ...ordered.map((occurrence) => occurrence.lastSeen),
        ),
        session_count: uniqueSessions.size,
        release_span: releaseSpan,
        apps: labelCoverage(ordered, (occurrence) => occurrence.app),
        tenants: presentOrUndefined(
          labelCoverage(ordered, (occurrence) => occurrence.tenant),
        ),
        occurrences: ordered,
      }) as DistinctBugRecurrence,
    );
  }

  return recurrences.sort(
    (a, b) =>
      b.session_count - a.session_count ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.first_seen - b.first_seen ||
      a.signature.localeCompare(b.signature),
  );
}

/**
 * The candidate holding the node `candidate` lost, named so a reader can find it.
 *
 * A bare candidate id is a reference into `CANDIDATES.md`, a document the rendered bundle's reader
 * is never given — naming the holder only by id would move the same "the answer is in a file you
 * do not have" failure one field over. The id travels WITH the detector, never instead of it.
 */
function holderOf(
  candidate: EvidenceCandidate,
  candidatesById: Map<string, EvidenceCandidate>,
): { candidateId: string; detector: string } | undefined {
  const heldBy = candidate.contention?.heldBy;
  if (heldBy === undefined) return undefined;
  const holder = candidatesById.get(heldBy);
  if (!holder) return undefined;
  return { candidateId: holder.id, detector: holder.detector };
}

function buildBug(
  cluster: Cluster,
  events: BugEvent[],
  candidatesById: Map<string, EvidenceCandidate>,
): DistinctBug {
  const candidates = cluster.members.map((member) => member.candidate);
  // Representative = highest score, then earliest, then lowest id (deterministic).
  const representative = [...candidates].sort(
    (a, b) =>
      b.score - a.score || a.anchor.t - b.anchor.t || a.id.localeCompare(b.id),
  )[0];

  const firstSeen = Math.min(
    ...candidates.map((candidate) => candidate.anchor.t),
  );
  const lastSeen = Math.max(
    ...candidates.map((candidate) => candidate.anchor.t),
  );
  const windowStart = Math.min(
    ...candidates.map((candidate) => candidate.evidenceWindow.start),
  );
  const windowEnd = Math.max(
    ...candidates.map((candidate) => candidate.evidenceWindow.end),
  );
  const severity = candidates
    .map((candidate) => candidate.severity)
    .reduce(
      (max, current) =>
        SEVERITY_RANK[current] > SEVERITY_RANK[max] ? current : max,
      "low" as DistinctBugSeverity,
    );

  const requestIds = Array.from(
    new Set(
      candidates
        .map((candidate) => candidate.anchor.requestId)
        .filter((id): id is string => id !== undefined),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const refs = candidates.map(toEvidenceRef);
  const frontendEvidence = refs.filter(
    (ref) => detectorPlane(ref.detector) === "frontend",
  );
  const backendEvidence = refs.filter(
    (ref) => detectorPlane(ref.detector) === "backend",
  );
  const dbDiffs = refs.filter((ref) => detectorPlane(ref.detector) === "db");

  const candidateIds = candidates
    .map((candidate) => candidate.id)
    .sort((a, b) => a.localeCompare(b));

  // When one signal recurred across multiple page URLs (the collapsed beacon-rejection case), surface
  // an occurrence count and the affected routes so the single ranked bug still reports its spread.
  const affectedUrls = Array.from(
    new Set(
      candidates
        .map((candidate) => candidate.anchor.route)
        .filter(
          (route): route is string => typeof route === "string" && route !== "",
        ),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const bug: DistinctBug = {
    schemaVersion: DISTINCT_BUGS_SCHEMA_VERSION,
    bugId: `bug_${hashString(cluster.key)}`,
    title: representative.title,
    severity,
    firstSeen,
    lastSeen,
    window: { start: windowStart, end: windowEnd },
    requestIds,
    representative: removeUndefined({
      title: representative.title,
      detector: representative.detector,
      severity: representative.severity,
      message: representative.anchor.message,
      route: representative.anchor.route,
      url: representative.anchor.url,
      method: representative.anchor.method,
      status: representative.anchor.status,
      target: representative.anchor.target,
      requestId: representative.anchor.requestId,
      frame: representative.anchor.frame,
      support: representative.support,
      recovery: representative.recovery,
      // Gated on the grade the row actually renders, not on `causalRole`: `support` is optional
      // for read-back from an artifact written before it existed, and a row reading
      // `not-assessed` beside a reason for isolation would contradict itself in two adjacent
      // cells. One condition makes the two structurally unable to disagree.
      isolationCause:
        representative.support === "unattached"
          ? representative.isolationCause
          : undefined,
      isolationHeldBy:
        representative.support === "unattached" &&
        representative.isolationCause === "lost-contention"
          ? holderOf(representative, candidatesById)
          : undefined,
      bodySnippet: failedRequestBodySnippet(representative, events),
    }) as DistinctBug["representative"],
    frontendEvidence,
    backendEvidence,
    ...(dbDiffs.length > 0 ? { dbDiffs } : {}),
    candidateIds,
    ...(affectedUrls.length > 1
      ? { occurrenceCount: candidates.length, affectedUrls }
      : {}),
  };
  return bug;
}

/**
 * Reuses the evidence-window association rule: a request id is authoritative;
 * legacy id-less events are usable only when exactly one response/error matches.
 * This prevents same-millisecond failures from borrowing another request's body.
 */
function failedRequestBodySnippet(
  candidate: EvidenceCandidate,
  events: BugEvent[],
): { request?: string; response?: string } | undefined {
  const anchor = failedNetworkAnchor(candidate, events);
  if (!anchor) return undefined;

  const requestId = candidate.anchor.requestId ?? requestIdForEvent(anchor);
  const request = requestId
    ? events.find(
        (event) =>
          event.k === "net.req" && requestIdForEvent(event) === requestId,
      )
    : undefined;
  const bodySnippet = removeUndefined({
    request: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
    response:
      anchor.k === "net.res"
        ? redactedNetworkBodySnippet(anchor.d.body, anchor.d.bodySummary)
        : undefined,
  });
  return bodySnippet.request || bodySnippet.response ? bodySnippet : undefined;
}

function failedNetworkAnchor(
  candidate: EvidenceCandidate,
  events: BugEvent[],
): BugEvent | undefined {
  const id = candidate.anchor.requestId;
  const matchingEvents = id
    ? events.filter(
        (event) =>
          (event.k === "net.res" || event.k === "net.err") &&
          requestIdForEvent(event) === id,
      )
    : events.filter(
        (event) =>
          event.t === candidate.anchor.t &&
          (event.k === "net.res" || event.k === "net.err") &&
          (candidate.anchor.status === undefined ||
            event.k !== "net.res" ||
            event.d.st === candidate.anchor.status),
      );
  if (matchingEvents.length !== 1) return undefined;

  const [anchor] = matchingEvents;
  if (anchor.k === "net.err") return anchor;
  const status = finiteNumber(anchor.d.st);
  return status !== undefined &&
    (status >= 400 || candidate.detector === "app_2xx_failure")
    ? anchor
    : undefined;
}

function requestIdForEvent(event: BugEvent): string | undefined {
  const id = event.d.id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function toEvidenceRef(candidate: EvidenceCandidate): DistinctBugEvidenceRef {
  return removeUndefined({
    candidateId: candidate.id,
    detector: candidate.detector,
    t: candidate.anchor.t,
    offsetMs: candidate.anchor.offsetMs,
    requestId: candidate.anchor.requestId,
    method: candidate.anchor.method,
    status: candidate.anchor.status,
    route: candidate.anchor.route,
    url: candidate.anchor.url,
    target: candidate.anchor.target,
    message: candidate.anchor.message,
  }) as DistinctBugEvidenceRef;
}

function lastSeenOf(cluster: Cluster): number {
  return Math.max(
    ...cluster.members.map((member) => member.candidate.anchor.t),
  );
}

/**
 * Normalizes a candidate's most identifying text into a stable signature: digit runs become `#`,
 * redaction markers are stripped, and case/whitespace are flattened so the same underlying failure
 * (and its in-session duplicates) collapse to one key.
 */
function normalizeSignature(candidate: EvidenceCandidate): string {
  const source =
    candidate.anchor.errorCode ??
    candidate.anchor.message ??
    candidate.anchor.elementLabel ??
    candidate.title;
  return normalizeText(source);
}

function normalizeText(source: string): string {
  return stripVolatileValues(stripUrlQueries(source).toLowerCase())
    .replace(/\[redacted(?::[^\]]*)?\]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stand-in for a stripped volatile value. A token rather than an empty string so two
 * messages that differ in how MANY variable parts they carry stay distinct. Byte-identical
 * to the cloud's `VOLATILE_PLACEHOLDER` so a signature computed here and one computed
 * there describe the same thing.
 */
const VOLATILE_PLACEHOLDER = " ~ ";

const UUID_IN_TEXT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const LONG_HEX_IN_TEXT = /\b[0-9a-f]{12,}\b/g;
const EMAIL_IN_TEXT = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/g;
/**
 * `ord_7885f1c8`, `cus_a91f22`: a type prefix plus one occurrence's opaque suffix. The
 * suffix must carry a digit, which is what separates a generated id from an ordinary
 * snake_case identifier (`payment_declined` names a fault and must survive).
 */
const PREFIXED_ID_IN_TEXT = /\b[a-z][a-z0-9]{1,9}_([a-z0-9]{6,})\b/g;

function stripPrefixedIds(source: string): string {
  return source.replace(PREFIXED_ID_IN_TEXT, (match, suffix: string) =>
    /\d/.test(suffix) ? VOLATILE_PLACEHOLDER : match,
  );
}
/** Anything inside matching quotes — a flag name, a column name, an interpolated value. */
const QUOTED_VALUE_IN_TEXT = /(["'`])[^"'`]*\1/g;

/**
 * Removes the parts of a message that vary between occurrences of ONE fault, so eight
 * occurrences mint one signature instead of eight.
 *
 * `Unknown feature flag 'beta-checkout'` and `Unknown feature flag 'beta-payments'` are
 * the same fault parameterised twice; so are two `Cannot find user <address>` and two
 * `Failed to load module chunk-<hash>`. Each pair used to mint its own bug, so a recurring
 * failure arrived as a list of singletons and the recurrence view had nothing to count.
 *
 * The rules, their order, and the placeholder are the cloud's `normalizeIncidentText`, with
 * ONE rule left out: the cloud replaces a whole absolute url, and here a url's PATH is
 * identity — `/v2/search` and `/v2/orders` are two endpoints, and {@link stripUrlQueries}
 * has already removed the part of a url that varies. Everything else matches rule for rule,
 * because a signature the two layers compute differently is worse than either rule alone.
 * The known consequence, which the cloud already accepts: quoted-value stripping merges
 * `column "mode" does not exist` with `column "region" does not exist`. They are distinct
 * faults with distinct fixes, and they will group. The trade is deliberate — the quoted
 * value is a variable far more often than it is the fault's identity, and the two
 * messages stay verbatim on the anchor and on every evidence ref.
 *
 * Input is expected already lowercased.
 */
function stripVolatileValues(source: string): string {
  return stripPrefixedIds(
    source
      .replace(UUID_IN_TEXT, VOLATILE_PLACEHOLDER)
      .replace(LONG_HEX_IN_TEXT, VOLATILE_PLACEHOLDER)
      .replace(EMAIL_IN_TEXT, VOLATILE_PLACEHOLDER),
  ).replace(QUOTED_VALUE_IN_TEXT, VOLATILE_PLACEHOLDER);
}

/**
 * A URL-like token inside free text: an absolute URL, or a path starting at `/`.
 * Stops at whitespace and at the punctuation that ends a URL inside prose.
 */
const URL_LIKE_TOKEN = /(?:https?:\/\/|\/)[^\s"'<>)\]}]*/gi;

/**
 * Drops the query string and fragment from every URL inside a text, keeping the
 * path.
 *
 * The query is the request's DATA, not its identity. One failing endpoint
 * reached with two different searches produced two issues — "HTTP 404 from GET
 * /v2/search" and "HTTP 404 from GET /v2/search?q=[REDACTED]" — because the
 * query rode into the grouping key through the candidate's message and title.
 * The same 404 on the same path is one bug however it was parameterised, and
 * the full URL is still carried verbatim on the anchor and on every evidence
 * ref, so nothing is lost from the evidence.
 *
 * Applied to identity ONLY. A page whose view is selected by a query parameter
 * still keeps its own component signature, which is built from the anchor's
 * route rather than from this text.
 */
function stripUrlQueries(source: string): string {
  return source.replace(URL_LIKE_TOKEN, (token) => {
    const cut = token.search(/[?#]/);
    return cut === -1 ? token : token.slice(0, cut);
  });
}

/**
 * An HTTP status code named in the text, together with the phrasing that makes
 * it a status code rather than a quantity: `HTTP 403`, `HTTP/1.1 500`,
 * `status 404`, `status code 502`, `code: 401`, `returned 503`,
 * `responded with 429`. Only 1xx-5xx three-digit runs qualify, and a longer
 * digit run (an id that happens to start 404...) never does.
 */
const HTTP_STATUS_IN_TEXT =
  /((?:^|[^a-z\d])(?:http\/\d(?:\.\d)?|http|https|status(?:\s+code)?|code|returned|responded\s+with)[\s:=]+)([1-5]\d{2})(?!\d)/g;

const DIGIT_LETTERS = "abcdefghij";
/**
 * Delimiter wrapped around a shielded status code. A control character, so it
 * can never collide with an ordinary word spelled from the letters a-j and turn
 * that word back into digits.
 */
const SHIELD = "\u0001";
/** Digits as delimited letters, so the digit-run collapse cannot reach them. */
function shieldDigits(code: string): string {
  const letters = Array.from(
    code,
    (digit) => DIGIT_LETTERS[Number(digit)],
  ).join("");
  return `${SHIELD}${letters}${SHIELD}`;
}

/**
 * Splitting on the delimiter rather than matching a pattern containing it: the
 * odd segments are exactly the shielded runs, and no control character has to
 * appear inside a regular expression.
 */
function unshieldDigits(text: string): string {
  return text
    .split(SHIELD)
    .map((segment, position) =>
      position % 2 === 1 && /^[a-j]+$/.test(segment)
        ? Array.from(segment, (letter) =>
            String(DIGIT_LETTERS.indexOf(letter)),
          ).join("")
        : segment,
    )
    .join("");
}

/**
 * Normalizes a message for the recurrence signature: digit runs collapse to `#`
 * so ids, counters and timestamps embedded in a message do not split one
 * recurring bug into many.
 *
 * HTTP status codes are the exception and survive intact. `HTTP 403 from POST
 * /login` and `HTTP 500 from POST /login` are different failures with different
 * fixes, and collapsing both to `http # from post /login` re-merged, at
 * identity time, exactly what the grouping layer works to keep apart. This is the
 * one deliberate divergence from the cloud's `normalizeIncidentText`, which replaces
 * every number including a status code; everything {@link stripVolatileValues} removes
 * matches the cloud rule for rule.
 */
function normalizeRecurrenceText(source: string): string {
  return unshieldDigits(
    stripVolatileValues(stripUrlQueries(source).toLowerCase())
      .replace(/\[redacted(?::[^\]]*)?\]/g, "")
      .replace(
        HTTP_STATUS_IN_TEXT,
        (_match, prefix: string, code: string) =>
          `${prefix}${shieldDigits(code)}`,
      )
      .replace(/\d+/g, "#"),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLegacyRecurrenceText(source: string): string {
  return source
    .toLowerCase()
    .replace(/\[redacted\]/g, "")
    .replace(/\d{3,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalizes only the route component of a version-2 recurrence signature. */
function normalizeRecurrenceRoute(source: string): string {
  const path = source
    .trim()
    .replace(/^(?:[a-z][a-z\d+.-]*:)?\/\/[^/?#]*/i, "")
    .split(/[?#]/, 1)[0];

  return path
    .split("/")
    .map((segment) =>
      isValueLikeRouteSegment(segment) ? ":id" : segment.toLowerCase(),
    )
    .join("/");
}

function isValueLikeRouteSegment(segment: string): boolean {
  return (
    /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(segment) ||
    /^[a-f\d]{6,}$/i.test(segment) ||
    /\d/.test(segment) ||
    (segment.length >= 16 &&
      /^[a-z\d+/_-]+={0,2}$/i.test(segment) &&
      /[a-z]/.test(segment) &&
      /[A-Z]/.test(segment)) ||
    segment.length > 24
  );
}

function componentSignature(candidate: EvidenceCandidate): string {
  return [
    candidate.anchor.route,
    candidate.anchor.status,
    candidate.anchor.target?.routePath,
    candidate.anchor.target?.testID,
    candidate.anchor.target?.accessibilityId,
    candidate.anchor.target?.label,
    candidate.anchor.target?.role,
    candidate.anchor.target?.componentName,
    candidate.anchor.target?.ancestryHash,
    candidate.anchor.target?.testId,
    candidate.anchor.target?.accessibilityLabel,
    candidate.anchor.target?.selector,
    candidate.anchor.target?.viewName,
    candidate.anchor.target?.screen,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join("|");
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function absoluteSeen(seen: number, sessionStart: number | undefined): number {
  if (!Number.isFinite(seen))
    return Number.isFinite(sessionStart) ? (sessionStart as number) : 0;
  if (!Number.isFinite(sessionStart) || seen > 946_684_800_000) return seen;
  return (sessionStart as number) + seen;
}

function buildReleaseSpan(
  releases: string[],
): DistinctBugRecurrence["release_span"] | undefined {
  const unique = uniqueSorted(releases);
  if (unique.length === 0) return undefined;
  const first = unique[0];
  const last = unique[unique.length - 1];
  return { first, last, label: first === last ? first : `${first}->${last}` };
}

/**
 * Roll one session-level label up across a recurrence's occurrences, counting
 * the sessions that never recorded it instead of silently dropping them.
 *
 * Counted per SESSION, not per occurrence: two grouped bugs from the same
 * unnamed session are one unknown app, matching `session_count`.
 */
function labelCoverage(
  occurrences: DistinctBugRecurrenceOccurrence[],
  pick: (occurrence: DistinctBugRecurrenceOccurrence) => string | undefined,
): DistinctBugRecurrenceLabels {
  const bySession = new Map<string, string | undefined>();
  for (const occurrence of occurrences) {
    const value = pick(occurrence);
    const existing = bySession.get(occurrence.sessionId);
    bySession.set(
      occurrence.sessionId,
      existing && existing.length > 0 ? existing : value,
    );
  }
  const values = [...bySession.values()];
  return {
    known: uniqueSorted(values),
    unknown: values.filter((value) => !value || value.length === 0).length,
  };
}

/** `undefined` when the dimension is absent from every session, so
 *  `removeUndefined` drops the key rather than shipping an empty claim. */
function presentOrUndefined(
  labels: DistinctBugRecurrenceLabels,
): DistinctBugRecurrenceLabels | undefined {
  return labels.known.length > 0 ? labels : undefined;
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
