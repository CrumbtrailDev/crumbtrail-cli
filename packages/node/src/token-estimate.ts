/**
 * Token estimation + shared budget-fill for the token-budgeted MCP surface
 * (CP4). Pure module: no I/O, no clocks, no randomness — every output is a
 * deterministic function of the inputs, so budgeted tool responses are
 * reproducible byte-for-byte.
 */

/**
 * Slack allowance, in estimated tokens, that covers the budgeting envelope a
 * budgeted response adds on top of its kept content: the `dropReport` object
 * (counts, capped refs, message) and the `tokenEstimate` field itself, plus
 * per-item rounding in {@link fillToBudget}'s cost model. Contract: whenever
 * the fixed (non-item) part of a payload fits the budget, the final response's
 * {@link estimateTokens} over its exact serialized form is
 * `<= maxTokens + BUDGET_SLACK_TOKENS`.
 */
export const BUDGET_SLACK_TOKENS = 256;

/** Max refs surfaced in a {@link DropReport} (both the array and the message). */
const DROP_REPORT_REF_CAP = 10;

/**
 * Cheap chars/4 token estimate over an already-serialized string:
 * `Math.ceil(serialized.length / 4)`.
 *
 * Bias, documented on purpose: this is a heuristic, not a tokenizer. It
 * UNDER-counts token-dense content (non-ASCII text, base64/hex blobs, dense
 * punctuation — real tokenizers emit more than 1 token per 4 chars there), so
 * callers budgeting for a specific model context should leave headroom. MCP
 * estimates are always taken over the exact `textResult` serialization —
 * `JSON.stringify(data, null, 2)` — so pretty-print indentation and newlines
 * are included in the count.
 */
export function estimateTokens(serialized: string): number {
  return Math.ceil(serialized.length / 4);
}

/** Structured report of what a budget fill omitted. Deterministic: no clocks,
 *  refs in the items' original rank order (no Set/Map iteration involved). */
export interface DropReport {
  /** How many whole items were dropped. */
  droppedCount: number;
  /** Estimated tokens the dropped items would have cost in the payload. */
  droppedTokenEstimate: number;
  /** Refs of the dropped items, rank order, capped at 10. */
  droppedRefs: string[];
  /** Human/agent-readable summary, e.g. "omitted 3 items, ~1.2k tokens, refs: a, b, c". */
  message: string;
}

export interface FillToBudgetOptions<T> {
  /** Total token budget for the final serialized payload. */
  maxTokens: number;
  /**
   * Estimated tokens of the payload WITHOUT any items — i.e.
   * `estimateTokens(JSON.stringify({ ...payload, [itemsKey]: [] }, null, 2))`.
   */
  baseTokens: number;
  /** Stable ref for an item (candidate id, EvidenceItem.id, "t=<ms>", ...). */
  refOf: (item: T) => string;
  /** Standalone serialization of one item; `JSON.stringify(item, null, 2)`. */
  serialize: (item: T) => string;
}

export interface FillToBudgetResult<T> {
  kept: T[];
  /** Present iff at least one item was dropped. */
  report?: DropReport;
}

/**
 * Estimated in-payload cost of one item. The item is assumed to be embedded in
 * a pretty-printed (indent 2) array under a top-level property of the final
 * payload, so relative to its standalone serialization every line gains 4
 * columns of indentation and the item costs a `",\n"` separator. Ceiling per
 * item slightly over-counts — the safe direction for a budget bound.
 */
function itemCost(serialized: string): number {
  let lines = 1;
  for (let i = 0; i < serialized.length; i += 1) {
    if (serialized.charCodeAt(i) === 10) lines += 1;
  }
  return Math.ceil((serialized.length + 4 * lines + 2) / 4);
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  const rounded =
    thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${rounded}k`;
}

/**
 * Shared budget fill: keeps the longest PREFIX of `items` (already in rank
 * order — the caller never re-sorts) whose estimated cost fits
 * `maxTokens - baseTokens`, and reports everything after it as dropped.
 *
 * Semantics pinned by tests:
 * - Drop strictly from the bottom of the given rank order: the kept set is
 *   always a prefix, so a mid-rank item is NEVER dropped while a lower-ranked
 *   one is kept — even when the lower-ranked item is smaller and would fit.
 * - A budget too small for even one item (or smaller than `baseTokens`) keeps
 *   nothing and reports everything dropped: never throws, never loops.
 * - Deterministic: refs come from `refOf` in item order; no clocks.
 */
export function fillToBudget<T>(
  items: T[],
  opts: FillToBudgetOptions<T>,
): FillToBudgetResult<T> {
  const available = opts.maxTokens - opts.baseTokens;
  let used = 0;
  let keptCount = 0;
  for (const item of items) {
    const cost = itemCost(opts.serialize(item));
    if (used + cost > available) break;
    used += cost;
    keptCount += 1;
  }

  const kept = items.slice(0, keptCount);
  const dropped = items.slice(keptCount);
  if (dropped.length === 0) return { kept };

  let droppedTokenEstimate = 0;
  for (const item of dropped)
    droppedTokenEstimate += itemCost(opts.serialize(item));
  const refs = dropped.slice(0, DROP_REPORT_REF_CAP).map(opts.refOf);
  const noun = dropped.length === 1 ? "item" : "items";
  const ellipsis = dropped.length > DROP_REPORT_REF_CAP ? "…" : "";
  return {
    kept,
    report: {
      droppedCount: dropped.length,
      droppedTokenEstimate,
      droppedRefs: refs,
      message: `omitted ${dropped.length} ${noun}, ~${formatTokenCount(droppedTokenEstimate)} tokens, refs: ${refs.join(", ")}${ellipsis}`,
    },
  };
}

/**
 * Appends a self-consistent `tokenEstimate` field to a payload: the estimate is
 * taken over the FINAL serialized form (`JSON.stringify(data, null, 2)`, the
 * exact `textResult` serialization) INCLUDING the `tokenEstimate` field itself,
 * via a small fixed-point iteration (the field's digit count feeds back into
 * the length; it converges in one or two passes for realistic payloads).
 */
export function attachTokenEstimate<T extends Record<string, unknown>>(
  payload: T,
): T & { tokenEstimate: number } {
  let estimate = 0;
  for (let i = 0; i < 5; i += 1) {
    const next = estimateTokens(
      JSON.stringify({ ...payload, tokenEstimate: estimate }, null, 2),
    );
    if (next === estimate) break;
    estimate = next;
  }
  return { ...payload, tokenEstimate: estimate };
}
