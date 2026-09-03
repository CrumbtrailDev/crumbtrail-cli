import type { BugEvent } from "./types";
import {
  buildApplicationAssertionData,
  isCanonicalApplicationAssertionTimestamp,
  isSafeApplicationAssertionCorrelation,
  isSafeApplicationAssertionName,
  isSafeApplicationAssertionValue,
  type ApplicationAssertionEventData,
  type ApplicationAssertionOperator,
  type ApplicationAssertionRejection,
  type ApplicationAssertionValue,
} from "./assertion";

/** G1: a response fact whose declared semantic comparison did not pass or did pass. */
export const APPLICATION_RESPONSE_ASSERTION_EVENT_KIND =
  "app.response.assertion" as const;

/** G2: an application-declared action reached its deadline or session shutdown unsatisfied. */
export const APPLICATION_EXPECTATION_MISSED_EVENT_KIND =
  "app.expectation.missed" as const;

export const MAX_APPLICATION_RESPONSE_FACTS_PER_CALL = 20 as const;
export const MAX_APPLICATION_RESPONSE_ASSERTIONS_PER_SESSION = 100 as const;
export const MAX_APPLICATION_RESPONSE_PATH_LENGTH = 128 as const;
export const MAX_APPLICATION_RESPONSE_PATH_DEPTH = 8 as const;
export const MAX_APPLICATION_RESPONSE_PATH_SEGMENT_LENGTH = 32 as const;
export const MAX_APPLICATION_RESPONSE_SELECTOR_SCAN = 25 as const;
export const APPLICATION_EXPECTATION_KIND_MAX_LENGTH = 24 as const;
export const APPLICATION_EXPECTATION_DEADLINE_MIN_MS = 1 as const;
export const APPLICATION_EXPECTATION_DEADLINE_MAX_MS = 86_400_000 as const;
export const MAX_APPLICATION_EXPECTATIONS_PER_SESSION = 100 as const;

const RESPONSE_PATH_RE =
  /^(?:[A-Za-z][A-Za-z0-9_:-]{0,31}(?:\[(?:0|[1-9][0-9]{0,2})\])*)(?:\.(?:[A-Za-z][A-Za-z0-9_:-]{0,31}(?:\[(?:0|[1-9][0-9]{0,2})\])*))*$/;
const RESPONSE_SENSITIVE_PATH_PARTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "authorization",
  "cookie",
  "headers",
  "header",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "accesstoken",
  "refreshtoken",
  "credential",
  "credentials",
  "bearer",
  "jwt",
  "privatekey",
  "privatetoken",
]);
const EXPECTATION_KIND_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,23}$/;
const EXPECTATION_KINDS = ["update", "external", "queue", "work"] as const;

export type ApplicationResponseFactRejection =
  | ApplicationAssertionRejection
  | "invalid_facts"
  | "no_facts"
  | "fact_batch_limit_reached"
  | "invalid_fact"
  | "missing_path"
  | "path_and_selector_both_set"
  | "invalid_path"
  | "path_not_found"
  | "path_accessor"
  | "path_unreadable"
  | "response_not_object"
  | "invalid_selector"
  | "selector_path_not_array"
  | "selector_match_not_found"
  | "selector_scan_limit_reached"
  | "selector_accessor"
  | "response_session_cap_reached";

export type ApplicationResponseSource = "path" | "selector";

export interface ApplicationResponseSelector {
  /** Exact safe path to an array in the response. */
  path: string;
  /** A bounded equality match against one safe path on each array item. */
  match: {
    path: string;
    expected: ApplicationAssertionValue;
  };
  /** Exact safe path to the bounded primitive selected from the matching item. */
  valuePath: string;
}

export interface ApplicationResponseFactOptions {
  name: string;
  operator: ApplicationAssertionOperator;
  expected: ApplicationAssertionValue;
  path?: string;
  selector?: ApplicationResponseSelector;
  requestId?: string;
  traceId?: string;
}

export interface ApplicationResponseCorrelation {
  requestId?: string;
  traceId?: string;
  sessionId?: string;
}

export interface ApplicationResponseAssertionEventData extends ApplicationAssertionEventData {
  source: ApplicationResponseSource;
  /** Safe response path, or a selector path rendered as `items[*].value`. */
  path: string;
}

export interface ApplicationResponseFactResult {
  accepted: boolean;
  passed?: boolean;
  rejection?: ApplicationResponseFactRejection;
  event?: BugEvent;
}

export interface ApplicationResponseCheckResult {
  /** True when at least one fact event was admitted to the caller's lane. */
  accepted: boolean;
  acceptedCount: number;
  results: ApplicationResponseFactResult[];
  rejection?:
    | Exclude<ApplicationResponseFactRejection, ApplicationAssertionRejection>
    | "correlation_invalid";
}

export type ApplicationExpectationKind = (typeof EXPECTATION_KINDS)[number];
export type ApplicationExpectationMissReason = "deadline" | "session_shutdown";

export interface ApplicationExpectationOptions {
  name: string;
  kind: ApplicationExpectationKind;
  /** How long the application gives the expected effect to occur. */
  deadlineMs: number;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
}

export type ApplicationExpectationRejection =
  | "invalid_name"
  | "invalid_kind"
  | "invalid_deadline"
  | "correlation_invalid"
  | "expectation_cap_reached"
  | "expectation_active_limit_reached"
  | "session_tracking_limit_reached"
  | "timer_unavailable"
  | "session_stopped"
  | "invalid_options";

export interface ApplicationExpectationHandle {
  /** Mark the declared effect as observed. Returns false after another terminal action. */
  satisfy(): boolean;
  /** Cancel the declaration without reporting it as missing. */
  cancel(): boolean;
}

export interface ApplicationExpectationResult {
  accepted: boolean;
  handle?: ApplicationExpectationHandle;
  rejection?: ApplicationExpectationRejection;
}

export interface ApplicationExpectationMissedEventData {
  name: string;
  kind: ApplicationExpectationKind;
  deadlineMs: number;
  reason: ApplicationExpectationMissReason;
  requestId?: string;
  traceId?: string;
}

export type ApplicationExpectationEventEmitter = (event: BugEvent) => void;

interface ParsedResponsePath {
  canonical: string;
  segments: Array<string | number>;
}

type ReadOwnPropertyResult =
  | { state: "missing" }
  | { state: "accessor" }
  | { state: "unreadable" }
  | { state: "value"; value: unknown };

function readOwnProperty(value: unknown, key: string): ReadOwnPropertyResult {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return { state: "missing" };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { state: "missing" };
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      return { state: "accessor" };
    return { state: "value", value: descriptor.value };
  } catch {
    return { state: "unreadable" };
  }
}

function readRequiredProperty(
  value: unknown,
  key: string,
): { present: boolean; readable: boolean; value?: unknown } {
  const result = readOwnProperty(value, key);
  if (result.state === "missing") return { present: false, readable: true };
  if (result.state !== "value") return { present: true, readable: false };
  return { present: true, readable: true, value: result.value };
}

function parseResponsePath(
  value: unknown,
):
  | { accepted: true; path: ParsedResponsePath }
  | { accepted: false; rejection: "invalid_path" } {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_APPLICATION_RESPONSE_PATH_LENGTH ||
    !RESPONSE_PATH_RE.test(value)
  ) {
    return { accepted: false, rejection: "invalid_path" };
  }

  const segments: Array<string | number> = [];
  for (const part of value.split(".")) {
    const propertyMatch = /^[A-Za-z][A-Za-z0-9_:-]{0,31}/.exec(part);
    if (!propertyMatch) return { accepted: false, rejection: "invalid_path" };
    const property = propertyMatch[0];
    if (
      property.length > MAX_APPLICATION_RESPONSE_PATH_SEGMENT_LENGTH ||
      RESPONSE_SENSITIVE_PATH_PARTS.has(property.toLowerCase())
    ) {
      return { accepted: false, rejection: "invalid_path" };
    }
    segments.push(property);

    const indexes = part.slice(property.length);
    if (indexes.length > 0) {
      for (const index of indexes.matchAll(/\[(\d+)\]/g)) {
        const parsed = Number(index[1]);
        if (!Number.isSafeInteger(parsed))
          return { accepted: false, rejection: "invalid_path" };
        segments.push(parsed);
      }
      if (indexes.replace(/\[\d+\]/g, "") !== "")
        return { accepted: false, rejection: "invalid_path" };
    }
  }
  if (
    segments.length === 0 ||
    segments.length > MAX_APPLICATION_RESPONSE_PATH_DEPTH
  )
    return { accepted: false, rejection: "invalid_path" };
  return { accepted: true, path: { canonical: value, segments } };
}

function readPath(
  response: unknown,
  path: ParsedResponsePath,
):
  | { accepted: true; value: unknown }
  | { accepted: false; rejection: ApplicationResponseFactRejection } {
  let current = response;
  for (const segment of path.segments) {
    const result = readOwnProperty(current, String(segment));
    if (result.state === "missing") {
      if (
        current === null ||
        (typeof current !== "object" && typeof current !== "function")
      )
        return { accepted: false, rejection: "response_not_object" };
      return { accepted: false, rejection: "path_not_found" };
    }
    if (result.state === "accessor")
      return { accepted: false, rejection: "path_accessor" };
    if (result.state === "unreadable")
      return { accepted: false, rejection: "path_unreadable" };
    current = result.value;
  }
  return { accepted: true, value: current };
}

function parseSelector(value: unknown):
  | {
      accepted: true;
      selector: {
        path: ParsedResponsePath;
        matchPath: ParsedResponsePath;
        matchExpected: ApplicationAssertionValue;
        valuePath: ParsedResponsePath;
      };
    }
  | { accepted: false; rejection: ApplicationResponseFactRejection } {
  const pathValue = readRequiredProperty(value, "path");
  const matchValue = readRequiredProperty(value, "match");
  const valuePathValue = readRequiredProperty(value, "valuePath");
  if (
    !pathValue.present ||
    !matchValue.present ||
    !valuePathValue.present ||
    !pathValue.readable ||
    !matchValue.readable ||
    !valuePathValue.readable
  )
    return { accepted: false, rejection: "invalid_selector" };

  const path = parseResponsePath(pathValue.value);
  const valuePath = parseResponsePath(valuePathValue.value);
  const matchPathValue = readRequiredProperty(matchValue.value, "path");
  const matchExpectedValue = readRequiredProperty(matchValue.value, "expected");
  if (
    !matchPathValue.present ||
    !matchExpectedValue.present ||
    !matchPathValue.readable ||
    !matchExpectedValue.readable
  )
    return { accepted: false, rejection: "invalid_selector" };
  const matchPath = parseResponsePath(matchPathValue.value);
  if (!path.accepted || !matchPath.accepted || !valuePath.accepted)
    return { accepted: false, rejection: "invalid_path" };
  if (!isSafeApplicationAssertionValue(matchExpectedValue.value))
    return { accepted: false, rejection: "invalid_selector" };
  return {
    accepted: true,
    selector: {
      path: path.path,
      matchPath: matchPath.path,
      matchExpected: matchExpectedValue.value,
      valuePath: valuePath.path,
    },
  };
}

function readSelectedValue(
  response: unknown,
  fact: { path?: unknown; selector?: unknown },
):
  | {
      accepted: true;
      value: unknown;
      source: ApplicationResponseSource;
      path: string;
    }
  | { accepted: false; rejection: ApplicationResponseFactRejection } {
  const pathPresent = fact.path !== undefined;
  const selectorPresent = fact.selector !== undefined;
  if (!pathPresent && !selectorPresent)
    return { accepted: false, rejection: "missing_path" };
  if (pathPresent && selectorPresent)
    return { accepted: false, rejection: "path_and_selector_both_set" };

  if (pathPresent) {
    const path = parseResponsePath(fact.path);
    if (!path.accepted) return path;
    const read = readPath(response, path.path);
    if (!read.accepted) return read;
    return {
      accepted: true,
      value: read.value,
      source: "path",
      path: path.path.canonical,
    };
  }

  const parsed = parseSelector(fact.selector);
  if (!parsed.accepted) return parsed;
  const arrayResult = readPath(response, parsed.selector.path);
  if (!arrayResult.accepted) return arrayResult;
  try {
    if (!Array.isArray(arrayResult.value))
      return { accepted: false, rejection: "selector_path_not_array" };
  } catch {
    return { accepted: false, rejection: "selector_path_not_array" };
  }
  const lengthResult = readOwnProperty(arrayResult.value, "length");
  if (
    lengthResult.state !== "value" ||
    typeof lengthResult.value !== "number" ||
    !Number.isSafeInteger(lengthResult.value) ||
    lengthResult.value < 0
  ) {
    return { accepted: false, rejection: "selector_path_not_array" };
  }
  const scanLimit = Math.min(
    lengthResult.value,
    MAX_APPLICATION_RESPONSE_SELECTOR_SCAN,
  );
  for (let index = 0; index < scanLimit; index += 1) {
    const item = readOwnProperty(arrayResult.value, String(index));
    if (item.state === "missing") continue;
    if (item.state !== "value")
      return { accepted: false, rejection: "selector_accessor" };
    const match = readPath(item.value, parsed.selector.matchPath);
    if (!match.accepted) {
      if (
        match.rejection === "path_not_found" ||
        match.rejection === "response_not_object"
      )
        continue;
      if (match.rejection === "path_accessor")
        return { accepted: false, rejection: "selector_accessor" };
      continue;
    }
    if (match.value !== parsed.selector.matchExpected) continue;
    const selected = readPath(item.value, parsed.selector.valuePath);
    if (!selected.accepted) return selected;
    return {
      accepted: true,
      value: selected.value,
      source: "selector",
      path: `${parsed.selector.path.canonical}[*].${parsed.selector.valuePath.canonical}`,
    };
  }
  if (lengthResult.value > MAX_APPLICATION_RESPONSE_SELECTOR_SCAN)
    return { accepted: false, rejection: "selector_scan_limit_reached" };
  return { accepted: false, rejection: "selector_match_not_found" };
}

function readFactField(fact: unknown, key: string): ReadOwnPropertyResult {
  return readOwnProperty(fact, key);
}

function normalizeResponseCorrelation(
  correlation: ApplicationResponseCorrelation,
  sessionIdOverride?: string,
):
  | { accepted: true; data: ApplicationResponseCorrelation }
  | { accepted: false; rejection: "correlation_invalid" } {
  const requestId = readOwnProperty(correlation, "requestId");
  const traceId = readOwnProperty(correlation, "traceId");
  const sessionId = readOwnProperty(correlation, "sessionId");
  if (
    requestId.state === "accessor" ||
    requestId.state === "unreadable" ||
    traceId.state === "accessor" ||
    traceId.state === "unreadable" ||
    sessionId.state === "accessor" ||
    sessionId.state === "unreadable"
  )
    return { accepted: false, rejection: "correlation_invalid" };
  const data: ApplicationResponseCorrelation = {};
  const values = {
    requestId: requestId.state === "value" ? requestId.value : undefined,
    traceId: traceId.state === "value" ? traceId.value : undefined,
    sessionId:
      sessionIdOverride ??
      (sessionId.state === "value" ? sessionId.value : undefined),
  };
  if (
    (values.requestId !== undefined &&
      !isSafeApplicationAssertionCorrelation(values.requestId)) ||
    (values.traceId !== undefined &&
      !isSafeApplicationAssertionCorrelation(values.traceId)) ||
    (values.sessionId !== undefined &&
      !isSafeApplicationAssertionCorrelation(values.sessionId))
  )
    return { accepted: false, rejection: "correlation_invalid" };
  if (values.requestId !== undefined) data.requestId = values.requestId;
  if (values.traceId !== undefined) data.traceId = values.traceId;
  if (values.sessionId !== undefined) data.sessionId = values.sessionId;
  return { accepted: true, data };
}

/** Build one G1 event without reading any response property beyond the declaration. */
export function buildApplicationResponseAssertionEvent(
  response: unknown,
  fact: ApplicationResponseFactOptions,
  timestamp: number,
  correlation: ApplicationResponseCorrelation = {},
  sessionIdOverride?: string,
): ApplicationResponseFactResult {
  const normalizedCorrelation = normalizeResponseCorrelation(
    correlation,
    sessionIdOverride,
  );
  if (!normalizedCorrelation.accepted)
    return { accepted: false, rejection: normalizedCorrelation.rejection };
  const name = readFactField(fact, "name");
  const operator = readFactField(fact, "operator");
  const expected = readFactField(fact, "expected");
  const path = readFactField(fact, "path");
  const selector = readFactField(fact, "selector");
  const requestId = readFactField(fact, "requestId");
  const traceId = readFactField(fact, "traceId");
  if (
    name.state !== "value" ||
    operator.state !== "value" ||
    expected.state !== "value" ||
    path.state === "accessor" ||
    path.state === "unreadable" ||
    selector.state === "accessor" ||
    selector.state === "unreadable" ||
    requestId.state === "accessor" ||
    requestId.state === "unreadable" ||
    traceId.state === "accessor" ||
    traceId.state === "unreadable"
  )
    return { accepted: false, rejection: "invalid_fact" };

  const selected = readSelectedValue(response, {
    path: path.state === "value" ? path.value : undefined,
    selector: selector.state === "value" ? selector.value : undefined,
  });
  if (!selected.accepted) return selected;
  const built = buildApplicationAssertionData({
    name: name.value as string,
    operator: operator.value as ApplicationAssertionOperator,
    expected: expected.value as ApplicationAssertionValue,
    actual: selected.value as ApplicationAssertionValue,
    requestId:
      (requestId.state === "value"
        ? (requestId.value as string | undefined)
        : undefined) ?? normalizedCorrelation.data.requestId,
    traceId:
      (traceId.state === "value"
        ? (traceId.value as string | undefined)
        : undefined) ?? normalizedCorrelation.data.traceId,
    sessionId: normalizedCorrelation.data.sessionId,
  });
  if (!built.accepted) return built;
  if (!isCanonicalApplicationAssertionTimestamp(timestamp))
    return { accepted: false, rejection: "invalid_timestamp" };
  return {
    accepted: true,
    passed: built.passed,
    event: {
      t: timestamp,
      k: APPLICATION_RESPONSE_ASSERTION_EVENT_KIND,
      d: {
        ...built.data,
        source: selected.source,
        path: selected.path,
      } satisfies ApplicationResponseAssertionEventData,
      ...(normalizedCorrelation.data.sessionId === undefined
        ? {}
        : { sessionId: normalizedCorrelation.data.sessionId }),
    },
  };
}

function readFactsLength(
  facts: unknown,
): { accepted: true; length: number } | { accepted: false } {
  const length = readOwnProperty(facts, "length");
  if (
    length.state !== "value" ||
    typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  )
    return { accepted: false };
  return { accepted: true, length: length.value };
}

/** Validate a bounded batch of G1 declarations. No result retains the response itself. */
export function checkApplicationResponse(
  response: unknown,
  facts: readonly ApplicationResponseFactOptions[],
  timestamp: number,
  correlation: ApplicationResponseCorrelation = {},
  sessionIdOverride?: string,
): ApplicationResponseCheckResult {
  const length = readFactsLength(facts);
  if (!length.accepted)
    return {
      accepted: false,
      acceptedCount: 0,
      results: [],
      rejection: "invalid_facts",
    };
  if (length.length === 0)
    return {
      accepted: false,
      acceptedCount: 0,
      results: [],
      rejection: "no_facts",
    };
  if (length.length > MAX_APPLICATION_RESPONSE_FACTS_PER_CALL)
    return {
      accepted: false,
      acceptedCount: 0,
      results: [],
      rejection: "fact_batch_limit_reached",
    };

  const results: ApplicationResponseFactResult[] = [];
  let acceptedCount = 0;
  for (let index = 0; index < length.length; index += 1) {
    const fact = readOwnProperty(facts, String(index));
    if (fact.state !== "value") {
      results.push({ accepted: false, rejection: "invalid_fact" });
      continue;
    }
    const result = buildApplicationResponseAssertionEvent(
      response,
      fact.value as ApplicationResponseFactOptions,
      timestamp,
      correlation,
      sessionIdOverride,
    );
    if (result.accepted) acceptedCount += 1;
    results.push(result);
  }
  return { accepted: acceptedCount > 0, acceptedCount, results };
}

export function isSafeApplicationExpectationKind(
  value: unknown,
): value is ApplicationExpectationKind {
  return (
    typeof value === "string" &&
    value.length <= APPLICATION_EXPECTATION_KIND_MAX_LENGTH &&
    EXPECTATION_KIND_RE.test(value) &&
    (EXPECTATION_KINDS as readonly string[]).includes(value)
  );
}

function isSafeExpectationDeadline(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= APPLICATION_EXPECTATION_DEADLINE_MIN_MS &&
    value <= APPLICATION_EXPECTATION_DEADLINE_MAX_MS
  );
}

interface NormalizedExpectation {
  name: string;
  kind: ApplicationExpectationKind;
  deadlineMs: number;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
}

function buildApplicationExpectationData(
  options: ApplicationExpectationOptions,
):
  | { accepted: true; data: NormalizedExpectation }
  | { accepted: false; rejection: ApplicationExpectationRejection } {
  const name = readOwnProperty(options, "name");
  const kind = readOwnProperty(options, "kind");
  const deadlineMs = readOwnProperty(options, "deadlineMs");
  const requestId = readOwnProperty(options, "requestId");
  const traceId = readOwnProperty(options, "traceId");
  const sessionId = readOwnProperty(options, "sessionId");
  if (name.state !== "value" || !isSafeApplicationAssertionName(name.value))
    return { accepted: false, rejection: "invalid_name" };
  if (kind.state !== "value" || !isSafeApplicationExpectationKind(kind.value))
    return { accepted: false, rejection: "invalid_kind" };
  if (
    deadlineMs.state !== "value" ||
    !isSafeExpectationDeadline(deadlineMs.value)
  )
    return { accepted: false, rejection: "invalid_deadline" };
  if (
    requestId.state === "unreadable" ||
    requestId.state === "accessor" ||
    traceId.state === "unreadable" ||
    traceId.state === "accessor" ||
    sessionId.state === "unreadable" ||
    sessionId.state === "accessor" ||
    (requestId.state === "value" &&
      requestId.value !== undefined &&
      !isSafeApplicationAssertionCorrelation(requestId.value)) ||
    (traceId.state === "value" &&
      traceId.value !== undefined &&
      !isSafeApplicationAssertionCorrelation(traceId.value)) ||
    (sessionId.state === "value" &&
      sessionId.value !== undefined &&
      !isSafeApplicationAssertionCorrelation(sessionId.value))
  )
    return { accepted: false, rejection: "correlation_invalid" };
  const requestIdValue =
    requestId.state === "value" && requestId.value !== undefined
      ? (requestId.value as string)
      : undefined;
  const traceIdValue =
    traceId.state === "value" && traceId.value !== undefined
      ? (traceId.value as string)
      : undefined;
  const sessionIdValue =
    sessionId.state === "value" && sessionId.value !== undefined
      ? (sessionId.value as string)
      : undefined;
  return {
    accepted: true,
    data: {
      name: name.value,
      kind: kind.value,
      deadlineMs: deadlineMs.value,
      ...(requestIdValue !== undefined ? { requestId: requestIdValue } : {}),
      ...(traceIdValue !== undefined ? { traceId: traceIdValue } : {}),
      ...(sessionIdValue !== undefined ? { sessionId: sessionIdValue } : {}),
    },
  };
}

export function buildApplicationExpectationMissedEvent(
  options: ApplicationExpectationOptions,
  reason: ApplicationExpectationMissReason,
  timestamp: number,
):
  | { accepted: true; event: BugEvent }
  | {
      accepted: false;
      rejection: ApplicationExpectationRejection | "invalid_timestamp";
    } {
  if (reason !== "deadline" && reason !== "session_shutdown")
    return { accepted: false, rejection: "invalid_options" };
  const built = buildApplicationExpectationData(options);
  if (!built.accepted) return built;
  if (!isCanonicalApplicationAssertionTimestamp(timestamp))
    return { accepted: false, rejection: "invalid_timestamp" };
  return {
    accepted: true,
    event: {
      t: timestamp,
      k: APPLICATION_EXPECTATION_MISSED_EVENT_KIND,
      d: {
        name: built.data.name,
        kind: built.data.kind,
        deadlineMs: built.data.deadlineMs,
        reason,
        ...(built.data.requestId === undefined
          ? {}
          : { requestId: built.data.requestId }),
        ...(built.data.traceId === undefined
          ? {}
          : { traceId: built.data.traceId }),
      } satisfies ApplicationExpectationMissedEventData,
      ...(built.data.sessionId === undefined
        ? {}
        : { sessionId: built.data.sessionId }),
    },
  };
}

interface PendingExpectation {
  id: number;
  data: NormalizedExpectation;
  timer?: ReturnType<typeof setTimeout>;
  emit: ApplicationExpectationEventEmitter;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  try {
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
  } catch {
    // Browser timers have no unref. A hostile timer shim cannot break capture.
  }
}

/** Shared browser/Node expectation state machine. It never exposes its internal id. */
export class ApplicationExpectationManager {
  private readonly sessionId?: string;
  private readonly now: () => number;
  private readonly defaultEmit: ApplicationExpectationEventEmitter;
  private readonly pending = new Map<number, PendingExpectation>();
  private nextId = 1;
  private startedCount = 0;
  private stopped = false;

  constructor(options: {
    sessionId?: string;
    emit: ApplicationExpectationEventEmitter;
    now?: () => number;
  }) {
    this.sessionId = options.sessionId;
    this.defaultEmit = options.emit;
    this.now = options.now ?? Date.now;
  }

  begin(
    options: ApplicationExpectationOptions,
    emit: ApplicationExpectationEventEmitter = this.defaultEmit,
  ): ApplicationExpectationResult {
    if (this.stopped) return { accepted: false, rejection: "session_stopped" };
    if (this.startedCount >= MAX_APPLICATION_EXPECTATIONS_PER_SESSION)
      return { accepted: false, rejection: "expectation_cap_reached" };
    if (this.pending.size >= MAX_APPLICATION_EXPECTATIONS_PER_SESSION)
      return {
        accepted: false,
        rejection: "expectation_active_limit_reached",
      };
    const built = buildApplicationExpectationData(options);
    if (!built.accepted) return built;
    if (this.sessionId !== undefined) built.data.sessionId = this.sessionId;
    const id = this.nextId;
    this.nextId += 1;
    this.startedCount += 1;
    const pending: PendingExpectation = { id, data: built.data, emit };
    this.pending.set(id, pending);
    try {
      const timer = setTimeout(() => {
        this.finish(id, "deadline");
      }, built.data.deadlineMs);
      pending.timer = timer;
      unrefTimer(timer);
    } catch {
      this.pending.delete(id);
      this.startedCount -= 1;
      return { accepted: false, rejection: "timer_unavailable" };
    }
    const handle: ApplicationExpectationHandle = Object.freeze({
      satisfy: () => this.finish(id, "satisfied"),
      cancel: () => this.finish(id, "cancelled"),
    });
    return { accepted: true, handle };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of [...this.pending.keys()])
      this.finish(id, "session_shutdown");
    this.pending.clear();
  }

  private finish(
    id: number,
    terminal: "satisfied" | "cancelled" | ApplicationExpectationMissReason,
  ): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (pending.timer !== undefined) {
      try {
        clearTimeout(pending.timer);
      } catch {
        // A timer shim that rejects cleanup cannot make a finished expectation pending again.
      }
    }
    if (terminal === "satisfied" || terminal === "cancelled") return true;
    let timestamp: number;
    try {
      timestamp = this.now();
    } catch {
      return false;
    }
    const event = buildApplicationExpectationMissedEvent(
      pending.data,
      terminal,
      timestamp,
    );
    if (!event.accepted) return false;
    try {
      pending.emit(event.event);
    } catch {
      // A telemetry delivery failure is not allowed to fail the host operation or retry.
    }
    return true;
  }
}

export function createApplicationExpectationManager(options: {
  sessionId?: string;
  emit: ApplicationExpectationEventEmitter;
  now?: () => number;
}): ApplicationExpectationManager {
  return new ApplicationExpectationManager(options);
}
