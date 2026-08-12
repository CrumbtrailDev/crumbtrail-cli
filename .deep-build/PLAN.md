# Deep Build — an external observability tool borrowables

**Run:** `deep-build/agent-evidence-loop`
**Main product:** worktree `/Users/os/repos/worktrees/crumbtrail-an external observability tool`, branch `deep-build/agent-evidence-loop`, base `bf7a9b8a`
**CLI / SDK:** worktree `/Users/os/repos/worktrees/crumbtrail-cli-an external observability tool`, branch `deep-build/agent-evidence-loop`, base `4038928`

18 checkpoints · **critical path 4** · 4 waves · no file with more than 2 writers.

Source note: the previous run's artifacts were renamed to `.deep-build/plan-model-catalogue.md`
and `.deep-build/decisions-model-catalogue.md`. This filesystem is case insensitive, so writing
`PLAN.md` would otherwise have destroyed `plan.md`.

---

## Six facts every builder must know before touching anything

These were verified by reading the code, not inferred. Three of them contradict the brief.

**1. `packages/cloud` depends on a PUBLISHED `crumbtrail-node`, not the workspace.**
`packages/cloud/package.json:32` pins `"crumbtrail-node": "^0.17.0"`; it resolves to a registry
tarball at `node_modules/.pnpm/crumbtrail-node@0.17.0_playwright@1.61.1`. The CLI worktree is at
`0.26.0`. `crumbtrail-node` is not a member of the main repo's pnpm workspace. **Nothing added in
the CLI repo during this run reaches the hosted product until `crumbtrail-node` is published and
that caret is bumped.** Publishing is out of band (`gh workflow run release.yml`) and is NOT a
checkpoint. To exercise a CLI change against the main repo locally, use
`node scripts/dev-harness/link.mjs link --target /Users/os/repos/worktrees/crumbtrail-an external observability tool`
from the CLI worktree; it swaps the leaf symlink and touches no manifest.

**2. The hosted MCP dispatch is name agnostic — new tools need ZERO cloud code.**
`packages/cloud/src/mcp-hosted/dispatch.ts:130` (`listTools`) proxies `tools/list` through the
installed `McpServer` and filters `LOCAL_ONLY_TOOLS` (7 bug-queue names, line 39). It imports no
tool table. A new tool appears on the hosted endpoint automatically once fact 1 is satisfied.
Only edit `LOCAL_ONLY_TOOLS` if a tool must be HIDDEN from hosted.

**3. A new MCP tool that reads only through `this.store` works hosted for free.**
`McpReadStore` (`packages/node/src/mcp-read-store.ts:3`) has exactly four methods, and
`events.ndjson.zst` is in the hosted artifact allowlist (`packages/cloud/src/routes/agent-routes.ts:58`).
`toolGetWindow` has no `FilesystemMcpReadStore` guard, unlike `getRegressionContext`
(`mcp-server.ts:2004`). **Any new tool that touches `fs` directly silently breaks hosted mode.**

**4. CORRECTION TO THE BRIEF — `intent-baseline.ts` cannot be reused by the correlation scorer.**
The dependency arrow runs cloud → `crumbtrail-node`. A scorer living in `packages/node` (which is
where `getWindow` lives) cannot import from `packages/cloud`. Separately,
`resolveIntentBaselineWindows` (`intent-baseline.ts:579`) hour floors and brand types its windows,
so it rejects sub hour highlight windows outright, and Benjamini Hochberg is **not a function** —
it is inlined at `intent-baseline.ts:1041-1060` and mutates domain objects. What IS portable is
`standardNormalCdf` + `erfc` (`intent-baseline.ts:834-862`, 28 dependency free lines). Copy those
with an attribution comment; write `ksTwoSample` and `benjaminiHochberg` fresh in the CLI repo.

**5. CORRECTION TO THE BRIEF — `fetch-all.ts` cannot be reused by live probes either.**
`packages/cloud/src/evidence-sources/fetch-all.ts` is cloud side; probes run inside the customer's
app, in `crumbtrail-core`. Borrow its **discipline**, not its code: never throw
(`fetchOne`, lines 98-166), one `AbortController` per unit with a `Promise.race` timeout, a global
byte cap folded in deterministic order (lines 244-261), redaction at the boundary, and an `ok` flag
derived by the framework rather than read from adapter free text (lines 270-278).

**6. The server to SDK channel ALREADY EXISTS and already carries an action verb.**
`BugLogger.startConfigPolling` (`packages/core/src/bug-logger.ts:682`) polls
`GET /api/capture-config?projectKey=` every 60s (`DEFAULT_CONFIG_POLL_INTERVAL_MS`, line 109) and is
the **only** place the SDK reads a response body. `hasRemoteCaptureTrigger` (line 1511) already lets
the server cause `this.flag()` in a live app (lines 772-777). `REMOTE_CONFIG_KEYS` (line 118) is the
existing allowlist precedent. There is no websocket and no SSE anywhere in the cloud. The ingest
POST response is an entirely unused channel — `HttpTransport` (`packages/core/src/transports/http.ts`)
checks `response.ok` and discards the body on all six calls.

---

## Wave plan

```
WAVE 1 (9 parallel, no prerequisites)
  MAIN  CP-P3 probe request plane   CP-P4 completeness names a probe
        CP-E1 detector class table  CP-B2 shadow back test    CP-V1 agent verification routes
  CLI   CP-P1 probe registry        CP-W1 correlation scorers
        CP-S1 skills scaffold+gate  CP-B1 backtest command

WAVE 2 (6 parallel)
  MAIN  CP-E2 namespace join  <- E1        CP-E3 consensus at mint  <- E1
  CLI   CP-P2 probe dispatch  <- P1        CP-W2 getWindowCorrelation <- W1
        CP-S2 skills batch A  <- S1        CP-S3 skills batch B     <- S1

WAVE 3 (1)
  CLI   CP-V2 verification MCP tools  <- V1, W2

WAVE 4 (2 parallel, different repos)
  MAIN  CP-DOCS-A      CLI  CP-DOCS-B
```

**Critical path (4):** `CP-W1 -> CP-W2 -> CP-V2 -> CP-DOCS-B`.
Counting dependency edges only it would be 3; the fourth link is the shared file lock on
`packages/node/src/mcp-server.ts` between CP-W2 and CP-V2 (see contention map).

**The six features are genuinely independent.** Live probes, correlation scoring, skills,
back test, ensemble and fix verification share no source file. This is six parallel fans, not a
chain. The only cross fan edge in the whole plan is the mcp-server.ts file lock.

---

# MAIN PRODUCT CHECKPOINTS

Worktree `/Users/os/repos/worktrees/crumbtrail-an external observability tool`. Run tests from the touched package dir.
`packages/cloud` is 228 files and about fifty seconds — always name the file.

---

## CP-P3 — Probe request plane (live probes, cloud half)

**Repo:** MAIN · **Prereqs:** none · **Shippable alone:** yes (queue empty until something enqueues)

### Goal
Let an authorized agent request a named probe for a project, and hand that name to the running SDK
over the channel that already exists.

### In scope
- New table + migration for a bounded per project pending probe queue: `(tenant_id, project_id,
  probe_name, requested_by, requested_at, expires_at, delivered_at)`, unique on
  `(tenant_id, project_id, probe_name)` so a repeat request is idempotent rather than a second row.
  **Read `packages/cloud/src/db.ts` and take the next free migration id** — migrations are numbered
  SQL blobs inside `db.ts`, there is no `supabase/migrations` dir, and the previous run had to
  renumber 126/127 to 128/129 at merge.
- `packages/cloud/src/routes/capture-config-routes.ts`: add `probes: string[]` to the 200 body
  (currently 7 fields, lines 46-54). Names only. Cap the array at 4. Mark rows delivered so a probe
  is requested once. The route is unauthenticated beyond the project key and sets
  `Access-Control-Allow-Origin: *` — **it must never carry anything but names from a fixed
  vocabulary.** Do not widen `Cache-Control: private, max-age=60` without saying why.
- New `packages/cloud/src/routes/agent-probe-routes.ts` with `POST /api/agent/probe`, copying the
  gate order in `tenant-playbook-routes.ts:53-119` exactly: `resolveAgentCaller` (401) →
  `ctx.agentReadLimiter.check` (429 + `Retry-After`) → `validId(project)` + `authorizeAgentProject`
  (404) → enqueue. Emit `emitDataAccessAuditEvent` + `emitAgentReadAuditEvent` on every path, as
  that file's local `audit()` helper does. Register in `packages/cloud/src/server.ts`.
- Reject any probe name not in the vocabulary with 400 and the allowed list.

### Out of scope
- Anything inside the SDK (CP-P1, CP-P2).
- Probe RESULT ingestion: results arrive as ordinary events through `/api/events`, which needs no
  change.
- Dashboard surfacing.
- Docs (CP-DOCS-A).

### Files
`packages/cloud/src/db.ts` · `packages/cloud/src/routes/capture-config-routes.ts` ·
`packages/cloud/src/routes/agent-probe-routes.ts` (new) · `packages/cloud/src/server.ts` ·
`packages/cloud/src/probe-queue.ts` (new) ·
`packages/cloud/src/__tests__/agent-probe-routes.test.ts` (new) ·
`packages/cloud/src/__tests__/capture-config-routes.test.ts`

### Done when
- [ ] An unknown probe name is refused with 400 and the response names the allowed set.
- [ ] Two identical POSTs produce one queue row, not two.
- [ ] A queued probe appears exactly once in the `/api/capture-config` body, then never again.
- [ ] An expired row is never delivered.
- [ ] Missing agent token → 401; wrong project → 404; over the read limiter → 429 with `Retry-After`.
- [ ] Every path emits both audit events.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool/packages/cloud
pnpm vitest run src/__tests__/agent-probe-routes.test.ts src/__tests__/capture-config-routes.test.ts
```
Paste the pass line and the assertion names for the four refusal cases.
**pg-mem caveat carried forward from the last run:** pg-mem has no advisory locks, no `SET LOCAL`,
one connection, and does not enforce `bigint` range. Do not claim a concurrency property this suite
cannot see. If you add a lock, say in the checkpoint report that it is untested against real Postgres.

---

## CP-P4 — Completeness gaps name the probe that would fill them now

**Repo:** MAIN · **Prereqs:** none · **Shippable alone:** yes

### Goal
Turn `EvidenceSlot.fix` from advice about future capture into a named, callable action.

### In scope
- `packages/evidence-brief/src/completeness.ts`: add `probe?: string` beside `fix?: string`
  (`EvidenceSlot`, line 42-51) and a `PROBE_VOCABULARY` const. Set `probe` only on absent slots and
  only where a probe genuinely helps: `code_location` → nothing (a probe cannot recover a stack
  after the fact — say so in the `detail`, do not fake it); `surrounding_context` →
  `storage.snapshot`; `failing_request` → `network.inflight`; `link_provenance` → nothing.
  Being honest about which gaps a probe cannot fill is the point of the slot model.
- Add `probes: string[]` to `EvidenceCompleteness` beside `captureFixes` (line 53-61), derived the
  same way (`gaps.map(s => s.probe).filter(Boolean)`).
- Drift guard test in the style of `packages/cloud/src/__tests__/evidence-link-vocabulary.test.ts`,
  which already guards the cloud `LinkMethod` union against `INFERRED_METHODS`. **The vocabulary is
  DECLARED here, not imported from the CLI repo** — a cross repo import is impossible (fact 1), and
  this is the repo's established pattern for exactly that situation.
- `packages/dashboard/src/pages/Detail.tsx` (assessCompleteness at 53-61, render at 1020-1022):
  show the probe name on a gap that has one. Design system components only, `--ds-*` tokens only,
  no hard coded colour. User facing strings carry no hyphens, en dashes or em dashes.

### Out of scope
- Executing a probe. This checkpoint only names one.
- `evidence-brief-assembly.ts` and `agent-routes.ts` — the new fields ride the existing
  `EvidenceCompleteness` through them with no edit.
- Docs (CP-DOCS-A).

### Files
`packages/evidence-brief/src/completeness.ts` · `packages/evidence-brief/src/completeness.test.ts` ·
`packages/evidence-brief/src/probe-vocabulary.test.ts` (new) ·
`packages/dashboard/src/pages/Detail.tsx` · `packages/dashboard/src/pages/Detail.test.tsx`

### Done when
- [ ] A `complete` grade emits `probes: []`.
- [ ] A missing `surrounding_context` emits both a `fix` string and `probe: "storage.snapshot"`.
- [ ] A missing `code_location` emits a `fix` and **no** `probe`, and the test asserts that absence.
- [ ] The grade computation is unchanged (grade is computed before the provenance slot is appended,
      `completeness.ts:402-407`, and linkage caps only downward, line 427 — do not disturb either).
- [ ] The dashboard renders the probe name and the page test asserts it.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool/packages/evidence-brief
pnpm vitest run src/completeness.test.ts src/completeness-linked.test.ts src/probe-vocabulary.test.ts
cd ../dashboard && pnpm vitest run src/pages/Detail.test.tsx
cd ../dashboard && pnpm vitest run src/styles/design-system-gate.test.ts
```

---

## CP-E1 — Classify every detector, not 29 of them

**Repo:** MAIN · **Prereqs:** none · **Shippable alone:** yes · **Highest value per minute in the run**

### Goal
`DETECTOR_CLASSES` maps 29 detector names; the SDK emits 99. The other ~70 fall to `"other"` and,
by the module's own doc comment, join nothing on predicate 3. Complete the table.

### In scope
- `packages/cloud/src/incident-grouping.ts`: `DetectorClass` (line 149) and `DETECTOR_CLASSES`
  (line 191). Classify all remaining detector names into the existing seven classes
  (`http | db | runtime | console | ui | user | other`). Add a class only if a genuine family has no
  home; do not invent one per detector, which would defeat predicate 3's different class test.
- Turn the existing sweep into a hard gate. `packages/cloud/src/__tests__/incident-grouping.test.ts`
  already resolves the INSTALLED `crumbtrail-node` dist (`sdkRequire.resolve`, lines 17-20) and
  sweeps `detector:` literals out of it. Make an unclassed name a **failure**, with the failure
  message naming the unmapped detectors so the next person can fix it in one pass.
- Deliberately leaving a detector as `"other"` is allowed but must be an explicit entry in the map
  with a one line reason, not a fallthrough.

### Out of scope
- Any change to `shouldJoin` (CP-E2) or to identity minting (CP-E3).
- The SDK side. Detector names are read out of the installed dist.

### Files
`packages/cloud/src/incident-grouping.ts` · `packages/cloud/src/__tests__/incident-grouping.test.ts`

### Done when
- [ ] Every `detector:` literal in the installed `crumbtrail-node` dist resolves to a non default
      class, or to `"other"` by an explicit map entry.
- [ ] The sweep fails, with a useful message, when a detector name is unmapped.
- [ ] No existing grouping assertion in the 42K suite regresses.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool/packages/cloud
pnpm vitest run src/__tests__/incident-grouping.test.ts
```
Also state, in the report, how many names were newly classed and the per class counts.
**Gotcha:** `packages/node/src/distinct-bugs.ts` in the CLI repo contains a non UTF8 byte, so plain
`grep` treats it as binary and returns nothing. Use `grep -a` when cross checking names.
**Gotcha:** this test reads the INSTALLED dist. If another agent relinks the CLI worktree
(fact 1), rerun.

---

## CP-E2 — Join the backend and frontend correlation namespaces

**Repo:** MAIN · **Prereqs:** CP-E1 (same file) · **Shippable alone:** yes

### Goal
Close the named residual cause of 1.50 canonical issues per single planted bug. PRODUCT.md:68 and
:195 both diagnose it identically: "a backend signal records the API path in `route` while a
frontend signal records the page route, and a frontend request id is a browser local sequence
number where the backend carries a shared correlation id, so the same failure seen from both sides
fails every predicate."

### In scope
- `packages/cloud/src/incident-grouping.ts`, `shouldJoin` (line 506) and its fact builders
  (`routeOf` line 397, `statusOf`, `BugFacts`):
  - Predicate 3's `a.route === b.route` becomes a namespace aware comparison. A backend fact
    carrying an API path and a frontend fact carrying a page route are compared through a normalized
    key that can relate them (the frontend request whose url path equals the backend route), not by
    raw string equality.
  - `sharesRequestId` must stop treating a browser local sequence number as a shared correlation id.
    A frontend request id that is not a shared correlation id joins on its url, not on its id.
- Preserve the `Guarded<T>` discipline exactly (`UNPARSEABLE` is neither present nor absent — a
  malformed value must refuse the join, never switch the guard off; see the `statusesAgree` doc
  comment). Preserve symmetry: the union must not depend on input order.
- Add fixtures to `incident-grouping.test.ts` shaped from the real split: one backend
  `http_error` on `/api/orders` and one frontend `console_error` on page route `/orders`, same
  window, that must now become ONE incident; plus a negative case that must still stay apart.

### Out of scope
- Identity minting (CP-E3). This checkpoint changes grouping only.
- Re running the playground corpus (see the honesty note below).

### Files
`packages/cloud/src/incident-grouping.ts` · `packages/cloud/src/__tests__/incident-grouping.test.ts`

### Done when
- [ ] The backend/frontend fixture pair groups into one incident with a stable primary.
- [ ] A genuinely unrelated pair on a superficially similar route still does not join.
- [ ] Shuffling the input yields identical incidents and identical primaries.
- [ ] No existing assertion in the 42K suite regresses.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool/packages/cloud
pnpm vitest run src/__tests__/incident-grouping.test.ts src/__tests__/incident-identity.test.ts src/__tests__/incident-projection.test.ts
```
**Honesty requirement, stated in the checkpoint report:** the 1.50 figure is a HAND measurement over
17 stored playground captures. There is no script that computes it — `crumbtrail-playground`'s
`scripts/verify.mjs` `applyBounds` (lines 171-236) asserts presence bounds (`count >= 1`) and
therefore cannot detect over reporting at all. The playground is a third repository with no worktree
in this run. **Do not claim a new number.** Claim what the fixtures prove, and record the re measure
as a manual follow up.

---

## CP-E3 — Consensus before a second issue is minted

**Repo:** MAIN · **Prereqs:** CP-E1 · **Shippable alone:** yes

### Goal
an external observability tool's false positive fix was unanimity across independent models, not threshold tuning. The
transferable principle here: a lone signal from one detector family should not mint a canonical
issue beside a corroborated incident in the same session.

### In scope
- `packages/cloud/src/incident-identity.ts`: before minting identity for an incident, apply a
  consensus test. An incident whose members are all one `DetectorClass` AND which carries no
  identity grade evidence (no shared request id — predicate 1 is the only identity predicate; all
  others are proximity) does not mint a new canonical issue when a multi class incident survived in
  the same session. It attaches as an occurrence instead.
- The rule must be conservative in the safe direction: when nothing else survived, a lone signal
  still mints. Suppressing the only issue in a session is strictly worse than over reporting.
- Reuse `detectorClass` and `compareDetectorClass` from `incident-grouping.ts` — import, do not
  copy. `incident-projection.ts` already imports `compareDetectorClass` for its corroboration
  census; read that first, it is the nearest existing notion of corroboration.
- Fixture tests, both directions.

### Out of scope
- Any change to `incident-grouping.ts` (CP-E1, CP-E2 own that file).
- Operator merge/split, which stays exactly as it is.

### Files
`packages/cloud/src/incident-identity.ts` · `packages/cloud/src/__tests__/incident-identity.test.ts`

### Done when
- [ ] A lone `console_error` beside a corroborated http+runtime incident attaches rather than minting.
- [ ] The same lone `console_error` as the ONLY incident in a session still mints.
- [ ] An incident with a shared request id mints regardless of class count.
- [ ] The 89K identity suite passes unchanged otherwise.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool/packages/cloud
pnpm vitest run src/__tests__/incident-identity.test.ts src/__tests__/canonical-issues.test.ts
```

---

## CP-B2 — Back test the detectors over history, writing nothing

**Repo:** MAIN · **Prereqs:** none · **Shippable alone:** yes

### Goal
an external observability tool replays 7 days of real history through an alert definition before it is deployed, showing
every transition it would have produced and notifying nobody. Do the same for shadow detectors.

### In scope
- New `packages/cloud/src/shadow-backtest.ts`: run the pure `ShadowDetector`s from
  `packages/cloud/src/shadow-detectors.ts` (`ShadowDetector` interface line 64,
  `DEFAULT_SHADOW_WINDOW_MS` 14d, `DEFAULT_MIN_DISTINCT_SESSIONS` 3) over a historical window and
  return what they WOULD have proposed. **Zero writes**: no `recordShadowCandidate`, no audit, no
  metrics, no memory writeback. `shadow-runtime.ts` already documents a "ZERO EXTERNAL MUTATION"
  discipline — this is that, pointed backwards.
- Report per candidate whether it would clear the project's current thresholds, read through
  `getCodeFixPrRules` (`packages/cloud/src/autonomy-policy.ts:635`;
  `DEFAULT_CODE_FIX_PR_RULES` line 504 = `{min_confidence: 0.8, real_issue: true,
  max_diff_lines: 300, max_open_prs: 3}`) and `resolveAutonomyLevel` (line 277). That is the
  "before it is enabled" half: the operator sees what turning the level up would have done.
- New `packages/cloud/src/routes/agent-backtest-routes.ts` with
  `GET /api/agent/shadow-backtest?project=&days=`, gates copied from `tenant-playbook-routes.ts`
  (agent caller → read limiter → project authz → audit). Bound `days` and cap the result set.

### Out of scope
- Any dashboard page. The primary reader is an agent over MCP; a human surface is a follow up.
- An MCP tool. This ships as a route; the tool would be a third writer of `mcp-server.ts`.
- The CLI detector back test (CP-B1) — different repo, different corpus, no shared code.

### Files
`packages/cloud/src/shadow-backtest.ts` (new) ·
`packages/cloud/src/routes/agent-backtest-routes.ts` (new) · `packages/cloud/src/server.ts` ·
`packages/cloud/src/__tests__/shadow-backtest.test.ts` (new)

### Done when
- [ ] A back test over a seeded history returns the candidates the forward runtime would have
      proposed, and the test asserts **row counts in `canonical_issue_shadow_candidates` and the
      audit table are unchanged** before and after. That assertion is the whole point.
- [ ] Each result says whether it clears the project's current thresholds and which rule it failed.
- [ ] 401 / 404 / 429 behave as on `/api/agent/playbook`.
- [ ] `days` outside bounds is refused, not silently clamped to something surprising.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool/packages/cloud
pnpm vitest run src/__tests__/shadow-backtest.test.ts src/__tests__/shadow-detection.test.ts src/__tests__/shadow-candidate-routes.test.ts
```

---

## CP-V1 — An agent can open a verification window and read the verdict

**Repo:** MAIN · **Prereqs:** none · **Shippable alone:** yes (route unused until CP-V2)

### Goal
Fix verification is ~80% built and closed to agents. Open the two ends.

### What already exists (do not rebuild any of it)
`packages/cloud/src/verification-engine.ts` — pure `evaluateVerification`, closed `VerificationReason`
vocabulary (`recurrence_detected | clean_observation_window | window_incomplete | window_too_short |
no_telemetry | insufficient_traffic | no_recurrence_low_traffic`, lines 53-61), thresholds at 89-97,
half open `[start, end)` windows, and the thesis "an absence of evidence is never a verified fix".
`verification-runtime.ts` — bounded tick, 7 day window, 50 per tick, idempotent, writes
`canonical_issue_verifications` (migration 25, `db.ts:1020`) and appends to
`issue_memory.resolution_history` (migration 26, `db.ts:1044`) via
`appendVerifiedResolutionForSignatures` (`issue-memory.ts:904`). Recall reweights on it
(`issue-memory.ts:221-234`, `resolution_verified` / `resolution_recurred`).

### The actual gap
`verification_started` is emitted from exactly one place: `linkReleaseForIssue`
(`canonical-fix-linkage.ts:190`). Only a RELEASE opens a window. `resolveIssue` from MCP does not,
and there is no agent readable verdict.

### In scope
- New `packages/cloud/src/routes/agent-verification-routes.ts`:
  - `POST /api/agent/verification` — open a window for one canonical issue after an agent applied a
    fix. Emit `verification_started` through `emitCanonicalIssueAuditEvent` with the agent as
    `actor`, exactly as `linkReleaseForIssue` does. **Idempotent**: an issue with an open window
    returns that window rather than opening a second, which is what the runtime's open window query
    (`verification-runtime.ts:152`, `event_type = 'verification_started' AND v.id IS NULL`) requires
    to stay correct.
  - `GET /api/agent/verification?project=&issue=` — return `{state, observationStart,
    observationEnd, result, reason, strategy, confidence}` where `state` distinguishes
    `open | terminal | none`. Reuse the stale window cutoff already in
    `canonical-issue-detail.ts:320-340`; do not invent a second staleness rule.
- Gates copied from `tenant-playbook-routes.ts`, including the plan gate if issue memory gating
  applies. Audit on every path.

### Out of scope
- Any change to the engine, the runtime, the thresholds, or the comment poster.
- The MCP tools (CP-V2).
- Auto remediation. an external observability tool's explicit non goal, and ours.

### Files
`packages/cloud/src/routes/agent-verification-routes.ts` (new) · `packages/cloud/src/server.ts` ·
`packages/cloud/src/__tests__/agent-verification-routes.test.ts` (new)

### Done when
- [ ] POST twice for one issue yields one `verification_started` audit event and the same window.
- [ ] GET returns `none` before, `open` during, and the terminal row's `result` + `reason` after the
      runtime tick writes one.
- [ ] The reason surfaced is from the closed vocabulary, verbatim — an inconclusive verdict must
      read as inconclusive to the agent, never as verified.
- [ ] 401 / 404 / 429 match `/api/agent/playbook`.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool/packages/cloud
pnpm vitest run src/__tests__/agent-verification-routes.test.ts src/__tests__/verification-runtime.test.ts src/__tests__/canonical-fix-linkage.test.ts
```

---

## CP-DOCS-A — Main product docs for all six features

**Repo:** MAIN · **Prereqs:** CP-P3, CP-P4, CP-E2, CP-E3, CP-B2, CP-V1 · **Atomic with the run**

### Why this is one checkpoint and not six
AGENTS.md requires docs in the same change as the behaviour. Taken per checkpoint that makes
`PRODUCT.md` a seven writer file — by far the worst contention in the plan and the only structural
problem the naive decomposition produces. Consolidating into one terminal checkpoint per repository
is the extraction. **The unit of change is the pull request, and the PR does contain the docs.**
The PR must not merge without this checkpoint.

### In scope
- `PRODUCT.md`: `## Capture` (25) for probes; `## Analysis` (64) for the correlation tool, the
  detector class completion and the consensus gate; `## Agent access: MCP` (131) for the new tools
  and routes; `## Known gaps in one place` (190). **Two gap lines must be rewritten honestly, not
  deleted:** line 192 "Bug reproduction: no op seam, not implemented" — probes are introspection at
  incident time, they are NOT reproduction, and the line must keep saying reproduction is not
  implemented while noting what probes do instead. Line 195, the 1.50 figure — update only if a
  measurement supports it; if CP-E2 shipped without a re measure, say the change landed and the
  number has not been re measured.
- `README.md` `## MCP tools` (185) and `## Hosted MCP access` (43) — line 54 hard codes "The seven
  bug-queue tools", still true, leave it.
- `docs/llms.txt` "Common tasks" bullets (line 8 names specific tools).
- `docs/launch/capability-ledger.json` — every relaunch claim must trace to an entry; checked by
  `scripts/launch/relaunch-gate.mjs`.
- Landing copy (`landing/web/lib/copy/product.ts`, `home.ts`) ONLY if a capability is publicly
  claimed. Gated capabilities need `GATING_LANGUAGE` ("off by default" / "you turn it on" /
  "when you enable"), `landing/web/lib/copy.test.ts:42`.
- **Every string added anywhere in this checkpoint: no hyphens, en dashes or em dashes in ordinary
  prose.** `copy.test.ts:107` enforces it for landing; hold the same bar in `PRODUCT.md` and
  `README.md` by hand.

### Out of scope
- CLI repo docs (CP-DOCS-B). Separate repository, separate commit — the workspace guide forbids a
  cross repo commit.
- New capability claims. Describe only what the other checkpoints actually shipped, and read their
  diffs rather than their checkpoint reports. The last run's post mortem found three defects whose
  shared root cause was "claims written from what someone believed the code did".

### Files
`PRODUCT.md` · `README.md` · `docs/llms.txt` · `docs/launch/capability-ledger.json` ·
`landing/web/lib/copy/product.ts` (conditional) · `landing/web/lib/copy/home.ts` (conditional)

### Done when
- [ ] Every shipped checkpoint in this repo has a PRODUCT.md line, with an honest status marker.
- [ ] The reproduction gap line still says reproduction is not implemented.
- [ ] No claim about the 1.50 metric that a measurement does not support.
- [ ] All copy gates pass.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool/landing/web && pnpm vitest run lib/copy.test.ts lib/relaunch-copy.test.ts lib/blog/blog-copy.test.ts
cd /Users/os/repos/worktrees/crumbtrail-an external observability tool && pnpm verify:positioning-language && pnpm verify:quickstart-docs
node scripts/launch/relaunch-gate.mjs
```
Then a manual dash sweep over the diff:
`git diff --unified=0 -- PRODUCT.md README.md docs/llms.txt | grep -nE '[[:alnum:]]-[[:alnum:]]'`
and justify every surviving hit as a technical string, path, package name or flag.

---

# CLI / SDK CHECKPOINTS

Worktree `/Users/os/repos/worktrees/crumbtrail-cli-an external observability tool`.
**This repo does NOT use the main repo's `sharedTestOptions()` or the machine wide lock** —
`scripts/test/vitest-defaults.mjs` exists only in the main product. Its per package configs are
plain. Still run the narrowest file; `packages/node` has 177 test files.

---

## CP-P1 — Probe registry and built in probes

**Repo:** CLI · **Prereqs:** none · **ATOMIC WITH CP-P2** (inert and undocumented on its own)

### Goal
A named, permissioned, bounded introspection registry inside `crumbtrail-core`.

### In scope
- New `packages/core/src/probes.ts`:
  - `PROBE_NAMES` — a frozen allowlist. Start with `runtime.env`, `storage.snapshot`,
    `network.inflight`, `flags.current`. This is the same vocabulary CP-P4 declares in the main repo.
  - `ProbeResult` — a structured table, not free text:
    `{ name, ok, columns: string[], rows: unknown[][], rowCount, truncated, latencyMs, error?: string }`.
    A table is what an agent can read; a paragraph is not.
  - `runProbe(name, ctx)` — **never throws.** One `AbortController` + `Promise.race` timeout per
    probe (default 2s, this runs in a user's live app), a row cap, a serialized byte cap folded in
    deterministic order, and `ok` derived by the framework rather than read from the probe's own
    words. All four rules are lifted from `packages/cloud/src/evidence-sources/fetch-all.ts`
    (lines 98-166 and 244-278) — read that file, copy the discipline, import nothing.
  - Every value crosses the existing redaction path before it leaves the probe.
- Pure module. No transport, no timers outside the probe, no globals.

### Out of scope
- Any wiring into `bug-logger.ts` (CP-P2).
- Probes that need app cooperation (a DOM selector, an arbitrary expression). **Never** accept a
  selector, a URL, an expression or anything code shaped from the server; see CP-P2's security note.

### Files
`packages/core/src/probes.ts` (new) · `packages/core/src/__tests__/probes.test.ts` (new) ·
`packages/core/src/index.ts` (export)

### Done when
- [ ] An unknown name returns `ok: false` with a refusal and runs nothing.
- [ ] A probe that hangs is aborted at the deadline and returns `ok: false, error: "timeout"` —
      the test asserts no rejection escapes.
- [ ] A probe that throws returns `ok: false`, never propagates.
- [ ] Over the row cap and over the byte cap both set `truncated: true` and drop from a deterministic
      end, and a repeat run drops identically.
- [ ] Redaction is asserted on at least one probe that can see a value.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool/packages/core
pnpm vitest run src/__tests__/probes.test.ts
```

---

## CP-P2 — Dispatch probes from the config poll; delete CaptureDirective

**Repo:** CLI · **Prereqs:** CP-P1 · **ATOMIC WITH CP-P1**

### Goal
Run a requested probe in the live app and ship the result, over the channel that already exists.
Remove the dead advisory mechanism it replaces.

### In scope
- `packages/core/src/bug-logger.ts`:
  - `readRemotePolicySettings` (line 1313) / `applyRemoteConfig` (line 727) accept
    `probes: string[]`. **Names only.** Filter against `PROBE_NAMES`, cap at 4 per poll, drop
    unknown names silently rather than erroring, and never pass a value from the payload into a
    probe as an argument.
  - Run the surviving probes and emit each `ProbeResult` as an event (`k: "probe.result"`) through
    the existing transport. No new endpoint, no new SDK HTTP call.
  - Follow `hasRemoteCaptureTrigger` (line 1511) as the precedent for a server initiated action, and
    `REMOTE_CONFIG_KEYS` (line 118) as the precedent for the allowlist.
- **Delete, in this checkpoint, per the pre release stance:** `CaptureDirective`
  (`packages/core/src/fusion.ts:138-145`), the `directives` field on `RankedBundle` (line 156),
  `suggestCaptureDirectives` (lines 640-660), its call site (line 214), `INFORMATIVE_LANES`
  (line 618), and `packages/core/src/__tests__/fusion-directives.test.ts`. It is computed,
  serialized, and read by nothing in either repository — verified by an exhaustive grep. Probes are
  its replacement; leaving both is a dual path.

### Out of scope
- `packages/cloud/src/__tests__/bundle-routes.test.ts:40` (`directives: []`) in the MAIN repo. It
  typechecks against the PUBLISHED `crumbtrail-node@0.17.0`, which still carries the field, so this
  deletion cannot break it. Record it as a deferred consumer cleanup for the version bump.
- The cloud half (CP-P3).

### Security note the builder is held to
`readRemotePolicySettings` is deliberately permissive about envelope shape and merges five nested
candidate objects. That is safe today **only** because `REMOTE_CONFIG_KEYS` is a fixed allowlist of
scalars. A probe field carrying anything resembling code, a URL or a selector destroys that
property. The repo already treats this as an injection surface —
`packages/cloud/src/__tests__/mcp-sentry-parity.test.ts:454-459` asserts directives do not echo
`rm -rf` from injected content. Add the equivalent assertion here.

### Files
`packages/core/src/bug-logger.ts` · `packages/core/src/fusion.ts` (deletions) ·
`packages/core/src/__tests__/probe-dispatch.test.ts` (new) ·
`packages/core/src/__tests__/fusion-directives.test.ts` (delete) ·
`packages/core/src/__tests__/fusion-contract.test.ts` (drop directive assertions)

### Done when
- [ ] A poll returning `{probes: ["storage.snapshot", "evil.exec", "../../etc/passwd"]}` runs exactly
      one probe and emits exactly one result event.
- [ ] A poll returning a probe entry shaped as an object with a selector, url or expression is
      rejected wholesale; the test asserts nothing was executed.
- [ ] More than 4 names are capped.
- [ ] `grep -rn "CaptureDirective\|suggestCaptureDirectives\|INFORMATIVE_LANES" packages/` returns
      nothing.
- [ ] The remaining fusion suite passes with the directive assertions removed, not skipped.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool/packages/core
pnpm vitest run src/__tests__/probe-dispatch.test.ts src/__tests__/probes.test.ts
pnpm vitest run src/__tests__/fusion-assemble.test.ts src/__tests__/fusion-contract.test.ts src/__tests__/fusion-hypotheses.test.ts src/__tests__/fusion-ranking.test.ts src/__tests__/fusion-context-fields.test.ts
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool && grep -rn "CaptureDirective" packages/ || echo "clean"
```

---

## CP-W1 — Window correlation scorers (pure)

**Repo:** CLI · **Prereqs:** none · **ATOMIC WITH CP-W2**

### Goal
A detector free "what changed in this window" engine, so a bug no hand written detector anticipated
still surfaces. We have ~99 detectors known to overfit to our corpora; this sidesteps that ceiling.

### In scope
- New `packages/node/src/stats.ts`: `standardNormalCdf` and `erfc`, copied from
  `packages/cloud/src/intent-baseline.ts:834-862` in the MAIN repo with a comment naming the source
  and why it is a copy (see fact 4 — the import is impossible, not merely inconvenient). Plus
  `ksTwoSample(a: number[], b: number[])` and `benjaminiHochberg(pValues: number[], q: number)`
  written fresh. BH exists nowhere as a reusable function today; it is inlined at
  `intent-baseline.ts:1041-1060` and mutates domain objects.
- New `packages/node/src/window-correlation.ts`:
  `correlateWindow(events: BugEvent[], { t0, t1, baselineMultiplier = 4 })`.
  - Baseline is **half open** `[t0 - 4w, t0)` against highlight `[t0, t1]`. `toolGetWindow`'s
    filter is fully inclusive on both ends (`mcp-server.ts:2483-2487`); reusing that shape would
    double count the boundary event.
  - Two complementary scorers, both required. **Volume delta** — percent change of averages over
    per `k` counts. It catches "was flat, then spiked", which KS misses. **KS two sample** over
    numeric fields. It catches a distribution shift at constant volume, which the volume scorer
    misses. Neither alone is the feature.
  - `BugEvent` is `{t, k, d}` with `d` untyped (`packages/core/src/types.ts:75-96`). There is no
    schema for `d`, so the KS scorer needs an **explicit per kind numeric field map** (start with
    `net.res` → duration, status, bytes). Declare it as data; do not guess generically.
  - Rank by p value, cut with BH FDR, return `{dimension, kind, field, scorer, pValue, direction,
    baselineStat, highlightStat}` rows.
- Pure. No I/O, no store, no fs.

### Out of scope
- The MCP tool (CP-W2).
- Scoring over anomaly flags. **There is no per event anomaly flag in this product** — verified,
  zero non test hits for `anomal` in either repo's `src`. `score`/`severity` live on candidates,
  never on events. an external observability tool's third mode has no substrate here; do not fake one.

### Files
`packages/node/src/stats.ts` (new) · `packages/node/src/window-correlation.ts` (new) ·
`packages/node/src/__tests__/stats.test.ts` (new) ·
`packages/node/src/__tests__/window-correlation.test.ts` (new)

### Done when
- [ ] Synthetic stream A (flat baseline, spike in highlight, same value distribution) is caught by
      the volume scorer and NOT by KS — asserted both ways.
- [ ] Synthetic stream B (equal counts, shifted latency distribution) is caught by KS and NOT by the
      volume scorer — asserted both ways.
- [ ] A no change stream returns zero rows after BH.
- [ ] `standardNormalCdf` agrees with known quantiles (0 → 0.5, 1.96 → ~0.975) to the fit's stated
      1.2e-7.
- [ ] BH is verified against a hand computed vector, including the "last index where p <= threshold"
      cutoff rule.
- [ ] The boundary event at exactly `t0` lands in the highlight and not the baseline.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool/packages/node
pnpm vitest run src/__tests__/stats.test.ts src/__tests__/window-correlation.test.ts
```

---

## CP-W2 — `getWindowCorrelation` MCP tool

**Repo:** CLI · **Prereqs:** CP-W1 · **SOLE WRITER of `mcp-server.ts` until it lands** · **Shippable**

### Goal
Expose CP-W1 to an agent, in both local and hosted mode.

### In scope
- `packages/node/src/mcp-server.ts`, exactly three edits (the file is 3117 lines and hand rolled;
  there is no SDK registration API and no zod):
  1. Append a descriptor to `const TOOLS = [` (line 258, closes 902). Copy the shape of
     `recordFeedback` (854-884) verbatim, including `/** @stability stable */` and
     `type: "object" as const`. Reuse `MAX_TOKENS_SCHEMA` (line 115). Snake case aliasing is
     automatic via `snakeCaseToolName` (907) — no alias edit.
  2. Add `case "getWindowCorrelation": return this.toolGetWindowCorrelation(args);` to the
     `callTool` switch (1072-1146).
  3. Implement `private async toolGetWindowCorrelation(args)`, modelled on `toolGetWindow`
     (2458-2514): resolve the dir with `sessionDirAsync`, load with `readColdEventsAsync` (2654)
     — **through `this.store` only, never `fs`** (fact 3) — call `correlateWindow`, and return
     through `budgetedTextResult` with a `budgetPlane` so `maxTokens` behaves like every other tool.
- Params: `sessionId` (required), `t0`, `t1` (required, absolute ms), `baselineMultiplier`
  (optional, default 4, bounded), `limit`, `maxTokens`.
- Bump `expect(result.tools).toHaveLength(35)` at
  `packages/node/src/__tests__/mcp-server.test.ts:125`.
- The tool description is read by an agent as its only instruction. Write it as such: say what
  question it answers, when to reach for it instead of `getWindow`, and that a low p value is a
  correlation and not a cause.

### Out of scope
- `LOCAL_ONLY_TOOLS` in the main repo. Not needed: dispatch is pass through (fact 2), and this tool
  reads only through the store, so hosted works.
- `packages/cloud/package.json`'s caret. Out of band (fact 1).

### Files
`packages/node/src/mcp-server.ts` · `packages/node/src/__tests__/mcp-server.test.ts` ·
`packages/node/src/__tests__/mcp-hierarchical.test.ts`

### Done when
- [ ] `tools/list` includes `getWindowCorrelation`; the count assertion is bumped, not weakened.
- [ ] A fixture session with a planted spike returns the spiking kind as the top row.
- [ ] An unknown session returns `isError`, matching `getWindow`'s behaviour (test at
      `mcp-hierarchical.test.ts:362`).
- [ ] `maxTokens` truncates with a `dropReport`, like every other budgeted tool.
- [ ] **A test drives the tool through a non filesystem store** and it answers, proving hosted mode.
      `mcp-remote-store.test.ts` shows the harness.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool/packages/node
pnpm vitest run src/__tests__/mcp-server.test.ts src/__tests__/mcp-hierarchical.test.ts src/__tests__/mcp-remote-store.test.ts
```

---

## CP-V2 — Fix verification MCP tools

**Repo:** CLI · **Prereqs:** CP-V1 (the routes), CP-W2 (file lock on `mcp-server.ts`)
**Atomic with CP-V1** — without the routes these tools always error.

### Goal
Close the loop in the agent's own session: after a fix, watch the same signature through the same
channel and report resolved or recurred back to the agent that made the change.

### In scope
- `packages/node/src/learning-loop.ts`: `startFixVerificationViaCloud` and
  `getFixVerificationViaCloud`, copying `getAgentPlaybookViaCloud` (line 220) exactly — same base
  url resolution, same agent token header, same result envelope, same failure shape so
  `learningLoopFailure` keeps working.
- `packages/node/src/mcp-server.ts`: two tools, same three edit pattern as CP-W2.
  `startFixVerification { project, canonicalIssueId, fixRef? }` and
  `getFixVerification { project, canonicalIssueId }`. Bump the tool count assertion again.
- The `getFixVerification` description must be explicit that an inconclusive verdict is not a fix,
  and must name the closed reason vocabulary. `verification-engine.ts:18-22` states the invariant:
  an absence of evidence is never a verified fix. An agent that reads "inconclusive" as "done"
  defeats the whole feature, and the description is the only place to prevent that.
- Consider whether `resolveIssue` (`mcp-server.ts:815`, handler 2274) should call
  `startFixVerification` when `disposition` indicates a fix was applied. **Decide and state the
  call in the checkpoint report.** Recommendation: keep them separate. `resolveIssue` records a
  disposition; opening an observation window is a distinct act with a distinct cost, and coupling
  them makes every disposition write open a window.

### Out of scope
- Any cloud change (CP-V1).
- A local/offline verification path. The runtime is cloud only and stays so.

### Files
`packages/node/src/learning-loop.ts` · `packages/node/src/mcp-server.ts` ·
`packages/node/src/__tests__/mcp-learning-loop.test.ts`

### Done when
- [ ] Both tools appear in `tools/list`; the count assertion is bumped.
- [ ] Against a mocked cloud, `startFixVerification` posts to `/api/agent/verification` with the
      agent token and returns the window.
- [ ] `getFixVerification` surfaces `result` and `reason` verbatim; a test asserts an
      `insufficient_traffic` verdict does NOT render as verified anywhere in the payload.
- [ ] Unconfigured cloud (`CRUMBTRAIL_CLOUD_URL` absent) returns the same gap shape `getPlaybook`
      returns, not a crash.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool/packages/node
pnpm vitest run src/__tests__/mcp-learning-loop.test.ts src/__tests__/mcp-server.test.ts
```

---

## CP-S1 — Skills plugin scaffold and the gate that keeps skills true

**Repo:** CLI (the public repository) · **Prereqs:** none · **Shippable alone:** yes

### Goal
an external observability tool ships 49+ installable skills that pair archetype knowledge with the exact queries to run.
We have none. Build the frame and, more importantly, the gate that stops a skill naming a tool or a
parameter that does not exist.

### In scope
- `plugins/crumbtrail-skills/.claude-plugin/plugin.json`, modelled on the existing
  `plugins/crumbtrail-mcp/.claude-plugin/plugin.json` (the CLI copy is the richer one: it has
  `$schema`, `license: MIT`, `homepage: https://crumbtrail.ai`).
- `.claude-plugin/marketplace.json` at the repo root listing both plugins. First one in the repo.
- One reference `SKILL.md` establishing the shape every archetype skill follows:
  **symptom → what Crumbtrail can see → the exact MCP call sequence with real parameters →
  how to tell this archetype from its neighbours → what a null result means.**
- **The gate**, `plugins/__tests__/skills.test.ts`: for every `SKILL.md` under `plugins/`, parse the
  MCP tool names and parameter names it mentions, then validate them against the live tool table by
  constructing an `McpServer` and calling `handleMessage({ method: "tools/list" })` — which is
  precisely how `packages/cloud/src/mcp-hosted/dispatch.ts:139` reads the list, because `TOOLS` is
  not exported. Fail on an unknown tool name or an unknown parameter. Also assert required
  frontmatter.
- Add a vitest config for the new suite if one is needed.

### Out of scope
- Writing archetype content (CP-S2, CP-S3).
- Reconciling the drifted `plugins/crumbtrail-mcp` manifests between the two repositories. Note it
  as a follow up; it is a second repo and not this run's job.

### Files
`plugins/crumbtrail-skills/.claude-plugin/plugin.json` (new) · `.claude-plugin/marketplace.json` (new) ·
`plugins/crumbtrail-skills/skills/_reference/SKILL.md` (new) · `plugins/__tests__/skills.test.ts` (new) ·
`plugins/vitest.config.ts` (new, if required) · root `vitest.config.ts` (add the project glob)

### Done when
- [ ] The gate fails on a deliberately broken fixture skill naming `getNonexistentTool`.
- [ ] The gate fails on a skill passing `sessionID` to a tool whose parameter is `sessionId`.
- [ ] The gate passes on the reference skill.
- [ ] The manifests parse against their `$schema`.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool
pnpm vitest run plugins/__tests__/skills.test.ts
```
Show the failing run on the broken fixture and the passing run after removing it.

---

## CP-S2 — Six archetype skills, batch A

**Repo:** CLI · **Prereqs:** CP-S1 · **Shippable alone:** yes

### Goal
Six installable skills whose knowledge is real and whose queries actually run.

### In scope
One `SKILL.md` per archetype, from the Tier 1 families in
`/Users/os/repos/worktrees/crumbtrail-an external observability tool/fables-analysis/failure-archetypes-universal.md`
(`## The 19 universal families`, line 35). Batch A, chosen because Crumbtrail telemetry can
genuinely serve them:
1. the new path parity gap
2. the stale cache / derived state no invalidate
3. the async lifecycle race
4. the lying status
5. the missing key detonation (payload is not the model)
6. the timezone / locale / format boundary

Each names a real MCP call sequence with real parameters. Prefer the progressive disclosure the
product already recommends: `getLatestIssue` or `listSessions` → `getSessionManifest` →
`getEvidence` → `getWindow`, plus `getRecurrence` and `listDistinctBugs({mode:"cross-session"})`
for the recurrence shaped archetypes. Where CP-W2's `getWindowCorrelation` fits an archetype whose
signature no detector names, use it — that is the archetype it was built for.

### Hard constraints
- **Never write the employer's name, and never name the corpus provenance.** The source file's
  header identifies the organisation; read it for content, copy none of that. Archetype names and
  mechanisms only. No ticket keys, no counts attributable to one company.
- No hyphens, en dashes or em dashes in prose. Tool names, parameters and paths are exempt.
- No claim about what Crumbtrail detects that is not true today. Where an archetype needs a signal
  we do not capture, say so plainly in the skill — a skill that overpromises is worse than no skill,
  because the agent burns a turn on a query that answers nothing.

### Out of scope
Batch B (CP-S3). Any change to the gate (CP-S1 owns it).

### Files
`plugins/crumbtrail-skills/skills/{new-path-parity,stale-derived-state,async-lifecycle-race,lying-status,missing-key-detonation,format-boundary}/SKILL.md` (6 new)

### Done when
- [ ] Six skills exist, each with the five section shape.
- [ ] The CP-S1 gate passes on all six.
- [ ] `grep -ri "<employer>" plugins/` returns nothing (the builder substitutes the real string,
      which is not written in this plan by design).
- [ ] A dash sweep over the six files returns only technical strings.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool
pnpm vitest run plugins/__tests__/skills.test.ts
grep -rnE '[[:alnum:]]-[[:alnum:]]' plugins/crumbtrail-skills/skills/ | grep -v '`'
```
Then run one skill's call sequence by hand against a local session and paste the output. A skill
whose queries were never executed is a guess.

---

## CP-S3 — Six archetype skills, batch B

**Repo:** CLI · **Prereqs:** CP-S1 · **Parallel with CP-S2, disjoint files** · **Shippable alone:** yes

Identical contract to CP-S2. Batch B:
1. the dependency bump double edge
2. the wrapped thing changed seam (unowned contract)
3. the silent hard limit and scale cliff
4. the dangling reference / orphan cascade
5. the flag / toggle landmine
6. the env to env promotion blind spot

### Files
`plugins/crumbtrail-skills/skills/{dependency-bump,unowned-contract,scale-cliff,orphan-cascade,flag-landmine,env-promotion}/SKILL.md` (6 new)

### Done when / Verification
As CP-S2, over these six files.

---

## CP-B1 — `crumbtrail-server backtest`

**Repo:** CLI · **Prereqs:** none · **Shippable alone:** yes

### Goal
Replay stored sessions through the current analyzer and report what it WOULD flag, changing nothing
on disk. Today `reanalyze` does the replay but **overwrites in place**, and its `--dry-run` only
checks that a cold stream exists (`run-reanalyze.ts:80-90`). The diff is the missing primitive.

### In scope
- New `packages/node/src/run-backtest.ts`, mirroring `run-reanalyze.ts`:
  - Copy the cold artifacts (`events.ndjson.zst`, `signatures.json`, and whatever
    `readColdEvidenceArtifacts` needs) into a temp dir, run `reanalyzeSession` **there**, then diff
    the produced `candidates.jsonl` against the stored one.
  - Report per session: `would_newly_flag`, `would_stop_flagging`, `unchanged`, with detector name
    and title for each; then totals. `--json` for a machine reader.
  - Two modes, one flag apart: a single session id or dir, and `--all` / a corpus directory. Reuse
    `findFinalizedSessionDirs` (`run-reanalyze.ts:120`), which already handles both the flat layout
    and the `{tenant}/{app}/{date}/{sessionId}` partition.
- Register in `packages/node/src/commands.ts` (`Command` union and `COMMAND_WORDS`), dispatch in
  `packages/node/src/cli.ts` next to `reanalyze` (line 292), and add the data driven per subcommand
  help entry the file's convention requires.

### Out of scope
- Modifying `reanalyzeSession` or `analyzeSession`. The temp dir copy needs neither.
- Anything cloud side (CP-B2).
- An MCP tool. It would be a third writer of `mcp-server.ts` for no gain; a back test is an
  operator act before enabling, not an incident time read.

### Files
`packages/node/src/run-backtest.ts` (new) · `packages/node/src/commands.ts` ·
`packages/node/src/cli.ts` · `packages/node/src/__tests__/backtest.test.ts` (new) ·
`packages/node/src/__tests__/commands.test.ts`

### Done when
- [ ] **The original session directory is byte identical after a run** — hash every file before and
      after and assert. This is the load bearing property; a back test that mutates the evidence it
      is testing against is worse than none.
- [ ] A fixture where the analyzer's output differs reports the exact candidate under
      `would_newly_flag`.
- [ ] A fixture where it does not differ reports `unchanged` and an empty diff.
- [ ] A session with no cold stream is skipped with a reason, never failed.
- [ ] `--json` output parses and carries the same totals as the text form.
- [ ] `crumbtrail-server backtest --help` prints focused help.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool/packages/node
pnpm vitest run src/__tests__/backtest.test.ts src/__tests__/commands.test.ts src/__tests__/run-reanalyze.test.ts
```
Then run it for real against a session under `~/.crumbtrail/sessions` and paste the output plus a
`find` mtime listing of that directory before and after.

---

## CP-DOCS-B — CLI repo docs

**Repo:** CLI · **Prereqs:** CP-P2, CP-W2, CP-S2, CP-S3, CP-B1, CP-V2 · **Atomic with the run**

### In scope
- `packages/node/README.md`: `## MCP evidence retrieval` (195) — **line 198 hard codes "Its
  thirty-five canonical tools"**, bump it to the real number. `### Progressive disclosure workflow`
  (209) — add `getWindowCorrelation` where it belongs in the sequence. The learning loop section
  (226) — add the two verification tools. `## Public API boundary` (433) and `## What this does not
  claim yet` (445).
- `packages/node/README.md` server CLI section — document `backtest`.
- Root `README.md` `## MCP bug context` (35) and its prose tool mentions (53-58).
- `plugins/crumbtrail-skills/README.md` — how to install the skills.
- No hyphens, en dashes or em dashes in prose.

### Out of scope
Main repo docs (CP-DOCS-A). Separate repository, separate commit.

### Done when
- [ ] Every hard coded tool count is correct.
- [ ] Every tool and command this run added appears in the right README section.
- [ ] Nothing is claimed that the diffs do not support — read the diffs, not the checkpoint reports.

### Verification
```
cd /Users/os/repos/worktrees/crumbtrail-cli-an external observability tool
pnpm verify:integration-docs
pnpm vitest run plugins/__tests__/skills.test.ts
git diff --unified=0 -- '*.md' | grep -nE '[[:alnum:]]-[[:alnum:]]'
```

---

# Dependency graph

```
MAIN                                   CLI
CP-P3  (none)                          CP-P1  (none) ──> CP-P2
CP-P4  (none)                          CP-W1  (none) ──> CP-W2 ─┐
CP-E1  (none) ──> CP-E2                CP-S1  (none) ──> CP-S2  │
              └─> CP-E3                              └─> CP-S3  │
CP-B2  (none)                          CP-B1  (none)            │
CP-V1  (none) ─────────────────────────────────────────> CP-V2 <┘
                                                    (V1 = API dep,
                                                     W2 = file lock)

CP-DOCS-A <- P3, P4, E2, E3, B2, V1
CP-DOCS-B <- P2, W2, S2, S3, B1, V2
```

| Checkpoint | Prereqs |
| --- | --- |
| CP-P1 | — |
| CP-P2 | CP-P1 |
| CP-P3 | — |
| CP-P4 | — |
| CP-W1 | — |
| CP-W2 | CP-W1 |
| CP-S1 | — |
| CP-S2 | CP-S1 |
| CP-S3 | CP-S1 |
| CP-B1 | — |
| CP-B2 | — |
| CP-E1 | — |
| CP-E2 | CP-E1 |
| CP-E3 | CP-E1 |
| CP-V1 | — |
| CP-V2 | CP-V1, CP-W2 |
| CP-DOCS-A | P3, P4, E2, E3, B2, V1 |
| CP-DOCS-B | P2, W2, S2, S3, B1, V2 |

---

# File contention map

**No file has more than 2 writers.** No extraction checkpoint is required for source code.

| File | Writers | Order forced |
| --- | --- | --- |
| `cli:packages/node/src/mcp-server.ts` | CP-W2, CP-V2 | **yes** — W2 then V2 |
| `cli:packages/node/src/__tests__/mcp-server.test.ts` | CP-W2, CP-V2 | **yes** — both bump the tool count on one line |
| `main:packages/cloud/src/incident-grouping.ts` | CP-E1, CP-E2 | **yes** — E1 then E2 |
| `main:packages/cloud/src/__tests__/incident-grouping.test.ts` | CP-E1, CP-E2 | yes, same |
| `main:packages/cloud/src/server.ts` | CP-P3, CP-B2, CP-V1 | no — three one line route registrations in one list; if they collide, resolve trivially |
| `cli:packages/core/src/fusion.ts` | CP-P2 | sole |
| `cli:packages/core/src/bug-logger.ts` | CP-P2 | sole |
| `cli:packages/core/src/probes.ts` | CP-P1 | sole |
| `cli:packages/node/src/window-correlation.ts`, `stats.ts` | CP-W1 | sole |
| `cli:packages/node/src/learning-loop.ts` | CP-V2 | sole |
| `cli:packages/node/src/commands.ts`, `cli.ts` | CP-B1 | sole |
| `cli:plugins/__tests__/skills.test.ts` | CP-S1 | sole |
| `cli:plugins/crumbtrail-skills/skills/**` | CP-S2, CP-S3 | no — disjoint directories |
| `main:packages/cloud/src/incident-identity.ts` | CP-E3 | sole |
| `main:packages/cloud/src/db.ts` | CP-P3 | sole (**take the next free migration id; read it, do not assume**) |
| `main:packages/cloud/src/routes/capture-config-routes.ts` | CP-P3 | sole |
| `main:packages/evidence-brief/src/completeness.ts` | CP-P4 | sole |
| `main:packages/dashboard/src/pages/Detail.tsx` | CP-P4 | sole |
| `main:PRODUCT.md`, `README.md`, `docs/llms.txt`, `capability-ledger.json` | CP-DOCS-A | sole |
| `cli:packages/node/README.md`, root `README.md` | CP-DOCS-B | sole |

### The one structural problem, and how it was removed
Applying AGENTS.md's "docs in the same change" rule per checkpoint makes `PRODUCT.md` a **seven
writer file** and `packages/node/README.md` a **five writer file** — both far past the threshold,
both on the merge path of every fan. The extraction is CP-DOCS-A and CP-DOCS-B: one terminal,
repo scoped docs checkpoint each, prerequisite on every behaviour checkpoint in its repository.
The docs still ship in the same **pull request** as the behaviour, which is the unit AGENTS.md is
protecting; neither PR may merge without its docs checkpoint. Cost: one extra link at the end of
every fan. It does not lengthen the critical path, which is set by the mcp-server.ts lock.

### `packages/cloud/src/server.ts`
Three checkpoints append a route registration. Each is one line in a sequential list, they are in
different waves' reach, and a textual collision is a two second resolution. Not worth a fourth
checkpoint or a registry refactor of a 62K file.

---

# Critical path

**4.**

```
CP-W1  correlation scorers      (no prereqs)
  -> CP-W2  getWindowCorrelation   (dependency: needs the scorers)
  -> CP-V2  verification tools     (FILE LOCK: mcp-server.ts, not a dependency)
  -> CP-DOCS-B                     (dependency: documents what shipped)
```

Every other chain is 3 or shorter: `P1→P2→DOCS-B`, `S1→S2→DOCS-B`, `E1→E2→DOCS-A`,
`V1→V2→DOCS-B`, `E1→E3→DOCS-A`.

Counting dependency edges alone the longest chain is 3. The fourth link is purely the shared file
scope on `packages/node/src/mcp-server.ts` and its tool count assertion. It could be removed by
having CP-W2 register both features' tool descriptors and CP-V2 supply only the handler, but that
would put CP-W2 in the business of a feature it does not implement and would ship a registered tool
with no handler if CP-V2 slipped. 4 is under the limit; leave it.

---

# Shippability

| Checkpoint | Status |
| --- | --- |
| CP-P1 | **Atomic with CP-P2.** Tested but unreachable alone. |
| CP-P2 | Atomic with CP-P1. Together: shippable. |
| CP-P3 | Shippable. Queue is empty until an agent enqueues. |
| CP-P4 | Shippable. Names a probe; naming one is useful even before one runs. |
| CP-W1 | **Atomic with CP-W2.** Pure module, no caller. |
| CP-W2 | Atomic with CP-W1. Together: shippable. |
| CP-S1 | Shippable. Scaffold plus a gate, no claims. |
| CP-S2 | Shippable. |
| CP-S3 | Shippable. |
| CP-B1 | Shippable. |
| CP-B2 | Shippable. |
| CP-E1 | Shippable, and independently valuable — it improves predicate 3 on its own. |
| CP-E2 | Shippable. |
| CP-E3 | Shippable. |
| CP-V1 | Shippable. Route exists and is unused. |
| CP-V2 | **Atomic with CP-V1.** Without the routes the tools always error. V1 lands first, so V2 is shippable when it runs. |
| CP-DOCS-A | **Atomic with the main repo PR.** Must not merge without it. |
| CP-DOCS-B | **Atomic with the CLI repo PR.** Must not merge without it. |

---

# Standing rules for every builder

1. **Narrowest test, always.** `pnpm vitest run <file>` from the touched package. Full `pnpm test`
   happens once at the end of the run, not per checkpoint. Never set a worker count in a suite
   config; in the MAIN repo a new suite spreads `sharedTestOptions()` from
   `scripts/test/vitest-defaults.mjs`. The CLI repo has no such mechanism — do not add one.
2. **One repository per commit.** The workspace guide forbids a cross repo commit. Two PRs.
3. **Pre release stance.** No migration, compat shim, deprecated alias, dual path or legacy branch
   to preserve behaviour that has not shipped. When you replace something, delete its code, tests,
   flags and docs in the same checkpoint. CP-P2 is the one deletion in this plan; do it.
4. **No reviewer follows you.** Your own evidence is the only gate. Paste real command output. If
   verification is impossible, say exactly why rather than claiming a pass.
5. **Claims come from the code**, not from what you believe the code does. The previous run's post
   mortem traced three shipped defects to exactly that, including a consent screen describing a
   mechanism that was never wired.
6. **User facing prose carries no hyphens, en dashes or em dashes.** Technical strings, paths,
   package names and flags are exempt.
7. **Design system only** for any UI. `--ds-*` tokens, exported components, no local variant.
   `packages/dashboard/src/styles/design-system-gate.test.ts` will catch a redefined primitive.

# Known gotchas

- `cli:packages/node/src/distinct-bugs.ts` contains a non UTF8 byte. Plain `grep` treats it as
  binary and silently returns nothing. Use `grep -a`.
- `main:packages/cloud/src/__tests__/incident-grouping.test.ts` resolves the **installed**
  `crumbtrail-node` dist and sweeps detector name literals out of it. If another agent relinks the
  CLI worktree via `scripts/dev-harness/link.mjs`, rerun it.
- pg-mem has no advisory locks, no `SET LOCAL`, one connection, and does not enforce `bigint` range.
  A green cloud suite proves nothing about a two transaction race. Say so if you add a lock.
- The hosted `tools/list` is cached for an hour (`TOOLS_LIST_TTL_MS`, `dispatch.ts:55`). A warm
  client will not see a new tool immediately.
- `main:packages/cloud/src/mcp-hosted/protocol.ts:11` references a `./tools.ts` that does not exist,
  and `dispatch.ts:25` says "36 evidence tools" where the real count is 35. Stale comments; correct
  them if you are in the file anyway.

# Out of scope for this run, routed as follow ups

- **Publishing `crumbtrail-node` and bumping `packages/cloud/package.json:32` from `^0.17.0`.**
  Until that happens nothing added in the CLI repo reaches the hosted product. Out of band via
  `gh workflow run release.yml`; needs a founder. This is the run's single unfinishable seam and
  must be stated plainly in the final report.
- Re measuring canonical issues per planted bug. The harness lives in a third repository
  (`crumbtrail-playground`, `pnpm agent-eval:recall` / `pnpm playground:verify`), has no worktree
  here, and its scorer asserts presence bounds rather than counts, so it cannot measure over
  reporting at all. Building an issues per planted bug scorer is a real, separate work item.
- Removing the duplicated `plugins/crumbtrail-mcp/` from the main repo and reconciling the two
  drifted manifests.
- A human dashboard surface for the shadow back test.
- `main:packages/cloud/src/__tests__/bundle-routes.test.ts:40` still passes `directives: []`; clean
  it up at the version bump.
