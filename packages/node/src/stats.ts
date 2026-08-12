/**
 * Small, dependency free statistics used by the window correlation scorers.
 *
 * Everything here is pure: no I/O, no clock, no store.
 */

/* ------------------------------------------------------------------------- *
 * Normal distribution
 *
 * `standardNormalCdf` and `erfc` below are COPIED verbatim (bodies unchanged)
 * from the main product repository, `packages/cloud/src/intent-baseline.ts`
 * lines 834-862, where they back the intent baseline rate tests.
 *
 * They are copied rather than imported because the import is impossible, not
 * merely inconvenient: the dependency arrow runs `packages/cloud` -> published
 * `crumbtrail-node`, never the other way, so nothing in this package can reach
 * into the cloud package. Twenty eight dependency free lines are a cheaper
 * honest duplicate than a new shared package. If the fit is ever corrected
 * there, correct it here too.
 * ------------------------------------------------------------------------- */

/**
 * Standard normal CDF via a Chebyshev fit to erfc (Numerical Recipes `erfcc`),
 * fractional error below 1.2e-7 everywhere. That is far tighter than any
 * threshold this module compares against, and it avoids adding a dependency for
 * one function.
 */
export function standardNormalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

export function erfc(x: number): number {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const tau =
    t *
    Math.exp(
      -x * x -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? tau : 2 - tau;
}

/* ------------------------------------------------------------------------- *
 * Kolmogorov-Smirnov, two sample
 * ------------------------------------------------------------------------- */

export interface KsTwoSampleResult {
  /** Supremum distance between the two empirical CDFs, in [0, 1]. */
  d: number;
  /** Two sided asymptotic p value, in [0, 1]. 1 when the test cannot run. */
  pValue: number;
}

/**
 * Two sample Kolmogorov-Smirnov test.
 *
 * Answers "did these two samples come from the same distribution", which is the
 * question a volume comparison cannot answer: a set of requests can keep the
 * exact same count while every one of them gets four times slower.
 *
 * The p value is the standard asymptotic Kolmogorov distribution,
 * `Q(lambda) = 2 * sum_{j>=1} (-1)^(j-1) * exp(-2 * j^2 * lambda^2)` with the
 * Stephens small sample correction on the effective sample size. It is an
 * approximation and it is only trustworthy once both samples have a handful of
 * points, which is why `correlateWindow` applies a floor before calling it.
 *
 * Non finite values are dropped. Empty or single valued input cannot be tested,
 * and returns `d: 0, pValue: 1` rather than a fabricated verdict.
 */
export function ksTwoSample(a: number[], b: number[]): KsTwoSampleResult {
  const sa = a.filter(Number.isFinite).sort((x, y) => x - y);
  const sb = b.filter(Number.isFinite).sort((x, y) => x - y);
  const n = sa.length;
  const m = sb.length;
  if (n === 0 || m === 0) return { d: 0, pValue: 1 };

  let i = 0;
  let j = 0;
  let fa = 0;
  let fb = 0;
  let d = 0;
  while (i < n && j < m) {
    const va = sa[i] as number;
    const vb = sb[j] as number;
    // Advance every tied observation on the side(s) holding the smaller value
    // before measuring, so repeated values do not produce a phantom step.
    if (va <= vb) {
      const value = va;
      while (i < n && sa[i] === value) {
        i += 1;
        fa = i / n;
      }
    }
    if (vb <= va) {
      const value = vb;
      while (j < m && sb[j] === value) {
        j += 1;
        fb = j / m;
      }
    }
    const gap = Math.abs(fa - fb);
    if (gap > d) d = gap;
  }
  // No trailing correction is needed. The loop only exits once a side is
  // exhausted, and a side is exhausted only by an advance that set its F to 1
  // and was followed by a gap measurement in the same iteration. The remaining
  // mass on the other side can only close that gap, never widen it.

  const ne = (n * m) / (n + m);
  const sqrtNe = Math.sqrt(ne);
  const lambda = (sqrtNe + 0.12 + 0.11 / sqrtNe) * d;
  return { d, pValue: kolmogorovQ(lambda) };
}

/**
 * `Q(lambda)` for the Kolmogorov distribution.
 *
 * The alternating series `2 * sum (-1)^(j-1) exp(-2 j^2 lambda^2)` converges
 * fast for moderate lambda, but its terms barely decay as lambda approaches 0:
 * truncating at any fixed term count leaves a residual the size of the last
 * term, so the sum drifts arbitrarily far from its true value of 1. At
 * lambda = 0.001 a 100 term truncation returns 0.02 — a maximally significant
 * verdict for two distributions that are essentially identical.
 *
 * `Q` is 1 to twelve decimal places for every lambda at or below 0.2, so
 * returning 1 below that cutoff is exact to the precision anything here cares
 * about and removes the divergent regime entirely. Above it the series is fully
 * converged well inside the 100 term budget.
 */
export function kolmogorovQ(lambda: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 1;
  if (lambda < 0.2) return 1;
  let sum = 0;
  for (let j = 1; j <= 100; j += 1) {
    const term =
      2 * (j % 2 === 1 ? 1 : -1) * Math.exp(-2 * j * j * lambda * lambda);
    sum += term;
    if (Math.abs(term) < 1e-12 * Math.abs(sum) || Math.abs(term) < 1e-300)
      break;
  }
  return Math.min(1, Math.max(0, sum));
}

/* ------------------------------------------------------------------------- *
 * Benjamini-Hochberg
 * ------------------------------------------------------------------------- */

export interface BenjaminiHochbergResult {
  /** Per input p value, in input order: did it survive the FDR cut. */
  rejected: boolean[];
  /** Per input p value, in input order: the BH threshold at its own rank. */
  thresholds: number[];
  /** 1 based rank of the last surviving p value. 0 when nothing survives. */
  cutoffRank: number;
}

/**
 * Benjamini-Hochberg false discovery rate control.
 *
 * Written fresh here. The main product inlines the same procedure at
 * `packages/cloud/src/intent-baseline.ts:1041-1060`, but it is not a function
 * there: it mutates domain objects in place, so there was nothing to reuse.
 *
 * The step up rule matters and is easy to get wrong. Sort the `m` p values
 * ascending, give rank `i` (1 based) the threshold `i / m * q`, then find the
 * LARGEST rank whose p value still clears its own threshold and reject
 * everything up to and including it. A p value that fails its own threshold is
 * still rejected when a later, larger one passes; testing each rank
 * independently would silently make the procedure more conservative than BH.
 *
 * Non finite p values are treated as 1 (never rejected) rather than throwing.
 * Callers must not pass tests that never ran: an entry with no p value inflates
 * `m` and weakens every real test for no reason.
 */
export function benjaminiHochberg(
  pValues: number[],
  q: number,
): BenjaminiHochbergResult {
  const m = pValues.length;
  if (m === 0) return { rejected: [], thresholds: [], cutoffRank: 0 };
  if (!Number.isFinite(q) || q <= 0)
    return {
      rejected: new Array<boolean>(m).fill(false),
      thresholds: new Array<number>(m).fill(0),
      cutoffRank: 0,
    };

  const clean = pValues.map((p) =>
    Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1,
  );
  const order = clean
    .map((p, index) => ({ p, index }))
    .sort((x, y) => x.p - y.p || x.index - y.index);

  const thresholds = new Array<number>(m).fill(0);
  let cutoffRank = 0;
  for (let i = 0; i < m; i += 1) {
    const entry = order[i] as { p: number; index: number };
    const threshold = ((i + 1) / m) * q;
    thresholds[entry.index] = threshold;
    if (entry.p <= threshold) cutoffRank = i + 1;
  }

  const rejected = new Array<boolean>(m).fill(false);
  for (let i = 0; i < cutoffRank; i += 1) {
    const entry = order[i] as { p: number; index: number };
    rejected[entry.index] = true;
  }
  return { rejected, thresholds, cutoffRank };
}
