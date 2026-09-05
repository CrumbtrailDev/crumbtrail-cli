import type { EvidenceItem, EvidenceLane, IntentSignal } from "./evidence";
import type { EvidenceJoinKey } from "./evidence-source";
import { tokenize } from "./tokenize";

/**
 * @stability stable
 * Version-bump policy (additive-on-v1 vs fusion.v2) is War-game 01 Fork A's
 * decision, not this file's — see wargames/wargames/01-solve-context-wargame-fields.md.
 */
export const FUSION_SCHEMA_VERSION = "fusion.v1" as const;

export type HypothesisKind =
  | "regression"
  | "latent"
  | "environment"
  | "client-side"
  | "intentional-change"
  | "inconclusive";

export interface Symptom {
  title: string;
  description?: string;
  release?: string;
  /**
   * A URL carried by the report: the page the reporter was on, or the tracker's
   * own link to the ticket. It is a loose TEXT hint — {@link rankEvidence}
   * scores it as a case-insensitive substring of an evidence item's signature
   * or brief — and it is deliberately NOT the correlation key.
   *
   * Ticket normalisers set this to the tracker's issue URL, which never appears
   * inside application evidence. Put the application path in {@link route}
   * instead; that is the field the incident-location scorer compares.
   */
  url?: string;
  /**
   * The application route the reported failure happened on, as the application
   * itself records it: a path such as `/checkout` or `/api/orders/:id`, with no
   * scheme, host, query string or fragment.
   *
   * This is the correlation key behind the "same route" facet of the
   * incident-location scorer, which compares it for EQUALITY (trimmed,
   * case-insensitive) against a recorded bug's `representative.route`. A value
   * carrying a host or a query string therefore matches nothing, and belongs in
   * {@link url}.
   */
  route?: string;
  user?: string;
  /**
   * The error family the report is about, in the same vocabulary the capture
   * side uses for a distinct bug's `representative.detector` — the detector id,
   * for example `console_error` or `net_5xx`, NOT a stack hash or a message.
   *
   * The "same error family" facet compares it for exact equality against that
   * detector id, so any other vocabulary silently scores zero. Leave it unset
   * when the report does not name one; an invented value is worse than none.
   */
  errorSig?: string;
  source?: string;
}

export interface Hypothesis {
  kind: HypothesisKind;
  /** 0..1 advisory confidence. Not a probability; a ranking signal. */
  confidence: number;
  rationale: string;
  /** EvidenceItem.id values backing this hypothesis. */
  evidenceIds: string[];
  /**
   * Advisory, additive: concrete observations that would confirm a fix for
   * THIS hypothesis worked. Emitted only for non-inconclusive hypotheses whose
   * cited evidence carries a concrete anchor (signature / requestId /
   * table+pk); absent otherwise. Sparse-and-concrete by design — never vacuous
   * prose like "verify the bug is gone". See {@link Verification}.
   */
  verification?: Verification[];
}

/**
 * A concrete, post-fix observation that would confirm a hypothesis's fix
 * worked. `observation` always names a concrete signal (an error signature, a
 * request id, or a table + primary key) — the derivation emits nothing when it
 * cannot anchor to one, so an emitted verification is never a vacuous
 * restatement.
 */
export interface Verification {
  /** Names a concrete signal — signature, request id, or table/pk. */
  observation: string;
  /** EvidenceItem.id values this observation is anchored to. */
  evidenceIds: string[];
  how: "session" | "request" | "db";
}

/**
 * Where the incident was located, when a locate ran. Advisory and optional
 * (absent for explicit baseline/current comparison bundles that never locate).
 * Shape shared with the node locate engine's `LocateMatch` and War-game 02's
 * deterministic token join — `method` distinguishes the two so 02 can populate
 * "token" without a schema change (War-game 02 Fork C: one definition, reused).
 */
export interface Located {
  outcome: "matched" | "ambiguous" | "inconclusive";
  /** 0..1 locate confidence. */
  confidence: number;
  /**
   * How the incident was located. "fuzzy" = the scored locate engine;
   * "token" = a deterministic token join (War-game 02). Absent when a caller
   * supplies neither.
   */
  method?: "fuzzy" | "token";
  /** The matched session, present ONLY when outcome === "matched". Never fabricated. */
  sessionId?: string;
  reasons?: string[];
  /** Compact candidate projection for an ambiguous locate. */
  candidates?: Array<{
    sessionId: string;
    bugId: string;
    confidence: number;
    reasons: string[];
  }>;
}

/**
 * Bundle-level answer to "how much context do we actually have here?" — the
 * LOW_CONTEXT signal. Derived purely from the assembled bundle (evidence
 * lanes, gaps, hypothesis strength, locate confidence). Advisory: it NEVER
 * gates or blocks bundle emission. `reasons` is the load-bearing part; `score`
 * and `level` summarize it.
 */
export interface ContextCompleteness {
  /** 0..1; higher = richer, more actionable context. */
  score: number;
  level: "high" | "medium" | "low";
  /** Human-legible drivers: missing lanes, thin evidence, inconclusive locate. */
  reasons: string[];
}

/**
 * Consumer-side advisory: what the CONSUMING agent should do when context is
 * thin. Distinct from {@link EvidenceGap} (capture-side: what evidence is
 * missing) — escalation is what to do about it. Always present; `recommended`
 * is false with an empty `when` when context is adequate. Never gates the
 * bundle (VISION: advisory, never a boolean verdict on the bug itself).
 */
export interface Escalation {
  recommended: boolean;
  /** Conditions phrased for the consuming agent, e.g. "if you cannot reproduce
   *  via the anchored request, stop and request human triage". */
  when: string[];
}

export interface EvidenceGap {
  lane: EvidenceLane;
  reason: string;
  suggestion?: string;
  /**
   * Optional structured severity marker. Additive and defaults to an ordinary
   * informational gap when absent (e.g. a missing join key, or a partial
   * enrichment/secondary gap) — those never affect a source's health.
   *
   * `"source-unavailable"` marks a HARD failure: the adapter could not deliver
   * its primary evidence at all (dispatch/auth failure, or a timeout that
   * retrieved zero items) and self-degraded to a gap instead of throwing. The
   * evidence framework reads this typed marker — never the free-text `reason` —
   * to decide `stats.ok`, so a self-degrading source and a throwing source emit
   * the same health signal. See node `fetch-all.ts`.
   */
  kind?: "source-unavailable";
}

/**
 * Why a source was not queried in a selective retrieval pass. `lane_not_relevant`
 * means the source's lanes do not intersect the incident's candidate lanes,
 * `source_unavailable` means the connector has failed often enough to be treated
 * as down, and `missing_join_key` means nothing in the incident could key a query
 * against it.
 */
export type RetrievalDeferReason =
  "lane_not_relevant" | "source_unavailable" | "missing_join_key";

/**
 * What a selective retrieval pass decided before any adapter was queried: which
 * lanes the incident made candidates, which sources were queried, and which were
 * deferred with a reason.
 *
 * Reporting only. It explains a fan out that already happened and never gates
 * bundle emission, exactly like {@link ContextCompleteness}.
 *
 * `lanes` is typed as {@link EvidenceLane} rather than widened to `string`: the
 * producing prefilter carries `EvidenceLane[]` end to end, so the narrow type is
 * the honest one. The cloud's local copy of this shape declares `string[]`, which
 * is a widening with no deliberate reason recorded behind it.
 */
export interface RetrievalQualityReport {
  /** Always true: the report exists only when selective retrieval ran. */
  enabled: true;
  /** Lanes the incident made worth querying at all. */
  candidateLanes: EvidenceLane[];
  /** The only strategy shipped: a pure, deterministic, spend-free prefilter. */
  strategy: "deterministic_prefilter";
  /** Sources that were queried. */
  selected: Array<{
    sourceId: string;
    lanes: EvidenceLane[];
    /** Join keys the incident could actually supply for this source. */
    joinKeys: EvidenceJoinKey[];
    rationale: string;
  }>;
  /** Sources that were skipped, each with a typed reason and prose rationale. */
  deferred: Array<{
    sourceId: string;
    lanes: EvidenceLane[];
    reason: RetrievalDeferReason;
    rationale: string;
  }>;
  /** True means the deterministic result is final and no paid planner is useful. */
  plannerFree: boolean;
}

export interface RankedBundle {
  schemaVersion: typeof FUSION_SCHEMA_VERSION;
  symptom: Symptom;
  /** Complete, neutral evidence in ranked order. Never filtered. */
  evidence: EvidenceItem[];
  /** Advisory only. Consumers may ignore and use evidence directly. */
  opinion: { stance: "advisory"; hypotheses: Hypothesis[] };
  gaps: EvidenceGap[];
  /** How much actionable context this bundle carries. Advisory, never gates. */
  contextCompleteness: ContextCompleteness;
  /** What the consuming agent should do when context is thin. Advisory. */
  escalation: Escalation;
  /** Where the incident was located, when a locate ran. Absent otherwise. */
  located?: Located;
  /**
   * What a selective retrieval pass decided, when one ran. Advisory: it explains
   * which sources were queried and never gates the bundle. A bundle assembled by
   * the unconditional fan out over every configured source omits the field
   * entirely rather than reporting an empty pass.
   */
  retrieval?: RetrievalQualityReport;
}

export interface AssembleBundleInput {
  symptom: Symptom;
  evidence: EvidenceItem[];
  intent: IntentSignal[];
  gaps?: EvidenceGap[];
  /** The locate decision, when one ran (auto-locate / token join). Threaded
   *  onto the bundle as {@link RankedBundle.located} and folded into
   *  completeness. Omit for explicit baseline/current comparison bundles. */
  located?: Located;
  /** The selective retrieval decision, when one ran. Passed through onto the
   *  bundle as {@link RankedBundle.retrieval} and used for nothing else — it
   *  does not feed ranking, hypotheses, or completeness. Omit for the
   *  unconditional fan out. */
  retrieval?: RetrievalQualityReport;
}

/**
 * Compose the RankedBundle: rank the complete evidence set (nothing dropped),
 * classify advisory hypotheses, and pass through any evidence gaps. Pure.
 */
export function assembleBundle(input: AssembleBundleInput): RankedBundle {
  const evidence = rankEvidence(input.symptom, input.evidence);
  const classified = classifyHypotheses(
    input.symptom,
    input.evidence,
    input.intent,
  );
  const gaps = input.gaps ?? [];
  const located = input.located;

  // Move 4: attach concrete post-fix verification observations per hypothesis,
  // anchored to evidence signals. Vacuous-by-design impossible: emitted only
  // for anchored evidence kinds (see deriveVerification).
  const hypotheses = classified.map((hypothesis) => {
    const verification = deriveVerification(hypothesis, evidence);
    return verification.length > 0
      ? { ...hypothesis, verification }
      : hypothesis;
  });

  const contextCompleteness = deriveContextCompleteness(
    evidence,
    gaps,
    hypotheses,
    located,
  );
  const escalation = deriveEscalation(contextCompleteness, hypotheses);

  return {
    schemaVersion: FUSION_SCHEMA_VERSION,
    symptom: input.symptom,
    evidence,
    opinion: { stance: "advisory", hypotheses },
    gaps,
    contextCompleteness,
    escalation,
    ...(located ? { located } : {}),
    ...(input.retrieval ? { retrieval: input.retrieval } : {}),
  };
}

// --- war-game-grade advisory fields (Mission 01) --------------------------

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Informative lanes for completeness breadth — the lanes that actually
 *  discriminate a cause. Includes `env`, since a present env difference is real
 *  context.
 *
 *  `tickets`, `conversations`, and `deploys` are deliberately ABSENT, and this is
 *  not an oversight to correct. Breadth here saturates at three lanes and feeds
 *  the LOW_CONTEXT signal, so admitting a lane makes bundles read as more complete
 *  than they were. A tenant who connects Slack would see LOW_CONTEXT fall without
 *  any new evidence about the failure itself. Whether `deploys` earns a place is a
 *  deliberate re-tuning of a shipped signal, to be made against real bundles
 *  rather than folded into the change that introduced the lane. */
const COMPLETENESS_LANES: EvidenceLane[] = [
  "network",
  "db",
  "flow",
  "browser",
  "env",
];

/**
 * Derive the LOW_CONTEXT signal from the assembled bundle. Pure. Combines four
 * structured inputs the bundle already carries:
 *  - evidence breadth: how many informative lanes are present (0..1, saturates
 *    at 3 lanes),
 *  - evidence volume: raw item count (0..1, saturates at 5 items),
 *  - hypothesis strength: the top hypothesis's confidence, treated as 0 when
 *    the only thing we could say is "inconclusive",
 *  - locate confidence: when a locate ran, a matched high-confidence locate
 *    lifts the score and an inconclusive locate depresses it; when no locate
 *    ran (explicit comparison), locate is neutral.
 * Gaps subtract, with hard `source-unavailable` gaps weighing more than soft
 * informational ones. Weights were calibrated so thin / medium / full fixtures
 * land in distinct bands (see fusion completeness tests).
 */
function deriveContextCompleteness(
  evidence: EvidenceItem[],
  gaps: EvidenceGap[],
  hypotheses: Hypothesis[],
  located?: Located,
): ContextCompleteness {
  const lanesPresent = new Set(evidence.map((item) => item.lane));
  const informativePresent = COMPLETENESS_LANES.filter((lane) =>
    lanesPresent.has(lane),
  );
  const breadth = Math.min(1, informativePresent.length / 3);
  const volume = Math.min(1, evidence.length / 5);

  const top = hypotheses[0];
  const hypothesisStrength =
    !top || top.kind === "inconclusive" ? 0 : top.confidence;

  let score = 0.4 * breadth + 0.25 * volume + 0.35 * hypothesisStrength;

  if (located) {
    if (located.outcome === "matched") {
      score = 0.85 * score + 0.15 * clamp01(located.confidence);
    } else {
      // Ambiguous and inconclusive locations cannot increase confidence: no
      // single session has been identified safely enough to strengthen context.
      score *= 0.6;
    }
  }

  const hardGaps = gaps.filter(
    (gap) => gap.kind === "source-unavailable",
  ).length;
  const softGaps = gaps.length - hardGaps;
  const gapPenalty = Math.min(0.5, softGaps * 0.1 + hardGaps * 0.3);
  score = clamp01(score - gapPenalty);

  const level: ContextCompleteness["level"] =
    score < 0.34 ? "low" : score < 0.67 ? "medium" : "high";

  const reasons: string[] = [];
  const missingLanes = COMPLETENESS_LANES.filter(
    (lane) => !lanesPresent.has(lane),
  );
  if (informativePresent.length === 0) {
    reasons.push("no network/db/flow/browser/env evidence captured");
  } else if (missingLanes.length > 0) {
    reasons.push(`missing evidence lanes: ${missingLanes.join(", ")}`);
  }
  if (evidence.length > 0 && evidence.length < 3) {
    reasons.push(`thin evidence (${evidence.length} item(s))`);
  }
  if (hardGaps > 0) reasons.push(`source unavailable for ${hardGaps} lane(s)`);
  if (softGaps > 0) reasons.push(`${softGaps} evidence gap(s)`);
  if (located?.outcome === "inconclusive" || located?.outcome === "ambiguous") {
    reasons.push(
      located.outcome === "ambiguous"
        ? "incident location ambiguous"
        : "incident location inconclusive",
    );
  }
  if (!top || top.kind === "inconclusive") {
    reasons.push("no distinguishing hypothesis");
  }

  return { score, level, reasons };
}

/** Compact, deterministic rendering of a primary key for a verification observation. */
function pkString(pk: Record<string, unknown>): string {
  return Object.keys(pk)
    .sort()
    .map((key) => `${key}=${String(pk[key])}`)
    .join(", ");
}

/**
 * Derive concrete post-fix verification observations for one hypothesis from
 * the evidence it cites. Emits an observation ONLY when the evidence item
 * carries a concrete anchor (db table+pk, request id, or error signature), so
 * an emitted observation always names a real signal — sparse and concrete
 * beats complete and vacuous. `inconclusive` hypotheses get none (correct: a
 * fix we can't hypothesize can't be verified). Deterministic; preserves the
 * hypothesis's evidence order.
 */
function deriveVerification(
  hypothesis: Hypothesis,
  evidence: EvidenceItem[],
): Verification[] {
  if (hypothesis.kind === "inconclusive") return [];
  const cited = new Set(hypothesis.evidenceIds);
  const out: Verification[] = [];
  for (const item of evidence) {
    if (!cited.has(item.id)) continue;
    const ref = item.ref;
    if (
      item.lane === "db" &&
      ref.table &&
      ref.pk &&
      Object.keys(ref.pk).length > 0
    ) {
      out.push({
        observation: `row in ${ref.table} (${pkString(ref.pk)}) matches the intended post-fix state`,
        evidenceIds: [item.id],
        how: "db",
      });
    } else if (ref.requestId) {
      const sigPart = ref.sig ? ` for signature ${ref.sig}` : "";
      out.push({
        observation: `request ${ref.requestId} succeeds${sigPart} on a fresh run (no error response)`,
        evidenceIds: [item.id],
        how: "request",
      });
    } else if (ref.sig) {
      out.push({
        observation: `error signature ${ref.sig} no longer appears in a fresh session over the same route`,
        evidenceIds: [item.id],
        how: "session",
      });
    }
    // No anchor → emit nothing for this item.
  }
  return out;
}

/**
 * Derive the consumer-side escalation advisory. Recommended when context is
 * thin (low completeness) or every hypothesis is inconclusive. `when`
 * conditions are phrased for the consuming agent. Never gates the bundle.
 */
function deriveEscalation(
  completeness: ContextCompleteness,
  hypotheses: Hypothesis[],
): Escalation {
  const allInconclusive =
    hypotheses.length > 0 &&
    hypotheses.every((hypothesis) => hypothesis.kind === "inconclusive");
  const recommended = completeness.level === "low" || allInconclusive;
  if (!recommended) return { recommended: false, when: [] };

  const when: string[] = [
    "if you cannot reproduce the symptom via the anchored request or session, stop and request human triage — do not widen the search",
  ];
  if (completeness.level === "low") {
    when.push(
      "context is thin: confirm the missing evidence lanes before acting on the top hypothesis",
    );
  }
  if (allInconclusive) {
    when.push(
      "no hypothesis is distinguished; treat the listed causes as equally unproven",
    );
  }
  return { recommended, when };
}

// --- evidence ranking (formerly fusion-rank.ts) ---------------------------

/**
 * Per-lane ranking bonus, added to an item's score (see below, capped at 1).
 * Deliberately NOT normalized across lanes: the value is an additive bonus with a
 * `?? 0.05` fallback, so introducing a lane cannot re-rank evidence in lanes that
 * already existed. That is what makes widening {@link EvidenceLane} additive
 * rather than a silent change to every tenant's existing ranking.
 *
 * `deploys` is weighted with the causal lanes rather than the corroborating ones.
 * A release inside the incident window is a direct candidate cause, unlike a
 * ticket or a Slack thread, which describe a failure without evidencing it.
 */
const LANE_PRIOR: Record<EvidenceLane, number> = {
  db: 0.2,
  network: 0.2,
  flow: 0.15,
  deploys: 0.15,
  env: 0.1,
  browser: 0.1,
  logs: 0.05,
  memory: 0.05,
  code: 0.05,
  tickets: 0.05,
  conversations: 0.05,
};

/** Jaccard overlap of two token sets; 0 when both are empty. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function symptomText(symptom: Symptom): string {
  return [symptom.title, symptom.description, symptom.errorSig]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/**
 * Deterministic relevance score in [0,1] for one evidence item against a
 * symptom. No embeddings — explainable weighted sum:
 *  - 0.5 if symptom.url appears (case-insensitive substring) in the item's
 *    ref.sig or brief.
 *  - 0.3 token overlap (Jaccard) between symptom text and brief+kind.
 *  - 0.2 lane prior (db/network highest, then flow, then env/browser, else low).
 */
function scoreEvidenceRelevance(symptom: Symptom, item: EvidenceItem): number {
  let score = 0;

  if (symptom.url) {
    const needle = symptom.url.toLowerCase();
    const haystack = `${item.ref.sig ?? ""} ${item.brief}`.toLowerCase();
    if (haystack.includes(needle)) score += 0.5;
  }

  const symptomTokens = tokenize(symptomText(symptom));
  const itemTokens = tokenize(`${item.brief} ${item.kind}`);
  score += 0.3 * jaccard(symptomTokens, itemTokens);

  score += LANE_PRIOR[item.lane] ?? 0.05;

  return Math.min(1, score);
}

/**
 * Rank evidence by relevance to the symptom, highest first. Stable sort;
 * ties preserve original order. ALL items are returned — nothing dropped.
 */
function rankEvidence(symptom: Symptom, items: EvidenceItem[]): EvidenceItem[] {
  return items
    .map((item, index) => ({
      item,
      index,
      score: scoreEvidenceRelevance(symptom, item),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

// --- hypothesis classification (formerly fusion-hypotheses.ts) ------------

/**
 * Classify evidence + intent into advisory hypotheses. Anti-overfit core:
 * evidence explained by a deliberate commit is split into
 * `intentional-change` and never counted toward `regression`.
 * Pure, deterministic, never throws. Ordered by confidence desc.
 */
function classifyHypotheses(
  symptom: Symptom,
  evidence: EvidenceItem[],
  intent: IntentSignal[],
): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];

  const evidenceIds = new Set(evidence.map((item) => item.id));
  const explainedById = new Map<string, IntentSignal>();
  for (const signal of intent) {
    if (signal.explainedByCommit && evidenceIds.has(signal.evidenceId)) {
      explainedById.set(signal.evidenceId, signal);
    }
  }

  // 1. intentional-change — one hypothesis per explained evidence id.
  for (const [evidenceId, signal] of explainedById) {
    const commit = signal.explainedByCommit!;
    hypotheses.push({
      kind: "intentional-change",
      confidence: 0.7,
      rationale: `explained by commit ${commit.sha}: ${commit.message}`,
      evidenceIds: [evidenceId],
    });
  }

  const unexplained = evidence.filter((item) => !explainedById.has(item.id));

  // 2. regression — unexplained, comparative network/db/flow evidence.
  const regressionEvidence = unexplained.filter(
    (item) =>
      (item.lane === "network" || item.lane === "db" || item.lane === "flow") &&
      hasComparativeChange(item),
  );
  if (regressionEvidence.length > 0) {
    const confidence = Math.min(0.9, 0.4 + 0.1 * regressionEvidence.length);
    hypotheses.push({
      kind: "regression",
      confidence,
      rationale: `${regressionEvidence.length} behavior change(s) vs baseline with no matching intentional commit`,
      evidenceIds: regressionEvidence.map((item) => item.id),
    });
  }

  // 3. environment — unexplained env-lane evidence.
  const envEvidence = unexplained.filter((item) => item.lane === "env");
  if (envEvidence.length > 0) {
    hypotheses.push({
      kind: "environment",
      confidence: 0.5,
      rationale: "environment/config differs",
      evidenceIds: envEvidence.map((item) => item.id),
    });
  }

  // 4. client-side — browser-lane evidence.
  const browserEvidence = unexplained.filter((item) => item.lane === "browser");
  if (browserEvidence.length > 0) {
    hypotheses.push({
      kind: "client-side",
      confidence: 0.5,
      rationale: "client-side factor (browser/network/device)",
      evidenceIds: browserEvidence.map((item) => item.id),
    });
  }

  // 5. latent — no evidence at all, but a non-empty symptom.
  if (evidence.length === 0 && symptom.title.trim().length > 0) {
    hypotheses.push({
      kind: "latent",
      confidence: 0.3,
      rationale:
        "no behavior change captured; likely a long-standing/latent issue or missing instrumentation",
      evidenceIds: [],
    });
  }

  // 6. inconclusive — nothing else emitted.
  if (hypotheses.length === 0) {
    hypotheses.push({
      kind: "inconclusive",
      confidence: 0.2,
      rationale: "insufficient evidence to distinguish causes",
      evidenceIds: [],
    });
  }

  return hypotheses
    .map((hypothesis, index) => ({ hypothesis, index }))
    .sort((a, b) => {
      if (b.hypothesis.confidence !== a.hypothesis.confidence) {
        return b.hypothesis.confidence - a.hypothesis.confidence;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.hypothesis);
}

function hasComparativeChange(item: EvidenceItem): boolean {
  if (item.before === undefined || item.after === undefined) return false;
  return evidenceValuesEqual(item.before, item.after) === false;
}

/**
 * Compares JSON-shaped evidence without depending on object key insertion
 * order. An unsupported or cyclic value is inconclusive, so it cannot support
 * a regression claim.
 */
function evidenceValuesEqual(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>(),
): boolean | undefined {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null)
    return false;
  if (typeof left !== "object" || typeof right !== "object") return false;

  const prior = seen.get(left);
  if (prior) return prior === right ? true : undefined;
  seen.set(left, right);

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const equal = evidenceValuesEqual(left[index], right[index], seen);
      if (equal !== true) return equal;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    const equal = evidenceValuesEqual(
      leftRecord[leftKeys[index]],
      rightRecord[rightKeys[index]],
      seen,
    );
    if (equal !== true) return equal;
  }
  return true;
}
