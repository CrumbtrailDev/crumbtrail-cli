import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { jsonResponse, opaqueResponse, request } from "./fixtures/net-res";

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

/** An earlier write to the same API area, which is what makes the URL stateful. */
const priorWrite = [
  request(10, "seed", "POST", "/api/cart/items", { productId: 1 }),
  jsonResponse(15, "seed", { ok: true }),
];

describe("shared_state_bleed", () => {
  it("names two identical reads that disagree with no write between them", () => {
    const found = detectors([
      ...priorWrite,
      request(100, "r1", "GET", "/api/cart"),
      jsonResponse(110, "r1", [{ id: 1 }]),
      request(200, "r2", "GET", "/api/cart"),
      jsonResponse(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).toContain("shared_state_bleed");
  });

  it("names the contradiction plainly", () => {
    const candidate = buildEvidenceCandidates(
      [
        ...priorWrite,
        request(100, "r1", "GET", "/api/cart"),
        jsonResponse(110, "r1", [{ id: 1 }]),
        request(200, "r2", "GET", "/api/cart"),
        jsonResponse(210, "r2", [{ id: 1 }, { id: 2 }]),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "shared_state_bleed");
    expect(candidate?.title).toBe(
      "Server state changed between two identical reads this session never wrote to",
    );
    expect(candidate?.severity).toBe("high");
    expect(candidate?.anchor.message).toContain("returned 1 then 2 items");
  });

  it("reads the true count of a capped array from arrayTotal.$", () => {
    // Both reads capture 20 items; only the recorded true lengths differ.
    const before = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const after = Array.from({ length: 31 }, (_, i) => ({ id: i + 1 }));
    const candidate = buildEvidenceCandidates(
      [
        ...priorWrite,
        request(100, "r1", "GET", "/api/cart"),
        jsonResponse(110, "r1", before),
        request(200, "r2", "GET", "/api/cart"),
        jsonResponse(210, "r2", after),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "shared_state_bleed");
    expect(candidate?.anchor.message).toContain("returned 25 then 31 items");
  });

  it("stays silent when this session wrote between the two reads", () => {
    const found = detectors([
      ...priorWrite,
      request(100, "r1", "GET", "/api/cart"),
      jsonResponse(110, "r1", [{ id: 1 }]),
      request(150, "w1", "POST", "/api/cart/items", { productId: 2 }),
      jsonResponse(160, "w1", { ok: true }),
      request(200, "r2", "GET", "/api/cart"),
      jsonResponse(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("stays silent on a read-only dashboard that never wrote to the area", () => {
    // No prior mutation to this API root, so a growing live feed is just a feed.
    const found = detectors([
      request(100, "r1", "GET", "/api/metrics"),
      jsonResponse(110, "r1", [{ id: 1 }]),
      request(200, "r2", "GET", "/api/metrics"),
      jsonResponse(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("stays silent when the two reads agree", () => {
    const found = detectors([
      ...priorWrite,
      request(100, "r1", "GET", "/api/cart"),
      jsonResponse(110, "r1", [{ id: 1 }, { id: 2 }]),
      request(200, "r2", "GET", "/api/cart"),
      jsonResponse(210, "r2", [{ id: 2 }, { id: 1 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("fires when the item set changed without the count changing", () => {
    const found = detectors([
      ...priorWrite,
      request(100, "r1", "GET", "/api/cart"),
      jsonResponse(110, "r1", [{ id: 1 }, { id: 2 }]),
      request(200, "r2", "GET", "/api/cart"),
      jsonResponse(210, "r2", [{ id: 1 }, { id: 9 }]),
    ]);
    expect(found).toContain("shared_state_bleed");
  });

  it("will not compare item sets across capped arrays, which share a prefix", () => {
    // Same true length, first twenty entries identical, tails unknown. Nothing
    // has been established, so nothing is claimed.
    const before = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const after = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const found = detectors([
      ...priorWrite,
      request(100, "r1", "GET", "/api/cart"),
      jsonResponse(110, "r1", before),
      request(200, "r2", "GET", "/api/cart"),
      jsonResponse(210, "r2", after),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("only compares reads of the identical URL", () => {
    const found = detectors([
      ...priorWrite,
      request(100, "r1", "GET", "/api/cart?view=compact"),
      jsonResponse(110, "r1", [{ id: 1 }]),
      request(200, "r2", "GET", "/api/cart?view=full"),
      jsonResponse(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });

  it("stays silent when a response body cannot be parsed", () => {
    const found = detectors([
      ...priorWrite,
      request(100, "r1", "GET", "/api/cart"),
      opaqueResponse(110, "r1"),
      request(200, "r2", "GET", "/api/cart"),
      jsonResponse(210, "r2", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("shared_state_bleed");
  });
});
