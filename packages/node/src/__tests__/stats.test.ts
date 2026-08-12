import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  erfc,
  ksTwoSample,
  standardNormalCdf,
} from "../stats";

/** The fit's own stated bound: fractional error below 1.2e-7 everywhere. */
const FIT_TOLERANCE = 1.2e-7;

describe("standardNormalCdf", () => {
  it("agrees with known quantiles inside the fit's stated 1.2e-7", () => {
    const cases: Array<[z: number, expected: number]> = [
      [0, 0.5],
      [1, 0.8413447460685429],
      [1.96, 0.9750021048517795],
      [-1.96, 0.024997895148220435],
      [2.575829303548901, 0.995],
      [-3, 0.0013498980316300946],
    ];
    for (const [z, expected] of cases) {
      const actual = standardNormalCdf(z);
      expect(Math.abs(actual - expected) / expected).toBeLessThan(
        FIT_TOLERANCE,
      );
    }
  });

  it("is symmetric and monotone", () => {
    for (const z of [0.25, 0.5, 1, 2, 4]) {
      expect(standardNormalCdf(z) + standardNormalCdf(-z)).toBeCloseTo(1, 12);
    }
    expect(standardNormalCdf(-1)).toBeLessThan(standardNormalCdf(0));
    expect(standardNormalCdf(0)).toBeLessThan(standardNormalCdf(1));
  });

  it("erfc matches known values", () => {
    expect(Math.abs(erfc(0) - 1)).toBeLessThan(FIT_TOLERANCE);
    expect(
      Math.abs(erfc(1) - 0.15729920705028513) / 0.15729920705028513,
    ).toBeLessThan(FIT_TOLERANCE);
    expect(
      Math.abs(erfc(-1) - 1.8427007929497148) / 1.8427007929497148,
    ).toBeLessThan(FIT_TOLERANCE);
  });
});

describe("ksTwoSample", () => {
  it("reports no distance and no significance for identical samples", () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = ksTwoSample(sample, [...sample]);
    expect(result.d).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it("reports full separation for disjoint samples, with the asymptotic p", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const result = ksTwoSample(a, b);
    expect(result.d).toBe(1);
    // Hand computed: ne = 10*10/20 = 5, lambda = (sqrt(5) + 0.12 + 0.11/sqrt(5)) * 1
    // = 2.4052614..., Q = 2 * exp(-2 * lambda^2) to the first term
    // = 2 * exp(-11.570565...) = 1.8915e-5. Later terms are below 1e-20.
    expect(result.pValue).toBeGreaterThan(1.88e-5);
    expect(result.pValue).toBeLessThan(1.9e-5);
  });

  it("handles ties without inventing a step", () => {
    const constant = [5, 5, 5, 5, 5, 5];
    const result = ksTwoSample(constant, [...constant]);
    expect(result.d).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it("measures a one sided tail correctly", () => {
    // F_a - F_b peaks at x = 2: 2/3 versus 1.
    const result = ksTwoSample([1, 2, 3], [2]);
    expect(result.d).toBeCloseTo(1 / 3, 12);
  });

  it("cannot test an empty sample and says so instead of guessing", () => {
    expect(ksTwoSample([], [1, 2, 3])).toEqual({ d: 0, pValue: 1 });
    expect(ksTwoSample([1, 2, 3], [])).toEqual({ d: 0, pValue: 1 });
  });

  it("drops non finite values rather than propagating NaN", () => {
    const result = ksTwoSample(
      [1, 2, Number.NaN, 3, Number.POSITIVE_INFINITY],
      [1, 2, 3],
    );
    expect(result.d).toBe(0);
    expect(Number.isFinite(result.pValue)).toBe(true);
  });
});

describe("benjaminiHochberg", () => {
  /**
   * Hand computed, m = 6, q = 0.05, thresholds i/m*q for 1 based rank i:
   *
   *   rank 1 -> 0.05/6      = 0.00833333
   *   rank 2 -> 0.10/6      = 0.01666667
   *   rank 3 -> 0.15/6      = 0.025
   *   rank 4 -> 0.20/6      = 0.03333333
   *   rank 5 -> 0.25/6      = 0.04166667
   *   rank 6 -> 0.30/6      = 0.05
   *
   * Ascending p values against those thresholds:
   *
   *   rank 1  p=0.001  <= 0.00833333  PASS
   *   rank 2  p=0.008  <= 0.01666667  PASS
   *   rank 3  p=0.030  >  0.025       fail
   *   rank 4  p=0.039  >  0.03333333  fail
   *   rank 5  p=0.041  <= 0.04166667  PASS   <- last passing rank
   *   rank 6  p=0.600  >  0.05        fail
   *
   * The step up rule rejects everything up to and including the LAST passing
   * rank, so ranks 3 and 4 are rejected too even though each fails its own
   * threshold. Testing ranks independently would reject only 2 of 6 and be
   * strictly more conservative than Benjamini-Hochberg.
   */
  const P_VALUES = [0.6, 0.008, 0.041, 0.001, 0.039, 0.03];

  it("applies the step up rule to a hand computed vector", () => {
    const result = benjaminiHochberg(P_VALUES, 0.05);
    expect(result.cutoffRank).toBe(5);
    expect(result.rejected).toEqual([false, true, true, true, true, true]);
  });

  it("reports each p value's threshold at its own rank, in input order", () => {
    const result = benjaminiHochberg(P_VALUES, 0.05);
    const expected = [
      0.05, // p=0.600 is rank 6
      0.1 / 6, // p=0.008 is rank 2
      0.25 / 6, // p=0.041 is rank 5
      0.05 / 6, // p=0.001 is rank 1
      0.2 / 6, // p=0.039 is rank 4
      0.15 / 6, // p=0.030 is rank 3
    ];
    for (let i = 0; i < expected.length; i += 1) {
      expect(result.thresholds[i]).toBeCloseTo(expected[i] as number, 12);
    }
  });

  it("rejects nothing when the smallest p value misses rank 1", () => {
    // Same vector, q = 0.005: rank 1 threshold is 0.000833 and p=0.001 misses
    // it; every later rank misses too.
    const result = benjaminiHochberg(P_VALUES, 0.005);
    expect(result.cutoffRank).toBe(0);
    expect(result.rejected).toEqual([false, false, false, false, false, false]);
  });

  it("rejects everything when every p value clears its threshold", () => {
    const result = benjaminiHochberg([0, 0, 0, 0], 0.05);
    expect(result.cutoffRank).toBe(4);
    expect(result.rejected).toEqual([true, true, true, true]);
  });

  it("returns an empty result for no tests", () => {
    expect(benjaminiHochberg([], 0.05)).toEqual({
      rejected: [],
      thresholds: [],
      cutoffRank: 0,
    });
  });

  it("treats a non finite p value as 1 and never rejects it", () => {
    const result = benjaminiHochberg([0.001, Number.NaN], 0.05);
    expect(result.rejected).toEqual([true, false]);
  });

  it("rejects nothing when q is zero or negative", () => {
    expect(benjaminiHochberg([0, 0.001], 0).cutoffRank).toBe(0);
    expect(benjaminiHochberg([0, 0.001], -1).rejected).toEqual([false, false]);
  });
});
