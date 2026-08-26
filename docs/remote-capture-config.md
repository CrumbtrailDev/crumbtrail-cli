# Remote capture config schema

The browser SDK polls `<httpEndpoint>/api/capture-config?projectKey=<key>` and applies the
capture policy it finds there. This document is the schema that endpoint answers with.

Applies to `crumbtrail-core` 0.40.0 and later. Schema version: **2**.

## Prerequisites

- The app initialises with `remoteConfig: true` (the default) and a `httpEndpoint` plus
  `httpAuthToken`. Without both, no poll is made and the local config is the whole policy.
- The endpoint answers `200` with JSON. `4xx` and `5xx` are ignored and the last known policy
  stands.

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
2. Reload the app and watch the network tab for `GET /api/capture-config`. The SDK sends
   `cache: "no-store"`, so every poll is a real request.
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

| Field | Type | Direction | Effect |
| --- | --- | --- | --- |
| `killSwitch` | boolean | settable | `true` clears the ring buffer, aborts the flight recorder and stops capture. |
| `consentMode` / `consent.mode` | `"implicit"` \| `"required"` | settable | Explicit consent blocks all buffering until `consent(true)`. |
| `respectGpc` | boolean | settable | Treat Global Privacy Control as required consent. |

## Reference: sampling and flight recorder

| Field | Type | Direction | Effect |
| --- | --- | --- | --- |
| `sampling.captureSampleRate` (aliases `captureRate`, `rate`, top-level `captureSampleRate`, `captureRate`, `sampleRate`) | number 0–1 | settable | Session sampling rate for capture candidates. |
| `sampling.baselineSampleRate` (aliases `baselineRate`, top-level `baselineSampleRate`, `baselineRate`) | number 0–1 | settable | Trigger-free baseline session rate. |
| `flightRecorder` | boolean | settable | Arm the flight recorder. |
| `flightRecorderTailMs` / `tailDurationMs` / `tailMs` / `triggers.tailSeconds` | number | settable | Tail kept after a trigger. `tailSeconds` is seconds; the rest are ms. |

## Reference: auto-flag triggers

Under `triggers`, each accepting `true`, `false`, or `{ "enabled": true }`:

`error` (`errors`, `onError`), `uncaughtError`, `unhandledRejection`, `request5xx`,
`renderedError` (`renderedErrors`, `onRenderedError`), `explicitBeacon`, `serverSidePull`,
`signals` (`onSignals`), `rageClick` (`rageClicks`, `onRageClick`), `retryStorm` (`retryStorms`,
`onRetryStorm`), `slowResponse` (`slowResponses`, `onSlowResponse`), `abandonedFlow`
(`abandonedFlows`, `onAbandonedFlow`).

`triggers.mask_all: true` also forces full masking. It cannot unmask.

Detector thresholds are settable at the top level: `autoFlagDebounceMs`, `autoFlagMaxPerSession`,
`rageClickThreshold`, `rageClickWindowMs`, `retryStormThreshold`, `retryStormWindowMs`,
`retryStormFailThreshold`, `slowRequestMs`, `slowRequestCount`, `slowRequestWindowMs`,
`abandonedFlowWindowMs`, `abandonedFlowMinInputs`. Each takes a finite number `>= 0`.

`trigger: true`, `triggerCapture: true`, `triggers.trigger: true` or `triggers.capture: true`
asks the client to flag a bug on this poll.

## Reference: masking and replay

| Field | Type | Direction | Effect |
| --- | --- | --- | --- |
| `masking.mode` / `maskingMode` / `masking` (string) | `"all"`, `"full"`, `"mask_all"`, `"strict"`, `"masked"`, `"text"`, `"text_only"`, `"inputs"`, `"inputs_only"`, `"none"`, `"off"`, `"unmasked"` | tighten-only | The unmasking values are accepted and do nothing. |
| `masking.maskAllText`, `masking.maskAllInputs` | boolean | tighten-only | Only `true` is honoured. |
| `replayEnabled` | boolean | settable | Session replay recording. |
| `replayMasking` | `"inputs_masked"` \| `"text_masked"` | settable | Replay masking level. |

## Reference: collector switches

Under `collectors`, each a boolean. A collector switch at the top level of the response is
ignored — the nested object is the only place they are read.

`console`, `network`, `interactions`, `keystrokes`, `scroll`, `visibility`, `clipboard`,
`errors`, `performance`, `cookies`, `storage`, `heartbeat`, `uiNumbers`, `listeners`,
`eventSource`, `webSocket`, `workers`, `environment`, `campaign`, `domSnapshot`.

`video`, `audio` and `widget` are not remotely settable.

```json
{ "collectors": { "keystrokes": false, "clipboard": false, "campaign": true } }
```

A collector turned off by a policy stops producing events from the point the collector is next
set up. Live start and stop mid-session lands in a later release; until then, a switch flipped
mid-session takes effect on the next session.

## Reference: network limits

| Field | Type | Direction | Effect |
| --- | --- | --- | --- |
| `network.maxBodySize` / `networkMaxBodySize` | number `>= 0` | tighten-only | Applied as `min(remote, local)`. A value above the local ceiling leaves the local one in place. |
| `network.excludeUrls` / `networkExcludeUrls` | string[] | additive | Remote entries are added to the local list. A local exclusion can never be removed, and `[]` clears nothing. |
| `network.captureHeaders` / `networkCaptureHeaders` | boolean | tighten-only | Applied as `local && remote`. Only `false` changes anything. |

A list carrying a non-string entry is refused whole. A list longer than 256 entries is refused
whole.

## Reference: redaction

Under `redaction`:

| Field | Type | Direction | Effect |
| --- | --- | --- | --- |
| `denyFields` | string[] | additive | Union with the local deny list. Local entries always survive. |
| `mode` | `"structured"` \| `"full"` | tighten-only | `"structured"` → `"full"` is honoured. `"full"` → `"structured"` is ignored. |
| `captureInputValues` | boolean | tighten-only | Only `false` is honoured. |
| `keepFields` | string[] | ignored | A keep exempts a field from the deny rules, so it would widen capture. Local `keepFields` are untouched. |

## Reference: throttles and size limits

Top-level, settable, each a finite number `>= 0`:

`keystrokeThrottleMs`, `scrollThrottleMs`, `clipboardMaxLength`, `cookieValueMaxLength`,
`storageValueMaxLength`, `stateMaxBytes`, `domSnapshotMaxBytes`, `ringBufferMs`,
`ringBufferMaxEvents`.

`ringBufferMs` and `ringBufferMaxEvents` change the configured values; the live ring buffer keeps
the size it was constructed with until the next session.

## Reference: probes

`probes` is an array of probe names. At most 4 run per poll, duplicates are dropped, an unknown
name is dropped, and one non-string entry refuses the whole field. A poll carrying `probes` and
nothing else is not a recognised policy, so its probes do not run.

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

**A collector switch has no effect until reload.** Expected in this release. See
[Reference: collector switches](#reference-collector-switches).
