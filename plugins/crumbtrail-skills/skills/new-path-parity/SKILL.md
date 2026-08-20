---
name: new-path-parity
description: Diagnose a failure that appears only on a rewritten or second implementation of a surface, where the new path silently omits behaviour the old path had. Use when a reporter says a feature works on the old screen, the old route, the old renderer or the previous release, and not on the new one. Explains which Crumbtrail queries separate a parity gap from a plain regression, and says plainly that Crumbtrail cannot see which code path served a request.
---

# The new path parity gap

A surface gets reimplemented: a second renderer, a new route, a rewritten editor, a v2 engine
behind the same button. The new implementation covers the common cases and quietly drops
behaviours the old one had. Parity patches then arrive one property at a time, and the class
refills every time a feature lands on the old path only.

The triage question for this archetype is unusual. Before you ask what the bug is, ask which
path served the failing action. Everything below is about answering that from a recording.

## Symptom

The reporter says the feature works one way and not another: on the old screen but not the new
one, on the previous release but not this one, in the classic view but not the rebuilt view.
The steps are the same. The data is the same. Only the surface changed.

A second common phrasing: a property the reporter relies on is simply not there any more. No
error, no failure, just an option that stopped being honoured.

## What Crumbtrail can see

Crumbtrail has no concept of a code path. It records one browsing session at a time and cannot
tell you which module, component tree or engine version handled a request. Nothing in a
recording says v1 or v2. If a skill told you otherwise it would be wrong.

What a recording does carry, and what makes the comparison possible:

- Navigation events with the exact URL and the transition that produced it, so two runs can be
  aligned by route.
- Every request and response with method, URL, status, duration and body. Bodies are summarized
  when large and fields are replaced with a redaction marker when the policy considers them
  sensitive, so you can rely on the presence and shape of a field more than on its value.
- An environment snapshot taken in the browser: user agent, browser name and version, operating
  system, viewport, locale and time zone.
- Backend request start, end and error records, but only where the backend SDK is installed.
- Database row changes with the table, the primary key, the before and after column values and a
  call site file and line, but only where the database adapter is installed.
- `listSessions` accepts `release` and `build` filters, which is the one place a recording carries
  a version label at all, and only when the app supplied one.

What it does not carry: the source of either implementation, feature flag state unless the app
sent it in a body or wrote it to storage, and any signal that two implementations exist. Parity
is a comparison you set up, not a fact the product detects.

No detector names a parity gap. Detectors that do fire on its downstream symptoms, and that you
will see named in the candidate list, are `ui_api_divergence`, `displayed_field_mismatch`,
`db_write_read_column_split`, `result_row_loss` and `stale_client_build`.

One operational limit worth knowing before you plan the work: `getRegressionContext` and
`recallIssueContext` read the session tree directly and are refused when the server is running
against the hosted store. Both are available when you are reading local recordings.

## Call sequence

Find the two runs you want to compare. If the app labels its builds, the `release` and `build`
filters are the cheapest way to get one session per implementation:

```json
[
  { "tool": "listSessions", "params": { "app": "checkout", "release": "2026.7", "limit": 10 } },
  { "tool": "listSessions", "params": { "app": "checkout", "release": "2026.8", "limit": 10 } }
]
```

Diff them. This is the call the archetype exists for. It aligns the two flows step by step and
reports divergences by plane, so a step present in the working run and absent in the failing run
comes back as an explicit missing step rather than something you infer:

```json
{
  "tool": "getRegressionContext",
  "params": { "sessionA": "<working session>", "sessionB": "<failing session>" }
}
```

Read the manifest of the failing run before pulling anything large. It reports the event counts
per kind, which tells you whether the backend and database planes are present at all:

```json
{ "tool": "getSessionManifest", "params": { "sessionId": "<failing session>" } }
```

Then take the ranked bundle for the failing run, and drill into whichever candidate the
divergence pointed at. The `ref` is a candidate id from that bundle:

```json
[
  { "tool": "getFixContext", "params": { "sessionId": "<failing session>", "maxTokens": 6000 } },
  { "tool": "getEvidence", "params": { "sessionId": "<failing session>", "ref": "cand_0001" } }
]
```

No detector names a parity gap, so the ranked bundle will often surface nothing that explains the
symptom. That is the case `getWindowCorrelation` exists for. Give it the window around the failing
action and it reports which event kinds and numeric fields moved against the quiet stretch before
it, with no detector involved. Every row is a correlation and never a cause, so confirm anything it
raises against the raw events before you act on it:

```json
{
  "tool": "getWindowCorrelation",
  "params": {
    "sessionId": "<failing session>",
    "t0": 1785428782855,
    "t1": 1785429039806,
    "maxTokens": 6000
  }
}
```

When the divergence is a request that behaved differently, check whether the browser side and the
server side agree on it. The gap types in the reply name which side is missing:

```json
{
  "tool": "getLinkedRequestContext",
  "params": { "sessionId": "<failing session>", "requestId": "<request id>" }
}
```

A request id with no counterpart on the other side comes back with a not found status rather
than an error, and still carries the whole session gap summary and the gap list, so the call is
worth making even when you are unsure the id is the right one.

If only one session exists, you cannot do parity work yet. Say so and ask for a recording of the
path that works. That is a legitimate answer and a much better one than guessing.

## Telling it apart

Four neighbours produce the same report. Each is separated by one observation.

If the same action fails on every route and every build, this is not a parity gap. It is an
ordinary defect and the comparison will waste your time.

If the failing run shows the write landing in the database while the screen disagrees, the new
path is not missing a behaviour, it is reading stale state. Go to the stale derived state
archetype instead.

If the failing run returns a success status with no matching row change, the status is lying and
the parity framing is a distraction. Go to the lying status archetype.

If the same steps sometimes succeed and sometimes fail on the same build, it is a race, not a
parity gap. Parity gaps are deterministic per path.

The distinction this archetype most often needs and cannot make from telemetry alone is which
implementation actually ran. Nothing in the recording carries that. What settles it is a version
or flag value the app itself emitted, a route that differs between the two runs, or reading the
routing code. Say which of those you used.

## What a null result means

An empty divergence list from `getRegressionContext` means the two recordings did not differ in
the planes it compares, which are the flow steps, the requests and the row changes. It does not
mean the implementations match. Two runs that took different routes to the same screen will align
poorly and report noise; two runs of different lengths will report the extra steps as missing.
Read the alignment counts before you read the divergences.

An empty `listSessions` result for a release filter usually means the app never sent a release
label, not that no session exists for that release. Drop the filter and match on time instead.
Check `unavailable` on the result first: when it is set the read stopped early and the list is
partial, so an empty list there says nothing about what the app recorded.

Missing backend or database event kinds in the manifest mean those SDKs are not installed in the
recorded environment. That is a gap in instrumentation, not evidence that the new path skipped a
write.

If everything comes back empty: widen the time range on `listSessions`, confirm capture was
running for the reported action, and if you still have only one usable recording, stop and ask
for a recording of the working path rather than reasoning about a comparison you cannot run.
