---
name: lying-status
description: Diagnose a failure where the reported status disagrees with the work, because status is written on a separate path from the work itself: success shown on failure, in progress forever, sync complete with zero rows, a 200 followed by a mid stream error. Use when an action was acknowledged and the effect is absent or partial. This is the archetype Crumbtrail carries the most direct evidence for.
---

# The lying status

Status and work travel on different paths. The work is a write, a job, a stream, a sync. The
status is a flag, a response code, a progress record, a toast. Nothing makes the two atomic, so
whenever the work fails after the status was committed, or the status is computed from something
other than the work, the two diverge and the interface reports something that did not happen.

This is the archetype Crumbtrail is strongest on, for a structural reason: the product records the
status plane and the work plane separately and can therefore contradict one with the other. Most
of the queries below exist to put those two planes side by side.

## Symptom

The interface said saved, sent, applied, synced, imported, complete, or showed a green check. The
effect is missing, partial, or smaller than reported. Nothing errored.

Variants that are the same archetype: a progress record stuck at in progress with nothing running
behind it; an import that reports a row count larger than the rows that exist; a job marked done
that left work behind; a response with a success status whose body describes a failure.

## What Crumbtrail can see

The status plane and the work plane, and both are ordinary parts of a recording:

- The status plane: response status codes, response bodies, console output, and the interface
  events around them. Bodies are summarized when large and sensitive fields are replaced with a
  redaction marker, but a count or a flag in a body normally survives intact.
- The work plane, where the database adapter is installed: row changes with the table, the primary
  key, the operation, the before and after column values, the request id that caused them and the
  call site file and line. This is the ground truth a status can be checked against.
- The middle: backend request start, end and error records with the route, the status code and the
  duration, where the backend SDK is installed. This is what tells you whether the status came from
  the same process that did or did not do the work.

Detectors that name this archetype directly, and that appear in the candidate list under these
names, are `acknowledged_write_never_landed`, `acknowledged_write_lost`,
`acknowledged_batch_rows_missing`, `acknowledged_state_contradicted_by_read`,
`response_count_mismatch`, `derived_count_below_observed_inserts`, `counter_contradiction`,
`report_total_contradicts_source_row`, `job_did_not_complete`, `job_drain_left_work_deferred`,
and `downstream_succeeded_after_timeout`.

What it cannot see, and this is the load bearing caveat for the whole skill: work that happens
outside a recorded process. A queue consumer, a scheduled job, a second service without the backend
SDK, or a write made by a database client the adapter does not wrap are all invisible. In every one
of those cases the absence of a row change means only that this recorder saw no write, and reading
it as proof that no write happened will produce a confident wrong answer.

Equally, without the database adapter there is no work plane at all, only the status plane, and the
central move of this skill is unavailable. Check for that before you plan around it.

## Call sequence

Start from the newest failure, or narrow by app if you have one:

```json
[
  { "tool": "getLatestIssue", "params": { "maxTokens": 4000 } },
  { "tool": "listSessions", "params": { "app": "checkout", "limit": 20 } }
]
```

Read the manifest first, and read the event counts in it before anything else. They tell you
whether the work plane exists in this recording, which decides whether the rest of the sequence can
answer the question at all:

```json
{ "tool": "getSessionManifest", "params": { "sessionId": "<sessionId>" } }
```

Take the ranked bundle. The detectors above surface here, and the ones whose names begin with
acknowledged are precisely this archetype already matched for you:

```json
{ "tool": "getFixContext", "params": { "sessionId": "<sessionId>", "maxTokens": 8000 } }
```

Drill into the candidate the bundle ranked first. The `ref` is a candidate id such as `cand_0001`,
and the reply carries the anchor and the evidence window behind the match:

```json
{ "tool": "getEvidence", "params": { "sessionId": "<sessionId>", "ref": "cand_0001" } }
```

Now put the two planes side by side. Pull the row changes and compare them against what the
response claimed:

```json
{ "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "db.diff", "limit": 100 } }
```

If the response reported success and no row change carries its request id, the link report will
tell you whether the request even reached an instrumented backend, which separates a lost write
from an uninstrumented one:

```json
{
  "tool": "getLinkedRequestContext",
  "params": { "sessionId": "<sessionId>", "requestId": "<request id from the response>" }
}
```

A request id with no counterpart on the other side comes back with a not found status rather
than an error, and still carries the whole session gap summary and the gap list, so the call is
worth making even when you are unsure the id is the right one.

Lying status is systemic rather than incidental, so it is worth asking whether the same signature
has appeared elsewhere before you write the diagnosis:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the list above>" } }
]
```

## Telling it apart

If something threw, this is not it. A rejection or an uncaught error means the failure announced
itself, and you want the missing key archetype or the race archetype. Lying status is silent by
definition.

If the row change is present and only the screen disagrees, the write landed and the read is
behind. That is stale derived state.

If the status lies on one route or one release and tells the truth on another, treat it as a parity
gap first and this archetype second, because the fix lands in a different place.

If the reported value is present but wrong in shape, scale or day rather than absent, this is a
format boundary problem.

Within this archetype, one distinction is worth making explicitly because the fix differs. Either
the status was written before the work could fail, or the status was computed from something other
than the work. The first shows up as a success response with a later error or timeout on the same
request id. The second shows up as a count in a body that does not match the rows that changed.

The distinction that cannot be made from telemetry alone is whether an absent row change means the
write failed or means the writing process was never instrumented. Nothing in the recording settles
that. What settles it is checking which services have the backend SDK and the database adapter
installed, and saying which you checked.

## What a null result means

An empty row change result is the reading that goes wrong most often. It means this recorder
observed no write. It does not mean no write occurred. Confirm the database adapter is present via
the manifest event counts before you treat it as evidence.

An empty failed request list is the expected result for this archetype, not a surprise. The
defining property is that the request succeeded. A clean network plane is consistent with the
status lying, and is in fact mildly supportive of it.

An empty console and error stream mean nothing was thrown or logged at error level, which is again
the normal shape here rather than a sign of health.

An empty recurrence result means the signature has not been seen in another recording, not that the
problem is isolated.

If everything is empty: confirm capture was running for the action the reporter described, widen the
window to include whatever the status claimed to do afterwards, and if the work happens in a
process this recording does not cover, say that plainly and name the process. That is the correct
answer, and it is far more useful than a diagnosis built on an absence you cannot interpret.
