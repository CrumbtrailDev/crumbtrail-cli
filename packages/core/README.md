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

### What a shape placeholder says

A redacted value in a JSON body is replaced by an object, and a redacted query
value by a string. Both carry the same facts: enough structure to tell a one
word entry from a pasted paragraph, and nothing recoverable.

```json
{
  "$redacted": "[REDACTED]",
  "len": 42,
  "charset": "mixed",
  "hash8": "527676bd",
  "words": 7,
  "nonAscii": true,
  "emoji": true,
  "example": "xxx xxxxxxxx xxxxxxxx xx xxxxxxx xxxxxx 🙂"
}
```

| Field                    | Meaning                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `len`                    | length in UTF-16 code units                                              |
| `charset`                | `alpha`, `num`, `alnum` or `mixed`                                       |
| `separators`             | positions of `.`, `,` and spaces in numeric looking text                 |
| `hash8`, `casefoldHash8` | session salted fingerprints, for equality only                           |
| `words`                  | whitespace separated runs                                                |
| `lines`                  | line breaks plus one, present only above one                             |
| `edges`                  | `leading`, `trailing` or `both` when whitespace sits at an end           |
| `nonAscii`               | any code point above 0x7F                                                |
| `emoji`                  | any Extended_Pictographic code point                                     |
| `pattern`                | `date`, `time`, `datetime`, `url`, `uuid`, `decimal` or `grouped_number` |
| `example`                | a stand in, not the real value                                           |

`hash8` is withheld when the candidate space is small enough to enumerate
(numeric under 12 characters, or anything under 6), and `words`, `lines` and
`example` are withheld with it.

The last seven rows of that table are emitted only when the classifier redacted
the value as ordinary prose, for a query value whose parameter name is not
sensitive, or for an upload's file name. A value redacted for its **name** (`password`, `ssn`, a `denyFields`
entry), for its input **type** (password, email, tel), by the `maskInputTypes`
**policy**, or by the `captureInputValues` opt out reports `len`, `charset`,
`separators` and the hashes, and nothing else. Those fields are safe on prose
and are a narrowing on a credential: `pattern: "date"` under a `dob` name hands
back most of what the redaction removed, and `edges`, `words` and `nonAscii`
each cut a password's candidate space. The floor is the default, so a value
whose reason is unknown gets the floor.

`example` is built from a fixed alphabet: `X` for an uppercase ASCII letter,
`x` for a lowercase one, `0` for a digit, `é` for a Latin letter with a
diacritic, one fixed letter per other script, `🙂` for an emoji, whitespace and
ASCII punctuation kept as they were, and `?` or `¤` for anything else. It is
capped at 120 code units followed by an ellipsis, while `len` still reports the
true length. It is emitted only for free prose and for an upload's file name, so
it never stands in for a password, an email, a token, a card number, an IBAN, a
high entropy string, a sensitive field name, or a masked input.

A stand in carrying fewer than three letter or digit stand in characters is
withheld, and the rest of the shape is emitted without it. On a value such as
`<<>>--__..!!??` the alphabet does no work: whitespace and ASCII punctuation are
kept as they were, so the field would be a verbatim copy of the value under a
name that promises it is not. The SDK is where that floor is enforced, so the
field never leaves the page below it.

The count is over the stand in's own characters rather than the original value's,
which is what lets a receiving server apply the identical rule. Two consequences
follow. A digit outside ASCII has no digit character in the alphabet and is
written as `¤`, so a value of Arabic-Indic digits carries no stand in. An astral
letter is written as its representative repeated to keep the code unit width, so
it counts twice.

The fixed alphabet is what makes the field checkable without the original value,
which matters because a server receiving a session never sees one.
`isValidRedactedShapeExample` is exported for that: given an `example` and the
shape it claims to describe, it checks the alphabet, the length against `len`,
the floor of three letter or digit stand in characters, and agreement with
`charset`, `nonAscii` and `emoji`, and reports whether they disagree. Run it on
ingest if you want a forged or hand edited `example` dropped rather than
trusted.

The query string form spells the same fields out in one marker:

```
?note=[REDACTED;len=35;charset=mixed;words=6;lines=2;edges=both;nonAscii;emoji]
?ssn=[REDACTED;len=35;charset=mixed]
```

A sensitive parameter name gets the floor, as it does everywhere else.

`example` is deliberately absent from that form. A query string is the plane
most likely to be re-serialized and pasted, and the stand in is the one field
that keeps the original's punctuation positions.

Input values keep the bare `[REDACTED]` token so every consumer that reads them
as text still works. Their shape rides in the event's redaction metadata, on the
`fields[]` entry for that input.

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
wait on first load rather than the session.

Nothing leaves the page during that wait, and nothing is thrown away either.
Events captured before the policy answers are held in memory and released once
it does, in the order they happened and with their original timestamps, so the
requests that render the first screen keep both halves of the pair rather than
arriving as a response with no request behind it. The hold is bounded at 2,000
events, drops the oldest first, and records a `buffer_overflow` gap counting
whatever it dropped.

Release is not a replay of what was captured, it is a re-ask under the policy
that just arrived. A held event is dropped when its collector is now off, when
its URL now matches `excludeUrls`, or when the session was shed by the sample
rate the policy carried; its headers are dropped when the policy turns header
capture off; its bodies are re-redacted under the policy's `denyFields`,
redaction mode and body size cap; an input value becomes a placeholder when the
policy sets `captureInputValues: false`; and a DOM snapshot, keystroke or
clipboard event is dropped outright when the policy tightened masking, because
the content it holds was already rendered under the looser rule. A held event
can lose detail or lose itself on release. It can never gain reach.

A decision against capture empties the hold without sending anything:
`stop()`, a `killSwitch`, `consent(false)`, a page hide that ends the session,
or Global Privacy Control. GPC counts as a decision under the default
`consentMode: "implicit"`, so a suppressed visitor holds nothing waiting for a
consent call that is never coming. Under `consentMode: "required"` it does not,
because the host is expected to answer and may answer yes: the first screen
stays in page memory, unsent, and reaches the wire only if `consent(true)`
arrives. Point `configEndpoint` somewhere
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

Each response retains its own bounded, redacted body, including repeated
responses from the same URL. Reading a retained response does not require an
earlier event to resolve a body reference. Repeated responses can therefore use
more capture storage, within the existing body and session limits.

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
value gets, computed over the file name, including the `example` stand in so a
reader can tell `IMG_0042.jpg` from `Q3 board deck (final).pdf` without seeing
either), `declaredType` (`file.type`, kept only
when it matches a strict MIME grammar), and `sniffedType`/`width`/`height` (read
from the file's own bytes: the first 32 bytes identify PNG, JPEG, GIF, WebP, PDF,
ZIP, MP4, or plain text, and carry dimensions for PNG/GIF/WebP; a JPEG's
dimensions come from scanning its marker segments in the first 64 KB) — arrives
on a separate `net.req.file` event rather than inside the body's JSON text. A
MIME type such as `application/pdf` would fail the enum-shaped rule that lets an
ordinary short body value survive redaction untouched, so fields that are
already shape-only or grammar-validated ride outside that redaction instead of
through it.

Exactly one `net.req.file` event is emitted per file part:

```
{ k: "net.req.file", t, d: { id, field, index, ext?, nameShape?, declaredType?, sniffedType?, width?, height? } }
```

`id` joins it to its `net.req`, `field` is the FormData key, and `index` is the
part's position among files under that same key. Reading the file's own bytes
is async, so the event is written once the byte sniff settles — successfully or
not — carrying the synchronous fields (`ext`, `nameShape`, `declaredType`)
alongside whatever the sniff found; a file with no `slice` method or a sniff
that fails still gets its one event, with the synchronous fields alone. `t` is
stamped with the request's own start time so the event sorts beside its
`net.req` regardless of when the sniff actually finished. None of this ever
delays the request itself, which dispatches without waiting on a single byte
of its own upload being read back.

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

Two further shapes are read, because a list screen states its own counts in
prose rather than as bare numbers. Both use a namespaced label, so a pager
footer can never be mistaken for a rendered figure by a consumer that matches
labels by word.

First, a text node whose **whole** content is a short count phrase:

| Rendered                                                              | Items                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| `31 people` (`{n} {noun}`)                                            | `count:people` = 31                                   |
| `Total 85 items`                                                      | `pager:total` = 85                                    |
| `Page 1 of 1`                                                         | `pager:page` = 1, `pager:pages` = 1                   |
| `1-25 of 31 items` (also en/em dash, `to`, optional `Showing` prefix) | `pager:range_start`, `pager:range_end`, `pager:total` |
| `Showing 25 of 138 results`                                           | `pager:shown` = 25, `pager:total` = 138               |

A trailing unit noun is accepted and ignored. `Total {n} {noun}` mints
`pager:total` only for a collection noun (items, results, records, rows,
entries, matches); every other noun is a count of something on the list, so
"Total 3 errors" reads as `count:errors` and a region cannot end up with two
different `pager:total` values.

The noun of a `{n} {noun}` count is one lowercase word, optionally preceded by
one qualifier from a closed list (open, closed, new, unread, active, pending,
total, matching), and it must look like a plural (end in "s") or be a known
non-plural count noun (people, staff, children, feedback, data, personnel). So
"12 open orders" and "31 people" are read, while "2 jane", "12 acme" and
"5 Dr Smith" are not. The honest residual: this is a shape test, not a
dictionary, so a lowercase word ending in "s" that happens to be a name
("3 williams") can still become a label — the gate narrows the opening rather
than closing it, and the opt-outs below are the answer when a screen renders
counts beside names. A sentence that merely mentions a number ("We have 31
people on the team.") is not a count and produces nothing.

Second, a pager control's state: a `button` or `a` whose accessible name
reduces to a pager word emits `{ label: "control:<word>", value: 1 | 0 }`, where
the value is a boolean, 1 for actionable and 0 for disabled, not a count. The
name is reduced rather than matched whole, so "Go to next page" and "Next Page"
both read as `control:next` while "Next step in setup" is not a pager control.
Disabled is read from the `disabled` attribute, `aria-disabled="true"`, a
disabled class on the control or its wrapper, or an anchor with
`tabindex="-1"`; `«`, `»`, `‹`, `›` and "Load more" are recognised too. A
control whose state cannot be established emits no item rather than a confident
`1`.

A numbered-link pager states its position only in markup, so an element
carrying `aria-current="page"` inside a `nav`, `ul` or `ol` contributes
`pager:page`. The page COUNT is deliberately not inferred from the highest
numbered link: an elided pager ("1 2 3 … 12") and a truncated one ("1 2 3 …")
are indistinguishable, and a guess there would be a false shortfall.

A control's word is all this collector knows. A bare Next or Previous button
outside a pager — a form wizard, a carousel, a date picker — emits
`control:next` or `control:previous` exactly as a pager does, so a consumer
must not read `control:next = 0` as "there is no page two" unless the same
region also carries pager evidence (`pager:pages`, `pager:total`, a range, or a
`pager:page`).

Count and control items are budgeted separately from rendered figures, at 20
per region, so a chatty feed cannot push a region over the numeric-token cap
and cause its currency tokens to be withheld. A region that holds more than 20
is clipped to the first 20 and reported in the scan result's `phrasesCapped`,
which raises a `capture_gap` for the region rather than letting a partial
snapshot read as complete.

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

Values are **redacted by default** by the same engine the rest of the SDK uses,
so a state field called `token` or `password` never leaves the browser in the
clear. The engine also classifies on the value, so an email address, a card
number, a JWT or a high entropy secret is redacted even under a field name that
reads as ordinary. A redacted value is replaced by a shape record carrying its
length, character classes and a stable hash, so two different secrets stay
distinguishable without either one leaving the browser. Snapshots are bounded:
a cycle, a very deep graph, a very long list or a very wide object is replaced
only where it broke the bound, and the rest of the snapshot is delivered.

Pass `{ captureRawState: true }` as the fourth argument only when you are
certain the value is safe.

`CrumbtrailErrorBoundary` redacts the error message, the stack and the component
stack as free text, which keeps every stack frame and substitutes only embedded
secrets. Both the boundary and `useBugState` report what they removed as
redaction metadata on the captured event.

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
