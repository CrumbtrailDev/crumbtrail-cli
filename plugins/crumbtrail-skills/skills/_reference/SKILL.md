---
name: reference
description: Worked example and template for a Crumbtrail failure archetype skill. Read this before writing a new archetype skill. This is a template rather than an archetype, so it will not help you diagnose anything on its own.
---

# Reference shape for a Crumbtrail archetype skill

Every archetype skill in this plugin uses the five sections below, in this order. The gate at `plugins/__tests__/skills.test.ts` checks that they are all present, and checks every tool name and parameter name against the live MCP tool table. Copy this file, keep the headings, replace the content.

The worked example running through it is deliberately plain: a user reports that an action in the app failed, and nobody knows yet which archetype it is. That is the state every real skill starts from.

## Symptom

State what the reporter or the failing test actually saw, in their words rather than in a diagnosis. One or two sentences.

For the worked example: a user completed an action, the page reported success, and the effect never appeared.

Do not write a cause here. The point of an archetype skill is that several causes produce the same symptom, and the call sequence is what separates them.

## What Crumbtrail can see

Name the signals a recorded session actually carries for this archetype, and name the ones it does not. Being explicit about the second list is the whole value of the section. A skill that implies a signal exists sends the agent to run a query that answers nothing, which costs a turn and teaches it a wrong picture of the product.

For the worked example, a session carries console errors and unhandled rejections, every request and response with status and timing, navigation, storage and cookie changes, backend spans where the backend SDK is installed, and database row changes where the database adapter is installed.

It does not carry a stack trace for code that never threw, and it does not carry the value of a variable that was never logged or sent. When an archetype turns on something in that second category, say so in this section and say what the closest available proxy is.

## Call sequence

Give the calls as `json` fenced blocks holding either one object or an array of objects, each shaped `{"tool": ..., "params": {...}}`. Use real parameter names. The gate rejects a parameter the tool does not accept and rejects a call missing a required parameter, so a sequence that passes the gate is a sequence that will at least dispatch.

Start from whichever entry point matches what you were handed. `getLatestIssue` when the report is fresh and unlabelled, `listSessions` when you have an app name or a time range:

```json
[
  { "tool": "getLatestIssue", "params": { "maxTokens": 4000 } },
  { "tool": "listSessions", "params": { "app": "checkout", "limit": 20 } }
]
```

Then widen progressively rather than pulling the whole session at once. The manifest tells you what the session holds and gives you the references the later calls take:

```json
[
  { "tool": "getSessionManifest", "params": { "sessionId": "<sessionId>" } },
  {
    "tool": "getEvidence",
    "params": { "sessionId": "<sessionId>", "ref": "<a ref from the manifest>" }
  }
]
```

When you have a moment in time and want everything around it, read the window rather than filtering events by hand. `t0` and `t1` are absolute milliseconds, and `maxTokens` keeps a busy window from swamping the context:

```json
{
  "tool": "getWindow",
  "params": {
    "sessionId": "<sessionId>",
    "t0": 1717171717000,
    "t1": 1717171719000,
    "maxTokens": 6000
  }
}
```

If the archetype is one that repeats, ask whether this failure has been seen before. `getRecurrence` takes a signature, so resolve one first:

```json
[
  {
    "tool": "resolveSignature",
    "params": { "sessionId": "<sessionId>", "signature": "<candidate signature>" }
  },
  { "tool": "getRecurrence", "params": { "signature": "<resolved signature>" } }
]
```

Two more entry points are worth knowing. `getFixContext` returns the whole ranked bundle for one session in a single call, which is the right move once you know which session matters. `listDistinctBugs` with `mode` set to the cross session value groups the same failure across sessions.

## Telling it apart

List the neighbouring archetypes that produce the same symptom, and for each one give the observation that separates them. Write it as a decision, not as a description, so an agent can act on it in one read.

For the worked example: if the request never left the browser, the cause is upstream of the network and the console is where to look. If the request left and returned a success status while the effect is missing, the status is not telling the truth and the backend span or the row changes are where to look. If the request returned an error the interface swallowed, the failure is real and the interface is hiding it.

Where a distinction turns on a signal listed as missing in the second section, say that the distinction cannot be made from telemetry alone and name what would settle it.

## What a null result means

An empty answer is evidence about the recording, not proof about the code. Say for each query in this skill what its empty result actually rules out.

For the worked example: no failed requests means no request failed inside the recorded window, and the window is bounded by when capture started and stopped. It does not mean no request failed. No console error means nothing was thrown or logged at error level, which is exactly the shape of a failure that was caught and swallowed, so a clean console is weak evidence of health and sometimes evidence of this archetype.

Close by saying what to do when everything returns empty. Usually that is to widen the window, confirm capture was running during the reported action, or accept that this archetype is ruled out and move to the neighbour named above.
