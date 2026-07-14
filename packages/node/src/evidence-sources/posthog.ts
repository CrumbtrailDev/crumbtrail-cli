import {
  EVIDENCE_SOURCE_SCHEMA_VERSION,
  type EvidenceGap,
  type EvidenceItem,
  type EvidenceJoinKey,
  type EvidenceLane,
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
 * PostHog evidence adapter — built to the Sentry reference shape (`sentry.ts`)
 * and the Datadog two-API shape (`datadog.ts`). Query-at-incident-time pull:
 * given a located incident window and the correlation keys known for it, ask
 * PostHog's Events REST API (primary) and Session-Recordings list API
 * (secondary) for records in that window, and normalize each into the neutral
 * `evidence.v1` contract. Zero-copy — nothing PostHog returns is persisted; only
 * the derived bundle is.
 *
 * Load-bearing patterns mirrored from the references:
 * - **Injectable transport**: constructor takes `fetchImpl?: typeof fetch`
 *   defaulting to global `fetch`; contract tests inject a fixture-routing stub so
 *   there is zero network in CI.
 * - **Resilience / self-limiting secondary budget**: events are the PRIMARY
 *   evidence (fetched with the bounded retry). Session recordings are a SECONDARY
 *   fetch, run best-effort inside a sub-budget carved from `limits.timeoutMs`
 *   (`RECORDINGS_BUDGET_FRACTION`) and bounded by the caller's abort signal. If
 *   the recordings list is slow, fails, or is aborted, the event items still ship
 *   + an honest gap — one API's slowness NEVER drops the other API's items, and
 *   the adapter always resolves before the framework's per-source timeout fires.
 * - **Descriptor-keyed query construction**: the filters are built strictly from
 *   `descriptor.joinKeys` ∩ present keys; a requested key PostHog cannot use
 *   becomes an honest {@link EvidenceGap}. Every declared join key is genuinely
 *   applied (user → `distinct_id`, sessionId → `$session_id` event property +
 *   recordings `session_ids`, url → `$current_url` event property, time → the
 *   window) — no silent no-op.
 * - **Recordings are LINK-ONLY**: the adapter lists recordings and links them by
 *   `ref.url` (a replay player deep link). It NEVER downloads or stores recording
 *   content — `before`/`after` stay null. See the brief's Out of Scope.
 * - **Boundaries**: honors `limits.maxItems`/`maxBytes`/`timeoutMs`; the `limit`
 *   arg caps results server-side so there is no pagination walk beyond
 *   `maxItems`; every request carries `CRUMBTRAIL_USER_AGENT`; the personal API key
 *   lives only in the Authorization header, never in a gap, stat, thrown message,
 *   or log.
 * - **Redaction stays at the framework boundary** (`redact.ts`); this file only
 *   populates the fields that boundary scrubs (`brief`, `after`, `ref.url`).
 */

/** Env var carrying the PostHog personal API key (Bearer). Required. */
export const POSTHOG_API_KEY_ENV = "CRUMBTRAIL_POSTHOG_API_KEY";
/** Env var carrying the PostHog project id (numeric or short id). Required. */
export const POSTHOG_PROJECT_ID_ENV = "CRUMBTRAIL_POSTHOG_PROJECT_ID";
/** Env var overriding the API/UI host (self-hosted or EU cloud). Optional. */
export const POSTHOG_HOST_ENV = "CRUMBTRAIL_POSTHOG_HOST";
/** Default cloud host when {@link POSTHOG_HOST_ENV} is unset. The API and UI
 *  share this origin, so it also anchors the deep links. Use
 *  `https://eu.posthog.com` (EU cloud) or your self-hosted origin otherwise. */
export const POSTHOG_DEFAULT_HOST = "https://us.posthog.com";

/** Presence of these two ⇒ the provider is configured (mirrors ticket clients).
 *  Host has a default so it is not required. */
export const POSTHOG_AUTH_FIELDS = [
  POSTHOG_API_KEY_ENV,
  POSTHOG_PROJECT_ID_ENV,
];

export const POSTHOG_DESCRIPTOR: EvidenceSourceDescriptor = {
  provider: "posthog",
  displayName: "PostHog",
  lanes: ["browser", "flow"],
  // best-first: a distinct id (user) or a session id is the tightest filter
  // PostHog offers over a person's activity; url narrows a time-only fallback;
  // time is the always-available floor (the events/recordings window).
  joinKeys: ["user", "sessionId", "url", "time"],
  authFields: POSTHOG_AUTH_FIELDS,
};

export interface PostHogSourceConfig {
  apiKey: string;
  projectId: string;
  /** API/UI host, no trailing slash. Defaults to {@link POSTHOG_DEFAULT_HOST}. */
  host?: string;
  /** Injectable transport. Defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch;
}

/** Thrown internally for a non-2xx PostHog response. Only the API path + status
 *  reach the message — never the API key. Retryability keys off `status`. */
class PostHogError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PostHogError";
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

/** Transient (worth a bounded retry): network error, or 429/5xx from PostHog. A
 *  hard 4xx (bad key/params) won't improve on retry; an abort must stop now. */
function isTransient(error: unknown): boolean {
  if (error instanceof PostHogError)
    return error.status === 429 || error.status >= 500;
  if (error instanceof Error && error.name === "AbortError") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Query construction (descriptor-keyed) — mirrors buildDatadogQuery.
// ---------------------------------------------------------------------------

/** One PostHog event-property filter (the `properties` query param is a JSON
 *  array of these). */
export interface PostHogPropertyFilter {
  key: string;
  value: string;
  operator: "exact";
  type: "event";
}

export interface PostHogQueryPlan {
  /** `distinct_id` filter (from the `user` key), applied to events + recordings. */
  distinctId?: string;
  /** `$session_id` filter (from the `sessionId` key), applied to recordings too. */
  sessionId?: string;
  /** Event-property filters (`$session_id`, `$current_url`) for the events query. */
  properties: PostHogPropertyFilter[];
  /** Join keys actually used to narrow beyond the time window, best-first. */
  usedKeys: EvidenceJoinKey[];
  /** Honest gaps: a requested key PostHog cannot filter by. */
  gaps: EvidenceGap[];
}

/**
 * Build the PostHog query from `descriptor.joinKeys` ∩ present keys.
 * Precedence: `user` → `distinct_id` (the person filter, tightest and applied to
 * BOTH the events and recordings requests); `sessionId` → a `$session_id` event
 * property filter AND the recordings `session_ids` filter; `url` → a
 * `$current_url` event property filter. The time window is always applied via the
 * request date range. Any requested key PostHog does NOT support (traceId,
 * requestId, release, service) yields a gap so the bundle states plainly what
 * filtered the result.
 */
export function buildPostHogQuery(query: EvidenceQuery): PostHogQueryPlan {
  const { keys } = query;
  const gaps: EvidenceGap[] = [];

  for (const requested of Object.keys(keys) as EvidenceJoinKey[]) {
    if (requested === "time") continue;
    if (keys[requested] == null || keys[requested] === "") continue;
    if (!POSTHOG_DESCRIPTOR.joinKeys.includes(requested)) {
      gaps.push({
        lane: "browser",
        reason: `posthog: cannot filter by ${requested}; used time window only`,
        suggestion:
          "identify the user (distinct id) or stamp a $session_id on this flow to correlate PostHog precisely",
      });
    }
  }

  const usedKeys: EvidenceJoinKey[] = [];
  const properties: PostHogPropertyFilter[] = [];
  const plan: PostHogQueryPlan = { properties, usedKeys, gaps };

  if (keys.user) {
    plan.distinctId = keys.user;
    usedKeys.push("user");
  }
  if (keys.sessionId) {
    plan.sessionId = keys.sessionId;
    properties.push({
      key: "$session_id",
      value: keys.sessionId,
      operator: "exact",
      type: "event",
    });
    usedKeys.push("sessionId");
  }
  if (keys.url) {
    properties.push({
      key: "$current_url",
      value: keys.url,
      operator: "exact",
      type: "event",
    });
    usedKeys.push("url");
  }

  if (usedKeys.length === 0) {
    gaps.push({
      lane: "browser",
      reason:
        "posthog: no supported correlation key present; used time window only",
      suggestion:
        "propagate a distinct id (user), a $session_id, or a url to tighten PostHog matching",
    });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Normalization — mirrors normalizeDatadogLog / normalizeDatadogSpan.
// ---------------------------------------------------------------------------

const BRIEF_MAX = 140;
/** Event properties we surface in `after` (scalars only). Bulk/other props are
 *  intentionally dropped; the byte cap + redaction bound whatever remains. */
const AFTER_PROP_KEYS = [
  "$current_url",
  "$pathname",
  "$browser",
  "$os",
  "$exception_type",
  "$exception_message",
  "$exception_values",
];

/** Minimal shape of a PostHog event row (from `GET /api/projects/{id}/events/`). */
export interface PostHogEvent {
  id?: string;
  distinct_id?: string;
  event?: string;
  timestamp?: string;
  properties?: Record<string, unknown>;
}

/** Minimal shape of a PostHog session-recording row (from the list endpoint). */
export interface PostHogRecording {
  id?: string;
  distinct_id?: string;
  start_time?: string;
  end_time?: string;
  /** Recording length in SECONDS (PostHog reports `recording_duration`). */
  recording_duration?: number;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function parseTime(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Human-readable recording duration, e.g. "45s" or "3m 20s". */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0)
    return "unknown";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

/**
 * `$pageview`/`$pageleave` capture the user's navigation sequence, so they land
 * in the `flow` lane; every other event is a `browser`-lane signal. Session
 * recordings are always `flow`. Both lanes are declared on the descriptor.
 */
function eventLane(eventName: string | undefined): EvidenceLane {
  return eventName === "$pageview" || eventName === "$pageleave"
    ? "flow"
    : "browser";
}

/** A person-scoped deep link when the distinct id is known (the reliable link),
 *  else the project activity explorer. */
export function posthogEventDeepLink(
  appBase: string,
  projectId: string,
  distinctId: string | undefined,
): string {
  const base = `${appBase}/project/${encodeURIComponent(projectId)}`;
  return distinctId
    ? `${base}/person/${encodeURIComponent(distinctId)}`
    : `${base}/activity/explore`;
}

/** The replay player deep link for a recording (LINK-ONLY — no content fetched). */
export function posthogRecordingDeepLink(
  appBase: string,
  projectId: string,
  recordingId: string,
): string {
  return `${appBase}/project/${encodeURIComponent(projectId)}/replay/${encodeURIComponent(recordingId)}`;
}

/** Trimmed scalar props for `after` (null when none present). Pure. */
function buildEventAfter(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!properties) return null;
  const out: Record<string, unknown> = {};
  for (const key of AFTER_PROP_KEYS) {
    const v = properties[key];
    if (v == null) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[key] = v;
    } else {
      // Keep structured exception values, but as their JSON string so `after`
      // stays a shallow, redactable record rather than an arbitrary object tree.
      out[key] = JSON.stringify(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** One PostHog event → neutral evidence.v1 item (lane "browser"/"flow"). Pure. */
export function normalizePostHogEvent(
  event: PostHogEvent,
  appBase: string,
  projectId: string,
): EvidenceItem {
  const id = event.id ?? "";
  const name = event.event ?? "event";
  const url = event.properties?.["$current_url"];
  const contextual =
    typeof url === "string" && url.length > 0 ? ` — ${url}` : "";

  const item: EvidenceItem = {
    id: `posthog:event:${id}`,
    lane: eventLane(event.event),
    kind: "posthog.event",
    brief: truncate(`${name}${contextual}`, BRIEF_MAX),
    ref: {
      provider: "posthog",
      id,
      url: posthogEventDeepLink(appBase, projectId, event.distinct_id),
    },
    before: null,
    after: buildEventAfter(event.properties),
  };
  const ms = parseTime(event.timestamp);
  if (ms != null) item.whenObserved = ms;
  return item;
}

/**
 * One PostHog session recording → neutral evidence.v1 item (lane "flow").
 * LINK-ONLY: the value is the replay deep link in `ref.url`; NO recording content
 * is fetched or stored, so `before`/`after` are null. Pure.
 */
export function normalizePostHogRecording(
  recording: PostHogRecording,
  appBase: string,
  projectId: string,
): EvidenceItem {
  const id = recording.id ?? "";
  const duration = formatDuration(recording.recording_duration);

  const item: EvidenceItem = {
    id: `posthog:recording:${id}`,
    lane: "flow",
    kind: "posthog.recording",
    brief: truncate(`session recording ${id} (${duration})`, BRIEF_MAX),
    ref: {
      provider: "posthog",
      id,
      url: posthogRecordingDeepLink(appBase, projectId, id),
    },
    // LINK-ONLY invariant: never any recording content — link by ref only.
    before: null,
    after: null,
  };
  const ms = parseTime(recording.start_time);
  if (ms != null) item.whenObserved = ms;
  return item;
}

// ---------------------------------------------------------------------------
// Secondary (recordings) budget — mirrors SPAN_BUDGET_FRACTION in datadog.ts.
// ---------------------------------------------------------------------------

/** Fraction of the per-source timeout the adapter will spend on the SECONDARY
 *  recordings list before giving up and shipping the primary event items. The
 *  remainder is headroom so the adapter ALWAYS resolves (with items) BEFORE the
 *  framework's per-source timeout fires and discards the whole result. */
const RECORDINGS_BUDGET_FRACTION = 0.5;

interface EventsResponse {
  results?: PostHogEvent[];
}

interface RecordingsResponse {
  results?: PostHogRecording[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PostHogEvidenceSource implements EvidenceSource {
  readonly descriptor = POSTHOG_DESCRIPTOR;
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly appBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PostHogSourceConfig) {
    this.apiKey = config.apiKey;
    this.projectId = config.projectId;
    this.appBase = (config.host ?? POSTHOG_DEFAULT_HOST).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    // The personal API key lives ONLY here — never in a thrown message, gap, or
    // stat.
    return evidenceRequestHeaders({ Authorization: `Bearer ${this.apiKey}` });
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(url, { headers: this.headers(), signal });
    if (!res.ok) {
      throw new PostHogError(
        res.status,
        `PostHog fetch failed with HTTP ${res.status}: ${sanitizeUrl(url)}`,
      );
    }
    return (await res.json()) as T;
  }

  private projectPath(resource: string): string {
    return `${this.appBase}/api/projects/${encodeURIComponent(this.projectId)}/${resource}`;
  }

  /** Cheap authenticated no-op: GET the project endpoint. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    const checkedAt = Date.now();
    try {
      await this.getJson(
        `${this.appBase}/api/projects/${encodeURIComponent(this.projectId)}/`,
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

  /** PRIMARY: events query. Bounded retry — this is the evidence we must ship. */
  private async searchEvents(
    plan: PostHogQueryPlan,
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<PostHogEvent[]> {
    const url = new URL(this.projectPath("events/"));
    url.searchParams.set("after", new Date(query.window.start).toISOString());
    url.searchParams.set("before", new Date(query.window.end).toISOString());
    if (plan.distinctId) url.searchParams.set("distinct_id", plan.distinctId);
    if (plan.properties.length > 0) {
      url.searchParams.set("properties", JSON.stringify(plan.properties));
    }
    url.searchParams.set("limit", String(Math.max(1, query.limits.maxItems)));

    const res = await withBoundedRetry(
      () => this.getJson<EventsResponse>(url.toString(), signal),
      { isRetryable: isTransient },
    );
    return Array.isArray(res.results) ? res.results : [];
  }

  /** SECONDARY: session-recordings list. Single attempt on purpose — it runs
   *  inside a sub-budget, so retrying would risk blowing the per-source timeout.
   *  LINK-ONLY: this lists recordings; it NEVER reads snapshot/content blobs. */
  private async searchRecordings(
    plan: PostHogQueryPlan,
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<PostHogRecording[]> {
    const url = new URL(this.projectPath("session_recordings/"));
    url.searchParams.set(
      "date_from",
      new Date(query.window.start).toISOString(),
    );
    url.searchParams.set("date_to", new Date(query.window.end).toISOString());
    if (plan.distinctId) url.searchParams.set("distinct_id", plan.distinctId);
    if (plan.sessionId) {
      url.searchParams.set("session_ids", JSON.stringify([plan.sessionId]));
    }
    url.searchParams.set("limit", String(Math.max(1, query.limits.maxItems)));

    const res = await this.getJson<RecordingsResponse>(url.toString(), signal);
    return Array.isArray(res.results) ? res.results : [];
  }

  /**
   * Best-effort recordings list inside a sub-budget carved from `limits.timeoutMs`
   * and bounded by the caller's abort signal. A slow/failed/aborted list leaves
   * `recordings` empty (→ the event items still ship) and flips `incomplete`.
   * Mirrors Datadog's `fetchSpansBestEffort`.
   */
  private async fetchRecordingsBestEffort(
    plan: PostHogQueryPlan,
    query: EvidenceQuery,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<{ recordings: PostHogRecording[]; incomplete: boolean }> {
    if (signal?.aborted) return { recordings: [], incomplete: true };
    const timeoutMs = query.limits.timeoutMs;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs != null && Number.isFinite(timeoutMs)) {
      const remaining = Math.max(
        0,
        timeoutMs * RECORDINGS_BUDGET_FRACTION - (Date.now() - startedAt),
      );
      budgetTimer = setTimeout(onAbort, remaining);
    }

    try {
      const recordings = await this.searchRecordings(
        plan,
        query,
        controller.signal,
      );
      return { recordings, incomplete: controller.signal.aborted };
    } catch {
      // Any failure (non-2xx, network, or abort) degrades to "no recordings".
      return { recordings: [], incomplete: true };
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
    const plan = buildPostHogQuery(query);

    // Step 1 — PRIMARY: events. If this itself fails, re-throw so the framework
    // turns it into a gap (message already sanitized, no key) and flags the
    // source ok:false — the hard-failure marker path.
    let events: PostHogEvent[];
    try {
      events = await this.searchEvents(plan, query, signal);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    // Step 2 — SECONDARY: recordings, best-effort within a sub-budget. Never
    // blocks or drops the primary event items. LINK-ONLY — see searchRecordings.
    const recordingResult = await this.fetchRecordingsBestEffort(
      plan,
      query,
      started,
      signal,
    );
    const fetched = events.length + recordingResult.recordings.length;

    // Step 3 — assemble neutral items (events first, then recordings), honoring
    // maxItems and the byte cap exactly like the references.
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

    for (const event of events) {
      if (!push(normalizePostHogEvent(event, this.appBase, this.projectId)))
        break;
    }
    for (const recording of recordingResult.recordings) {
      if (
        !push(
          normalizePostHogRecording(recording, this.appBase, this.projectId),
        )
      ) {
        break;
      }
    }

    const gaps: EvidenceGap[] = [...plan.gaps];
    if (recordingResult.incomplete) {
      // Honest note: events shipped; the secondary recordings list did not finish
      // within budget. Never a reason to drop the event items.
      gaps.push({
        lane: "flow",
        reason:
          "posthog: session-recordings list did not complete within budget; event evidence returned without recordings",
        suggestion:
          "raise the per-source timeout or narrow the incident window to include recording links",
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

/** Registry entry: build a PostHog source from env when its auth fields are set. */
export const posthogEvidenceProvider: EvidenceSourceProvider = {
  provider: "posthog",
  authFields: POSTHOG_AUTH_FIELDS,
  fromEnv: (env) =>
    new PostHogEvidenceSource({
      apiKey: env[POSTHOG_API_KEY_ENV] as string,
      projectId: env[POSTHOG_PROJECT_ID_ENV] as string,
      host: env[POSTHOG_HOST_ENV] || POSTHOG_DEFAULT_HOST,
    }),
};
