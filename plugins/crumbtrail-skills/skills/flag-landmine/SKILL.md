---
name: flag-landmine
description: Diagnose a failure that differs between users or accounts on the same build because a feature flag or toggle is unset, stale, or doubling as configuration. Use when a feature works for one user and not another with identical code, when an old toggle blocks a new path, or when behaviour differs and nobody can say which switch is responsible.
---

# The flag and toggle landmine

Flags accumulate three jobs at once: configuration, rollout control, and an archive of past
workarounds. They are usually free text and usually unvalidated. A toggle nobody has touched for
years blocks a new code path, or a flag that was never initialised for some users silently
disables a feature for exactly them.

Before running this skill, confirm the recording actually carries a flags map. If it does not,
this archetype is invisible to the recording and the first useful action is to make the
application declare its flags.

## Symptom

Two users on the same build get different behaviour. A feature is off for some accounts and
nobody can name the switch. A new path works in one account and short circuits in another. The
reporter often frames this as intermittent, because from their side the same action produces
different results, but it is stable per user rather than random.

## What Crumbtrail can see

The environment snapshot emitted at session start carries the feature flags and the runtime
configuration the application declared to the SDK, redacted, and later declarations arrive as
deltas on the same channel. `getRegressionContext` compares two recordings and returns an
environment delta naming each flag key, config key, release label and build label that moved
between them, so a working session and a broken session can be diffed directly.

Alongside that, the session carries the usual planes: interactions, console, requests and
responses, backend spans where the backend integration is installed, and database row changes
where the database adapter is installed. Those are what tell you the flag actually changed a code
path rather than merely differing.

It does not read your flag provider. Crumbtrail has no connection to a flag service and cannot
enumerate the flags that exist, their defaults, their targeting rules, or their history. Only the
values the application chose to declare are present, and only from the moment it declared them.
If the application never declares its environment, the flags section is absent and no query in
this skill will produce anything.

Declared flag values also pass through the redaction policy. A boolean or a short identifier
survives; a value that classifies as free text or as a token is replaced with non recoverable
shape metadata. So you may be able to see that a flag differs without being able to see what it
is set to.

## Call sequence

First establish that flags are being declared at all, which the session index and the ranked
bundle both show:

```json
[
  { "tool": "getIndex", "params": { "sessionId": "<the failing session>" } },
  { "tool": "getFixContext", "params": { "sessionId": "<the failing session>", "maxTokens": 12000 } }
]
```

The ranked bundle carries a redaction aware environment snapshot. If it has no flags, stop here
and report that the recording cannot answer the question yet.

The load bearing move is a pair: one recording where the feature works and one where it does not,
on the same build. Hold the build constant and vary the user:

```json
[
  { "tool": "listSessions", "params": { "app": "checkout", "build": "9f2c1ab", "limit": 50 } },
  {
    "tool": "getRegressionContext",
    "params": { "sessionA": "<a session where it works>", "sessionB": "<a session where it does not>" }
  }
]
```

Read the environment delta from that bundle. A flag key that moved while the release and build
labels held constant is the finding.

Then confirm the flag actually reached a code path, by looking at what diverged in the same
window rather than trusting the correlation:

```json
[
  { "tool": "getSessionManifest", "params": { "sessionId": "<the failing session>" } },
  {
    "tool": "getWindow",
    "params": {
      "sessionId": "<the failing session>",
      "t0": 1785324493000,
      "t1": 1785324497000,
      "maxTokens": 8000
    }
  }
]
```

A stale toggle blocking a new path tends to affect a stable set of accounts over a long period
rather than starting at a moment, which the recurrence rollup will show:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session", "app": "checkout" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the rollup>" } }
]
```

## Telling it apart

**A permission seed gap** also splits users on one build. The discriminator is which axis the
split follows. If the affected users share a role, a creation path or an upgrade history rather
than a flag value, the missing rows are permissions and not toggles. Compare two sessions whose
declared flags are identical and whose users differ in role.

**The environment promotion blind spot** splits by environment rather than by user. If every
account in one environment behaves one way and every account in another behaves the other way,
the flag values probably travelled incorrectly rather than being targeted incorrectly.

**A dependency bump or a release regression** splits by date. A recurrence rollup with a sharp
first seen points there; a rollup spread evenly over months with a stable set of accounts points
here.

**Configuration mistaken for a defect** is the honest outcome a meaningful fraction of the time.
A flag set deliberately to a value that produces the reported behaviour is not a bug, and the
only product fix is usually a clearer message. Check whether the value is wrong or merely
surprising before filing anything.

If the environment delta is empty and behaviour still differs, the input that differs is not
something the session declares. That is a real and reportable finding: name what would need to be
declared for the next recording to answer the question, rather than concluding the flags are
identical.

## What a null result means

An absent flags section means the application never declared one. It does not mean the
application has no flags. Everything downstream in this skill depends on that declaration, so
treat its absence as the finding rather than as a clean result.

An empty environment delta between two sessions means the two recordings declared the same
environment. Since only declared values are compared, that is a statement about what was declared
and not about what the two runtimes actually were.

A flag value rendered as shape metadata means redaction classified it as sensitive. The
difference between the two sessions is still visible even when the value is not, so a delta that
names a key with unreadable values is still a usable finding.

If every query is empty, confirm the environment declaration is wired, find a working recording
on the same build to pair against the failing one, and otherwise move to the permission seed gap
neighbour, which splits the same population on a different axis.
