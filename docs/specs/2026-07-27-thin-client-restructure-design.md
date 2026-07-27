# Thin Capture Client: Stop Shipping the Analysis Engine to Customers

Date: 2026-07-27
Status: Design for review — **not approved, not implemented**
Packages: `crumbtrail-node`, `crumbtrail-core`, `crumbtrail` (CLI), `crumbtrail-detect-core`,
and `crumbtrail/packages/{cloud,artifact-edge,artifact-protocol,capture-policy}`

## Problem

Customers cannot be expected to upgrade an npm package every time an analysis heuristic
changes. Today they must, because the analysis engine lives in their `node_modules`.

The measurable symptom, in this repository:

| Metric | Value |
| --- | --- |
| Commits since 2026-05-27 | 100 |
| Of those, release/version-bump commits | **41** |
| Published packages | 8 (`topology-harness` is private) |

Forty-one percent of all commit activity is release plumbing. PR #33 is the archetype: a
cosmetic evidence-title formatting fix that required publishing a new npm package to every
installed client.

### The cause is not the package count

The instinct to consolidate nine packages into fewer is right in spirit but aimed at the
wrong target. Measured (non-test LOC under each `src/`):

| Package | LOC | Role |
| --- | --- | --- |
| `crumbtrail-node` | **46,698** | backend capture **+ the entire analysis engine** |
| `crumbtrail-core` | 11,089 | browser/universal capture SDK |
| `crumbtrail` (CLI) | 4,342 | installer / wizard |
| `crumbtrail-detect-core` | 2,972 | project detection, recipes, version floors |
| `topology-harness` | 2,754 | internal, unpublished |
| `crumbtrail-react-native` | 1,297 | adapter |
| `crumbtrail-install-shared` | 370 | adapter |
| `crumbtrail-react` | 289 | adapter |
| `crumbtrail-tauri` | 58 | adapter |

The four small adapters total **2,014 LOC combined**. Merging them changes nothing about
release frequency. One package is 76% of the shipped code, and the volatile parts dominate it:

| File | Size |
| --- | --- |
| `evidence-index.ts` | 147.3K |
| `mcp-server.ts` | 130.4K |
| `llm-bundle.ts` | 125.5K |
| `server.ts` | 64.0K |
| `post-process.ts` | 56.3K |
| `causal-graph.ts` | 39.0K |
| `locate-incident.ts` | 29.5K |

None of that is capture. It is *interpretation* — detection heuristics, ranking, titles,
bundling — precisely the code that gets tuned weekly. Every backend recipe installs
`crumbtrail-node` as a regular dependency
([recipe-registry.ts:186](../../packages/detect-core/src/recipe-registry.ts:186)), so every
heuristic tweak becomes a customer-facing release plus a `SDK_VERSION_FLOORS` lockstep edit.

## What makes this tractable

The analysis code **already runs server-side**. It is not a rewrite, it is a move:

- `crumbtrail/packages/cloud/src/artifact-processing.ts:14` — `import { postProcess } from "crumbtrail-node"`
- Redaction policy is already applied at the edge: `artifact-edge/src/ingest/direct-ingest.ts:19`
  imports `crumbtrail-capture-policy`
- Server-side repo indexing already ships: `cloud/src/repo-index.ts` (104.2K),
  `vector-index.ts`, `canonical-code-context.ts`, plus a `RepoIndexProgress` dashboard UI
- The hosted ingest protocol already exists: `artifact-edge` serves `/v2/ingest/events/append`,
  `/v2/ingest/commit`, `/v2/ingest/delete`, with grant-based auth in
  `crumbtrail-artifact-protocol` (`grants.ts`, `envelope.ts`, `keys.ts`)

## The seam

All 46,698 LOC of `crumbtrail-node`, split by what genuinely forces execution on the
customer's machine:

| Bucket | LOC | Can it leave? |
| --- | --- | --- |
| Interpretation — evidence-index, llm-bundle, post-process, causal-graph, distinct-bugs, locate-incident, ai-diagnosis, fix-context, recall, compare | ~17,000 | Yes — pure functions over uploaded evidence |
| Third-party integrations — `evidence-sources/`, `knowledge/`, `ticket/` | **7,392** (verified) | Yes — and they *should*; they break on vendor schedules |
| Runtime instrumentation — `db/`, express, otel, auto-capture, session write, storage | ~8,800 | **No** — must hook the live process |
| Local repo access — source-map, code-pointers, `scan/`, `git-host/`, `replay/` | ~1,950 | Mostly — the repo index covers it now |
| Plumbing — mcp-server, cli, config, doctor | ~5,900 | Depends on the MCP decision |

**~24,600 LOC — over half the package — has no business in a customer's `node_modules`,**
and it is exactly the code that changes most often.

## Proposed target: 8 published packages → 4

| Package | Contents | LOC |
| --- | --- | --- |
| `crumbtrail-core` | Browser/universal capture. Absorbs `react` + `tauri` as subpath exports (`crumbtrail-core/react`) | ~11k → ~7k |
| `crumbtrail-node` | Backend capture **only**: db instrumentation, express/otel adapters, auto-capture, buffer, upload | **46.7k → ~9k** |
| `crumbtrail-react-native` | Stays separate — native linking makes folding it in a liability | ~1.3k |
| `crumbtrail` (CLI) | Installer + detection. Absorbs `detect-core` + `install-shared` | ~7.8k |

`topology-harness` stays internal. Cloud depends on both `crumbtrail` and
`crumbtrail-detect-core`, so folding detection into the CLI package does not strand it — but
that import must be updated in the same change.

### Why this stops the releases

Three things force a client release today; all three are removed:

1. **Analysis heuristics** → server-side, deploy continuously. This is what PR #33 was.
2. **Vendor API drift** → deleted from the client entirely (pending the decision below).
3. **Redaction/capture rules** → already server-side at the edge. `core/src/redaction.ts`
   is 1,998 LOC substantially duplicating `crumbtrail-capture-policy`.

What remains as a release trigger is the **wire contract**, and
`crumbtrail-artifact-protocol` already is that contract. Proposed rule: the server accepts
envelope version N and N−1 at minimum; clients ship only when the envelope shape changes.
That is a couple of releases a year rather than a couple a month.

## The genuinely new work

The clients do not speak the hosted protocol. `core/src/transports/http.ts` POSTs
`/api/events`, `/api/blob/:name`, `/api/session/start`, `/api/bug/flag` to a **local**
server. `artifact-edge` exposes `/v2/ingest/*` with grant auth. And
`crumbtrail-artifact-protocol` is **not a dependency of any package in this repo** (verified:
no match in `packages/*/package.json`).

So the critical path is a hosted transport in `crumbtrail-core` that acquires a grant and
speaks v2. The edge side is already built and tested; this is the client half only.

## Sequencing

Each step is independently shippable and independently revertible.

1. **Hosted transport in `core`** — new `HostedTransport` alongside `HttpTransport`, grant
   acquisition, v2 envelopes. Additive; nothing is removed. Unblocks everything else.
2. **Envelope compatibility rule** — server accepts N and N−1; add a contract test asserting
   it. This is what makes later client versions optional rather than mandatory.
3. **Move interpretation to cloud** — relocate the ~17k LOC. Cloud already imports
   `postProcess`; invert so cloud owns the code and node no longer exports it.
4. **Delete vendor integrations** — 7,392 LOC (see open question below).
5. **Consolidate adapters** — `react`/`tauri` into `core` subpaths; `detect-core`/
   `install-shared` into the CLI. Cosmetic by comparison; do it last, when it is only
   packaging.

Steps 1 and 2 deliver most of the benefit. Steps 3–5 are cleanup that the first two make safe.

## Open questions — blocking, need a decision

**1. Deleting `knowledge/` conflicts with recent deliberate work.**
The call was "don't worry about integrations, MCPs will get that data." Taken literally that
deletes `evidence-sources/` (7 vendors), `ticket/`, and `knowledge/`. But `knowledge/confluence.ts`
(39.3K) is the Confluence spec oracle, which has its own approved design
(`docs/specs/2026-07-19-confluence-spec-oracle-design.md`), a `deep-build/confluence-spec-oracle`
branch, and a **live `searchSpecs` tool exposed on the Crumbtrail MCP server**. Deleting it
would remove a shipped, externally-visible capability. Recommend: delete `evidence-sources/`
and `ticket/`, **keep `knowledge/`** until explicitly confirmed — or move it to cloud rather
than dropping it.

**2. Does the MCP server stay local or become hosted?**
The transcript recorded "remote-first, nothing second," which implies hosted. That removes
~5,900 LOC of plumbing from the client but changes how agents connect. Not yet decided.

**3. Package renames are breaking for existing installs.**
Folding `detect-core` and `install-shared` into `crumbtrail` deprecates two published names.
Existing installs need a migration path or a final deprecating release — which is itself a
forced client update, cutting against the goal. Sequencing step 5 last limits the damage.

## The honest tension

Adding rrweb-based visual replay and require-time log interception *adds* client code, which
cuts against "rarely ship updates."

The resolution is that the two kinds of code behave differently. What leaves (~24.6k of
heuristics, ranking, titles, vendor APIs) changed 41 times in 60 days. What arrives is
mechanically stable: rrweb's event format is versioned and slow-moving, and require-time
patching targets interfaces (`console`, `process.stdout`, pino/winston/bunyan) that change on
a multi-year cadence. The same technique already ships in `db/auto-instrument.ts`, which
monkey-patches pg/mysql/mssql/sqlite at require time with no customer configuration.

Licensing note, since it came up: **rrweb is MIT and the Sentry JavaScript SDK is MIT.**
Rewriting either "so it isn't plagiarism" does not work legally — paraphrasing does not escape
copyright and derivative works remain covered — but neither is necessary. Depending on rrweb
directly is both lawful and better: owning a rewrite means owning ~20k LOC of DOM-serialization
edge cases (canvas, shadow DOM, iframes, web fonts, CSS-in-JS), which is exactly the kind of
code that drags a team back into constant releases.

## Provenance

Design from a 2026-07-27 12:18pm session that ended before anything was written down.
All figures above were re-verified against `origin/main` at the time of writing rather than
carried over from that conversation.
