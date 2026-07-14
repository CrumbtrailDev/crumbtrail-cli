import type {
  EvidenceGap,
  EvidenceItem,
  EvidenceLane,
  EvidenceQuery,
} from "crumbtrail-core";
import type { EvidenceSource } from "./registry";
import { redactEvidenceGap, redactSourceResult, redactText } from "./redact";

/**
 * Parallel adapter fan-out. Queries every configured {@link EvidenceSource} at
 * once, bounds each by a per-source timeout, redacts every result at the
 * boundary, and enforces a global byte cap across all sources. It NEVER throws:
 * a failed or slow source becomes an {@link EvidenceGap} ("sentry: timeout after
 * 10s"), because evidence is advisory and "inconclusive" is a valid outcome.
 */

/** Per-source timeout when neither the query nor options specify one. */
export const DEFAULT_SOURCE_TIMEOUT_MS = 10_000;
/** Global cap on normalized (redacted) evidence bytes across all sources. */
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024;

export interface AdapterSourceStats {
  provider: string;
  /**
   * Health signal for this source. INVARIANT: `ok` is false iff the source
   * could not deliver its PRIMARY evidence — a total failure/timeout that
   * returned zero items — regardless of whether the adapter threw or
   * self-degraded internally. A source that returned any items (even partial,
   * with an enrichment/secondary gap) stays `ok: true`. The framework is the
   * single source of truth: it derives `ok` from the throw path OR a
   * `kind: "source-unavailable"` gap on a zero-item result (see below), never
   * from gap `reason` text.
   */
  ok: boolean;
  /** Items the source reported fetching (0 on failure). */
  fetched: number;
  /** Items actually included after the global byte cap. */
  returned: number;
  /** True if the source's own maxItems OR the global byte cap dropped items. */
  truncated: boolean;
  /** Framework-measured wall time for this source's fetch. */
  latencyMs: number;
  /** Bytes of this source's included normalized items. */
  bytes: number;
  /** Sanitized failure/timeout reason when `ok` is false. */
  error?: string;
}

export interface AdapterEvidence {
  items: EvidenceItem[];
  gaps: EvidenceGap[];
  stats: AdapterSourceStats[];
}

export interface FetchAdapterEvidenceOptions {
  /** Per-source timeout override (else query.limits.timeoutMs, else default). */
  timeoutMs?: number;
  /** Global byte cap across sources. Default 512 KB. */
  maxTotalBytes?: number;
  /** Clock hook (tests). Default Date.now. */
  now?: () => number;
}

interface SourceOutcome {
  provider: string;
  latencyMs: number;
  /** Present on success (already redacted). */
  result?: import("crumbtrail-core").EvidenceSourceResult;
  /** Present on failure/timeout — a source-level gap to surface. */
  gap?: EvidenceGap;
  error?: string;
}

function sourceGapLane(source: EvidenceSource): EvidenceLane {
  return source.descriptor.lanes[0] ?? "logs";
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/** "10s" for whole-second budgets (the common case), "250ms" otherwise. */
function formatTimeout(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/**
 * Run one source under a timeout. Resolves to a {@link SourceOutcome} — never
 * rejects. On timeout the AbortController fires so a well-behaved adapter can
 * cancel its in-flight fetch; either way the race resolves to a gap.
 */
async function fetchOne(
  source: EvidenceSource,
  query: EvidenceQuery,
  timeoutMs: number,
  now: () => number,
): Promise<SourceOutcome> {
  const provider = source.descriptor.provider;
  const controller = new AbortController();
  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  try {
    const outcome = await Promise.race([
      source.fetchEvidence(query, controller.signal).then(
        (result) => ({ result }) as const,
        (error) => ({ error }) as const,
      ),
      timeout,
    ]);
    const latencyMs = Math.max(0, now() - start);

    if ("timedOut" in outcome) {
      // Framework-generated wording; no adapter payload, but route it through
      // the same redaction boundary as the success path for uniformity. The
      // "<provider>: timeout after 10s" wording has no token-like runs, so it
      // passes through unchanged.
      return {
        provider,
        latencyMs,
        error: "timeout",
        gap: redactEvidenceGap({
          lane: sourceGapLane(source),
          reason: `${provider}: timeout after ${formatTimeout(timeoutMs)}`,
          suggestion:
            "the source did not respond within its budget; the bundle was assembled without it",
        }),
      };
    }
    if ("error" in outcome) {
      // A thrown adapter error message is untrusted (may embed a
      // credential/URL-with-token), so scrub both the surfaced gap.reason and
      // stats.error at the boundary before they are retained in the bundle.
      const message = sanitizeError(outcome.error);
      return {
        provider,
        latencyMs,
        error: redactText(message, "stats.error"),
        gap: redactEvidenceGap({
          lane: sourceGapLane(source),
          reason: `${provider}: fetch failed — ${message}`,
        }),
      };
    }
    return {
      provider,
      latencyMs,
      result: redactSourceResult(outcome.result),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fan out `query` to every source in parallel, degrade failures to gaps, redact
 * at the boundary, and cap total normalized bytes. Deterministic: outcomes are
 * folded in source order, so the byte cap trims from a stable point.
 */
export async function fetchAdapterEvidence(
  sources: EvidenceSource[],
  query: EvidenceQuery,
  options: FetchAdapterEvidenceOptions = {},
): Promise<AdapterEvidence> {
  const now = options.now ?? Date.now;
  const timeoutMs =
    options.timeoutMs ?? query.limits.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const outcomes = await Promise.allSettled(
    sources.map((source) => fetchOne(source, query, timeoutMs, now)),
  );

  const items: EvidenceItem[] = [];
  const gaps: EvidenceGap[] = [];
  const stats: AdapterSourceStats[] = [];

  let runningBytes = 0;
  let capReached = false;
  let droppedCount = 0;

  outcomes.forEach((settled, index) => {
    const source = sources[index];
    const provider = source.descriptor.provider;

    // fetchOne never rejects, but guard defensively so one bug cannot throw.
    if (settled.status === "rejected") {
      // Same untrusted-error scrubbing as the fetchOne error branch: redact
      // before the reason/error are retained in the bundle.
      const message = sanitizeError(settled.reason);
      gaps.push(
        redactEvidenceGap({
          lane: sourceGapLane(source),
          reason: `${provider}: fetch failed — ${message}`,
        }),
      );
      stats.push({
        provider,
        ok: false,
        fetched: 0,
        returned: 0,
        truncated: false,
        latencyMs: 0,
        bytes: 0,
        error: redactText(message, "stats.error"),
      });
      return;
    }

    const outcome = settled.value;
    if (!outcome.result) {
      if (outcome.gap) gaps.push(outcome.gap);
      stats.push({
        provider,
        ok: false,
        fetched: 0,
        returned: 0,
        truncated: false,
        latencyMs: outcome.latencyMs,
        bytes: 0,
        error: outcome.error,
      });
      return;
    }

    const result = outcome.result;
    let returned = 0;
    let bytes = 0;
    let truncated = result.stats.truncated;

    for (const item of result.items) {
      if (capReached) {
        droppedCount += 1;
        truncated = true;
        continue;
      }
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (runningBytes + size > maxTotalBytes) {
        capReached = true;
        truncated = true;
        droppedCount += 1;
        continue;
      }
      items.push(item);
      runningBytes += size;
      bytes += size;
      returned += 1;
    }

    // Harmonize `stats.ok` with the throw path: a self-degrading adapter
    // (CloudWatch/Splunk) that hard-fails catches the error, returns zero items,
    // and flags a `kind: "source-unavailable"` gap. When nothing survived
    // (`returned === 0`) and such a marker is present, the source delivered no
    // primary evidence → ok:false, exactly as if it had thrown. Any surviving
    // item (partial success) keeps ok:true even with the marker present, so the
    // resilience/primary-survives-timeout behavior is preserved.
    const failureGap =
      returned === 0
        ? result.gaps.find((gap) => gap.kind === "source-unavailable")
        : undefined;

    gaps.push(...result.gaps);
    stats.push({
      provider,
      ok: failureGap === undefined,
      fetched: result.stats.fetched,
      returned,
      truncated,
      latencyMs: outcome.latencyMs,
      bytes,
      // Surface the sanitized failure reason (already redacted upstream) so the
      // doctor/dashboard health surface has a cause string, matching throw path.
      ...(failureGap ? { error: failureGap.reason } : {}),
    });
  });

  if (capReached) {
    gaps.push({
      lane: "logs",
      reason: `evidence byte cap reached (${formatKb(maxTotalBytes)}); ${droppedCount} item(s) dropped`,
      suggestion:
        "narrow the incident window or add correlation keys to reduce evidence volume",
    });
  }

  return { items, gaps, stats };
}
