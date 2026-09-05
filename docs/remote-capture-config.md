# Remote capture config schema

The browser SDK polls `<httpEndpoint>/api/capture-config?projectKey=<key>` and applies the
capture policy it finds there. This document is the schema that endpoint answers with.

Applies to `crumbtrail-core` 0.40.0 and later. Schema version: **2**.

## Prerequisites

- The app initialises with `remoteConfig: true` (the default) and a `httpEndpoint` plus
  `httpAuthToken`. Without both, no poll is made and the local config is the whole policy.
- The endpoint answers `200` with JSON. `4xx` and `5xx` are ignored and the last known policy
  stands.

The current SDK first registers a per tab runtime identity with
`POST <httpEndpoint>/api/runtime/register?projectKey=<key>`. The response contains
an opaque `instanceId`, an `instanceProof`, and an `expiresAt` timestamp. The
proof is kept in memory and sent only on session start as the top level
`instanceProof`. A config poll also carries the `instanceId` and
`Authorization: Bearer <instanceProof>` only when the resolved config polling
origin matches the `httpEndpoint` origin. An explicit `configEndpoint` on another
origin uses the legacy untargeted request and receives no runtime proof. The SDK
rotates the proof before expiry. A failed or rate limited registration does not
stop capture, and the poll falls back to the legacy untargeted request. Endpoint
based serverless wrappers reuse one binding across warm invocations for the same
endpoint and project, with a bounded idle cache.

## Minimal working response

```json
{
  "schemaVersion": 2,
  "killSwitch": false,
  "sampling": { "captureSampleRate": 0.25, "baselineSampleRate": 0.05 },
  "collectors": { "keystrokes": false, "clipboard": false },
  "network": { "maxBodySize": 8192, "excludeUrls": ["/api/billing"] },
  "redaction": { "mode": "full", "denyFields": ["invoiceRef"] },
  "scrollThrottleMs": 1000
}
```

## Verify it applied

1. Serve the response above from the config route.
2. Reload the app and watch the network tab for `POST /api/runtime/register`,
   `POST /api/session/start`, and `GET /api/capture-config`. When the config poll
   uses the same origin as `httpEndpoint`, it includes `instanceId` and an
   `Authorization` bearer header. A different-origin `configEndpoint` uses the
   untargeted request without either value. The SDK sends `cache: "no-store"`,
   so every poll is a real request. The bearer must not appear in session
   metadata or captured events.
3. The policy is live once the SDK starts sending events. Until a poll returns a **recognised**
   policy, capture is buffered and nothing is delivered; after `REMOTE_POLICY_TIMEOUT_MS` with no
   recognised policy the SDK opens the gate on the local config and records a
   `capture_gap` event with `reason: "policy_unavailable"`.

A response is recognised when it carries at least one field from the tables below.
`schemaVersion` and `probes` alone are not recognised.

## Envelope

The policy fields may sit at the top level, or under any of `project`, `captureConfig`,
`capture_config`, `policy`, `settings`, `captureSettings`. These are merged, later winning:
`root`, `project`, `captureConfig`, `policy`, `settings`. Use the top level unless you already
have a wrapper.

`schemaVersion` is a number the client tolerates and ignores. It is not required, is never
validated, and no behaviour depends on it. Send it so a future client can branch on it.

Unknown fields are ignored in silence. A field whose value has the wrong type is ignored, not
coerced.

## Direction rules

Two kinds of field:

- **Settable.** The remote value replaces the local one.
- **Tighten-only.** The remote value applies only when it captures less than the local one.
  Loosening is a silent no-op.

Every tighten-only field is compared against the value the app passed to `init()`, snapshotted at
startup — never against the value a previous poll already tightened. A sequence of polls therefore
cannot ratchet a limit back up one step at a time.

## Reference: kill switch and consent

| Field                          | Type                         | Direction | Effect                                                                       |
| ------------------------------ | ---------------------------- | --------- | ---------------------------------------------------------------------------- |
| `killSwitch`                   | boolean                      | settable  | `true` clears the ring buffer, aborts the flight recorder and stops capture. |
| `consentMode` / `consent.mode` | `"implicit"` \| `"required"` | settable  | Explicit consent blocks all buffering until `consent(true)`.                 |
| `respectGpc`                   | boolean                      | settable  | Treat Global Privacy Control as required consent.                            |

### What happens to events captured before this response arrives

Capture is closed until the first policy lands, and events emitted in that
window are held in memory rather than discarded, then released once the answer
arrives. Without the hold a request issued before the policy and answered after
it kept its `net.res` and lost its `net.req`, which is how a first screen ends
up recorded as responses with no calls behind them.

Release re-asks the policy questions against the events it held, because they
were built under the local config:

| The response says                     | What happens to a held event                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `collectors.<name>: false`            | Events of that collector are dropped.                                                                                                           |
| `network.excludeUrls`                 | A held request for a matching URL is dropped. Matched against the URL the application asked for, not the redacted copy on the event.            |
| `network.captureHeaders: false`       | `d.hdrs` is removed.                                                                                                                            |
| `network.maxBodySize`                 | Bodies over the new cap become a `payload_too_large` summary. WebSocket frames and worker messages keep their own smaller ceilings.             |
| `redaction.denyFields`                | Bodies are re-redacted under the added names, and the parsed response view in `d.bodyMeta` is rebuilt from the result.                          |
| `redaction.mode`                      | Bodies are re-redacted under the named mode.                                                                                                    |
| `redaction.captureInputValues: false` | A held input value becomes a placeholder.                                                                                                       |
| `masking.*` tightened                 | Held `dom.snap`, `clk`, `inp`, `key` and `clip` events are dropped, not re-masked. They carry text rendered from a DOM that is gone by release. |
| `sampling.captureSampleRate` sheds    | The whole hold is discarded.                                                                                                                    |
| `killSwitch: true`                    | The whole hold is discarded.                                                                                                                    |

Drops are counted in a `capture_gap`, so a session says what release cost it.
Events the policy dropped are reported under reason `policy_tightened`, and
events the hold discarded to stay under its own 2,000 event cap under
`buffer_overflow`. They mean opposite things: one says the policy worked, the
other says the hold was too small for the page. The cap drops the oldest first.

Global Privacy Control ends the wait rather than extending it: under the default
`consentMode: "implicit"` a GPC visitor's hold is discarded on the first poll,
because no consent call is coming. Under `consentMode: "required"` the hold is
kept, unsent, until `consent(true)` or `consent(false)` answers.

## Reference: sampling and flight recorder

| Field                                                                                                                    | Type       | Direction | Effect                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ---------- | --------- | --------------------------------------------------------------------- |
| `sampling.captureSampleRate` (aliases `captureRate`, `rate`, top-level `captureSampleRate`, `captureRate`, `sampleRate`) | number 0–1 | settable  | Session sampling rate for capture candidates.                         |
| `sampling.baselineSampleRate` (aliases `baselineRate`, top-level `baselineSampleRate`, `baselineRate`)                   | number 0–1 | settable  | Trigger-free baseline session rate.                                   |
| `flightRecorder`                                                                                                         | boolean    | settable  | Arm the flight recorder.                                              |
| `flightRecorderTailMs` / `tailDurationMs` / `tailMs` / `triggers.tailSeconds`                                            | number     | settable  | Tail kept after a trigger. `tailSeconds` is seconds; the rest are ms. |

## Reference: auto-flag triggers

Under `triggers`, each accepting `true`, `false`, or `{ "enabled": true }`:

`error` (`errors`, `onError`), `uncaughtError`, `unhandledRejection`, `request5xx`,
`renderedError` (`renderedErrors`, `onRenderedError`), `caughtError` (`caughtErrors`,
`onCaughtError`), `responseBodyError` (`responseBodyErrors`, `onResponseBodyError`),
`streamFailure` (`streamFailures`, `onStreamFailure`), `workerError` (`workerErrors`,
`onWorkerError`), `wrongNumber` (`wrongNumbers`, `onWrongNumber`), `resourceLoadFailure`
(`resourceLoadFailures`, `onResourceLoadFailure`), `storageFailure` (`storageFailures`,
`onStorageFailure`), `explicitBeacon`, `serverSidePull`, `signals` (`onSignals`),
`rageClick` (`rageClicks`, `onRageClick`), `retryStorm` (`retryStorms`, `onRetryStorm`),
`slowResponse` (`slowResponses`, `onSlowResponse`), `abandonedFlow` (`abandonedFlows`,
`onAbandonedFlow`).

The Cloud policy enables `caughtError`, `responseBodyError`, `streamFailure`, and
`workerError` by default. It keeps `wrongNumber`, `resourceLoadFailure`, and
`storageFailure` disabled until a project enables them.

`triggers.mask_all: true` also forces full masking. It cannot unmask.

Detector thresholds are settable at the top level: `autoFlagDebounceMs`, `autoFlagMaxPerSession`,
`rageClickThreshold`, `rageClickWindowMs`, `retryStormThreshold`, `retryStormWindowMs`,
`retryStormFailThreshold`, `slowRequestMs`, `slowRequestCount`, `slowRequestWindowMs`,
`abandonedFlowWindowMs`, `abandonedFlowMinInputs`. Each takes a finite number `>= 0`.

`trigger: true`, `triggerCapture: true`, `triggers.trigger: true` or `triggers.capture: true`
asks the client to flag a bug on this poll.

## Reference: masking and replay

| Field                                               | Type                                                                                                                                           | Direction    | Effect                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------- |
| `masking.mode` / `maskingMode` / `masking` (string) | `"all"`, `"full"`, `"mask_all"`, `"strict"`, `"masked"`, `"text"`, `"text_only"`, `"inputs"`, `"inputs_only"`, `"none"`, `"off"`, `"unmasked"` | tighten-only | The unmasking values are accepted and do nothing. |
| `masking.maskAllText`, `masking.maskAllInputs`      | boolean                                                                                                                                        | tighten-only | Only `true` is honoured.                          |
| `replayEnabled`                                     | boolean                                                                                                                                        | settable     | Session replay recording.                         |
| `replayMasking`                                     | `"inputs_masked"` \| `"text_masked"`                                                                                                           | settable     | Replay masking level.                             |

## Reference: collector switches

Under `collectors`, each a boolean, tighten-only. A collector switch at the top level of the
response is ignored — the nested object is the only place they are read.

`false` always applies. `true` applies only to a collector the app passed as `true` to `init()`,
which makes it a restore of something an earlier poll switched off. `true` for a collector the app
left off is a silent no-op: a policy cannot start capturing keystrokes, clipboard or cookies for
an app that never asked to.

`console`, `network`, `interactions`, `keystrokes`, `scroll`, `visibility`, `clipboard`,
`errors`, `performance`, `cookies`, `storage`, `heartbeat`, `uiNumbers`, `listeners`,
`eventSource`, `webSocket`, `workers`, `environment`, `campaign`, `domSnapshot`.

`video`, `audio` and `widget` are not remotely settable.

```json
{ "collectors": { "keystrokes": false, "clipboard": false } }
```

### When a switch takes effect

A switch flipped mid-session is applied on the poll that carries it, not on the next session.

**Off is always live.** The collector is torn down on that poll: listeners removed, patched
globals restored, timers cleared. Events already buffered are kept — the switch says what to
capture from here, not what to forget.

**A restore is live for every collector but one.** "Restore" is the only kind of `true` that does
anything, per the rule above.

| Collector                                                                                                                                                                                                            | Off mid-session         | Restored mid-session    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------- |
| `console`, `errors`, `interactions`, `keystrokes`, `scroll`, `visibility`, `clipboard`, `cookies`, `storage`, `network`, `heartbeat`, `uiNumbers`, `listeners`, `eventSource`, `webSocket`, `workers`, `environment` | live                    | live                    |
| `performance`                                                                                                                                                                                                        | live                    | next page load          |
| `campaign`, `domSnapshot`                                                                                                                                                                                            | no collector, see below | no collector, see below |

`performance` observes with `buffered: true`, which is what lets it report the navigation and
paint entries that fired before the SDK initialised. A second instance mid-session would replay
the whole load timeline the first one already reported, and its final vitals — `inp`, `cls.score`,
`lcp.final` — were emitted when the first one was torn down. The config value is applied either
way, so the next page load starts it.

`campaign` and `domSnapshot` are settings rather than collectors. `domSnapshot` is read when a bug
is flagged, so a change is already live. `campaign` is read by the environment snapshot, which a
session emits once, so a change reaches the next session's snapshot.

A collector switch is idempotent: a policy answering `console: true` on every poll installs one
collector, not one per poll.

Turning `environment` off also closes the environment lane for the rest of the session — no
`setEnv` deltas and no flag snapshot — because a session carrying no `env` event must not carry
env data under another name. Turning it back on emits a fresh snapshot and reopens the lane.

A collector started mid-session is built from the config as it stands after the poll, so a
throttle or limit changed on the same poll is the one it runs with.

A collector that fails to shut down cleanly is not started again for the rest of the session. A
teardown that throws part way leaves some of its patches removed and some still in place, and
starting a second copy over the half that survived would capture every event twice. The switch
is still applied to the config, so the next page load starts the collector normally.

## Reference: network limits

| Field                                              | Type          | Direction    | Effect                                                                                                       |
| -------------------------------------------------- | ------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `network.maxBodySize` / `networkMaxBodySize`       | number `>= 0` | tighten-only | Applied as `min(remote, local)`. A value above the local ceiling leaves the local one in place.              |
| `network.excludeUrls` / `networkExcludeUrls`       | string[]      | additive     | Remote entries are added to the local list. A local exclusion can never be removed, and `[]` clears nothing. |
| `network.captureHeaders` / `networkCaptureHeaders` | boolean       | tighten-only | Applied as `local && remote`. Only `false` changes anything.                                                 |

A list carrying a non-string entry is refused whole. A list longer than 256 entries is refused
whole.

## Reference: redaction

Under `redaction`:

| Field                | Type                       | Direction    | Effect                                                                                                   |
| -------------------- | -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `denyFields`         | string[]                   | additive     | Union with the local deny list. Local entries always survive.                                            |
| `mode`               | `"structured"` \| `"full"` | tighten-only | `"structured"` → `"full"` is honoured. `"full"` → `"structured"` is ignored.                             |
| `captureInputValues` | boolean                    | tighten-only | Only `false` is honoured.                                                                                |
| `keepFields`         | string[]                   | ignored      | A keep exempts a field from the deny rules, so it would widen capture. Local `keepFields` are untouched. |

All three are live on the poll that carries them. A new deny field applies to the next event any
running collector emits, including the `ui.num` scanner, and `captureInputValues: false` stops
input values being recorded from that poll rather than from the next page load.

## Reference: throttles

Top-level, settable, each a finite number `>= 0`: `keystrokeThrottleMs`, `scrollThrottleMs`.

A throttle decides how often a running collector emits, not what it puts in an event, so both
directions are allowed.

Live on the poll that carries it. The keystroke and scroll collectors read their throttle per
event, so a change reaches the collector already running rather than the next page load.

## Reference: size caps

Top-level, tighten-only, each a finite number `>= 0`, applied as `min(remote, init)`:
`clipboardMaxLength`, `storageValueMaxLength`, `stateMaxBytes`, `domSnapshotMaxBytes`.

Each one bounds how much of a captured value rests inside an event, so raising it would put more
of the user's data in the payload than `init()` agreed to. A value above the local one leaves the
local one in place.

Live on the poll that carries it. The clipboard and storage collectors read their cap per event,
so a lowered cap bounds the next event rather than the next page load's.

## Reference: ring buffer

Top-level, tighten-only against the `init()` values, applied as `min(remote, init)`:

| Field                 | Accepted               | Effect                                              |
| --------------------- | ---------------------- | --------------------------------------------------- |
| `ringBufferMs`        | whole number `>= 1000` | Retention window of the live buffer.                |
| `ringBufferMaxEvents` | whole number `>= 1`    | Event ceiling of the live buffer and the event bus. |

Anything else — `0`, `0.5`, a negative, `NaN`, `Infinity` — is ignored outright rather than
coerced, and leaves the bound where it was.

Both move the live ring buffer on the poll that carries them. Lowering either evicts oldest-first
at once, so a policy asking for less retention gets it immediately rather than as the buffer next
fills. When that eviction drops events the buffer was already holding, the session records a
`capture_gap` with `reason: "retention_reduced"` and a `droppedEventCount`, so the shortened
window is visible to whoever reads the report cut from it.

## Reference: probes

`probes` is an array of probe names. At most 4 run per poll, duplicates are dropped, an unknown
name is dropped, and one non-string entry refuses the whole field. A poll carrying `probes` and
nothing else is not a recognised policy, so its probes do not run. A current SDK binds targeted
delivery to its registered runtime identity. Cloud delivers a targeted probe only to the runtime
that started the target session. A same-origin config poll carries that binding. A different-origin
`configEndpoint`, and older SDKs that omit the binding, continue to receive untargeted project
probes.

The exact allowlist includes `runtime.env`, `runtime.cpu_profile`, `storage.snapshot`,
`network.inflight` and `flags.current`. `runtime.cpu_profile` is Node-only and requires the exact
runtime binding for the targeted session. It uses a fixed 1,000 ms sampling window and a 2,000 ms
hard deadline, and returns only `durationMs`, `sampleCount` and up to 50 bounded function rows.
Browser/core callers and untargeted or stale responses return an explicit `unavailable` result.

## Never remotely settable

These are ignored wherever they appear in a response, including inside `collectors`:

`captureRawConsole`, `captureRawErrors`, `captureRawClipboard`, `captureRawState`,
`maskAllText`/`maskAllInputs` set to `false`, `redaction.captureInputValues` set to `true`,
`redaction.keepFields`, `httpEndpoint`, `httpAuthToken`, `transport`, `configEndpoint`,
`remoteConfig`, `configPollIntervalMs`.

The transport fields are excluded so a config response can never redirect captured data, and the
poll fields so a response can never stop the client polling or point it elsewhere.

## Troubleshooting

**Nothing is delivered and a `capture_gap` with `reason: "policy_unavailable"` appears.** No poll
returned a recognised policy in time. Check the route answers `200` with at least one recognised
field.

**A setting saves in the dashboard but nothing changes in the app.** Confirm the field is in this
document, then confirm the direction: a tighten-only field with a looser value than the app's
`init()` is applied as a no-op by design.

**A collector switch has no effect at all.** `true` for a collector the app left off at `init()`
is a no-op by design — turn it on in the app's init block, then the poll can switch it off and
back on. Also check the switch is inside the nested `collectors` object rather than at the top
level, where it is ignored.

**A collector switch has no effect until reload.** Two cases are by design: restoring
`performance`, and changing `campaign`. Everything else applies on the poll. See
[When a switch takes effect](#when-a-switch-takes-effect).
