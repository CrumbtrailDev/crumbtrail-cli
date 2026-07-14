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
import { signSigV4 } from "./sigv4";

/**
 * CloudWatch Logs Insights evidence adapter — the second adapter, built to the
 * Sentry reference shape (`sentry.ts`). Query-at-incident-time pull: given a
 * located incident window and the correlation keys known for it, run a Logs
 * Insights query over the configured log group(s) and normalize each matching
 * log line into the neutral `evidence.v1` contract. Zero-copy — nothing AWS
 * returns is persisted; only the derived bundle is.
 *
 * Load-bearing patterns mirrored from the Sentry reference:
 * - **Injectable transport**: constructor takes `fetchImpl?: typeof fetch`
 *   defaulting to global `fetch`; contract tests inject a fixture-routing stub so
 *   there is zero network in CI.
 * - **Resilience / self-limiting poll budget**: Logs Insights is async —
 *   `StartQuery` then poll `GetQueryResults`. The polling loop is the analog of
 *   Sentry's best-effort enrichment: it self-limits to a sub-budget carved from
 *   `limits.timeoutMs` (`POLL_BUDGET_FRACTION`) so the adapter resolves BEFORE
 *   the framework's per-source race fires, and it keeps the newest partial result
 *   snapshot. A query that out-runs the budget degrades to the rows that
 *   completed + an honest gap ("cloudwatch: query did not complete within Ns"),
 *   never "no items."
 * - **Descriptor-keyed query construction**: the `filter` term is built strictly
 *   from `descriptor.joinKeys` ∩ present keys; a requested key CloudWatch cannot
 *   use becomes an honest {@link EvidenceGap} rather than a silent drop.
 * - **Boundaries**: honors `limits.maxItems`/`maxBytes`/`timeoutMs`; no
 *   pagination walk beyond `maxItems`; every request is SigV4-signed and carries
 *   `CRUMBTRAIL_USER_AGENT`; credentials live only in the signing path, never in a
 *   gap, stat, thrown message, or log.
 * - **Redaction stays at the framework boundary** (`redact.ts`); this file only
 *   populates the fields that boundary scrubs (`brief`, `after`, `ref.url`).
 */

/** Env var carrying the AWS access key id. Required. */
export const CLOUDWATCH_ACCESS_KEY_ID_ENV =
  "CRUMBTRAIL_CLOUDWATCH_ACCESS_KEY_ID";
/** Env var carrying the AWS secret access key. Required. */
export const CLOUDWATCH_SECRET_ACCESS_KEY_ENV =
  "CRUMBTRAIL_CLOUDWATCH_SECRET_ACCESS_KEY";
/** Env var carrying the AWS region, e.g. "us-east-1". Required. */
export const CLOUDWATCH_REGION_ENV = "CRUMBTRAIL_CLOUDWATCH_REGION";
/** Env var carrying a comma-separated list of log group names. Required. */
export const CLOUDWATCH_LOG_GROUPS_ENV = "CRUMBTRAIL_CLOUDWATCH_LOG_GROUPS";
/** Env var carrying an STS session token for temporary/role creds. Optional. */
export const CLOUDWATCH_SESSION_TOKEN_ENV =
  "CRUMBTRAIL_CLOUDWATCH_SESSION_TOKEN";
/** Env var overriding the Logs endpoint host (govcloud/localstack). Optional. */
export const CLOUDWATCH_ENDPOINT_ENV = "CRUMBTRAIL_CLOUDWATCH_ENDPOINT";

/** AWS service id used for SigV4 signing + the endpoint host. */
const CLOUDWATCH_SERVICE = "logs";
/** `X-Amz-Target` API version prefix for CloudWatch Logs. */
const LOGS_TARGET_PREFIX = "Logs_20140328";

/** Presence of these four ⇒ the provider is configured (mirrors ticket clients). */
export const CLOUDWATCH_AUTH_FIELDS = [
  CLOUDWATCH_ACCESS_KEY_ID_ENV,
  CLOUDWATCH_SECRET_ACCESS_KEY_ENV,
  CLOUDWATCH_REGION_ENV,
  CLOUDWATCH_LOG_GROUPS_ENV,
];

export const CLOUDWATCH_DESCRIPTOR: EvidenceSourceDescriptor = {
  provider: "cloudwatch",
  displayName: "CloudWatch",
  lanes: ["logs"],
  // best-first: a correlation id in the message is the tightest filter Logs
  // Insights offers; time is the always-available floor; service scopes via the
  // configured log group(s). Note traceId doubles as requestId in this repo.
  joinKeys: ["requestId", "traceId", "time", "service"],
  authFields: CLOUDWATCH_AUTH_FIELDS,
};

/** Keys that become a `filter @message like "..."` term, best-first. */
const MESSAGE_FILTER_KEYS: EvidenceJoinKey[] = ["requestId", "traceId"];

export interface CloudWatchSourceConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Log group names to query, one Logs Insights query each. */
  logGroups: string[];
  /** STS session token for temporary/role credentials. Optional. */
  sessionToken?: string;
  /** Logs endpoint host override (no trailing slash). Defaults to the regional
   *  `https://logs.{region}.amazonaws.com`. */
  endpoint?: string;
  /** Injectable transport. Defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch;
  /** Poll interval override (ms) for the GetQueryResults loop. Tests shrink it. */
  pollIntervalMs?: number;
}

/** Thrown internally for a non-2xx Logs response. Only the API target + status
 *  reach the message — never the signing secret or the access key id. Retryability
 *  keys off `status`, exactly like `SentryError`/`TicketError`. */
class CloudWatchError extends Error {
  constructor(
    readonly status: number,
    readonly target: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudWatchError";
  }
}

/** Transient (worth a bounded retry): network error, or 429/5xx from AWS. A hard
 *  4xx (bad creds/params) won't improve on retry; an abort must stop now. */
function isTransient(error: unknown): boolean {
  if (error instanceof CloudWatchError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error && error.name === "AbortError") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Query construction (descriptor-keyed) — mirrors buildSentryQuery.
// ---------------------------------------------------------------------------

export interface CloudWatchQueryPlan {
  /** The Logs Insights query string (fields/filter/sort/limit). */
  queryString: string;
  /** Join keys actually used to narrow beyond the time window, best-first. */
  usedKeys: EvidenceJoinKey[];
  /** Honest gaps: a requested key CloudWatch cannot filter by. */
  gaps: EvidenceGap[];
}

/** Escape a value for a Logs Insights `like "..."` substring match (NOT a regex:
 *  the quoted form is a literal substring), so a value containing a quote or
 *  backslash cannot break out of the token. */
function quoteLike(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * Build the Logs Insights query from `descriptor.joinKeys` ∩ present keys.
 * Precedence: a `filter @message like "<id>"` term when a requestId/traceId is
 * present (the tightest correlation Logs Insights offers on unstructured logs),
 * else a time-window-only scan (the window is expressed via StartQuery's
 * start/end, not the query string). Any requested key CloudWatch does NOT support
 * (sessionId, release, url, user) yields a gap so the bundle states plainly what
 * filtered the result.
 */
export function buildCloudWatchQuery(
  query: EvidenceQuery,
): CloudWatchQueryPlan {
  const { keys, limits } = query;
  const gaps: EvidenceGap[] = [];

  // A requested key outside the descriptor's capability set is unusable.
  for (const requested of Object.keys(keys) as EvidenceJoinKey[]) {
    if (requested === "time") continue;
    if (keys[requested] == null || keys[requested] === "") continue;
    if (!CLOUDWATCH_DESCRIPTOR.joinKeys.includes(requested)) {
      gaps.push({
        lane: "logs",
        reason: `cloudwatch: cannot filter by ${requested}; used time window only`,
        suggestion:
          "stamp a request/trace id into your log lines (W3C traceparent) to correlate CloudWatch precisely",
      });
    }
  }

  // `service` is a declared join key, but CloudWatch does not turn it into a
  // query filter: a service is scoped by the log group(s) the operator
  // configured (CLOUDWATCH_LOG_GROUPS), so passing keys.service does NOT narrow
  // the @message scan. Emit an honest gap rather than the silent no-op the other
  // adapters avoid — the caller learns the service was honored via log-group
  // scoping, not as a message filter.
  if (keys.service != null && keys.service !== "") {
    gaps.push({
      lane: "logs",
      reason:
        "cloudwatch: service is scoped by the configured log group(s), not used as a message filter",
      suggestion:
        "configure CRUMBTRAIL_CLOUDWATCH_LOG_GROUPS to the service's log group(s); stamp a request/trace id into log lines to filter within them",
    });
  }

  const usedKeys: EvidenceJoinKey[] = [];
  let filterTerm = "";
  // traceId doubles as requestId in this repo, so the first present of the two
  // correlation keys is enough; a single message filter supersedes the looser
  // time-only scan.
  for (const key of MESSAGE_FILTER_KEYS) {
    const value = keys[key];
    if (value) {
      filterTerm = `| filter @message like ${quoteLike(value)} `;
      usedKeys.push(key);
      break;
    }
  }

  if (usedKeys.length === 0) {
    gaps.push({
      lane: "logs",
      reason:
        "cloudwatch: no supported correlation key present; used time window only",
      suggestion:
        "propagate a request id or trace id into log lines to tighten CloudWatch matching",
    });
  }

  // Tight, bounded scan: newest first, hard `limit` so Logs Insights never walks
  // beyond maxItems even before our own truncation.
  const limit = Math.max(1, limits.maxItems);
  const queryString =
    `fields @timestamp, @message, @ptr, @logStream ` +
    `${filterTerm}| sort @timestamp desc | limit ${limit}`;

  return { queryString, usedKeys, gaps };
}

// ---------------------------------------------------------------------------
// Normalization — mirrors normalizeSentryIssue.
// ---------------------------------------------------------------------------

const BRIEF_MAX = 140;

/** One Logs Insights result row: a list of `{ field, value }` cells. */
export type CloudWatchResultRow = Array<{ field?: string; value?: string }>;

function rowFields(row: CloudWatchResultRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cell of row) {
    if (cell.field) out[cell.field] = cell.value ?? "";
  }
  return out;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Parse a Logs Insights `@timestamp` ("YYYY-MM-DD HH:MM:SS.mmm", UTC, no zone)
 * into ms epoch. Normalizes the space/zone so parsing is engine-independent.
 */
function parseCwTimestamp(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts)
    ? ts.replace(" ", "T")
    : `${ts.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * CloudWatch Logs Insights console deep link for a log group in a region, so a
 * human can open the source. The console double-encodes path separators
 * (`/` → `$252F`). This links to the log group; a token-bearing URL would be
 * scrubbed at the redaction boundary anyway (there is none here).
 */
export function cloudWatchDeepLink(region: string, logGroup: string): string {
  const encGroup = logGroup.replace(/\//g, "$252F");
  return (
    `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}` +
    `#logsV2:log-groups/log-group/${encGroup}`
  );
}

/** One Logs Insights row → neutral evidence.v1 item. Pure. */
export function normalizeCloudWatchRow(
  row: CloudWatchResultRow,
  region: string,
  logGroup: string,
): EvidenceItem {
  const fields = rowFields(row);
  const message = fields["@message"] ?? "";
  const ptr = fields["@ptr"];
  const stream = fields["@logStream"];
  const ts = fields["@timestamp"];
  // Stable id: the @ptr is the row's unique pointer; fall back to stream+ts.
  const idPart = ptr || `${logGroup}:${stream ?? ""}:${ts ?? ""}`;

  const item: EvidenceItem = {
    id: `cloudwatch:${idPart}`,
    lane: "logs",
    kind: "cloudwatch.log",
    brief: truncate(message, BRIEF_MAX),
    ref: {
      provider: "cloudwatch",
      id: ptr || stream || logGroup,
      url: cloudWatchDeepLink(region, logGroup),
    },
    before: null,
    after: message.trim().length > 0 ? message.trim() : null,
  };
  const ms = parseCwTimestamp(ts);
  if (ms != null) item.whenObserved = ms;
  return item;
}

// ---------------------------------------------------------------------------
// Poll budget — mirrors ENRICH_BUDGET_FRACTION in sentry.ts.
// ---------------------------------------------------------------------------

/** Fraction of the per-source timeout the poll loop will spend before returning
 *  whatever completed. The remainder is headroom so the adapter ALWAYS resolves
 *  (with rows) BEFORE the framework's per-source timeout fires and discards the
 *  whole result. */
const POLL_BUDGET_FRACTION = 0.8;
/** Default GetQueryResults poll cadence. Tests shrink this via config. */
const DEFAULT_POLL_INTERVAL_MS = 500;
/** Max concurrent Logs Insights queries (one per log group). */
const GROUP_CONCURRENCY = 4;

/** Logs Insights query lifecycle statuses that mean "stop polling". */
const TERMINAL_STATUSES = new Set([
  "Complete",
  "Failed",
  "Cancelled",
  "Timeout",
  "Unknown",
]);

interface GetQueryResultsResponse {
  status?: string;
  results?: CloudWatchResultRow[];
}

interface GroupOutcome {
  logGroup: string;
  /** The Logs Insights `results` for this group (each row is a cell list). */
  resultRows: CloudWatchResultRow[];
  /** True iff the query reached `Complete` within budget. */
  complete: boolean;
  /** Present when the group's query itself failed (auth/not-found/etc.). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CloudWatchEvidenceSource implements EvidenceSource {
  readonly descriptor = CLOUDWATCH_DESCRIPTOR;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly region: string;
  private readonly logGroups: string[];
  private readonly sessionToken?: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;

  constructor(config: CloudWatchSourceConfig) {
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.region = config.region;
    this.logGroups = config.logGroups;
    this.sessionToken = config.sessionToken;
    this.endpoint = (
      config.endpoint ?? `https://logs.${config.region}.amazonaws.com`
    ).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * One signed POST to the Logs JSON API. `action` is the short target name
   * (e.g. "StartQuery"). The SigV4 signature and the (non-secret) User-Agent are
   * the only auth material on the wire; the secret key never leaves the signer.
   */
  private async post<T>(
    action: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const target = `${LOGS_TARGET_PREFIX}.${action}`;
    const payload = JSON.stringify(body ?? {});
    const baseHeaders: Record<string, string> = evidenceRequestHeaders({
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": target,
    });
    const signed = signSigV4({
      method: "POST",
      url: `${this.endpoint}/`,
      region: this.region,
      service: CLOUDWATCH_SERVICE,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      body: payload,
      headers: baseHeaders,
    });
    const res = await this.fetchImpl(`${this.endpoint}/`, {
      method: "POST",
      headers: signed,
      body: payload,
      signal,
    });
    if (!res.ok) {
      // Only the target + status reach the message — no secret, no key id.
      throw new CloudWatchError(
        res.status,
        target,
        `CloudWatch ${action} failed with HTTP ${res.status}`,
      );
    }
    return (await res.json()) as T;
  }

  private startQuery(
    logGroup: string,
    plan: CloudWatchQueryPlan,
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<{ queryId?: string }> {
    // Logs Insights StartQuery takes start/end in SECONDS.
    return this.post<{ queryId?: string }>(
      "StartQuery",
      {
        logGroupNames: [logGroup],
        startTime: Math.floor(query.window.start / 1000),
        endTime: Math.floor(query.window.end / 1000),
        queryString: plan.queryString,
        limit: Math.max(1, query.limits.maxItems),
      },
      signal,
    );
  }

  private getQueryResults(
    queryId: string,
    signal?: AbortSignal,
  ): Promise<GetQueryResultsResponse> {
    return this.post<GetQueryResultsResponse>(
      "GetQueryResults",
      { queryId },
      signal,
    );
  }

  /** Cheap authenticated no-op: DescribeLogGroups with limit 1. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    const checkedAt = Date.now();
    try {
      await this.post("DescribeLogGroups", { limit: 1 }, signal);
      return { ok: true, provider: this.descriptor.provider, checkedAt };
    } catch (error) {
      // Message already sanitized (target + status, no secret).
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        provider: this.descriptor.provider,
        checkedAt,
        error: message,
      };
    }
  }

  /**
   * Run one log group's Logs Insights query end-to-end: StartQuery, then poll
   * GetQueryResults until Complete, a terminal non-complete status, or the
   * shared deadline/abort fires. Keeps the newest partial `results` snapshot so
   * a query that out-runs the budget still yields the rows that had completed —
   * never empty. A group whose query throws (bad creds, missing group) degrades
   * to `error` on the outcome rather than sinking the other groups' rows.
   */
  private async runGroupQuery(
    logGroup: string,
    plan: CloudWatchQueryPlan,
    query: EvidenceQuery,
    deadline: number,
    signal: AbortSignal,
    sleep: (ms: number, s: AbortSignal) => Promise<void>,
  ): Promise<GroupOutcome> {
    let resultRows: CloudWatchResultRow[] = [];
    try {
      const started = await withBoundedRetry(
        () => this.startQuery(logGroup, plan, query, signal),
        { isRetryable: isTransient },
      );
      const queryId = started.queryId;
      if (!queryId) {
        return { logGroup, resultRows, complete: false };
      }

      for (;;) {
        if (signal.aborted) break; // budget spent or external abort
        const res = await withBoundedRetry(
          () => this.getQueryResults(queryId, signal),
          { isRetryable: isTransient },
        );
        // Keep the newest snapshot: partial results are still real evidence.
        if (Array.isArray(res.results)) resultRows = res.results;
        const status = res.status ?? "Running";
        if (status === "Complete") {
          return { logGroup, resultRows, complete: true };
        }
        if (TERMINAL_STATUSES.has(status)) {
          // Failed/Cancelled/Timeout/Unknown: return whatever partial we have.
          return { logGroup, resultRows, complete: false };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(this.pollIntervalMs, remaining), signal);
      }
      // Budget/abort exhausted mid-poll: return the newest snapshot, incomplete.
      return { logGroup, resultRows, complete: false };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // Aborted mid-fetch: not a group failure, just incomplete.
        return { logGroup, resultRows, complete: false };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { logGroup, resultRows, complete: false, error: message };
    }
  }

  async fetchEvidence(
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<EvidenceSourceResult> {
    const started = Date.now();
    const { limits } = query;
    const plan = buildCloudWatchQuery(query);

    // Self-limiting deadline: the poll loop must yield before the framework's
    // per-source timeout, so it self-aborts at a fraction of the budget. The
    // internal controller also chains off the incoming signal so an external
    // abort stops it too.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = limits.timeoutMs;
    const deadline =
      timeoutMs != null && Number.isFinite(timeoutMs)
        ? started + timeoutMs * POLL_BUDGET_FRACTION
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

    let outcomes: GroupOutcome[];
    try {
      // One Logs Insights query per log group, capped concurrency.
      outcomes = await mapWithConcurrency(
        this.logGroups,
        GROUP_CONCURRENCY,
        (logGroup) =>
          this.runGroupQuery(
            logGroup,
            plan,
            query,
            deadline,
            controller.signal,
            sleep,
          ),
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (budgetTimer) clearTimeout(budgetTimer);
    }

    // Assemble neutral items across groups (config order), honoring maxItems and
    // the byte cap exactly like the Sentry reference.
    const items: EvidenceItem[] = [];
    const gaps: EvidenceGap[] = [...plan.gaps];
    let fetched = 0;
    let bytes = 0;
    let truncated = false;
    const incompleteGroups: string[] = [];
    const failedGroups: { logGroup: string; error: string }[] = [];

    for (const outcome of outcomes) {
      if (outcome.error) {
        failedGroups.push({ logGroup: outcome.logGroup, error: outcome.error });
        continue;
      }
      if (!outcome.complete) incompleteGroups.push(outcome.logGroup);
      for (const row of outcome.resultRows) {
        fetched += 1;
        if (items.length >= limits.maxItems) {
          truncated = true;
          continue;
        }
        const item = normalizeCloudWatchRow(row, this.region, outcome.logGroup);
        const size = Buffer.byteLength(JSON.stringify(item), "utf8");
        if (items.length > 0 && bytes + size > limits.maxBytes) {
          truncated = true;
          continue;
        }
        items.push(item);
        bytes += size;
      }
    }

    // Source-level hard failure ONLY when the source as a whole delivered zero
    // items AND at least one group failed or timed out. Partial success (any
    // group returned rows) stays ok:true, so the `source-unavailable` marker is
    // computed once at the source level — never per failed group — and only when
    // nothing survived. All-groups-failed / all-incomplete-with-zero-rows →
    // ok:false (parity with a thrown failure); a legitimately empty successful
    // query (no failures, no incompletes) stays ok:true with no marker.
    const totalFailure =
      items.length === 0 &&
      (failedGroups.length > 0 || incompleteGroups.length > 0);

    for (const { logGroup, error } of failedGroups) {
      gaps.push({
        lane: "logs",
        reason: `cloudwatch[${logGroup}]: fetch failed — ${error}`,
        ...(totalFailure ? { kind: "source-unavailable" as const } : {}),
      });
    }

    if (incompleteGroups.length > 0) {
      const secs =
        timeoutMs != null && Number.isFinite(timeoutMs)
          ? Math.round((timeoutMs * POLL_BUDGET_FRACTION) / 1000)
          : 0;
      // Honest note: whatever completed shipped; slow groups did not finish.
      // Never a reason to drop the rows that did complete.
      gaps.push({
        lane: "logs",
        reason: totalFailure
          ? `cloudwatch: query did not complete within ${secs}s for ${incompleteGroups.length} log group(s); returned no results`
          : `cloudwatch: query did not complete within ${secs}s for ${incompleteGroups.length} log group(s); returned partial results`,
        suggestion:
          "narrow the incident window, add a correlation key, or raise the per-source timeout",
        ...(totalFailure ? { kind: "source-unavailable" as const } : {}),
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

/**
 * Run `fn` over `items` with a bounded worker pool, collecting results
 * index-aligned to `items`. Never rejects if `fn` never rejects. Mirrors the
 * `mapWithConcurrency` helper in sentry.ts, extended to return values.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;
  let next = 0;
  const pool = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: pool }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Split a comma-separated env value into trimmed, non-empty log group names. */
function parseLogGroups(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Registry entry: build a CloudWatch source from env when its auth fields are set. */
export const cloudWatchEvidenceProvider: EvidenceSourceProvider = {
  provider: "cloudwatch",
  authFields: CLOUDWATCH_AUTH_FIELDS,
  fromEnv: (env) =>
    new CloudWatchEvidenceSource({
      accessKeyId: env[CLOUDWATCH_ACCESS_KEY_ID_ENV] as string,
      secretAccessKey: env[CLOUDWATCH_SECRET_ACCESS_KEY_ENV] as string,
      region: env[CLOUDWATCH_REGION_ENV] as string,
      logGroups: parseLogGroups(env[CLOUDWATCH_LOG_GROUPS_ENV]),
      sessionToken: env[CLOUDWATCH_SESSION_TOKEN_ENV] || undefined,
      endpoint: env[CLOUDWATCH_ENDPOINT_ENV] || undefined,
    }),
};
