# Datadog (evidence adapter)

> Part of Crumbtrail's [evidence-source adapters](./evidence-sources.md) — see the overview for the OTLP dual-export vs. evidence-adapter decision guide and the GA-pending live-smoke checklist.
>
> This is a **separate concept** from [datadog.md](./datadog.md), which
> documents streaming Datadog telemetry to Crumbtrail via OTLP dual-export. That
> recipe file is generated from `packages/node/src/provider-recipes.ts` and kept
> in lockstep by `scripts/verify-integration-docs.mjs` — it does not carry
> evidence-adapter content, so this file exists on its own to avoid being
> overwritten by that generator. Pick whichever fits; they coexist.

Crumbtrail reads your existing Datadog at ticket time — no re-instrumentation,
nothing new stored. This is a **query-at-incident-time pull**: when a ticket
arrives, Crumbtrail queries the **Logs Search v2** API (primary) and the
**Spans Search v2** API (secondary) inside the located incident window,
normalizes each record into the neutral evidence bundle, and **stores nothing
but the derived bundle**.

## Setup

Set these in the Crumbtrail runtime environment (self-host). The adapter is active
only when both required keys are present:

```bash
CRUMBTRAIL_DATADOG_API_KEY=<api key>
CRUMBTRAIL_DATADOG_APP_KEY=<application key>
# Optional — your Datadog site. Default datadoghq.com. Use datadoghq.eu,
# us3.datadoghq.com, us5.datadoghq.com, ap1.datadoghq.com, etc. for other regions.
CRUMBTRAIL_DATADOG_SITE=datadoghq.com
```

The application key needs `logs_read_data` and `apm_read` scopes. Verify it is
wired and authenticating:

```bash
crumbtrail-server doctor
```

Doctor lists each configured evidence source, whether its cheap authenticated
no-op (an `api/v1/validate` call) succeeds, and its declared join keys.

## What gets fetched

For a located incident window, the adapter builds one query string, e.g.:

```
@trace_id:<traceId> service:<service> @http.url:"<url>"
```

and sends it to both search APIs, scoped to the window (`filter.from`/`filter.to`,
epoch milliseconds as strings).

**Two-API resilience**: logs are the **primary** evidence, fetched with the
bounded retry. Spans are a **secondary** fetch run best-effort inside a
sub-budget carved from the per-source timeout (half the budget). If the span
search is slow, fails, or is aborted, the log items still ship, with an honest
gap (`datadog: span search did not complete within budget …`). One API's
slowness never drops the other API's items.

Each record becomes one neutral evidence item:

- A **log** → `lane: "logs"`, `kind: "datadog.log"`, `brief`: first ~140 chars of
  the message, `after`: the trimmed message (redacted), `whenObserved`: the log
  timestamp, `ref.url`: a Log Explorer deep link focused on the event id + window.
- A **span** → `lane: "network"`, `kind: "datadog.span"`, `brief`:
  `<resource> (<duration>ms)`, `whenObserved`: the span start, `ref.url`: an APM
  trace/span deep link (`/apm/trace/<traceId>?spanID=<id>`) where a trace id is
  present, else the traces list.

Bulk text is bounded by `maxItems` / `maxBytes` (the `page.limit` caps each search
so there is no pagination walk) and passes through the redaction boundary before
anything is retained.

## Join keys

The adapter filters best-first by the keys it actually supports:
**`traceId, time, service, url`**.

- A **trace id** becomes `@trace_id:<id>` — the tightest correlation.
- **`service`** becomes `service:<value>`; **`url`** becomes `@http.url:<value>`
  (both genuinely applied — never a silent no-op).
- **`time`** is always applied via the search window.
- Otherwise it scans the time window only and says so in the bundle's gaps.
- A requested key Datadog cannot use (e.g. `requestId`, `sessionId`, `release`,
  `user`) surfaces an honest gap rather than a silent drop.

Adapter output is **neutral evidence only**; ranking and hypotheses happen once,
downstream, never in the adapter. The API/app keys live only in the request
headers — never in a gap, stat, log, or thrown message.
