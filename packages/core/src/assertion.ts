import type { BugEvent } from "./types";

/** One stable event kind for an application's own bounded correctness claim. */
export const APPLICATION_ASSERTION_EVENT_KIND = "app.assertion" as const;
/** Alias for callers that want to name the support purpose explicitly. */
export const SUPPORT_ASSERTION_EVENT_KIND = APPLICATION_ASSERTION_EVENT_KIND;

/** The only operators the wire contract supports. */
export const APPLICATION_ASSERTION_OPERATORS = [
  "equals",
  "not_equals",
  "greater_or_equal",
  "less_or_equal",
] as const;

export type ApplicationAssertionOperator =
  (typeof APPLICATION_ASSERTION_OPERATORS)[number];
export type SupportAssertionOperator = ApplicationAssertionOperator;
export type ApplicationAssertionValue = boolean | number | string;
export type SupportAssertionValue = ApplicationAssertionValue;

/** Maximum number of valid assertion events emitted by one session. */
export const MAX_APPLICATION_ASSERTIONS_PER_SESSION = 100 as const;
export const MAX_SUPPORT_ASSERTIONS_PER_SESSION =
  MAX_APPLICATION_ASSERTIONS_PER_SESSION;

/** Bounds are deliberately small so this contract cannot become a logging escape hatch. */
export const APPLICATION_ASSERTION_NAME_MAX_LENGTH = 64 as const;
export const APPLICATION_ASSERTION_STRING_MAX_LENGTH = 64 as const;
export const APPLICATION_ASSERTION_CORRELATION_MAX_LENGTH = 64 as const;

export interface ApplicationAssertionOptions {
  /** A stable identifier such as `cart_total` or `invoice_count`. */
  name: string;
  operator: ApplicationAssertionOperator;
  expected: ApplicationAssertionValue;
  actual: ApplicationAssertionValue;
  /** The request and trace that produced the values, when the app has them. */
  requestId?: string;
  traceId?: string;
  /** Used by backend callers. Browser callers normally use the active session. */
  sessionId?: string;
}

export type SupportAssertionOptions = ApplicationAssertionOptions;

export type ApplicationAssertionRejection =
  | "invalid_name"
  | "invalid_operator"
  | "invalid_expected"
  | "invalid_actual"
  | "value_types_differ"
  | "operator_requires_numbers"
  | "correlation_invalid"
  | "session_cap_reached";

export interface ApplicationAssertionResult {
  /** Whether the inputs formed a bounded assertion and were eligible to emit. */
  accepted: boolean;
  /** The deterministic comparison result. Present only for an accepted assertion. */
  passed?: boolean;
  /** Why no event was emitted. Never contains the rejected value. */
  rejection?: ApplicationAssertionRejection;
  /** The exact event emitted, useful to a custom transport or test seam. */
  event?: BugEvent;
}

export type SupportAssertionResult = ApplicationAssertionResult;

export interface ApplicationAssertionEventData {
  name: string;
  operator: ApplicationAssertionOperator;
  expected: ApplicationAssertionValue;
  actual: ApplicationAssertionValue;
  passed: boolean;
  valueType: "boolean" | "number" | "string";
  requestId?: string;
  traceId?: string;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const CORRELATION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SECRET_PREFIX_RE = /^(?:sk|pk)_(?:live|test)_|^(?:ghp|gho|ghu|ghs|ghr)_|^github_pat_|^xox[abprs]-|^bearer[: _-]/i;

function isSafeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= APPLICATION_ASSERTION_NAME_MAX_LENGTH &&
    NAME_RE.test(value)
  );
}

/**
 * A value is either a primitive bounded fact or it is not assertion evidence.
 * In particular, this rejects prose, email addresses, JWTs, and common token
 * prefixes before an application value reaches the event bus.
 */
export function isSafeApplicationAssertionValue(
  value: unknown,
): value is ApplicationAssertionValue {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  if (
    value.length === 0 ||
    value.length > APPLICATION_ASSERTION_STRING_MAX_LENGTH ||
    !SAFE_VALUE_RE.test(value)
  )
    return false;
  if (EMAIL_RE.test(value) || JWT_RE.test(value)) return false;
  if (SECRET_PREFIX_RE.test(value)) return false;
  return true;
}

function assertionValueType(
  value: ApplicationAssertionValue,
): ApplicationAssertionEventData["valueType"] {
  return typeof value as ApplicationAssertionEventData["valueType"];
}

function isApplicationAssertionOperator(
  value: unknown,
): value is ApplicationAssertionOperator {
  return (
    typeof value === "string" &&
    (APPLICATION_ASSERTION_OPERATORS as readonly string[]).includes(value)
  );
}

function isSafeCorrelation(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= APPLICATION_ASSERTION_CORRELATION_MAX_LENGTH &&
    CORRELATION_RE.test(value)
  );
}

/** Evaluate a validated bounded assertion. */
export function evaluateApplicationAssertion(
  operator: ApplicationAssertionOperator,
  expected: ApplicationAssertionValue,
  actual: ApplicationAssertionValue,
): boolean {
  switch (operator) {
    case "equals":
      return expected === actual;
    case "not_equals":
      return expected !== actual;
    case "greater_or_equal":
      return (actual as number) >= (expected as number);
    case "less_or_equal":
      return (actual as number) <= (expected as number);
  }
}

/**
 * Validate and evaluate an assertion without emitting or retaining anything.
 * The returned event data is the exact bounded payload used by the SDK.
 */
export function buildApplicationAssertionData(
  options: ApplicationAssertionOptions,
):
  | { accepted: true; passed: boolean; data: ApplicationAssertionEventData }
  | { accepted: false; rejection: Exclude<ApplicationAssertionRejection, "session_cap_reached"> } {
  if (!isSafeName(options.name))
    return { accepted: false, rejection: "invalid_name" };
  if (!isApplicationAssertionOperator(options.operator))
    return { accepted: false, rejection: "invalid_operator" };
  if (!isSafeApplicationAssertionValue(options.expected))
    return { accepted: false, rejection: "invalid_expected" };
  if (!isSafeApplicationAssertionValue(options.actual))
    return { accepted: false, rejection: "invalid_actual" };
  const expectedType = assertionValueType(options.expected);
  const actualType = assertionValueType(options.actual);
  if (expectedType !== actualType)
    return { accepted: false, rejection: "value_types_differ" };
  if (
    (options.operator === "greater_or_equal" ||
      options.operator === "less_or_equal") &&
    expectedType !== "number"
  )
    return { accepted: false, rejection: "operator_requires_numbers" };
  if (
    (options.requestId !== undefined && !isSafeCorrelation(options.requestId)) ||
    (options.traceId !== undefined && !isSafeCorrelation(options.traceId)) ||
    (options.sessionId !== undefined && !isSafeCorrelation(options.sessionId))
  )
    return { accepted: false, rejection: "correlation_invalid" };

  const passed = evaluateApplicationAssertion(
    options.operator,
    options.expected,
    options.actual,
  );
  return {
    accepted: true,
    passed,
    data: {
      name: options.name,
      operator: options.operator,
      expected: options.expected,
      actual: options.actual,
      passed,
      valueType: expectedType,
      ...(options.requestId === undefined
        ? {}
        : { requestId: options.requestId }),
      ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    },
  };
}

/** Build the stable wire event after validation. */
export function buildApplicationAssertionEvent(
  options: ApplicationAssertionOptions,
  timestamp: number,
): ApplicationAssertionResult {
  const built = buildApplicationAssertionData(options);
  if (!built.accepted) return built;
  return {
    accepted: true,
    passed: built.passed,
    event: {
      t: timestamp,
      k: APPLICATION_ASSERTION_EVENT_KIND,
      d: { ...built.data },
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
    },
  };
}

export const buildSupportAssertionEvent = buildApplicationAssertionEvent;
export const evaluateSupportAssertion = evaluateApplicationAssertion;
