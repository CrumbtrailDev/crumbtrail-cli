/**
 * Provider-agnostic evidence-source contract (types only — browser-safe, no I/O).
 *
 * This is the query-at-incident-time pull surface: when a ticket arrives, the
 * runtime asks a client's existing observability tools (Sentry, CloudWatch,
 * Splunk, Datadog, PostHog, Cloudflare) for evidence inside the located incident
 * window and normalizes each hit into the neutral `evidence.v1` contract
 * ({@link EvidenceItem} / {@link EvidenceGap}). Evidence stays neutral and
 * complete here — ranking/opinion happens exactly once downstream in
 * `assembleBundle` (fusion.v1), never in adapter output.
 *
 * Deliberately distinct from the OTLP dual-export path: adapters are zero-copy
 * and derived-artifacts-only; only the assembled bundle persists.
 */
import type { EvidenceItem, EvidenceLane } from "./evidence";
import type { EvidenceGap, Symptom } from "./fusion";

/**
 * Schema version string const, matching the repo convention
 * (`evidence.v1` / `fusion.v1` / `fix-context.v1`).
 */
export const EVIDENCE_SOURCE_SCHEMA_VERSION = "evidence-source.v1" as const;

/**
 * Correlation keys an adapter can filter by. The Varicent lesson: most clients
 * do not propagate a trace end-to-end, so an adapter must declare (in its
 * descriptor) which keys it can actually use and honestly report — via an
 * {@link EvidenceGap} — when a requested key is unavailable and it fell back to
 * a time window only. Note `traceId` doubles as `requestId` in the repo's
 * correlation model.
 */
export type EvidenceJoinKey =
  | "traceId"
  | "requestId"
  | "sessionId"
  | "time"
  | "release"
  | "url"
  | "user"
  | "service";

export interface EvidenceSourceDescriptor {
  /** Stable provider id, e.g. "sentry" | "cloudwatch" | "splunk". */
  provider: string;
  /** Human-facing name for doctor output and docs. */
  displayName: string;
  /** Which evidence.v1 lanes this source can populate. */
  lanes: EvidenceLane[];
  /** Keys it can actually filter by, best-first (drives query construction). */
  joinKeys: EvidenceJoinKey[];
  /** Env-var names carrying this source's credentials, for doctor + docs. */
  authFields: string[];
}

export interface EvidenceQuery {
  /** ms-epoch incident window, already located upstream. */
  window: { start: number; end: number };
  /** Correlation keys known for this incident; adapters use what they support. */
  keys: Partial<Record<EvidenceJoinKey, string>>;
  /** fusion.v1 Symptom, for text-relevance hints (optional). */
  symptom?: Symptom;
  /** Egress + token discipline: hard bounds every adapter must honor. */
  limits: { maxItems: number; maxBytes: number; timeoutMs: number };
}

export interface EvidenceSourceResult {
  schemaVersion: typeof EVIDENCE_SOURCE_SCHEMA_VERSION;
  /** Neutral evidence.v1 items — no ranking, no opinion. */
  items: EvidenceItem[];
  /** e.g. "splunk cannot filter by traceId; used time window only". */
  gaps: EvidenceGap[];
  stats: {
    provider: string;
    fetched: number;
    returned: number;
    truncated: boolean;
    latencyMs: number;
  };
}
