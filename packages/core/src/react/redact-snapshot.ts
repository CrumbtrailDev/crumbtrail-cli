import {
  BROWSER_REDACTION_POLICY,
  BROWSER_REDACTION_POLICY_V2,
  mergeRedactionMetadata,
  redactNetworkTextBody,
  STRUCTURED_BODY_MAX_ARRAY_ENTRIES,
  type PayloadSummary,
  type RedactionField,
  type RedactionMetadata,
} from "../redaction";

/**
 * The React plane's redaction entry points.
 *
 * There is exactly one redaction engine in this package, in `../redaction.ts`,
 * and this module owns nothing but the two things the engine cannot do for
 * itself on this plane:
 *
 * 1. React state is an arbitrary in-memory JavaScript graph, not a string that
 *    arrived off the network. The engine's structured walker takes a serialized
 *    body, so the graph has to be made JSON-safe and structurally bounded first
 *    — which is also the only place a cycle can be broken before it reaches
 *    `JSON.stringify`.
 * 2. An error message and a stack trace are free text, so they take the engine's
 *    free-text route, exactly as `collectors/error.ts` routes `msg` and `stk`.
 *
 * Nothing here re-declares a rule. This file previously lived as a fork of the
 * engine's name tables inside `use-bug-state.ts`, which meant the React plane
 * classified on key names alone: an email, a spaced card number, an SSN, a short
 * IBAN and any sub-40-character secret all transmitted verbatim under a key name
 * the fork did not recognise, and every substitution was a bare `[REDACTED]` so
 * two different secrets compared equal.
 */

/* ------------------------------------------------------------------ */
/* Structural bounds on the React snapshot normalizer                  */
/* ------------------------------------------------------------------ */

/**
 * How deep the normalizer descends before it stands a subtree in.
 *
 * Matches the bound the structured network walker uses, for the same reason:
 * hand written state shapes bottom out around ten levels, and the depth past
 * that is a normalised store or a parent back-pointer chain rather than data a
 * reader wants.
 */
export const REACT_SNAPSHOT_MAX_DEPTH = 24;

/**
 * How many array entries the normalizer keeps.
 *
 * One below the shared walker's bound, and derived from it so the two cannot
 * drift apart. The normalizer appends a stand-in saying how long the list
 * really was, and at an equal bound the walker's own truncation ate exactly
 * that element — leaving a shortened list that read as the whole list, which is
 * the one reading that sends a debugger down the wrong path. Keeping one fewer
 * entry puts the stand-in inside the window the walker preserves.
 */
export const REACT_SNAPSHOT_MAX_ARRAY_ENTRIES =
  STRUCTURED_BODY_MAX_ARRAY_ENTRIES - 1;

/** How many own keys the normalizer keeps on one object. */
export const REACT_SNAPSHOT_MAX_OBJECT_KEYS = 500;

/** Longest key kept verbatim. A key longer than this is a value wearing a key's clothes. */
export const REACT_SNAPSHOT_MAX_KEY_LENGTH = 128;

/**
 * Total values the normalizer will visit.
 *
 * Depth, array and key bounds each cap one dimension; a wide-and-shallow graph
 * can still be enormous while breaking none of them. This is the backstop that
 * keeps a snapshot from costing more than the bug it explains, and it fires on
 * the same terms as the others: the part that broke it is replaced, the rest of
 * the snapshot is delivered.
 */
export const REACT_SNAPSHOT_MAX_NODES = 10_000;

/**
 * What a stand-in for an omitted part of the graph looks like.
 *
 * An object, not a string, and that is deliberate. Everything the normalizer
 * emits is handed straight to the engine's structured walker, which classifies
 * every string it meets — a `"[OMITTED:depth]"` marker would be read as free
 * text and replaced with a shape placeholder, so the reason it existed would be
 * the one thing lost. As an object with an enum-like `reason` and numeric
 * counts it survives the walk untouched.
 *
 * `limit` and `observed` ride on the value rather than on the
 * {@link RedactionField}, because the field type on this branch carries neither.
 */
interface OmittedStandIn {
  $omitted: string;
  limit?: number;
  observed?: number;
  kind?: string;
}

function omitted(
  reason: string,
  extra: Omit<OmittedStandIn, "$omitted"> = {},
): OmittedStandIn {
  return { $omitted: reason, ...extra };
}

interface NormalizeState {
  fields: RedactionField[];
  seen: Set<object>;
  nodes: number;
}

function pushField(state: NormalizeState, path: string, reason: string): void {
  state.fields.push({ path, reason, action: "summarized" });
}

/**
 * Make one value JSON-safe and structurally bounded.
 *
 * Every bound replaces or shortens only the part that broke it. A snapshot is
 * never discarded whole for one cycle or one long list: the point of capturing
 * state is to show a reader what the component held, and a stand-in where the
 * unusual part was still shows that.
 */
function normalize(
  value: unknown,
  path: string,
  depth: number,
  state: NormalizeState,
): unknown {
  state.nodes += 1;
  if (state.nodes > REACT_SNAPSHOT_MAX_NODES) {
    pushField(state, path, "node_budget_exceeded");
    return omitted("budget", { limit: REACT_SNAPSHOT_MAX_NODES });
  }

  if (value === null) return null;

  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    // A non-finite number has no JSON form; `JSON.stringify` writes `null` and
    // a reader cannot tell that apart from a field that was genuinely null.
    if (type === "number" && !Number.isFinite(value as number))
      return omitted("unsupported", { kind: String(value) });
    return value;
  }
  if (type === "undefined")
    return omitted("unsupported", { kind: "undefined" });
  if (type === "function" || type === "symbol" || type === "bigint")
    return omitted("unsupported", { kind: type });
  if (type !== "object") return omitted("unsupported", { kind: type });

  const object = value as object;

  // React state is the most likely place in any codebase to hold a cycle: refs,
  // DOM nodes, parent back-pointers, normalised stores. The old walker had no
  // guard at all, so one threw a RangeError from inside `componentDidCatch` —
  // a crash inside the crash handler.
  if (state.seen.has(object)) {
    pushField(state, path, "structure_cycle");
    return omitted("cycle");
  }

  if (depth >= REACT_SNAPSHOT_MAX_DEPTH) {
    pushField(state, path, "structure_depth_exceeded");
    return omitted("depth", {
      limit: REACT_SNAPSHOT_MAX_DEPTH,
      observed: depth,
    });
  }

  // Serialized before the generic object walk, which sees no own enumerable
  // properties on any of them and would render every one as `{}`.
  if (object instanceof Date) {
    const time = object.getTime();
    return Number.isFinite(time) ? object.toISOString() : null;
  }
  if (object instanceof Set) {
    return normalize([...object], path, depth, state);
  }
  if (object instanceof Map) {
    return normalize([...object], path, depth, state);
  }

  state.seen.add(object);
  try {
    if (Array.isArray(object)) {
      if (object.length > REACT_SNAPSHOT_MAX_ARRAY_ENTRIES) {
        pushField(state, path, "array_length_exceeded");
      }
      const kept = object.slice(0, REACT_SNAPSHOT_MAX_ARRAY_ENTRIES);
      const output: unknown[] = kept.map((entry, index) =>
        normalize(entry, `${path}[${index}]`, depth + 1, state),
      );
      // Appended rather than dropped: a shortened list that says nothing about
      // its own length reads as the whole list, which is the one reading that
      // sends a debugger down the wrong path.
      if (object.length > REACT_SNAPSHOT_MAX_ARRAY_ENTRIES) {
        output.push(
          omitted("array_length", {
            limit: REACT_SNAPSHOT_MAX_ARRAY_ENTRIES,
            observed: object.length,
          }),
        );
      }
      return output;
    }

    let entries: Array<[string, unknown]>;
    try {
      entries = Object.entries(object as Record<string, unknown>);
    } catch {
      // A throwing getter on a property the walk touched.
      pushField(state, path, "unreadable_property");
      return omitted("unreadable");
    }

    const output: Record<string, unknown> = {};
    if (entries.length > REACT_SNAPSHOT_MAX_OBJECT_KEYS) {
      pushField(state, path, "object_keys_exceeded");
      output.$omittedKeys = {
        $omitted: "object_keys",
        limit: REACT_SNAPSHOT_MAX_OBJECT_KEYS,
        observed: entries.length,
      };
    }
    for (const [rawKey, entry] of entries.slice(
      0,
      REACT_SNAPSHOT_MAX_OBJECT_KEYS,
    )) {
      let key = rawKey;
      if (key.length > REACT_SNAPSHOT_MAX_KEY_LENGTH) {
        key = `${key.slice(0, REACT_SNAPSHOT_MAX_KEY_LENGTH)}…`;
        pushField(state, `${path}.${key}`, "json_key_too_long");
      }
      if (entry === undefined) continue;
      output[key] = normalize(entry, `${path}.${key}`, depth + 1, state);
    }
    return output;
  } finally {
    state.seen.delete(object);
  }
}

export interface ReactSnapshotRedaction {
  value: unknown;
  metadata?: RedactionMetadata;
}

function structuralMetadata(
  fields: RedactionField[],
): RedactionMetadata | undefined {
  if (fields.length === 0) return undefined;
  return { policy: BROWSER_REDACTION_POLICY_V2, fields };
}

/**
 * Redact a React state snapshot through the shared engine, and report what was
 * removed.
 *
 * The value is bounded and made JSON-safe here, then serialized and handed to
 * {@link redactNetworkTextBody} in structured mode — the engine's per-value
 * classifier, the one that catches an email, a Luhn-passing card run, a JWT, an
 * IBAN and a high-entropy secret regardless of the key name it sits under, and
 * the one that substitutes a shape placeholder rather than a bare marker, so two
 * different secrets no longer compare equal.
 */
export function redactReactSnapshotWithMetadata(
  value: unknown,
  path = "state",
): ReactSnapshotRedaction {
  const state: NormalizeState = { fields: [], seen: new Set(), nodes: 0 };
  try {
    const normalized = normalize(value, path, 0, state);
    const json = JSON.stringify(normalized);
    if (json === undefined) {
      return {
        value: omitted("unsupported"),
        metadata: structuralMetadata([
          { path, reason: "unserializable_snapshot", action: "dropped" },
        ]),
      };
    }
    const result = redactNetworkTextBody(json, {
      contentType: "application/json",
      mode: "structured",
      path,
    });
    const body = result.body;
    if (body === undefined) {
      // The engine chose a summary over a body. Keep its own account of why.
      return {
        value: omitted("engine_summary"),
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
    }
    const metadata = mergeRedactionMetadata(
      structuralMetadata(state.fields),
      result.metadata,
    );
    return {
      value: JSON.parse(body) as unknown,
      ...(metadata ? { metadata } : {}),
    };
  } catch {
    // Redaction is the boundary that lets a value leave the browser. A failure
    // here must fail closed: emit the stand-in, never the input.
    return {
      value: omitted("redaction_failed"),
      metadata: structuralMetadata([
        { path, reason: "react_snapshot_failed", action: "dropped" },
      ]),
    };
  }
}

/**
 * Value-only form, for the state provider callback — which returns a value and
 * has nowhere to put metadata. `crumbtrail.ts` attaches its own redaction
 * evidence when it builds the `state.snap` event.
 */
export function redactReactSnapshot(value: unknown, path = "state"): unknown {
  return redactReactSnapshotWithMetadata(value, path).value;
}

function bodyPlaceholder(summary: PayloadSummary | undefined): string {
  return summary ? `[${summary.action}:${summary.reason}]` : "[REDACTED]";
}

/**
 * Redact one free-text error string — a message, a stack, a component stack.
 *
 * Identical treatment to `collectors/error.ts`, and deliberately not the
 * structured walker: a stack trace is prose with file paths in it, and the
 * structured classifier would read the whole thing as one free-text value and
 * replace it. The free-text route scrubs embedded URLs, `key=value` secrets and
 * token-shaped substrings, and keeps every frame.
 */
export function redactReactErrorText(
  value: string | undefined,
  path: string,
  maxLength?: number,
): { value?: string; metadata?: RedactionMetadata } {
  if (value == null) return {};
  const result = redactNetworkTextBody(value, {
    contentType: "text/plain",
    path,
    ...(maxLength !== undefined ? { maxLength } : {}),
  });
  return {
    value: result.body ?? bodyPlaceholder(result.bodySummary),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

/** Re-exported so callers can assert the plane a React capture claims. */
export { BROWSER_REDACTION_POLICY, BROWSER_REDACTION_POLICY_V2 };
