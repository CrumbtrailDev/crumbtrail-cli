import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function nav(t: number, to: string): BugEvent {
  return { t, k: "nav", d: { to, tr: "push" } } as unknown as BugEvent;
}

function gauge(
  t: number,
  total: number,
  url: string,
  byType?: Array<[string, number]>,
): BugEvent {
  return {
    t,
    k: "ui.listeners",
    d: { total, url, ...(byType ? { byType } : {}) },
  } as unknown as BugEvent;
}

function candidatesFor(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (candidate) => candidate.detector === "listener_growth",
  );
}

/** Three navigations, each with a settled listener gauge. */
function walk(totals: number[]): BugEvent[] {
  return totals.flatMap((total, i) => [
    nav(1_000 * (i + 1), `/page-${i + 1}`),
    gauge(1_000 * (i + 1) + 100, total, `/page-${i + 1}`, [
      ["click", total - 4],
      ["resize", 4],
    ]),
  ]);
}

describe("listener_growth", () => {
  it("names listeners that climb across navigations and never come back down", () => {
    const [candidate] = candidatesFor(walk([20, 60, 110]));
    expect(candidate).toBeDefined();
    expect(candidate.title).toContain(
      "grew from 20 to 110 across 3 navigations",
    );
    expect(candidate.severity).toBe("medium");
  });

  it("references the first and the last gauge", () => {
    const [candidate] = candidatesFor(walk([20, 60, 110]));
    expect(candidate.anchor.message).toContain("First gauge: 20 listeners");
    expect(candidate.anchor.message).toContain("Last gauge: 110 listeners");
    expect(candidate.anchor.message).toContain("/page-1");
    expect(candidate.anchor.message).toContain("/page-3");
    expect(candidate.anchor.message).toContain("click +90");
  });

  it("needs at least three navigations to call growth a trend", () => {
    expect(candidatesFor(walk([20, 110]))).toHaveLength(0);
  });

  it("stays silent when the count ever shrinks, because cleanup runs somewhere", () => {
    expect(candidatesFor(walk([20, 200, 110]))).toHaveLength(0);
  });

  it("stays silent below the absolute floor", () => {
    // 4 → 12 triples, but eight listeners is not a leak.
    expect(candidatesFor(walk([4, 8, 12]))).toHaveLength(0);
  });

  it("stays silent below the cumulative ratio", () => {
    // +40 absolute, but only a 1.4x rise across the whole walk.
    expect(candidatesFor(walk([100, 120, 140]))).toHaveLength(0);
  });

  it("treats two gauges on one page as one observation", () => {
    const events = [
      nav(1_000, "/a"),
      gauge(1_100, 20, "/a"),
      gauge(1_200, 60, "/a"),
      nav(2_000, "/b"),
      gauge(2_100, 110, "/b"),
    ];
    // Only two navigation epochs are represented, so this is not yet a trend.
    expect(candidatesFor(events)).toHaveLength(0);
  });
});
