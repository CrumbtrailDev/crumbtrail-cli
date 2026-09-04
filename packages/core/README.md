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

## Serverless Fetch handlers

Fetch runtimes import `withCrumbtrailFetch` from the `/serverless` subpath:

```ts
import { withCrumbtrailFetch } from "crumbtrail-core/serverless";

export const handler = withCrumbtrailFetch(async () => new Response("ok"), {
  endpoint: "https://your-crumbtrail-host",
});
```

The endpoint is required unless you provide a custom transport. For runtime
bindings, lifecycle hooks, options, data bounds, and platform examples, see
[Capture serverless HTTP functions](../../docs/integrations/serverless-functions.md).

## Setup

Call `Crumbtrail.init()` once, at your app's entry point:

```ts
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";

Crumbtrail.init({
  ...PRESET_PASSIVE,
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: process.env.CRUMBTRAIL_KEY,
  remoteConfig: true,
  release: "2026.08.26",
  // Backend origins this app calls. Leave it out only if your API is served
  // from the same origin as the page. See below.
  networkCorrelationAllowedOrigins: ["https://api.example.com"],
});
```

That's the whole integration — capture runs in the background from there.

### Release identity

Pass the application's release identifier as `release` when you have one:

```ts
Crumbtrail.init({
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,
  remoteConfig: true,
  release: import.meta.env.VITE_APP_VERSION,
});
```

The SDK also reads common public `*_APP_VERSION` and `*_APP_BUILD` values from
`process.env` when a bundler exposes them. Vite applications should pass their
`import.meta.env` release explicitly as shown above. When the page declares
`<meta name="app-build" content="...">`, that value is recorded as `build`.
An explicit `release` wins over an inferred release. These are application
values, not the SDK version.

The session-start envelope and the session replay `replay.json` manifest carry
`release` and `build` when known, plus the distinct `sdkVersion` that wrote
them. Unknown application identity is omitted rather than guessed. Identity is
resolved once at `init()` and remains the identity of that loaded page for its
whole session, including SPA navigations. This records the stale shell's build
so a later mismatch detector can compare it with a server-declared build. The
SDK does not implement that detector here.

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

### Limiting active session duration

Set `maxSessionDurationMs: 300_000` to begin a new session every five minutes
while the page remains active. The default is `0`, which disables rotation.
For separate visits on reload, also use `sessionPersistence: "memory"`.

```ts
Crumbtrail.init({
  httpEndpoint: "https://app.crumbtrail.ai",
  maxSessionDurationMs: 300_000,
  sessionPersistence: "memory",
  endOnPageHide: true,
});
```

New actions use the new session. Requests already in progress retain their
original session identity, and their later responses are delivered as late
evidence to that session. A session can therefore acquire additional evidence
after its five minute interval closes. Finalization waits for admitted uploads,
and server processing can add time before the updated evidence is visible.
Browser timer suspension can delay the boundary until execution resumes.

Rotation requires the HTTP transport or a custom transport implementing
`sendSessionEvents`. It is not applied in flight recorder mode. Page exit and
`stop()` retain their existing flush and close behavior. A browser can terminate
before delivery completes, so page exit still depends on server recovery when
its lifecycle request cannot be delivered.

### Capturing page-load failures before init

For page-load fetches, XHRs, and browser-managed subresource failures, this
import is required when `init()` can run after the page starts loading. The
normal entry still captures events after `init()`, but it cannot recover events
that happened before its chunk evaluated. Without this import, those early
events are not captured.

Add this side-effect import as the first line of your entry file, above every
other import:

```ts
import "crumbtrail-core/early";
```

It patches `fetch` and `XMLHttpRequest` synchronously, listens for
capture-phase subresource errors, stamps the same correlation headers the SDK
stamps on same-origin requests, and parks bounded records in one queue. The
queue holds at most 50 entries, 2 MB of request and response body text, 32 KB
per request or response body, and 4 KB of URL text per resource failure. These
fixed limits apply before configuration is known. The early queue keeps body
text only in page memory and `init()` drains it through the normal redaction
pipeline before emission. If `init()` never runs within 60 seconds, the queue
and early resource listener are dropped and the patches become pass-throughs.

After the coordinated SDK 0.49.0 release is published, a page with no bundler
can load the published classic bootstrap before the page's first executable
script. The CLI's static recipe emits this URL only when that compatible SDK
release is supplied, and pins it to the same exact release as the module that
initializes the SDK:

```html
<script src="https://unpkg.com/crumbtrail-core@<version>/dist/early-bootstrap.global.js"></script>
```

This script is parser-blocking, installs no configuration, and makes no network
request of its own. The following module script initializes Crumbtrail and
drains the queue. A Content Security Policy must allow `https://unpkg.com` for
the bootstrap tag and `https://esm.sh` for its module import in `script-src` or
the corresponding `script-src-elem` policy. It must also approve the inline
module with a matching nonce or hash and allow the ingest endpoint in
`connect-src`. If SRI is required, add `integrity` and
`crossorigin="anonymous"` to the bootstrap tag only, using a hash for its exact
response. SRI does not protect the inline module or its static import. For
offline or stricter policies, self-host the published `dist` files, including
relative ESM chunks, replace both pinned URLs, and use an approved external or
nonce/hash-approved module. If the bootstrap itself is blocked or unavailable,
no early hooks can run.

An older CLI or SDK does not emit a bootstrap URL. It keeps the module import
at the supported SDK floor and tells a rerun to upgrade to the coordinated
release before adding early capture.

### Presets

| Preset           | Behaviour                                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `PRESET_PASSIVE` | Capture continuously and auto-flag on errors and signals. The default. |
| `PRESET_LIGHT`   | Leaner capture, less overhead.                                         |
| `PRESET_FULL`    | Everything, for a heavy debugging session.                             |

### Automatic capture triggers

The automatic triggers are `autoFlagOnError`,
`autoFlagOnUncaughtError`, `autoFlagOnUnhandledRejection`,
`autoFlagOnRequest5xx`, `autoFlagOnRenderedError`,
`autoFlagOnCaughtError`, `autoFlagOnResponseBodyError`,
`autoFlagOnStreamFailure`, `autoFlagOnWorkerError`,
`autoFlagOnWrongNumber`, `autoFlagOnResourceLoadFailure`,
`autoFlagOnStorageFailure`, and the configured signal triggers
`autoFlagOnRageClick`, `autoFlagOnRetryStorm`, `autoFlagOnSlowResponse`, and
`autoFlagOnAbandonedFlow`.
`autoFlagDebounceMs` coalesces a burst and
`autoFlagMaxPerSession` caps automatic reports across all triggers.

`autoFlagOnCaughtError`, `autoFlagOnResponseBodyError`,
`autoFlagOnStreamFailure`, and `autoFlagOnWorkerError` are enabled by default.
`autoFlagOnWrongNumber`, `autoFlagOnResourceLoadFailure`, and
`autoFlagOnStorageFailure` are disabled by default because they can be noisy.

When `autoFlagOnStorageFailure` is enabled, Crumbtrail records rejected Web
Storage, IndexedDB, and Cache API operations. It records only the storage API,
operation, and bounded error name. It never records database or cache names,
keys, request bodies, or responses, and ignores deliberate aborts.

`autoFlagOnRenderedError` is enabled by default. It watches browser-standard
signals: `role="alert"` or `role="alertdialog"` entering the document,
`aria-invalid="true"` appearing on a control, and native `invalid` events. A
same-turn state that clears before the mutation batch settles is ignored.

This trigger does not guess from CSS classes, test IDs, or error copy. It cannot
cover plain error elements with none of these accessibility or browser
validation signals, nor can it infer an error from `aria-describedby`,
`aria-errormessage`, `:user-invalid`, or application-specific state that is not
exposed through these standards.

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

To record an error that your application caught, use `recordError`. It emits a
canonical `err` event with `handled: true`, `fatal: false` by default, and
bounded message and stack fields, redacted unless `captureRawErrors` is enabled:

```ts
try {
  await submitOrder();
} catch (error) {
  crumbtrail.recordError(error, { source: "checkout" });
}
```

Also on the instance: `addEvent`, `recordError`, `registerStateProvider`,
`setEnv`, `captureScreenshot`, `createRequestHeaders`, `pause`, `resume`,
`stop`, `getSessionId`.

### Attach a report screenshot

Capture an application owned PNG only after the user has chosen the image or
the application has rendered the canvas. The SDK does not request display media
or capture images automatically:

```ts
const image = await crumbtrail.captureScreenshot(canvas);

await crumbtrail.flagBug({
  note: "The total is wrong",
  visualArtifactName: image.artifactName,
});
```

`captureScreenshot` accepts a PNG `Blob` with `type: "image/png"` or an
`HTMLCanvasElement`. Canvas output is encoded as PNG. The generated artifact
name is the only name accepted for a later association. The image is limited
to 5 MiB and 4096 pixels on either edge. The project administrator must enable
report screenshots before the Cloud endpoint accepts the upload. The client
also keeps this API disabled until the remote project policy enables it.

### Reporting a bounded business assertion

When application code knows an expected and actual bounded fact, report both
through the assertion API. The SDK evaluates the fixed operator and emits an
`app.assertion` event. It does not infer correctness from a response body or UI
state.

```ts
const passed = crumbtrail.assert({
  name: "cart_total",
  operator: "equals",
  expected: 100,
  actual: cart.total,
});
```

Names and values are strictly bounded. Values may be booleans, finite numbers,
or short identifier and enum shaped strings. Objects, prose, emails, tokens,
response bodies, and redaction markers are rejected. At most 100 valid
assertions are emitted per session. Use `reportAssertion()` when the caller
needs to distinguish a failed assertion from an invalid or capped input. Pass
`requestId` and `traceId` when the application owns those correlation values.
With the default `sessionPersistence: "session"`, the assertion count is kept
with the session ID in `sessionStorage`, so a hard reload cannot reset the
session cap. An assertion is counted only after the EventBus admits it, so
consent, remote policy, sampling, flight recorder finalization, and lifecycle
shutdown can refuse it with `capture_not_admitted` without spending the cap.
Assertion event timestamps are non-negative safe integer Unix milliseconds within
the ECMAScript `Date` range. The exported event builder rejects timestamps
outside that definition.

### Checking response semantics and expected effects

When a response has a valid HTTP shape but the application knows that a bounded
business fact is wrong, check it with `checkResponse()`:

```ts
const result = crumbtrail.checkResponse(response, [
  {
    name: "cart_total",
    operator: "equals",
    expected: 100,
    path: "data.total",
  },
]);
```

Each declaration reads one exact own-property path, or one bounded selector for
an array item. The response is not retained or sent. Only a boolean, finite
number, or short identifier-shaped string may become event data. Objects,
prose, emails, tokens, headers, accessors, prototype paths, and missing values
are rejected. A call accepts at most 20 facts, selectors scan at most 25 items,
and a session emits at most 100 response facts. Only admitted events consume
the cap, and the count survives reloads with session persistence enabled.
Inactive capture returns `capture_not_admitted`. The event kind is
`app.response.assertion`, and `reportResponse()` is an alias when the name is
more readable at the call site.

For work that should happen after a successful operation, declare the expected
effect before starting it:

```ts
const expectation = crumbtrail.expectSideEffect({
  name: "inventory_update",
  kind: "update",
  deadlineMs: 2_000,
});

// Call this when the application observes the update or external effect.
expectation.handle?.satisfy();
```

The supported kinds include `update`, `external`, `queue`, and `work`. An
unsatisfied declaration emits one `app.expectation.missed` event at its
deadline or when the session stops. `cancel()` suppresses that event for work
the application intentionally abandoned. Deadlines are bounded from 1 ms to
24 hours, expectation handles are opaque, and timers do not keep a Node process
alive. These APIs declare application knowledge. They do not infer business
correctness or discover an effect that the application did not declare.

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

### Selecting small support diagnostics

Use `redaction.diagnosticFields` when the application needs a small set of
declared flag or runtime-config values in an environment event. The paths are
relative to each map passed to `setEnv`, use exact property names and numeric
array indexes, and select at most 16 scalar values. Only the first 64 configured
paths are parsed, and array indexes must be between 0 and 63:

```ts
const logger = Crumbtrail.init({
  redaction: {
    diagnosticFields: ["checkout.status", "attempts[0].code"],
  },
});

logger.setEnv({
  flags: {
    checkout: { status: "failed" },
    attempts: [{ code: "E_TIMEOUT", customerEmail: "person@example.com" }],
  },
});
```

Only the selected paths are considered. Values must be scalar and no longer
than 256 characters. Selected strings are normalized with Unicode NFKC before
classification. Values that remain non-ASCII are omitted. Whole or embedded
URLs go through `redactUrl` with `keepFields` ignored, and unsafe schemes are
redacted. Sensitive names, email, token, card, password, and other secret
patterns still win. Wildcards, inherited properties, accessors, cycles,
prototype-like keys, bodies, headers, stacks, locals, and non-scalars are not
retained. Omitting `diagnosticFields` preserves the existing environment
redaction behavior. `keepFields` and `redaction.mode` do not widen this list.

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
back.

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

`remoteConfig` is what makes the project's capture settings reach the
running app, and it is on by default. With it on, the SDK polls `/api/capture-config` on `httpEndpoint`
using the ingest key it already holds, and the auto flag triggers, flight
recorder tail, baseline sampling, consent mode, masking mode, report screenshots,
session replay and live probes are taken from the project rather than from this call. Those reach
an app on that poll and on no other path. The kill switch, the per project
capture budgets, row value redaction and the refusal of a replay write from a
project that has not opted in are enforced at ingest as well, so they take
effect on the next upload whatever the client is running. Set `remoteConfig` to
`false` to skip the poll and run on this call alone. The poll needs
`httpAuthToken`, so a client with no ingest key does not poll whatever this
says. It is fail closed but bounded: capture waits up to five seconds for the
first policy response, then falls back to this call and records a
`policy_unavailable` gap, so a host that does not serve the route costs that
wait on first load rather than the session. Point `configEndpoint` somewhere
else only for a self hosted config service.

When an ingest key is present, the SDK also registers one runtime identity with
`POST /api/runtime/register` on the ingest host. Cloud returns an opaque
`instanceId`, a short lived bearer proof, and `expiresAt`. The SDK keeps these
values in memory and sends them only as top level session start fields. A config
poll also uses the identity and bearer proof only when its resolved origin
matches the ingest host. A different-origin `configEndpoint` stays on the
legacy untargeted poll. It rotates the proof before expiry and falls back to the
untargeted poll when registration is unavailable or rate limited. Registration
is bounded and does not block capture indefinitely. Endpoint based serverless
wrappers reuse one binding across warm invocations for the same endpoint and
project, with a bounded idle cache.

Set `flightRecorder: true` to buffer locally until an error, signal, widget
action, or `flag()` triggers capture. The recorder adds the configured tail
before finalizing the report. A cloud config response can disable capture with
`killSwitch: true`; the SDK clears its buffer as soon as that response arrives.

### Live probes

A capture config response can also name probes to run, under a `probes` field. A probe answers one
question about the running application and rests its answer as a `probe.result` event, so an agent
reading the session afterwards sees what the app actually looked like at that moment rather than
what the code implies it looked like. Five probes exist and the server can name nothing else:
`runtime.env`, `runtime.cpu_profile`, `storage.snapshot`, `network.inflight` and `flags.current`.

The whole of what a server may say is a name. Probes take no selector, no URL, no path and no
expression, so no value from a config response reaches probe code, and one entry shaped as an object
rather than a string refuses the entire field rather than being salvaged. A name outside the five is
dropped without normalization. At most four probes run per poll, repeats are collapsed, and a list
longer than 64 entries is refused before it is read.

They run one at a time, only after the remote policy has been applied, and each gets its own
deadline: 2 seconds, 200 rows and 32 KB of serialized rows by default. A probe that hangs is
abandoned at the deadline. A kill switch, a `stop()` or a newer poll ends the run between probes. A
probe never throws: a failure rests as a `probe.result` carrying `ok: false` and a short reason,
because "this source was not available in production" is itself an answer. Values pass through the
same redaction the rest of capture uses.

A current SDK registers its runtime before polling. When an agent targets a
session, Cloud sends the probe only to the matching runtime identity. Older SDKs
continue to receive untargeted project probes. A targeted probe whose runtime
does not poll remains unavailable instead of being answered by a bystander.

`runtime.cpu_profile` is available only in `crumbtrail-node` and only on a poll
authenticated by the exact runtime binding for the target session. Node uses
`node:inspector` for a fixed 1,000 ms sampling window and a 2,000 ms hard
deadline. Its result contains only `durationMs`, `sampleCount` and up to 50
bounded `topFunctions` rows. Browser/core callers, untargeted or stale
responses, unsupported inspectors and profiler failures return `ok: false` with
`error: "unavailable"` or another explicit error and do not produce a fake
empty profile.

`storage.snapshot` is the reading where that distinction changes what is emitted, so its keys get a
stricter treatment than the ordinary storage capture uses. It reports which keys exist, how many,
what pattern each follows and how many bytes each holds. It does not report any stored value, which
is replaced unconditionally, and it does not report the identifying part of a key: an email address,
a user id, an order number, a phone number or any other span that could carry a value is replaced
with `*`, so `session:alice@example.com:cart` is reported as `session:*:cart`. A key from which no
ordinary word survives is reported as `[REDACTED_KEY]`. A plain word in a key is kept, which is what
makes two patterns tellable apart, so a key that spells out a person's name in ordinary letters is
the one case this cannot catch.

### Response identity (`net.res`)

`net.res` carries `d.method` and `d.url` — the same values, under the same
redaction, as the `net.req` it answers. A reader does not have to find the paired
request to learn which endpoint a response came from, which matters because the
pair is not guaranteed: a request that started before the retained window, or
before a truncated upload's cut, leaves its response standing alone. `net.err`
has always carried both for the same reason.

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

### Subresource load failures (`net.err`)

The `errors` collector also listens in the capture phase for browser-managed
subresource failures. These use `net.err` with `transport: "resource"`, so they
remain distinct from fetch and XHR failures (`transport: "fetch"` or `"xhr"`).
The payload carries the lower-case element type, its resolved `url`, and
`loading`, which is true while the document is still loading. URLs use the same
redaction policy as every other captured URL, and the element's inline content
is never read.

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
repeated field becomes an array. File parts are described, never read: the file's
own bytes are never stored, only sniffed and discarded. The form field name
survives as the key and the part reports `{ file: true, bytes, ext }` — `ext` is
the lowercased tail of the file name after its last dot (never the stem), kept
only when it is short and alphanumeric enough to be a type rather than free text.

The rest of the file's description — `nameShape` (the same shape a redacted
value gets, computed over the file name), `declaredType` (`file.type`, kept only
when it matches a strict MIME grammar), and `sniffedType`/`width`/`height` (read
from the file's own bytes: the first 32 bytes identify PNG, JPEG, GIF, WebP, PDF,
ZIP, MP4, or plain text, and carry dimensions for PNG/GIF/WebP; a JPEG's
dimensions come from scanning its marker segments in the first 64 KB) — arrives
on a separate `net.req.file` event rather than inside the body's JSON text. A
MIME type such as `application/pdf` would fail the enum-shaped rule that lets an
ordinary short body value survive redaction untouched, so fields that are
already shape-only or grammar-validated ride outside that redaction instead of
through it. `net.req.file` carries `id` (joining it to its `net.req`), `field`
(the FormData key), and `index` (position among files under that same key), and
may arrive in two parts: the synchronous fields immediately, and the sniffed
fields once the bounded byte read resolves — never delaying the request itself,
which dispatches without waiting on either.

Server-side multipart bodies are unaffected by any of this; describing a
multipart part on the Node SDK needs a boundary parser it does not have yet.

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

The shared native SDK wire contract also defines `native-hang` for a bounded
watchdog or previous launch hang observation. `crumbtrail-core` does not emit
this event. Platform SDKs can adopt the contract when their collectors support
it. Memory pressure and process termination remain `app-lifecycle` events.

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

| Package                                                                            | Use it for                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| [`crumbtrail`](https://www.npmjs.com/package/crumbtrail)                           | The `npx crumbtrail` setup wizard                  |
| [`crumbtrail-node`](https://www.npmjs.com/package/crumbtrail-node)                 | Backend capture: Express, `node:http` and database |
| [`crumbtrail-react-native`](https://www.npmjs.com/package/crumbtrail-react-native) | React Native and Expo bindings                     |

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

## Data witness event

`db.witness` records one before or after database observation from the CLI witness
runner. Automatic SDK capture does not emit it. The event carries `witnessId`,
`engine`, `runId`, `phase`, a migration fingerprint, and one to three statement results.
Each result contains a value free shape, bound parameters, execution status, true row
count, and up to 25 identifying rows. Identifying values and parameters pass through
the existing database row redaction. The session view shows counts and identifying
values after redaction.

The `DataWitness` type is a restricted query document. `validateDataWitness` rejects
unsupported instructions and unbound keys. `compileDataWitness` generates parameterized
reads for Postgres, MySQL, SQLite, SQL Server, or MongoDB. It does not execute arbitrary
SQL or aggregation stages. The witness runner never boots the application, copies the
database, or sends the connection string to Crumbtrail.
