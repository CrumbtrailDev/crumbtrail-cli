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
 * Splunk evidence adapter — built to the Sentry reference shape (`sentry.ts`) and
 * the CloudWatch async-poll shape (`cloudwatch.ts`). Query-at-incident-time pull:
 * given a located incident window and the correlation keys known for it, run a
 * bounded SPL search over the configured index(es) and normalize each matching
 * event into the neutral `evidence.v1` contract. Zero-copy — nothing Splunk
 * returns is persisted; only the derived bundle is.
 *
 * Load-bearing patterns mirrored from the references:
 * - **Injectable transport**: constructor takes `fetchImpl?: typeof fetch`
 *   defaulting to global `fetch`; contract tests inject a fixture-routing stub so
 *   there is zero network in CI.
 * - **Resilience / self-limiting search budget**: a Splunk search is async —
 *   `POST .../jobs` dispatches a job, then we poll `.../results_preview`. The poll
 *   loop is the analog of CloudWatch's poll: it self-limits to a sub-budget carved
 *   from `limits.timeoutMs` (`POLL_BUDGET_FRACTION`) so the adapter resolves BEFORE
 *   the framework's per-source race fires, and it keeps the newest partial preview
 *   snapshot. A search that out-runs the budget degrades to the rows Splunk had
 *   previewed + an honest gap ("splunk: search did not complete within Ns"),
 *   never "no items."
 * - **Descriptor-keyed query construction**: the SPL terms are built strictly from
 *   `descriptor.joinKeys` ∩ present keys; a requested key Splunk cannot use becomes
 *   an honest {@link EvidenceGap} rather than a silent drop. Every declared join
 *   key is genuinely applied (traceId/requestId as a term, service as a field
 *   filter, time as earliest/latest) — no silent no-op.
 * - **Boundaries**: honors `limits.maxItems`/`maxBytes`/`timeoutMs`; the `count`
 *   arg caps results server-side so there is no pagination walk beyond `maxItems`;
 *   every request carries `CRUMBTRAIL_USER_AGENT`; the token lives only in the
 *   Authorization header, never in a gap, stat, thrown message, or log.
 * - **Redaction stays at the framework boundary** (`redact.ts`); this file only
 *   populates the fields that boundary scrubs (`brief`, `after`, `ref.url`).
 */

/** Env var carrying the Splunk search head base URL (incl. mgmt port, e.g.
 *  `https://splunk.example.com:8089`). Required. */
export const SPLUNK_HOST_ENV = "CRUMBTRAIL_SPLUNK_HOST";
/** Env var carrying the Splunk authentication (JWT) token. Required. */
export const SPLUNK_TOKEN_ENV = "CRUMBTRAIL_SPLUNK_TOKEN";
/** Env var carrying a comma-separated list of allowed indexes. Required. */
export const SPLUNK_INDEX_ENV = "CRUMBTRAIL_SPLUNK_INDEX";
/** Env var overriding the web UI base URL for deep links (e.g.
 *  `https://splunk.example.com:8000`). Optional — derived from the host if unset. */
export const SPLUNK_WEB_URL_ENV = "CRUMBTRAIL_SPLUNK_WEB_URL";

/** Presence of these three ⇒ the provider is configured (mirrors ticket clients). */
export const SPLUNK_AUTH_FIELDS = [
  SPLUNK_HOST_ENV,
  SPLUNK_TOKEN_ENV,
  SPLUNK_INDEX_ENV,
];

export const SPLUNK_DESCRIPTOR: EvidenceSourceDescriptor = {
  provider: "splunk",
  displayName: "Splunk",
  lanes: ["logs"],
  // best-first: a correlation id term is the tightest filter over raw events;
  // requestId doubles as traceId in this repo; service narrows via a field
  // filter; time is the always-available floor (earliest/latest).
  joinKeys: ["traceId", "requestId", "time", "service"],
  authFields: SPLUNK_AUTH_FIELDS,
};

/** Correlation-id keys that become a bare SPL search term, best-first. */
const TERM_KEYS: EvidenceJoinKey[] = ["traceId", "requestId"];

export interface SplunkSourceConfig {
  /** Search head base URL (no trailing slash), typically the :8089 mgmt port. */
  host: string;
  /** Splunk authentication (JWT) token. */
  token: string;
  /** Allowed index names; the SPL scans these (OR-joined). */
  indexes: string[];
  /** Web UI base URL for deep links. Defaults to a best-effort host derivation. */
  webUrl?: string;
  /** Injectable transport. Defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch;
  /** Poll interval override (ms) for the results_preview loop. Tests shrink it. */
  pollIntervalMs?: number;
}

/** Thrown internally for a non-2xx Splunk response. Only the API path + status
 *  reach the message — never the token. Retryability keys off `status`, exactly
 *  like `SentryError`/`CloudWatchError`/`TicketError`. */
class SplunkError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SplunkError";
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

/** Transient (worth a bounded retry): network error, or 429/5xx from Splunk. A
 *  hard 4xx (bad token/SPL) won't improve on retry; an abort must stop now. */
function isTransient(error: unknown): boolean {
  if (error instanceof SplunkError)
    return error.status === 429 || error.status >= 500;
  if (error instanceof Error && error.name === "AbortError") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Query construction (descriptor-keyed) — mirrors buildSentryQuery/…CloudWatch.
// ---------------------------------------------------------------------------

export interface SplunkQueryPlan {
  /** The full SPL string (starts with `search`, incl. index + earliest/latest). */
  spl: string;
  /** Join keys actually used to narrow beyond the time window, best-first. */
  usedKeys: EvidenceJoinKey[];
  /** Honest gaps: a requested key Splunk cannot filter by. */
  gaps: EvidenceGap[];
}

/** Quote + escape a value for an SPL double-quoted term so a value containing a
 *  quote or backslash cannot break out of the token. */
function splQuote(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** `index=a` or `(index=a OR index=b)` for the configured indexes. */
function indexClause(indexes: string[]): string {
  const parts = indexes.map((i) => `index=${splQuote(i)}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/**
 * Build the SPL from `descriptor.joinKeys` ∩ present keys.
 * Precedence: a bare quoted correlation-id term (traceId, else requestId) is the
 * tightest filter over raw events; `service="<svc>"` is applied additively as a
 * field filter; the time window is always expressed via `earliest`/`latest`. Any
 * requested key Splunk does NOT support (sessionId, release, url, user) yields a
 * gap so the bundle states plainly what filtered the result.
 */
export function buildSplunkQuery(
  query: EvidenceQuery,
  indexes: string[],
): SplunkQueryPlan {
  const { keys, window } = query;
  const gaps: EvidenceGap[] = [];

  // A requested key outside the descriptor's capability set is unusable.
  for (const requested of Object.keys(keys) as EvidenceJoinKey[]) {
    if (requested === "time") continue;
    if (keys[requested] == null || keys[requested] === "") continue;
    if (!SPLUNK_DESCRIPTOR.joinKeys.includes(requested)) {
      gaps.push({
        lane: "logs",
        reason: `splunk: cannot filter by ${requested}; used time window only`,
        suggestion:
          "stamp a request/trace id (W3C traceparent) into your events to correlate Splunk precisely",
      });
    }
  }

  const usedKeys: EvidenceJoinKey[] = [];
  const terms: string[] = [];

  // Correlation id: traceId doubles as requestId, so the first present of the two
  // is enough. A single quoted term supersedes the looser time-only scan.
  for (const key of TERM_KEYS) {
    const value = keys[key];
    if (value) {
      terms.push(splQuote(value));
      usedKeys.push(key);
      break;
    }
  }

  // service is genuinely applied as a field filter (never a silent no-op).
  if (keys.service) {
    terms.push(`service=${splQuote(keys.service)}`);
    usedKeys.push("service");
  }

  if (usedKeys.length === 0) {
    gaps.push({
      lane: "logs",
      reason:
        "splunk: no supported correlation key present; used time window only",
      suggestion:
        "propagate a request/trace id or service to tighten Splunk matching",
    });
  }

  // earliest/latest as epoch seconds (Splunk accepts epoch in-SPL). This keeps
  // the window in the SPL so the deep link reproduces exactly what was searched.
  const earliest = Math.floor(window.start / 1000);
  const latest = Math.floor(window.end / 1000);
  const spl = [
    "search",
    indexClause(indexes),
    `earliest=${earliest}`,
    `latest=${latest}`,
    ...terms,
  ].join(" ");

  return { spl, usedKeys, gaps };
}

// ---------------------------------------------------------------------------
// Normalization — mirrors normalizeSentryIssue / normalizeCloudWatchRow.
// ---------------------------------------------------------------------------

const BRIEF_MAX = 140;

/** One Splunk search result row (the `results[]` entries in the JSON output). */
export interface SplunkResultRow {
  _raw?: string;
  _time?: string;
  _cd?: string;
  _bkt?: string;
  index?: string;
  sourcetype?: string;
  [field: string]: unknown;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Parse a Splunk `_time` (ISO 8601, usually with offset) into ms epoch. */
function parseSplunkTime(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Derive a best-effort web UI base for deep links from the mgmt host: the mgmt
 * port (8089) becomes the default web port (8000); otherwise the origin is used.
 * A configured {@link SplunkSourceConfig.webUrl} always wins.
 */
export function splunkWebBase(host: string, webUrl?: string): string {
  if (webUrl) return webUrl.replace(/\/+$/, "");
  try {
    const u = new URL(host);
    if (u.port === "8089") u.port = "8000";
    return `${u.origin}`;
  } catch {
    return host.replace(/\/+$/, "");
  }
}

/**
 * Splunk search-app deep link that lands on the SPL + time range the event came
 * from — the practical "actual search where the log lives" link (better than a
 * bare index link). The mgmt API host carries no UI, so we point at the web base.
 */
export function splunkSearchDeepLink(
  webBase: string,
  spl: string,
  window: { start: number; end: number },
): string {
  const earliest = Math.floor(window.start / 1000);
  const latest = Math.floor(window.end / 1000);
  const q = encodeURIComponent(spl);
  return (
    `${webBase}/en-US/app/search/search?q=${q}` +
    `&earliest=${earliest}&latest=${latest}`
  );
}

/** One Splunk result row → neutral evidence.v1 item. Pure. */
export function normalizeSplunkRow(
  row: SplunkResultRow,
  webBase: string,
  spl: string,
  window: { start: number; end: number },
): EvidenceItem {
  const raw = typeof row._raw === "string" ? row._raw : "";
  // Stable id: `_cd` is the event's unique address; fall back to bkt + time.
  const idPart = row._cd || `${row._bkt ?? row.index ?? ""}:${row._time ?? ""}`;

  const item: EvidenceItem = {
    id: `splunk:${idPart}`,
    lane: "logs",
    kind: "splunk.event",
    brief: truncate(raw, BRIEF_MAX),
    ref: {
      provider: "splunk",
      id: idPart,
      url: splunkSearchDeepLink(webBase, spl, window),
    },
    before: null,
    after: raw.trim().length > 0 ? raw.trim() : null,
  };
  const ms = parseSplunkTime(row._time);
  if (ms != null) item.whenObserved = ms;
  return item;
}

// ---------------------------------------------------------------------------
// Poll budget — mirrors POLL_BUDGET_FRACTION in cloudwatch.ts.
// ---------------------------------------------------------------------------

/** Fraction of the per-source timeout the poll loop will spend before returning
 *  whatever Splunk had previewed. The remainder is headroom so the adapter ALWAYS
 *  resolves (with rows) BEFORE the framework's per-source timeout fires and
 *  discards the whole result. */
const POLL_BUDGET_FRACTION = 0.8;
/** Default results_preview poll cadence. Tests shrink this via config. */
const DEFAULT_POLL_INTERVAL_MS = 500;

interface CreateJobResponse {
  sid?: string;
}

/** results_preview / results output: `preview` is false once the search is done. */
interface ResultsResponse {
  preview?: boolean;
  results?: SplunkResultRow[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SplunkEvidenceSource implements EvidenceSource {
  readonly descriptor = SPLUNK_DESCRIPTOR;
  private readonly host: string;
  private readonly token: string;
  private readonly indexes: string[];
  private readonly webBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;

  constructor(config: SplunkSourceConfig) {
    this.host = config.host.replace(/\/+$/, "");
    this.token = config.token;
    this.indexes = config.indexes;
    this.webBase = splunkWebBase(this.host, config.webUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // Splunk authentication (JWT) tokens use Bearer auth. The token lives ONLY
    // here — never in a thrown message, gap, or stat.
    return evidenceRequestHeaders({
      Authorization: `Bearer ${this.token}`,
      ...extra,
    });
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(url, { headers: this.headers(), signal });
    if (!res.ok) {
      throw new SplunkError(
        res.status,
        `Splunk fetch failed with HTTP ${res.status}: ${sanitizeUrl(url)}`,
      );
    }
    return res.json();
  }

  /** Dispatch a search job (form-encoded), returning its sid. */
  private async createJob(
    spl: string,
    signal?: AbortSignal,
  ): Promise<CreateJobResponse> {
    const body = new URLSearchParams({
      search: spl,
      output_mode: "json",
    }).toString();
    const url = `${this.host}/services/search/v2/jobs`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      body,
      signal,
    });
    if (!res.ok) {
      throw new SplunkError(
        res.status,
        `Splunk createJob failed with HTTP ${res.status}: ${sanitizeUrl(url)}`,
      );
    }
    return (await res.json()) as CreateJobResponse;
  }

  /** Fetch the newest preview snapshot for a job (also final rows once done). */
  private previewResults(
    sid: string,
    count: number,
    signal?: AbortSignal,
  ): Promise<ResultsResponse> {
    const url =
      `${this.host}/services/search/v2/jobs/${encodeURIComponent(sid)}` +
      `/results_preview?output_mode=json&count=${Math.max(1, count)}`;
    return this.getJson(url, signal) as Promise<ResultsResponse>;
  }

  /** Cheap authenticated no-op: GET server info. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    const checkedAt = Date.now();
    try {
      await this.getJson(
        `${this.host}/services/server/info?output_mode=json`,
        signal,
      );
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

  async fetchEvidence(
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<EvidenceSourceResult> {
    const started = Date.now();
    const { limits } = query;
    const plan = buildSplunkQuery(query, this.indexes);

    // Self-limiting deadline: the poll loop must yield before the framework's
    // per-source timeout, so it self-aborts at a fraction of the budget. The
    // internal controller also chains off the incoming signal so an external
    // abort stops it too.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = limits.timeoutMs;
    const budgetMs =
      timeoutMs != null && Number.isFinite(timeoutMs)
        ? timeoutMs * POLL_BUDGET_FRACTION
        : Number.POSITIVE_INFINITY;
    const deadline = Number.isFinite(budgetMs)
      ? started + budgetMs
      : Number.POSITIVE_INFINITY;
    if (Number.isFinite(deadline)) {
      budgetTimer = setTimeout(onAbort, Math.max(0, deadline - Date.now()));
    }
    if (signal?.aborted) controller.abort();

    const sleep = (ms: number, s: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        if (s.aborted) return resolve();
        const t = setTimeout(() => {
          s.removeEventListener("abort", onAbortSleep);
          resolve();
        }, ms);
        const onAbortSleep = () => {
          clearTimeout(t);
          resolve();
        };
        s.addEventListener("abort", onAbortSleep, { once: true });
      });

    let rows: SplunkResultRow[] = [];
    let complete = false;
    let failure: string | undefined;
    const sig = controller.signal;
    try {
      const created = await withBoundedRetry(
        () => this.createJob(plan.spl, sig),
        {
          isRetryable: isTransient,
        },
      );
      const sid = created.sid;
      if (sid) {
        for (;;) {
          if (sig.aborted) break; // budget spent or external abort
          const res = await withBoundedRetry(
            () => this.previewResults(sid, limits.maxItems, sig),
            { isRetryable: isTransient },
          );
          // Keep the newest snapshot: partial preview rows are still real evidence.
          if (Array.isArray(res.results)) rows = res.results;
          if (res.preview === false) {
            complete = true;
            break; // search is done; these are the final rows
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(this.pollIntervalMs, remaining), sig);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // Aborted mid-fetch: not a failure, just incomplete.
      } else {
        // A dispatch/results failure degrades to a gap (the framework also
        // redacts defensively); the message is already sanitized (no token).
        failure = error instanceof Error ? error.message : String(error);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (budgetTimer) clearTimeout(budgetTimer);
    }

    // Assemble neutral items, honoring maxItems and the byte cap exactly like the
    // references.
    const items: EvidenceItem[] = [];
    const gaps: EvidenceGap[] = [...plan.gaps];
    let bytes = 0;
    let truncated = false;
    const fetched = rows.length;

    for (const row of rows) {
      if (items.length >= limits.maxItems) {
        truncated = true;
        break;
      }
      const item = normalizeSplunkRow(
        row,
        this.webBase,
        plan.spl,
        query.window,
      );
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length > 0 && bytes + size > limits.maxBytes) {
        truncated = true;
        break;
      }
      items.push(item);
      bytes += size;
    }

    // A hard failure ONLY when nothing survived: dispatch/auth failure with zero
    // rows, or a timeout that previewed nothing. The `source-unavailable` marker
    // lets the framework set stats.ok:false (parity with a thrown failure). If we
    // did ship rows, this is partial success → no marker → ok:true.
    const noItems = items.length === 0;
    if (failure) {
      gaps.push({
        lane: "logs",
        reason: `splunk: fetch failed — ${failure}`,
        ...(noItems ? { kind: "source-unavailable" as const } : {}),
      });
    } else if (!complete) {
      const secs =
        timeoutMs != null && Number.isFinite(timeoutMs)
          ? Math.round((timeoutMs * POLL_BUDGET_FRACTION) / 1000)
          : 0;
      // Honest note: whatever Splunk had previewed shipped; the search did not
      // finish within budget. Never a reason to drop the rows we did get — but
      // if it previewed NOTHING, the source delivered no primary evidence.
      gaps.push({
        lane: "logs",
        reason: noItems
          ? `splunk: search did not complete within ${secs}s; returned no results`
          : `splunk: search did not complete within ${secs}s; returned partial results`,
        suggestion:
          "narrow the incident window, add a correlation key, or raise the per-source timeout",
        ...(noItems ? { kind: "source-unavailable" as const } : {}),
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

/** Split a comma-separated env value into trimmed, non-empty index names. */
function parseIndexes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Registry entry: build a Splunk source from env when its auth fields are set. */
export const splunkEvidenceProvider: EvidenceSourceProvider = {
  provider: "splunk",
  authFields: SPLUNK_AUTH_FIELDS,
  fromEnv: (env) =>
    new SplunkEvidenceSource({
      host: env[SPLUNK_HOST_ENV] as string,
      token: env[SPLUNK_TOKEN_ENV] as string,
      indexes: parseIndexes(env[SPLUNK_INDEX_ENV]),
      webUrl: env[SPLUNK_WEB_URL_ENV] || undefined,
    }),
};
