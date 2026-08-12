import type { BugEvent } from "crumbtrail-core";
import { benjaminiHochberg, ksTwoSample, standardNormalCdf } from "./stats";

/**
 * Detector free "what changed in this window".
 *
 * Every other surface in this product answers with a hand written detector, and
 * a detector only finds what its author anticipated. This module asks the
 * complementary question: hold a highlight window against the quiet stretch
 * immediately before it and report, with a false discovery rate cut, which
 * measurable things differ. A bug nobody wrote a detector for still shows up as
 * a difference.
 *
 * Two scorers run, and neither is redundant:
 *
 * - **Volume delta** compares per kind event RATES. It catches "was flat, then
 *   spiked", which a distribution test cannot see because the values did not
 *   change at all.
 * - **KS two sample** compares the distribution of a numeric field at equal
 *   volume. It catches "same twenty requests, all four times slower", which the
 *   volume scorer cannot see because the count did not change at all.
 *
 * A low p value here is a CORRELATION and not a cause. It says the window
 * differs, not why.
 *
 * Pure: no I/O, no store, no fs, no clock.
 */

/* ------------------------------------------------------------------------- *
 * Numeric field map
 * ------------------------------------------------------------------------- */

/**
 * Which numeric fields the KS scorer may read, per event kind.
 *
 * `BugEvent.d` is `Record<string, unknown>` with no schema
 * (`packages/core/src/types.ts`), so there is nothing to introspect. Guessing
 * generically would score ids, timestamps and enum codes as if they were
 * measurements. The map is therefore declared as data and grown deliberately.
 *
 * `net.res` fields come from the collector that emits them,
 * `packages/core/src/collectors/network.ts`: `dur` is the request duration in
 * ms, `st` the HTTP status, and `bodyMeta.bytes` the response body size. Dotted
 * paths are resolved one level at a time.
 */
export const NUMERIC_FIELDS_BY_KIND: Readonly<
  Record<string, readonly string[]>
> = {
  "net.res": ["dur", "st", "bodyMeta.bytes"],
};

/* ------------------------------------------------------------------------- *
 * Floors
 * ------------------------------------------------------------------------- */

/**
 * Minimum combined baseline + highlight count before the volume scorer runs.
 * Its p value comes from a normal approximation to a binomial, which is not
 * trustworthy on a handful of events; below this the honest answer is "no test
 * was run" rather than a confident verdict built on four events.
 */
export const MIN_VOLUME_EVENTS = 10;

/** Minimum sample size on EACH side before the KS scorer runs, same reason. */
export const MIN_KS_SAMPLES = 5;

/** Default false discovery rate for the Benjamini-Hochberg cut. */
export const DEFAULT_FDR_Q = 0.05;

/* ------------------------------------------------------------------------- *
 * Types
 * ------------------------------------------------------------------------- */

export type WindowCorrelationDirection = "increase" | "decrease" | "flat";

export interface WindowCorrelationRow {
  /** `volume` for rate changes, `distribution` for shape changes. */
  dimension: "volume" | "distribution";
  /** The event kind the row is about, for example `net.res`. */
  kind: string;
  /** `count` for volume rows, otherwise the numeric field path that shifted. */
  field: string;
  scorer: "volume-delta" | "ks-two-sample";
  pValue: number;
  direction: WindowCorrelationDirection;
  /**
   * Volume rows: the baseline count rescaled to a highlight length window, so
   * it is directly comparable with `highlightStat`. Distribution rows: the
   * baseline median of the field.
   */
  baselineStat: number;
  /** Volume rows: the highlight count. Distribution rows: highlight median. */
  highlightStat: number;
}

export interface WindowCorrelationOptions {
  /** Start of the highlight window, absolute ms. Inclusive. */
  t0: number;
  /** End of the highlight window, absolute ms. Inclusive. */
  t1: number;
  /** Baseline width as a multiple of the highlight width. */
  baselineMultiplier?: number;
  /** False discovery rate for the Benjamini-Hochberg cut. */
  q?: number;
}

export interface WindowCorrelationResult {
  /** Baseline window, HALF OPEN: `[t0, t1)`. */
  baseline: { t0: number; t1: number; events: number };
  /** Highlight window, fully inclusive: `[t0, t1]`. */
  highlight: { t0: number; t1: number; events: number };
  baselineMultiplier: number;
  q: number;
  /** How many tests reached a p value and so entered the BH correction. */
  testsRun: number;
  /** Surviving rows, most significant first. Empty means nothing changed. */
  rows: WindowCorrelationRow[];
}

/* ------------------------------------------------------------------------- *
 * Entry point
 * ------------------------------------------------------------------------- */

export function correlateWindow(
  events: BugEvent[],
  options: WindowCorrelationOptions,
): WindowCorrelationResult {
  const highlightStart = Math.min(options.t0, options.t1);
  const highlightEnd = Math.max(options.t0, options.t1);
  const multiplier =
    Number.isFinite(options.baselineMultiplier) &&
    (options.baselineMultiplier as number) > 0
      ? (options.baselineMultiplier as number)
      : 4;
  const q =
    Number.isFinite(options.q) && (options.q as number) > 0
      ? (options.q as number)
      : DEFAULT_FDR_Q;

  const width = highlightEnd - highlightStart;
  const baselineStart = highlightStart - multiplier * width;

  // The baseline is HALF OPEN and the highlight is fully inclusive at both
  // ends, matching `getWindow`. Making the baseline inclusive at its upper
  // bound too would count an event landing exactly on t0 in both windows,
  // which is the one boundary a caller re-windowing around an incident is most
  // likely to hit.
  const baselineEvents = events.filter(
    (event) =>
      typeof event.t === "number" &&
      event.t >= baselineStart &&
      event.t < highlightStart,
  );
  const highlightEvents = events.filter(
    (event) =>
      typeof event.t === "number" &&
      event.t >= highlightStart &&
      event.t <= highlightEnd,
  );

  const result: WindowCorrelationResult = {
    baseline: {
      t0: baselineStart,
      t1: highlightStart,
      events: baselineEvents.length,
    },
    highlight: {
      t0: highlightStart,
      t1: highlightEnd,
      events: highlightEvents.length,
    },
    baselineMultiplier: multiplier,
    q,
    testsRun: 0,
    rows: [],
  };

  // A zero width highlight gives a zero width baseline: there is no rate to
  // compare and no before to compare against. Say nothing rather than divide.
  if (width <= 0) return result;

  const tested: WindowCorrelationRow[] = [
    ...scoreVolume(baselineEvents, highlightEvents, multiplier),
    ...scoreDistributions(baselineEvents, highlightEvents),
  ].sort(
    (a, b) =>
      a.pValue - b.pValue ||
      a.kind.localeCompare(b.kind) ||
      a.field.localeCompare(b.field),
  );

  result.testsRun = tested.length;
  const cut = benjaminiHochberg(
    tested.map((row) => row.pValue),
    q,
  );
  result.rows = tested.filter((_row, index) => cut.rejected[index]);
  return result;
}

/* ------------------------------------------------------------------------- *
 * Volume delta
 * ------------------------------------------------------------------------- */

/**
 * Per kind rate comparison.
 *
 * Conditional on the total count `N = baseline + highlight`, the number landing
 * in the highlight is binomial with `p0 = highlightWidth / (highlightWidth +
 * baselineWidth)`, which reduces to `1 / (1 + multiplier)`. The normal
 * approximation to that binomial gives a two sided p value. Comparing raw
 * counts instead would report every window as a 4x drop purely because the
 * baseline is four times longer.
 */
function scoreVolume(
  baselineEvents: BugEvent[],
  highlightEvents: BugEvent[],
  multiplier: number,
): WindowCorrelationRow[] {
  const baselineCounts = countByKind(baselineEvents);
  const highlightCounts = countByKind(highlightEvents);
  const kinds = [
    ...new Set([...baselineCounts.keys(), ...highlightCounts.keys()]),
  ].sort();

  const p0 = 1 / (1 + multiplier);
  const rows: WindowCorrelationRow[] = [];
  for (const kind of kinds) {
    const baselineCount = baselineCounts.get(kind) ?? 0;
    const highlightCount = highlightCounts.get(kind) ?? 0;
    const total = baselineCount + highlightCount;
    if (total < MIN_VOLUME_EVENTS) continue;

    const mean = total * p0;
    const sd = Math.sqrt(total * p0 * (1 - p0));
    if (!(sd > 0)) continue;
    const z = (highlightCount - mean) / sd;
    // Two sided: 2 * P(Z <= -|z|).
    const pValue = Math.min(1, 2 * standardNormalCdf(-Math.abs(z)));

    // The baseline count rescaled to a highlight length window. Its comparison
    // with `highlightCount` has the same sign as `z` by construction:
    // H > (B + H) * p0  is equivalent to  H > B / multiplier.
    const expected = baselineCount / multiplier;
    rows.push({
      dimension: "volume",
      kind,
      field: "count",
      scorer: "volume-delta",
      pValue,
      direction: directionOf(expected, highlightCount),
      baselineStat: round(expected),
      highlightStat: highlightCount,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------------- *
 * Distribution shift
 * ------------------------------------------------------------------------- */

function scoreDistributions(
  baselineEvents: BugEvent[],
  highlightEvents: BugEvent[],
): WindowCorrelationRow[] {
  const rows: WindowCorrelationRow[] = [];
  for (const [kind, fields] of Object.entries(NUMERIC_FIELDS_BY_KIND)) {
    const baselineOfKind = baselineEvents.filter((event) => event.k === kind);
    const highlightOfKind = highlightEvents.filter((event) => event.k === kind);
    for (const field of fields) {
      const a = numericValues(baselineOfKind, field);
      const b = numericValues(highlightOfKind, field);
      if (a.length < MIN_KS_SAMPLES || b.length < MIN_KS_SAMPLES) continue;
      const ks = ksTwoSample(a, b);
      const baselineMedian = median(a);
      const highlightMedian = median(b);
      rows.push({
        dimension: "distribution",
        kind,
        field,
        scorer: "ks-two-sample",
        pValue: ks.pValue,
        direction: directionOf(baselineMedian, highlightMedian),
        baselineStat: round(baselineMedian),
        highlightStat: round(highlightMedian),
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function countByKind(events: BugEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (typeof event.k !== "string" || event.k === "") continue;
    counts.set(event.k, (counts.get(event.k) ?? 0) + 1);
  }
  return counts;
}

/** Resolve a dotted path inside `d` and keep it only if it is a finite number. */
function numericValues(events: BugEvent[], path: string): number[] {
  const segments = path.split(".");
  const values: number[] = [];
  for (const event of events) {
    let current: unknown = event.d;
    for (const segment of segments) {
      if (typeof current !== "object" || current === null) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (typeof current === "number" && Number.isFinite(current))
      values.push(current);
  }
  return values;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function directionOf(
  baseline: number,
  highlight: number,
): WindowCorrelationDirection {
  if (highlight > baseline) return "increase";
  if (highlight < baseline) return "decrease";
  return "flat";
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
