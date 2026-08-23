import path from "node:path";
import { resolveSessionDirById } from "./session-paths";
import { defaultSessionStore } from "./session-store";
import type { EvidenceCandidate } from "./evidence-index";
import type { CausalConfidence } from "./causal-graph";
import type {
  LlmBundle,
  LlmBundleBackendRequestEvidenceSummary,
  LlmBundleDbDiff,
  LlmBundleDbRead,
  LlmBundleDbError,
  LlmBundleDbStatement,
  LlmBundleDbActivity,
  LlmBundleFrontendRequestEvidenceSummary,
  LlmBundleFailedRequestSummary,
  LlmBundlePrecedingRequestSummary,
  LlmBundleLinkedFullStackRequestSummary,
} from "./llm-bundle";
import {
  extractOpinionCodePointers,
  type CodePointer,
} from "./code-pointers";
import { buildCodeLocations, type CodeLocation } from "./code-locations";

/** A database row diff correlated to the primary window. See {@link LlmBundleDbDiff}. */
export type FixContextDbDiff = LlmBundleDbDiff;
export type FixContextDbRead = LlmBundleDbRead;
/** A statement that was attempted and raised, correlated to the primary window. */
export type FixContextDbError = LlmBundleDbError;
/** A statement that was attempted and succeeded, correlated to the primary window. */
export type FixContextDbStatement = LlmBundleDbStatement;
export type FixContextDbActivity = LlmBundleDbActivity;

/**
 * Versioned, correlated, LLM-ready "hand it to the model" bundle for a finalized
 * session. This is the keystone fix-context contract (V2.5).
 *
 * The shape is intentionally stable: `primary_window.db_diffs` defaults to an empty array
 * and `environment` defaults to null so later checkpoints (CP5 DB diffing, CP3 environment
 * capture) can populate them without breaking the contract.
 */
/**
 * @stability stable
 * Version-bump policy follows the same Fork A decision as fusion.v1 — see
 * wargames/wargames/01-solve-context-wargame-fields.md.
 */
export const FIX_CONTEXT_SCHEMA_VERSION = "fix-context.v2" as const;

export interface FixContextSession {
  id: string;
  name?: string;
  app?: string;
  source?: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface FixContextReproHint {
  title?: string;
  detector?: string;
  severity?: EvidenceCandidate["severity"];
  route?: string;
  target?: EvidenceCandidate["anchor"]["target"];
  elementLabel?: string;
  errorCode?: string;
  message?: string;
  requestId?: string;
  offsetMs?: number;
}

export interface FixContextPrimaryWindow {
  frontend: {
    window: { start: number; end: number; windowId: string } | null;
    anchor: EvidenceCandidate["anchor"] | null;
    requests: LlmBundleFrontendRequestEvidenceSummary[];
  };
  backend: {
    requests: LlmBundleBackendRequestEvidenceSummary[];
  };
  /**
   * Requests that SUCCEEDED just before the first error, with their bodies.
   *
   * `frontend.requests` and `backend.requests` are both drawn from
   * `fullStackEvidence.linked`, which pairs a browser request with its backend
   * span. A browser-only session has no such pairs, so both were `[]` and this
   * whole structure reported no request evidence for the exact defect shape
   * that has no failed request to report: a 200 carrying the wrong value.
   * Empty when the session recorded no error to anchor on.
   */
  preceding_requests: LlmBundlePrecedingRequestSummary[];
  /**
   * Failed browser requests from the finalized evidence bundle. These carry
   * redacted request and response bodies when capture recorded them, so the
   * issue handoff does not make an agent reconstruct the cause from raw time
   * windows.
   */
  failed_requests?: LlmBundleFailedRequestSummary[];
  /**
   * Database row diffs correlated to the primary window (CP5 DB diffing). Empty when the session
   * captured no `db.diff` events in the window. Consumers MUST treat `[]` as "no DB evidence".
   */
  db_diffs: FixContextDbDiff[];
  /**
   * Database rows read in the primary window (`db.read`, pre-state capture). Empty when read
   * capture is disabled or no reads matched the primary request/window.
   */
  db_reads: FixContextDbRead[];
  /**
   * Statements attempted in the primary window that the database REFUSED (`db.error`). Empty when
   * every statement the window issued succeeded.
   *
   * This plane is the one that can be decisive on its own. `db_diffs` and `db_reads` can only
   * describe statements that completed, so a request whose fault IS the failing statement used to
   * present as a request with no database evidence at all — and a request that ran two statements
   * and lost one presented as confidently complete. Consumers MUST NOT read `[]` as "the database
   * was fine"; read it as "no statement in this window was observed to raise".
   */
  db_errors: FixContextDbError[];
  /**
   * Statements the primary window issued that the database ACCEPTED (`db.statement`).
   *
   * The plane that says what the request ASKED. `db_diffs` and `db_reads` can only describe a
   * statement through what it returned, so a wrong predicate on a query that runs perfectly — the
   * common case, not the exotic one — presented as a window full of correct-looking evidence, and
   * a SELECT that matched zero rows presented as no statement at all. Empty when the capture path
   * recorded no statement for this window; consumers MUST NOT read `[]` as "the request issued no
   * queries".
   */
  db_statements: FixContextDbStatement[];
  /**
   * OTel DB span activity in the primary window. These are statements/operations only, never
   * before/after row diffs.
   */
  db_activity: FixContextDbActivity[];
}

/** One downstream symptom of the primary root cause, resolved from `signals`. */
export interface FixContextCausalSymptom {
  id: string;
  detector: string;
  title: string;
  attributionConfidence?: CausalConfidence;
}

/**
 * The primary root-cause → symptom chain, derived ONLY from causal fields already present on the
 * signals (CP3). `null` when the primary candidate is isolated or has no attributed
 * symptoms. Purely a projection — no attribution is recomputed here.
 */
export interface FixContextCausalChain {
  root: { id: string; detector: string; title: string };
  symptoms: FixContextCausalSymptom[];
}

/**
 * Why no chain was projected. One of four states, and they are NOT
 * interchangeable:
 *
 * - `no_signals` — nothing ranked at all. There was no incident to explain.
 * - `top_candidate_isolated` — the highest-ranked signal, the one that names the
 *   incident, could not be attached to the causal graph: nothing compatible was
 *   there to attach it to. The chain's absence is a fact about OUR attribution,
 *   not about the application.
 * - `top_candidate_lost_contention` — the highest-ranked signal COULD have been
 *   attached. A node it describes existed and was in reach, and another
 *   candidate had already claimed it, because attribution is
 *   one-candidate-per-node and settles ties by arrival order. This is not a
 *   missing observation; it is one that was displaced, and the two were
 *   previously reported with the same word.
 * - `root_attributed_no_symptoms` — a root was resolved and it explains nothing
 *   downstream, so the projection has one end of a chain and no other.
 *
 * `detector` names the signal that could not be placed, so a reader can see which
 * observation is missing from the graph rather than being told only that
 * something is.
 */
export interface FixContextCausalAbsence {
  reason:
    | "no_signals"
    | "top_candidate_isolated"
    | "top_candidate_lost_contention"
    | "root_attributed_no_symptoms";
  detector?: string;
  signalId?: string;
  /**
   * The graph node the top signal lost. Set only for
   * `top_candidate_lost_contention`; it resolves against `causal_graph`'s nodes.
   */
  contendedNodeId?: string;
  /**
   * The signal id that holds {@link contendedNodeId} instead. Set only for
   * `top_candidate_lost_contention`, and only when that signal is in this
   * bundle — a contest whose winner was capped out of the emitted set still
   * reports the contest.
   */
  incumbentSignalId?: string;
  /** The incumbent's detector, when the incumbent is present in the signals. */
  incumbentDetector?: string;
}

/**
 * A deterministic detector output. `basis` makes it explicit that `baseScore`
 * is a reproducible heuristic score, not a contextual model judgment.
 *
 * Candidates on disk intentionally remain unchanged for artifact compatibility;
 * this contract projects the audit fields at its boundary.
 */
export type FixContextSignal = EvidenceCandidate & {
  basis: "heuristic";
  baseScore: number;
};

export interface FixContext {
  schemaVersion: typeof FIX_CONTEXT_SCHEMA_VERSION;
  session: FixContextSession;
  signals: FixContextSignal[];
  primary_window: FixContextPrimaryWindow;
  /**
   * Account/environment state snapshot. Defaults to `null`; CP3 (environment capture)
   * populates this. Consumers MUST treat null as "not captured".
   */
  environment: Record<string, unknown> | null;
  /**
   * Primary root-cause → symptom chain projected from the signals' causal fields (CP4).
   * `null` when the top candidate is isolated or attributes no symptoms. Consumers MUST treat null
   * as "no causal structure surfaced".
   */
  causal_chain: FixContextCausalChain | null;
  /**
   * Why {@link FixContext.causal_chain} is null, when it is. Absent whenever a
   * chain is present.
   *
   * A bare null says "no causal structure surfaced", which is true and which a
   * reader cannot act on. Measured across nine captured sessions from five
   * scenarios, `causal_chain` was null in all nine — and in eight of them the top
   * candidate was the detector that NAMES the incident, sitting `isolated`
   * because nothing had decided which node kind it anchors on. "The signal that
   * identifies your bug could not be placed in the graph" and "these events
   * genuinely have no causal relationship" are opposite facts, and the field
   * that reported both identically is the reason nobody noticed for nine
   * sessions.
   *
   * This does NOT widen what is claimed. No chain is asserted, nothing is
   * guessed, and `causal_chain` stays null — the absence simply stops being
   * silent.
   */
  causal_chain_absence?: FixContextCausalAbsence;
  repro_hint: FixContextReproHint | null;
  /**
   * Cloud-resolved GitHub code pointers projected from the session's canonical
   * opinion artifact (cloud GitHub integration, CP3). OPTIONAL and additive:
   * absent when the session has no opinion artifact, the deployment has no
   * GitHub connection, or resolution produced no honest match. Consumers MUST
   * treat absence as "no pointers available", never as an error.
   */
  code_pointers?: CodePointer[];
  /**
   * Where in the source each ranked signal physically came from, derived from
   * frames the runtime reported at capture time (see `code-locations.ts`).
   *
   * Distinct from `code_pointers` on purpose. Those are cloud-resolved GitHub
   * permalinks and exist only where a connector and a deploy binding do; these
   * are available on every path, including self-host and file-store, because
   * they come from the process that was running. OPTIONAL and additive: absent
   * when the SDK was not capturing callsites and no candidate carried a frame.
   * Consumers MUST treat absence as "no locations captured", never as an error.
   */
  code_locations?: CodeLocation[];
  /**
   * Present only when at least one `code_locations` entry is a served script URL
   * with no source map behind it.
   *
   * Says, in the payload the agent reads, that those lines are positions in the
   * SERVED module and not in the reader's file. A dev server rewrites JSX and
   * injects a preamble, so the numbers do not line up and an agent that opens
   * the path at that line finds nothing — or, worse, finds something unrelated.
   * Follows `causal_chain_absence`: state the limit where the field is, rather
   * than letting a confident-looking value stand unqualified.
   */
  code_locations_note?: string;
}

export interface BuildFixContextOptions {
  /** Base sessions directory used to resolve a bare session id to a directory. */
  outputDir?: string;
}

export class FixContextError extends Error {
  constructor(
    readonly code: "session-not-found",
    message: string,
  ) {
    super(message);
    this.name = "FixContextError";
  }
}

/**
 * Builds the fix-context contract for a finalized session by reading hot-plane artifacts
 * (index.json, candidates.jsonl, llm.json). It never reads raw NDJSON at query time.
 */
export async function buildFixContext(
  sessionDirOrId: string,
  opts: BuildFixContextOptions = {},
): Promise<FixContext> {
  const sessionDir = resolveSessionDir(sessionDirOrId, opts);
  if (!(await defaultSessionStore.statArtifact(sessionDir, "index.json"))) {
    throw new FixContextError(
      "session-not-found",
      `No finalized session found at ${sessionDir} (missing index.json). Run post-processing first.`,
    );
  }

  const index = (await readJsonRecord(sessionDir, "index.json")) ?? {};
  const bundle = await readBundle(sessionDir);
  const ranked = await readCandidates(sessionDir);
  const opinion = await readJsonRecord(sessionDir, "opinion.json");

  return buildFixContextFromArtifacts(sessionDir, index, bundle, ranked, {
    opinion,
  });
}

/**
 * Assembles the fix-context contract from already-read finalized artifacts.
 * This lets alternate read backends preserve the stable local contract without
 * duplicating the projection and ranking logic.
 */
export function buildFixContextFromArtifacts(
  sessionDir: string,
  index: Record<string, unknown>,
  bundle: LlmBundle | undefined,
  ranked: EvidenceCandidate[],
  extras: { opinion?: Record<string, unknown> } = {},
): FixContext {
  const session = buildSession(sessionDir, index, bundle);
  const primaryWindow = buildPrimaryWindow(ranked, bundle, resolveAnchorRequestId(index));
  const reproHint = buildReproHint(ranked);
  const environment = buildEnvironment(bundle);
  const causal = projectCausalChain(ranked);
  const codePointers = extractOpinionCodePointers(extras.opinion);
  const codeLocations = buildCodeLocations(bundle, ranked);
  const servedLocations = (codeLocations ?? []).filter(
    (location) => location.servedUrl,
  ).length;

  return {
    schemaVersion: FIX_CONTEXT_SCHEMA_VERSION,
    session,
    signals: ranked.map(toSignal),
    primary_window: primaryWindow,
    environment,
    causal_chain: causal.chain,
    ...(causal.absence ? { causal_chain_absence: causal.absence } : {}),
    repro_hint: reproHint,
    ...(codePointers ? { code_pointers: codePointers } : {}),
    ...(codeLocations ? { code_locations: codeLocations } : {}),
    ...(servedLocations > 0
      ? {
          code_locations_note: `${servedLocations} of these ${servedLocations === 1 ? "locations is" : "locations are"} a URL the script was served from, marked servedUrl. Its line is a position in the served module, not in the source file of the same name — a dev server rewrites and prepends to it — so do not open that path at that line and expect the reported code. Treat it as naming the module only. Set CRUMBTRAIL_SOURCEMAP_DIR to the build's source map directory to resolve these to real repository paths and lines.`,
        }
      : {}),
  };
}

function toSignal(candidate: EvidenceCandidate): FixContextSignal {
  return {
    ...candidate,
    basis: "heuristic",
    baseScore: candidate.score,
  };
}

/**
 * Projects the primary root-cause → symptom chain from causal fields already present on the ranked
 * candidates (CP3). Does NOT recompute attribution and does NOT re-sort candidates: it reads the
 * root-first order that `candidates.jsonl` already carries.
 *
 * Primary root resolution: `ranked[0]` is the anchor, and nothing else is.
 *   - if it is a root -> it is the root;
 *   - else if it is a symptom -> resolve its `rootCauseId` against `signals`;
 *   - else -> null.
 *
 * A wider walk was tried and REVERTED on evidence. The reasoning was sound: a generic
 * whole-session detector (an N+1 on an unrelated route) takes the top slot, and a chain sitting
 * intact two rows below is discarded, which three separate evaluation defects reported as
 * "captured every decisive fact but never assembled them". Scanning down the list for the first
 * candidate that resolves does find a chain - just not the incident's. On a gift-card balance
 * defect it produced `root: backend_http_client_error, HTTP 401 from GET /api/me`: a page-load
 * auth probe on a different route, asserted as the causal story of the bug. The decisive
 * candidate, a UI-vs-API divergence on the reported route, was `causalRole: "isolated"` and was
 * never a chain in the first place.
 *
 * A confident wrong chain is worse than an honest null: null says "no causal structure surfaced",
 * which is true and readable, while the walk's output says "this is why it broke" about an
 * unrelated request. So the null stays until the real gap is closed, and the real gap is that
 * cross-plane contradictions are not attributed to the request and rows that produced them -
 * assembly per incident, ranked against the reported symptom. That is a change to attribution,
 * not to this projection, and this function must not paper over it.
 */

export function buildCausalChain(
  ranked: EvidenceCandidate[],
): FixContextCausalChain | null {
  return projectCausalChain(ranked).chain;
}

/**
 * The chain and, when there is none, the reason.
 *
 * One function rather than two so the reason can never disagree with the null it
 * explains. A second function mirroring these branches would drift the first time
 * one of them changed, and a WRONG explanation of an absence is worse than the
 * bare null it replaced — it is a confident claim about our own instrument.
 *
 * Every `return` below is byte-for-byte the same decision the projection made
 * before; nothing is newly refused and nothing newly accepted.
 */
export function projectCausalChain(ranked: EvidenceCandidate[]): {
  chain: FixContextCausalChain | null;
  absence?: FixContextCausalAbsence;
} {
  const top = ranked[0];
  if (!top) return { chain: null, absence: { reason: "no_signals" } };

  const byId = new Map<string, EvidenceCandidate>();
  for (const candidate of ranked) byId.set(candidate.id, candidate);

  let root: EvidenceCandidate | undefined;
  if (top.causalRole === "root") {
    root = top;
  } else if (top.causalRole === "symptom" && top.rootCauseId) {
    root = byId.get(top.rootCauseId);
  }
  if (!root || root.causalRole !== "root") {
    // A top candidate that LOST a contest is a different fact from one that had
    // nothing to attach to, and reporting both as "isolated" made the reason
    // string wrong about 40% of the population it described. The chain stays
    // null either way — nothing is newly claimed here, only correctly named.
    //
    // Keyed on the CAUSE, not on the `contention` payload. The incumbent's
    // candidate can be capped out of the emitted set, which drops the payload
    // while the cause stands — and keying on the payload would then report
    // "could not be placed" about a signal whose own record says it lost a
    // contest, reintroducing this finding's false statement one field over.
    if (top.isolationCause === "lost-contention") {
      const incumbent = top.contention
        ? byId.get(top.contention.heldBy)
        : undefined;
      return {
        chain: null,
        absence: removeUndefined({
          reason: "top_candidate_lost_contention",
          detector: top.detector,
          signalId: top.id,
          contendedNodeId: top.contention ? top.contention.nodeId : undefined,
          incumbentSignalId: incumbent ? incumbent.id : undefined,
          incumbentDetector: incumbent ? incumbent.detector : undefined,
        }) as FixContextCausalAbsence,
      };
    }
    return {
      chain: null,
      absence: { reason: "top_candidate_isolated", detector: top.detector, signalId: top.id },
    };
  }

  const causeIds = root.causes ?? [];
  const symptoms: FixContextCausalSymptom[] = [];
  for (const id of causeIds) {
    const symptom = byId.get(id);
    if (!symptom) continue;
    symptoms.push(
      removeUndefined({
        id: symptom.id,
        detector: symptom.detector,
        title: symptom.title,
        attributionConfidence: symptom.attributionConfidence,
      }) as FixContextCausalSymptom,
    );
  }
  if (symptoms.length === 0) {
    return {
      chain: null,
      absence: { reason: "root_attributed_no_symptoms", detector: root.detector, signalId: root.id },
    };
  }

  return {
    chain: {
      root: { id: root.id, detector: root.detector, title: root.title },
      symptoms,
    },
  };
}

function resolveSessionDir(
  sessionDirOrId: string,
  opts: BuildFixContextOptions,
): string {
  return resolveSessionDirById(sessionDirOrId, opts.outputDir);
}

function buildSession(
  sessionDir: string,
  index: Record<string, unknown>,
  bundle: LlmBundle | undefined,
): FixContextSession {
  const fallbackId = path.basename(sessionDir);
  if (bundle) {
    return removeUndefined({
      id: bundle.session.id || fallbackId,
      name: bundle.session.name,
      app: bundle.session.app,
      source: bundle.session.source,
      startMs: bundle.session.startMs,
      endMs: bundle.session.endMs,
      durationMs: bundle.session.durationMs,
    }) as FixContextSession;
  }

  const start = finiteNumber(index.start) ?? 0;
  const end = finiteNumber(index.end) ?? start;
  return removeUndefined({
    id: safeString(index.id) ?? fallbackId,
    startMs: start,
    endMs: end,
    durationMs: finiteNumber(index.dur) ?? Math.max(0, end - start),
  }) as FixContextSession;
}

/**
 * Turns whichever request id a candidate anchored on into the one the backend and DB planes used.
 *
 * A browser-plane detector anchors on the browser's own request counter; `fullStackEvidence.linked`
 * and `databaseDiffs` are keyed by the correlation requestId. Without this the identity join below
 * silently never fires for browser-plane candidates, and the primary window falls back to the time
 * window alone — which pulls in every request that happened to overlap and no rows that are
 * provably the reported one's. `causalGraph.requestIdAliases` is the join; see its doc comment.
 *
 * Unknown ids pass through unchanged, so a backend-plane anchor (already correlated) is untouched.
 */
function resolveAnchorRequestId(
  index: Record<string, unknown>,
): (id: string | undefined) => string | undefined {
  const graph = index.causalGraph;
  const aliases =
    isRecord(graph) && isRecord(graph.requestIdAliases)
      ? graph.requestIdAliases
      : undefined;
  return (id) => {
    if (id === undefined) return undefined;
    const alias = aliases?.[id];
    return typeof alias === "string" ? alias : id;
  };
}

function buildPrimaryWindow(
  ranked: EvidenceCandidate[],
  bundle: LlmBundle | undefined,
  resolveRequestId: (id: string | undefined) => string | undefined = (id) => id,
): FixContextPrimaryWindow {
  const top = ranked[0];
  const window = top ? top.evidenceWindow : null;
  const topRequestId = resolveRequestId(top?.anchor.requestId);
  const linked: LlmBundleLinkedFullStackRequestSummary[] =
    bundle?.fullStackEvidence?.linked ?? [];

  const matched = linked.filter((entry) => {
    if (topRequestId && entry.requestId === topRequestId) return true;
    const t = entry.frontend?.ref?.t;
    if (window && typeof t === "number")
      return t >= window.start && t <= window.end;
    return false;
  });

  return {
    frontend: {
      window,
      anchor: top?.anchor ?? null,
      requests: matched.map((entry) => entry.frontend),
    },
    backend: {
      requests: matched.map((entry) => entry.backend),
    },
    preceding_requests: bundle?.browserEvidence?.precedingRequests ?? [],
    failed_requests: selectPrimaryFailedRequests(bundle, top),
    db_diffs: selectPrimaryWindowDbDiffs(bundle, window, topRequestId, matched),
    db_reads: selectPrimaryWindowDbReads(bundle, window, topRequestId, matched),
    db_errors: selectPrimaryWindowDbErrors(bundle, window, topRequestId, matched),
    db_statements: selectPrimaryWindowDbStatements(bundle, window, topRequestId, matched),
    db_activity: selectPrimaryWindowDbActivity(bundle, window, topRequestId, matched),
  };
}

/** Keep the issue's own failed request first, without hiding the full session tool. */
function selectPrimaryFailedRequests(
  bundle: LlmBundle | undefined,
  top: EvidenceCandidate | undefined,
): LlmBundleFailedRequestSummary[] {
  const failed = bundle?.browserEvidence?.failedRequests ?? [];
  if (!top) return failed;

  const method = top.anchor.method?.toUpperCase();
  const url = top.anchor.url;
  const status = top.anchor.status;
  const matching = failed.filter(
    (request) =>
      (method === undefined || request.method?.toUpperCase() === method) &&
      (url === undefined || request.url === url) &&
      (status === undefined || request.status === status),
  );
  return matching.length > 0 ? matching : failed;
}

/**
 * Selects the `db.diff` rows correlated to the primary window: those whose timestamp falls inside
 * the top candidate's evidence window, or whose `requestId` matches the anchor / a linked
 * full-stack request. Reads only the finalized bundle (never raw NDJSON).
 */
function selectPrimaryWindowDbDiffs(
  bundle: LlmBundle | undefined,
  window: { start: number; end: number } | null,
  topRequestId: string | undefined,
  matched: LlmBundleLinkedFullStackRequestSummary[],
): FixContextDbDiff[] {
  const diffs = Array.isArray(bundle?.databaseDiffs)
    ? bundle!.databaseDiffs
    : [];
  if (diffs.length === 0) return [];

  const requestIds = new Set<string>();
  if (topRequestId) requestIds.add(topRequestId);
  for (const entry of matched) requestIds.add(entry.requestId);

  return diffs.filter((diff) => {
    if (
      window &&
      typeof diff.t === "number" &&
      diff.t >= window.start &&
      diff.t <= window.end
    )
      return true;
    return diff.requestId !== undefined && requestIds.has(diff.requestId);
  });
}

function selectPrimaryWindowDbReads(
  bundle: LlmBundle | undefined,
  window: { start: number; end: number } | null,
  topRequestId: string | undefined,
  matched: LlmBundleLinkedFullStackRequestSummary[],
): FixContextDbRead[] {
  const reads = Array.isArray(bundle?.databaseReads)
    ? bundle!.databaseReads
    : [];
  if (reads.length === 0) return [];

  const requestIds = new Set<string>();
  if (topRequestId) requestIds.add(topRequestId);
  for (const entry of matched) requestIds.add(entry.requestId);

  return reads.filter((read) => {
    if (
      window &&
      typeof read.t === "number" &&
      read.t >= window.start &&
      read.t <= window.end
    )
      return true;
    return read.requestId !== undefined && requestIds.has(read.requestId);
  });
}

function selectPrimaryWindowDbErrors(
  bundle: LlmBundle | undefined,
  window: { start: number; end: number } | null,
  topRequestId: string | undefined,
  matched: LlmBundleLinkedFullStackRequestSummary[],
): FixContextDbError[] {
  const errors = Array.isArray(bundle?.databaseErrors)
    ? bundle!.databaseErrors
    : [];
  if (errors.length === 0) return [];

  const requestIds = new Set<string>();
  if (topRequestId) requestIds.add(topRequestId);
  for (const entry of matched) requestIds.add(entry.requestId);

  return errors.filter((error) => {
    if (
      window &&
      typeof error.t === "number" &&
      error.t >= window.start &&
      error.t <= window.end
    )
      return true;
    return error.requestId !== undefined && requestIds.has(error.requestId);
  });
}

function selectPrimaryWindowDbStatements(
  bundle: LlmBundle | undefined,
  window: { start: number; end: number } | null,
  topRequestId: string | undefined,
  matched: LlmBundleLinkedFullStackRequestSummary[],
): FixContextDbStatement[] {
  const statements = Array.isArray(bundle?.databaseStatements)
    ? bundle!.databaseStatements
    : [];
  if (statements.length === 0) return [];

  const requestIds = new Set<string>();
  if (topRequestId) requestIds.add(topRequestId);
  for (const entry of matched) requestIds.add(entry.requestId);

  return statements.filter((statement) => {
    if (
      window &&
      typeof statement.t === "number" &&
      statement.t >= window.start &&
      statement.t <= window.end
    )
      return true;
    return (
      statement.requestId !== undefined && requestIds.has(statement.requestId)
    );
  });
}

function selectPrimaryWindowDbActivity(
  bundle: LlmBundle | undefined,
  window: { start: number; end: number } | null,
  topRequestId: string | undefined,
  matched: LlmBundleLinkedFullStackRequestSummary[],
): FixContextDbActivity[] {
  const activity = Array.isArray(bundle?.databaseActivity)
    ? bundle!.databaseActivity
    : [];
  if (activity.length === 0) return [];

  const requestIds = new Set<string>();
  if (topRequestId) requestIds.add(topRequestId);
  for (const entry of matched) requestIds.add(entry.requestId);

  return activity.filter((entry) => {
    if (
      window &&
      typeof entry.t === "number" &&
      entry.t >= window.start &&
      entry.t <= window.end
    )
      return true;
    return entry.requestId !== undefined && requestIds.has(entry.requestId);
  });
}

/**
 * Reads the redaction-aware environment snapshot from the finalized bundle (llm.json). CP3
 * env capture: returns the bundle's `environment` object when present, or `null` when no env
 * was captured (consumers MUST treat null as "not captured"). Never reads raw events here.
 */
function buildEnvironment(
  bundle: LlmBundle | undefined,
): Record<string, unknown> | null {
  const env = bundle?.environment;
  if (!isRecord(env) || Object.keys(env).length === 0) return null;
  return env;
}

function buildReproHint(
  ranked: EvidenceCandidate[],
): FixContextReproHint | null {
  const top = ranked[0];
  if (!top) return null;
  return removeUndefined({
    title: top.title,
    detector: top.detector,
    severity: top.severity,
    route: top.anchor.route,
    target: top.anchor.target,
    elementLabel: top.anchor.elementLabel,
    errorCode: top.anchor.errorCode,
    message: top.anchor.message,
    requestId: top.anchor.requestId,
    offsetMs: top.anchor.offsetMs,
  }) as FixContextReproHint;
}

async function readCandidates(
  sessionDir: string,
): Promise<EvidenceCandidate[]> {
  const buf = await defaultSessionStore.readArtifact(
    sessionDir,
    "candidates.jsonl",
  );
  if (!buf) return [];
  const content = buf.toString("utf-8").trim();
  if (!content) return [];
  const candidates: EvidenceCandidate[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      candidates.push(JSON.parse(trimmed) as EvidenceCandidate);
    } catch {
      // candidates.jsonl is deterministic and pre-redacted; skip any malformed line defensively.
    }
  }
  return candidates;
}

async function readBundle(sessionDir: string): Promise<LlmBundle | undefined> {
  const record =
    (await readJsonRecord(sessionDir, "llm.json")) ??
    (await readJsonRecord(sessionDir, "bundle.json"));
  return record as LlmBundle | undefined;
}

async function readJsonRecord(
  sessionDir: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const buf = await defaultSessionStore.readArtifact(sessionDir, name);
    if (!buf) return undefined;
    const parsed: unknown = JSON.parse(buf.toString("utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
