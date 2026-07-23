# Silent-Bug Detection: Invariant Signals

Date: 2026-07-22
Status: Approved design, pre-implementation
Packages: `crumbtrail-core` (capture), `crumbtrail-node` (analysis), `crumbtrail-playground` (verification)

## Problem

A live probe exercise (2026-07-22, playground `crumbtrail-detection-probe`) planted three
silent bugs — no error, no 4xx/5xx, all flows return 200 OK — and measured what Crumbtrail
surfaced:

| Probe | Bug                                                                             | Captured?                                                          | Auto-flagged?                           |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| P1    | Inventory decremented by `qty + 1` per order                                    | Yes — `db.diff` before/after showed 25→23 for qty 1                | Only as generic low-score `db_mutation` |
| P2    | Expired coupon silently accepted (200, $0 discount, no redemption row)          | Partially — request body was `[REDACTED]`, hiding the coupon input | No — 200 looks normal                   |
| P3    | Cart Total renders subtotal, dropping tax (`Total ≠ Subtotal + Tax` in the DOM) | No — pure client render, no fetch/console trace                    | No                                      |

Crumbtrail today is an evidence-capture tool with error-shaped heuristics. Its 23 detectors
(`evidence-index.ts`) fire on errors, failed HTTP, and console noise — not on
semantically-wrong-but-200 flows. The `db.diff` before/after data is already the strongest
evidence in the product; it is captured but never _interpreted_.

## Goal

All three probe classes produce ranked signals in `CANDIDATES.md` / `getFixContext`
automatically, with zero per-app configuration, deterministically (no LLM in the loop),
while never weakening the privacy posture for secrets/PII.

Acceptance is mechanical: the three probes become playground patch-activated regressions
(#24–#26) and `pnpm playground:verify --all` passes with `expects` assertions on the new
signals.

## Non-goals

- App-declared invariant DSLs or per-app rule config (may layer on later; not this design).
- LLM-based anomaly detection (`ai-diagnosis.ts` remains a separate, optional layer).
- Capturing raw keystrokes, clipboard, or any currently-disabled sensitive plane.
- Detecting concurrency races (BUG #2-style) — out of scope for deterministic single-session analysis.

## Design

Three pillars. A depends on B (structured bodies make payload fields readable); C is
independent capture plus two detectors that join A's ranking pipeline.

### Pillar A — Cross-plane invariant detectors (`crumbtrail-node`)

New detector family in `evidence-index.ts`, running at finalize alongside the existing 23.
Both detectors operate per `requestId` on the already-correlated triple:
frontend `net.req`/`net.res` ↔ `backend.req.start/end` ↔ `db.diff[]`.

**A1. `db_delta_mismatch`** (P1)

For each mutating request (POST/PUT/PATCH/DELETE with ≥1 correlated `db.diff`):

1. Extract candidate pairs from the structured request payload: an id-like field
   (`id`, `*Id`, `*_id`) plus a quantity-like numeric field (`qty`, `quantity`, `count`,
   `units`) in the same object scope (top level or same array element).
2. Match each pair to `db.diff` rows whose `pk` value equals the payload id and whose
   `op` is `update` with exactly one changed numeric column.
3. If `|after − before| ≠ qty` → emit signal.

Severity `high`, base score 72. That is above every generic `db_mutation` rank (66 when the
write is linked to a failure, 40 standalone) and above a 4xx `http_error`'s 70, so it is the
highest-scored db-plane signal. Score is not list position: see "Ranking database writes
against errors" below for what actually decides emitted order. Confidence `high` only when
the id match is exact and a single numeric column changed; otherwise the detector stays
silent — no fuzzy guesses.
Evidence attached verbatim: the payload fields, the diff `before`/`after`, the requestId.

Cart-line aggregation rule: when multiple payload lines target the same id, compare the
summed qty against the summed delta across that request's diffs for that pk.

**A2. `ineffective_input`** (P2)

For each 2xx mutating request whose structured payload contains a non-empty string field
of a user-input shape (≤ 64 chars, not id-like, not on the redaction deny-list):

1. Stem the field name (`couponCode` → `coupon`).
2. Scan the correlated response body fields, and the names of tables touched by correlated
   `db.diff`s, for the stem or a known-synonym expansion (built-in stem map:
   `coupon → discount|redemption|promo`; `search|query → results`; extensible constant).
3. If the response contains a matching field that is zero/empty/absent AND no touched
   table name matches → emit signal:
   _"input `couponCode` accepted (200) but produced no observable effect."_

Severity `medium`, base score 55, confidence `low` — deliberately surfaced-not-buried,
capped at 3 per session, deduped by field name. This is a hint detector; the evidence
window it anchors gives an agent the payload + response + diff list to judge.

### Pillar B — Structured redaction v2 (`crumbtrail-core`)

Replace whole-body `"[REDACTED]"` in `collectors/network.ts` (`redactNetworkTextBody`)
with structure-preserving redaction for JSON request and response bodies (bounded:
≤ 16 KB parsed; larger bodies keep today's behavior).

Per-value classification, deny-biased:

| Class         | Rule                                                                                                                                                                                                                                                                   | Output                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Always redact | Field-name deny list (the v1 sensitive-key patterns in `core/src/redaction.ts`, plus `password`, `token`, `secret`, `auth`, `card`, `cvv`, `ssn`, `email`, `phone`, `address`) or value pattern (email regex, Luhn-passing digits, JWT shape, high-entropy ≥ 24 chars) | `"[REDACTED]"` + shape |
| Keep          | Numbers, booleans, nulls; short enum-like strings (≤ 24 chars, single token, alphanumeric/`-_`) not matching any redact rule                                                                                                                                           | verbatim               |
| Unknown       | Everything else (long strings, free text)                                                                                                                                                                                                                              | `"[REDACTED]"` + shape |

Shape metadata (for redacted values): `{ len, charset: "alpha"|"num"|"alnum"|"mixed", hash8 }` —
enough for presence/equality tests without recoverability. Field _names_ and JSON structure
are always preserved.

Config: `redaction: { mode: "structured" | "full", denyFields: string[] }` — `"full"`
restores today's behavior; `denyFields` extends the deny list. Default is `"structured"`.
The emitted redaction schema tag bumps (`…browser-redaction.v2`) so readers can distinguish
sessions; v1 sessions read exactly as before.

Non-JSON text bodies keep current behavior. This pillar is what makes A1/A2 payload
extraction possible; it also upgrades human/agent session reading (`EXPIRED5` becomes
visible — a coupon code is an enum-like short token, kept by design).

### Pillar C — Numeric UI snapshot + display detectors

**Capture (`crumbtrail-core`, new collector `ui-numbers.ts`, event kind `ui.num`)**

On navigation commit and after DOM mutations settle (MutationObserver debounced 500 ms):
scan visible text for labeled numeric tokens — currency/number values whose label comes
from `dt/dd` pairs, `label`+sibling, `aria-label`, or preceding text node in the same
row/list item. Emit a compact snapshot:

```json
{
  "k": "ui.num",
  "d": {
    "region": "dl.totals",
    "items": [
      { "label": "Subtotal", "value": 199.0, "unit": "$" },
      { "label": "Tax (8.25%)", "value": 16.42, "unit": "$" },
      { "label": "Total", "value": 199.0, "unit": "$" }
    ]
  }
}
```

Caps: ≤ 50 tokens per snapshot, ≤ 1 snapshot per region per settle, emit only on change
(diff vs previous snapshot of the same region). No raw DOM/HTML is captured — labels and
numbers only; labels run through the Pillar B classifier (a label matching PII patterns is
redacted, its value kept).

**Detectors (`crumbtrail-node`)**

- **C1. `ui_arithmetic_mismatch`** (P3): within one region snapshot, match label-role
  patterns (`subtotal`/`tax`/`fee`/`shipping`/`discount` vs `total`; `qty × unit price` vs
  line total). If the parts are present and `|sum − total| > ε` (ε = 1 cent per component)
  → signal, severity `medium`, base score 60, confidence `high` (arithmetic either holds
  or it doesn't). Evidence: the snapshot items verbatim.
- **C2. `ui_api_divergence`**: a labeled on-screen number differs from a same-stem numeric
  field in a response received since the last navigation, beyond ε = 1 cent. Severity
  `medium`, score 55, confidence `medium`, capped at 3 per session.

### Ranking and false-positive posture

- New signals enter the existing score/dedupe/causal pipeline unchanged; `CANDIDATES.md`,
  `fix-context.v2`, and every MCP tool surface them with zero reader changes.
- Emit-only-on-exact-pairing is the core FP control: every detector stays silent rather
  than guess. Every emitted signal carries the raw evidence pair it was computed from.
- Per-session caps: A1 uncapped (exact by construction), A2 ≤ 3, C2 ≤ 3, C1 uncapped.

#### Ranking database writes against errors

`db_mutation` (from `db.diff`) and `otel_db_activity` (from OTel db spans) are always emitted —
they are the subtle data-correctness evidence the logger most wants to catch — so their rank,
not their presence, is what carries meaning. That rank is decided by each write's own
relationship to the session's failures (`rankDbWritesAgainstErrors` / `DB_WRITE_RANK` in
`evidence-index.ts`):

1. **Same request, error at or before the write.** The unit of work failed and this write still
   landed, so it may be a partial or retried commit. This is the strongest link, and it is
   unbounded in time: request membership, not elapsed time, is the claim. The two planes key it
   differently — `db.diff` on `requestId` (one HTTP request), the OTel plane on `traceId`, which
   can span a long-running job, so the same rule reaches further there.
2. **Otherwise, within `PROXIMITY_MS` of a failure.** The only route available to a write with no
   request linkage, such as a background job. `PROXIMITY_MS` is bound by reference to
   `CAUSAL_RANK_CONSTANTS.MAP_WINDOW_MS` (2s): without a shared request id, a write is only
   claimed to be near an error inside the same window the causal graph itself will draw an edge
   across.
3. **Otherwise standalone**, at score 40 / `low`. Still surfaced, and — absent any error — still
   ranked first so its evidence window covers the write for fix-context.

Rule 1 depends on the two keys agreeing. `collectErrorMoments` keys an OTel error moment on its
`traceId`, while `db.diff` writes key on `requestId`; the SDK stamps them identically in the
captures behind this document, which is why the checkout's writes reach rule 1 at all. Wherever a
trace id is not the application's request id, that linkage is simply unreachable and those writes
fall through to the 2 second proximity rule instead.

Every linked write gets the **same** rank: score 66, severity `medium`, confidence `medium`. The
score sits below `db_delta_mismatch`'s 72 and below a 4xx `http_error`'s 70 on purpose. "A write
landed in a request that failed" is weaker evidence than the failure itself or than an observed
data inconsistency: the link says the write is worth reading, not that the write is wrong. It ties
`backend_http_client_error`'s 66 deliberately: a request the backend answered 4xx makes the same
kind of claim, and separating the two would assert a difference that is not there. Scores in this
file are a rank, not an identifier, and are not distinct anyway (`repeated_clicks` alone spans
58..65, across `console_error`'s 58 and the OTel 60s). Only the linkage _rule_ differs between
linked writes, and only in the title — rule 2 says "near an error", rule 1 says "in the failing
request", because rule 1 is unbounded in time and a write a minute away from the failure must not
claim to be near it.

There is deliberately **no ordering of writes within one failure**. Ordering by temporal distance
to the error was implemented and then removed: inside a single request the error precedes every
write, so distance collapses to write order, and write order is an artifact of the application's
code path rather than evidence about culpability. On the captured retry storm it ranked the two
duplicate `coupon_redemptions` rows — the actual defect — below the innocent `products` update and
`orders` insert purely because checkout writes coupons last. Discriminating inside a failure needs
an observable property of the rows themselves (identical after-images, a delta contradicting the
payload), which is what the `db.diff` invariant detectors above do.

Table participation in the error path was evaluated as a discriminator and rejected. The error
evidence available at this point (HTTP spans, console errors, network failures) carries no table
name, so it could only be matched by guessing a table from a route or a message, which contradicts
the emit-only-on-exact-pairing posture above.

**One failure is one moment.** A single failure emits several error events milliseconds apart (the
5xx response, the matching `backend.req.error`, the console error it raises on the client), and
each is emitted again from the pre-built index arrays. `collectErrorMoments` collapses them:
events are chained into one moment while consecutive events sit within `PROXIMITY_MS` of each
other, so a retry burst is one failure rather than several. Chaining on a shared request id was
considered and rejected — two failures of one request a minute apart would merge into a moment
spanning that minute, and every unrelated write in between would silently become "near an error".
Chaining only on `PROXIMITY_MS` adjacency keeps every internal gap at or below the window, which
makes distance-to-span and distance-to-nearest-event agree, so the collapse changes the moment
model without widening what links. Under a uniform linked rank the collapse changes no emitted
score today; it exists so that "error moment" means "failure", which is what any per-failure count
or budget will need.

**Rank is not a stand-in for "an error happened".** `resolveLatestIssue` (behind the
`getLatestIssue` MCP tool and `fix-context --latest`) qualifies a session on error-class evidence,
one clause of which is a `critical`/`high` candidate row. Under the old binary boost, a session
whose only error signal was a console error qualified through that clause: a database write within
five seconds was lifted to `high`, and the gate read the write's rank as proof of the error. Ranking
that write honestly removed the proxy, so `hasErrorClassEvidence` now tests for the evidence
directly and counts `index.consoleErrors` — errors the capture already narrowed to level `error` —
as its own clause. `index.networkErrors` is deliberately not a clause: post-process records every
`net.err` there, then keeps only the ones `isCountableNetworkFailure` accepts in `failedReqs`, so
the trustworthy network errors already qualify and adding the array back would qualify a session on
a fetch the user cancelled by navigating away. Detector ranks are evidence weight; they are not a
place for another surface to read a boolean out of.

**Score is not list position.** `buildCausalGraph` runs unconditionally in the shipped finalize
path, so `applyCausalRerank` almost always applies, and its first sort key is a causal tier, not
score: roots and isolated candidates are ordered ahead of every high/medium-confidence symptom
before score is consulted. A standalone `low`/40 write that the graph called a root therefore
lists above a `medium`/66 write it called a symptom. That is a known limitation of the emitted
ordering, not of this rule; the ranks above decide relative weight, and MCP consumers should
compare rank, not list index.

This rule replaces an earlier binary boost that lifted a write to `high`/88 whenever any error
shared its request id or fell inside a wide ±5s window. On a real captured retry storm
(`ses_20260723_160942_5cb9d594a635`) that lifted an unrelated background job drain ~2.9s later to
the same `high`/88 tier as the failing checkout's own writes, on the time window alone. Under the
rule above the checkout's six writes are all `medium`/66 and the drain's three return to `low`/40.

## Data flow (end to end)

```
browser SDK (core)                      capture server / finalize (node)
──────────────────                      ────────────────────────────────
fetch wrapper ──► structured-redacted   events.ndjson ──► evidence-index
  net.req/net.res bodies (B)               ├─ existing 23 detectors
DOM settle ──► ui.num snapshots (C)        ├─ A1 db_delta_mismatch  (payload ↔ db.diff)
backend SDK ──► backend.* + db.diff        ├─ A2 ineffective_input  (payload ↔ response/diff names)
  (unchanged)                              ├─ C1 ui_arithmetic_mismatch (ui.num)
                                           └─ C2 ui_api_divergence     (ui.num ↔ net.res)
                                        ──► CANDIDATES.md / fix-context / MCP (unchanged readers)
```

## Error handling

- Redaction parse failures (malformed JSON, size cap) fall back to v1 full redaction —
  never drop the event, never throw into the host app.
- `ui.num` collector is wrapped like every collector: observer errors disable the
  collector for the session and mark it degraded in the manifest (`degradedCollection`).
- Detectors treat missing/legacy (v1-redacted) bodies as "no evidence" and stay silent —
  old sessions produce no new signals and no errors.

## Testing

- Unit: classifier table tests (deny names, Luhn, JWT, entropy, enum-keep); A1 pairing and
  aggregation; A2 stem map; C1 label-role arithmetic; C2 correlation windows. Fixture
  sessions under `packages/node/src/__tests__/` following `evidence-index-db-diff.test.ts`.
- Integration: three new playground regressions, patch-activated like #16–#23:
  - **#24 over-decrement** (P1 patch) → expects `db_delta_mismatch` in N1, absent in N.
  - **#25 silent-coupon-accept** (P2 patch) → expects `ineffective_input` in N1 + coupon
    field visible (non-redacted) in the captured payload.
  - **#26 display-total-drops-tax** (P3 patch) → expects `ui_arithmetic_mismatch` in N1.
  - `pnpm playground:verify --all --json` green is the release gate; `BUGS.md` gains the
    three entries per playground rules.

## Rollout

1. Pillar B lands first (core 0.6.0) — capture must precede analysis; v2 tag keeps readers
   compatible.
2. Pillar A detectors + fixtures (node 0.8.0).
3. Pillar C collector (core 0.6.x) + detectors (node 0.8.x).
4. Playground regressions #24–#26 + `BUGS.md` update, wired into `verify:smoke`.

Each step is independently shippable; a step's failure blocks nothing already released.
