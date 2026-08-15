import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, summarizeVitals } from "../llm-bundle";

/**
 * The cross-repo contract this checkpoint closes.
 *
 * The cloud reads a `vitals` object at the top level of `index.json` and
 * `llm.json`, keyed by exactly `lcp | cls | inp | ttfb | fcp`. The collector
 * does not emit those names: it emits `k:'perf'` events whose `d.metric` is
 * `lcp.final`, `cls.score`, `inp`, `ttfb` or `fcp`, alongside a raw per-entry
 * `lcp` / `cls` stream that is deliberately NOT the answer. These tests hold
 * the mapping, the omission rules, and — the one that a wrong implementation
 * would still pass without — that the aggregation reads `lcp.final` rather than
 * the last raw candidate.
 */

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function perf(metric: string, d: Record<string, unknown>, t = 2_000): BugEvent {
  return { t, k: "perf", d: { metric, ...d } } as unknown as BugEvent;
}

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-vitals-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index: { id: "s1", start: 1_000, end: 6_000, dur: 5_000 },
    candidates: [],
  } as never);
}

/** One of each, as a healthy session would produce them. */
const ALL_FIVE: BugEvent[] = [
  perf("ttfb", { value: 210, domContentLoadedEventEnd: 640 }, 1_100),
  perf("fcp", { value: 812.5 }, 1_200),
  perf(
    "inp",
    { value: 240, eventType: "pointerdown", interactionCount: 12 },
    5_000,
  ),
  perf("cls.score", { value: 0.18, shiftCount: 4 }, 5_900),
  perf("lcp.final", { value: 1_900, size: 40_000, element: "IMG" }, 5_900),
];

describe("summarizeVitals", () => {
  it("maps every collector metric name onto its canonical key", () => {
    expect(summarizeVitals(ALL_FIVE)).toEqual({
      ttfb: { value: 210, rating: "good" },
      fcp: { value: 812.5, rating: "good" },
      inp: { value: 240, rating: "needs_improvement" },
      cls: { value: 0.18, rating: "needs_improvement" },
      lcp: { value: 1_900, rating: "good" },
    });
  });

  it("aggregates lcp from lcp.final, not from the last raw candidate", () => {
    // The collector emits a stream of ever-larger raw `lcp` candidates AND a
    // single frozen `lcp.final`. Here they disagree, and the raw stream's last
    // member arrives LAST in the event order, so an implementation that takes
    // "the newest lcp-ish event" reads 3_400 and reports a poor LCP for a page
    // whose real LCP was good. Same shape for cls.
    const events: BugEvent[] = [
      perf("lcp", { value: 900, size: 10_000 }, 1_500),
      perf("cls", { value: 0.02 }, 1_600),
      perf("lcp.final", { value: 1_900, size: 40_000 }, 5_900),
      perf("cls.score", { value: 0.18, shiftCount: 4 }, 5_900),
      perf("lcp", { value: 3_400, size: 90_000 }, 6_000),
      perf("cls", { value: 0.31 }, 6_100),
    ];

    expect(summarizeVitals(events)).toEqual({
      lcp: { value: 1_900, rating: "good" },
      cls: { value: 0.18, rating: "needs_improvement" },
    });
  });

  it("omits the metrics whose score event never arrived", () => {
    // A session ended through `Crumbtrail.stop()` can lose the final batch, so a
    // partial reading is a normal shippable state. The absent metrics must be
    // absent keys, not null and not zero: zero is a real CLS score.
    const vitals = summarizeVitals([
      perf("ttfb", { value: 900 }, 1_100),
      perf("fcp", { value: 3_500 }, 1_200),
    ]);

    expect(vitals).toEqual({
      ttfb: { value: 900, rating: "needs_improvement" },
      fcp: { value: 3_500, rating: "poor" },
    });
    expect(Object.keys(vitals ?? {}).sort()).toEqual(["fcp", "ttfb"]);
    expect("lcp" in (vitals ?? {})).toBe(false);
    expect("cls" in (vitals ?? {})).toBe(false);
    expect("inp" in (vitals ?? {})).toBe(false);
  });

  it("returns undefined when no score event was captured at all", () => {
    // Raw candidates alone are not a score. Nothing finalized, nothing reported.
    expect(summarizeVitals([])).toBeUndefined();
    expect(
      summarizeVitals([
        perf("lcp", { value: 900 }),
        perf("cls", { value: 0.02 }),
        perf("resource", { value: 12 }),
        { t: 1, k: "clk", d: { metric: "lcp.final", value: 1 } } as never,
      ]),
    ).toBeUndefined();
  });

  it("drops metric names outside the canonical five, and unusable values", () => {
    expect(
      summarizeVitals([
        perf("longtask", { value: 120 }),
        perf("fid", { value: 30 }),
        perf("lcp.final", { value: "1900" }),
        perf("cls.score", { value: Number.NaN }),
        perf("inp", {}),
        perf("ttfb", { value: 210 }),
      ]),
    ).toEqual({ ttfb: { value: 210, rating: "good" } });
  });

  it("rates each metric on its own thresholds, boundaries included", () => {
    const good = summarizeVitals([
      perf("lcp.final", { value: 2_500 }),
      perf("cls.score", { value: 0.1 }),
      perf("inp", { value: 200 }),
      perf("ttfb", { value: 800 }),
      perf("fcp", { value: 1_800 }),
    ]);
    for (const metric of Object.values(good ?? {})) {
      expect(metric.rating).toBe("good");
    }

    const poor = summarizeVitals([
      perf("lcp.final", { value: 4_001 }),
      perf("cls.score", { value: 0.26 }),
      perf("inp", { value: 501 }),
      perf("ttfb", { value: 1_801 }),
      perf("fcp", { value: 3_001 }),
    ]);
    for (const metric of Object.values(poor ?? {})) {
      expect(metric.rating).toBe("poor");
    }
  });
});

describe("llm.json vitals", () => {
  it("carries the vitals object at the top level of the bundle", () => {
    const bundle = bundleFor(ALL_FIVE);
    expect(bundle.vitals).toEqual({
      ttfb: { value: 210, rating: "good" },
      fcp: { value: 812.5, rating: "good" },
      inp: { value: 240, rating: "needs_improvement" },
      cls: { value: 0.18, rating: "needs_improvement" },
      lcp: { value: 1_900, rating: "good" },
    });

    // The cloud reads the serialized artifact, not the in-memory object.
    const written = JSON.parse(JSON.stringify(bundle));
    expect(written.vitals.lcp.value).toBe(1_900);
    expect(written.vitals.cls.rating).toBe("needs_improvement");
  });

  it("omits the vitals key entirely when the session finalized nothing", () => {
    const bundle = bundleFor([perf("lcp", { value: 900 })]);
    expect("vitals" in bundle).toBe(false);
    expect(JSON.parse(JSON.stringify(bundle)).vitals).toBeUndefined();
  });
});
