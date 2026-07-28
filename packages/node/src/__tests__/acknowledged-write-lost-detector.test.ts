import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { jsonResponse, request } from "./fixtures/net-res";

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

const ENDPOINT = "/api/cart/items";

describe("acknowledged_write_lost", () => {
  it("names two acknowledged adds that left one item's worth of quantity", () => {
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", []),
      request(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(110, "w1", { ok: true }),
      request(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(210, "w2", { ok: true }),
      request(300, "r", "GET", ENDPOINT),
      jsonResponse(310, "r", [{ id: 1, productId: 7, qty: 1 }]),
    ]);
    expect(found).toContain("acknowledged_write_lost");
  });

  it("says how many writes were acknowledged and what the read showed", () => {
    const candidate = buildEvidenceCandidates(
      [
        request(10, "b", "GET", ENDPOINT),
        jsonResponse(20, "b", []),
        request(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
        jsonResponse(110, "w1", { ok: true }),
        request(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
        jsonResponse(210, "w2", { ok: true }),
        request(300, "r", "GET", ENDPOINT),
        jsonResponse(310, "r", [{ id: 1, productId: 7, qty: 1 }]),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "acknowledged_write_lost");
    expect(candidate?.title).toBe(
      "2 writes were acknowledged but the collection kept fewer",
    );
    expect(candidate?.severity).toBe("high");
    expect(candidate?.anchor.message).toContain("2 POSTs");
    expect(candidate?.anchor.message).toContain("shows 1");
  });

  it("stays silent when the quantity accounts for both writes", () => {
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", []),
      request(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(110, "w1", { ok: true }),
      request(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(210, "w2", { ok: true }),
      request(300, "r", "GET", ENDPOINT),
      jsonResponse(310, "r", [{ id: 1, productId: 7, qty: 2 }]),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("counts items when the request bodies carry no quantity", () => {
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", [{ id: 1 }]),
      request(100, "w1", "POST", ENDPOINT, { note: "one" }),
      jsonResponse(110, "w1", { ok: true }),
      request(200, "w2", "POST", ENDPOINT, { note: "one" }),
      jsonResponse(210, "w2", { ok: true }),
      request(300, "r", "GET", ENDPOINT),
      jsonResponse(310, "r", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).toContain("acknowledged_write_lost");
  });

  it("counts against the true length of a capped collection", () => {
    // The read captures 20 items but records 24; the two acknowledged adds
    // should have taken a 23-item collection to 25.
    const before = Array.from({ length: 23 }, (_, i) => ({ id: i + 1 }));
    const after = Array.from({ length: 24 }, (_, i) => ({ id: i + 1 }));
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", before),
      request(100, "w1", "POST", ENDPOINT, { note: "one" }),
      jsonResponse(110, "w1", { ok: true }),
      request(200, "w2", "POST", ENDPOINT, { note: "one" }),
      jsonResponse(210, "w2", { ok: true }),
      request(300, "r", "GET", ENDPOINT),
      jsonResponse(310, "r", after),
    ]);
    expect(found).toContain("acknowledged_write_lost");
  });

  it("stays silent when the collection grew by as many items as were acknowledged", () => {
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", [{ id: 1 }]),
      request(100, "w1", "POST", ENDPOINT, { note: "one" }),
      jsonResponse(110, "w1", { ok: true }),
      request(200, "w2", "POST", ENDPOINT, { note: "one" }),
      jsonResponse(210, "w2", { ok: true }),
      request(300, "r", "GET", ENDPOINT),
      jsonResponse(310, "r", [{ id: 1 }, { id: 2 }, { id: 3 }]),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("needs at least two acknowledgements", () => {
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", []),
      request(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(110, "w1", { ok: true }),
      request(300, "r", "GET", ENDPOINT),
      jsonResponse(310, "r", []),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("does not group writes that targeted different items", () => {
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", []),
      request(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(110, "w1", { ok: true }),
      request(200, "w2", "POST", ENDPOINT, { productId: 9, qty: 1 }),
      jsonResponse(210, "w2", { ok: true }),
      request(300, "r", "GET", ENDPOINT),
      jsonResponse(310, "r", [{ id: 1, productId: 7, qty: 1 }]),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("stays silent when a write was never acknowledged", () => {
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", []),
      request(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(110, "w1", { ok: true }),
      request(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(210, "w2", { error: "conflict" }, { status: 409 }),
      request(300, "r", "GET", ENDPOINT),
      jsonResponse(310, "r", [{ id: 1, productId: 7, qty: 1 }]),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("stays silent without a read taken after the writes", () => {
    const found = detectors([
      request(10, "b", "GET", ENDPOINT),
      jsonResponse(20, "b", []),
      request(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(110, "w1", { ok: true }),
      request(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      jsonResponse(210, "w2", { ok: true }),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("still reports the quantity loss without a pre-write baseline", () => {
    const candidate = buildEvidenceCandidates(
      [
        request(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 2 }),
        jsonResponse(110, "w1", { ok: true }),
        request(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 2 }),
        jsonResponse(210, "w2", { ok: true }),
        request(300, "r", "GET", ENDPOINT),
        jsonResponse(310, "r", [{ id: 1, productId: 7, qty: 2 }]),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "acknowledged_write_lost");
    expect(candidate).toBeDefined();
    // No baseline to anchor the delta on, so the claim is graded down.
    expect(candidate?.confidence).toBe("medium");
  });
});
