import type { BugEvent } from "crumbtrail-core";

/**
 * `net.res` fixtures that mirror what the browser collector actually emits.
 *
 * The detectors that read response bodies were once written against a guessed
 * envelope (`d.body = { ct, data, arrayTotal: number }`) and would have matched
 * nothing in a real session. The emitted contract is:
 *
 *  - `d.body` stays the redacted body as TEXT. Long-standing, and older
 *    consumers depend on it.
 *  - `d.bodyMeta` is additive: `{ ct, bytes?, truncated?, data?, arrayTotal? }`,
 *    built ONLY for a same-origin JSON response of at most 32KB that parsed
 *    after redaction.
 *  - `arrayTotal` is a JSONPath → true-length MAP (`{"$": 25}` for a top-level
 *    array, `{"$.items": 57}` for a nested one), written only for arrays the
 *    capture actually shortened.
 *  - `truncated` is set by the string and depth caps too, so it says nothing
 *    about how many items an array had.
 *
 * The capping below is a faithful port of `capSummaryValue` in
 * `packages/core/src/collectors/network.ts`, so a fixture cannot drift into
 * describing a body shape the browser never produces. Its behaviour is pinned
 * against the core suite's own numbers in `net-res-fixture.test.ts`.
 */

/** Mirrors RESPONSE_SUMMARY_MAX_DEPTH in the core collector. */
const MAX_DEPTH = 4;
/** Mirrors RESPONSE_SUMMARY_MAX_ARRAY in the core collector. */
const MAX_ARRAY = 20;
/** Mirrors RESPONSE_SUMMARY_MAX_STRING in the core collector. */
const MAX_STRING = 120;

export interface ResponseBodyMetaFixture {
  ct: string;
  bytes?: number;
  truncated?: boolean;
  data?: unknown;
  arrayTotal?: Record<string, number>;
}

interface SummaryState {
  truncated: boolean;
  arrayTotal: Record<string, number>;
}

function capSummaryValue(
  value: unknown,
  depth: number,
  path: string,
  state: SummaryState,
): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING) return value;
    state.truncated = true;
    return value.slice(0, MAX_STRING);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      state.truncated = true;
      return `[array:${value.length}]`;
    }
    const kept = value.slice(0, MAX_ARRAY);
    if (value.length > kept.length) {
      state.truncated = true;
      state.arrayTotal[path] = value.length;
    }
    return kept.map((entry, index) =>
      capSummaryValue(entry, depth + 1, `${path}[${index}]`, state),
    );
  }
  if (value !== null && typeof value === "object") {
    if (depth >= MAX_DEPTH) {
      state.truncated = true;
      return "[object]";
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = capSummaryValue(entry, depth + 1, `${path}.${key}`, state);
    }
    return output;
  }
  return value;
}

/** The `d.bodyMeta` the collector would build for this JSON payload. */
export function bodyMetaFor(payload: unknown): ResponseBodyMetaFixture {
  const text = JSON.stringify(payload) ?? "";
  const state: SummaryState = { truncated: false, arrayTotal: {} };
  const data = capSummaryValue(payload, 0, "$", state);
  const meta: ResponseBodyMetaFixture = {
    ct: "json",
    bytes: new TextEncoder().encode(text).length,
    data,
  };
  if (state.truncated) meta.truncated = true;
  if (Object.keys(state.arrayTotal).length > 0)
    meta.arrayTotal = state.arrayTotal;
  return meta;
}

/**
 * A same-origin JSON response: text body plus the parsed, capped summary. What
 * a browser session actually carries.
 */
export function jsonResponse(
  t: number,
  requestId: string,
  payload: unknown,
  options: { status?: number; dur?: number } = {},
): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      requestId,
      st: options.status ?? 200,
      dur: options.dur ?? 8,
      body: JSON.stringify(payload),
      bodyMeta: bodyMetaFor(payload),
    },
  } as unknown as BugEvent;
}

/**
 * A response the collector could size but not parse: cross-origin, non-JSON,
 * over 32KB, or unparseable after redaction. `bodyMeta` carries size facts and
 * no `data`, which is the shape a detector must treat as no evidence.
 */
export function opaqueResponse(
  t: number,
  requestId: string,
  options: { ct?: string; bytes?: number; status?: number } = {},
): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      requestId,
      st: options.status ?? 200,
      dur: 8,
      body: "[REDACTED]",
      bodyMeta: {
        ct: options.ct ?? "application/json",
        bytes: options.bytes ?? 4096,
      },
    },
  } as unknown as BugEvent;
}

/**
 * A response with no `bodyMeta` at all: a backend-captured, replayed, or
 * pre-`bodyMeta` session, where the redacted text is the only source. Nothing
 * capped it, so its lengths are exact.
 */
export function legacyJsonResponse(
  t: number,
  requestId: string,
  payload: unknown,
  options: { status?: number } = {},
): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      requestId,
      st: options.status ?? 200,
      dur: 8,
      body: JSON.stringify(payload),
    },
  } as unknown as BugEvent;
}

/** A `net.req` matching the fixtures above. */
export function request(
  t: number,
  requestId: string,
  method: string,
  url: string,
  body?: unknown,
): BugEvent {
  return {
    t,
    k: "net.req",
    d: {
      requestId,
      m: method,
      url,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  } as unknown as BugEvent;
}
