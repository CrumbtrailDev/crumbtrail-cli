# Splunk (evidence adapter)

> Part of Crumbtrail's [evidence-source adapters](./evidence-sources.md) — see the overview for the OTLP dual-export vs. evidence-adapter decision guide and the GA-pending live-smoke checklist.
>
> This is a **separate concept** from [splunk.md](./splunk.md), which documents
> streaming Splunk Observability Cloud telemetry to Crumbtrail via OTLP
> dual-export. That recipe file is generated from
> `packages/node/src/provider-recipes.ts` and kept in lockstep by
> `scripts/verify-integration-docs.mjs` — it does not carry evidence-adapter
> content, so this file exists on its own to avoid being overwritten by that
> generator. Pick whichever fits; they coexist.

Crumbtrail reads your existing Splunk at ticket time — no re-instrumentation,
nothing new stored. This is a **query-at-incident-time pull**: when a ticket
arrives, Crumbtrail dispatches one bounded SPL search over your configured
index(es) inside the located incident window, normalizes each matching event
into the neutral evidence bundle, and **stores nothing but the derived bundle**.

## Setup

Set these in the Crumbtrail runtime environment (self-host). The adapter is active
only when all three required vars are present:

```bash
# Search-head base URL, including the management port (usually 8089).
CRUMBTRAIL_SPLUNK_HOST=https://splunk.example.com:8089
# A Splunk authentication (JWT) token — Settings > Tokens, or the
# authorization/tokens endpoint. Sent as `Authorization: Bearer <token>`.
CRUMBTRAIL_SPLUNK_TOKEN=<token>
# Comma-separated indexes the search is allowed to scan.
CRUMBTRAIL_SPLUNK_INDEX=main,app

# Optional — web UI base for deep links. Derived from the host if unset
# (the :8089 mgmt port is swapped for the :8000 default web port).
CRUMBTRAIL_SPLUNK_WEB_URL=https://splunk.example.com:8000
```

The token's role needs read access to `search` and the target indexes. Verify it
is wired and authenticating:

```bash
crumbtrail-server doctor
```

Doctor lists each configured evidence source, whether its cheap authenticated
no-op (a `server/info` call) succeeds, and its declared join keys.

## What gets fetched

For a located incident window, the adapter builds SPL like:

```
search (index="main" OR index="app") earliest=<epoch> latest=<epoch>
  "<traceId or requestId>"   -- only when a correlation key is present
  service="<service>"        -- only when a service key is present
```

A Splunk search is asynchronous: the adapter dispatches a job
(`POST /services/search/v2/jobs`), then polls `results_preview`. The **poll loop
self-limits** to a fraction of the per-source timeout (80%), keeping the newest
partial preview snapshot. If the search does not finish within budget, the rows
Splunk had already previewed are still returned, with an honest gap
(`splunk: search did not complete within Ns …`) — never an empty timeout.

Each matching event becomes one neutral evidence item:

- `lane: "logs"`, `kind: "splunk.event"`
- `brief`: the first ~140 chars of `_raw` (short)
- `ref`: `{ provider: "splunk", id, url }` — a Splunk **search-app deep link** that
  reproduces the SPL + time range, so a human lands on the search where the event
  lives. `id` is the event's `_cd` for provenance.
- `after`: the trimmed `_raw` body (redacted)
- `whenObserved`: the event `_time`

Bulk text is bounded by `maxItems` / `maxBytes` (the SPL `count` caps the job so
there is no pagination walk) and passes through the redaction boundary before
anything is retained.

## Join keys

The adapter filters best-first by the keys it actually supports:
**`traceId, requestId, time, service`**.

- A **trace id or request id** (they double for each other in Crumbtrail's
  correlation model) is added as a quoted SPL term — the tightest filter over raw
  events.
- **`service`** is applied as a `service="<value>"` field filter (never a silent
  no-op).
- **`time`** is always applied via `earliest`/`latest`.
- Otherwise it scans the time window only and says so in the bundle's gaps.
- A requested key Splunk cannot use (e.g. `sessionId`, `release`, `url`, `user`)
  surfaces an honest gap rather than a silent drop — the gap doubles as the nudge
  to stamp correlation keys into your events.

Adapter output is **neutral evidence only**; ranking and hypotheses happen once,
downstream, never in the adapter. The token lives only in the `Authorization`
header — never in a gap, stat, log, or thrown message.
