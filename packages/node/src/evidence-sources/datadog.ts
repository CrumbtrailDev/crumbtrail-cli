import {
  EVIDENCE_SOURCE_SCHEMA_VERSION,
  type EvidenceGap,
  type EvidenceItem,
  type EvidenceJoinKey,
  type EvidenceQuery,
  type EvidenceSourceDescriptor,
  type EvidenceSourceResult,
} from "crumbtrail-core";
import { withBoundedRetry } from "../ticket/clients";
import {
  evidenceRequestHeaders,
  type EvidenceSource,
  type EvidenceSourceProvider,
  type SourceHealth,
} from "./registry";

/**
 * Datadog evidence adapter — built to the Sentry reference shape (`sentry.ts`).
 * Query-at-incident-time pull: given a located incident window and the
 * correlation keys known for it, ask Datadog's Logs Search v2 API (primary) and
 * Spans Search v2 API (secondary) for matching records in that window, and
 * normalize each into the neutral `evidence.v1` contract. Zero-copy — nothing
 * Datadog returns is persisted; only the derived bundle is.
 *
 * Load-bearing patterns mirrored from the Sentry reference:
 * - **Injectable transport**: constructor takes `fetchImpl?: typeof fetch`
 *   defaulting to global `fetch`; contract tests inject a fixture-routing stub so
 *   there is zero network in CI.
 * - **Resilience / self-limiting secondary budget**: logs are the PRIMARY
 *   evidence (fetched with the bounded retry). Spans are a SECONDARY fetch, run
 *   best-effort inside a sub-budget carved from `limits.timeoutMs`
 *   (`SPAN_BUDGET_FRACTION`) and bounded by the caller's abort signal. If the span
 *   search is slow, fails, or is aborted, the log items still ship + an honest gap
 *   — one API's slowness NEVER drops the other API's items, and the adapter always
 *   resolves before the framework's per-source timeout fires.
 * - **Descriptor-keyed query construction**: the query string is built strictly
 *   from `descriptor.joinKeys` ∩ present keys; a requested key Datadog cannot use
 *   becomes an honest {@link EvidenceGap}. Every declared join key is genuinely
 *   applied (traceId → `@trace_id`, service → `service:`, url → `@http.url`, time
 *   → filter from/to) — no silent no-op.
 * - **Boundaries**: honors `limits.maxItems`/`maxBytes`/`timeoutMs`; the page
 *   limit caps results server-side so there is no pagination walk beyond
 *   `maxItems`; every request carries `CRUMBTRAIL_USER_AGENT`; the API/app keys live
 *   only in the request headers, never in a gap, stat, thrown message, or log.
 * - **Redaction stays at the framework boundary** (`redact.ts`); this file only
 *   populates the fields that boundary scrubs (`brief`, `after`, `ref.url`).
 */

/** Env var carrying the Datadog API key. Required. */
export const DATADOG_API_KEY_ENV = "CRUMBTRAIL_DATADOG_API_KEY";
/** Env var carrying the Datadog application key. Required. */
export const DATADOG_APP_KEY_ENV = "CRUMBTRAIL_DATADOG_APP_KEY";
/** Env var carrying the Datadog site (datadoghq.com | datadoghq.eu | us3… ). Optional. */
export const DATADOG_SITE_ENV = "CRUMBTRAIL_DATADOG_SITE";
/** Default site when {@link DATADOG_SITE_ENV} is unset. */
export const DATADOG_DEFAULT_SITE = "datadoghq.com";

/** Presence of these two ⇒ the provider is configured (mirrors ticket clients).
 *  Site has a default so it is not required. */
export const DATADOG_AUTH_FIELDS = [DATADOG_API_KEY_ENV, DATADOG_APP_KEY_ENV];

export const DATADOG_DESCRIPTOR: EvidenceSourceDescriptor = {
  provider: "datadog",
  displayName: "Datadog",
  lanes: ["logs", "network"],
  // best-first: a trace id is the tightest filter Datadog offers; time is the
  // always-available floor; service and url narrow a time-only fallback.
  joinKeys: ["traceId", "time", "service", "url"],
  authFields: DATADOG_AUTH_FIELDS,
};

export interface DatadogSourceConfig {
  apiKey: string;
  appKey: string;
  /** Datadog site, e.g. "datadoghq.com". Defaults to {@link DATADOG_DEFAULT_SITE}. */
  site?: string;
  /** Injectable transport. Defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch;
}

/** Thrown internally for a non-2xx Datadog response. Only the API path + status
 *  reach the message — never the API/app keys. Retryability keys off `status`. */
class DatadogError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DatadogError";
  }
}

function sanitizeUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.origin}${p.pathname}`;
  } catch {
    return u.split("?")[0];
  }
}

/** Transient (worth a bounded retry): network error, or 429/5xx from Datadog. A
 *  hard 4xx (bad keys/query) won't improve on retry; an abort must stop now. */
function isTransient(error: unknown): boolean {
  if (error instanceof DatadogError)
    return error.status === 429 || error.status >= 500;
  if (error instanceof Error && error.name === "AbortError") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Query construction (descriptor-keyed) — mirrors buildSentryQuery.
// ---------------------------------------------------------------------------

export interface DatadogQueryPlan {
  /** The Datadog search query string (may be empty ⇒ time-window only). */
  queryString: string;
  /** Join keys actually used to narrow beyond the time window, best-first. */
  usedKeys: EvidenceJoinKey[];
  /** Honest gaps: a requested key Datadog cannot filter by. */
  gaps: EvidenceGap[];
}

/** Quote + escape a value for a Datadog query facet term when it carries
 *  whitespace or special syntax, so it cannot break out of the token. */
function ddQuote(value: string): string {
  if (/[\s:"\\()]/.test(value)) {
    return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  }
  return value;
}

/**
 * Build the Datadog query from `descriptor.joinKeys` ∩ present keys. The same
 * query string filters both the logs and spans search bodies.
 * Precedence: a `@trace_id:<id>` term when a trace is present (tightest), plus
 * additive `service:<svc>` and `@http.url:<url>` terms for whichever of those
 * keys is present. Any requested key Datadog does NOT support (requestId,
 * sessionId, release, user) yields a gap so the bundle states plainly what
 * filtered the result.
 */
export function buildDatadogQuery(query: EvidenceQuery): DatadogQueryPlan {
  const { keys } = query;
  const gaps: EvidenceGap[] = [];

  for (const requested of Object.keys(keys) as EvidenceJoinKey[]) {
    if (requested === "time") continue;
    if (keys[requested] == null || keys[requested] === "") continue;
    if (!DATADOG_DESCRIPTOR.joinKeys.includes(requested)) {
      gaps.push({
        lane: "logs",
        reason: `datadog: cannot filter by ${requested}; used time window only`,
        suggestion:
          "stamp a trace id (W3C traceparent) on this flow to correlate Datadog precisely",
      });
    }
  }

  const terms: string[] = [];
  const usedKeys: EvidenceJoinKey[] = [];

  if (keys.traceId) {
    terms.push(`@trace_id:${ddQuote(keys.traceId)}`);
    usedKeys.push("traceId");
  }
  if (keys.service) {
    terms.push(`service:${ddQuote(keys.service)}`);
    usedKeys.push("service");
  }
  if (keys.url) {
    terms.push(`@http.url:${ddQuote(keys.url)}`);
    usedKeys.push("url");
  }

  if (usedKeys.length === 0) {
    gaps.push({
      lane: "logs",
      reason:
        "datadog: no supported correlation key present; used time window only",
      suggestion:
        "propagate a trace id, service, or url to tighten Datadog matching",
    });
  }

  return { queryString: terms.join(" "), usedKeys, gaps };
}

// ---------------------------------------------------------------------------
// Normalization — mirrors normalizeSentryIssue.
// ---------------------------------------------------------------------------

const BRIEF_MAX = 140;

/** Minimal shape of a Datadog Logs Search v2 result row. */
export interface DatadogLog {
  id?: string;
  attributes?: {
    timestamp?: string | number;
    message?: string;
    service?: string;
    status?: string;
  };
}

/** Minimal shape of a Datadog Spans Search v2 result row. */
export interface DatadogSpan {
  id?: string;
  attributes?: {
    start_timestamp?: string | number;
    resource_name?: string;
    operation_name?: string;
    service?: string;
    duration?: number;
    trace_id?: string;
    span_id?: string;
  };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function toMs(value: string | number | undefined): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") {
    // Datadog spans report timestamps in nanoseconds; logs in ISO strings.
    return value > 1e15 ? Math.floor(value / 1e6) : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Derive the Datadog app UI base for deep links from the API site.
 * `datadoghq.com`/`.eu` use an `app.` subdomain; regional sites (us3/us5/ap1)
 * already carry their subdomain, so the site is the app host.
 */
export function datadogAppBase(site: string): string {
  if (site === "datadoghq.com" || site === "datadoghq.eu") {
    return `https://app.${site}`;
  }
  return `https://${site}`;
}

/** One Datadog log → neutral evidence.v1 item (lane "logs"). Pure. */
export function normalizeDatadogLog(
  log: DatadogLog,
  appBase: string,
  queryString: string,
  window: { start: number; end: number },
): EvidenceItem {
  const message = log.attributes?.message ?? "";
  const id = log.id ?? "";
  const q = encodeURIComponent(queryString);
  // Log Explorer deep link focused on this event id within the window.
  const url =
    `${appBase}/logs?query=${q}&event=${encodeURIComponent(id)}` +
    `&from_ts=${window.start}&to_ts=${window.end}`;

  const item: EvidenceItem = {
    id: `datadog:log:${id}`,
    lane: "logs",
    kind: "datadog.log",
    brief: truncate(message, BRIEF_MAX),
    ref: { provider: "datadog", id, url },
    before: null,
    after: message.trim().length > 0 ? message.trim() : null,
  };
  const ms = toMs(log.attributes?.timestamp);
  if (ms != null) item.whenObserved = ms;
  return item;
}

/** One Datadog span → neutral evidence.v1 item (lane "network"). Pure. */
export function normalizeDatadogSpan(
  span: DatadogSpan,
  appBase: string,
): EvidenceItem {
  const a = span.attributes ?? {};
  const id = span.id ?? "";
  const resource = a.resource_name ?? a.operation_name ?? "span";
  const duration =
    typeof a.duration === "number"
      ? `${Math.round(a.duration / 1e6)}ms` // duration is nanoseconds
      : undefined;
  const brief = truncate(
    duration ? `${resource} (${duration})` : resource,
    BRIEF_MAX,
  );
  // Trace deep link lands on the actual trace/span in APM where feasible.
  const url = a.trace_id
    ? `${appBase}/apm/trace/${encodeURIComponent(a.trace_id)}` +
      (a.span_id ? `?spanID=${encodeURIComponent(a.span_id)}` : "")
    : `${appBase}/apm/traces`;

  const item: EvidenceItem = {
    id: `datadog:span:${id}`,
    lane: "network",
    kind: "datadog.span",
    brief,
    ref: { provider: "datadog", id, url },
    before: null,
    after: a.service ? `service=${a.service}` : null,
  };
  const ms = toMs(a.start_timestamp);
  if (ms != null) item.whenObserved = ms;
  return item;
}

// ---------------------------------------------------------------------------
// Secondary (spans) budget — mirrors ENRICH_BUDGET_FRACTION in sentry.ts.
// ---------------------------------------------------------------------------

/** Fraction of the per-source timeout the adapter will spend on the SECONDARY
 *  span search before giving up and shipping the primary log items. The remainder
 *  is headroom so the adapter ALWAYS resolves (with items) BEFORE the framework's
 *  per-source timeout fires and discards the whole result. */
const SPAN_BUDGET_FRACTION = 0.5;

interface SearchResponse<T> {
  data?: T[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DatadogEvidenceSource implements EvidenceSource {
  readonly descriptor = DATADOG_DESCRIPTOR;
  private readonly apiKey: string;
  private readonly appKey: string;
  private readonly site: string;
  private readonly apiBase: string;
  private readonly appBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DatadogSourceConfig) {
    this.apiKey = config.apiKey;
    this.appKey = config.appKey;
    this.site = config.site || DATADOG_DEFAULT_SITE;
    this.apiBase = `https://api.${this.site}`;
    this.appBase = datadogAppBase(this.site);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    // The API + app keys live ONLY in these headers — never in a thrown message,
    // gap, or stat.
    return evidenceRequestHeaders({
      "Content-Type": "application/json",
      "DD-API-KEY": this.apiKey,
      "DD-APPLICATION-KEY": this.appKey,
    });
  }

  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new DatadogError(
        res.status,
        `Datadog fetch failed with HTTP ${res.status}: ${sanitizeUrl(url)}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Cheap authenticated no-op: validate the API key. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    const checkedAt = Date.now();
    try {
      const url = `${this.apiBase}/api/v1/validate`;
      const res = await this.fetchImpl(url, {
        headers: this.headers(),
        signal,
      });
      if (!res.ok) {
        throw new DatadogError(
          res.status,
          `Datadog validate failed with HTTP ${res.status}`,
        );
      }
      return { ok: true, provider: this.descriptor.provider, checkedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        provider: this.descriptor.provider,
        checkedAt,
        error: message,
      };
    }
  }

  /** PRIMARY: Logs Search v2. Bounded retry — this is the evidence we must ship. */
  private async searchLogs(
    plan: DatadogQueryPlan,
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<DatadogLog[]> {
    const res = await withBoundedRetry(
      () =>
        this.post<SearchResponse<DatadogLog>>(
          "/api/v2/logs/events/search",
          {
            filter: {
              query: plan.queryString,
              from: String(query.window.start),
              to: String(query.window.end),
            },
            sort: "-timestamp",
            page: { limit: Math.max(1, query.limits.maxItems) },
          },
          signal,
        ),
      { isRetryable: isTransient },
    );
    return Array.isArray(res.data) ? res.data : [];
  }

  /** SECONDARY: Spans Search v2. Single attempt on purpose — it runs inside a
   *  sub-budget, so retrying would risk blowing the per-source timeout. */
  private async searchSpans(
    plan: DatadogQueryPlan,
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<DatadogSpan[]> {
    const res = await this.post<SearchResponse<DatadogSpan>>(
      "/api/v2/spans/events/search",
      {
        data: {
          type: "search_request",
          attributes: {
            filter: {
              query: plan.queryString,
              from: String(query.window.start),
              to: String(query.window.end),
            },
            sort: "-timestamp",
            page: { limit: Math.max(1, query.limits.maxItems) },
          },
        },
      },
      signal,
    );
    return Array.isArray(res.data) ? res.data : [];
  }

  /**
   * Best-effort span search inside a sub-budget carved from `limits.timeoutMs`
   * and bounded by the caller's abort signal. A slow/failed/aborted span search
   * leaves `spans` empty (→ the log items still ship) and flips `incomplete`.
   * Mirrors Sentry's `enrichStackHeads`.
   */
  private async fetchSpansBestEffort(
    plan: DatadogQueryPlan,
    query: EvidenceQuery,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<{ spans: DatadogSpan[]; incomplete: boolean }> {
    if (signal?.aborted) return { spans: [], incomplete: true };
    const timeoutMs = query.limits.timeoutMs;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs != null && Number.isFinite(timeoutMs)) {
      const remaining = Math.max(
        0,
        timeoutMs * SPAN_BUDGET_FRACTION - (Date.now() - startedAt),
      );
      budgetTimer = setTimeout(onAbort, remaining);
    }

    try {
      const spans = await this.searchSpans(plan, query, controller.signal);
      return { spans, incomplete: controller.signal.aborted };
    } catch {
      // Any failure (non-2xx, network, or abort) degrades to "no spans".
      return { spans: [], incomplete: true };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  }

  async fetchEvidence(
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<EvidenceSourceResult> {
    const started = Date.now();
    const { limits } = query;
    const plan = buildDatadogQuery(query);

    // Step 1 — PRIMARY: logs. If this itself fails, re-throw so the framework
    // turns it into a gap (message already sanitized, no keys).
    let logs: DatadogLog[];
    try {
      logs = await this.searchLogs(plan, query, signal);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    // Step 2 — SECONDARY: spans, best-effort within a sub-budget. Never blocks or
    // drops the primary log items.
    const spanResult = await this.fetchSpansBestEffort(
      plan,
      query,
      started,
      signal,
    );
    const fetched = logs.length + spanResult.spans.length;

    // Step 3 — assemble neutral items (logs first, then spans), honoring maxItems
    // and the byte cap exactly like the references.
    const items: EvidenceItem[] = [];
    let bytes = 0;
    let truncated = false;
    const push = (item: EvidenceItem): boolean => {
      if (items.length >= limits.maxItems) {
        truncated = true;
        return false;
      }
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length > 0 && bytes + size > limits.maxBytes) {
        truncated = true;
        return false;
      }
      items.push(item);
      bytes += size;
      return true;
    };

    for (const log of logs) {
      if (
        !push(
          normalizeDatadogLog(
            log,
            this.appBase,
            plan.queryString,
            query.window,
          ),
        )
      ) {
        break;
      }
    }
    for (const span of spanResult.spans) {
      if (!push(normalizeDatadogSpan(span, this.appBase))) break;
    }

    const gaps: EvidenceGap[] = [...plan.gaps];
    if (spanResult.incomplete) {
      // Honest note: logs shipped; the secondary span search did not finish
      // within budget. Never a reason to drop the log items.
      gaps.push({
        lane: "network",
        reason:
          "datadog: span search did not complete within budget; log evidence returned without spans",
        suggestion:
          "raise the per-source timeout or narrow the incident window to include span evidence",
      });
    }

    return {
      schemaVersion: EVIDENCE_SOURCE_SCHEMA_VERSION,
      items,
      gaps,
      stats: {
        provider: this.descriptor.provider,
        fetched,
        returned: items.length,
        truncated,
        latencyMs: Math.max(0, Date.now() - started),
      },
    };
  }
}

/** Registry entry: build a Datadog source from env when its auth fields are set. */
export const datadogEvidenceProvider: EvidenceSourceProvider = {
  provider: "datadog",
  authFields: DATADOG_AUTH_FIELDS,
  fromEnv: (env) =>
    new DatadogEvidenceSource({
      apiKey: env[DATADOG_API_KEY_ENV] as string,
      appKey: env[DATADOG_APP_KEY_ENV] as string,
      site: env[DATADOG_SITE_ENV] || DATADOG_DEFAULT_SITE,
    }),
};
