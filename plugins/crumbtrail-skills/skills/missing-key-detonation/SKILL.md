---
name: missing-key-detonation
description: Diagnose a crash caused by an always present optional field that was absent for one row, model or mode, or by a null or oddly typed value reaching code that assumed presence. Use when a stack shows a property read on undefined or null and only some data triggers it. Explains how to read the captured payload that fed the crash, and where redaction limits what you can see.
---

# The missing key detonation, where the payload is not the model

Code is written against the model in someone's head. The payload is produced by a different
system, for a different reason, and for one row, one account, one provider or one mode the field
the code treats as always present is simply not there. Direct access explodes.

The same family covers the softer version: the field is present but legitimately null, or an empty
array, or a string where a number was expected, and the code that receives it assumed otherwise.

The failed obvious fix for this family is the per symptom guard. Adding an optional access at the
crash site stops that crash and leaves every sibling site intact, so the class recurs indefinitely.
When you write the diagnosis, name where the contract should be checked, not only where it blew up.

## Symptom

A property read on undefined or null, usually as a type error naming the property. The stack points
at rendering or mapping code. Most data works; one item, one account or one mode does not. A list
renders down to a particular row and stops.

Frequently the reporter describes it as affecting only them, or only one record, which is exactly
right and is the most useful thing they said.

## What Crumbtrail can see

This archetype is well served, because the payload that caused it crossed a boundary the recorder
watches.

- Uncaught errors with the message, the file, the line, the column and the full stack, and unhandled
  rejections with the message and stack. The property name is normally in the message.
- The response that carried the payload, including its body. Large bodies are summarized and a
  summary records the original length and why it was reduced. This is the point of the whole
  sequence: you can read the object the code choked on rather than guess at it.
- Backend response bodies where the backend SDK is installed, so you can see whether the field was
  already missing when the server produced it.
- Row reads and row changes where the database adapter is installed, which is how you tell a
  genuinely null column from a field dropped in serialization.

The limit you must state when it applies: redaction. Fields the policy considers sensitive come
back with their value replaced by a marker, and the reply records which paths were redacted and
why. Redaction preserves the shape, so a redacted field is still visibly present. What it does not
preserve is the value, so if the question is whether the field held an empty string or a real one,
the recording will not answer it and you should say so rather than guessing.

The other hard limit is that the value of a local variable at the moment of the throw is not
recorded. Crumbtrail captures what crossed a boundary, not the heap. The stack plus the response
body is the closest available substitute and is usually sufficient.

Detectors relevant here, by the names they appear under, are `console_error`,
`content_type_body_mismatch`, `result_row_loss`, `displayed_field_mismatch` and
`response_exceeded_requested_limit`.

## Call sequence

Go straight to the throw. Error context groups each error with the events around it and reports
what it dropped when the budget binds, so a large session still gives you a usable answer:

```json
{
  "tool": "getErrorContext",
  "params": { "sessionId": "<sessionId>", "windowMs": 5000, "limit": 5, "maxTokens": 8000 }
}
```

If the budget dropped everything, the reply names the timestamps it dropped. Use one to read the
window directly rather than raising the budget blindly:

```json
{
  "tool": "getWindow",
  "params": {
    "sessionId": "<sessionId>",
    "t0": 1785323596000,
    "t1": 1785323597000,
    "maxTokens": 8000
  }
}
```

Now find the payload. Pull the responses and look for the one that returned just before the throw
and whose body should have carried the property named in the error message:

```json
{ "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "net.res", "limit": 200 } }
```

Check the failed request list too, but expect it to be empty. A thin payload almost always arrives
with a success status, which is what makes this archetype easy to misfile as a network problem:

```json
{ "tool": "getFailedRequests", "params": { "sessionId": "<sessionId>", "maxTokens": 4000 } }
```

If the field looks absent on the wire, find out whether it was ever there. The link report joins the
browser side and the server side of one request, and where the database adapter is installed the row
reads show what the source actually held:

```json
[
  {
    "tool": "getLinkedRequestContext",
    "params": { "sessionId": "<sessionId>", "requestId": "<request id>" }
  },
  { "tool": "getEvents", "params": { "sessionId": "<sessionId>", "kind": "db.read", "limit": 100 } }
]
```

Because this family recurs across models and modes rather than appearing once, finish by asking
what else looks like it. Similar issue recall reads the local session tree and is refused when the
server is reading the hosted store:

```json
[
  {
    "tool": "recallSimilarIssues",
    "params": { "sessionId": "<sessionId>", "query": "cannot read properties of undefined", "limit": 5 }
  },
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session" } }
]
```

## Telling it apart

If nothing threw, this is not it. The archetype is defined by the explosion.

If the property is present in the body and the code still failed, the problem is the value, not the
key. If the value is a wrong shaped date, number or currency, go to the format boundary archetype.

If the same payload renders correctly elsewhere in the same recording, the payload is fine and the
consumer differs. Treat it as a parity gap between two implementations of the same view.

If the field is present on some attempts and absent on others with identical steps, an earlier
request is overwriting or nulling the slot and this is an async lifecycle race.

If the interface reported success and the crash happened somewhere the user never saw, check
whether the acknowledged work also failed, which would make lying status the more useful frame.

Where the missing field is one redaction replaced, the distinction between absent and empty cannot
be made from telemetry alone. What settles it is the server side body, the row read, or reproducing
with a record you own.

## What a null result means

An empty failed request list rules out nothing at all here and is the expected reading. The request
that fed the crash returned a success status.

An empty error context means no error and no rejection was captured. That either rules the
archetype out, or means the throw was caught and swallowed by an error boundary, in which case look
for a render that stopped rather than a stack.

An absent field in a captured body is genuine evidence, with one exception: confirm the reply did
not report that path as redacted or the body as summarized before you conclude the field was never
sent. A summary records that it reduced the body, and a reduced body is not a missing field.

An empty row read result means the database adapter is not installed, or the read went through a
client it does not wrap. It is not evidence that the source row lacked the column.

If everything is empty: confirm capture was running when the crash occurred, widen the window
around the reported moment, and if the only evidence is a stack with no payload behind it, say that
the recording does not contain the request that produced the object and name what you would need.
