# Adaptive capture directives

Every `fusion.v1` `RankedBundle` returned by `solveContext` carries a
`directives: CaptureDirective[]` field alongside `evidence`, `opinion`, and
`gaps`. It is the engine's advisory answer to: _for this bug signature, what
should we collect more deeply next time so we're not blind to it again?_

## What a `CaptureDirective` is

```ts
interface CaptureDirective {
  signature: string; // the bug signature this raises capture for
  raise: EvidenceLane[]; // lanes to collect more deeply next time
  scope: "signature" | "session";
  reason: string;
}
```

- `signature` — `symptom.errorSig` when present, otherwise a slug of
  `symptom.title` (or `'unknown'` if both are empty). This is the key an SDK
  or operator would use to target the escalation.
- `raise` — the subset of the informative lanes (`network`, `db`, `browser`,
  `flow`) that had no evidence in this bundle.
- `scope` — always `'signature'` today; reserved for a future `'session'`
  scope that would raise capture for one session only.
- `reason` — a human-readable explanation, e.g. _"thin evidence for this
  signature; raise capture on: db, browser, flow"_.

## When directives are emitted

`suggestCaptureDirectives(symptom, evidence, gaps)` (in `crumbtrail-core`) is
pure and deterministic — same inputs always produce the same output, no
clock or randomness involved.

- Evidence is considered **thin** when `evidence.length === 0` or
  `gaps.length > 0`.
- If evidence is not thin, or if every informative lane is already
  represented in the evidence, the result is `[]` — no directive.
- Otherwise, exactly **one** directive is returned, raising whichever
  informative lanes are missing.

`assembleBundle` calls `suggestCaptureDirectives` with the same evidence and
gaps it already computes, so every `RankedBundle` — however it's produced —
gets a consistent `directives` array. `directives` is purely additive: the
`fusion.v1` schema version is unchanged, and existing consumers that ignore
the field are unaffected.

Directives are **advisory only**. Generating them never mutates any session,
evidence, or verdict — `compareSessions` and the verdict gate are untouched
by this feature.

## Observed behavior through `solveContext`

- **Symptom only, no sessions compared** — evidence is empty and a gap is
  emitted (`"no recorded sessions compared for this symptom"`), so evidence
  is thin: `directives` has exactly one entry raising all four informative
  lanes.
- **Two diverging sessions compared** (e.g. a 200→500 regression) —
  `compareSessions` produces non-empty evidence and no gap, so evidence is
  _not_ thin: `directives` is `[]`.

## The apply-seam: what ships here vs. what doesn't

This slice ships the full deterministic **decision + delivery** of capture
directives: generation in `crumbtrail-core`, surfacing on `RankedBundle`, and
threading through `solveContext`. It is fully testable and does not touch
any shipping runtime path.

**Not shipped in this slice:** actually _enforcing_ a directive — escalating
capture depth for a matching signature at record time. That would require an
SDK-side `CaptureDirectiveStore` (a signature → raised-lanes map) that the
Crumbtrail runtime's collectors would consult before deciding how deeply to
capture a given lane for a session matching that signature.

This enforcement step is deliberately deferred as a follow-on, not built
here, because:

- It would require making the shipping SDK capture hot path branch on
  directive state, which is a much higher-risk change than adding an
  advisory field to a bundle.
- The decision (this slice) is independently valuable and testable without
  the enforcement half — an operator or agent consuming `solveContext` can
  already see and act on directives manually.
- Enforcement needs its own design pass: how directives are persisted and
  distributed to the running SDK, staleness/expiry, and how a directive is
  cleared once the lane has enough evidence again.
