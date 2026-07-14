# CloudWatch (evidence adapter)

> Part of Crumbtrail's [evidence-source adapters](./evidence-sources.md) — see the overview for the OTLP dual-export vs. evidence-adapter decision guide and the GA-pending live-smoke checklist.

Query your existing **CloudWatch Logs** at incident time — no re-instrumentation,
no AWS SDK, nothing new stored. When a ticket arrives, Crumbtrail runs a **Logs
Insights** query over your configured log group(s) inside the located incident
window, normalizes each matching log line into the neutral evidence bundle, and
**stores nothing but the derived bundle**.

CloudWatch has no OTLP dual-export recipe (unlike Sentry/Splunk/Datadog); the
evidence adapter is the way to bring CloudWatch logs into a bundle.

## Setup

Set these in the Crumbtrail runtime environment (self-host). The adapter is active
only when all four required vars are present:

```bash
CRUMBTRAIL_CLOUDWATCH_ACCESS_KEY_ID=<AWS access key id>
CRUMBTRAIL_CLOUDWATCH_SECRET_ACCESS_KEY=<AWS secret access key>
CRUMBTRAIL_CLOUDWATCH_REGION=us-east-1
# Comma-separated log groups; one Logs Insights query is run per group.
CRUMBTRAIL_CLOUDWATCH_LOG_GROUPS=/aws/lambda/your-service,/ecs/your-service

# Optional — STS session token for temporary / assumed-role credentials.
CRUMBTRAIL_CLOUDWATCH_SESSION_TOKEN=
# Optional — override the Logs endpoint host (GovCloud, LocalStack, testing).
CRUMBTRAIL_CLOUDWATCH_ENDPOINT=
```

The IAM principal needs read-only Logs Insights access:
`logs:StartQuery`, `logs:GetQueryResults`, and `logs:DescribeLogGroups` (used for
the doctor health check) on the target log groups.

### Credentials

- **v1 is static keys.** Provide an access key + secret for a read-only IAM user,
  or a temporary access key + secret + `CRUMBTRAIL_CLOUDWATCH_SESSION_TOKEN` from an
  assumed role / SSO session. There is no OAuth or ambient instance-profile
  resolution in v1 — pass the keys explicitly. (Full role-assumption support is a
  future addition; the session-token field already lets you feed short-lived role
  creds today.)
- Requests are signed with **AWS Signature Version 4**, hand-rolled with Node
  `crypto` — Crumbtrail adds **no AWS SDK dependency**. The secret access key is
  used only inside the signing chain; it never appears in a header value, a log,
  a thrown message, or a bundle gap.

Verify it is wired and authenticating:

```bash
crumbtrail-server doctor
```

Doctor lists each configured evidence source, whether its cheap authenticated
no-op (a `DescribeLogGroups` call) succeeds, and its declared join keys.

## What gets fetched

For a located incident window, the adapter runs one Logs Insights query per
configured log group:

```
fields @timestamp, @message, @ptr, @logStream
| filter @message like "<requestId or traceId>"   -- only when a key is present
| sort @timestamp desc
| limit <maxItems>
```

Logs Insights is asynchronous: the adapter calls `StartQuery`, then polls
`GetQueryResults` until the query completes. The **poll loop self-limits** to a
fraction of the per-source timeout budget, keeping the newest partial result
snapshot. If a query does not finish within budget, the rows that already
completed are still returned, with an honest gap
(`cloudwatch: query did not complete within Ns …`) — never an empty timeout.
A single log group whose query fails (bad group, denied) degrades to a scoped gap
while the other groups' rows still return.

Each matching log line becomes one neutral evidence item:

- `lane: "logs"`, `kind: "cloudwatch.log"`
- `brief`: the first ~140 chars of `@message` (short)
- `ref`: `{ provider: "cloudwatch", id, url }` — a CloudWatch Logs console deep
  link to the log group, so a human can open the source. `id` is the row's `@ptr`
  (or log stream) for provenance.
- `after`: the trimmed `@message` body (redacted)
- `whenObserved`: the `@timestamp`

Bulk message text is bounded by `maxItems` / `maxBytes` and passes through the
redaction boundary before anything is retained.

## Join keys

The adapter filters best-first by the keys it actually supports:
**`requestId, traceId, time, service`**.

- With a **requestId or trace id** present, it adds a
  `filter @message like "<id>"` term — the tightest correlation Logs Insights
  offers over unstructured log text. (In Crumbtrail's correlation model the trace
  id doubles as the request id, so either narrows to the same incident.)
- Otherwise it scans the **time window only** and says so in the bundle's gaps.
- `service` scopes via the log group(s) you configure (typically one group per
  service), not a message filter.
- A requested key CloudWatch cannot use (e.g. `sessionId`, `release`, `url`,
  `user`) surfaces an honest gap rather than a silent drop — the gap doubles as
  the nudge to stamp correlation keys into your logs.

Adapter output is **neutral evidence only**; ranking and hypotheses happen once,
downstream, never in the adapter.

## Cost / egress notes

Logs Insights bills by bytes scanned. The adapter keeps this bounded: a hard
`limit` clause, `maxItems`/`maxBytes` caps, a single query per group with no
pagination walk, and a self-limiting poll budget. Narrow incident windows and a
propagated request/trace id both shrink the scan — and the honest gaps tell you
when a scan was wide because a correlation key was missing.
