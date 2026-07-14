import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
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
 * Cloudflare evidence adapter — built to the Sentry reference shape
 * (`sentry.ts`). Cloudflare has no ad-hoc log-query API on most plans, so this
 * adapter reads a **Logpush-to-R2 sink**: the client configures a Logpush job
 * that streams HTTP-request logs (or Workers Trace Events) as gzipped NDJSON
 * objects into an R2 bucket, and this adapter lists+reads the objects whose
 * time-partitioned keys fall inside the located incident window.
 *
 * R2 exposes an **S3-compatible API**, so we reuse the hand-rolled
 * {@link signSigV4} signer (service `s3`, region `auto`, R2 access key/secret,
 * endpoint `https://{account}.r2.cloudflarestorage.com`) rather than adding an
 * S3 SDK — the same zero-dependency decision made for CloudWatch. R2 egress is
 * FREE, so bulk reads cost nothing (the one provider where this is true), but we
 * still bound total work by `maxItems`/`maxBytes`/`timeoutMs` — we never walk the
 * whole bucket; truncation is recorded as a gap. Zero-copy: nothing R2 returns is
 * persisted; only the derived bundle is.
 *
 * Load-bearing patterns mirrored from the reference adapters:
 * - **Injectable transport**: constructor takes `fetchImpl?: typeof fetch`
 *   defaulting to global `fetch`; contract tests inject a fixture-routing stub so
 *   there is zero network in CI.
 * - **Descriptor-keyed filtering**: R2 has no server-side query, so `url` and
 *   `requestId` are applied as LINE-LEVEL filters after read; `time` is applied
 *   both by mapping the window to the minimal set of date-partitioned object keys
 *   AND at the line level. Any requested key the dataset cannot use becomes an
 *   honest {@link EvidenceGap} rather than a silent no-op.
 * - **Self-limiting read budget**: listing is the PRIMARY step (bounded retry);
 *   object reads fan out with capped concurrency inside a sub-budget carved from
 *   `limits.timeoutMs` (`READ_BUDGET_FRACTION`) so the adapter resolves BEFORE the
 *   framework's per-source timeout fires. Objects that could not be read in budget
 *   degrade to whatever was parsed + an honest gap, never "no items."
 * - **Resilience / source-unavailable marker**: a hard failure (bucket
 *   unreachable / auth fail) that yielded zero items self-degrades to a
 *   `kind: "source-unavailable"` gap → `ok:false`; partial success stays
 *   `ok:true` (see `fetch-all.ts`).
 * - **Secrets discipline**: the R2 secret lives ONLY inside the signer; it never
 *   appears in a gap, stat, thrown message, or log.
 * - **Redaction stays at the framework boundary** (`redact.ts`); this file only
 *   populates the fields that boundary scrubs (`brief`, `after`, `ref.url`).
 */

/** Env var carrying the Cloudflare account id (R2 endpoint host). Required. */
export const CLOUDFLARE_R2_ACCOUNT_ID_ENV =
  "CRUMBTRAIL_CLOUDFLARE_R2_ACCOUNT_ID";
/** Env var carrying the R2 access key id. Required. */
export const CLOUDFLARE_R2_ACCESS_KEY_ID_ENV =
  "CRUMBTRAIL_CLOUDFLARE_R2_ACCESS_KEY_ID";
/** Env var carrying the R2 secret access key. Required. */
export const CLOUDFLARE_R2_SECRET_ACCESS_KEY_ENV =
  "CRUMBTRAIL_CLOUDFLARE_R2_SECRET_ACCESS_KEY";
/** Env var carrying the R2 bucket name Logpush writes into. Required. */
export const CLOUDFLARE_R2_BUCKET_ENV = "CRUMBTRAIL_CLOUDFLARE_R2_BUCKET";
/** Env var carrying the key prefix BEFORE the `{DATE}` Logpush partition. Optional. */
export const CLOUDFLARE_R2_PREFIX_ENV = "CRUMBTRAIL_CLOUDFLARE_R2_PREFIX";
/** Env var selecting the Logpush dataset. Optional (default http_requests). */
export const CLOUDFLARE_R2_DATASET_ENV = "CRUMBTRAIL_CLOUDFLARE_R2_DATASET";
/** Env var overriding the R2 endpoint host (testing/localstack). Optional. */
export const CLOUDFLARE_R2_ENDPOINT_ENV = "CRUMBTRAIL_CLOUDFLARE_R2_ENDPOINT";

/** SigV4 service id for the R2 S3-compatible API. */
const R2_SERVICE = "s3";
/** SigV4 region for R2 — always the literal "auto". */
const R2_REGION = "auto";

/** Logpush datasets this adapter knows how to normalize. */
export type CloudflareDataset = "http_requests" | "workers_trace_events";
const DEFAULT_DATASET: CloudflareDataset = "http_requests";

/** Presence of these four ⇒ the provider is configured (mirrors ticket clients).
 *  Prefix, dataset, and endpoint have defaults so they are not required. */
export const CLOUDFLARE_AUTH_FIELDS = [
  CLOUDFLARE_R2_ACCOUNT_ID_ENV,
  CLOUDFLARE_R2_ACCESS_KEY_ID_ENV,
  CLOUDFLARE_R2_SECRET_ACCESS_KEY_ENV,
  CLOUDFLARE_R2_BUCKET_ENV,
];

export const CLOUDFLARE_DESCRIPTOR: EvidenceSourceDescriptor = {
  provider: "cloudflare",
  displayName: "Cloudflare",
  // http_requests → network; workers_trace_events → logs. The descriptor
  // declares both; the configured dataset decides which lane items land in.
  lanes: ["network", "logs"],
  // best-first: a RayID (request id) is the tightest line-level filter Logpush
  // objects offer; url narrows http_requests; time is the always-available floor
  // (and maps the window to the minimal set of object keys).
  joinKeys: ["requestId", "url", "time"],
  authFields: CLOUDFLARE_AUTH_FIELDS,
};

// ---------------------------------------------------------------------------
// Config + errors
// ---------------------------------------------------------------------------

export interface CloudflareSourceConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Key prefix BEFORE the `{DATE}` Logpush partition (no leading slash). */
  prefix?: string;
  /** Logpush dataset. Defaults to http_requests. */
  dataset?: CloudflareDataset;
  /** Endpoint host override (no trailing slash). Defaults to the R2 endpoint. */
  endpoint?: string;
  /** Injectable transport. Defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch;
}

/** Thrown internally for a non-2xx R2 response. Only the operation + status reach
 *  the message — never the signing secret or the access key id. */
class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly op: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

/** Transient (worth a bounded retry): network error, or 429/5xx from R2. A hard
 *  4xx (bad creds/params) won't improve on retry; an abort must stop now. */
function isTransient(error: unknown): boolean {
  if (error instanceof CloudflareError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error && error.name === "AbortError") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Query construction (descriptor-keyed) — mirrors buildSentryQuery.
// ---------------------------------------------------------------------------

export interface CloudflarePlan {
  /** Case-insensitive substring the request URL must contain, when url keyed. */
  urlFilter?: string;
  /** Exact RayID/request id a line must carry, when requestId keyed. */
  requestIdFilter?: string;
  /** Join keys actually used to narrow beyond the time window, best-first. */
  usedKeys: EvidenceJoinKey[];
  /** Honest gaps: a requested key this dataset cannot filter by. */
  gaps: EvidenceGap[];
}

/**
 * Build the line-level filter plan from `descriptor.joinKeys` ∩ present keys.
 * R2 has no query API, so filters are applied per NDJSON line after read:
 * `requestId` → exact match on the line's RayID (both datasets); `url` →
 * case-insensitive substring on the request URL (http_requests only — Workers
 * Trace Events carry no URL, so a requested `url` becomes a gap). Any requested
 * key outside the descriptor (traceId, sessionId, release, user, service) yields
 * a gap so the bundle states plainly what filtered the result.
 */
export function buildCloudflarePlan(
  query: EvidenceQuery,
  dataset: CloudflareDataset,
): CloudflarePlan {
  const { keys } = query;
  const gaps: EvidenceGap[] = [];
  const lane = dataset === "http_requests" ? "network" : "logs";

  for (const requested of Object.keys(keys) as EvidenceJoinKey[]) {
    if (requested === "time") continue;
    if (keys[requested] == null || keys[requested] === "") continue;
    if (!CLOUDFLARE_DESCRIPTOR.joinKeys.includes(requested)) {
      gaps.push({
        lane,
        reason: `cloudflare: cannot filter by ${requested}; used time window only`,
        suggestion:
          "stamp a RayID/request id into your Logpush fields to correlate Cloudflare precisely",
      });
    }
  }

  const usedKeys: EvidenceJoinKey[] = [];
  let requestIdFilter: string | undefined;
  let urlFilter: string | undefined;

  if (keys.requestId) {
    requestIdFilter = keys.requestId;
    usedKeys.push("requestId");
  }
  if (keys.url) {
    if (dataset === "http_requests") {
      urlFilter = keys.url;
      usedKeys.push("url");
    } else {
      // Workers Trace Events carry no URL field — the filter cannot be applied.
      gaps.push({
        lane: "logs",
        reason:
          "cloudflare[workers_trace_events]: no URL field; url filter not applied",
        suggestion:
          "switch the Logpush dataset to http_requests to filter by URL",
      });
    }
  }

  if (usedKeys.length === 0) {
    gaps.push({
      lane,
      reason:
        "cloudflare: no supported correlation key present; used time window only",
      suggestion:
        "propagate a RayID/request id (or url for http_requests) to tighten Cloudflare matching",
    });
  }

  return { urlFilter, requestIdFilter, usedKeys, gaps };
}

// ---------------------------------------------------------------------------
// Object-key ↔ incident-window mapping (bounded).
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Cap on date-partition prefixes listed for one query — bounds the fan-out so a
 *  huge (stale-ticket) window never lists the whole bucket. */
export const MAX_DATE_PARTITIONS = 3;
/** Cap on objects read per query. R2 egress is free, but reads are still bounded
 *  so a busy bucket cannot blow the timeout; overflow is a truncation gap. */
export const MAX_OBJECTS = 50;
/** ListObjectsV2 page size — single page, never a pagination walk. */
const LIST_MAX_KEYS = 1000;
/** Concurrency for the object-read fan-out. */
const READ_CONCURRENCY = 4;
/** Fraction of the per-source timeout the read fan-out spends before returning
 *  whatever parsed. Remainder is headroom so the adapter resolves before the
 *  framework's per-source timeout fires and discards the whole result. */
const READ_BUDGET_FRACTION = 0.8;

const BRIEF_MAX = 140;
/** Max characters kept in an item's `after` payload (byte cap + redaction do the
 *  rest). Keeps a single fat NDJSON line from dominating the bundle. */
const AFTER_MAX = 2_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `YYYYMMDD` (UTC) for a ms epoch — the Logpush `{DATE}` partition format. */
function yyyymmdd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/**
 * The UTC day-partition strings the window touches, most-recent-first, capped to
 * {@link MAX_DATE_PARTITIONS}. `truncated` is set when the window spanned more
 * days than the cap (older days are dropped and reported as a gap).
 */
export function cloudflareDatePartitions(window: {
  start: number;
  end: number;
}): { dates: string[]; truncated: boolean } {
  const dates: string[] = [];
  const startDay = Math.floor(window.start / DAY_MS) * DAY_MS;
  const endDay = Math.floor(window.end / DAY_MS) * DAY_MS;
  for (let d = endDay; d >= startDay; d -= DAY_MS) {
    dates.push(yyyymmdd(d));
    if (dates.length >= MAX_DATE_PARTITIONS + 1) break;
  }
  if (dates.length > MAX_DATE_PARTITIONS) {
    return { dates: dates.slice(0, MAX_DATE_PARTITIONS), truncated: true };
  }
  return { dates, truncated: false };
}

/** Normalize a configured prefix: strip leading slash, ensure a trailing slash
 *  when non-empty (so `logs` → `logs/` and `` stays ``). */
export function normalizeCloudflarePrefix(prefix: string | undefined): string {
  const p = (prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return p.length > 0 ? `${p}/` : "";
}

/**
 * Parse the batch time range embedded in a Logpush object key. Logpush names
 * objects `<start>_<end>_<hash>.log.gz`, where each timestamp is `YYYYMMDDTHHMMSSZ`
 * (the batch's first + last event). Returns the [start,end] ms range so an object
 * can be included only when its batch overlaps the incident window. Returns
 * undefined when the key does not carry a parseable range (then the object is
 * kept conservatively — still bounded by MAX_OBJECTS).
 */
export function parseKeyWindow(
  key: string,
): { start: number; end: number } | undefined {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const m = name.match(/(\d{8}T\d{6}Z)_(\d{8}T\d{6}Z)/);
  if (!m) return undefined;
  const toMs = (stamp: string): number => {
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(
      6,
      8,
    )}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
    return Date.parse(iso);
  };
  const start = toMs(m[1]);
  const end = toMs(m[2]);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return { start, end };
}

// ---------------------------------------------------------------------------
// ListObjectsV2 XML parsing (minimal, dependency-free).
// ---------------------------------------------------------------------------

export interface R2Object {
  key: string;
  size: number;
}

export interface ListObjectsResult {
  objects: R2Object[];
  truncated: boolean;
}

function xmlTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}

function xmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Parse an S3/R2 ListObjectsV2 XML response into object keys + sizes. Minimal by
 * design (the shape is stable and we never paginate): pulls each `<Contents>`'s
 * `<Key>`/`<Size>` and the top-level `<IsTruncated>`.
 */
export function parseListObjectsV2(xml: string): ListObjectsResult {
  const objects: R2Object[] = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    const key = xmlTag(block, "Key");
    if (!key) continue;
    const size = Number.parseInt(xmlTag(block, "Size") ?? "0", 10);
    objects.push({ key: xmlDecode(key), size: Number.isNaN(size) ? 0 : size });
  }
  const truncated = (xmlTag(xml, "IsTruncated") ?? "false").trim() === "true";
  return { objects, truncated };
}

// ---------------------------------------------------------------------------
// NDJSON decoding (gzip-aware) + normalization.
// ---------------------------------------------------------------------------

/** gzip magic bytes (RFC 1952): 0x1f 0x8b. */
function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Decode an R2 object body to NDJSON text. Logpush gzips by default (`.log.gz`);
 * we also accept plaintext (`.ndjson`). Detection is by gzip magic bytes so a key
 * suffix mismatch cannot corrupt parsing.
 */
export function decodeNdjson(body: ArrayBuffer | Buffer): string {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (isGzip(buf)) return gunzipSync(buf).toString("utf8");
  return buf.toString("utf8");
}

/** Parse NDJSON text into records, skipping blank/garbled lines. */
export function parseNdjsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A single malformed line never sinks the batch.
    }
  }
  return out;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A Logpush timestamp → ms epoch. Handles rfc3339 strings, unix seconds,
 * unix-ms, and unix-nanos (the timestamp_format options Logpush emits).
 */
export function cloudflareToMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") {
    if (value >= 1e17) return Math.floor(value / 1e6); // nanoseconds
    if (value >= 1e14) return Math.floor(value / 1e3); // microseconds
    if (value >= 1e11) return value; // milliseconds
    return value * 1000; // seconds
  }
  if (typeof value === "string") {
    const asNum = Number(value);
    if (!Number.isNaN(asNum) && /^\d+$/.test(value.trim())) {
      return cloudflareToMs(asNum);
    }
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** The RayID (request id) a line carries, if any. Both datasets expose `RayID`. */
function lineRayId(line: Record<string, unknown>): string | undefined {
  const direct = asString(line["RayID"]);
  if (direct) return direct;
  const event = line["Event"];
  if (event && typeof event === "object") {
    return asString((event as Record<string, unknown>)["RayID"]);
  }
  return undefined;
}

/** The full request URL a http_requests line describes, if reconstructable. */
function httpRequestUrl(line: Record<string, unknown>): string | undefined {
  const host = asString(line["ClientRequestHost"]);
  const uri =
    asString(line["ClientRequestURI"]) ?? asString(line["ClientRequestPath"]);
  if (host && uri) {
    const scheme = asString(line["ClientRequestScheme"]) ?? "https";
    return `${scheme}://${host}${uri}`;
  }
  return uri ?? host;
}

export interface NormalizedLine {
  item: EvidenceItem;
  whenObserved: number | undefined;
  rayId: string | undefined;
  url: string | undefined;
}

/** Drop a URL/URI query string — query params are the classic secret carrier
 *  (`?token=…`), and the request path is the signal we want in brief/after. The
 *  full URL (with query) still lands in `ref.url`, where `redactUrl` scrubs any
 *  embedded secret at the boundary. */
function stripQuery(uri: string): string {
  return uri.split("?")[0];
}

/** One http_requests NDJSON line → neutral evidence.v1 item (lane network). */
export function normalizeHttpRequestLine(
  line: Record<string, unknown>,
): NormalizedLine {
  const rayId = lineRayId(line);
  const method = asString(line["ClientRequestMethod"]) ?? "GET";
  const rawUri =
    asString(line["ClientRequestURI"]) ??
    asString(line["ClientRequestPath"]) ??
    "/";
  const path = stripQuery(rawUri);
  const status = line["EdgeResponseStatus"];
  const statusPart = status != null ? ` → ${status}` : "";
  const url = httpRequestUrl(line);
  const whenObserved = cloudflareToMs(
    line["EdgeStartTimestamp"] ?? line["EdgeEndTimestamp"],
  );

  // `after` is the trimmed line, but with the request URI's query stripped so a
  // secret hiding in `?token=…` cannot leak through the free-text field (the
  // shared boundary redacts `Bearer …`-style tokens but not query params inside
  // a JSON blob). The full URL is still preserved in `ref.url`.
  const safeLine = rawUri !== path ? { ...line, ClientRequestURI: path } : line;

  const item: EvidenceItem = {
    id: `cloudflare:http:${rayId ?? `${method}:${path}:${whenObserved ?? ""}`}`,
    lane: "network",
    kind: "cloudflare.http",
    brief: truncate(`${method} ${path}${statusPart}`, BRIEF_MAX),
    ref: {
      provider: "cloudflare",
      id: rayId ?? "",
      ...(url ? { url } : {}),
    },
    before: null,
    after: clip(JSON.stringify(safeLine), AFTER_MAX),
  };
  if (whenObserved != null) item.whenObserved = whenObserved;
  return { item, whenObserved, rayId, url };
}

/** One Workers Trace Event NDJSON line → neutral evidence.v1 item (lane logs). */
export function normalizeWorkerTraceLine(
  line: Record<string, unknown>,
): NormalizedLine {
  const rayId = lineRayId(line);
  const outcome = asString(line["Outcome"]) ?? "unknown";
  const script = asString(line["ScriptName"]) ?? "worker";
  const whenObserved = cloudflareToMs(
    line["EventTimestampMs"] ?? line["EventTimestamp"],
  );

  // `after` prefers the actual logs/exceptions the event carried.
  const logs = Array.isArray(line["Logs"]) ? line["Logs"] : [];
  const exceptions = Array.isArray(line["Exceptions"])
    ? line["Exceptions"]
    : [];
  const payload =
    logs.length > 0 || exceptions.length > 0
      ? JSON.stringify({ Logs: logs, Exceptions: exceptions })
      : JSON.stringify(line);

  const item: EvidenceItem = {
    id: `cloudflare:worker:${rayId ?? `${script}:${whenObserved ?? ""}`}`,
    lane: "logs",
    kind: "cloudflare.worker",
    brief: truncate(`${outcome} — ${script}`, BRIEF_MAX),
    ref: { provider: "cloudflare", id: rayId ?? "" },
    before: null,
    after: clip(payload, AFTER_MAX),
  };
  if (whenObserved != null) item.whenObserved = whenObserved;
  return { item, whenObserved, rayId, url: undefined };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("").digest("hex");

interface ReadOutcome {
  key: string;
  lines: Record<string, unknown>[];
  error?: string;
}

export class CloudflareEvidenceSource implements EvidenceSource {
  readonly descriptor = CLOUDFLARE_DESCRIPTOR;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly dataset: CloudflareDataset;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CloudflareSourceConfig) {
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.bucket = config.bucket;
    this.prefix = normalizeCloudflarePrefix(config.prefix);
    this.dataset = config.dataset ?? DEFAULT_DATASET;
    this.endpoint = (
      config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`
    ).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** One SigV4-signed GET against R2 (S3 API). The secret lives only in the
   *  signer; `x-amz-content-sha256` (empty-body hash) is signed as S3 requires.
   *  Returns the raw Response so callers can read text() or arrayBuffer(). */
  private async signedGet(
    url: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers = evidenceRequestHeaders({
      "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
    });
    const signed = signSigV4({
      method: "GET",
      url,
      region: R2_REGION,
      service: R2_SERVICE,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      body: "",
      headers,
    });
    return this.fetchImpl(url, { method: "GET", headers: signed, signal });
  }

  /** Build a ListObjectsV2 URL for a key prefix, capped to a single page. */
  private listUrl(prefix: string): string {
    // Manually encode so the signed URL and the wire URL are byte-identical
    // (encodeURIComponent === RFC3986 for this controlled param set: digits,
    // slashes, hyphens). No pagination — a single bounded page.
    const params =
      `list-type=2&max-keys=${LIST_MAX_KEYS}` +
      `&prefix=${encodeURIComponent(prefix)}`;
    return `${this.endpoint}/${encodeURIComponent(this.bucket)}?${params}`;
  }

  private objectUrl(key: string): string {
    // Preserve the key's slashes in the path (they are path separators), encode
    // the remaining segments.
    const encodedKey = key
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `${this.endpoint}/${encodeURIComponent(this.bucket)}/${encodedKey}`;
  }

  private async listObjects(
    prefix: string,
    signal?: AbortSignal,
  ): Promise<ListObjectsResult> {
    const res = await this.signedGet(this.listUrl(prefix), signal);
    if (!res.ok) {
      throw new CloudflareError(
        res.status,
        "ListObjectsV2",
        `Cloudflare R2 ListObjectsV2 failed with HTTP ${res.status}`,
      );
    }
    return parseListObjectsV2(await res.text());
  }

  private async readObject(
    key: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const res = await this.signedGet(this.objectUrl(key), signal);
    if (!res.ok) {
      throw new CloudflareError(
        res.status,
        "GetObject",
        `Cloudflare R2 GetObject failed with HTTP ${res.status}`,
      );
    }
    const buf = await res.arrayBuffer();
    return parseNdjsonLines(decodeNdjson(buf));
  }

  /** Cheap authenticated no-op: ListObjectsV2 on the bucket, max-keys 1. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    const checkedAt = Date.now();
    try {
      const url =
        `${this.endpoint}/${encodeURIComponent(this.bucket)}` +
        `?list-type=2&max-keys=1`;
      const res = await this.signedGet(url, signal);
      if (!res.ok) {
        throw new CloudflareError(
          res.status,
          "ListObjectsV2",
          `Cloudflare R2 health failed with HTTP ${res.status}`,
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

  async fetchEvidence(
    query: EvidenceQuery,
    signal?: AbortSignal,
  ): Promise<EvidenceSourceResult> {
    const started = Date.now();
    const { limits } = query;
    const plan = buildCloudflarePlan(query, this.dataset);
    const gaps: EvidenceGap[] = [...plan.gaps];

    // Step 1 — map the window to the minimal set of date-partitioned prefixes.
    const partitions = cloudflareDatePartitions(query.window);
    if (partitions.truncated) {
      gaps.push({
        lane: this.dataset === "http_requests" ? "network" : "logs",
        reason: `cloudflare: incident window spans more than ${MAX_DATE_PARTITIONS} day partitions; older days were not scanned`,
        suggestion:
          "narrow the incident window; Logpush objects are partitioned by day",
      });
    }

    // Step 2 — list each partition (PRIMARY, bounded retry). A partition whose
    // list throws degrades to a recorded failure rather than sinking the rest.
    const candidates: R2Object[] = [];
    const failedPrefixes: { prefix: string; error: string }[] = [];
    // Partitions whose ListObjectsV2 came back with IsTruncated=true. We list a
    // single 1000-key page (no continuation walk by design). Logpush keys sort
    // lexicographically = chronologically, so a >1000-object day returns only the
    // EARLIEST 1000 — the NEWEST objects (most likely to overlap a recent
    // incident window) are silently dropped. That is an honest gap, not silence.
    const truncatedPartitions: string[] = [];
    for (const date of partitions.dates) {
      const prefix = `${this.prefix}${date}/`;
      try {
        const listing = await withBoundedRetry(
          () => this.listObjects(prefix, signal),
          { isRetryable: isTransient },
        );
        candidates.push(...listing.objects);
        if (listing.truncated) truncatedPartitions.push(date);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") continue;
        failedPrefixes.push({
          prefix,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Step 3 — keep only objects whose batch window overlaps the incident
    // window, newest-first, capped to MAX_OBJECTS (bounded read fan-out).
    const overlapping = candidates.filter((obj) => {
      const kw = parseKeyWindow(obj.key);
      if (!kw) return true; // unparseable key: keep conservatively (still capped)
      return kw.start <= query.window.end && kw.end >= query.window.start;
    });
    overlapping.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    const objectCapReached = overlapping.length > MAX_OBJECTS;
    const toRead = overlapping.slice(0, MAX_OBJECTS);

    // Step 4 — read objects within a sub-budget carved from timeoutMs so the
    // adapter resolves before the framework's per-source timeout fires.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = limits.timeoutMs;
    const deadline =
      timeoutMs != null && Number.isFinite(timeoutMs)
        ? started + timeoutMs * READ_BUDGET_FRACTION
        : Number.POSITIVE_INFINITY;
    if (Number.isFinite(deadline)) {
      budgetTimer = setTimeout(onAbort, Math.max(0, deadline - Date.now()));
    }
    if (signal?.aborted) controller.abort();

    let readOutcomes: ReadOutcome[] = [];
    let readIncomplete = false;
    try {
      readOutcomes = await mapWithConcurrency(
        toRead,
        READ_CONCURRENCY,
        async (obj): Promise<ReadOutcome> => {
          if (controller.signal.aborted) {
            readIncomplete = true;
            return { key: obj.key, lines: [] };
          }
          try {
            const lines = await this.readObject(obj.key, controller.signal);
            return { key: obj.key, lines };
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              readIncomplete = true;
              return { key: obj.key, lines: [] };
            }
            return {
              key: obj.key,
              lines: [],
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (budgetTimer) clearTimeout(budgetTimer);
    }

    // Step 5 — normalize + line-level filter (time always; url/requestId when
    // keyed), honoring maxItems and the byte cap.
    const normalize =
      this.dataset === "http_requests"
        ? normalizeHttpRequestLine
        : normalizeWorkerTraceLine;
    const urlNeedle = plan.urlFilter?.toLowerCase();

    const items: EvidenceItem[] = [];
    const readFailures: { key: string; error: string }[] = [];
    let fetched = 0;
    let bytes = 0;
    let truncated = objectCapReached || truncatedPartitions.length > 0;

    for (const outcome of readOutcomes) {
      if (outcome.error) {
        readFailures.push({ key: outcome.key, error: outcome.error });
        continue;
      }
      for (const line of outcome.lines) {
        const norm = normalize(line);
        // Time filter is always applied (line-level precision within window).
        if (
          norm.whenObserved != null &&
          (norm.whenObserved < query.window.start ||
            norm.whenObserved > query.window.end)
        ) {
          continue;
        }
        if (plan.requestIdFilter && norm.rayId !== plan.requestIdFilter) {
          continue;
        }
        if (urlNeedle && !(norm.url ?? "").toLowerCase().includes(urlNeedle)) {
          continue;
        }
        fetched += 1;
        if (items.length >= limits.maxItems) {
          truncated = true;
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(norm.item), "utf8");
        if (items.length > 0 && bytes + size > limits.maxBytes) {
          truncated = true;
          continue;
        }
        items.push(norm.item);
        bytes += size;
      }
    }

    // Step 6 — honest gaps + source-health marker. A hard failure (all lists
    // failed / reads failed) that yielded zero items is a source-unavailable
    // failure; partial success (any item) stays ok:true.
    const hadFailure =
      failedPrefixes.length > 0 || readFailures.length > 0 || readIncomplete;
    const totalFailure = items.length === 0 && hadFailure;

    for (const { prefix, error } of failedPrefixes) {
      gaps.push({
        lane: this.dataset === "http_requests" ? "network" : "logs",
        reason: `cloudflare[${prefix}]: list failed — ${error}`,
        ...(totalFailure ? { kind: "source-unavailable" as const } : {}),
      });
    }
    for (const { key, error } of readFailures) {
      gaps.push({
        lane: this.dataset === "http_requests" ? "network" : "logs",
        reason: `cloudflare[${key}]: read failed — ${error}`,
        ...(totalFailure ? { kind: "source-unavailable" as const } : {}),
      });
    }
    if (readIncomplete) {
      const secs =
        timeoutMs != null && Number.isFinite(timeoutMs)
          ? Math.round((timeoutMs * READ_BUDGET_FRACTION) / 1000)
          : 0;
      gaps.push({
        lane: this.dataset === "http_requests" ? "network" : "logs",
        reason: totalFailure
          ? `cloudflare: object reads did not complete within ${secs}s; returned no results`
          : `cloudflare: object reads did not complete within ${secs}s; returned partial results`,
        suggestion:
          "narrow the incident window, add a correlation key, or raise the per-source timeout",
        ...(totalFailure ? { kind: "source-unavailable" as const } : {}),
      });
    }
    if (objectCapReached) {
      gaps.push({
        lane: this.dataset === "http_requests" ? "network" : "logs",
        reason: `cloudflare: more than ${MAX_OBJECTS} Logpush objects matched the window; only the newest were read`,
        suggestion:
          "narrow the incident window or add a correlation key to reduce object volume",
      });
    }
    for (const date of truncatedPartitions) {
      gaps.push({
        lane: this.dataset === "http_requests" ? "network" : "logs",
        reason: `cloudflare: more than ${LIST_MAX_KEYS} Logpush objects in partition ${date}; only the first page was listed — newest objects may be missing`,
        suggestion: "narrow the window or use finer Logpush partitioning",
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
 * helper in cloudwatch.ts.
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

/** Parse the dataset env value; unknown → default with no throw. */
function parseDataset(raw: string | undefined): CloudflareDataset {
  return raw === "workers_trace_events"
    ? "workers_trace_events"
    : DEFAULT_DATASET;
}

/** Registry entry: build a Cloudflare source from env when its auth fields are set. */
export const cloudflareEvidenceProvider: EvidenceSourceProvider = {
  provider: "cloudflare",
  authFields: CLOUDFLARE_AUTH_FIELDS,
  fromEnv: (env) =>
    new CloudflareEvidenceSource({
      accountId: env[CLOUDFLARE_R2_ACCOUNT_ID_ENV] as string,
      accessKeyId: env[CLOUDFLARE_R2_ACCESS_KEY_ID_ENV] as string,
      secretAccessKey: env[CLOUDFLARE_R2_SECRET_ACCESS_KEY_ENV] as string,
      bucket: env[CLOUDFLARE_R2_BUCKET_ENV] as string,
      prefix: env[CLOUDFLARE_R2_PREFIX_ENV] || undefined,
      dataset: parseDataset(env[CLOUDFLARE_R2_DATASET_ENV]),
      endpoint: env[CLOUDFLARE_R2_ENDPOINT_ENV] || undefined,
    }),
};
