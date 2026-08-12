---
name: format-boundary
description: Diagnose a value that is serialized in one context and parsed in another, so a time zone, locale, calendar or numeric format flips it: off by hours, off by a day at midnight, a decimal separator swapped, money out by a factor. Use when a value is right in one place and wrong in another. Points at the recorded environment block, which carries the locale and time zone the session ran under.
---

# The timezone, locale or format boundary

A value is written in one context and read in another. The contexts disagree about a default: which
zone a naive timestamp belongs to, which day a week starts on, whether a comma is a thousands
separator or a decimal point, how many minor units a currency has, which calendar or numeral system
the locale implies. The value survives the trip and its meaning does not.

Two properties make this family expensive. It clusters at midnight, at daylight saving transitions,
at month and quarter ends, so it looks intermittent while being entirely deterministic. And it is a
family rather than a site: fixing the one place a reporter noticed leaves every sibling untouched,
which is why the same defect returns under a different label.

## Symptom

A date is off by one day, or by exactly the offset between two zones. A report attributed to the
wrong period at a boundary. A number rendered with the wrong separator, or a total out by a factor
of a hundred. A week that starts on the wrong day. A duration or a unit shown in the wrong scale.

The strongest clue in the report itself is that the same value is correct somewhere else in the
product. One representation is right and another is wrong.

## What Crumbtrail can see

The most useful fact for this archetype comes free and is easy to miss. A recording carries an
environment snapshot taken in the browser, and the ranked bundle exposes it as an environment block
holding the user agent, the browser, the operating system, the viewport, the locale and the time
zone the session ran under. That is the reporter's context, which is the thing you would otherwise
have to ask for and would usually get wrong.

Beyond that, the point of the recording here is that the same value appears in several
representations and you can compare them:

- The request body, holding the value as the browser serialized it.
- The response body, holding it as the server serialized it. Bodies are summarized when large and
  sensitive fields are replaced with a redaction marker.
- The stored row, where the database adapter is installed, holding the value as the column actually
  contains it, with the before and after of any change.
- Backend request records with routes and durations, where the backend SDK is installed.

Detectors that name this family, and that appear in the candidate list under these names, are
`display_date_timezone_mismatch`, `currency_locale_mismatch`, `locale_decimal_scale_shift`,
`money_scale_shift`, `fractional_cent_rounding`, `retry_schedule_clock_shift`,
`country_postal_validation_mismatch`, `interpolation_artifact`, `ui_arithmetic_mismatch` and
`rtl_physical_layout_rules`.

What the recording does not carry: the server process time zone or its default clock, the
formatting options the rendering code passed, and the locale data version in use on either side.
The environment block describes the browser, not the backend. When the hypothesis is that the
server is running in a different zone from its database, the recording cannot confirm it and you
should say so.

The other gap is the screen itself. The string the user actually saw is present only where a DOM
snapshot or a captured frame covers that moment, and a recording may have neither. Without one, a
mismatch between the value on the wire and the value on the screen is a hypothesis rather than an
observation.

## Call sequence

Start with the ranked bundle, and read its environment block before anything else. The locale and
time zone there set up every comparison that follows:

```json
{ "tool": "getFixContext", "params": { "sessionId": "<sessionId>", "maxTokens": 8000 } }
```

Then collect the representations. The wire value first:

```json
[
  { "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "net.req", "limit": 200 } },
  { "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "net.res", "limit": 200 } }
]
```

Then the stored value, which is the one that settles which side of the boundary changed it:

```json
{ "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "db.diff", "limit": 100 } }
```

Read the window around the moment the wrong value was produced, so the request, the response and
the row change for one action sit together:

```json
{
  "tool": "getWindow",
  "params": {
    "sessionId": "<sessionId>",
    "t0": 1785436544000,
    "t1": 1785436550000,
    "maxTokens": 8000
  }
}
```

Where a snapshot or a frame exists, it is the only way to see what was rendered. A frame is
resolved by timestamp and is available when reading local recordings:

```json
{ "tool": "getFrame", "params": { "sessionId": "<sessionId>", "timestamp": 1785436545000 } }
```

Because this is a family and not a site, finish by looking for the siblings. That is the difference
between a fix that holds and one that gets reopened:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the list above>" } }
]
```

## Telling it apart

If the value is absent rather than wrong, this is not it. An absent field is a missing key
detonation; an absent effect behind a success message is lying status.

If a reload corrects the value, the wrong one was cached and this is stale derived state.

If the value is correct on one route or release and wrong on another with the same data, a second
implementation is formatting it differently and the parity gap archetype is the better frame.

If the same input yields a correct value sometimes and a wrong one other times, it is a race. This
family is deterministic: the same value, the same zone and the same locale always produce the same
wrong answer, even when the calendar makes it look sporadic.

Within the family, the useful split is where the meaning changed. A value already wrong in the
request body was mangled in the browser. A value correct in the request and wrong in the stored row
was mangled on the way in. A value correct in the row and wrong in the response was mangled on the
way out. Those are three different fixes and the queries above tell them apart directly.

The distinction that cannot be made from telemetry alone is anything about the server clock or the
formatting options in the rendering code. What settles it is the deployment configuration and the
call site, and you should name which you read.

## What a null result means

An environment block that reports a locale and a time zone matching your own is the single most
common reason this archetype fails to reproduce. It means the recording was made under your
settings and not the reporter's, so a clean run proves nothing. Reproduce under the values the block
reports.

An absent time zone or locale in the environment block means the snapshot did not capture them, not
that they were unset.

An empty row change result means the database adapter is not installed or no row changed, and until
you check the manifest event counts you cannot tell which. Without the stored representation you can
still compare the request and the response, but you cannot say which side of the store changed the
meaning.

An absent frame or snapshot means visual evidence was not captured for that moment. The rendered
string is then unavailable and any claim about what the user saw is inference. Say so.

If everything is empty: widen the window around the reported value, confirm capture was running,
and check whether the value crosses the boundary at all in this recording. A value computed entirely
inside one process never crosses a recorded boundary, and for that case the recording cannot help
and reading the formatting call site is the faster route.
