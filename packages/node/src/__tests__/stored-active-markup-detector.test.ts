import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function candidates(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (candidate) => candidate.detector === "stored_active_markup",
  );
}

describe("stored_active_markup", () => {
  it("flags persisted event-handler markup without repeating the payload", () => {
    const [candidate] = candidates([
      {
        t: 100,
        k: "db.diff",
        d: {
          engine: "postgres",
          op: "insert",
          table: "reviews",
          requestId: "req-review",
          after: {
            id: 8,
            body: `<img src=x onerror="fetch('/api/orders')"> great product`,
          },
        },
      },
    ] as unknown as BugEvent[]);

    expect(candidate).toBeDefined();
    expect(candidate.title).toContain("reviews.body");
    expect(JSON.stringify(candidate)).not.toContain("fetch('/api/orders')");
  });

  it("stays silent for ordinary text and inert formatting tags", () => {
    expect(
      candidates([
        {
          t: 100,
          k: "db.diff",
          d: {
            op: "insert",
            table: "reviews",
            after: { body: "<strong>Great product</strong>" },
          },
        },
      ] as unknown as BugEvent[]),
    ).toHaveLength(0);
  });
});
