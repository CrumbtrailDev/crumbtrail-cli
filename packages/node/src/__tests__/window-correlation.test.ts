import type { BugEvent } from "crumbtrail-core";
import { describe, expect, it } from "vitest";
import {
  MIN_KS_SAMPLES,
  MIN_VOLUME_EVENTS,
  correlateWindow,
} from "../window-correlation";

const T0 = 1_000_000;
const T1 = 1_010_000;
const WIDTH = T1 - T0;

/**
 * Twenty distinct latencies. Both the baseline and the highlight of the "volume
 * only" stream draw from exactly this set, so their empirical distributions are
 * identical and KS has nothing to find there.
 */
const DURS = Array.from({ length: 20 }, (_, i) => 100 + i * 10);

function netRes(t: number, dur: number): BugEvent {
  return { t, k: "net.res", d: { dur, st: 200, bodyMeta: { bytes: 500 } } };
}

/**
 * An event of a kind with no entry in `NUMERIC_FIELDS_BY_KIND`, so a stream
 * built from it runs exactly one test: the volume scorer on `err`. That keeps
 * the Benjamini-Hochberg denominator at 1 and lets a p value assertion be about
 * the scorer rather than about the multiple comparison correction.
 */
function errAt(t: number): BugEvent {
  return { t, k: "err", d: { msg: "boom" } };
}

describe("correlateWindow — window boundaries", () => {
  it("puts an event at exactly t0 in the highlight, never the baseline", () => {
    const events: BugEvent[] = [
      netRes(T0 - 1, 100),
      netRes(T0, 100),
      netRes(T1, 100),
    ];
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    expect(result.baseline).toEqual({
      t0: T0 - 4 * WIDTH,
      t1: T0,
      events: 1,
    });
    expect(result.highlight).toEqual({ t0: T0, t1: T1, events: 2 });
  });

  it("keeps the highlight inclusive at t1 and the baseline half open", () => {
    // One event on each of the four interesting instants.
    const events: BugEvent[] = [
      netRes(T0 - 4 * WIDTH - 1, 100), // before the baseline
      netRes(T0 - 4 * WIDTH, 100), // first baseline ms, inclusive
      netRes(T1, 100), // last highlight ms, inclusive
      netRes(T1 + 1, 100), // after the highlight
    ];
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    expect(result.baseline.events).toBe(1);
    expect(result.highlight.events).toBe(1);
  });

  it("says nothing for a zero width highlight instead of dividing by it", () => {
    const events = Array.from({ length: 40 }, (_, i) => netRes(T0 - i, 100));
    const result = correlateWindow(events, { t0: T0, t1: T0 });
    expect(result.rows).toEqual([]);
    expect(result.testsRun).toBe(0);
  });
});

describe("correlateWindow — stream A: flat baseline, spike in the highlight", () => {
  // 20 events across a 40s baseline (0.5/s), 60 across a 10s highlight (6/s).
  // Values are drawn from DURS on BOTH sides: the baseline holds each value
  // once, the highlight holds each value three times, so the two empirical
  // distributions are identical and only the RATE changed.
  const events: BugEvent[] = [
    ...Array.from({ length: 20 }, (_, i) =>
      netRes(T0 - 4 * WIDTH + i * 2000, DURS[i] as number),
    ),
    ...Array.from({ length: 60 }, (_, i) =>
      netRes(T0 + i * 160, DURS[i % 20] as number),
    ),
  ];
  const result = correlateWindow(events, { t0: T0, t1: T1 });

  it("is caught by the volume scorer", () => {
    const volume = result.rows.filter((row) => row.scorer === "volume-delta");
    expect(volume).toHaveLength(1);
    expect(volume[0]).toMatchObject({
      dimension: "volume",
      kind: "net.res",
      field: "count",
      direction: "increase",
      baselineStat: 5, // 20 baseline events rescaled to a 1x window
      highlightStat: 60,
    });
    expect(volume[0]?.pValue).toBeLessThan(1e-20);
  });

  it("is NOT caught by KS — the value distribution did not move", () => {
    expect(result.rows.filter((row) => row.scorer === "ks-two-sample")).toEqual(
      [],
    );
  });

  it("ran the KS tests and they simply did not fire", () => {
    // Guards against the negative assertion above passing vacuously because
    // KS never ran: 1 volume test plus 3 KS fields.
    expect(result.testsRun).toBe(4);
  });
});

describe("correlateWindow — stream B: equal volume, shifted latency", () => {
  // baselineMultiplier 1 makes the two windows the same width, so 60 events on
  // each side is both equal counts AND equal rate: the volume scorer has
  // literally nothing to see. Latency moves from 100..159 to 300..359.
  const events: BugEvent[] = [
    ...Array.from({ length: 60 }, (_, i) =>
      netRes(T0 - WIDTH + i * 160, 100 + i),
    ),
    ...Array.from({ length: 60 }, (_, i) => netRes(T0 + i * 160, 300 + i)),
  ];
  const result = correlateWindow(events, {
    t0: T0,
    t1: T1,
    baselineMultiplier: 1,
  });

  it("is caught by KS on the shifted field", () => {
    const ks = result.rows.filter((row) => row.scorer === "ks-two-sample");
    expect(ks).toHaveLength(1);
    expect(ks[0]).toMatchObject({
      dimension: "distribution",
      kind: "net.res",
      field: "dur",
      direction: "increase",
      baselineStat: 129.5,
      highlightStat: 329.5,
    });
    expect(ks[0]?.pValue).toBeLessThan(1e-20);
  });

  it("is NOT caught by the volume scorer — the rate did not move", () => {
    expect(result.rows.filter((row) => row.scorer === "volume-delta")).toEqual(
      [],
    );
  });

  it("ran the volume test and it simply did not fire", () => {
    expect(result.baseline.events).toBe(60);
    expect(result.highlight.events).toBe(60);
    expect(result.testsRun).toBe(4);
  });

  it("does not report the fields that held still", () => {
    expect(result.rows.map((row) => row.field)).toEqual(["dur"]);
  });
});

describe("correlateWindow — no change", () => {
  const events: BugEvent[] = [
    ...Array.from({ length: 80 }, (_, i) =>
      netRes(T0 - 4 * WIDTH + i * 500, DURS[i % 20] as number),
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      netRes(T0 + i * 500, DURS[i % 20] as number),
    ),
  ];
  const result = correlateWindow(events, { t0: T0, t1: T1 });

  it("returns zero rows after the Benjamini-Hochberg cut", () => {
    expect(result.rows).toEqual([]);
  });

  it("still ran all four tests", () => {
    expect(result.testsRun).toBe(4);
    expect(result.baseline.events).toBe(80);
    expect(result.highlight.events).toBe(20);
  });
});

describe("correlateWindow — scorer floors and shapes", () => {
  it("flags a kind that appears only in the highlight", () => {
    const events: BugEvent[] = [
      ...Array.from({ length: 40 }, (_, i) =>
        netRes(T0 - 4 * WIDTH + i * 1000, 100),
      ),
      ...Array.from({ length: 10 }, (_, i) => netRes(T0 + i * 500, 100)),
      // 25 rather than 12: the volume floor is a floor on the COMBINED count,
      // and this kind has no baseline events at all to contribute to it.
      ...Array.from({ length: 25 }, (_, i) => ({
        t: T0 + i * 400,
        k: "err",
        d: { msg: "boom" },
      })),
    ];
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    const err = result.rows.find((row) => row.kind === "err");
    expect(err).toMatchObject({
      dimension: "volume",
      scorer: "volume-delta",
      direction: "increase",
      baselineStat: 0,
      highlightStat: 25,
    });
  });

  it("does not run the volume test below its event floor", () => {
    const events: BugEvent[] = Array.from(
      { length: MIN_VOLUME_EVENTS - 1 },
      (_, i) => netRes(T0 + i, 100),
    );
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    expect(result.testsRun).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("does not run KS below its per side sample floor", () => {
    // 20 baseline and 20 highlight events clear the volume floor, but only the
    // first MIN_KS_SAMPLES - 1 highlight events carry a numeric `dur`.
    const events: BugEvent[] = [
      ...Array.from({ length: 20 }, (_, i) =>
        netRes(T0 - 4 * WIDTH + i * 2000, DURS[i] as number),
      ),
      ...Array.from({ length: 20 }, (_, i) => ({
        t: T0 + i * 100,
        k: "net.res",
        d:
          i < MIN_KS_SAMPLES - 1
            ? { dur: 100 }
            : ({ note: "no numeric fields" } as Record<string, unknown>),
      })),
    ];
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    expect(result.rows.some((row) => row.scorer === "ks-two-sample")).toBe(
      false,
    );
    // Only the volume test ran: every KS field is short on the highlight side.
    expect(result.testsRun).toBe(1);
  });

  it("reads a dotted field path out of the payload", () => {
    const events: BugEvent[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        t: T0 - WIDTH + i * 300,
        k: "net.res",
        d: { dur: 100, st: 200, bodyMeta: { bytes: 500 } },
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        t: T0 + i * 300,
        k: "net.res",
        d: { dur: 100, st: 200, bodyMeta: { bytes: 90_000 } },
      })),
    ];
    const result = correlateWindow(events, {
      t0: T0,
      t1: T1,
      baselineMultiplier: 1,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      field: "bodyMeta.bytes",
      direction: "increase",
      baselineStat: 500,
      highlightStat: 90_000,
    });
  });

  it("reports a rate DROP as a decrease", () => {
    const events: BugEvent[] = [
      ...Array.from({ length: 80 }, (_, i) =>
        netRes(T0 - 4 * WIDTH + i * 500, 100),
      ),
      netRes(T0 + 1, 100),
      netRes(T0 + 2, 100),
    ];
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    const volume = result.rows.find((row) => row.scorer === "volume-delta");
    expect(volume).toMatchObject({
      direction: "decrease",
      baselineStat: 20,
      highlightStat: 2,
    });
  });

  it("does not test a kind whose combined count sits at the old floor", () => {
    // The concrete case the floor exists for: 5 events in the 4x baseline and 5
    // in the highlight. The uncorrected normal put this at p = 0.018, which
    // survived the q = 0.05 cut and was reported as a real rate increase. The
    // exact two sided binomial is 0.066, so the correct answer is silence.
    const events: BugEvent[] = [
      ...Array.from({ length: 5 }, (_, i) => errAt(T0 - 4 * WIDTH + i * 1000)),
      ...Array.from({ length: 5 }, (_, i) => errAt(T0 + i * 1000)),
    ];
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    expect(result.testsRun).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("orders surviving rows by p value", () => {
    const events: BugEvent[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        t: T0 - WIDTH + i * 300,
        k: "net.res",
        d: { dur: 100 + i, st: 200, bodyMeta: { bytes: 500 + i } },
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        t: T0 + i * 100,
        k: "net.res",
        d: { dur: 5000 + i, st: 500, bodyMeta: { bytes: 40_000 + i } },
      })),
    ];
    const result = correlateWindow(events, {
      t0: T0,
      t1: T1,
      baselineMultiplier: 1,
    });
    expect(result.rows.length).toBeGreaterThan(1);
    for (let i = 1; i < result.rows.length; i += 1) {
      expect(result.rows[i]?.pValue).toBeGreaterThanOrEqual(
        result.rows[i - 1]?.pValue as number,
      );
    }
  });
});

describe("correlateWindow — volume p value calibration", () => {
  /**
   * The volume p value is the only number in this module a caller acts on
   * directly, and nothing else in this file pins it: the other volume
   * assertions are `< 1e-20` on a case so extreme that any monotone function of
   * the counts would pass. So the arithmetic was free to be wrong, and it was —
   * the normal approximation ran with no continuity correction, which deflates
   * every volume p value by a factor of two to four.
   *
   * Each case below is one event kind with no numeric fields, so exactly one
   * test runs and the Benjamini-Hochberg denominator is 1. At the default 4x
   * multiplier the conditional distribution of the highlight count is
   * Binomial(total, 0.2).
   *
   * `corrected` is the value this module must return: `2 * Phi(-(|k - n*p0| -
   * 0.5) / sqrt(n*p0*(1-p0)))`. `uncorrected` is what it returned before the
   * fix, and `exact` is the two sided binomial, computed by summing the tail
   * pmf. The corrected value has to sit between the two: the correction closes
   * most of the gap to the exact test without overshooting past it.
   */
  const CASES: Array<{
    baseline: number;
    highlight: number;
    corrected: number;
    uncorrected: number;
    exact: number;
  }> = [
    {
      baseline: 15,
      highlight: 10,
      corrected: 0.024449,
      uncorrected: 0.012419,
      exact: 0.034664,
    },
    {
      baseline: 26,
      highlight: 14,
      corrected: 0.0297,
      uncorrected: 0.017706,
      exact: 0.038815,
    },
    {
      baseline: 33,
      highlight: 17,
      corrected: 0.021556,
      uncorrected: 0.013328,
      exact: 0.028883,
    },
  ];

  for (const testCase of CASES) {
    const total = testCase.baseline + testCase.highlight;
    it(`prices ${testCase.highlight} of ${total} at the continuity corrected value`, () => {
      const events: BugEvent[] = [
        ...Array.from({ length: testCase.baseline }, (_, i) =>
          errAt(T0 - 4 * WIDTH + i * 1000),
        ),
        ...Array.from({ length: testCase.highlight }, (_, i) =>
          errAt(T0 + i * 400),
        ),
      ];
      const result = correlateWindow(events, { t0: T0, t1: T1 });
      expect(result.testsRun).toBe(1);
      const row = result.rows.find((entry) => entry.scorer === "volume-delta");
      expect(row).toBeDefined();

      // Pinned to the hand computed corrected value, five decimals.
      expect(row?.pValue).toBeCloseTo(testCase.corrected, 5);
      // And bracketed, which is the property that survives a change of fit:
      // strictly more conservative than the uncorrected normal, still no more
      // conservative than the exact binomial it approximates.
      expect(row?.pValue).toBeGreaterThan(testCase.uncorrected);
      expect(row?.pValue).toBeLessThan(testCase.exact);
    });
  }

  it("says nothing when the highlight count sits exactly on its expected rate", () => {
    // 40 baseline and 10 highlight is precisely the 4x rate. The test runs and
    // reports nothing, which is the case that proves silence here comes from
    // the scorer answering rather than from the floor skipping it.
    const events: BugEvent[] = [
      ...Array.from({ length: 40 }, (_, i) => errAt(T0 - 4 * WIDTH + i * 1000)),
      ...Array.from({ length: 10 }, (_, i) => errAt(T0 + i * 400)),
    ];
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    expect(result.testsRun).toBe(1);
    expect(result.rows).toEqual([]);
  });

  it("still reads a rate drop as a decrease after the absolute value", () => {
    // `direction` comes from the rescaled counts, not from the sign of z, so
    // taking |k - mean| inside the correction must not flatten a drop.
    const events: BugEvent[] = [
      ...Array.from({ length: 100 }, (_, i) => errAt(T0 - 4 * WIDTH + i * 400)),
      ...Array.from({ length: 5 }, (_, i) => errAt(T0 + i * 400)),
    ];
    const result = correlateWindow(events, { t0: T0, t1: T1 });
    const row = result.rows.find((entry) => entry.scorer === "volume-delta");
    expect(row).toMatchObject({
      direction: "decrease",
      baselineStat: 25,
      highlightStat: 5,
    });
  });
});
