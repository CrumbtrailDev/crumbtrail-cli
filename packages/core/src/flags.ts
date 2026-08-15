/**
 * Feature-flag normalization and change detection.
 *
 * Pure, dependency-free, and deliberately free of any SDK plumbing: no events, no transport,
 * no globals. `setEnv` today re-states whatever the app passed it, so a reader of a captured
 * session cannot tell "the app re-declared its flags on every route change" from "the flag
 * actually flipped mid session" — which is precisely the question a flag-caused regression
 * asks. These two functions are what make that distinction expressible.
 *
 * Flag providers disagree about shape. Some hand back a bare value (`true`, `"blue"`), some
 * hand back a value plus the variant key that produced it (`{ value: true, variant: "test" }`).
 * `normalizeFlagValue` folds both into one record so a diff compares like with like, and it is
 * idempotent so a normalized record can be re-normalized (or stored and re-read) without drift.
 */

/** A flag value paired with the provider variant that produced it, when one is known. */
export interface NormalizedFlag {
  /** The flag's effective value. Any JSON-ish shape, including `null`. */
  value: unknown;
  /** Provider variant key, present only when the provider supplied a string one. */
  variant?: string;
}

/** One key that moved between two flag states. `undefined` on either side means absent. */
export interface FlagChange {
  from: NormalizedFlag | undefined;
  to: NormalizedFlag | undefined;
}

export interface FlagDiff {
  /** Only the keys that actually moved. An unchanged re-declaration produces an empty object. */
  changed: Record<string, FlagChange>;
  /** Normalized `next`, ready to be carried forward as the `prev` of the following diff. */
  nextState: Record<string, NormalizedFlag>;
}

/**
 * Depth past which `deepEqual` stops recursing and falls back to reference equality. Flag
 * payloads are configuration, not object graphs; this is a cheap guard against a pathological
 * or cyclic value blowing the stack inside a capture path that must never throw.
 */
const MAX_COMPARE_DEPTH = 20;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True when `v` is the provider wrapper shape `{ value, variant? }` rather than a flag value
 * that merely happens to be an object.
 *
 * The key-subset check is what keeps this honest: `{ value: 1, other: 2 }` is a payload, not a
 * wrapper, and unwrapping it would silently drop `other`. A non-string `variant` is malformed,
 * so the object is preserved whole rather than partially discarded.
 */
function isFlagWrapper(v: unknown): v is { value: unknown; variant?: unknown } {
  if (!isPlainObject(v)) return false;
  if (!("value" in v)) return false;
  for (const key of Object.keys(v)) {
    if (key !== "value" && key !== "variant") return false;
  }
  if ("variant" in v && v.variant !== undefined && typeof v.variant !== "string") {
    return false;
  }
  return true;
}

/**
 * Fold any provider flag shape into `{ value, variant? }`.
 *
 * Scalars, strings, `null`, arrays and non-wrapper objects pass through as `value` with no
 * variant. The `variant` key is omitted entirely rather than set to `undefined`, so a
 * variant-less flag deep-equals a plain `{ value }` record.
 *
 * Idempotent: `normalizeFlagValue(normalizeFlagValue(x))` deep-equals `normalizeFlagValue(x)`
 * for every input, which is what lets a normalized record be stored, re-read, and fed back in.
 */
export function normalizeFlagValue(v: unknown): NormalizedFlag {
  if (isFlagWrapper(v)) {
    const variant = typeof v.variant === "string" ? v.variant : undefined;
    return variant === undefined ? { value: v.value } : { value: v.value, variant };
  }
  return { value: v };
}

/**
 * Structural equality for flag values. Hand-rolled on purpose: `crumbtrail-core` advertises
 * zero runtime dependencies, and reference equality would report a change every time an app
 * re-declared an object-valued flag with a freshly built literal.
 */
function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  // NaN is the one primitive `===` disagrees with itself about.
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (depth >= MAX_COMPARE_DEPTH) return false;

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!deepEqual(arrA[i], arrB[i], depth + 1)) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!deepEqual(objA[key], objB[key], depth + 1)) return false;
  }
  return true;
}

function normalizeState(
  state: Record<string, unknown> | null | undefined,
): Record<string, NormalizedFlag> {
  const out: Record<string, NormalizedFlag> = {};
  if (!isPlainObject(state)) return out;
  for (const key of Object.keys(state)) {
    out[key] = normalizeFlagValue(state[key]);
  }
  return out;
}

/**
 * Compare two declared flag states and report only what moved.
 *
 * `next` is authoritative: a key present in `prev` and absent from `next` is a removal, not an
 * omission. `from`/`to` carry the normalized record rather than the bare value, so a variant
 * flip over an unchanged value is still a visible change. Both sides tolerate `undefined` and
 * non-object input, because this sits on a capture path that must never throw.
 */
export function diffFlags(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): FlagDiff {
  const prevState = normalizeState(prev);
  const nextState = normalizeState(next);
  const changed: Record<string, FlagChange> = {};

  for (const key of Object.keys(nextState)) {
    const before = Object.prototype.hasOwnProperty.call(prevState, key)
      ? prevState[key]
      : undefined;
    if (before === undefined || !deepEqual(before, nextState[key])) {
      changed[key] = { from: before, to: nextState[key] };
    }
  }

  for (const key of Object.keys(prevState)) {
    if (!Object.prototype.hasOwnProperty.call(nextState, key)) {
      changed[key] = { from: prevState[key], to: undefined };
    }
  }

  return { changed, nextState };
}
