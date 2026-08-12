import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * A monotone live count is produced by two different histories: registrations
 * that are never removed, and registrations that outpace removals. The finding
 * a reader is handed must therefore report what the census recorded, not assert
 * which of the two happened — and when the census recorded no churn at all, the
 * absence must read as unknown, never as zero removals.
 */

function nav(t: number, to: string): BugEvent {
  return { t, k: "nav", d: { to, tr: "push" } } as unknown as BugEvent;
}

function gauge(
  t: number,
  total: number,
  url: string,
  byType: Array<[string, number]>,
  churnByType?: Array<[string, number, number]>,
): BugEvent {
  return {
    t,
    k: "ui.listeners",
    d: { total, url, byType, ...(churnByType ? { churnByType } : {}) },
  } as unknown as BugEvent;
}

function staircaseFor(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 })
    .filter((candidate) => candidate.detector === "listener_growth")
    .find((candidate) => candidate.title.includes('"message"'));
}

/**
 * Arrivals at "/" whose "message" count follows `live`, optionally carrying the
 * cumulative churn counters `churn` — one `[added, removed]` pair per reading.
 */
function walk(live: number[], churn?: Array<[number, number]>): BugEvent[] {
  return live.flatMap((count, i) => [
    nav(1_000 * (i + 1), "/"),
    nav(1_000 * (i + 1) + 10, "/other"),
    gauge(
      1_000 * (i + 1) + 100,
      count + 10,
      "/",
      [
        ["message", count],
        ["click", 10],
      ],
      churn
        ? [
            ["message", churn[i][0], churn[i][1]],
            ["click", 10, 0],
          ]
        : undefined,
    ),
  ]);
}

describe("listener staircase reports observed churn instead of an assumed mechanism", () => {
  it("reports the registrations and removals the census actually recorded", () => {
    // Live 1 → 5, produced by 9 registrations against 4 removals.
    const found = staircaseFor(
      walk(
        [1, 2, 3, 4, 5],
        [
          [1, 0],
          [3, 1],
          [5, 2],
          [7, 3],
          [9, 4],
        ],
      ),
    );
    expect(found).toBeDefined();
    const message = String(found?.anchor?.message);
    expect(message).toContain("1 → 5");
    expect(message).toContain("8 registration");
    expect(message).toContain("4 removal");
    // Removals WERE recorded here, so nothing may claim cleanup never ran.
    expect(message).not.toMatch(/no cleanup/i);
    expect(message).not.toMatch(/never .*(clean|removed)/i);
  });

  it("says plainly that no removal was recorded when the count is a true zero", () => {
    const found = staircaseFor(
      walk(
        [1, 2, 3, 4, 5],
        [
          [1, 0],
          [2, 0],
          [3, 0],
          [4, 0],
          [5, 0],
        ],
      ),
    );
    const message = String(found?.anchor?.message);
    expect(message).toContain("4 registration");
    expect(message).toContain("0 removal");
    expect(message).toContain("No removal");
  });

  it("does not assert a mechanism when the capture carries no churn at all", () => {
    const found = staircaseFor(walk([1, 2, 3, 4, 5]));
    expect(found).toBeDefined();
    const message = String(found?.anchor?.message);
    // The live-count evidence survives.
    expect(message).toContain("1 → 5");
    expect(message).toContain("never decreased");
    // The unobserved mechanism does not.
    expect(message).not.toMatch(/with no cleanup on unmount/i);
    // And absence must read as unknown, never as zero removals.
    expect(message).not.toContain("0 removal");
    expect(message).not.toMatch(/no removal was recorded/i);
    expect(message).toMatch(/not observed|records the live count only/i);
  });

  it("degrades to the unknown wording when only some readings carry churn", () => {
    const events = walk(
      [1, 2, 3, 4, 5],
      [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
        [5, 0],
      ],
    );
    // Strip churn from the first reading only: the span is no longer measurable.
    const firstGauge = events.find((event) => event.k === "ui.listeners");
    delete (firstGauge as unknown as { d: Record<string, unknown> }).d
      .churnByType;

    const message = String(staircaseFor(events)?.anchor?.message);
    expect(message).toMatch(/not observed|records the live count only/i);
    expect(message).not.toContain("0 removal");
  });
});
