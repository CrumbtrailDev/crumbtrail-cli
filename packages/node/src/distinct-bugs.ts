import { hashString } from "crumbtrail-core";
import type { TargetDescriptor } from "crumbtrail-core";
import type { EvidenceCandidate } from "./evidence-index";

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
    method?: string;
    status?: number;
    target?: TargetDescriptor;
    requestId?: string;
  };
  frontendEvidence: DistinctBugEvidenceRef[];
  backendEvidence: DistinctBugEvidenceRef[];
  dbDiffs?: DistinctBugEvidenceRef[];
  candidateIds: string[];
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

export interface DistinctBugRecurrence {
  signature: string;
  title: string;
  severity: DistinctBugSeverity;
  first_seen: number;
  last_seen: number;
  session_count: number;
  release_span?: { first: string; last: string; label: string };
  apps: string[];
  tenants: string[];
  occurrences: DistinctBugRecurrenceOccurrence[];
}

// Detectors whose evidence is observed on the back end (server-side telemetry). Everything else
// is a client-observed signal (network failures are observed by the browser even when the fault is
// server-side; full-stack linkage already ties those together via requestId).
const BACKEND_DETECTORS = new Set(["otel_span_error", "otel_log_error"]);
const DB_DETECTORS = new Set(["db_mutation"]);

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
): DistinctBug[] {
  // Deterministic processing order: time asc, score desc, id asc. Independent of input order.
  const ordered = [...candidates].sort(
    (a, b) =>
      a.anchor.t - b.anchor.t || b.score - a.score || a.id.localeCompare(b.id),
  );

  const byRequest = new Map<string, Cluster>();
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

  const bugs = clusters.map((cluster) => buildBug(cluster));
  bugs.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.firstSeen - b.firstSeen ||
      a.bugId.localeCompare(b.bugId),
  );
  return bugs;
}

export function buildDistinctBugSignature(
  bug: Pick<DistinctBug, "title" | "representative">,
): string {
  const detector = bug.representative?.detector ?? "unknown";
  const route = bug.representative?.route ?? "";
  const message =
    bug.representative?.message ?? bug.representative?.title ?? bug.title;
  return `bugsig:${hashString(`${detector}|${normalizeRecurrenceText(message)}|${normalizeRecurrenceText(route)}`)}`;
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
        apps: uniqueSorted(ordered.map((occurrence) => occurrence.app)),
        tenants: uniqueSorted(ordered.map((occurrence) => occurrence.tenant)),
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

function buildBug(cluster: Cluster): DistinctBug {
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
    (ref) =>
      !BACKEND_DETECTORS.has(ref.detector) && !DB_DETECTORS.has(ref.detector),
  );
  const backendEvidence = refs.filter((ref) =>
    BACKEND_DETECTORS.has(ref.detector),
  );
  const dbDiffs = refs.filter((ref) => DB_DETECTORS.has(ref.detector));

  const candidateIds = candidates
    .map((candidate) => candidate.id)
    .sort((a, b) => a.localeCompare(b));

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
      method: representative.anchor.method,
      status: representative.anchor.status,
      target: representative.anchor.target,
      requestId: representative.anchor.requestId,
    }) as DistinctBug["representative"],
    frontendEvidence,
    backendEvidence,
    ...(dbDiffs.length > 0 ? { dbDiffs } : {}),
    candidateIds,
  };
  return bug;
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
  return source
    .toLowerCase()
    .replace(/\[redacted\]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRecurrenceText(source: string): string {
  return source
    .toLowerCase()
    .replace(/\[redacted\]/g, "")
    .replace(/\d{3,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
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
