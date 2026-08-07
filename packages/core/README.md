# crumbtrail-core

The capture engine behind [Crumbtrail](https://crumbtrail.ai). It records what
actually happened around a bug — the console, the network calls, the DOM
interactions, the state — and hands it over as evidence a coding agent can act on,
instead of a screenshot and a vague repro.

Framework-agnostic, with **no dependencies**.

## Install

```bash
npm install crumbtrail-core
```

Or let the wizard install and wire it for you:

```bash
npx crumbtrail
```

## Setup

Call `Crumbtrail.init()` once, at your app's entry point:

```ts
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";

Crumbtrail.init({
  ...PRESET_PASSIVE,
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: process.env.CRUMBTRAIL_KEY,
});
```

That's the whole integration — capture runs in the background from there.

### Catching the requests that beat init

`init()` usually runs from an async import, so the fetches that render the
first screen can finish before the network patch exists. Those requests leave
no `net.req` and, more importantly, no correlation header, so their backend and
database events cannot be joined to the session later.

Add one side-effect import above everything else in your entry file:

```ts
import "crumbtrail-core/early";
```

It patches `fetch` and `XMLHttpRequest` synchronously, stamps the same
correlation headers the SDK stamps on same origin requests, and parks bounded
metadata (at most 50 requests, 2 MB of body text) until `init()` drains it
through the normal redaction pipeline. `init()` adopts the session id it minted,
so the early requests, the live session, and the backend events all match. If
`init()` never runs within 60 seconds, the queue is dropped and recording stops.

### Presets

| Preset           | Behaviour                                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `PRESET_PASSIVE` | Capture continuously and auto-flag on errors and signals. The default. |
| `PRESET_LIGHT`   | Leaner capture, less overhead.                                         |
| `PRESET_FULL`    | Everything, for a heavy debugging session.                             |

### Flagging a bug yourself

`init()` returns the instance, so you can mark moments explicitly:

```ts
const crumbtrail = Crumbtrail.init({ ...PRESET_PASSIVE, httpEndpoint });

crumbtrail.mark("checkout: submitted");

await crumbtrail.flagBug({
  note: "Payment failed with no error toast",
  tags: ["checkout"],
});
```

Also on the instance: `addEvent`, `registerStateProvider`, `setEnv`,
`createRequestHeaders`, `pause`, `resume`, `stop`, `getSessionId`.

## Redaction is on by default

Crumbtrail is meant to be pointed at real traffic, so scrubbing is not opt in.
Tokens, cookies, storage values, page text, input values, and database row values
are redacted before an event enters the browser buffer. See
`BROWSER_REDACTION_POLICY` and the `redact*` helpers if you want to inspect or
tighten the policy.

### Keeping a field the classifier would otherwise drop

JSON request bodies go through a deny biased per value classifier: numbers and
short enum like strings are kept, everything else is replaced by a shape
placeholder. That is the right default and it is wrong for one specific case,
which is when the text a user submitted **is** the defect. A stored XSS payload,
a search term with a quote in it, an address line a validator wrongly rejects,
a decimal comma amount: a hash of any of those tells an agent nothing.

`redaction.keepFields` names those fields. It is matched on the whole field
name, never as a substring, and it applies to JSON keys and query string
parameters alike:

```ts
Crumbtrail.init({
  redaction: { keepFields: ["body", "q", "postalCode"] },
});
```

What a keep does and does not do:

- It overrides the **built in name heuristics** only. Those match by substring
  and have real false positives, so without an override an app whose schema
  trips one (`auth` matches `author`, `pan` matches `panel`) cannot capture the
  field at all.
- It never disables **value based detection**. An email, a JWT, a card number,
  a token, or a high entropy secret sitting in a kept field is still redacted.
- Your own `denyFields` entry still wins over your keep for the same name.

The capture server takes the same list, so a name kept in a `db.diff` row is
also kept in the request body and query string that produced it:

```bash
crumbtrail-server serve --keep-field body,q,postalCode
```

`CRUMBTRAIL_KEEP_FIELDS` sets it from the environment; flags add to it rather
than replacing it. The active list is printed at boot, because it is the one
setting that makes the server store more than it did before.

## Production capture

Page text, input values, keystrokes, clipboard content, DOM snapshots, and
database row values are masked before they enter the local ring buffer. Add
`data-crumbtrail-unmask` to one element when its text or value is safe to
capture. Add `data-crumbtrail-block` to exclude an element and its descendants
entirely.

Remote capture policy can only add masking. Clear text or values are captured
only when `data-crumbtrail-unmask` is added to that individual safe element.

For consent managed applications, begin capture only after your consent manager
grants permission:

```ts
const crumbtrail = Crumbtrail.init({
  consentMode: "required",
  configEndpoint: "https://capture.example.com/config",
  projectKey: "project_123",
});

crumbtrail.consent(true);
crumbtrail.identify({ accountId: "account_123", userId: "user_456" });
await crumbtrail.flag();
```

Global Privacy Control is respected by default. Email shaped identifiers are
discarded by `identify`.

Set `flightRecorder: true` to buffer locally until an error, signal, widget
action, or `flag()` triggers capture. The recorder adds the configured tail
before finalizing the report. A cloud config response can disable capture with
`killSwitch: true`; the SDK clears its buffer as soon as that response arrives.

### Response body summaries (`net.res`)

`net.res` keeps carrying the redacted response body as text in `d.body`. It also
carries `d.bodyMeta`, the size facts plus a bounded parsed view:
`{ ct, bytes, truncated?, data?, arrayTotal? }`. `data` is present for JSON
responses of 32 KB or less, is derived from the already redacted body, and is
capped at four levels of nesting, 20 array items, and 120 character strings.
`arrayTotal` records the real length of each array that was cut, keyed by its
path, so a truncated list is never mistaken for a short one. Anything else,
including non JSON and oversized responses, carries the content type and byte
size only.

### Content Security Policy refusals (`csp`)

A policy refusal is the quietest way for a feature to stop existing. The browser
refuses a script, a stylesheet, an image or a connection, and the page reports
nothing: no JavaScript error, because the code never ran, and no failed request,
because the request was never made. A capture built on errors and network traffic
is blind to it by construction, while the user watches a button do nothing.

The `errors` collector now listens for `securitypolicyviolation` and emits
`{ directive, disposition, blockedUri, file, line, st }`. `disposition` keeps a
report-only policy distinguishable from an enforced one, since a report-only
policy blocks nothing. The `sample` a browser may attach is a fragment of the
page's own script or style text and is never read.

### Streaming responses

`Response.text()` resolves when the stream closes, which for a streaming response
may be never. The collector used to await that before emitting `net.res`, so a
streamed request - progress updates, model tokens, a log tail, a large export -
was recorded as a request that never came back.

The response body is now read under a budget: 2 seconds, or
`networkMaxBodySize`, whichever comes first. Whatever arrived inside the budget
is captured, and `net.res` carries `streaming: true` when the body had not
finished. The event is timestamped when the response ARRIVED rather than when its
body ended, so a long stream cannot push its own event past the effects it
caused.

### Worker traffic (`worker.msg`)

The `workers` collector is **on by default**. A worker is a second program with
its own global scope: nothing this SDK patches exists inside it, so a `fetch`
made there is not recorded and an error thrown there never reaches the page's
handlers. Applications put parsing, pricing, sync and offline queues in workers,
so a capture that says nothing about them can be silent about the whole
computation that produced a wrong answer.

What is observable from the window is the conversation. The collector wraps the
`Worker` constructor and emits `{ id, script, op }` for `start`, for `error`
(with the message the page never saw), and for each message as `op: "post"` and
`op: "recv"` with a redacted `body` and a `seq` number. Messages answer to the
same structured redaction as request bodies. A payload that is not text-shaped -
a transferred buffer, a port - reports `opaque: true` rather than an invented
summary.

Bounded like socket frames: 2 KB per message, 40 messages per worker, 200 across
the session.

### Form-shaped request bodies

`fetch(url, { body: new URLSearchParams(form) })` and `body: new FormData(form)`
are how a form submission is normally written, and both used to be discarded
whole as non-text. Every field the user filled in went missing from the capture
because of the container it arrived in.

Both are now read without consuming them, and the same body redaction runs over
the result. A `FormData` is rendered as a JSON object keyed by field name, so a
repeated field becomes an array. File parts are described, never read: the form
field name survives as the key and the part reports `{ file: true, bytes }`. The
file's own name and MIME type are free text and answer to the same value rules as
any other string in a body.

### GraphQL operation identity (`net.req d.gql`)

Every GraphQL request in an application goes to the same URL, so a record keyed
on method and path reports one endpoint doing everything. When a request body
parses as GraphQL, `net.req` carries `d.gql` with `op` (`query`, `mutation`,
`subscription`, or `unknown` for a persisted query that sent no document),
`name` when the document or the request names one, and `batch` when the request
carried several operations.

Only the operation name and type are read. Both are code, identical for every
user. Variables are never inspected here: they carry user input, and the body
redaction that runs over them is the only thing entitled to decide what
survives.

### Server-sent events (`net.sse`)

The `eventSource` collector wraps the `EventSource` constructor and emits
`{ url, op }` for open, error, and close, with `count` (messages received so
far) on error and close, and `reopen: true` when a stream to the same URL is
recreated within 30 seconds of the last failure. That makes a stream which
quietly drops and reconnects visible while the page shows stale data. Message
payloads are never read.

### WebSocket traffic (`net.ws`)

The `webSocket` collector is **on by default**. It wraps the `WebSocket`
constructor and emits `{ id, url, op }` for open, error, and close, with
`received` and `sent` counts plus the close `code` and `clean` flag, and
`reopen: true` when a socket to the same URL is recreated within 30 seconds of
the last failure.

It also carries the frames themselves, in both directions, as `op: "send"` and
`op: "msg"` with a redacted `body` and a `seq` number. Frames answer to the same
structured redaction policy as request and response bodies, including your own
`denyFields` and `keepFields`, so a socket publishes no class of value your HTTP
traffic does not. Binary frames report `binary: true` and a byte count only,
never content.

Three bounds keep a chatty socket from filling a session: 2 KB per frame, 40
frames per socket, and 200 frames across the session. Past a cap the socket keeps
counting and stops quoting, so the close event still reports the true totals.

### Listener accounting (`ui.listeners`)

The `listeners` collector is **on by default** and disabled by `PRESET_LIGHT`.
It patches `addEventListener` and `removeEventListener` to keep a running count
per event type, and emits `{ total, byType, url }` on every navigation and
whenever the total grows by 25 since the last reading. That makes a view which
re-subscribes on every render and never unsubscribes visible before it starts
firing handlers twice. It stores counts only, never a target or a listener, and
only sees registrations made after `init()`.

### On-screen numbers (`ui.num`)

The `uiNumbers` collector is **on by default**. It scans the visible DOM for
labeled numeric tokens — a number paired with its nearby text label, e.g.
`Subtotal: $84.00` — and emits compact `ui.num` snapshots of `{label, value,
unit}`. These power the display-arithmetic detector (subtotal + tax vs total)
and the UI-vs-API divergence detector. It never captures raw DOM or HTML, only
the short label and the parsed number.

This means numeric amounts shown on screen are captured together with their
labels. Labels run through the redaction classifier, so PII-shaped labels
(emails, tokens) and card-number-shaped values are dropped entirely. The honest
residual: a label that is itself a human name reads as ordinary free text and
can survive capture, so the case to think about is numbers rendered next to
names — payroll, CRM rows, admin tables (`Jane Doe  $84,000`).

Opting out, narrowest first:

- Add the sensitive label to `redaction.denyFields` to drop just those items.
- Use `PRESET_LIGHT`, which disables the collector.
- Disable it entirely with `uiNumbers: false` in `Crumbtrail.init({...})`.

Hidden elements (`hidden`, `aria-hidden="true"`, `display:none`,
`visibility:hidden`) are already skipped.

Each `ui.num` snapshot carries the document `lang` and `dir`, and the same
collector emits one `ui.layout` event per navigation with
`{ dir, lang, scrollW, clientW, overflowX, url }`. Together they make a
locale-vs-rendered-number contradiction, and horizontal overflow from a long
translated label, joinable without capturing any DOM.

## Related packages

| Package                                                                            | Use it for                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`crumbtrail`](https://www.npmjs.com/package/crumbtrail)                           | The `npx crumbtrail` setup wizard                          |
| [`crumbtrail-node`](https://www.npmjs.com/package/crumbtrail-node)                 | Self-hosted server, Express middleware, MCP evidence tools |
| [`crumbtrail-react`](https://www.npmjs.com/package/crumbtrail-react)               | React error boundary and state-capture hook                |
| [`crumbtrail-react-native`](https://www.npmjs.com/package/crumbtrail-react-native) | React Native bindings                                      |
| [`crumbtrail-tauri`](https://www.npmjs.com/package/crumbtrail-tauri)               | Tauri desktop bindings                                     |

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
