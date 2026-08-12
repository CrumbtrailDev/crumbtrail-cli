---
name: scale-cliff
description: Diagnose a failure that works at small size and dies at a round number, where a fixed timeout, a parameter cap, a row maximum, an identifier length limit or an operation sized for the median account becomes fatal for a large one. Use when a flow works for most accounts and fails for the biggest, when something truncates or returns short, or when a job never finishes for one tenant.
---

# The silent hard limit and scale cliff

The code is correct for the median account and fatal for the large one. A fixed timeout, a cap on
bound parameters, an identifier length limit, a row maximum, a counter that overflows, or an
operation whose cost grows with a dimension nobody sized for. It does not degrade. It works, and
then at some size it does not.

## Symptom

The reporter says it works for them and not for a colleague, or that it worked until the account
grew. A request times out only for the largest tenant. An export comes back short. A list stops at
a suspiciously round count. A name is accepted and then appears truncated. A job stays in
progress forever for one customer and finishes everywhere else.

The tell to look for later is that failure tracks a size rather than a time.

## What Crumbtrail can see

Every request carries its timing, so a session shows exactly where duration climbed and where a
request stopped completing. Named detector signals aimed at this shape include `slow_request`,
`latency_outlier`, `pending_request`, `result_row_loss`, `response_exceeded_requested_limit`,
`response_count_mismatch`, `pagination_first_page_offset`, `accepted_text_was_truncated`,
`job_did_not_complete`, `job_drain_left_work_deferred`, `n_plus_one_query` and
`request_reconnect_storm`.

Where the database adapter is installed, the session carries the rows that changed and the query
activity that changed them, which is how an operation whose cost grows per row becomes visible.
Where the backend integration is installed, backend spans carry the server side timing for the
same request.

It does not see server memory, processor load, connection pool occupancy, garbage collection, or
a database query plan. It cannot tell you the value of the limit. It can tell you the input size
at which the request stopped succeeding, which is usually enough to name the dimension and let
the code reveal the constant.

One capture bound matters enough to state before you use it. A response body larger than the
configured maximum is summarised rather than stored, and the summary records that reason. A short
looking body is therefore not proof that the application truncated anything. Read the body summary
reason first, and only call it product truncation when the reason is not a capture size bound.

## Call sequence

Begin with the manifest, which names the signals that fired and gives you the evidence windows to
drill into:

```json
[
  { "tool": "getSessionManifest", "params": { "sessionId": "<sessionId>" } },
  { "tool": "getEvidence", "params": { "sessionId": "<sessionId>", "ref": "cand_0001" } }
]
```

Then read the timing and the shape of what came back. `getFixContext` returns the ranked bundle
including database row activity in one call, which is the efficient move once you know the
session matters:

```json
[
  { "tool": "getFixContext", "params": { "sessionId": "<sessionId>", "maxTokens": 12000 } },
  { "tool": "getFailedRequests", "params": { "sessionId": "<sessionId>", "maxTokens": 4000 } }
]
```

Read the window around the slow or incomplete request to see what else was in flight, since a
cliff frequently arrives as a burst rather than as one call:

```json
{
  "tool": "getWindow",
  "params": {
    "sessionId": "<sessionId>",
    "t0": 1785436515000,
    "t1": 1785436525000,
    "limit": 500,
    "maxTokens": 8000
  }
}
```

The confirming observation is that the failure concentrates on one account. Group across sessions
and filter by tenant:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session", "tenant": "<tenant>" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the rollup>", "tenant": "<tenant>" } }
]
```

A rollup whose sessions all carry one tenant label is a cliff. A rollup spread across tenants
inside one time window is the neighbour described below.

## Telling it apart

**The infrastructure weather event** is the neighbour that gets confused with this one most
often, and the confusion is costly because the fix lives in a different team. Weather makes a
whole class of unrelated operations slow at once, with clean application logs, and it clusters in
a time window across many tenants. A cliff clusters on one large tenant and tracks a size. Use
the tenant labels in the recurrence rollup as the discriminator: same time, many tenants means
weather; many times, one tenant means a cliff.

**The async lifecycle race** also produces a request that never resolves, but a race is
nondeterministic at the same size, while a cliff is reproducible at the same size. If retrying
the identical input sometimes works, it is not a hard limit.

**The lying status** overlaps when a job reports complete with nothing done. If the work stopped
at a boundary and the status still says complete, both are present: the cliff is the cause and
the untruthful status is why it went unnoticed. Report both.

**A hostile identifier landmine** shares the truncation symptom. The discriminator is which
dimension moved: a length cap on one name is that archetype, a row or parameter count is this
one.

Where the distinction turns on the limit's actual value, telemetry cannot supply it. Name the
dimension and the observed threshold, then read the constant out of the code or the driver.

## What a null result means

No `slow_request` and no `latency_outlier` means nothing crossed the threshold inside the
recorded window. A request that had not completed when capture stopped is recorded as a pending
request rather than a slow one, so a quiet timing picture with a pending request in it is exactly
the shape of the worst cliffs.

An empty database section usually means the database adapter is not installed for that service,
not that no rows were touched. Confirm the session carries any database activity before treating
an empty picture as evidence about the query cost.

A short response body with a capture size reason in its summary tells you about the recorder, not
the application. That single misreading is the most likely wrong conclusion this skill can lead
to, so check it before you write anything down.

If everything is empty, reproduce at the size the reporter described, confirm capture was running
for the whole operation rather than only its start, and otherwise move to the infrastructure
weather neighbour, whose signature is clean application evidence and a broad blast radius.
