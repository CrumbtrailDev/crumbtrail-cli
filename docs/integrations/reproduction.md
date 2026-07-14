# On-demand reproduction seam

`solveContext` fuses a symptom with locally recorded evidence. When no
sessions were compared, or a comparison yielded nothing, evidence is thin —
there's nothing to rank or explain. The reproduction seam lets `solveContext`
optionally reach for one more source of evidence in that case: driving a live
attempt to reproduce the symptom and folding whatever it finds into the same
`RankedBundle`.

This slice ships the full, tested integration path — the interface, the
gating rules, and a safe no-op default — proved end-to-end with a fake
reproducer. The concrete browser-driving reproducer is a documented
follow-on (see below), not implemented here.

## The `Reproducer` contract

```ts
interface ReproductionResult {
  attempted: boolean;
  sessionDir?: string; // where a fresh session was recorded, if any
  evidence: EvidenceItem[]; // fresh evidence (empty if none)
  intent: IntentSignal[]; // usually empty; reserved
  note: string; // human/agent-readable outcome
}

interface Reproducer {
  reproduce(symptom: Symptom): Promise<ReproductionResult>;
}
```

`reproduce(symptom)` takes the same `Symptom` `solveContext` already builds
from the tool's `symptom`/`ticket` inputs, and returns fresh evidence in the
same `EvidenceItem`/`IntentSignal` shapes used everywhere else in the fusion
pipeline. There is nothing reproduction-specific about the evidence it
returns — it's ranked, gapped, and turned into hypotheses/directives by the
same `assembleBundle` call as evidence gathered from recorded sessions.

## Opt-in and thin-evidence gated

Reproduction is off by default and only runs when all of the following hold:

- The `solveContext` caller passes `allowReproduction: true`.
- A `reproducerFactory` is configured on `McpServerConfig` (see below).
- The evidence gathered so far is thin: `evidence.length === 0`.

If sessions were already compared and produced evidence, the reproducer is
never called — there's no reason to re-drive a live app when history already
answered the question. This also means reproduction never runs by accident:
an operator has to both configure a reproducer factory and pass
`allowReproduction: true` on the call.

`solveContext` never throws because of reproduction. A reproducer that
throws, times out, or returns `attempted:false`/no evidence is caught and
folded back into the existing thin-evidence gap (with `result.note` appended
where available) — the tool still returns a valid bundle.

## The `NoopReproducer` default

`McpServerConfig.reproducerFactory` mirrors the existing `gitHostClientFactory`
/`ticketConnectorFactory` test seams: production code leaves it unset, and
`solveContext` behaves as if a `NoopReproducer` were configured — reproduction
is disabled, `attempted` is always `false`, and nothing about the tool's
existing behavior changes. `NoopReproducer` lives in
`packages/node/src/reproduce/noop.ts`; the contract types live in
`packages/node/src/reproduce/types.ts`.

## Follow-on: a concrete browser-driving reproducer

**Not yet implemented.** The natural next `Reproducer` is one that:

1. Navigates a live target app to `symptom.url`.
2. Drives the reported repro steps (from `symptom.description`, or a
   structured steps input yet to be designed).
3. Records a Crumbtrail session of that run.
4. Compares the recorded session against a baseline session (reusing the
   slice-0 `compareSessions` seam) to derive its `EvidenceItem[]`.

This is deferred because it depends on two things this slice deliberately
does not assume: a **live target app** to drive, and a **browser automation
harness** wired to it (Playwright or similar) plus app-specific launch/auth
config. Those are per-deployment concerns; the seam above is what lets a
concrete reproducer be dropped in later without touching `solveContext` again.
