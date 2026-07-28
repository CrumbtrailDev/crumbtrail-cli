import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function request(
  t: number,
  url: string,
  requestId = "req-a",
  method = "GET",
): BugEvent {
  return { t, k: "net.req", d: { requestId, m: method, url } } as BugEvent;
}

function response(t: number, requestId = "req-a", st = 200): BugEvent {
  return { t, k: "net.res", d: { requestId, st, dur: 12 } } as BugEvent;
}

function read(
  t: number,
  row: Record<string, unknown>,
  requestId = "req-a",
  table = "products",
): BugEvent {
  return {
    t,
    k: "db.read",
    d: { engine: "postgres", table, pk: { id: row.id ?? 1 }, row, requestId },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("filter_contradiction", () => {
  it("names a row that defies the equality filter the request declared", () => {
    const found = detectors([
      request(10, "/api/products?category=audio"),
      read(20, { id: 1, category: "audio" }),
      read(21, { id: 2, category: "desk" }),
      response(30),
    ]);
    expect(found).toContain("filter_contradiction");
  });

  it("states the contradiction in the title", () => {
    const candidate = buildEvidenceCandidates(
      [
        request(10, "/api/products?category=audio"),
        read(21, { id: 2, category: "desk" }),
        response(30),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "filter_contradiction");
    expect(candidate?.title).toBe(
      "Response rows contradict the request's own filter `category`",
    );
    expect(candidate?.severity).toBe("high");
    expect(candidate?.anchor.comparedColumns).toEqual(["category"]);
  });

  it("reads a boolean availability filter against the stock column", () => {
    const found = detectors([
      request(10, "/api/products?inStock=true"),
      read(20, { id: 7, inventory: 0 }),
      response(30),
    ]);
    expect(found).toContain("filter_contradiction");
  });

  it("stays silent when every read row satisfies the filter", () => {
    const found = detectors([
      request(10, "/api/products?category=audio"),
      read(20, { id: 1, category: "audio" }),
      read(21, { id: 2, category: "audio" }),
      response(30),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("accepts any member of a repeated or comma-listed filter", () => {
    const found = detectors([
      request(10, "/api/products?category=audio,video"),
      read(20, { id: 1, category: "video" }),
      response(30),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("ignores free-text search parameters", () => {
    // `q` is a term the server interprets, not a promise every row equals it.
    const found = detectors([
      request(10, "/api/products?q=audio"),
      read(20, { id: 1, q: "desk" }),
      response(30),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("ignores range bounds", () => {
    const found = detectors([
      request(10, "/api/products?maxPrice=200"),
      read(20, { id: 1, maxPrice: 40 }),
      response(30),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("ignores paging and sorting parameters", () => {
    const found = detectors([
      request(10, "/api/products?sort=name&limit=20"),
      read(20, { id: 1, sort: "price", limit: 3 }),
      response(30),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("stays silent when the row value was redacted away", () => {
    const found = detectors([
      request(10, "/api/products?category=audio"),
      read(20, { id: 1, category: "[REDACTED]" }),
      response(30),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("stays silent when the response was not a 2xx", () => {
    // A failed request's rows prove nothing about what the filter should return.
    const found = detectors([
      request(10, "/api/products?category=audio"),
      read(20, { id: 1, category: "desk" }),
      response(30, "req-a", 500),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("only compares rows read by the request that declared the filter", () => {
    const found = detectors([
      request(10, "/api/products?category=audio", "req-a"),
      response(30, "req-a"),
      // A different request read the contradicting row.
      read(40, { id: 2, category: "desk" }, "req-b"),
      request(35, "/api/other", "req-b"),
      response(45, "req-b"),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("reports one candidate per declared filter, not per row", () => {
    const candidates = buildEvidenceCandidates(
      [
        request(10, "/api/products?category=audio"),
        read(20, { id: 1, category: "desk" }),
        read(21, { id: 2, category: "lamp" }),
        read(22, { id: 3, category: "rug" }),
        response(30),
      ],
      { start: 0 },
    ).filter((entry) => entry.detector === "filter_contradiction");
    expect(candidates).toHaveLength(1);
  });
});
