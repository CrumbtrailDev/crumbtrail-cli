import type {
  EvidenceGap,
  EvidenceItem,
  EvidenceQuery,
  EvidenceSourceDescriptor,
  EvidenceSourceResult,
} from "crumbtrail-core";
import { EVIDENCE_SOURCE_SCHEMA_VERSION } from "crumbtrail-core";
import type { EvidenceSource, SourceHealth } from "./registry";

/**
 * Configurable in-memory {@link EvidenceSource} for tests. It makes NO network
 * calls. It can resolve with fixed items/gaps, throw, hang until aborted (to
 * prove the framework's per-source timeout), or record concurrency (to prove
 * the fan-out is parallel).
 */
export interface FakeEvidenceSourceOptions {
  provider?: string;
  displayName?: string;
  descriptor?: Partial<EvidenceSourceDescriptor>;
  /** Items returned by fetchEvidence (defaults to none). */
  items?: EvidenceItem[];
  /** Gaps the source itself declares (e.g. unsupported join key). */
  gaps?: EvidenceGap[];
  /** stats.fetched to report (defaults to items.length). */
  fetched?: number;
  /** stats.truncated to report (source-internal maxItems truncation). */
  truncated?: boolean;
  /** Health result (defaults to ok). A function is invoked per call. */
  health?: SourceHealth | (() => Promise<SourceHealth> | SourceHealth);
  /** Resolve after this many ms (real timer). */
  delayMs?: number;
  /** Never resolve on its own — only settle when the abort signal fires. */
  neverResolves?: boolean;
  /** Reject fetchEvidence with this error. */
  error?: Error;
  /** Called at the start of fetchEvidence (concurrency tracking, etc.). */
  onFetchStart?: () => void;
  /** Called when fetchEvidence settles. */
  onFetchEnd?: () => void;
}

const DEFAULT_DESCRIPTOR: Omit<EvidenceSourceDescriptor, "provider"> = {
  displayName: "Fake",
  lanes: ["logs"],
  joinKeys: ["time"],
  authFields: [],
};

export class FakeEvidenceSource implements EvidenceSource {
  readonly descriptor: EvidenceSourceDescriptor;
  /** How many times fetchEvidence was entered — parallelism assertions read this. */
  fetchCalls = 0;
  /** The last query fetchEvidence received (for query-construction assertions). */
  lastQuery?: EvidenceQuery;

  constructor(private readonly options: FakeEvidenceSourceOptions = {}) {
    const provider = options.provider ?? "fake";
    this.descriptor = {
      ...DEFAULT_DESCRIPTOR,
      ...options.descriptor,
      provider,
      displayName:
        options.displayName ?? options.descriptor?.displayName ?? provider,
    };
  }

  async health(): Promise<SourceHealth> {
    const value = this.options.health;
    if (typeof value === "function") return value();
    return (
      value ?? {
        ok: true,
        provider: this.descriptor.provider,
        checkedAt: 0,
      }
    );
  }

  async fetchEvidence(
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<EvidenceSourceResult> {
    this.fetchCalls += 1;
    this.lastQuery = query;
    this.options.onFetchStart?.();
    try {
      if (this.options.neverResolves) {
        await new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (this.options.delayMs && this.options.delayMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.options.delayMs),
        );
      }
      if (this.options.error) throw this.options.error;

      const items = this.options.items ?? [];
      return {
        schemaVersion: EVIDENCE_SOURCE_SCHEMA_VERSION,
        items,
        gaps: this.options.gaps ?? [],
        stats: {
          provider: this.descriptor.provider,
          fetched: this.options.fetched ?? items.length,
          returned: items.length,
          truncated: this.options.truncated ?? false,
          latencyMs: 0,
        },
      };
    } finally {
      this.options.onFetchEnd?.();
    }
  }
}
