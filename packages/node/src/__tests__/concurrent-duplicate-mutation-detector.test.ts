import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function req(
  requestId: string,
  t: number,
  url: string,
  body: unknown,
  method = "POST",
): BugEvent {
  return {
    t,
    k: "net.req",
    d: { id: requestId, requestId, url, method, body },
  } as unknown as BugEvent;
}

function res(
  requestId: string,
  t: number,
  st = 200,
  body?: unknown,
): BugEvent {
  return {
    t,
    k: "net.res",
    d: { id: requestId, requestId, st, body },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map((c) => c.detector);
}

function candidate(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).find(
    (c) => c.detector === "concurrent_duplicate_mutation",
  );
}

/** Two identical add-to-cart POSTs in flight together; both succeed, and the
 * later response shows the duplicated line the race produced. */
const RACED_ADDS = [
  req("a", 100, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
  req("b", 101, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
  res("a", 140, 200, '{"items":[{"productId":5,"qty":1}]}'),
  res(
    "b",
    141,
    200,
    '{"items":[{"productId":5,"qty":1},{"productId":5,"qty":1}]}',
  ),
];

describe("concurrent_duplicate_mutation", () => {
  it("names two identical mutations whose lifetimes overlapped", () => {
    const found = candidate(RACED_ADDS);
    expect(found).toBeDefined();
    expect(String(found?.anchor?.message)).toContain("2 identical POST");
    expect(String(found?.anchor?.message)).toContain(
      "different resulting states",
    );
  });

  it("stays silent on a sequential retry of the same mutation", () => {
    // A retry after the first call answered is the client behaving normally,
    // not a race — even with an identical body.
    const events = [
      req("a", 100, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
      res("a", 140, 200, "{}"),
      req("b", 200, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
      res("b", 240, 200, "{}"),
    ];
    expect(detectors(events)).not.toContain("concurrent_duplicate_mutation");
  });

  it("stays silent when the overlapping bodies differ", () => {
    const events = [
      req("a", 100, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
      req("b", 101, "http://x/api/cart/items", '{"productId":7,"qty":1}'),
      res("a", 140, 200, "{}"),
      res("b", 141, 200, "{}"),
    ];
    expect(detectors(events)).not.toContain("concurrent_duplicate_mutation");
  });

  it("stays silent when either copy failed — the error detectors own that pair", () => {
    const events = [
      req("a", 100, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
      req("b", 101, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
      res("a", 140, 500, "{}"),
      res("b", 141, 200, "{}"),
    ];
    expect(detectors(events)).not.toContain("concurrent_duplicate_mutation");
  });

  it("skips redacted bodies rather than treating them as equal", () => {
    // Two different payloads redacted to the same marker must not read as one
    // duplicated mutation.
    const events = [
      req("a", 100, "http://x/api/cart/items", '{"productId":"[REDACTED]"}'),
      req("b", 101, "http://x/api/cart/items", '{"productId":"[REDACTED]"}'),
      res("a", 140, 200, "{}"),
      res("b", 141, 200, "{}"),
    ];
    expect(detectors(events)).not.toContain("concurrent_duplicate_mutation");
  });

  it("emits one candidate for a burst, carrying the copy count", () => {
    const events = [
      req("a", 100, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
      req("b", 101, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
      req("c", 102, "http://x/api/cart/items", '{"productId":5,"qty":1}'),
      res("a", 140, 200, "{}"),
      res("b", 141, 200, "{}"),
      res("c", 142, 200, "{}"),
    ];
    const all = buildEvidenceCandidates(events, { start: 0 }).filter(
      (c) => c.detector === "concurrent_duplicate_mutation",
    );
    expect(all).toHaveLength(1);
    expect(String(all[0]?.anchor?.message)).toContain("3 identical POST");
  });

  it("ignores non-mutating methods entirely", () => {
    const events = [
      req("a", 100, "http://x/api/cart", '{"q":1}', "GET"),
      req("b", 101, "http://x/api/cart", '{"q":1}', "GET"),
      res("a", 140, 200, "{}"),
      res("b", 141, 200, "{}"),
    ];
    expect(detectors(events)).not.toContain("concurrent_duplicate_mutation");
  });
});
