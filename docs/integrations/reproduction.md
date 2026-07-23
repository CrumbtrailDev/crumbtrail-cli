# Replaying a captured flow

## Live reproduction is not an MCP capability

Crumbtrail MCP is a read only context retrieval surface. It does not expose an
`allowReproduction` option, drive a browser, navigate a live application, or
record a new session. `solveContext` only analyzes supplied symptoms and
retrieved context.

Nothing below is reachable from the MCP bug context interface. Enabling live
reproduction through MCP would require a separate product and safety review.

## The library level replay adapter

`crumbtrail-node` exports a replay seam that a first party tool or a CI job can
call directly. It turns the `nav`, `clk` and `inp` events of a captured session
into an ordered flow, then either observes that flow or drives it through
Playwright and returns a `replay-result.v1` result.

```ts
import { buildReplayFlow, runReproduction } from "crumbtrail-node";

const flow = buildReplayFlow({
  sourceSessionId: "ses_20260723_101500_ab12cd",
  targetUrl: "http://localhost:4173/checkout",
  events, // the captured session's events
});

const outcome = await runReproduction({
  flow,
  allowReproduction: true,
  policy: {
    execute: true,
    allowlist: [{ origin: "http://localhost:4173", isolated: true }],
  },
});

if (outcome.attempted) {
  console.log(outcome.result); // replay-result.v1
} else {
  console.log(outcome.refusal); // { code, reason, remedy }
}
```

### Playwright is an optional peer dependency

Playwright is declared optional, is never imported statically, and is loaded
lazily the first time a replay actually executes. If it is not installed the
adapter returns a `driver_unavailable` refusal and the caller carries on. It
never throws and it never forces a browser download on a consumer who does not
replay.

```bash
pnpm add -D playwright
npx playwright install chromium
```

### Safety model

Four rules hold, in this order, and each one is enforced in
`packages/node/src/replay/policy.ts`:

1. **Observation only by default.** A replay runs only when the caller passes
   `allowReproduction: true` and the environment policy sets `execute: true`.
   Either one missing keeps the run in observation mode.
2. **Execution requires an allowlisted origin.** The flow's `targetUrl` origin
   must appear on the policy allowlist, and that entry must declare `isolated`,
   which is the operator asserting the environment's data is disposable. An
   allowlisted but non isolated origin is refused, because a replay could
   otherwise mutate data it must not touch.
3. **Captured secrets are never forwarded.** Credential bearing input values and
   query parameters are dropped when the flow is built, so they never reach the
   driver, and a flow that depends on one is refused outright rather than run in
   a state that cannot work. Every replay opens a fresh browser context with no
   stored state, no credentials and no extra headers, so nothing from the
   original session is replayed.
4. **A refusal always explains itself.** Every non executing run returns a
   structured refusal with a `code`, a `reason` and, where one exists, a
   `remedy`. There is no silent no op.

Navigations are also rebased onto `targetUrl`, so the origin the session was
captured against is never contacted.

### Per environment configuration

`replayPolicyFromEnv()` reads the policy from the process environment. Both
gates are required before anything executes.

| Variable | Meaning |
| --- | --- |
| `CRUMBTRAIL_REPLAY_EXECUTE` | `1` or `true` turns actuation on. Anything else keeps observation only. |
| `CRUMBTRAIL_REPLAY_ISOLATED_ORIGINS` | Comma separated http(s) origins. Listing an origin declares it an isolated environment whose data is disposable. Malformed entries are dropped. |
| `CRUMBTRAIL_REPLAY_MAX_STEPS` | Optional positive integer step budget. Defaults to 200. |
| `CRUMBTRAIL_REPLAY_STEP_TIMEOUT_MS` | Optional positive integer per step driver timeout. Defaults to 5000. |

### Refusal codes

| Code | Meaning |
| --- | --- |
| `no_replayable_steps` | The flow has no navigate, click or input steps. |
| `target_url_invalid` | The target is not a plain http(s) URL, or it embeds credentials. |
| `step_budget_exceeded` | The flow is longer than the configured budget. |
| `flow_carries_secret` | A step depends on a credential like value. |
| `reproduction_not_requested` | The caller did not pass `allowReproduction: true`. |
| `execution_not_enabled` | The environment is observation only. |
| `target_not_allowlisted` | The target origin is not on the execution allowlist. |
| `target_not_isolated` | The origin is allowlisted but not declared isolated. |
| `driver_unavailable` | Playwright is not installed, or a browser failed to start. |

The first four report `eligible: false`: no configuration change makes that flow
replayable as it stands. The rest report `eligible: true`: the flow is fine and
the environment has not opted in.
