import type {
  EvidenceQuery,
  EvidenceSourceDescriptor,
  EvidenceSourceResult,
} from "crumbtrail-core";
import { CRUMBTRAIL_USER_AGENT } from "../ticket/clients";

/**
 * Evidence-source framework (runtime half). Mirrors the ticket-connector
 * pattern in `ticket/clients.ts`: env-var credentials for self-host, a provider
 * is present ⇔ its required vars are all set, and every outbound request carries
 * {@link CRUMBTRAIL_USER_AGENT}. Adapters (CP3+) register here; this file is the
 * contract + presence logic only.
 */

/**
 * Health of one configured source. Emitted by `EvidenceSource.health()` (a
 * cheap authenticated no-op) and surfaced by `crumbtrail-server doctor`.
 */
export interface SourceHealth {
  ok: boolean;
  provider: string;
  /** ms epoch when the check ran. */
  checkedAt: number;
  /** Sanitized failure reason when `ok` is false (never a raw secret). */
  error?: string;
}

/**
 * One provider's runtime surface. `fetchEvidence` returns neutral evidence.v1
 * items (no ranking); it never gates and — through the framework — degrades to
 * a gap rather than throwing. The optional `signal` lets the framework's
 * per-source timeout abort an in-flight outbound fetch; adapters should thread
 * it into their `fetch` calls when present.
 */
export interface EvidenceSource {
  readonly descriptor: EvidenceSourceDescriptor;
  health(signal?: AbortSignal): Promise<SourceHealth>;
  fetchEvidence(
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<EvidenceSourceResult>;
}

/**
 * A registered provider: how to detect its env credentials and construct a
 * source from them. Adapters append an entry to {@link EVIDENCE_SOURCE_PROVIDERS}.
 */
export interface EvidenceSourceProvider {
  provider: string;
  /**
   * Required env-var names. The provider is considered configured iff every one
   * is set to a non-empty string — mirroring `ticketClientFromEnv`'s
   * present ⇔ required-vars-set rule.
   */
  authFields: string[];
  fromEnv(env: Record<string, string | undefined>): EvidenceSource;
}

/**
 * Provider registry. Adapters (Sentry in CP3, then CloudWatch/Splunk/…) append
 * their {@link EvidenceSourceProvider} here via {@link registerEvidenceProvider}.
 * `evidenceSourcesFromEnv` walks it to build the configured sources.
 */
export const EVIDENCE_SOURCE_PROVIDERS: EvidenceSourceProvider[] = [];

/**
 * Register a provider once (idempotent by `provider` id). Adapter modules call
 * this at import time; `../evidence-sources/index.ts` imports every adapter so a
 * single import of the barrel populates the registry. Idempotency keeps repeated
 * imports (test isolation, HMR) from double-registering.
 */
export function registerEvidenceProvider(
  provider: EvidenceSourceProvider,
): void {
  if (EVIDENCE_SOURCE_PROVIDERS.some((p) => p.provider === provider.provider)) {
    return;
  }
  EVIDENCE_SOURCE_PROVIDERS.push(provider);
}

function isPresent(
  env: Record<string, string | undefined>,
  authFields: string[],
): boolean {
  return authFields.every((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Build the configured evidence sources from env. A provider is included iff all
 * its `authFields` are set. Never throws for a partially-configured provider —
 * it is simply omitted (adapter absence degrades to a gap downstream, never an
 * error). `providers` is injectable for tests.
 */
export function evidenceSourcesFromEnv(
  env: Record<string, string | undefined> = process.env,
  providers: EvidenceSourceProvider[] = EVIDENCE_SOURCE_PROVIDERS,
): EvidenceSource[] {
  const sources: EvidenceSource[] = [];
  for (const provider of providers) {
    if (isPresent(env, provider.authFields))
      sources.push(provider.fromEnv(env));
  }
  return sources;
}

/**
 * Base headers every adapter's outbound request must include. Exposes the
 * shared source-identifying User-Agent so adapters do not re-declare it.
 */
export function evidenceRequestHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { "User-Agent": CRUMBTRAIL_USER_AGENT, ...extra };
}

export { CRUMBTRAIL_USER_AGENT };
