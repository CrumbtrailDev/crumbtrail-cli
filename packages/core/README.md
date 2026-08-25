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
  remoteConfig: true,
  // Backend origins this app calls. Leave it out only if your API is served
  // from the same origin as the page. See below.
  networkCorrelationAllowedOrigins: ["https://api.example.com"],
});
```

That's the whole integration — capture runs in the background from there.

### Joining a backend on another origin

Crumbtrail joins a frontend session to its backend requests by stamping three
headers on outbound calls: `X-Crumbtrail-Session-Id`, `X-Crumbtrail-Request-Id`
and W3C `traceparent`. Same origin calls are stamped automatically. Cross origin
calls are stamped only when you list the backend origin:

```ts
Crumbtrail.init({
  ...PRESET_PASSIVE,
  networkCorrelationAllowedOrigins: [
    "https://api.example.com",
    "http://localhost:4000",
  ],
});
```

The default is an empty list, which means an app whose API lives on another host
or port captures frontend evidence and backend evidence that never join: the
session shows the failing click, the backend shows the failing request, and
nothing connects them. If your frontend and API are separate services, this
setting is required, not optional.

The default is empty on purpose. Stamping every outbound request would send
trace context to third party APIs the app happens to call, and would add a CORS
preflight to requests that had none, so the origins are yours to name. The
literal `"self"` is accepted as a stand in for the page's own origin.

When a request would have been stamped but its origin is not listed, the SDK
prints one `console.info` line naming that origin, once per origin per page, so
a missing entry is visible in the browser console rather than silent.

Your backend must also let the three headers through CORS, with
`Access-Control-Allow-Headers` covering `x-crumbtrail-session-id`,
`x-crumbtrail-request-id` and `traceparent`.

### Leaving the page

In a browser, `pagehide` and `visibilitychange` close the current session when
the page is closed, navigated away from, or sent to the background. Final event
batches are delivered with a lifecycle safe request. A page entering the back
forward cache keeps its session open, so returning to it does not lose the rest
of the visit. A page that was already closed and then becomes visible again
starts a new session. Set `endOnPageHide: false` only when your application
owns session boundaries and will call `stop()` itself.

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

`createRequestHeaders()` is for a transport Crumbtrail does not patch, such as a
WebSocket frame, a server action, or a queue message. It returns the session
header, the request id header, and a `traceparent`, exactly what the automatic
fetch and XHR paths stamp, so a request you stamp yourself joins the same
backend evidence as one Crumbtrail stamped. Pass your own request id only if you
already have one to keep.

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
name, never as a substring, and it applies to JSON keys, query string
parameters and form input values alike:

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
- On a **form input** it is matched against the field's `name`, and a
  `password`, `email` or `tel` input is never kept whatever it is called.

The capture server takes the same list, so a name kept in a `db.diff` row is
also kept in the request body and query string that produced it:

```bash
crumbtrail-server serve --keep-field body,q,postalCode
```

`CRUMBTRAIL_KEEP_FIELDS` sets it from the environment; flags add to it rather
than replacing it. The active list is printed at boot, because it is the one
setting that makes the server store more than it did before.

## Production capture

Page text, keystrokes, clipboard content, DOM snapshots, and database row values
are masked before they enter the local ring buffer. Add `data-crumbtrail-unmask`
to one element when its text or value is safe to capture. Add
`data-crumbtrail-block` to exclude an element and its descendants entirely.

**Input values** answer to the redaction policy rather than to a blanket mask, so
they behave the same way the same value does in a request body: numbers and short
enum-like strings are recorded, and free prose, emails, JWTs, card numbers, IBANs
and high-entropy strings are replaced by `[REDACTED]`. A `password`, `email` or
`tel` input is redacted on its type before anything reads it. `redaction.keepFields`
recovers free text in a field you name.

This is why the price a shopper typed and the price the request carried can both
appear in one capture, which is the whole of a large class of filter and validation
defects.

To record none of it, set `redaction: { captureInputValues: false }`. Every input
becomes `[REDACTED]` whatever the field is called, and `keepFields` cannot bring one
back. Operators can enforce the same thing at the capture server with
`crumbtrail-server serve --no-input-values` or `CRUMBTRAIL_CAPTURE_INPUT_VALUES=0`,
which overrides whatever the application asked for — the switch only ever removes.

Remote capture policy can only add masking. Clear text or values are captured
only when `data-crumbtrail-unmask` is added to that individual safe element.

For consent managed applications, begin capture only after your consent manager
grants permission:

```ts
const crumbtrail = Crumbtrail.init({
  consentMode: "required",
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,
  remoteConfig: true,
});

crumbtrail.consent(true);
crumbtrail.identify({ accountId: "account_123", userId: "user_456" });
await crumbtrail.flag();
```

Global Privacy Control is respected by default. Email shaped identifiers are
discarded by `identify`.

`remoteConfig: true` is what makes the project's capture settings reach the
running app. With it on, the SDK polls `/api/capture-config` on `httpEndpoint`
using the ingest key it already holds, and the auto flag triggers, flight
recorder tail, baseline sampling, consent mode, masking mode, session replay and
live probes are taken from the project rather than from this call. Those reach
an app on that poll and on no other path. The kill switch, the per project
capture budgets, row value redaction and the refusal of a replay write from a
project that has not opted in are enforced at ingest as well, so they take
effect on the next upload whatever the client is running. It is off by default,
and every install path the `crumbtrail` installer writes turns it on. The poll is fail closed: capture waits for the first policy
response, so do not turn it on against a host that does not serve the route.
Point `configEndpoint` somewhere else only for a self hosted config service.

Set `flightRecorder: true` to buffer locally until an error, signal, widget
action, or `flag()` triggers capture. The recorder adds the configured tail
before finalizing the report. A cloud config response can disable capture with
`killSwitch: true`; the SDK clears its buffer as soon as that response arrives.

### Live probes

A capture config response can also name probes to run, under a `probes` field. A probe answers one
question about the running application and rests its answer as a `probe.result` event, so an agent
reading the session afterwards sees what the app actually looked like at that moment rather than
what the code implies it looked like. Four probes exist and the server can name nothing else:
`runtime.env`, `storage.snapshot`, `network.inflight` and `flags.current`.

The whole of what a server may say is a name. Probes take no selector, no URL, no path and no
expression, so no value from a config response reaches probe code, and one entry shaped as an object
rather than a string refuses the entire field rather than being salvaged. A name outside the four is
dropped without normalization. At most four probes run per poll, repeats are collapsed, and a list
longer than 64 entries is refused before it is read.

They run one at a time, only after the remote policy has been applied, and each gets its own
deadline: 2 seconds, 200 rows and 32 KB of serialized rows by default. A probe that hangs is
abandoned at the deadline. A kill switch, a `stop()` or a newer poll ends the run between probes. A
probe never throws: a failure rests as a `probe.result` carrying `ok: false` and a short reason,
because "this source was not available in production" is itself an answer. Values pass through the
same redaction the rest of capture uses.

A probe is answered by whichever application instance is polling when the request goes out. That is
not the session an agent is investigating, and by the time a bundle is being read that session has
ended, so a probe reports on a bystander rather than on the person who hit the defect. Read every
reading as "the app looks like this right now", never as "the failing session looked like this".

`storage.snapshot` is the reading where that distinction changes what is emitted, so its keys get a
stricter treatment than the ordinary storage capture uses. It reports which keys exist, how many,
what pattern each follows and how many bytes each holds. It does not report any stored value, which
is replaced unconditionally, and it does not report the identifying part of a key: an email address,
a user id, an order number, a phone number or any other span that could carry a value is replaced
with `*`, so `session:alice@example.com:cart` is reported as `session:*:cart`. A key from which no
ordinary word survives is reported as `[REDACTED_KEY]`. A plain word in a key is kept, which is what
makes two patterns tellable apart, so a key that spells out a person's name in ordinary letters is
the one case this cannot catch.

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
per event type, and emits `{ total, byType, churnByType, stk, url }` on every
navigation and whenever the total grows by 25 since the last reading. That makes
a view which re-subscribes on every render and never unsubscribes visible before
it starts firing handlers twice. It only sees registrations made after `init()`.

`byType` is the LIVE count per event type. `churnByType` carries the cumulative
registrations and removals for the same types, in the same order, because the
live count alone cannot tell "registered and never removed" from "registered
faster than removed" — both leave the same rising curve, and a consumer that
reads only the curve and states which one happened is stating something nothing
observed. A reading without `churnByType` means those counters were not
captured, which is not the same as no removals.

`stk` carries a **bounded number of registration call stacks** — where in the
application a listener was registered — in the same shape and under the same
redaction as a request's `stk`. This is stack text, so it is application file
paths, line numbers and function names: a new data class on this event, and the
only thing here that is not a count. It is still never a target, never a
listener, and never the listener's own code. Four bounds keep it small: only the
first registration per (target kind, event type) is captured, at most 128 such
keys are ever captured for, each stack is cut to 3 frames and 400 characters,
and a gauge reports at most 2 of them — each site once per session, never
repeated on later gauges. On engines without `Error.captureStackTrace` (Firefox,
Safari) the field is absent rather than guessed at, because a wrong location is
worse than none. A framework that registers its own delegated listeners will
name its own internals as the callsite for those types; that is where the
registration genuinely happened.

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

## React

The React bindings live on the `crumbtrail-core/react` subpath. Nothing extra to
install: React is an optional peer dependency, so a project that never imports
this subpath never has to have React at all.

Wrap a subtree so a render error is flagged as a bug with the surrounding
session already captured:

```tsx
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";
import { CrumbtrailErrorBoundary } from "crumbtrail-core/react";

const crumbtrail = Crumbtrail.init({
  ...PRESET_PASSIVE,
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: process.env.CRUMBTRAIL_KEY,
  remoteConfig: true,
});

export function App() {
  return (
    <CrumbtrailErrorBoundary
      logger={crumbtrail}
      fallback={<p>Something broke.</p>}
    >
      <Checkout />
    </CrumbtrailErrorBoundary>
  );
}
```

| Prop       | Type         | Description                                   |
| ---------- | ------------ | --------------------------------------------- |
| `logger`   | `Crumbtrail` | The instance returned by `Crumbtrail.init()`. |
| `children` | `ReactNode`  | The subtree to guard.                         |
| `fallback` | `ReactNode`  | Optional UI to render after an error.         |

`useBugState` registers a value so it is attached to any bug flagged while the
component is mounted:

```tsx
import { useBugState } from "crumbtrail-core/react";

function Checkout({ crumbtrail }) {
  const [cart, setCart] = useState([]);
  const [step, setStep] = useState("address");

  useBugState(crumbtrail, "cart", cart);
  useBugState(crumbtrail, "step", step);

  // ...
}
```

Values are **redacted by default** using the same policy as the rest of the SDK,
so a state field called `token` or `password` never leaves the browser in the
clear. Pass `{ captureRawState: true }` as the fourth argument only when you are
certain the value is safe.

React 18 or newer. For React Native and Expo, use
[`crumbtrail-react-native`](https://www.npmjs.com/package/crumbtrail-react-native)
instead: its peer dependencies are native and must not reach a web bundle.

## Tauri

The Tauri v2 transport lives on the `crumbtrail-core/tauri` subpath. It replaces
the HTTP transport with native IPC, so a desktop app needs no server process.
`@tauri-apps/api` is an optional peer dependency, which every Tauri v2 frontend
already has.

```typescript
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";
import { TauriTransport } from "crumbtrail-core/tauri";

const logger = Crumbtrail.init({
  ...PRESET_PASSIVE,
  transportInstance: new TauriTransport(),
});
```

`TauriTransport` sends events over Tauri's `invoke()` IPC to the Rust side,
which owns session directories, NDJSON writing, blob storage and
post-processing. That Rust half is the `tauri-plugin-crumbtrail` crate, and it
must be registered separately — see
[`packages/tauri/README.md`](https://github.com/CrumbtrailDev/crumbtrail-cli/blob/main/packages/tauri/README.md)
for the Cargo dependency, the `.plugin(...)` call and the capability permission.
Without those three steps every Crumbtrail `invoke` fails.

## Related packages

| Package                                                                            | Use it for                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`crumbtrail`](https://www.npmjs.com/package/crumbtrail)                           | The `npx crumbtrail` setup wizard                          |
| [`crumbtrail-node`](https://www.npmjs.com/package/crumbtrail-node)                 | Self-hosted server, Express middleware, MCP evidence tools |
| [`crumbtrail-react-native`](https://www.npmjs.com/package/crumbtrail-react-native) | React Native and Expo bindings                             |

The React error boundary and state-capture hook, and the Tauri desktop
transport, are subpaths of this package rather than packages of their own — see
[React](#react) and [Tauri](#tauri) above.

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
