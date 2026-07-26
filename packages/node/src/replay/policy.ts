import { flowCarriesSecret } from "./flow";
import type {
  ReplayDecision,
  ReplayFlow,
  ReplayRefusal,
  ReplayRefusalCode,
} from "./types";

/**
 * Pure eligibility and permission logic for replay. No I/O, no driver, no
 * clock — a decision is a function of the flow and the policy alone, so every
 * safety rule below is unit-testable without a browser.
 *
 * Three invariants this module exists to hold:
 *
 * 1. **Observation only by default.** `execute` is opt-in twice over: the
 *    caller must pass `allowReproduction: true` *and* the environment policy
 *    must set `execute: true`. Either missing means `mode: "observe"`.
 * 2. **Nothing runs against an un-vetted target.** The target origin must be on
 *    {@link ReplayPolicy.allowlist} and that entry must declare `isolated`,
 *    which is the operator asserting the environment's data is disposable.
 * 3. **A refusal always explains itself.** Every `observe` decision carries a
 *    {@link ReplayRefusal} with a code, a reason and (where one exists) a
 *    remedy. There is no silent no-op path.
 */

/** An origin an operator has cleared for replay execution. */
export interface ReplayTargetAllowlistEntry {
  /** Exact http(s) origin, e.g. `http://localhost:3000`. Compared verbatim. */
  origin: string;
  /**
   * The operator asserts this environment's data is disposable. Without it a
   * replay could mutate data it is not allowed to touch, so execution is
   * refused even for an allowlisted origin.
   */
  isolated: boolean;
}

export interface ReplayPolicy {
  /** Master switch. Default false: the adapter observes and never actuates. */
  execute: boolean;
  /** Origins cleared for execution. Empty means nothing is executable. */
  allowlist: ReplayTargetAllowlistEntry[];
  /** Refuse flows longer than this. */
  maxSteps: number;
  /** Per-step driver timeout, milliseconds. */
  stepTimeoutMs: number;
}

export const DEFAULT_REPLAY_MAX_STEPS = 200;
export const DEFAULT_REPLAY_STEP_TIMEOUT_MS = 5_000;

/** Observation only, nothing allowlisted. The production default. */
export function defaultReplayPolicy(): ReplayPolicy {
  return {
    execute: false,
    allowlist: [],
    maxSteps: DEFAULT_REPLAY_MAX_STEPS,
    stepTimeoutMs: DEFAULT_REPLAY_STEP_TIMEOUT_MS,
  };
}

export function resolveReplayPolicy(
  overrides?: Partial<ReplayPolicy>,
): ReplayPolicy {
  return { ...defaultReplayPolicy(), ...removeUndefined(overrides ?? {}) };
}

/**
 * Reads the per-environment policy from the process environment.
 *
 * - `CRUMBTRAIL_REPLAY_EXECUTE=1|true` turns actuation on. Absent or anything
 *   else keeps the observation-only default.
 * - `CRUMBTRAIL_REPLAY_ISOLATED_ORIGINS` is a comma separated origin list. The
 *   variable name carries the assertion: listing an origin here declares it an
 *   isolated environment whose data is disposable. Malformed entries are
 *   dropped rather than silently widening the allowlist.
 *
 * Both are required for execution, so a single stray variable cannot make a
 * replay run.
 */
export function replayPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReplayPolicy {
  const policy = defaultReplayPolicy();
  policy.execute = isTruthyFlag(env.CRUMBTRAIL_REPLAY_EXECUTE);
  policy.allowlist = parseOriginList(
    env.CRUMBTRAIL_REPLAY_ISOLATED_ORIGINS,
  ).map((origin) => ({ origin, isolated: true }));

  const maxSteps = positiveInt(env.CRUMBTRAIL_REPLAY_MAX_STEPS);
  if (maxSteps !== undefined) policy.maxSteps = maxSteps;
  const timeout = positiveInt(env.CRUMBTRAIL_REPLAY_STEP_TIMEOUT_MS);
  if (timeout !== undefined) policy.stepTimeoutMs = timeout;

  return policy;
}

export interface ReplayRequestOptions {
  /**
   * The documented opt-in. Anything other than `true` keeps the replay in
   * observation mode — this is the argument CRUMB-41 required to stop being
   * inert, and `defaultReproducerFactory` now honours it.
   */
  allowReproduction?: boolean;
}

/**
 * Decides whether `flow` may be replayed and, if so, whether it may actuate.
 *
 * Checks run in a fixed order so the reported refusal is the most fundamental
 * one. Codes 1–4 are flow properties (`eligible: false` — no configuration
 * change makes this flow replayable as-is); codes 5–8 are permission gaps
 * (`eligible: true` — the flow is fine, the environment has not opted in).
 */
export function evaluateReplayPolicy(
  flow: ReplayFlow,
  policy: ReplayPolicy = defaultReplayPolicy(),
  options: ReplayRequestOptions = {},
): ReplayDecision {
  // 1. Shape: is there anything to replay at all?
  if (flow.steps.length === 0) {
    return ineligible(
      "no_replayable_steps",
      "The flow has no navigate, click or input steps to replay.",
      "Capture a session that records the failing interaction, then rebuild the flow.",
    );
  }

  // 2. Target: a replay always drives an explicit http(s) base URL.
  const targetOrigin = httpOrigin(flow.targetUrl);
  if (!targetOrigin) {
    return ineligible(
      "target_url_invalid",
      `The replay target ${JSON.stringify(flow.targetUrl)} is not an http(s) URL.`,
      "Set the flow's targetUrl to the http(s) base URL of an isolated environment.",
    );
  }

  // 3. Budget.
  if (flow.steps.length > policy.maxSteps) {
    return ineligible(
      "step_budget_exceeded",
      `The flow has ${flow.steps.length} steps, above the ${policy.maxSteps} step budget.`,
      "Narrow the captured window, or raise CRUMBTRAIL_REPLAY_MAX_STEPS for this environment.",
    );
  }

  // 4. Secrets. The raw value was already dropped when the flow was built; this
  //    refuses the replay rather than running a flow that silently cannot work.
  const secretStep = flowCarriesSecret(flow);
  if (secretStep) {
    return ineligible(
      "flow_carries_secret",
      `Step ${secretStep.index} (${secretStep.sig}) depends on a credential-like value: ${
        secretStep.value?.kind === "secret"
          ? secretStep.value.reason
          : "unknown"
      }. Captured secrets are never forwarded into a replay.`,
      "Replay a flow that reaches the failure without a credential, or seed the isolated environment with a fixture account outside the captured session.",
    );
  }

  // 5. Caller opt-in.
  if (options.allowReproduction !== true) {
    return notPermitted(
      "reproduction_not_requested",
      "Reproduction was not requested, so the flow was analysed but not run.",
      "Pass allowReproduction: true to request an actuated replay.",
    );
  }

  // 6. Environment opt-in.
  if (!policy.execute) {
    return notPermitted(
      "execution_not_enabled",
      "Replay execution is disabled for this environment; replay is observation only by default.",
      "Set CRUMBTRAIL_REPLAY_EXECUTE=1 in an environment whose data is disposable.",
    );
  }

  // 7. Allowlist.
  const entry = policy.allowlist.find(
    (candidate) => httpOrigin(candidate.origin) === targetOrigin,
  );
  if (!entry) {
    return notPermitted(
      "target_not_allowlisted",
      `Origin ${targetOrigin} is not on the replay execution allowlist.`,
      "Add the origin to CRUMBTRAIL_REPLAY_ISOLATED_ORIGINS, or to the policy allowlist.",
    );
  }

  // 8. Isolation.
  if (!entry.isolated) {
    return notPermitted(
      "target_not_isolated",
      `Origin ${targetOrigin} is allowlisted but not declared isolated, so a replay could mutate data it must not touch.`,
      "Only declare an origin isolated when its data is disposable.",
    );
  }

  return { eligible: true, mode: "execute", targetOrigin };
}

/** Convenience for a caller that only needs the refusal text. */
export function describeRefusal(refusal: ReplayRefusal): string {
  return refusal.remedy
    ? `${refusal.code}: ${refusal.reason} ${refusal.remedy}`
    : `${refusal.code}: ${refusal.reason}`;
}

function ineligible(
  code: ReplayRefusalCode,
  reason: string,
  remedy?: string,
): ReplayDecision {
  return {
    eligible: false,
    mode: "observe",
    refusal: { code, reason, remedy },
  };
}

function notPermitted(
  code: ReplayRefusalCode,
  reason: string,
  remedy?: string,
): ReplayDecision {
  return { eligible: true, mode: "observe", refusal: { code, reason, remedy } };
}

function httpOrigin(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return undefined;
  // Credentials embedded in a target URL are a secret leak vector, not a target.
  if (parsed.username || parsed.password) return undefined;
  return parsed.origin;
}

function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins: string[] = [];
  for (const part of raw.split(",")) {
    const origin = httpOrigin(part.trim());
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

function isTruthyFlag(raw: string | undefined): boolean {
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function positiveInt(raw: string | undefined): number | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function removeUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
