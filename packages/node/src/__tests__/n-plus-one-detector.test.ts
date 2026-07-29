import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function read(
  t: number,
  stmt: number | undefined,
  table = "product_ratings",
  requestId = "req-a",
): BugEvent {
  return {
    t,
    k: "db.read",
    d: {
      engine: "postgres",
      table,
      pk: { id: stmt ?? 1 },
      row: { rating: 5 },
      requestId,
      ...(stmt === undefined ? {} : { stmt }),
    },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("n_plus_one_query", () => {
  it("names a request that ran one SELECT per row", () => {
    const events = Array.from({ length: 12 }, (_, i) => read(10 + i, i + 1));
    expect(detectors(events)).toContain("n_plus_one_query");
  });

  it("stays silent on one SELECT that returned many rows", () => {
    // Same event count, same table, same request — only the statement ordinal
    // differs, which is the entire point of capturing it.
    const events = Array.from({ length: 12 }, (_, i) => read(10 + i, 1));
    expect(detectors(events)).not.toContain("n_plus_one_query");
  });

  it("stays below the threshold for an ordinary handful of queries", () => {
    const events = Array.from({ length: 5 }, (_, i) => read(10 + i, i + 1));
    expect(detectors(events)).not.toContain("n_plus_one_query");
  });

  it("counts per table, not across the whole request", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => read(10 + i, i + 1, "products")),
      ...Array.from({ length: 5 }, (_, i) => read(20 + i, i + 6, "reviews")),
    ];
    expect(detectors(events)).not.toContain("n_plus_one_query");
  });

  it("counts per request, not across the session", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) =>
        read(10 + i, i + 1, "products", "req-a"),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        read(20 + i, i + 1, "products", "req-b"),
      ),
    ];
    expect(detectors(events)).not.toContain("n_plus_one_query");
  });

  it("cannot run without statement ordinals", () => {
    const events = Array.from({ length: 12 }, (_, i) => read(10 + i, undefined));
    expect(detectors(events)).not.toContain("n_plus_one_query");
  });

  it("reports the statement count in the title", () => {
    const events = Array.from({ length: 30 }, (_, i) => read(10 + i, i + 1));
    const candidate = buildEvidenceCandidates(events, { start: 0 }).find(
      (c) => c.detector === "n_plus_one_query",
    );
    expect(candidate?.title).toContain("30 separate SELECTs");
  });

  it("collapses the same pattern across requests into one candidate", () => {
    // An export that pages through four screens runs the identical missing-JOIN
    // path four times. Four copies of one finding would fill the whole top of
    // the ranking; the reader needs one candidate that says it recurred.
    const events = ["req-a", "req-b", "req-c", "req-d"].flatMap((rid, r) =>
      Array.from({ length: 12 + r }, (_, i) =>
        read(100 * r + i, i + 1, "order_items", rid),
      ),
    );
    const hits = buildEvidenceCandidates(events, { start: 0 }).filter(
      (c) => c.detector === "n_plus_one_query",
    );
    expect(hits).toHaveLength(1);
    // Anchored on the worst request, with the recurrence stated.
    expect(hits[0].title).toContain("15 separate SELECTs");
    expect(hits[0].anchor.requestId).toBe("req-d");
    expect(String(hits[0].anchor.message)).toContain("4 requests");
  });

  it("keeps distinct tables as distinct candidates", () => {
    const events = [
      ...Array.from({ length: 12 }, (_, i) => read(10 + i, i + 1, "order_items", "req-a")),
      ...Array.from({ length: 12 }, (_, i) => read(30 + i, i + 1, "reviews", "req-a")),
    ];
    const hits = buildEvidenceCandidates(events, { start: 0 }).filter(
      (c) => c.detector === "n_plus_one_query",
    );
    expect(hits.map((h) => h.title).sort()).toEqual([
      "N+1 query: one request ran 12 separate SELECTs against order_items",
      "N+1 query: one request ran 12 separate SELECTs against reviews",
    ]);
  });
});
