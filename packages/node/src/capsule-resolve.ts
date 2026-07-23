import {
  compileCapsuleV2,
  hashString,
  type CapsuleV2,
  type CompileCapsuleV2Input,
  type ExternalRef,
  type RankedBundle,
  type Symptom,
} from "crumbtrail-core";
import {
  locateAndAssemble,
  type AdapterPhaseOptions,
  type EvidenceSourceHealth,
  type LocateIncidentOptions,
  type LocateMatch,
} from "./locate-incident";
import type { RecallStore } from "./recall";

// --- capsule.v2 resolution (CRUMB-60) --------------------------------------
//
// crumbtrail-node's SINGLE bridge from the existing fusion.v1 {@link RankedBundle}
// to the additive capsule.v2 envelope. It owns the one `compileCapsuleV2` call
// site in the package so the MCP `resolveCapsule` tool and the CLI `capsule`
// command share ONE compile path and stay at parity — neither re-implements the
// compile, and neither re-ranks or re-shapes evidence. The bundle is referenced
// verbatim as capsule part 4.
//
// Node supplies only the compiler inputs it actually has at this resolution
// point — the resolved bundle plus a derived identity/signature — and lets the
// (total) core compiler fill everything it omits with a deliverable, degraded
// capsule. Node does NOT fabricate occurrences, an evidence profile (completeness
// denominator), join observations, memory, or a resolution state; the compiler
// defaults those to privacy-safe/inconclusive values. Callers MAY pass any of
// those additively when a surface genuinely has them.

/** Identity fields a caller may override; anything omitted is derived from the
 *  resolved bundle. */
export interface CapsuleIdentityOverrides {
  canonicalId?: string;
  signature?: string;
  externalRefs?: ExternalRef[];
  revision?: number;
}

/** Additive compiler inputs a surface MAY supply alongside the bundle. Every
 *  field is optional; the core compiler produces a deliverable capsule without
 *  any of them. */
export interface CompileCapsuleFromBundleOptions {
  identity?: CapsuleIdentityOverrides;
  knownFacts?: string[];
  occurrences?: CompileCapsuleV2Input["occurrences"];
  evidenceProfile?: CompileCapsuleV2Input["evidenceProfile"];
  joins?: CompileCapsuleV2Input["joins"];
  gaps?: CompileCapsuleV2Input["gaps"];
  redactions?: CompileCapsuleV2Input["redactions"];
  queryFailures?: CompileCapsuleV2Input["queryFailures"];
  memory?: CompileCapsuleV2Input["memory"];
  resolution?: CompileCapsuleV2Input["resolution"];
}

/**
 * Derive a stable capsule signature for a resolved issue from its bundle. Uses
 * the symptom's own error signature when present (an inferred one is never
 * fabricated), else a deterministic FNV-1a hash of the symptom's stable text so
 * recurrences of the same symptom group under one signature.
 */
export function deriveCapsuleSignature(bundle: RankedBundle): string {
  const sym = bundle.symptom;
  const explicit = sym.errorSig?.trim();
  if (explicit) return explicit;
  const basis = [sym.title, sym.url, sym.source, sym.release]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("|");
  return `sig_${hashString(basis)}`;
}

/**
 * Derive the canonical id for a resolved issue: the located Crumbtrail session
 * when a locate matched one (the most specific stable id node holds), else the
 * signature.
 */
export function deriveCapsuleCanonicalId(
  bundle: RankedBundle,
  signature: string,
): string {
  const sessionId = bundle.located?.sessionId;
  return sessionId && sessionId.length > 0 ? sessionId : signature;
}

/**
 * THE single `compileCapsuleV2` call site in crumbtrail-node. Wrap an
 * already-resolved fusion.v1 {@link RankedBundle} into a capsule.v2 envelope,
 * supplying only the inputs node has (the bundle as part 4, a derived
 * identity/signature, plus any additive extras a caller passes) and letting the
 * total core compiler produce a deliverable capsule for everything omitted.
 * Pure: the bundle is referenced verbatim and never mutated or re-ranked.
 */
export function compileCapsuleFromBundle(
  bundle: RankedBundle,
  options: CompileCapsuleFromBundleOptions = {},
): CapsuleV2 {
  const signature =
    options.identity?.signature?.trim() || deriveCapsuleSignature(bundle);
  const canonicalId =
    options.identity?.canonicalId?.trim() ||
    deriveCapsuleCanonicalId(bundle, signature);

  const input: CompileCapsuleV2Input = {
    identity: {
      canonicalId,
      signature,
      ...(options.identity?.externalRefs
        ? { externalRefs: options.identity.externalRefs }
        : {}),
      ...(options.identity?.revision !== undefined
        ? { revision: options.identity.revision }
        : {}),
    },
    bundle,
    ...(options.knownFacts ? { knownFacts: options.knownFacts } : {}),
    ...(options.occurrences ? { occurrences: options.occurrences } : {}),
    ...(options.evidenceProfile
      ? { evidenceProfile: options.evidenceProfile }
      : {}),
    ...(options.joins ? { joins: options.joins } : {}),
    ...(options.gaps ? { gaps: options.gaps } : {}),
    ...(options.redactions ? { redactions: options.redactions } : {}),
    ...(options.queryFailures ? { queryFailures: options.queryFailures } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
  };

  return compileCapsuleV2(input);
}

/** Options for {@link resolveIssueToCapsule}: the same locate + adapter options
 *  {@link locateAndAssemble} takes, plus an optional additive capsule slice. */
export type ResolveIssueToCapsuleOptions = LocateIncidentOptions &
  AdapterPhaseOptions & { capsule?: CompileCapsuleFromBundleOptions };

/** The result of resolving an issue to a capsule: the capsule plus the exact
 *  bundle it wraps, the locate decision, and per-source health — mirrors
 *  {@link locateAndAssemble} so callers keep the advisory locate/health signals. */
export interface ResolveIssueToCapsuleResult {
  capsule: CapsuleV2;
  bundle: RankedBundle;
  match: LocateMatch;
  sources: EvidenceSourceHealth[];
}

/**
 * Resolve a symptom to a capsule.v2 envelope through the ONE existing bundle
 * resolution path ({@link locateAndAssemble}, already shared with the inner
 * `/api/solve-context` endpoint) and then the single {@link compileCapsuleFromBundle}
 * compile site. Both the MCP `resolveCapsule` tool and the CLI `capsule` command
 * call this, so the two surfaces are at parity by construction. No parallel
 * resolution path, no re-ranking.
 */
export async function resolveIssueToCapsule(
  symptom: Symptom,
  store: RecallStore,
  opts: ResolveIssueToCapsuleOptions = {},
): Promise<ResolveIssueToCapsuleResult> {
  const { capsule: capsuleOptions, ...locateOptions } = opts;
  const { bundle, match, sources } = await locateAndAssemble(
    symptom,
    store,
    locateOptions,
  );
  const capsule = compileCapsuleFromBundle(bundle, capsuleOptions);
  return { capsule, bundle, match, sources };
}
