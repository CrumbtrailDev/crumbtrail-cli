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
 * Sentry evidence adapter — the reference implementation every other adapter
 * (CloudWatch, Splunk, Datadog, PostHog, Cloudflare) copies.
 *
 * It is a query-at-incident-time pull: given a located incident window and the
 * correlation keys known for it, ask Sentry's REST API for the issues/events in
 * that window and normalize each into the neutral `evidence.v1` contract. It is
 * zero-copy — nothing Sentry returns is persisted; only the derived bundle is.
 *
 * Load-bearing patterns for CP4–CP7 to mirror:
 * - **Primary-first, enrichment-best-effort**: neutral items are built from the
 *   list/query call (the PRIMARY evidence — `brief`, `ref`, `whenObserved`) and
 *   emitted regardless of any secondary enrichment. Enrichment (here: per-issue
 *   stack heads) fans out with capped concurrency inside a sub-budget carved
 *   from `limits.timeoutMs`; if it is slow, fails, or the abort signal fires,
 *   the primary items still ship with a less-enriched field (`after: null`) —
 *   never nothing. This keeps a timed-out source degrading to "fewer/less-rich
 *   items + a gap," never "zero items."
 * - **Injectable transport**: the constructor takes `fetchImpl?: typeof fetch`.
 *   Production uses global `fetch`; contract tests inject a stub that replays
 *   recorded fixtures, so there is zero network in CI.
 * - **Descriptor-keyed query construction**: the search query is built strictly
 *   from `descriptor.joinKeys` ∩ the keys present in `EvidenceQuery.keys`, and a
 *   requested key the adapter cannot use becomes an honest {@link EvidenceGap}
 *   rather than a silent drop.
 * - **Boundaries**: never throws out of `fetchEvidence` in a way the framework
 *   can't turn into a gap; honors `limits.maxItems`/`maxBytes`; no pagination
 *   walk beyond `maxItems`; every request carries `CRUMBTRAIL_USER_AGENT`; the
 *   auth token lives only in the Authorization header, never in a message.
 * - **Redaction stays at the framework boundary** (`redact.ts` /
 *   `fetchAdapterEvidence`); this file only populates the fields that boundary
 *   scrubs (`brief`, `after`, `ref.url`).
 */

/** Env var carrying the Sentry auth token (Bearer). Required. */
export const SENTRY_AUTH_TOKEN_ENV = "CRUMBTRAIL_SENTRY_AUTH_TOKEN";
/** Env var carrying the Sentry organization slug. Required. */
export const SENTRY_ORG_ENV = "CRUMBTRAIL_SENTRY_ORG";
/** Env var overriding the API host (self-hosted Sentry). Optional. */
export const SENTRY_HOST_ENV = "CRUMBTRAIL_SENTRY_HOST";
/** Default SaaS host when {@link SENTRY_HOST_ENV} is unset. */
export const SENTRY_DEFAULT_HOST = "https://sentry.io";

/** Presence of these two ⇒ the provider is configured (mirrors ticket clients). */
export const SENTRY_AUTH_FIELDS = [SENTRY_AUTH_TOKEN_ENV, SENTRY_ORG_ENV];

export const SENTRY_DESCRIPTOR: EvidenceSourceDescriptor = {
  provider: "sentry",
  displayName: "Sentry",
  lanes: ["logs", "code"],
  // best-first: a trace token is the tightest filter Sentry offers; time is the
  // always-available floor; release/url/user narrow a time-only fallback.
  joinKeys: ["traceId", "time", "release", "url", "user"],
  authFields: SENTRY_AUTH_FIELDS,
};

/** Keys Sentry can turn into a search token (everything in the descriptor bar
 *  `time`, which is expressed via the start/end params, not the query string). */
const SEARCH_KEYS: EvidenceJoinKey[] = SENTRY_DESCRIPTOR.joinKeys.filter(
  (k) => k !== "time",
);

export interface SentrySourceConfig {
  authToken: string;
  org: string;
  /** API host, no trailing slash. Defaults to {@link SENTRY_DEFAULT_HOST}. */
  host?: string;
  /** Injectable transport. Defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch;
}

/** Thrown internally for a non-2xx Sentry response. The URL is sanitized and the
 *  auth token never appears — only status + path reach the message. Retryability
 *  keys off `status` exactly like `TicketError`. */
class SentryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SentryError";
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

/** Transient (worth a bounded retry): network error, or 429/5xx from Sentry. A
 *  hard 4xx (bad auth/params) won't improve on retry; an abort must stop now. */
function isTransient(error: unknown): boolean {
  if (error instanceof SentryError)
    return error.status === 429 || error.status >= 500;
  if (error instanceof Error && error.name === "AbortError") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Query construction (descriptor-keyed) — the part CP4–CP7 copy most closely.
// ---------------------------------------------------------------------------

export interface SentryQueryPlan {
  /** Sentry search query string (may be empty ⇒ time-window only). */
  search: string;
  /** Join keys actually used to narrow beyond the time window, best-first. */
  usedKeys: EvidenceJoinKey[];
  /** Honest gaps: a requested key Sentry cannot filter by. */
  gaps: EvidenceGap[];
}

function quoteIfNeeded(value: string): string {
  // Quote when the value carries whitespace, a colon, or an embedded quote, and
  // escape embedded `"`/`\` so a value like `id:"x"` cannot break out of the
  // token and corrupt (or inject into) the search query. CP4–CP7 copy this.
  if (/[\s:"\\]/.test(value)) {
    return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  }
  return value;
}

/**
 * Build the Sentry search query from `descriptor.joinKeys` ∩ present keys.
 * Precedence: a `trace:{traceId}` token when a trace is present (tightest), else
 * `url:` / `release:` / `user.email:` tokens for whichever of those keys is
 * present. Any requested key Sentry does NOT support (requestId, sessionId,
 * service, and — when no trace is present — nothing to pin on) yields a gap so
 * the bundle states plainly what filtered the result.
 */
export function buildSentryQuery(query: EvidenceQuery): SentryQueryPlan {
  const { keys } = query;
  const gaps: EvidenceGap[] = [];

  // A requested key outside the descriptor's capability set is unusable.
  for (const requested of Object.keys(keys) as EvidenceJoinKey[]) {
    if (requested === "time") continue;
    if (keys[requested] == null || keys[requested] === "") continue;
    if (!SENTRY_DESCRIPTOR.joinKeys.includes(requested)) {
      gaps.push({
        lane: "logs",
        reason: `sentry: cannot filter by ${requested}; used time window only`,
        suggestion:
          "stamp a trace id (W3C traceparent) on this flow to correlate Sentry precisely",
      });
    }
  }

  const tokens: string[] = [];
  const usedKeys: EvidenceJoinKey[] = [];

  if (keys.traceId) {
    // Tightest correlation: one trace token supersedes the looser tokens.
    tokens.push(`trace:${keys.traceId}`);
    usedKeys.push("traceId");
  } else {
    if (keys.url) {
      tokens.push(`url:${quoteIfNeeded(keys.url)}`);
      usedKeys.push("url");
    }
    if (keys.release) {
      tokens.push(`release:${quoteIfNeeded(keys.release)}`);
      usedKeys.push("release");
    }
    if (keys.user) {
      tokens.push(`user.email:${quoteIfNeeded(keys.user)}`);
      usedKeys.push("user");
    }
  }

  if (usedKeys.length === 0) {
    // No usable correlation key at all — time window is the only filter.
    gaps.push({
      lane: "logs",
      reason:
        "sentry: no supported correlation key present; used time window only",
      suggestion:
        "propagate a trace id, release, url, or user to tighten Sentry matching",
    });
  }

  return { search: tokens.join(" "), usedKeys, gaps };
}

// ---------------------------------------------------------------------------
// Normalization — the template every adapter follows.
// ---------------------------------------------------------------------------

/** Minimal shape of the Sentry issues-list rows we consume. */
interface SentryIssue {
  id: string;
  title?: string;
  culprit?: string;
  permalink?: string;
  lastSeen?: string;
  firstSeen?: string;
  metadata?: { value?: string; type?: string };
}

/** Minimal shape of a Sentry event (from `/issues/{id}/events/latest/`). */
interface SentryEvent {
  id?: string;
  dateCreated?: string;
  entries?: Array<{ type?: string; data?: unknown }>;
}

const BRIEF_MAX = 140;
/** Frames of the exception stack head we keep (bounded; bulk is capped anyway). */
const STACK_HEAD_FRAMES = 6;

/** Capped-concurrency fan-out for OPTIONAL stack-head enrichment: N issues cost
 *  ~N/CAP round trips instead of N serial ones, without hammering Sentry. */
const ENRICH_CONCURRENCY = 5;
/** Fraction of the per-source timeout budget the adapter will spend on OPTIONAL
 *  enrichment before giving up and emitting the primary issues-list items. The
 *  remainder is headroom so the adapter ALWAYS resolves (with items) before the
 *  framework's per-source timeout fires and discards the whole result. */
const ENRICH_BUDGET_FRACTION = 0.5;

/**
 * Run `fn` over `items` with a bounded worker pool (best-first order preserved
 * by index). Never rejects if `fn` never rejects. Pure helper CP4–CP7 reuse for
 * best-effort enrichment fan-out.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const pool = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: pool }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** "<title> — <culprit>", collapsed and clipped to ~140 chars. */
function buildBrief(issue: SentryIssue): string {
  const title =
    issue.title ??
    issue.metadata?.value ??
    issue.metadata?.type ??
    "Sentry issue";
  const culprit = issue.culprit?.trim();
  return truncate(culprit ? `${title} — ${culprit}` : title, BRIEF_MAX);
}

/**
 * Trimmed stack head for `after`: exception type/value plus the top frames as
 * `at fn (file:line)` lines. Kept short here; the framework byte cap + redaction
 * handle the rest. Returns null when the event carries no stacktrace.
 */
function buildStackHead(event: SentryEvent | undefined): string | null {
  const exception = event?.entries?.find((e) => e.type === "exception");
  const values = (exception?.data as { values?: unknown[] } | undefined)
    ?.values;
  const top = Array.isArray(values)
    ? (values[values.length - 1] as Record<string, unknown>)
    : undefined;
  if (!top) return null;

  const header = [top.type, top.value].filter(Boolean).join(": ");
  const frames = (top.stacktrace as { frames?: unknown[] } | undefined)?.frames;
  const lines: string[] = [];
  if (Array.isArray(frames)) {
    // Sentry orders frames caller→callee, so the crash frame is last: take the
    // tail and present it crash-first.
    for (const raw of frames.slice(-STACK_HEAD_FRAMES).reverse()) {
      const f = raw as Record<string, unknown>;
      const loc = [f.filename ?? f.module, f.lineNo]
        .filter((v) => v != null)
        .join(":");
      const fn = (f.function as string) ?? "?";
      lines.push(`  at ${fn}${loc ? ` (${loc})` : ""}`);
    }
  }
  const body = [header, ...lines].filter(Boolean).join("\n");
  return body.length > 0 ? body : null;
}

function whenObserved(
  issue: SentryIssue,
  event: SentryEvent | undefined,
): number | undefined {
  const iso = event?.dateCreated ?? issue.lastSeen;
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Sentry issue + its latest event → neutral evidence.v1 item. Pure. */
export function normalizeSentryIssue(
  issue: SentryIssue,
  event?: SentryEvent,
): EvidenceItem {
  const item: EvidenceItem = {
    id: `sentry:${issue.id}`,
    lane: "logs",
    kind: "sentry.error",
    brief: buildBrief(issue),
    ref: {
      provider: "sentry",
      id: issue.id,
      ...(issue.permalink ? { url: issue.permalink } : {}),
    },
    before: null,
    after: buildStackHead(event),
  };
  const ms = whenObserved(issue, event);
  if (ms != null) item.whenObserved = ms;
  return item;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SentryEvidenceSource implements EvidenceSource {
  readonly descriptor = SENTRY_DESCRIPTOR;
  private readonly authToken: string;
  private readonly org: string;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SentrySourceConfig) {
    this.authToken = config.authToken;
    this.org = config.org;
    this.host = (config.host ?? SENTRY_DEFAULT_HOST).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    // Token lives ONLY here — never in a thrown message or gap text.
    return evidenceRequestHeaders({
      Authorization: `Bearer ${this.authToken}`,
    });
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(url, { headers: this.headers(), signal });
    if (!res.ok) {
      throw new SentryError(
        res.status,
        `Sentry fetch failed with HTTP ${res.status}: ${sanitizeUrl(url)}`,
      );
    }
    return res.json();
  }

  /** Cheap authenticated no-op: GET the org endpoint. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    const checkedAt = Date.now();
    try {
      await this.getJson(
        `${this.host}/api/0/organizations/${encodeURIComponent(this.org)}/`,
        signal,
      );
      return { ok: true, provider: this.descriptor.provider, checkedAt };
    } catch (error) {
      // Message already sanitized (status + path, no token).
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        provider: this.descriptor.provider,
        checkedAt,
        error: message,
      };
    }
  }

  /** GET the latest event for one issue (for its stack head). A per-issue
   *  enrichment failure is non-fatal: we return undefined and the item is still
   *  emitted with `after: null` rather than sinking the whole fetch. Single
   *  attempt on purpose — this runs once per issue, so retrying it would let the
   *  best-effort enrichment blow the per-source timeout budget; the primary
   *  issues query keeps the bounded retry. */
  private async fetchLatestEvent(
    issueId: string,
    signal?: AbortSignal,
  ): Promise<SentryEvent | undefined> {
    const url =
      `${this.host}/api/0/organizations/${encodeURIComponent(this.org)}` +
      `/issues/${encodeURIComponent(issueId)}/events/latest/`;
    try {
      return (await this.getJson(url, signal)) as SentryEvent;
    } catch {
      // Any failure (non-2xx, network, or abort) degrades to "no stack head".
      return undefined;
    }
  }

  /**
   * OPTIONAL stack-head enrichment — the resilient pattern CP4–CP7 mirror.
   *
   * Fans out `/events/latest/` calls with capped concurrency, bounded by BOTH
   * the caller's abort signal AND a sub-budget carved from the per-source
   * timeout (`ENRICH_BUDGET_FRACTION` of `limits.timeoutMs`). A slow, failed, or
   * aborted event fetch simply leaves that issue's event `undefined` (→
   * `after: null`); it never blocks or drops the primary issues-list evidence.
   * Returns the per-issue events (index-aligned to `issues`) plus `incomplete`,
   * set when the signal fired or the sub-budget was exhausted before every
   * enrichment finished.
   */
  private async enrichStackHeads(
    issues: readonly SentryIssue[],
    startedAt: number,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ events: (SentryEvent | undefined)[]; incomplete: boolean }> {
    const events: (SentryEvent | undefined)[] = new Array(issues.length).fill(
      undefined,
    );
    // Signal already fired (or nothing to enrich): return the primary items as
    // they stand rather than nothing.
    if (issues.length === 0) return { events, incomplete: false };
    if (signal?.aborted) return { events, incomplete: true };

    // Sub-budget: enrichment must yield before the framework's per-source
    // timeout, so it self-aborts at a fraction of the budget. Its own controller
    // also chains off the incoming signal so an external abort stops it too.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs != null && Number.isFinite(timeoutMs)) {
      const remaining = Math.max(
        0,
        timeoutMs * ENRICH_BUDGET_FRACTION - (Date.now() - startedAt),
      );
      budgetTimer = setTimeout(onAbort, remaining);
    }

    try {
      await mapWithConcurrency(issues, ENRICH_CONCURRENCY, async (issue, i) => {
        if (controller.signal.aborted) return; // sub-budget spent: skip cleanly
        events[i] = await this.fetchLatestEvent(issue.id, controller.signal);
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (budgetTimer) clearTimeout(budgetTimer);
    }

    return { events, incomplete: controller.signal.aborted };
  }

  async fetchEvidence(
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<EvidenceSourceResult> {
    const started = Date.now();
    const { limits } = query;
    const plan = buildSentryQuery(query);

    // Step 1 — one issues query bounded to maxItems (no pagination walk). This
    // is the PRIMARY evidence: brief, ref, and whenObserved come straight from
    // the list rows and are complete without any enrichment.
    const url = new URL(
      `${this.host}/api/0/organizations/${encodeURIComponent(this.org)}/issues/`,
    );
    // Sentry treats an explicit start+end as an absolute window; statsPeriod is
    // deliberately omitted (passing it alongside start/end is rejected).
    url.searchParams.set("start", new Date(query.window.start).toISOString());
    url.searchParams.set("end", new Date(query.window.end).toISOString());
    if (plan.search) url.searchParams.set("query", plan.search);
    url.searchParams.set("limit", String(Math.max(1, limits.maxItems)));

    let raw: unknown;
    try {
      raw = await withBoundedRetry(() => this.getJson(url.toString(), signal), {
        isRetryable: isTransient,
      });
    } catch (error) {
      // Re-throw so the framework converts it into a gap; the message is already
      // sanitized (no token). fetchAdapterEvidence redacts it again defensively.
      throw error instanceof Error ? error : new Error(String(error));
    }

    const issues: SentryIssue[] = Array.isArray(raw)
      ? (raw as SentryIssue[])
      : [];
    const fetched = issues.length;

    // Step 2 — best-effort stack-head enrichment, capped-concurrency fan-out
    // bounded by a sub-budget + the abort signal. Enrichment is polish only: it
    // can arrive late, fail, or be skipped entirely, and the primary items still
    // ship (with `after: null`). It NEVER blocks or drops primary evidence, and
    // it self-limits so the adapter resolves before the framework's timeout can
    // discard the whole result.
    const enrichment = await this.enrichStackHeads(
      issues,
      started,
      limits.timeoutMs,
      signal,
    );

    // Step 3 — assemble neutral items from the issues list, folding in whatever
    // enrichment arrived, honoring maxItems and the byte cap exactly as before.
    const items: EvidenceItem[] = [];
    let bytes = 0;
    let truncated = false;
    for (let i = 0; i < issues.length; i += 1) {
      if (items.length >= limits.maxItems) {
        truncated = true;
        break;
      }
      const item = normalizeSentryIssue(issues[i], enrichment.events[i]);
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length > 0 && bytes + size > limits.maxBytes) {
        // Keep at least one item so a single oversized event still yields
        // evidence; otherwise stop before blowing the byte budget.
        truncated = true;
        break;
      }
      items.push(item);
      bytes += size;
    }

    const gaps: EvidenceGap[] = [...plan.gaps];
    if (enrichment.incomplete && items.length > 0) {
      // Honest note: primary evidence shipped, but optional stack heads did not
      // finish within budget. Never a reason to drop the items.
      gaps.push({
        lane: "logs",
        reason:
          "sentry: stack-head enrichment did not complete within budget; some items returned without stack traces",
        suggestion:
          "raise the per-source timeout or narrow the incident window to enrich stack traces",
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

/** Registry entry: build a Sentry source from env when its auth fields are set. */
export const sentryEvidenceProvider: EvidenceSourceProvider = {
  provider: "sentry",
  authFields: SENTRY_AUTH_FIELDS,
  fromEnv: (env) =>
    new SentryEvidenceSource({
      authToken: env[SENTRY_AUTH_TOKEN_ENV] as string,
      org: env[SENTRY_ORG_ENV] as string,
      host: env[SENTRY_HOST_ENV] || SENTRY_DEFAULT_HOST,
    }),
};
