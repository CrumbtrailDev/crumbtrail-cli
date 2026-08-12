---
name: stale-derived-state
description: Diagnose a change that does not take effect until a reload, a logout or a navigation away and back, because a cache or a piece of derived state has no invalidation hook on write. Use when a save appears to work but the screen keeps showing the old value. Names the Crumbtrail queries that prove the write landed, and states plainly that in memory caches are invisible to the recording.
---

# The stale cache or derived state that never invalidates

Something is written. Something else is derived from it and was computed earlier. The write path
never tells the derived thing to recompute, so the screen, the session config, the lookup table or
the client store keeps serving the value it already had. A reload rebuilds everything from source
and the problem disappears, which is exactly why it gets reported as intermittent when it is not.

The diagnostic move is to prove the write landed and the read did not reflect it. Crumbtrail is
good at the first half and only partly good at the second.

## Symptom

A user changes a setting, renames something, toggles a permission or saves a record. The
interface accepts it. The new value does not appear. Reloading the page, logging out and back in,
or navigating away and returning makes it appear.

A second phrasing is the opposite direction: a value that should have been cleared keeps coming
back, or a list that should now be empty keeps rendering its previous contents.

## What Crumbtrail can see

The honest limitation first, because it decides how you spend the next few turns. The cache that
failed to invalidate is usually an in memory object: a client store, a module scoped map, a
memoized selector, a server side lookup table. None of that is recorded. Crumbtrail instruments
the boundaries a value crosses, not the heap it sits in. If the value never crossed a boundary,
the recording cannot show it to you.

What the recording does carry, all of which are boundaries a stale value tends to cross:

- Storage writes with the storage type, the operation, the key, and the old and new values. Keys
  and values that look sensitive come back replaced with a redaction marker, so you may see that a
  key changed without seeing what it changed to.
- Cookie changes.
- Every request and response, so the write and the later read are both present with their bodies.
  This is the strongest available proxy: a read issued after the write that returns the old value
  proves the staleness is on the server or in a shared cache rather than in the browser, and a
  read that never happens at all proves the opposite.
- Navigation events, which matter because this archetype is defined by what a reload fixes.
- Database row changes with before and after column values, but only where the database adapter is
  installed. This is what turns "the write probably landed" into a fact.

Detectors that name this archetype directly, and that you will see in the candidate list, are
`stale_value_rendered`, `stale_value_writeback`, `cached_empty_result_after_data_arrived`,
`stale_view_after_pop`, `acknowledged_state_contradicted_by_read` and `stale_client_build`.

What it cannot see: the contents of a client store, whether a query cache key was invalidated,
whether a memo was recomputed, and the value of any variable that was neither logged nor sent.
When the answer turns on one of those, say so and name the read request as the closest proxy.

## Call sequence

Start from whichever entry point matches what you were handed:

```json
[
  { "tool": "getLatestIssue", "params": { "maxTokens": 4000 } },
  { "tool": "listSessions", "params": { "app": "settings", "limit": 20 } }
]
```

Take the ranked bundle. The detectors listed above surface here by name, and a candidate carries
the window and anchor you need for the calls that follow:

```json
{ "tool": "getFixContext", "params": { "sessionId": "<sessionId>", "maxTokens": 6000 } }
```

Prove the write landed. Row changes carry the table, the primary key, the before and after values
and the call site that produced them, so an update present here with a screen that disagrees is
the archetype confirmed rather than suspected:

```json
{ "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "db.diff", "limit": 50 } }
```

Then look at what the browser kept. A storage value written once at login and read for the rest of
the session is the classic client side instance of this archetype:

```json
[
  { "tool": "getStorageChanges", "params": { "sessionId": "<sessionId>", "limit": 100 } },
  { "tool": "getStorageSnapshot", "params": { "sessionId": "<sessionId>", "maxTokens": 4000 } },
  { "tool": "getCookieChanges", "params": { "sessionId": "<sessionId>", "limit": 50 } }
]
```

Read the window that spans the write and the next read of the same value. Absolute milliseconds,
and a token budget so a busy window does not swamp the context:

```json
{
  "tool": "getWindow",
  "params": {
    "sessionId": "<sessionId>",
    "t0": 1785323596000,
    "t1": 1785323606000,
    "maxTokens": 6000
  }
}
```

The question that window answers is binary. Either a refetch of the changed resource appears after
the write, or it does not. If it does and the response still holds the old value, the stale copy is
upstream of the browser. If no refetch appears at all, nothing asked for the new value and the
staleness is local.

## Telling it apart

If a reload fixes it, this archetype is live. If a reload does not fix it, the value is genuinely
wrong at the source and you are in lying status territory instead.

If the write produced no row change and the response still reported success, the write never
landed. That is the lying status archetype, not this one, and the fix is in a completely different
place.

If the same steps produce the correct value sometimes and the old value other times, ordering is
varying between runs and this is an async lifecycle race. Staleness is stable; races are not.

If the old value appears only on one route or one release while another shows the new one, suspect
a parity gap between two implementations of the same screen.

If the value is present and current but rendered in the wrong shape, wrong unit or wrong day, this
is a format boundary problem and none of the queries above will help.

## What a null result means

An empty `getStorageChanges` result means nothing was written to browser storage during the
recording. Most caches never touch storage, so empty here is the ordinary case and rules out
almost nothing. Do not read it as evidence of health.

An empty `getEvents` result for `db.diff` has two very different causes: no row changed, or the
database adapter is not installed in the recorded environment. Check the event counts in
`getSessionManifest` before choosing between them. Treating an uninstrumented plane as an absent
write is the most common way this archetype gets misdiagnosed.

An empty candidate list from `getFixContext` means no detector matched, which for this archetype is
common, because the detectors need both the write and the contradicting read inside the recording.
A recording that captured only the write cannot show the contradiction.

If everything is empty: widen the window around the reported save, confirm capture was running
when the user reloaded and saw the correct value, and if the recording holds only one side of the
write and read pair, ask for a recording that covers both.
