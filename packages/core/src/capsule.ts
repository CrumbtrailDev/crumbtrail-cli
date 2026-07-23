/**
 * capsule.v2 — the additive issue-resolution envelope (CRUMB-60, CP3).
 *
 * capsule.v2 wraps the existing neutral ranked evidence bundle (`fusion.v1`
 * {@link RankedBundle}) in a ten-part envelope that a resolving agent can act
 * on: identity, symptom, occurrences/impact, evidence, join graph, quality
 * report, advisory opinion, memory, resolution, and agent directions.
 *
 * It is strictly ADDITIVE. Part 4 REUSES the existing {@link RankedBundle}
 * verbatim — the compiler references it, never re-ranks or re-shapes it — so
 * every v1 consumer keeps working. No new capability duplicates fusion's
 * ranking/opinion; the capsule only frames and correlates what fusion produced.
 *
 * Correlation + completeness rules enforced here (types and/or compiler):
 *  - Key provenance is one of captured | provider_mapped | inferred
 *    ({@link KeyProvenance}).
 *  - Time proximity is NEVER an exact causal join — a `time_proximity` edge is
 *    type-forbidden from carrying `causal: true` (see {@link JoinEdge}).
 *  - Unjoined evidence is preserved as an explicit {@link JoinIsland}, never
 *    silently dropped.
 *  - Gap reasons come from a CLOSED vocabulary ({@link GAP_REASONS} /
 *    {@link GapReason}).
 *  - Completeness is computed ONLY against an {@link EvidenceProfile}
 *    denominator. Without a profile the quality report carries no score — the
 *    `profile`/`completeness` pair is type-linked so a bare number is
 *    impossible (see {@link QualityReport}).
 *  - A degraded capsule is still deliverable: the compiler always returns a
 *    capsule, carrying its limits and an inconclusive advisory when input is
 *    thin. Quality is never a blocking verdict.
 *  - The envelope carries no recoverable secrets and copies no unrestricted raw
 *    provider telemetry: evidence is referenced through the already-neutral,
 *    redacted {@link RankedBundle} / {@link EvidenceRef} surface only.
 */
import type { EvidenceLane, EvidenceRef } from "./evidence";
import type { EvidenceJoinKey } from "./evidence-source";
import type {
  HypothesisKind,
  RankedBundle,
  Symptom,
  Verification,
} from "./fusion";

/** Schema tag for the capsule envelope. Additive alongside `fusion.v1`. */
export const CAPSULE_SCHEMA_VERSION = "capsule.v2" as const;

/**
 * How a correlation key's value was obtained for a given evidence item.
 * Closed union — an inferred key must never be presented as a captured one.
 */
export type KeyProvenance = "captured" | "provider_mapped" | "inferred";

/**
 * CLOSED gap vocabulary. Every gap the capsule emits must name one of these —
 * free text is never a gap reason. Consumers can switch exhaustively on it.
 */
export const GAP_REASONS = [
  "not_configured",
  "disconnected",
  "retention_expired",
  "policy_redacted",
  "missing_join_key",
  "query_timeout",
  "source_unavailable",
  "no_matching_evidence",
] as const;

export type GapReason = (typeof GAP_REASONS)[number];

/** Runtime guard: is a string a member of the closed gap vocabulary? */
export function isGapReason(value: unknown): value is GapReason {
  return (
    typeof value === "string" &&
    (GAP_REASONS as readonly string[]).includes(value)
  );
}

// --- Part 1: Identity ------------------------------------------------------

/** A reference to this issue in an external system (tracker, provider, VCS). */
export interface ExternalRef {
  /** Stable system id, e.g. "jira" | "sentry" | "github". */
  system: string;
  /** Native id within that system. */
  id: string;
  /** Optional deep link for human verification. Token-bearing URLs are scrubbed
   *  at the redaction boundary before they reach here. */
  url?: string;
}

export interface CapsuleIdentity {
  /** Canonical, cross-source issue id this capsule speaks for. */
  canonicalId: string;
  /** Stable signature grouping recurrences of the same issue. */
  signature: string;
  /** External references (tracker/provider/VCS). Additive, may be empty. */
  externalRefs: ExternalRef[];
  /** Schema tag — always "capsule.v2". */
  schemaVersion: typeof CAPSULE_SCHEMA_VERSION;
  /** Monotonic revision of this capsule for the canonical id. */
  revision: number;
}

// --- Part 2: Symptom -------------------------------------------------------

export interface CapsuleSymptom {
  /** Bounded, user-visible behavior. Reuses the fusion {@link Symptom} shape. */
  behavior: Symptom;
  /** Authoritative known facts, stated plainly. May be empty. */
  knownFacts: string[];
}

// --- Part 3: Occurrences and impact ---------------------------------------

/**
 * Privacy-safe aggregate impact. Counts only — never per-subject identifiers.
 * `provenance` records how the counts were derived (captured telemetry,
 * provider-mapped, or inferred) so an estimate is never read as a measurement.
 */
export interface OccurrenceImpact {
  sessions: number;
  users: number;
  tenants: number;
  /** Affected release identifiers. */
  releases: string[];
  /** How the aggregate was derived. */
  provenance: KeyProvenance;
  /** True when the aggregate carries no per-subject identifiers. */
  privacySafe: boolean;
}

// --- Part 4: Evidence (REUSES the existing ranked bundle) ------------------

export interface CapsuleEvidence {
  /** The existing neutral ranked bundle, referenced verbatim. Not re-ranked. */
  bundle: RankedBundle;
  /** Evidence references (deep links / provider anchors). Additive. */
  refs: EvidenceRef[];
}

// --- Part 5: Join graph ----------------------------------------------------

/** Why two evidence items are linked. A shared join key vs. mere time nearness. */
export type JoinBasis = "shared_key" | "time_proximity";

/**
 * One edge in the join graph, connecting two evidence items.
 *
 * Discriminated on {@link JoinBasis}. A `time_proximity` edge is type-forbidden
 * from asserting causation: its `causal` field can only be `false`. A
 * `shared_key` edge may assert causation, but the compiler only does so for a
 * captured key.
 */
export type JoinEdge =
  | {
      basis: "shared_key";
      fromEvidenceId: string;
      toEvidenceId: string;
      key: EvidenceJoinKey;
      provenance: KeyProvenance;
      /** 0..1 join confidence. */
      confidence: number;
      /** Whether this edge asserts causation (only ever true for a captured key). */
      causal: boolean;
    }
  | {
      basis: "time_proximity";
      fromEvidenceId: string;
      toEvidenceId: string;
      key: EvidenceJoinKey;
      provenance: KeyProvenance;
      confidence: number;
      /** Time proximity is never causal — the type pins this to false. */
      causal: false;
    };

/** Evidence that could not be joined to anything, preserved explicitly. */
export interface JoinIsland {
  evidenceId: string;
  lane: EvidenceLane;
  /** Why it is unjoined — from the closed vocabulary. */
  reason: GapReason;
}

export interface JoinGraph {
  edges: JoinEdge[];
  /** Unjoined evidence, never dropped. */
  islands: JoinIsland[];
}

/**
 * Compiler input describing one observed correlation between evidence items.
 * The compiler expands each into pairwise {@link JoinEdge}s.
 */
export interface JoinObservation {
  /** 2+ evidence ids this correlation links, in order. */
  evidenceIds: string[];
  key: EvidenceJoinKey;
  provenance: KeyProvenance;
  basis: JoinBasis;
  /** 0..1 confidence; defaults to a provenance-derived value when omitted. */
  confidence?: number;
}

// --- Part 6: Quality report ------------------------------------------------

/**
 * The completeness DENOMINATOR: what evidence we should expect, derived from
 * configured sources + capture policy + the critical flow under test. A
 * completeness score is only meaningful against this. When absent, no score is
 * emitted.
 */
export interface EvidenceProfile {
  /** Lanes we expect to see given configuration + policy + flow. */
  expectedLanes: EvidenceLane[];
  /** Configured source provider ids that back the expectation. */
  configuredSources: string[];
  /** Capture-policy label that shaped the expectation (optional). */
  capturePolicy?: string;
  /** Critical flow the expectation is scoped to (optional). */
  criticalFlow?: string;
}

/** One quality gap, always naming a closed {@link GapReason}. */
export interface GapDetail {
  lane: EvidenceLane;
  reason: GapReason;
  /** Optional free-text context. Never itself the reason. */
  detail?: string;
}

/** Completeness score, always paired with its denominator — never bare. */
export interface Completeness {
  /** 0..1 = present expected lanes / expected lanes. */
  score: number;
  /** Denominator: number of expected lanes. */
  expected: number;
  /** Numerator: expected lanes actually present. */
  present: number;
}

interface QualityReportCommon {
  presentLanes: EvidenceLane[];
  /** Expected-but-absent lanes. Empty without a profile (no denominator). */
  missingLanes: EvidenceLane[];
  /** All quality gaps, closed-vocab reasons. */
  gaps: GapDetail[];
  /** Policy redactions (reason: policy_redacted). */
  redactions: GapDetail[];
  /** Query failures (reason: query_timeout | source_unavailable). */
  queryFailures: GapDetail[];
}

/**
 * Quality report. The `profile`/`completeness` pair is type-linked: a report
 * either carries both or neither, so a completeness score can never appear
 * without its {@link EvidenceProfile} denominator.
 */
export type QualityReport = QualityReportCommon &
  (
    | { profile: EvidenceProfile; completeness: Completeness }
    | { profile?: undefined; completeness?: undefined }
  );

// --- Part 7: Advisory opinion ---------------------------------------------

export interface FixClass {
  kind: HypothesisKind;
  /** 0..1 advisory confidence. Not a probability. */
  confidence: number;
  rationale: string;
  /** EvidenceItem.id values backing this fix class. */
  citations: string[];
}

/**
 * Ranked advisory opinion. `inconclusive` is an explicit state, set true when
 * no fix class is distinguished (degraded/thin input). Advisory only — it never
 * gates delivery.
 */
export interface AdvisoryOpinion {
  stance: "advisory";
  /** Ranked fix classes, highest confidence first. */
  fixClasses: FixClass[];
  /** Explicit inconclusive verdict. */
  inconclusive: boolean;
  knowns: string[];
  unknowns: string[];
}

// --- Part 8: Memory --------------------------------------------------------

export interface VerifiedFix {
  release: string;
  /** ms epoch when verified, if known. */
  verifiedAt?: number;
  outcome: "verified" | "regressed";
}

export interface CapsuleMemory {
  /** Related canonical issue ids. */
  relatedIssues: string[];
  /** Prior resolution note, if this issue was resolved before. */
  priorResolution?: string;
  /** Recurrence signal. */
  recurrence?: { count: number; window?: string };
  /** Verified fix history for this issue. */
  verifiedFixHistory: VerifiedFix[];
}

// --- Part 9: Resolution ----------------------------------------------------

export interface CapsuleResolution {
  /** Linked fix reference (commit/PR/change id), if any. */
  linkedFix?: string;
  /** Release the fix shipped in, if any. */
  release?: string;
  verificationState: "unverified" | "pending" | "verified" | "regressed";
  /** Post-fix observation window. */
  observationWindow?: { start: number; end?: number };
}

// --- Part 10: Agent directions --------------------------------------------

export interface AgentDirections {
  /** Bounded next actions for the resolving agent. */
  nextActions: string[];
  /** Concrete post-fix verification recipe. Reuses fusion {@link Verification}. */
  verificationRecipe: Verification[];
}

// --- The envelope ----------------------------------------------------------

export interface CapsuleV2 {
  schemaVersion: typeof CAPSULE_SCHEMA_VERSION;
  identity: CapsuleIdentity;
  symptom: CapsuleSymptom;
  occurrences: OccurrenceImpact;
  evidence: CapsuleEvidence;
  joinGraph: JoinGraph;
  quality: QualityReport;
  advisory: AdvisoryOpinion;
  memory: CapsuleMemory;
  resolution: CapsuleResolution;
  directions: AgentDirections;
}

// --- Compiler --------------------------------------------------------------

export interface CompileCapsuleV2Input {
  identity: {
    canonicalId: string;
    signature: string;
    externalRefs?: ExternalRef[];
    /** Defaults to 1. */
    revision?: number;
  };
  /** The existing ranked bundle — reused verbatim as part 4. Required. */
  bundle: RankedBundle;
  knownFacts?: string[];
  /** Partial impact; missing fields default to a privacy-safe inferred zero. */
  occurrences?: Partial<OccurrenceImpact>;
  /** The completeness denominator. Omit to emit no completeness score. */
  evidenceProfile?: EvidenceProfile;
  /** Observed correlations between evidence items. */
  joins?: JoinObservation[];
  /** Closed-vocab quality gaps beyond what the bundle carries. */
  gaps?: GapDetail[];
  /** Policy redactions (reason forced to policy_redacted). */
  redactions?: GapDetail[];
  /** Query failures (reason must be query_timeout | source_unavailable). */
  queryFailures?: GapDetail[];
  memory?: Partial<CapsuleMemory>;
  resolution?: Partial<CapsuleResolution>;
}

function confidenceForProvenance(provenance: KeyProvenance): number {
  switch (provenance) {
    case "captured":
      return 0.9;
    case "provider_mapped":
      return 0.6;
    case "inferred":
      return 0.3;
  }
}

/** Build the join graph: pairwise edges from observations, plus islands for
 *  every evidence item that no edge touches. Never asserts causation from time
 *  proximity (type-enforced) and never drops an unjoined item. */
function buildJoinGraph(
  bundle: RankedBundle,
  joins: JoinObservation[],
): JoinGraph {
  const edges: JoinEdge[] = [];
  const joinedIds = new Set<string>();

  for (const obs of joins) {
    const ids = obs.evidenceIds;
    if (ids.length < 2) continue;
    const confidence = obs.confidence ?? confidenceForProvenance(obs.provenance);
    for (let i = 0; i < ids.length - 1; i++) {
      const fromEvidenceId = ids[i];
      const toEvidenceId = ids[i + 1];
      joinedIds.add(fromEvidenceId);
      joinedIds.add(toEvidenceId);
      if (obs.basis === "time_proximity") {
        // Time proximity is correlation, not causation — never causal.
        edges.push({
          basis: "time_proximity",
          fromEvidenceId,
          toEvidenceId,
          key: obs.key,
          provenance: obs.provenance,
          confidence,
          causal: false,
        });
      } else {
        // A shared key asserts causation only when the key was actually
        // captured; a provider-mapped or inferred key is correlation only.
        edges.push({
          basis: "shared_key",
          fromEvidenceId,
          toEvidenceId,
          key: obs.key,
          provenance: obs.provenance,
          confidence,
          causal: obs.provenance === "captured",
        });
      }
    }
  }

  const islands: JoinIsland[] = [];
  for (const item of bundle.evidence) {
    if (joinedIds.has(item.id)) continue;
    islands.push({
      evidenceId: item.id,
      lane: item.lane,
      reason: "missing_join_key",
    });
  }

  return { edges, islands };
}

/** Map the fusion bundle's gaps into closed-vocab {@link GapDetail}s. A typed
 *  `source-unavailable` bundle gap becomes the `source_unavailable` reason;
 *  every other bundle gap lands on `no_matching_evidence`, preserving its
 *  free text as `detail`. Guarantees a closed reason for every emitted gap. */
function mapBundleGaps(bundle: RankedBundle): {
  gaps: GapDetail[];
  queryFailures: GapDetail[];
} {
  const gaps: GapDetail[] = [];
  const queryFailures: GapDetail[] = [];
  for (const gap of bundle.gaps) {
    if (gap.kind === "source-unavailable") {
      queryFailures.push({
        lane: gap.lane,
        reason: "source_unavailable",
        detail: gap.reason,
      });
    } else {
      gaps.push({
        lane: gap.lane,
        reason: "no_matching_evidence",
        detail: gap.reason,
      });
    }
  }
  return { gaps, queryFailures };
}

function buildQualityReport(
  bundle: RankedBundle,
  input: CompileCapsuleV2Input,
): QualityReport {
  const presentLanes = [...new Set(bundle.evidence.map((item) => item.lane))];
  const bundleGaps = mapBundleGaps(bundle);

  const redactions: GapDetail[] = (input.redactions ?? []).map((r) => ({
    ...r,
    reason: "policy_redacted",
  }));
  const queryFailures: GapDetail[] = [
    ...bundleGaps.queryFailures,
    ...(input.queryFailures ?? []),
  ];
  const gaps: GapDetail[] = [
    ...bundleGaps.gaps,
    ...(input.gaps ?? []),
    ...redactions,
    ...queryFailures,
  ];

  const common: QualityReportCommon = {
    presentLanes,
    missingLanes: [],
    gaps,
    redactions,
    queryFailures,
  };

  const profile = input.evidenceProfile;
  if (!profile) {
    // No denominator → no completeness score. Missing lanes are undefinable.
    return { ...common };
  }

  const presentSet = new Set(presentLanes);
  const expected = profile.expectedLanes;
  const presentExpected = expected.filter((lane) => presentSet.has(lane));
  const missingLanes = expected.filter((lane) => !presentSet.has(lane));
  const score =
    expected.length === 0 ? 0 : presentExpected.length / expected.length;

  return {
    ...common,
    missingLanes,
    profile,
    completeness: {
      score,
      expected: expected.length,
      present: presentExpected.length,
    },
  };
}

function buildAdvisory(bundle: RankedBundle): AdvisoryOpinion {
  const hypotheses = bundle.opinion.hypotheses;
  const fixClasses: FixClass[] = hypotheses.map((h) => ({
    kind: h.kind,
    confidence: h.confidence,
    rationale: h.rationale,
    citations: h.evidenceIds,
  }));

  const inconclusive =
    hypotheses.length === 0 ||
    hypotheses.every((h) => h.kind === "inconclusive");

  const knowns: string[] = [];
  const top = hypotheses[0];
  if (top && top.kind !== "inconclusive") {
    knowns.push(top.rationale);
  }
  const unknowns = [...bundle.contextCompleteness.reasons];

  return { stance: "advisory", fixClasses, inconclusive, knowns, unknowns };
}

function buildDirections(bundle: RankedBundle): AgentDirections {
  const verificationRecipe: Verification[] = [];
  for (const h of bundle.opinion.hypotheses) {
    if (h.verification) verificationRecipe.push(...h.verification);
  }
  const nextActions = bundle.escalation.recommended
    ? [...bundle.escalation.when]
    : ["proceed on the top advisory fix class, then run the verification recipe"];
  return { nextActions, verificationRecipe };
}

/**
 * Compile a capsule.v2 envelope from the existing ranked bundle plus available
 * inputs. Pure and total: always returns a deliverable capsule, even for thin /
 * degraded input (which yields an inconclusive advisory). The input bundle is
 * referenced verbatim in part 4 and never mutated.
 */
export function compileCapsuleV2(input: CompileCapsuleV2Input): CapsuleV2 {
  const { bundle } = input;

  const identity: CapsuleIdentity = {
    canonicalId: input.identity.canonicalId,
    signature: input.identity.signature,
    externalRefs: input.identity.externalRefs ?? [],
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    revision: input.identity.revision ?? 1,
  };

  const symptom: CapsuleSymptom = {
    behavior: bundle.symptom,
    knownFacts: input.knownFacts ?? [],
  };

  const occInput = input.occurrences ?? {};
  const occurrences: OccurrenceImpact = {
    sessions: occInput.sessions ?? 0,
    users: occInput.users ?? 0,
    tenants: occInput.tenants ?? 0,
    releases: occInput.releases ?? [],
    provenance: occInput.provenance ?? "inferred",
    privacySafe: occInput.privacySafe ?? true,
  };

  const evidence: CapsuleEvidence = {
    bundle,
    refs: bundle.evidence.map((item) => item.ref),
  };

  const joinGraph = buildJoinGraph(bundle, input.joins ?? []);
  const quality = buildQualityReport(bundle, input);
  const advisory = buildAdvisory(bundle);

  const memory: CapsuleMemory = {
    relatedIssues: input.memory?.relatedIssues ?? [],
    verifiedFixHistory: input.memory?.verifiedFixHistory ?? [],
    ...(input.memory?.priorResolution !== undefined
      ? { priorResolution: input.memory.priorResolution }
      : {}),
    ...(input.memory?.recurrence !== undefined
      ? { recurrence: input.memory.recurrence }
      : {}),
  };

  const resolution: CapsuleResolution = {
    verificationState: input.resolution?.verificationState ?? "unverified",
    ...(input.resolution?.linkedFix !== undefined
      ? { linkedFix: input.resolution.linkedFix }
      : {}),
    ...(input.resolution?.release !== undefined
      ? { release: input.resolution.release }
      : {}),
    ...(input.resolution?.observationWindow !== undefined
      ? { observationWindow: input.resolution.observationWindow }
      : {}),
  };

  const directions = buildDirections(bundle);

  return {
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    identity,
    symptom,
    occurrences,
    evidence,
    joinGraph,
    quality,
    advisory,
    memory,
    resolution,
    directions,
  };
}
