---
name: orphan-cascade
description: Diagnose a failure where a delete or a rename did not cascade to every row or pointer referencing the object, and the orphan detonates later in whatever dereferences it next. Use when something unrelated broke after a removal, when an object appears half gone, or when a screen fails on a reference to something that no longer exists.
---

# The dangling reference and orphan cascade

Something was deleted or renamed, and the change did not reach every row, pointer, cached
identifier or stored configuration that referenced it. The removal appeared to succeed. The
failure arrives later, somewhere else, in whatever dereferences the orphan next.

The repair is where this archetype bites twice. A reference left behind by a rename must be
remapped and a reference left behind by a delete must be pruned, and applying the wrong repair
deletes live configuration.

## Symptom

A removal or a rename was carried out and reported as done. Later, and usually in a different
part of the product, something fails: a screen will not load, a report is missing rows, a job
throws on a lookup, a saved view points at nothing. The reporter rarely connects the two, so the
report describes the detonation and not the removal.

## What Crumbtrail can see

Where the database adapter is installed, a session carries the exact rows that changed with their
before and after values, pre state reads taken before a mutation, and the query activity that
produced them. That is the strongest evidence available for this archetype, because it shows what
the delete actually touched rather than what it was supposed to touch.

Named detector signals that speak to it include `orphaned_reference`,
`existing_children_reparented_to_new_row`, `db_delta_mismatch`, `db_unrequested_clear`,
`acknowledged_write_never_landed`, `acknowledged_batch_rows_missing` and
`request_target_row_mismatch`. Alongside those, the session carries the request that carried the
removal and, when both happened in one recording, the later request that detonated, plus the
console error at the detonation site.

It does not carry rows in tables nothing touched during the recording. Crumbtrail records what
the session's queries did, not the state of the database, so it cannot enumerate every dangling
pointer that now exists. It also cannot tell a rename apart from a delete followed by an insert
unless the queries themselves make that explicit. That second limit matters, because RENAMED
versus DELETED is exactly the discrimination the repair depends on, and it is frequently not
answerable from telemetry. When it is not, say so and settle it from the schema and the code.

## Call sequence

When the delete and the detonation are in one recording, the ranked bundle carries both the row
diffs and the correlated requests, so start there:

```json
{ "tool": "getFixContext", "params": { "sessionId": "<sessionId>", "maxTokens": 12000 } }
```

Otherwise work from the manifest and resolve the signal that fired:

```json
[
  { "tool": "getSessionManifest", "params": { "sessionId": "<sessionId>" } },
  { "tool": "getEvidence", "params": { "sessionId": "<sessionId>", "ref": "cand_0001" } },
  { "tool": "getErrorContext", "params": { "sessionId": "<sessionId>", "windowMs": 4000, "maxTokens": 6000 } }
]
```

Read the window around the removal itself rather than around the detonation, which is where the
incomplete cascade is visible:

```json
{
  "tool": "getWindow",
  "params": {
    "sessionId": "<sessionId>",
    "t0": 1785324493000,
    "t1": 1785324497000,
    "limit": 500,
    "maxTokens": 8000
  }
}
```

The common and harder case is that the removal happened in an earlier recording than the
detonation. Crumbtrail does not join two sessions for you, so find the earlier one by application
and time and then compare the pair:

```json
[
  { "tool": "listSessions", "params": { "app": "checkout", "before": 1785324493000, "limit": 50 } },
  {
    "tool": "getRegressionContext",
    "params": { "sessionA": "<the session that removed the object>", "sessionB": "<the session that failed>" }
  }
]
```

An orphan is durable, so it should recur. Confirm that rather than assuming it:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session", "app": "checkout" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the rollup>" } }
]
```

## Telling it apart

**The missing key detonation** crashes at the same place on the same kind of access. The
discriminator is whether the referenced object ever existed. If a pre state read or an earlier
recording shows the row present and then absent, this is an orphan. If nothing ever carried that
field for this row, model or mode, the payload simply did not match the model and the guard is
the fix.

**The stale cache and derived state neighbour** also shows a screen pointing at something that is
gone, but its reference is stale rather than dangling, and a reload or a fresh session repairs
it. An orphan survives a reload. Record a clean session and try the same action: if it still
fails, the state on disk is wrong.

**The environment promotion blind spot** produces orphans as a side effect when an export drops a
dependency. If the dangling references appeared in one environment right after a promotion and
not in the source environment, look at the promotion rather than at a delete path.

**RENAMED versus DELETED** is the distinction that decides the repair, and it is often not
visible in the recording. If the row diffs show an insert with a new identifier carrying the same
payload, a rename is likely. If they show a delete with no matching insert, a delete is likely.
When neither pattern is present, say the recording does not settle it and read the code path that
performed the change.

## What a null result means

An empty database section almost always means the database adapter is not installed for the
service that performed the removal, not that no rows changed. Check whether the session carries
any database activity at all before reading an empty row diff as evidence that the cascade was
complete. This is the single most likely wrong conclusion here.

An absent `orphaned_reference` signal means no detector matched inside this recording. Detectors
fire on shapes they were built for, and an orphan that detonates as a generic lookup failure will
not carry that name. A clean signal list is not a clean database.

No error at the detonation site is consistent with the failure being swallowed and rendered as an
empty state, which is a common and quiet form of this archetype. Treat a silent screen as a
possible detonation rather than as health.

If everything comes back empty, look for the earlier recording that contains the removal, confirm
the database adapter is installed on the service that owns the data, and otherwise move to the
missing key detonation neighbour, whose evidence lives at the crash site rather than in the row
history.
