# Cloudflare (evidence adapter)

> Part of Crumbtrail's [evidence-source adapters](./evidence-sources.md) — see the overview for the OTLP dual-export vs. evidence-adapter decision guide and the GA-pending live-smoke checklist.

Unlike Sentry/Datadog/Splunk, Cloudflare exposes **no ad-hoc log-query API** on
most plans — you cannot ask "give me the requests in this 10-minute window."
The supported path is **Logpush → R2**: you configure a Logpush job that streams
your logs into an R2 bucket, and Crumbtrail reads the objects inside the located
incident window at ticket time. Nothing is re-instrumented and nothing but the
derived bundle is stored.

## Feasibility (CP7 spike)

**Verdict: VIABLE.**

- **No ad-hoc query API.** Cloudflare's ad-hoc log APIs (Logpull / GraphQL
  Analytics) are limited/deprecated and not a general log-search surface. The
  durable, GA path for "give me the raw log lines" is **Logpush to a sink**.
- **R2 is the ideal sink.** R2 speaks an **S3-compatible API** (ListObjectsV2 +
  GetObject, SigV4 service `s3`), so the hand-rolled `sigv4.ts` signer already in
  this repo (built for CloudWatch) is reused directly — **no S3 SDK dependency**.
  R2 **egress is free**, so bulk reads cost nothing (the one provider where the
  repo's egress rule is explicitly relaxed). We still bound total work by
  `maxItems` / `maxBytes` / `timeoutMs`.
- **Object layout we target.** Logpush's R2 `destination_conf` is
  `r2://<BUCKET_PATH>/{DATE}?account-id=…&access-key-id=…&secret-access-key=…`.
  The recommended `{DATE}` placeholder writes objects into **daily subfolders**
  named `YYYYMMDD`, and each object is named
  `YYYYMMDDTHHMMSSZ_YYYYMMDDTHHMMSSZ_<hash>.log.gz` — the two timestamps are the
  batch's first and last event. Output is **NDJSON** (one JSON record per line),
  **gzip-compressed by default** (`.log.gz`); the adapter also accepts plaintext
  (`.ndjson`) and detects gzip by magic bytes.
- **Window → keys mapping.** The incident window is mapped to the minimal set of
  object keys: the UTC day partition(s) it touches become the ListObjectsV2
  prefix(es), and each object is included only when the batch range embedded in
  its key overlaps the window. Object count and day-partition count are capped
  (no bucket walk); overflow is reported as a truncation gap.

The one genuine constraint (not a blocker): the client **must** configure the
Logpush job with the `{DATE}` daily-partition placeholder so the adapter can
bound its listing to the window's day(s). This is documented in Setup below.

## Setup

### 1. Create a Logpush job into R2

Pick a dataset — **HTTP requests** (zone-scoped) or **Workers Trace Events**
(account-scoped) — and point it at an R2 bucket, using the `{DATE}` placeholder:

```
r2://<bucket>/<optional-prefix>/{DATE}?account-id=<ACCOUNT_ID>&access-key-id=<R2_ACCESS_KEY_ID>&secret-access-key=<R2_SECRET_ACCESS_KEY>
```

- Keep the default output (`ndjson`, gzip). For HTTP requests, include at least
  `EdgeStartTimestamp`, `ClientRequestHost`, `ClientRequestMethod`,
  `ClientRequestURI`, `EdgeResponseStatus`, and `RayID`. For Workers Trace Events,
  the default fields (`Outcome`, `ScriptName`, `EventTimestampMs`, `Logs`,
  `Exceptions`, and the event's `RayID`) are enough.
- The `{DATE}` placeholder is **required** for this adapter — it is what lets
  Crumbtrail scan only the day(s) the incident touches instead of the whole bucket.

### 2. Create an R2 API token

Create an R2 **Access Key** (S3 credentials) scoped to read the bucket. You will
get an Account ID, an Access Key ID, and a Secret Access Key.

### 3. Configure the Crumbtrail runtime (self-host)

The adapter is active only when the four required vars are present:

```bash
CRUMBTRAIL_CLOUDFLARE_R2_ACCOUNT_ID=<cloudflare account id>
CRUMBTRAIL_CLOUDFLARE_R2_ACCESS_KEY_ID=<R2 access key id>
CRUMBTRAIL_CLOUDFLARE_R2_SECRET_ACCESS_KEY=<R2 secret access key>
CRUMBTRAIL_CLOUDFLARE_R2_BUCKET=<bucket name>
# Optional — key prefix BEFORE the {DATE} partition (e.g. "cf-logs"); omit if the
# job writes to the bucket root.
CRUMBTRAIL_CLOUDFLARE_R2_PREFIX=cf-logs
# Optional — http_requests (default) or workers_trace_events.
CRUMBTRAIL_CLOUDFLARE_R2_DATASET=http_requests
# Optional — override the R2 endpoint host (testing only).
CRUMBTRAIL_CLOUDFLARE_R2_ENDPOINT=
```

Verify it is wired and authenticating:

```bash
crumbtrail-server doctor
```

Doctor lists each configured evidence source, whether its cheap authenticated
no-op (a `max-keys=1` ListObjectsV2 call) succeeds, and its declared join keys.

## What gets fetched

For a located incident window the adapter:

1. Derives the UTC day partition(s) the window touches (capped to 3 — a wider
   window reports a gap rather than scanning more days).
2. Runs one bounded `ListObjectsV2` per partition prefix (`<prefix>/YYYYMMDD/`),
   a single page — never a pagination walk.
3. Keeps only objects whose embedded batch time range overlaps the window,
   newest-first, capped to a fixed object count (overflow → truncation gap).
4. Reads those objects (gunzips gzip, parses NDJSON) inside a sub-budget carved
   from the per-source timeout, so it resolves before the framework's timeout.
5. Filters each line by the precise window and by any correlation key present,
   then normalizes.

Each line becomes one neutral evidence item:

- An **HTTP request** → `lane: "network"`, `kind: "cloudflare.http"`, `brief`:
  `<method> <path> → <status>`, `whenObserved`: `EdgeStartTimestamp`, `ref.url`:
  the reconstructed request URL (query stripped at the source, and the deep link
  scrubbed by the redaction boundary), `ref.id`: the `RayID`.
- A **Workers Trace Event** → `lane: "logs"`, `kind: "cloudflare.worker"`,
  `brief`: `<outcome> — <script>`, `whenObserved`: `EventTimestampMs`, `after`:
  the event's logs + exceptions (redacted), `ref.id`: the `RayID`.

Bulk text is bounded by `maxItems` / `maxBytes` and passes through the redaction
boundary before anything is retained. Query strings inside request URLs are
dropped from the free-text fields at the source so a `?token=…` secret cannot
leak; the full URL survives only in `ref.url`, where embedded secrets are scrubbed.

## Join keys

The adapter declares **`requestId, url, time`**. Because R2 has no server-side
query, these are applied as **line-level** filters after read:

- **`requestId`** → exact match on the line's `RayID` (both datasets).
- **`url`** → case-insensitive substring on the request URL (**http_requests
  only** — Workers Trace Events carry no URL, so a requested `url` on that dataset
  surfaces an honest gap instead of a silent no-op).
- **`time`** → always applied, both by mapping the window to object keys and at
  the line level.
- A requested key Cloudflare cannot use (e.g. `traceId`, `sessionId`, `release`,
  `user`, `service`) surfaces an honest gap rather than a silent drop.

Adapter output is **neutral evidence only**; ranking and hypotheses happen once,
downstream, never in the adapter. The R2 secret lives only inside the SigV4
signer — never in a gap, stat, log, or thrown message.

## Notes / limits

- **Logs only** (HTTP requests + Workers Trace Events). Cloudflare Analytics
  GraphQL, metrics, and firewall analytics are out of scope.
- **Latency**: Logpush batches are typically written within a few minutes, so
  very recent events may not yet be in R2 when a ticket arrives.
- **Zero-copy**: nothing R2 returns is persisted; only the derived bundle is.
- **Not yet smoke-tested against a live R2 bucket + real Logpush job** — the
  object layout and gzip/NDJSON handling are pinned by recorded fixtures and the
  documented Logpush-to-R2 contract; a real end-to-end smoke run is still pending.
