---
name: unowned-contract
description: Diagnose a failure caused by something outside your control changing its payload, its authentication or its semantics, breaking a thin adapter that trusted the old shape. Use when an integration that worked for months starts failing with nothing shipped on your side, when a vendor call still returns success while the data no longer matches what the code reads, or when an external response suddenly arrives in a different form.
---

# The wrapped thing changed seam

Somebody else's contract moved. A vendor API, a firmware build, a warehouse dialect, a model
provider: whatever the adapter wrapped changed its payload, its authentication or its meaning out
of band, and the adapter that trusted the old shape broke. The fix is almost always to handle the
new shape, not to restore the old behaviour.

## Symptom

An integration that has worked for a long time starts failing, and nothing shipped on our side.
Or the call still succeeds and the data it carries no longer matches what the code reads: a field
that is now absent, a type that flipped, an identifier that is now a string, a list that became
an object.

Authentication is the other common face of it. Requests that used to be accepted now come back as
a redirect, a login page, or a rejection with a shape the adapter does not recognise.

## What Crumbtrail can see

For every request the browser made, including calls to external hosts, a session carries the
method, the URL, the status, the timing, the headers when header capture is enabled, and the
request and response bodies subject to the capture size limit and the redaction policy. Where the
backend integration is installed, backend spans carry the same for calls that integration
instruments, and a response body when it reports one. `getLinkedRequestContext` returns the
joined frontend and backend view of one request id.

Several named detector signals point straight at this archetype when they fire:
`content_type_body_mismatch`, `api_route_returned_document` (a document arriving where structured
data was expected, which is what an expired session or a moved authentication endpoint looks
like), `response_count_mismatch`, `ui_api_divergence`, `backend_http_error`,
`backend_http_client_error` and `invalid_webhook_signature_accepted`.

It does not see a call your backend makes to a vendor unless the backend integration is installed
and instruments that call. It does not see the vendor's changelog, deprecation notice or status
page, and it never will, because none of that is in the running application. A body larger than
the configured maximum is summarised rather than stored, and fields the redaction policy
classifies as sensitive are replaced with non recoverable shape metadata. When the field that
changed is a redacted one you can see that its shape moved and you cannot see its value.

## Call sequence

Start from the recording and let the manifest tell you which signals fired, rather than guessing
which one to query:

```json
[
  { "tool": "getSessionManifest", "params": { "sessionId": "<sessionId>" } },
  { "tool": "getEvidence", "params": { "sessionId": "<sessionId>", "ref": "cand_0001" } }
]
```

Then read the traffic itself. A contract change often returns a success status, so read all
requests around the moment rather than only the failed ones:

```json
[
  { "tool": "getFailedRequests", "params": { "sessionId": "<sessionId>", "maxTokens": 4000 } },
  {
    "tool": "getLinkedRequestContext",
    "params": { "sessionId": "<sessionId>", "requestId": "<request id from the manifest>" }
  },
  {
    "tool": "getWindow",
    "params": {
      "sessionId": "<sessionId>",
      "t0": 1785324493000,
      "t1": 1785324496000,
      "maxTokens": 6000
    }
  }
]
```

The load bearing comparison is old shape against new shape. Find a recording from before the
change against the same endpoint and diff the two runs:

```json
[
  { "tool": "listSessions", "params": { "app": "checkout", "before": 1785300000000, "limit": 20 } },
  {
    "tool": "getRegressionContext",
    "params": { "sessionA": "<a session from before>", "sessionB": "<the failing session>" }
  }
]
```

Vendor rollouts are dated events too, so check whether the failure starts at a moment:

```json
[
  { "tool": "listDistinctBugs", "params": { "mode": "cross-session" } },
  { "tool": "getRecurrence", "params": { "signature": "<signature from the rollup>" } }
]
```

## Telling it apart

**The lying status** also shows success alongside a missing effect, but the untruthful status is
written by our own code on a path separate from the work. Here the status is the vendor's. Ask
whose host returned it. If the misleading response came from an origin we operate, it is the
lying status; if it came from a third party, this archetype is the better fit.

**The missing key detonation** looks the same at the crash site: a field was absent and direct
access exploded. The discriminator is history. If the same endpoint returned the field in an
earlier recording, the contract moved. If it never did for this row, model or mode, the field was
always optional and our code assumed presence. `getRegressionContext` against an older session is
the query that settles it.

**A dependency bump** changes our adapter rather than the wire. If the wire traffic is byte
comparable across the two recordings and only our handling of it differs, look at what we
upgraded.

**Trust boundary config drift** breaks a whole surface for one install while the application is
healthy elsewhere. If the same vendor call succeeds from another environment or tenant at the
same time, suspect edge configuration rather than a contract change.

Where the distinction turns on the vendor's intent rather than on the bytes, telemetry cannot
settle it. Name the exact field or status that moved, and confirm it against the vendor's own
documentation outside the recording.

## What a null result means

An empty failed request list means no response in the recorded window carried a status of 400 or
above. A contract change very often returns success with different content, so an empty failed
request list is the expected reading for this archetype and exonerates nothing.

An absent body is ambiguous by design. Check the body summary reason before concluding the
response was empty: a payload dropped for size, a binary payload, or a redacted field are all
recorded as such and none of them means the vendor sent nothing.

No backend spans usually means the backend integration is not installed for the service making
the call, not that the call was never made. Confirm the session carries backend activity at all
before reading its absence as evidence.

If everything comes back empty, widen the window, confirm the failing call actually happened
inside the recording, and otherwise move to the neighbour that fits: the missing key detonation
when there is no history of the old shape, and the lying status when the misleading response came
from our own origin.
