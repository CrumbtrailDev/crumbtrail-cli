# Sentry (evidence adapter)

> Part of Crumbtrail's [evidence-source adapters](./evidence-sources.md) — see the overview for the OTLP dual-export vs. evidence-adapter decision guide and the GA-pending live-smoke checklist.
>
> This is a **separate concept** from [sentry.md](./sentry.md), which documents
> streaming Sentry traces to Crumbtrail via OTLP dual-export. That recipe file is
> generated from `packages/node/src/provider-recipes.ts` and kept in lockstep by
> `scripts/verify-integration-docs.mjs` — it does not carry evidence-adapter
> content, so this file exists on its own to avoid being overwritten by that
> generator. Pick whichever fits; they coexist.

Crumbtrail reads your existing Sentry org at ticket time — no re-instrumentation,
nothing new stored. This is a **query-at-incident-time pull**: when a ticket
arrives, Crumbtrail queries the **issues** list API (primary) and enriches each
issue with its **latest event** (secondary, best-effort) for a trimmed stack
head, normalizes each into the neutral evidence bundle, and **stores nothing but
the derived bundle**.

## Setup

Set these in the Crumbtrail runtime environment (self-host). The adapter is active
only when both required vars are present:

```bash
CRUMBTRAIL_SENTRY_AUTH_TOKEN=<sentry auth token, org:read + event:read>
CRUMBTRAIL_SENTRY_ORG=<your-org-slug>
# Optional — self-hosted Sentry; defaults to https://sentry.io
CRUMBTRAIL_SENTRY_HOST=https://sentry.io
```

The token is read only from the environment, never passed as a tool argument or
logged; it lives solely in the outbound `Authorization: Bearer` header.

Verify it is wired and authenticating:

```bash
crumbtrail-server doctor
```

Doctor lists each configured evidence source, whether its cheap authenticated
no-op (a GET on the org endpoint) succeeds, and its declared join keys.

## What gets fetched

For a located incident window, the adapter calls
`GET /api/0/organizations/{org}/issues/` filtered by that window (`start`/`end`,
mutually exclusive with `statsPeriod`, so `statsPeriod` is never sent alongside
them), capped by `limit` (= `maxItems`, so there is no pagination walk).

Primary evidence is emitted from that issues list; enrichment is best-effort and
never gates primary items. Each returned issue is (optionally) enriched with its
latest event via `GET /issues/{id}/events/latest/` for a crash-first stack head.
This enrichment fans out with capped concurrency (5 in flight) inside a
sub-budget carved from the per-source timeout (half the budget); if it is slow,
fails, or is aborted, the issues still return (with `after: null` and an honest
gap) rather than being dropped as a timeout. Each Sentry issue becomes one
neutral evidence item:

- `lane: "logs"`, `kind: "sentry.error"`
- `brief`: `"<title> — <culprit>"` (short)
- `ref`: `{ provider: "sentry", id, url }` — the Sentry issue permalink, so a
  human can open the source.
- `after`: the crash-first stack head, up to 6 frames (redacted)
- `whenObserved`: the latest event's timestamp, else the issue's `lastSeen`

## Join keys

The adapter filters best-first by the keys it actually supports:
**`traceId, time, release, url, user`**.

- With a **trace id** present (W3C traceparent propagated end-to-end), it uses a
  single `trace:<id>` search token — the tightest match, superseding all other
  tokens.
- Otherwise it combines `url:` / `release:` / `user.email:` tokens for whichever
  of those keys the ticket carries, always inside the time window.
- If none of those are available, it filters by the **time window only** and
  says so in the bundle's gaps. A requested key Sentry cannot use (e.g.
  `requestId`, `sessionId`, `service`) also surfaces an honest gap rather than a
  silent drop — the gap doubles as the nudge to stamp correlation keys.

Adapter output is **neutral evidence only**; ranking and hypotheses happen once,
downstream, never in the adapter.
