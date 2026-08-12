---
name: env-promotion
description: Diagnose a failure that appears only after content or configuration was promoted from one environment to another, where the promotion tool diffed by name and exact structure and a drifted schema, a duplicate name, an unsupported sub object or a rename broke the comparator, or the promotion reported success and silently mangled the payload. Use when something works in one environment and fails in the next after an export, an import, a sync or a deploy of configuration.
---

# The environment to environment promotion blind spot

A promotion tool moves objects between environments by matching on name and exact structure. When
the two environments have drifted, when a name is duplicated, when a sub object is unsupported, or
when something was renamed, the comparator breaks. The worse case is that it does not break: it
reports success, and the payload arrives incomplete or mangled.

Read the limits section of this skill before running the queries. More of this archetype lives
outside the recording than in any other archetype in this collection, and the honest answer is
often that the recording characterises the damage while the cause is confirmed elsewhere.

## Symptom

Something that works in one environment fails in the next after a promotion. An object arrives
missing its dependencies. A configuration import reports success and the target is short. A
comparator reports a difference that does not exist, or reports none where there is one. Users in
the promoted environment see a feature behave differently from the one it was copied from.

## What Crumbtrail can see

Whatever the application did in the target environment, if capture was running there. That is
requests and responses with status, timing and body, console errors and unhandled rejections,
navigation, storage and cookie changes, backend spans where the backend integration is installed,
and database row changes where the database adapter is installed. Together those characterise the
target failure precisely enough to name the object that is missing or wrong.

Environment identity is available in two forms, both of which are opt in. The application can
declare a release label, a build label and arbitrary configuration to the SDK, which is where an
environment name lives when a team puts it there. Separately, a session created automatically from
backend telemetry takes its identity from the reporting service's resource attributes, so when
`deployment.environment` is set on that service the environment name is part of the session
identity. Check which of these your deployment uses before assuming either.

`getRegressionContext` compares a recording from each environment and returns an environment
delta naming the config keys, release labels, build labels and declared flags that differ, plus
the first diverging interaction, the correlated requests and the database rows whose values
changed.

Here is where the evidence runs out, and it runs out early. Crumbtrail records the application,
not the pipeline. It does not see the promotion tool's own run, the export archive, the
serialisation, the comparator's decisions, or a configuration sync job, unless that tool is itself
an instrumented application in the loop. A promotion that runs headless produces no session at
all. So a query in this skill can show that the target environment is missing an object; it cannot
show that the export dropped it. State that boundary in the writeup rather than letting the reader
infer a causal claim the recording does not support.

## Call sequence

Start by characterising the failure in the target environment:

```json
[
  { "tool": "getSessionManifest", "params": { "sessionId": "<a session from the target environment>" } },
  { "tool": "getFixContext", "params": { "sessionId": "<a session from the target environment>", "maxTokens": 12000 } }
]
```

Then get the same flow from the source environment and diff the pair. This is the query that does
the work, because a promotion defect is by definition a difference between two environments
running the same intent:

```json
[
  { "tool": "listSessions", "params": { "app": "checkout", "release": "2026.7.3", "limit": 50 } },
  {
    "tool": "getRegressionContext",
    "params": { "sessionA": "<a session from the source environment>", "sessionB": "<a session from the target environment>" }
  }
]
```

Read the environment delta and the first diverging interaction from that bundle. A promoted object
that arrived incomplete usually shows as a divergence in a response payload or a database read
rather than as an error.

Drill into the missing piece rather than the symptom:

```json
[
  { "tool": "getFailedRequests", "params": { "sessionId": "<target session>", "maxTokens": 4000 } },
  {
    "tool": "getLinkedRequestContext",
    "params": { "sessionId": "<target session>", "requestId": "<request id from the manifest>" }
  },
  {
    "tool": "getWindow",
    "params": {
      "sessionId": "<target session>",
      "t0": 1785436515000,
      "t1": 1785436521000,
      "maxTokens": 8000
    }
  }
]
```

A promotion is a dated event, so the failure should start at a moment in the target environment
and never have occurred before it:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session", "app": "checkout" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the rollup>", "app": "checkout" } }
]
```

## Telling it apart

**The flag and toggle landmine** also splits behaviour between two populations, but it splits by
user or account inside one environment. If two users in the same environment differ, it is a flag.
If every user in one environment differs from every user in another, look at the promotion.

**Trust boundary configuration drift** is the closest neighbour and the easiest to confuse,
because both make one environment fail while the application is healthy elsewhere. The
discriminator is what is missing. If authentication, cross origin policy, certificates, proxy
behaviour or a site address are failing at the edge, that is drift at the boundary. If the
application is reachable and healthy and a specific promoted object is absent or wrong, this is
the promotion.

**The dangling reference and orphan cascade** is frequently the shape the damage takes, because a
partial import leaves references to objects that never arrived. The two are not alternatives:
the promotion is the cause and the orphan is the effect. Report the orphan as the finding and the
promotion as the origin, and check the orphan skill for the repair distinction between remapping
and pruning.

**A dependency bump or a release regression** also starts at a moment. Separate them by asking
whether the moment coincides with a promotion or with a deploy of code, and whether the source
environment on the same release is healthy. A healthy source environment on an identical release
label points here.

Where the distinction turns on what the promotion tool actually did, telemetry cannot settle it.
Name the object that is missing or malformed in the target, then confirm against the promotion
run's own logs and the export archive, which live outside the recording.

## What a null result means

No session from the target environment means capture is not running there, which is the most
common reason this whole skill returns nothing. A promotion target is often an environment nobody
instrumented. Say that plainly rather than reporting a clean result.

An empty environment delta means the two recordings declared the same environment. Since only
declared values are compared, and since many teams never declare an environment name, an empty
delta is weak evidence and frequently means the environment identity was never captured rather
than that the two environments matched.

An empty failed request list is the expected reading when a promotion succeeded and mangled the
payload, because a mangled payload usually returns a success status. Absence of failed requests
does not exonerate the promotion.

No database row changes usually means the database adapter is not installed for the service that
owns the promoted data, not that nothing changed.

If everything comes back empty, the recording does not reach this archetype. Instrument the target
environment, capture the same flow in the source environment for a pair to diff, and in the
meantime confirm the promotion from its own run output. Say which of those steps is outstanding
rather than reporting the archetype as ruled out.
