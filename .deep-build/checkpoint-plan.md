# Checkpoint plan: Confluence spec oracle (Slice C)

Implementation map: `docs/specs/2026-07-19-confluence-spec-oracle-design.md`

## Executive decisions carried into the run

- **D1** Advisory only. A Confluence page annotates, never suppresses a finding.
- **D2** Separate Confluence authorization. `JIRA_OAUTH_SCOPES` is not widened,
  so existing connected Jira tenants are not forced to re-consent.
- **D3** Slice C (agent-invoked tool) ships before Slice B (automatic trigger).
  B has nothing to call until C exists, and B's threshold cannot be tuned
  without usage data that only C produces.
- **D4** Knowledge gaps use the `code` lane. `EvidenceGap.lane` is typed
  `EvidenceLane` and the spec forbids adding `docs`. `code` is the closest
  existing value, and the field is inert here because `KnowledgeResult` returns
  directly to the caller and never enters `assembleBundle`. Adding a new lane
  value is rejected.

## Checkpoints

### CP1. `knowledge.v1` contract, CQL builder, gap vocabulary
Pure, I/O-free core. Types, CQL construction and sanitization, gap helper,
`ageDays` derivation against an injectable clock.
Files: `packages/node/src/knowledge/{types,cql,gaps}.ts`,
`packages/node/src/__tests__/knowledge-cql.test.ts`.
Prerequisites: none.
Verification: vitest on the new unit test, `tsc --noEmit`, `EvidenceLane` untouched.

### CP2. Confluence client
Env-only credentials, bounded CQL fetch, redaction at the boundary, never throws.
Files: `packages/node/src/knowledge/{confluence,index}.ts`,
`packages/node/src/__tests__/fixtures/confluence/*.json`,
`packages/node/src/__tests__/knowledge-confluence.test.ts`.
Prerequisites: CP1.
Verification: four degradation cases each yield a gap not a rejection; credential
fixture asserted scrubbed; no live request; `EVIDENCE_SOURCE_PROVIDERS` unchanged.

### CP3. `searchSpecs` MCP tool
Tool declaration, dispatch, argument validation. `spaceKeys` may only narrow the
operator allowlist, never widen it.
Files: `packages/node/src/mcp-server.ts` (edit),
`packages/node/src/__tests__/mcp-search-specs.test.ts`.
Prerequisites: CP2.
Verification: `tools/list` includes the documented schema; unconfigured host
returns a gap-bearing result rather than an MCP error.

### CP4. Boundary guards, operator docs, doctor surface
Converts the "not an evidence adapter" claim from prose into failing tests.
Files: `packages/node/src/__tests__/knowledge-boundary.test.ts`,
`docs/integrations/confluence-spec-oracle.md`,
`packages/node/src/doctor.ts` (edit), `docs/integrations/README.md` (edit).
Prerequisites: CP2.
Verification: guard assertions fail when violated; doctor reports presence
without leaking the token; `evidence-sources-doc-consistency.test.ts` green.

## Dependency graph

```
CP1 -> CP2 -+-> CP3   (concurrent)
            +-> CP4   (concurrent)
```

Serialized by logic: CP1 -> CP2 (CP2 consumes the contract and gap helper),
CP2 -> CP3, CP2 -> CP4.

Concurrent: CP3 and CP4 once CP2 is committed. File scopes are disjoint. CP3
touches `mcp-server.ts` and MCP tests; CP4 touches `doctor.ts`, `docs/`, and a
new guard test. This is the run's one clean concurrency opportunity.

Watch item: if `packages/node/src/__tests__/mcp-server.test.ts` asserts
`tools/list` exhaustively, it becomes a shared-edit hotspot for CP3.
