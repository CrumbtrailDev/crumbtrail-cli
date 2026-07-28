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

function res(t: number, requestId: string, data: unknown, st = 200): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      requestId,
      st,
      dur: 6,
      body: { ct: "json", bytes: 96, truncated: false, data },
    },
  } as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

const ENDPOINT = "/api/cart/items";

describe("acknowledged_write_lost", () => {
  it("names two acknowledged adds that left one item's worth of quantity", () => {
    const found = detectors([
      req(10, "b", "GET", ENDPOINT),
      res(20, "b", []),
      req(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(110, "w1", { ok: true }),
      req(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(210, "w2", { ok: true }),
      req(300, "r", "GET", ENDPOINT),
      res(310, "r", [{ id: 1, productId: 7, qty: 1 }]),
    ]);
    expect(found).toContain("acknowledged_write_lost");
  });

  it("says how many writes were acknowledged and what the read showed", () => {
    const candidate = buildEvidenceCandidates(
      [
        req(10, "b", "GET", ENDPOINT),
        res(20, "b", []),
        req(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
        res(110, "w1", { ok: true }),
        req(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
        res(210, "w2", { ok: true }),
        req(300, "r", "GET", ENDPOINT),
        res(310, "r", [{ id: 1, productId: 7, qty: 1 }]),
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
      req(10, "b", "GET", ENDPOINT),
      res(20, "b", []),
      req(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(110, "w1", { ok: true }),
      req(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(210, "w2", { ok: true }),
      req(300, "r", "GET", ENDPOINT),
      res(310, "r", [{ id: 1, productId: 7, qty: 2 }]),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("counts items when the request bodies carry no quantity", () => {
    const found = detectors([
      req(10, "b", "GET", ENDPOINT),
      res(20, "b", [{ id: 1 }]),
      req(100, "w1", "POST", ENDPOINT, { note: "one" }),
      res(110, "w1", { ok: true }),
      req(200, "w2", "POST", ENDPOINT, { note: "one" }),
      res(210, "w2", { ok: true }),
      req(300, "r", "GET", ENDPOINT),
      res(310, "r", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).toContain("acknowledged_write_lost");
  });

  it("stays silent when the collection grew by as many items as were acknowledged", () => {
    const found = detectors([
      req(10, "b", "GET", ENDPOINT),
      res(20, "b", [{ id: 1 }]),
      req(100, "w1", "POST", ENDPOINT, { note: "one" }),
      res(110, "w1", { ok: true }),
      req(200, "w2", "POST", ENDPOINT, { note: "one" }),
      res(210, "w2", { ok: true }),
      req(300, "r", "GET", ENDPOINT),
      res(310, "r", [{ id: 1 }, { id: 2 }, { id: 3 }]),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("needs at least two acknowledgements", () => {
    const found = detectors([
      req(10, "b", "GET", ENDPOINT),
      res(20, "b", []),
      req(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(110, "w1", { ok: true }),
      req(300, "r", "GET", ENDPOINT),
      res(310, "r", []),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("does not group writes that targeted different items", () => {
    const found = detectors([
      req(10, "b", "GET", ENDPOINT),
      res(20, "b", []),
      req(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(110, "w1", { ok: true }),
      req(200, "w2", "POST", ENDPOINT, { productId: 9, qty: 1 }),
      res(210, "w2", { ok: true }),
      req(300, "r", "GET", ENDPOINT),
      res(310, "r", [{ id: 1, productId: 7, qty: 1 }]),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("stays silent when a write was never acknowledged", () => {
    const found = detectors([
      req(10, "b", "GET", ENDPOINT),
      res(20, "b", []),
      req(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(110, "w1", { ok: true }),
      req(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(210, "w2", { error: "conflict" }, 409),
      req(300, "r", "GET", ENDPOINT),
      res(310, "r", [{ id: 1, productId: 7, qty: 1 }]),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("stays silent without a read taken after the writes", () => {
    const found = detectors([
      req(10, "b", "GET", ENDPOINT),
      res(20, "b", []),
      req(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(110, "w1", { ok: true }),
      req(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 1 }),
      res(210, "w2", { ok: true }),
    ]);
    expect(found).not.toContain("acknowledged_write_lost");
  });

  it("still reports the quantity loss without a pre-write baseline", () => {
    const candidate = buildEvidenceCandidates(
      [
        req(100, "w1", "POST", ENDPOINT, { productId: 7, qty: 2 }),
        res(110, "w1", { ok: true }),
        req(200, "w2", "POST", ENDPOINT, { productId: 7, qty: 2 }),
        res(210, "w2", { ok: true }),
        req(300, "r", "GET", ENDPOINT),
        res(310, "r", [{ id: 1, productId: 7, qty: 2 }]),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "acknowledged_write_lost");
    expect(candidate).toBeDefined();
    // No baseline to anchor the delta on, so the claim is graded down.
    expect(candidate?.confidence).toBe("medium");
  });
});
