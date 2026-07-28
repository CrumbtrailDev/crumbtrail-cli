import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { parseLimitOffset } from "../db/sql";

function req(requestId: string, t: number, url: string): BugEvent {
  return {
    t,
    k: "net.req",
    d: { id: requestId, requestId, url, method: "GET" },
  } as unknown as BugEvent;
}

function read(
  requestId: string,
  t: number,
  q?: { limit?: number; offset?: number },
): BugEvent {
  return {
    t,
    k: "db.read",
    d: {
      engine: "postgres",
      table: "products",
      pk: { id: 2 },
      row: { id: 2 },
      requestId,
      ...(q ? { q } : {}),
    },
  } as unknown as BugEvent;
}

function detections(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (c) => c.detector === "pagination_first_page_offset",
  );
}

describe("parseLimitOffset", () => {
  it("resolves literals and Postgres placeholders", () => {
    expect(parseLimitOffset("SELECT * FROM p LIMIT 12 OFFSET 1")).toEqual({
      limit: 12,
      offset: 1,
    });
    expect(
      parseLimitOffset("SELECT * FROM p LIMIT $1 OFFSET $2", [50, 1]),
    ).toEqual({ limit: 50, offset: 1 });
  });

  it("reads the MySQL comma form as offset, count", () => {
    expect(parseLimitOffset("SELECT * FROM p LIMIT 1, 12")).toEqual({
      offset: 1,
      limit: 12,
    });
  });

  it("yields nothing rather than guessing an unresolvable placeholder", () => {
    expect(parseLimitOffset("SELECT * FROM p LIMIT $1 OFFSET $2")).toEqual({});
    expect(parseLimitOffset("SELECT * FROM p")).toEqual({});
  });
});

describe("pagination_first_page_offset", () => {
  it("flags a first-page request whose SELECT skipped a fractional page", () => {
    const events = [
      req("r1", 100, "http://x/api/products"),
      read("r1", 120, { limit: 12, offset: 1 }),
    ];
    const found = detections(events);
    expect(found).toHaveLength(1);
    expect(String(found[0]?.anchor?.message)).toContain("OFFSET 1");
  });

  it("collapses the per-row read events into one finding", () => {
    const events = [
      req("r1", 100, "http://x/api/products?page=1"),
      read("r1", 120, { limit: 12, offset: 1 }),
      read("r1", 121, { limit: 12, offset: 1 }),
      read("r1", 122, { limit: 12, offset: 1 }),
    ];
    expect(detections(events)).toHaveLength(1);
  });

  it("stays silent on a real page 2, where offset equals the limit", () => {
    const events = [
      req("r1", 100, "http://x/api/products?page=2"),
      read("r1", 120, { limit: 12, offset: 12 }),
    ];
    expect(detections(events)).toHaveLength(0);
  });

  it("stays silent on a ranked pick — LIMIT 1 OFFSET 1 is not a page", () => {
    const events = [
      req("r1", 100, "http://x/api/products/runner-up"),
      read("r1", 120, { limit: 1, offset: 1 }),
    ];
    expect(detections(events)).toHaveLength(0);
  });

  it("stays silent when the request paged explicitly past the start", () => {
    const events = [
      req("r1", 100, "http://x/api/products?offset=5"),
      read("r1", 120, { limit: 12, offset: 5 }),
    ];
    expect(detections(events)).toHaveLength(0);
  });

  it("skips cursor-paged requests whose window is not derivable", () => {
    const events = [
      req("r1", 100, "http://x/api/products?cursor=abc"),
      read("r1", 120, { limit: 12, offset: 1 }),
    ];
    expect(detections(events)).toHaveLength(0);
  });

  it("stays silent when the read carries no window at all", () => {
    const events = [
      req("r1", 100, "http://x/api/products"),
      read("r1", 120),
    ];
    expect(detections(events)).toHaveLength(0);
  });
});
