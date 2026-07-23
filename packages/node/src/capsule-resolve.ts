import {
  compileCapsuleV2,
  hashString,
  type CapsuleV2,
  type CompileCapsuleV2Input,
  type ExternalRef,
  type RankedBundle,
} from "crumbtrail-core";
import {
  isFusionBundleRecord,
  resolveTicketToBundle,
  type ResolvedTicketRef,
  type TicketResolutionDeps,
} from "./ticket-resolve";

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

// --- issue resolution (CRUMB-60) --------------------------------------------
//
// ONE resolution entry point for both capsule surfaces, taking the SAME input
// `solveContext` takes: a ticket reference, a described symptom, or both. It
// calls the SAME shared producer `solveContext` calls
// ({@link resolveTicketToBundle}: cloud pull short-circuit, ticket fetch and
// normalization, explicit baseline/current comparison, auto-locate and the
// adapter phase, git-host intent inference), then the single compile site above.
// No second pipeline, no re-ranking: the capsule is additive framing over
// exactly the bundle `solveContext` would have returned for the same input.

/** The result of resolving a ticket to a capsule. `error` carries a refusal the
 *  surface should report (for example an unusable stored bundle), never a
 *  half-built capsule. */
export type ResolveTicketToCapsuleResult =
  | { kind: "error"; message: string }
  | {
      kind: "capsule";
      capsule: CapsuleV2;
      bundle: RankedBundle;
      /** Where the bundle came from: a configured cloud deployment's stored
       *  bundle for this ticket, or local resolution. */
      source: "cloud" | "local";
      ticket?: ResolvedTicketRef;
    };

/** Link the resolved issue back to its ticket, unless the caller already
 *  supplied its own external refs. */
function withTicketRef(
  options: CompileCapsuleFromBundleOptions,
  ticket: ResolvedTicketRef | undefined,
): CompileCapsuleFromBundleOptions {
  if (!ticket || options.identity?.externalRefs) return options;
  return {
    ...options,
    identity: {
      ...options.identity,
      externalRefs: [
        {
          system: ticket.provider,
          id: ticket.id,
          ...(ticket.url ? { url: ticket.url } : {}),
        },
      ],
    },
  };
}

/**
 * Resolve a TICKET reference (the same `ticket`/`symptom`/`baselineSession`/
 * `currentSession`/`gitHost` input `solveContext` accepts) to a capsule.v2
 * envelope. Both the MCP `resolveCapsule` tool and the CLI `capsule` command
 * call this, so the surfaces are at parity by construction: identical input
 * yields an identical capsule, including its identity and signature.
 */
export async function resolveTicketToCapsule(
  args: Record<string, unknown>,
  deps: TicketResolutionDeps,
  capsuleOptions: CompileCapsuleFromBundleOptions = {},
): Promise<ResolveTicketToCapsuleResult> {
  const resolved = await resolveTicketToBundle(args, deps);
  if (resolved.kind === "error") {
    return { kind: "error", message: resolved.message };
  }

  if (resolved.kind === "pulled") {
    // A stored bundle is reused verbatim, exactly as solveContext returns it.
    // It is only usable as capsule part 4 when it really is a fusion.v1 bundle;
    // anything else is reported honestly rather than coerced into a capsule.
    if (!isFusionBundleRecord(resolved.bundle)) {
      return {
        kind: "error",
        message:
          "the bundle stored for this ticket is not a fusion.v1 RankedBundle, so it cannot be wrapped in a capsule; use solveContext to inspect the stored payload.",
      };
    }
    const bundle = resolved.bundle as RankedBundle;
    return {
      kind: "capsule",
      capsule: compileCapsuleFromBundle(
        bundle,
        withTicketRef(capsuleOptions, resolved.ticket),
      ),
      bundle,
      source: "cloud",
      ...(resolved.ticket ? { ticket: resolved.ticket } : {}),
    };
  }

  return {
    kind: "capsule",
    capsule: compileCapsuleFromBundle(
      resolved.bundle,
      withTicketRef(capsuleOptions, resolved.ticket),
    ),
    bundle: resolved.bundle,
    source: "local",
    ...(resolved.ticket ? { ticket: resolved.ticket } : {}),
  };
}
