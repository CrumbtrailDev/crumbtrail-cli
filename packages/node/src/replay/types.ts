import type { ReplayResult } from "./result";

/**
 * The `Reproducer` seam and the value objects it consumes.
 *
 * A reproduction takes a {@link ReplayFlow} — the ordered navigate/click/input
 * steps distilled from a captured session — and either observes it (the
 * default) or actuates it against an explicitly allowlisted, explicitly
 * isolated environment, emitting a `replay-result.v1` {@link ReplayResult}.
 *
 * Two implementations exist, so this is a real seam rather than a hypothetical
 * one: `NoopReproducer` (observation only) and `PlaywrightReproducer`
 * (actuating). `defaultReproducerFactory` picks between them from a
 * {@link ReplayDecision}; see `replay/factory.ts`.
 */

/** What a single recorded interaction asks the replay to do. */
export type ReplayAction = "navigate" | "click" | "input";

/**
 * How an input step's captured value may be used. Capture already redacts
 * input values unless an element is explicitly unmasked, so a literal value is
 * the exception, not the rule.
 */
export type ReplayValueSource =
  /** A safe, non-secret literal captured from an explicitly unmasked field. */
  | { kind: "literal"; value: string }
  /** Capture redacted the value; the replay has nothing to type. */
  | { kind: "redacted" }
  /**
   * The field or the value is credential-like. The raw value is never carried
   * here — it is dropped at flow-build time and the step is marked so policy
   * can refuse the whole flow.
   */
  | { kind: "secret"; reason: string };

export interface ReplayStep {
  /** Position in the flow, 0-based. Mirrors `replay-result.v1` step index. */
  index: number;
  /** Element signature from capture, or a `nav:<path>` pseudo-signature. */
  sig: string;
  action: ReplayAction;
  /** Same-origin path (+ query when it survived redaction) for `navigate`. */
  path?: string;
  /** True when a navigation's query string was dropped by redaction. */
  queryWithheld?: boolean;
  /** CSS selector recorded by capture, used for the `exact` resolution rung. */
  selector?: string;
  /** Lowercased tag name, used for the `structural` rung. */
  tag?: string;
  /** ARIA role guess, used for the `role-label` rung. */
  role?: string;
  /** Accessible name / visible text, used for the `role-label` rung. */
  label?: string;
  /** Only present for `input` steps. */
  value?: ReplayValueSource;
}

export interface ReplayFlow {
  /** Session the steps were distilled from. */
  sourceSessionId: string;
  /**
   * Base URL the replay would actually drive. Navigations are rebased onto
   * this origin, so the captured production origin is never contacted.
   */
  targetUrl: string;
  /** Origin the flow was captured against, for the record only. */
  capturedOrigin?: string;
  steps: ReplayStep[];
}

/** Observation is the default; execution has to be opted into and allowlisted. */
export type ReplayMode = "observe" | "execute";

export type ReplayRefusalCode =
  /** The flow has nothing to replay. */
  | "no_replayable_steps"
  /** No usable http(s) target URL. */
  | "target_url_invalid"
  /** More steps than the configured budget. */
  | "step_budget_exceeded"
  /** A step depends on a credential-like value. */
  | "flow_carries_secret"
  /** The caller did not pass `allowReproduction: true`. */
  | "reproduction_not_requested"
  /** Policy is observation only (the default). */
  | "execution_not_enabled"
  /** The target origin is not on the execution allowlist. */
  | "target_not_allowlisted"
  /** The target origin is allowlisted but not declared isolated. */
  | "target_not_isolated"
  /** Playwright is not installed, or failed to launch. */
  | "driver_unavailable";

/**
 * Why a replay did not execute. Always populated when `mode` is `observe`, so
 * a refusal is never a silent no-op.
 */
export interface ReplayRefusal {
  code: ReplayRefusalCode;
  /** One sentence a human or agent can act on. */
  reason: string;
  /** What would make this replay executable, when anything would. */
  remedy?: string;
}

export interface ReplayDecision {
  /**
   * False when the flow itself can never be replayed (shape or safety), true
   * when only an opt-in or an allowlist entry is missing.
   */
  eligible: boolean;
  mode: ReplayMode;
  /** Present whenever `mode` is `observe`. */
  refusal?: ReplayRefusal;
  /** Echo of the resolved target, present when `mode` is `execute`. */
  targetOrigin?: string;
}

export interface ReproductionOutcome {
  /** True only when a driver actually actuated the flow. */
  attempted: boolean;
  mode: ReplayMode;
  /** Which adapter produced this outcome. */
  adapter: "noop" | "playwright";
  /** Human- and agent-readable summary. */
  note: string;
  /** Present whenever the replay did not execute. */
  refusal?: ReplayRefusal;
  /** `replay-result.v1`. Present only when `attempted` is true. */
  result?: ReplayResult;
}

export interface Reproducer {
  readonly adapter: "noop" | "playwright";
  reproduce(
    flow: ReplayFlow,
    decision: ReplayDecision,
  ): Promise<ReproductionOutcome>;
}
