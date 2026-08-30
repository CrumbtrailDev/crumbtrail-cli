# Serverless runtime checkpoint plan

## CP1: Request scoped invocation contract

Create `crumbtrail-core/serverless` with bounded correlation and lifecycle metadata, per invocation state, body exclusion, error preservation, and contained flush failures. Prove cold use, sequential warm reuse, overlapping isolation, and built subpath resolution.

- Prerequisites: none
- Scope: `packages/core/src/serverless/invocation.ts`, `packages/core/src/serverless/index.ts`, invocation and package boundary tests, `packages/core/package.json`, `packages/core/tsup.config.ts`
- Verification: targeted core serverless tests, core typecheck, core build
- Stop: atomic with CP2 or CP3

## CP2: Standards based Fetch adapter

Add a Request to Response wrapper under `crumbtrail-core/serverless`. Preserve Response and error identity. Schedule flush through `waitUntil` when supplied and await it otherwise. Prove success, error, abort, flush failure, and absence of Node runtime references.

- Prerequisites: CP1
- Scope: `packages/core/src/serverless/fetch.ts`, Fetch and edge boundary tests, `packages/core/src/serverless/index.ts`
- Verification: targeted core serverless tests, core typecheck and build, built output runtime reference scan
- Stop: shippable with CP1

## CP3: Node function adapters

Add async wrappers for API Gateway v1 and v2 compatible Lambda events, Vercel Node requests and responses, and Netlify events and results. Reuse CP1, flush before completion, preserve return and error identity, and reject unsupported callback use explicitly.

- Prerequisites: CP1
- Scope: new `packages/node/src/serverless/**`, node root exports, adapter and package boundary tests
- Verification: adapter, package boundary, Express, node HTTP, and auto capture tests, node typecheck and build, built ESM and CJS export checks
- Stop: shippable with CP1

## CP4: Serverless detection and honest setup plans

Detect Serverless Framework, AWS SAM, Vercel, Netlify, Workers, and Deno before Hono and generic Node. Add platform recipe IDs and exact adapter guidance. Change Workers from native OTLP guidance to the Fetch adapter path. Mutate only fixture proven deterministic exports and keep all ambiguous plans nonmutating and explicit.

- Prerequisites: CP2 and CP3
- Scope: CLI detection, recipe registry, injection types, snippets, recipes, integration, executor, CLI summaries, serverless recipe tests, parity and honesty tests, platform fixtures
- Verification: targeted CLI recipe, matcher, honesty, detection, and plan tests, CLI typecheck and build
- Stop: shippable

## CP5: Installer fixture lifecycle harness

Run the built and packed CLI through AWS, Vercel, Netlify, Workers, and Deno fixture families. Prove recipe selection, copyable guidance, no mutation for guided plans, idempotence for automatic plans, and truthful detected, guided, wired, and verified states.

- Prerequisites: CP4
- Scope: `scripts/lib/installer-recipes.mjs`, `scripts/verify-installers.mjs`
- Verification: `node scripts/verify-installers.mjs --group serverless --mode inproc`, including one deliberate assertion failure and restoration
- Stop: shippable

## CP6: Documentation, packaging, and aggregate verification

Document copyable Fetch and Node examples, prerequisites, environment, defaults, lifecycle, body exclusion, callback limitation, failure behavior, setup mode, and current release limits. Verify packed core and node exports through ESM and CJS, then run full touched package suites.

- Prerequisites: CP2, CP3, CP4, CP5
- Scope: serverless integration docs, affected package and root READMEs, fresh install verifier
- Verification: full core, node, and CLI tests, typechecks, builds, fresh install, serverless installer group
- Stop: shippable final state

## Dependency graph

`CP1 -> {CP2, CP3} -> CP4 -> CP5 -> CP6`

CP2 and CP3 run concurrently. All other checkpoints serialize on dependencies. The longest path is five checkpoints. Coordination count is six, at the allowed cap.

## File contention map

- `packages/core/src/serverless/index.ts`: CP1 then CP2.
- Every other core contract file: CP1 only.
- Every Fetch adapter file: CP2 only.
- Every Node adapter file: CP3 only.
- CLI detection, recipe, injection, summary, test, and fixture files: CP4 only.
- Installer harness files: CP5 only.
- Documentation and fresh install verifier files: CP6 only.

The only shared file is the core serverless barrel. Its CP1 to CP2 order already follows the dependency graph. No planned file has four or more writers.
