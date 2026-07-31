import type { BugEvent } from "crumbtrail-core";
import { describe, expect, it } from "vitest";
import { buildEvidenceCandidates } from "../evidence-index";
import { groupDistinctBugs } from "../distinct-bugs";

/**
 * One repeating failure, many times over. This is the shape that consumed the
 * candidate cap on a live 19k-event session: 170 of 200 slots went to four
 * repetition detectors on two URLs, and the only candidate naming the real
 * defect fell off the end.
 */
function repeatedFailures(count: number) {
  const start = 1_000_000;
  return Array.from({ length: count }, (_, i) => ({
    t: start + i * 50,
    m: "POST",
    url: "http://localhost:7461/api/claims",
    st: 500,
    id: `req_${i}`,
    reason: "http_error",
  }));
}

function rareCandidateEvents(at: number): BugEvent[] {
  return [
    {
      t: at,
      k: "net.req",
      d: { id: "rare_1", requestId: "rare_1", m: "GET", url: "http://localhost:7461/api/search?q=ward" },
    },
    {
      t: at + 5,
      k: "net.req",
      d: { id: "rare_2", requestId: "rare_2", m: "GET", url: "http://localhost:7461/api/search?q=ward+n" },
    },
    {
      t: at + 40,
      k: "net.res",
      d: { id: "rare_2", requestId: "rare_2", st: 200, body: "{\"q\":\"ward n\"}" },
    },
    {
      t: at + 90,
      k: "net.res",
      d: { id: "rare_1", requestId: "rare_1", st: 200, body: "{\"q\":\"ward\"}" },
    },
  ];
}

describe("candidate cap rations by detector", () => {
  it("keeps a rare detector's finding when one detector floods the list", () => {
    const failures = repeatedFailures(400);
    const events = rareCandidateEvents(1_000_000 + 400 * 50 + 500);
    const candidates = buildEvidenceCandidates(events, {
      start: 999_000,
      failedReqs: failures,
    });

    const detectors = new Set(candidates.map((candidate) => candidate.detector));
    const httpErrors = candidates.filter(
      (candidate) => candidate.detector === "http_error",
    );

    expect(candidates.length).toBeLessThanOrEqual(200);
    expect(httpErrors.length).toBeGreaterThan(0);
    // The guarantee: a detector that fired once is never evicted by a detector
    // that fired four hundred times. Spare room is still filled with the flood —
    // when nothing else is competing, more copies are better than empty slots —
    // so the assertion is about survival, not about the flood's share.
    expect(detectors.has("response_race")).toBe(true);
  });

  it("leaves a list under the cap exactly as it was", () => {
    const candidates = buildEvidenceCandidates([], {
      start: 999_000,
      failedReqs: repeatedFailures(12),
    });
    expect(candidates.filter((c) => c.detector === "http_error").length).toBe(12);
  });
});

describe("distinct bugs fold repeated single-candidate failures", () => {
  it("returns one bug for the same failure on four request ids", () => {
    const candidates = buildEvidenceCandidates([], {
      start: 999_000,
      networkErrors: Array.from({ length: 4 }, (_, i) => ({
        t: 1_000_000 + i,
        method: "GET",
        url: "http://localhost:7461/api/claims/coverage",
        requestId: `net_${i}`,
        message: "Failed to fetch",
      })),
    } as never);

    const bugs = groupDistinctBugs(candidates, []);
    const networkBugs = bugs.filter((bug) =>
      bug.title.includes("Network error"),
    );

    expect(networkBugs).toHaveLength(1);
    expect(networkBugs[0]?.occurrenceCount ?? 1).toBeGreaterThanOrEqual(1);
  });
});
