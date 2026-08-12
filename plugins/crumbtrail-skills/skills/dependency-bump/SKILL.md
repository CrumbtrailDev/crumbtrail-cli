---
name: dependency-bump
description: Diagnose a failure whose real defect lives in a pinned upstream library rather than in application code, and whose fix is a version bump that may import the next breaking change. Use when a flow stopped working with no application change anyone can point at, when a symptom appeared everywhere at once, or when a bump made for one reason quietly moved behaviour for everything else on that library.
---

# The dependency bump double edge

The defect is not in code anyone here wrote. It sits in a pinned upstream: a client library, a
driver, a runtime, a rendering engine. The fix is a version bump, and the bump is the second
edge, because it also brings the next breaking change with it.

## Symptom

A flow that worked stops working, and nobody can name an application change that would explain
it. The failure often arrives for many users at the same moment rather than spreading. The
mirror image is just as common: a bump was made deliberately to fix one thing, and something
unrelated that also sits on that library changed behaviour at the same time.

Do not write the cause down yet. A release regression in first party code produces exactly this
symptom, and so does a vendor changing a payload out of band.

## What Crumbtrail can see

A session carries the moment it was recorded, console errors and unhandled rejections including
ones thrown from inside a bundled library, every request and response with status, timing and
body subject to the capture size limit and the redaction policy, navigation, storage and cookie
changes, backend spans where the backend integration is installed, and database row changes
where the database adapter is installed.

The environment snapshot carries the browser name and version, the operating system, the
viewport, the locale, the timezone, a public client release identity read from the
`<meta name="app-build">` tag when the page sets one, and whatever release, build, flag and
config values the application declared to the SDK.

It does not carry a dependency manifest, a lockfile, an installed version list, or a diff of
one. Nothing in a session records which version of a library was loaded, other than the
browser's own version and whatever the application chose to declare. So a bump is dated by
observing when recorded behaviour changed, and it is never read directly. When you write the
finding up, say that the version was inferred from timing rather than observed, because the
reader will otherwise assume you saw it.

## Call sequence

Start by proving the failure has a start date rather than assuming it. Group the same failure
across sessions, then read the rollup for the signature that matches:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session", "app": "checkout" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the rollup>" } }
]
```

`getRecurrence` returns first seen and last seen timestamps, a session count, a release span and
the per session occurrences. A tight first seen with nothing before it is the shape this
archetype makes.

Now pick one recording from each side of that moment and compare them. The release filter is
useful only when the application declares a release; fall back to the time filters when it does
not:

```json
[
  { "tool": "listSessions", "params": { "app": "checkout", "release": "2026.7.2", "limit": 20 } },
  { "tool": "listSessions", "params": { "app": "checkout", "after": 1785400000000, "limit": 20 } },
  {
    "tool": "getRegressionContext",
    "params": { "sessionA": "<a session from before>", "sessionB": "<a session from after>" }
  }
]
```

The regression bundle carries an environment delta. Read it precisely: it moves only when the
declared flags, the declared config, the release label, the build label, or a captured runtime
field such as the browser version actually differ. A library version is not in that list.

Then read the throw site in the later session. A stack that terminates inside vendor code
rather than application code is the strongest observation available for this archetype:

```json
[
  { "tool": "getErrorContext", "params": { "sessionId": "<after>", "windowMs": 2000, "maxTokens": 6000 } },
  { "tool": "getFailedRequests", "params": { "sessionId": "<after>", "maxTokens": 4000 } }
]
```

If you want the whole ranked bundle for the failing recording in one call rather than assembling
it, use `getFixContext` on the later session.

## Telling it apart

**A first party release regression** produces an identical recurrence shape: a failure that
starts at a moment and holds. Telemetry cannot separate the two, because both are "the code that
ran changed". What separates them is the source diff, so read the release's changes and check
whether the change was ours or a lockfile line. Say in the writeup that the recording narrowed
the moment and the diff named the cause.

**An unowned contract seam** looks similar but moves on the wire rather than in our bundle. If
the failing thing is a response from an external host whose shape or status changed, the vendor
moved and no bump of ours caused it. A bump changes our side while the wire traffic stays the
same.

**A runtime bump underneath you** shows up directly. Compare the environment snapshots of the
two sessions: if `browser.version` moved while the release and build labels did not, the
platform bumped, not a package.

**The second edge** is worth checking explicitly once you have a candidate bump. Ask whether any
other surface on the same library also changed in the same window. Run the cross session grouping
again without narrowing to one signature and look for a second signature whose first seen lands
in the same window.

## What a null result means

A `session_count` of one in the recurrence rollup does not mean the failure is new. It means one
recording carries that signature. Capture may not have been running before, the earlier sessions
may have expired, or the earlier failure may have grouped under a different signature. Absence of
history is a statement about the archive, not about the code.

An empty release span means no session declared a release label. That is a gap in what the
application declares, not evidence that the release did not move. It is also the cheapest thing
to fix, and worth naming as a follow up.

An empty environment delta from `getRegressionContext` means the two recordings declared the same
environment. Since a library version is never part of what is declared, an empty delta is the
expected reading here and rules nothing out.

If every query comes back empty, widen the window with the time filters, confirm capture was
running on both sides of the suspected moment, and otherwise treat the archetype as unconfirmed
rather than ruled out. The next place to look is the release diff, which is outside the recording.
