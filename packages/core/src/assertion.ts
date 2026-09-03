import { classifyStructuredValue } from "./redaction";
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

/** Canonical assertion event timestamps are non-negative Unix milliseconds. */
export const APPLICATION_ASSERTION_TIMESTAMP_MIN = 0 as const;
/** Match the largest timestamp representable by an ECMAScript Date. */
export const APPLICATION_ASSERTION_TIMESTAMP_MAX =
  8_640_000_000_000_000 as const;

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
  | "invalid_options"
  | "invalid_name"
  | "invalid_operator"
  | "invalid_expected"
  | "invalid_actual"
  | "value_types_differ"
  | "operator_requires_numbers"
  | "correlation_invalid"
  | "invalid_timestamp"
  | "capture_not_admitted"
  | "session_cap_reached"
  | "session_tracking_limit_reached";

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

type ApplicationAssertionDataRejection = Exclude<
  ApplicationAssertionRejection,
  | "invalid_timestamp"
  | "capture_not_admitted"
  | "session_cap_reached"
  | "session_tracking_limit_reached"
>;

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const CORRELATION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SECRET_PREFIX_RE =
  /^(?:sk|pk)_(?:live|test)_|^(?:ghp|gho|ghu|ghs|ghr)_|^github_pat_|^xox[abprs]-|^bearer[: _-]/i;

type AssertionSnapshot = {
  name: unknown;
  operator: unknown;
  expected: unknown;
  actual: unknown;
  requestId?: unknown;
  traceId?: unknown;
  sessionId?: unknown;
};

type SnapshotResult =
  | { accepted: true; options: ApplicationAssertionOptions }
  | { accepted: false; rejection: "invalid_options" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object")
    return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readOwn(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

/** Read only assertion fields once, without invoking unknown keys or spreading the caller. */
function snapshotApplicationAssertionOptions(input: unknown): SnapshotResult {
  if (!isPlainRecord(input))
    return { accepted: false, rejection: "invalid_options" };
  try {
    const snapshot: AssertionSnapshot = {
      name: readOwn(input, "name"),
      operator: readOwn(input, "operator"),
      expected: readOwn(input, "expected"),
      actual: readOwn(input, "actual"),
    };
    const requestId = readOwn(input, "requestId");
    const traceId = readOwn(input, "traceId");
    const sessionId = readOwn(input, "sessionId");
    if (requestId !== undefined) snapshot.requestId = requestId;
    if (traceId !== undefined) snapshot.traceId = traceId;
    if (sessionId !== undefined) snapshot.sessionId = sessionId;
    return {
      accepted: true,
      options: snapshot as ApplicationAssertionOptions,
    };
  } catch {
    return { accepted: false, rejection: "invalid_options" };
  }
}

export function isSafeApplicationAssertionName(
  value: unknown,
): value is string {
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
  if (SECRET_PREFIX_RE.test(value)) return false;
  return classifyStructuredValue(value).action === "keep";
}

function isSafeApplicationAssertionValueForName(
  value: unknown,
  name: string,
): value is ApplicationAssertionValue {
  return (
    isSafeApplicationAssertionValue(value) &&
    classifyStructuredValue(value, name).action === "keep"
  );
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

export function isSafeApplicationAssertionCorrelation(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= APPLICATION_ASSERTION_CORRELATION_MAX_LENGTH &&
    CORRELATION_RE.test(value)
  );
}

export function isCanonicalApplicationAssertionTimestamp(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= APPLICATION_ASSERTION_TIMESTAMP_MIN &&
    value <= APPLICATION_ASSERTION_TIMESTAMP_MAX
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
function buildApplicationAssertionDataFromSnapshot(
  options: ApplicationAssertionOptions,
):
  | { accepted: true; passed: boolean; data: ApplicationAssertionEventData }
  | { accepted: false; rejection: ApplicationAssertionDataRejection } {
  if (!isSafeApplicationAssertionName(options.name))
    return { accepted: false, rejection: "invalid_name" };
  if (classifyStructuredValue(true, options.name).action !== "keep")
    return { accepted: false, rejection: "invalid_name" };
  if (!isApplicationAssertionOperator(options.operator))
    return { accepted: false, rejection: "invalid_operator" };
  if (!isSafeApplicationAssertionValueForName(options.expected, options.name))
    return { accepted: false, rejection: "invalid_expected" };
  if (!isSafeApplicationAssertionValueForName(options.actual, options.name))
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
    (options.requestId !== undefined &&
      !isSafeApplicationAssertionCorrelation(options.requestId)) ||
    (options.traceId !== undefined &&
      !isSafeApplicationAssertionCorrelation(options.traceId)) ||
    (options.sessionId !== undefined &&
      !isSafeApplicationAssertionCorrelation(options.sessionId))
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

export function buildApplicationAssertionData(
  options: ApplicationAssertionOptions,
):
  | { accepted: true; passed: boolean; data: ApplicationAssertionEventData }
  | { accepted: false; rejection: ApplicationAssertionDataRejection } {
  const snapshot = snapshotApplicationAssertionOptions(options);
  if (!snapshot.accepted) return snapshot;
  return buildApplicationAssertionDataFromSnapshot(snapshot.options);
}

/** Build the stable wire event after validation. */
export function buildApplicationAssertionEvent(
  options: ApplicationAssertionOptions,
  timestamp: number,
  sessionIdOverride?: string,
): ApplicationAssertionResult {
  const snapshot = snapshotApplicationAssertionOptions(options);
  if (!snapshot.accepted) return snapshot;
  const safeOptions =
    sessionIdOverride === undefined
      ? snapshot.options
      : { ...snapshot.options, sessionId: sessionIdOverride };
  const built = buildApplicationAssertionDataFromSnapshot(safeOptions);
  if (!built.accepted) return built;
  if (!isCanonicalApplicationAssertionTimestamp(timestamp)) {
    return { accepted: false, rejection: "invalid_timestamp" };
  }
  return {
    accepted: true,
    passed: built.passed,
    event: {
      t: timestamp,
      k: APPLICATION_ASSERTION_EVENT_KIND,
      d: { ...built.data },
      ...(safeOptions.sessionId === undefined
        ? {}
        : { sessionId: safeOptions.sessionId }),
    },
  };
}

export const buildSupportAssertionEvent = buildApplicationAssertionEvent;
export const evaluateSupportAssertion = evaluateApplicationAssertion;
