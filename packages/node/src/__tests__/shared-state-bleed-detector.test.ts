import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function req(
  t: number,
  requestId: string,
  method: string,
  url: string,
  body?: unknown,
): BugEvent {
  return {
    t,
    k: "net.req",
    d: { requestId, m: method, url, ...(body === undefined ? {} : { body }) },
  } as BugEvent;
}

function res(
  t: number,
  requestId: string,
  data: unknown,
  st = 200,
): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      requestId,
      st,
      dur: 8,
      body: { ct: "json", bytes: 128, truncated: false, data },
    },
  } as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

/** An earlier write to the same API area, which is what makes the URL stateful. */
const priorWrite = [
  req(10, "seed", "POST", "/api/cart/items", { productId: 1 }),
  res(15, "seed", { ok: true }),
];

describe("shared_state_bleed", () => {
  it("names two identical reads that disagree with no write between them", () => {
    const found = detectors([
      ...priorWrite,
      req(100, "r1", "GET", "/api/cart"),
      res(110, "r1", [{ id: 1 }]),
      req(200, "r2", "GET", "/api/cart"),
      res(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).toContain("shared_state_bleed");
  });

  it("names the contradiction plainly", () => {
    const candidate = buildEvidenceCandidates(
      [
        ...priorWrite,
        req(100, "r1", "GET", "/api/cart"),
        res(110, "r1", [{ id: 1 }]),
        req(200, "r2", "GET", "/api/cart"),
        res(210, "r2", [{ id: 1 }, { id: 2 }]),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "shared_state_bleed");
    expect(candidate?.title).toBe(
      "Server state changed between two identical reads this session never wrote to",
    );
    expect(candidate?.severity).toBe("high");
    expect(candidate?.anchor.message).toContain("returned 1 then 2 items");
  });

  it("stays silent when this session wrote between the two reads", () => {
    const found = detectors([
      ...priorWrite,
      req(100, "r1", "GET", "/api/cart"),
      res(110, "r1", [{ id: 1 }]),
      req(150, "w1", "POST", "/api/cart/items", { productId: 2 }),
      res(160, "w1", { ok: true }),
      req(200, "r2", "GET", "/api/cart"),
      res(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("stays silent on a read-only dashboard that never wrote to the area", () => {
    // No prior mutation to this API root, so a growing live feed is just a feed.
    const found = detectors([
      req(100, "r1", "GET", "/api/metrics"),
      res(110, "r1", [{ id: 1 }]),
      req(200, "r2", "GET", "/api/metrics"),
      res(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("stays silent when the two reads agree", () => {
    const found = detectors([
      ...priorWrite,
      req(100, "r1", "GET", "/api/cart"),
      res(110, "r1", [{ id: 1 }, { id: 2 }]),
      req(200, "r2", "GET", "/api/cart"),
      res(210, "r2", [{ id: 2 }, { id: 1 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("fires when the item set changed without the count changing", () => {
    const found = detectors([
      ...priorWrite,
      req(100, "r1", "GET", "/api/cart"),
      res(110, "r1", [{ id: 1 }, { id: 2 }]),
      req(200, "r2", "GET", "/api/cart"),
      res(210, "r2", [{ id: 1 }, { id: 9 }]),
    ]);
    expect(found).toContain("shared_state_bleed");
  });

  it("only compares reads of the identical URL", () => {
    const found = detectors([
      ...priorWrite,
      req(100, "r1", "GET", "/api/cart?view=compact"),
      res(110, "r1", [{ id: 1 }]),
      req(200, "r2", "GET", "/api/cart?view=full"),
      res(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("stays silent when a response body cannot be read", () => {
    const found = detectors([
      ...priorWrite,
      req(100, "r1", "GET", "/api/cart"),
      { t: 110, k: "net.res", d: { requestId: "r1", st: 200 } } as BugEvent,
      req(200, "r2", "GET", "/api/cart"),
      res(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });
});
