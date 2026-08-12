---
name: async-lifecycle-race
description: Diagnose an intermittent failure caused by ordering, where derived state is read after it was invalidated: a response that lands after the thing it was for went away, two writes that overwrite each other, a value that flips back. Use when the same steps sometimes work and sometimes do not. Names the Crumbtrail timing and ordering queries, and states plainly that component lifecycle is not instrumented.
---

# The async lifecycle race

Two things happen concurrently and the code assumed an order. A response arrives after the view
that requested it was torn down. A slower first request lands after a faster second one and
overwrites it. A position is read after the model it indexed into shrank. A cancelled query nulls
a slot that something else is still reading.

The defining property is that the inputs are identical and the outcome is not. That is also what
makes it the archetype most often closed as unreproducible, and the one where a recording is worth
the most, because the recording holds the ordering that the reporter could not describe.

Guard fixes for this family have a habit of creating the next one. A teardown check added to stop
a crash frequently produces a different null dereference a release later, so treat a fix here as
something to verify against a fresh recording rather than something to reason about.

## Symptom

Intermittent. The reporter says it works most of the time, or it broke once and they cannot make
it happen again, or it only happens when the network is slow, or only when they click twice, or
only when they navigate away quickly.

The visible failure is usually one of: a null or undefined dereference in a stack that mentions a
callback or a promise handler, a value that appears and then reverts, a spinner that never
resolves, or a duplicate of something that should have happened once.

## What Crumbtrail can see

The limitation first. There is no framework lifecycle instrumentation. Crumbtrail does not record
component mount or unmount, effect teardown, promise identity, subscription disposal, or which
await resumed after which. If your hypothesis is "the component unmounted mid flight", the
recording cannot confirm the unmount. It can confirm the flight and the navigation, and that is
usually enough.

What it does carry, and this archetype lives almost entirely on it:

- Every request with a start record and an end record, carrying method, URL, status and a duration
  in milliseconds. Two overlapping requests to the same endpoint, and which one finished last, are
  both plainly visible.
- Unhandled rejections and uncaught errors with the message and the full stack, which usually
  names the callback that ran too late.
- Navigation events with their transition, and page visibility changes.
- Clicks and inputs with timestamps, so a double submit is countable rather than inferred.
- Backend request start, end and error records with durations, where the backend SDK is installed.
- Row changes carrying the request id that produced them, where the database adapter is installed,
  which is what lets you say two requests wrote the same row and in which order.

Detectors that name this archetype, and that appear in the candidate list by these names, are
`response_race`, `pending_request`, `inflight_request_invalidated_by_session_rotation`,
`state_flip_flop`, `lost_update`, `concurrent_duplicate_mutation`, `request_reconnect_storm`,
`stream_desync` and `retry_loop_against_success`.

## Call sequence

Races repeat, so the cheapest first question is whether this one has been seen before. Group the
same failure across recordings, then pull the history of whichever signature matches:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the list above>" } }
]
```

Then get to the throw. Error context groups each error or rejection with what surrounded it, and
the window and budget parameters keep a noisy session from filling the context:

```json
{
  "tool": "getErrorContext",
  "params": { "sessionId": "<sessionId>", "windowMs": 4000, "limit": 5, "maxTokens": 6000 }
}
```

Read a tight window around the failure. Tight matters here more than anywhere else: the whole
question is what the neighbouring few hundred milliseconds contained, and a wide window buries it:

```json
{
  "tool": "getWindow",
  "params": {
    "sessionId": "<sessionId>",
    "t0": 1785323596000,
    "t1": 1785323597500,
    "maxTokens": 6000
  }
}
```

When the window is busy and you cannot tell which of the events in it matter, ask what moved rather
than reading them all. This holds the window against the quiet stretch before it and ranks the event
kinds and numeric fields whose rate or distribution changed. It is the right call when the ranked
bundle surfaced no candidate that explains the symptom. Every row is a correlation and never a
cause, and an empty row list means nothing cleared the significance cut rather than that the session
is healthy:

```json
{
  "tool": "getWindowCorrelation",
  "params": {
    "sessionId": "<sessionId>",
    "t0": 1785323596000,
    "t1": 1785323597500,
    "maxTokens": 6000
  }
}
```

Now check the ordering directly. Pull the request and response streams and look for two requests
to the same endpoint whose lifetimes overlap:

```json
[
  { "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "net.req", "limit": 200 } },
  { "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "net.res", "limit": 200 } }
]
```

If the two sides disagree about a request, the link report names which side is missing and why:

```json
{
  "tool": "getLinkedRequestContext",
  "params": { "sessionId": "<sessionId>", "requestId": "<request id>" }
}
```

A request id with no counterpart on the other side comes back with a not found status rather
than an error, and still carries the whole session gap summary and the gap list, so the call is
worth making even when you are unsure the id is the right one.

Finally, the ranked bundle, which is where the race detectors above surface with the evidence they
matched on:

```json
{ "tool": "getFixContext", "params": { "sessionId": "<sessionId>", "maxTokens": 8000 } }
```

## Telling it apart

The separating observation is repeatability, and you can often settle it without a second
recording by counting occurrences of the same steps within one.

If the same steps in the same recording produced the right result once and the wrong result
another time, it is a race. If every attempt in the recording failed the same way, it is not, and
the intermittency the reporter described belongs to something upstream such as which route or
which build they were on.

If the failure is stable until a reload and then goes away, that is stale derived state, not a
race, even though both get reported as flaky.

If a response body is missing a field the code then dereferenced, the ordering is a red herring and
this is a missing key detonation. Check the body before you chase timing.

If the status reported success while the work did not happen, and it does so every time, that is
lying status. A race can produce the same picture, so the tell is consistency: lying status is
reliable, a race is not.

Distinctions that turn on component lifecycle cannot be made from telemetry alone. If the answer is
"was this component still mounted", the recording will not say. What settles it is the stack on the
rejection, the navigation event immediately before it, and reading the teardown code.

## What a null result means

An empty `getErrorContext` result means nothing threw and nothing rejected during the recording. A
race that resolves to a wrong value rather than an exception produces a perfectly clean session, so
a clean error context is weak evidence of health and is entirely compatible with this archetype.
Move to ordering: compare request lifetimes yourself.

An empty `getRecurrence` result means this signature has not been seen in another recording, which
for an intermittent failure most often means it has been captured once. It does not mean the
failure is new.

An empty `getFixContext` signal list means no detector matched. The race detectors need both racing
operations inside the recorded window. A recording that started after the first request began
cannot show the overlap.

If everything is empty: widen the window, confirm capture covered the moment the reporter
described, and if the failure genuinely did not recur in the recording, say that the recording does
not contain the event rather than concluding the code is fine.
