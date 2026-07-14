# PostHog (evidence adapter)

> Part of Crumbtrail's [evidence-source adapters](./evidence-sources.md) — see the overview for the OTLP dual-export vs. evidence-adapter decision guide and the GA-pending live-smoke checklist.

Crumbtrail reads your existing PostHog at ticket time — no re-instrumentation,
nothing new stored. This is a **query-at-incident-time pull**: when a ticket
arrives, Crumbtrail queries the **Events** REST API (primary) and the
**Session-Recordings** list API (secondary) inside the located incident window,
normalizes each record into the neutral evidence bundle, and **stores nothing but
the derived bundle**.

Session recordings are **linked by reference only** — Crumbtrail never downloads,
transcodes, or stores recording content. The value of a recording item is its
replay-player deep link.

## Setup

Set these in the Crumbtrail runtime environment (self-host). The adapter is active
only when both required values are present:

```bash
CRUMBTRAIL_POSTHOG_API_KEY=<personal API key>
CRUMBTRAIL_POSTHOG_PROJECT_ID=<project id>
# Optional — your PostHog host. Default https://us.posthog.com.
# Use https://eu.posthog.com (EU cloud) or your self-hosted origin otherwise.
CRUMBTRAIL_POSTHOG_HOST=https://us.posthog.com
```

Use a **personal API key** (`Authorization: Bearer <key>`) with read access to
the project's events and session recordings. Verify it is wired and
authenticating:

```bash
crumbtrail-server doctor
```

Doctor lists each configured evidence source, whether its cheap authenticated
no-op (a project-endpoint GET) succeeds, and its declared join keys.

## What gets fetched

For a located incident window, the adapter builds one filter set from the
correlation keys it knows and sends it to both APIs, scoped to the window:

- **Events** — `GET /api/projects/{id}/events/` with `after`/`before` (the
  window), `distinct_id` (the user), a `properties` filter for `$session_id`
  and/or `$current_url`, and `limit` (= `maxItems`, so there is no pagination
  walk).
- **Session recordings** — `GET /api/projects/{id}/session_recordings/` with
  `date_from`/`date_to`, `distinct_id`, and `session_ids` when a session id is
  known. This lists recordings only; **no snapshot/content blob is ever read.**

**Two-API resilience**: events are the **primary** evidence, fetched with the
bounded retry. The recordings list is a **secondary** fetch run best-effort inside
a sub-budget carved from the per-source timeout. If it is slow, fails, or is
aborted, the event items still ship, with an honest gap (`posthog:
session-recordings list did not complete within budget …`). One API's slowness
never drops the other API's items.

Each record becomes one neutral evidence item:

- An **event** → `lane: "browser"` (or `lane: "flow"` for `$pageview` /
  `$pageleave` navigation events), `kind: "posthog.event"`, `brief`: the event
  name plus `$current_url` when present, `after`: a trimmed set of scalar props
  (redacted), `whenObserved`: the event timestamp, `ref.url`: a person-page deep
  link (`/project/{id}/person/{distinctId}`) when the distinct id is known, else
  the project activity explorer.
- A **session recording** → `lane: "flow"`, `kind: "posthog.recording"`,
  `brief`: `session recording <id> (<duration>)`, `whenObserved`: the recording
  start, `ref.url`: the replay-player deep link
  (`/project/{id}/replay/{recordingId}`). `before`/`after` are always **null** —
  no recording content is fetched or stored.

Bulk text is bounded by `maxItems` / `maxBytes` and passes through the redaction
boundary before anything is retained.

## Join keys

The adapter filters best-first by the keys it actually supports:
**`user, sessionId, url, time`**.

- **`user`** becomes the `distinct_id` filter on both the events and recordings
  requests — the tightest correlation over a person's activity.
- **`sessionId`** becomes a `$session_id` event-property filter **and** the
  recordings `session_ids` filter.
- **`url`** becomes a `$current_url` event-property filter.
- **`time`** is always applied via the request window.
- Otherwise it scans the time window only and says so in the bundle's gaps.
- A requested key PostHog cannot use (e.g. `traceId`, `requestId`, `release`,
  `service`) surfaces an honest gap rather than a silent drop.

Adapter output is **neutral evidence only**; ranking and hypotheses happen once,
downstream, never in the adapter. The personal API key lives only in the
`Authorization` request header — never in a gap, stat, log, or thrown message.
