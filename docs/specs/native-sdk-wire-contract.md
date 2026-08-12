# Native SDK wire contract

Normative contract for any Crumbtrail SDK that is **not** built on
`crumbtrail-core`: the Swift, Kotlin and Dart SDKs, and anything added later.

`crumbtrail-core` is the reference implementation. Where this document and core
disagree, core is right and this document is a bug. The machine readable form of
everything below lives in
[`test-fixtures/wire-contract/`](../../test-fixtures/wire-contract), and every
native SDK has a conformance test that serialises its own types and compares
against those fixtures byte for byte.

## Why this exists

Three SDKs written in three languages against a prose description will drift:
one spells a field `sdkVersion`, another omits `schemaVersion`, a third sends
seconds where core sends milliseconds. Ingest accepts all of it, because the
envelope is deliberately permissive for forward compatibility, and the loss only
becomes visible later as sessions that cannot be correlated and evidence that
cannot be joined. Fixtures turn that silent drift into a failing test.

## Transport

All requests are `POST`. `{endpoint}` is the configured base URL with trailing
slashes stripped.

| Path | Body | When |
| --- | --- | --- |
| `/api/session/start` | `{ sessionId, metadata }` | Once, when the session opens |
| `/api/events` | `{ sessionId, events }` | Per batch |
| `/api/session/end` | `{ sessionId }` | Once, when the session closes |

Headers on every request:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Crumbtrail-Auth` | The ingest key. Omit the header entirely when no key is configured — never send an empty string. |

The key is an **ingest** key (`ctkey_`). It is write only by design. A native SDK
must never use it to read, and must never ship it in a form that is recoverable
from the built artifact beyond what shipping the app inherently exposes.

### Failure handling

A non-2xx response is **not** a delivery. `fetch`-style APIs resolve for 4xx and
5xx alike, so an SDK that only catches thrown errors will treat "payload too
large" and "rate limited" as success, drop the batch, and produce a session
indistinguishable from one where nothing happened.

Every SDK must distinguish three outcomes and record the third:

1. **2xx** — delivered.
2. **Network failure** — the request produced no response. Retry per the
   SDK's queue policy.
3. **Non-2xx** — the server refused. Do not retry the identical batch; surface
   it as a capture gap so the missing window is declared rather than implied.

## Event envelope

One event is a JSON object. Field names are short because a session is thousands
of them.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `t` | integer | yes | Unix timestamp in **milliseconds**. Not seconds. |
| `k` | string | yes | Event kind (see below) |
| `d` | object | yes | Kind specific payload. May be empty, never null. |
| `schemaVersion` | integer | no | Currently `1`. Absent means 1. Native SDKs **must** send it. |
| `platform` | string | no | `web`, `react-native`, `ios`, `android`, `flutter`, `webview`, `node`. Absent means `web`. Native SDKs **must** send it. |
| `sdk` | object | no | `{ name, version }`. Native SDKs **must** send both. |
| `capabilities` | string[] | no | Capability names this SDK has active |
| `target` | object | no | Normalised UI target (see below) |
| `sessionId` | string | no | Only when an extension workflow session owns the event |
| `offsetMs` | integer | no | Milliseconds since the session's canonical start |

`platform` reports the **concrete OS** wherever the SDK can know it. A hybrid
SDK running in a WebView reports `ios` or `android`, not `webview`, and falls
back to `webview` only when the host platform is genuinely unknown. Filtering a
session to one OS is load bearing: the two mobile WebViews disagree about
storage eviction, back navigation and media autoplay, and a large share of
hybrid bugs live on exactly one of them.

### Event kinds

Kinds are open, but these are the shared ones. An SDK that invents a kind
outside this list gets no cross platform treatment on the ingest side.

| `k` | Meaning | Common `d` keys |
| --- | --- | --- |
| `err` | An error or crash | `msg`, `stk`, `fatal`, `source` |
| `rej` | An unhandled async failure | `msg`, `stk`, `source` |
| `con` | A console/log line | `lv` (`log`/`warn`/`err`/`dbg`/`info`), `args` |
| `net` | A completed request | `url`, `method`, `status`, `ok`, `dur`, `source` |
| `net-status` | Connectivity state or change | `connected`, `type`, `kind` |
| `env` | Environment snapshot | `kind`, `device`, `app`, `battery`, `locale` |
| `navigation` | A screen or route change | `name`, `path`, `key`, `url`, `source` |
| `nav-intent` | A navigation the user asked for | `action`, `source` |
| `app-lifecycle` | Foreground/background transitions | `state`, `source`, `kind` |
| `native-crash` | A native crash captured on next launch | `msg`, `stk`, `signal`, `source` |
| `view-snapshot` | A view tree snapshot | `nodes`, `w`, `h` |

`err` carries `fatal: true` only for a failure that actually terminated the
process. A caught and reported exception is `fatal: false`.

### Target descriptor

Optional, on events that refer to a UI element. At least one identifying key
must be present, or omit `target` entirely.

Identifying keys: `role`, `label`, `testID`, `accessibilityId`,
`componentName`, `routePath`, `ancestryHash`. Also allowed: `bounds`
(`{x, y, width, height}`), `redaction`.

Do not send the deprecated `testId`, `accessibilityLabel` or `accessibilityText`
spellings. They exist only so legacy web emitters keep working.

## Session

### Identity

A session id is minted by the SDK, is opaque to the server, and must be stable
across a cold start within the idle window.

Persistence must survive an app restart and an OS storage reclaim:

| Platform | Store | Not this |
| --- | --- | --- |
| iOS native | `UserDefaults` | — |
| Android native | `SharedPreferences` | — |
| Flutter | `SharedPreferences` via the platform channel | — |
| Capacitor / hybrid | `@capacitor/preferences` | WebView `localStorage`, which iOS can evict |

### Expiry

A persisted session is resumed **only** when it is still fresh:

```
resume if (now - lastActivity) <= idleMs, otherwise mint a new id
```

This is not optional and it is not "resume forever". Resuming an ancient session
stitches today's bug onto last week's timeline; never resuming turns a user's
week of intermittent reports into unrelated single event sessions. `lastActivity`
is rewritten on activity, in the same millisecond unit as `t`.

### Metadata

`/api/session/start` carries `metadata`. Core sends `url`, `ua`, and `service`
when configured, plus any identity fields. A native SDK has no URL or user
agent, so it sends what it does have:

| Key | Value |
| --- | --- |
| `service` | The configured service name, when set |
| `platform` | Same value as the event `platform` field |
| `app` | `{ id, version, build }` |
| `device` | `{ model, manufacturer, os, osVersion }` |

Omit any key whose value is unknown. Do not send empty strings as placeholders:
an absent field and a field that is present but blank mean different things on
the ingest side, and only one of them is honest.

## Redaction

A native SDK inherits the same obligation as core: **capture must never be the
reason a secret leaves the device.**

- Never send request or response bodies by default.
- Never send `Authorization`, `Cookie`, `Set-Cookie`, or any header whose
  compacted name contains `token`, `secret`, `key`, `password`, or `auth`.
- Strip credentials, and query values that look like credentials, from any URL
  before it goes in `d.url`.
- Never record keystrokes or input values.

When in doubt, drop the value and keep the shape. An agent can act on
"a 402 on POST /checkout with a redacted body"; it cannot act on a leaked card
number, and neither can you once it is in ingest.

## Conformance

Each native SDK ships a test that builds one event of each kind it emits,
serialises it, and asserts it equals the corresponding fixture in
`test-fixtures/wire-contract/events/`. Changing a fixture is therefore a
deliberate, reviewable act that fails every SDK at once, which is the point.
