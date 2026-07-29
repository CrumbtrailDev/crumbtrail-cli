import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { jsonResponse, request } from "./fixtures/net-res";

function sessionDelete(t: number, requestId: string): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      requestId,
      engine: "postgres",
      op: "delete",
      table: "sessions",
      pk: { id: "opaque" },
      before: { id: "opaque", user_id: 3 },
    },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("session-bound cart invariants", () => {
  it("flags checkout expiring a session and erasing a populated cart", () => {
    const found = detectors([
      request(10, "before", "GET", "/api/cart"),
      jsonResponse(20, "before", {
        items: [{ productId: 1, qty: 2 }],
      }),
      request(100, "checkout", "POST", "/api/checkout", { total: 9900 }),
      sessionDelete(105, "checkout"),
      jsonResponse(
        110,
        "checkout",
        { error: "empty_cart" },
        { status: 400 },
      ),
      request(120, "after", "GET", "/api/cart"),
      jsonResponse(130, "after", { items: [] }),
    ]);
    expect(found).toContain("cart_lost_after_session_expiry");
  });

  it("does not blame session expiry when the cart remains populated", () => {
    const found = detectors([
      request(10, "before", "GET", "/api/cart"),
      jsonResponse(20, "before", {
        items: [{ productId: 1, qty: 2 }],
      }),
      request(100, "checkout", "POST", "/api/checkout", { total: 9900 }),
      sessionDelete(105, "checkout"),
      jsonResponse(
        110,
        "checkout",
        { error: "empty_cart" },
        { status: 400 },
      ),
      request(120, "after", "GET", "/api/cart"),
      jsonResponse(130, "after", {
        items: [{ productId: 1, qty: 2 }],
      }),
    ]);
    expect(found).not.toContain("cart_lost_after_session_expiry");
  });

  it("flags repeated login merging the same guest cart twice", () => {
    const found = detectors([
      request(10, "login1", "POST", "/api/login", {}),
      jsonResponse(20, "login1", {
        user: { id: 3 },
        mergedLines: 1,
      }),
      request(30, "cart1", "GET", "/api/cart"),
      jsonResponse(40, "cart1", {
        items: [{ productId: 1, qty: 2 }],
      }),
      request(50, "login2", "POST", "/api/login", {}),
      jsonResponse(60, "login2", {
        user: { id: 3 },
        mergedLines: 1,
      }),
      request(70, "cart2", "GET", "/api/cart"),
      jsonResponse(80, "cart2", {
        items: [
          { productId: 1, qty: 2 },
          { productId: 1, qty: 2 },
        ],
      }),
    ]);
    expect(found).toContain("cart_remerged_on_login");
  });

  it("does not flag a second login when the cart stayed stable", () => {
    const found = detectors([
      request(10, "login1", "POST", "/api/login", {}),
      jsonResponse(20, "login1", {
        user: { id: 3 },
        mergedLines: 1,
      }),
      request(30, "cart1", "GET", "/api/cart"),
      jsonResponse(40, "cart1", {
        items: [{ productId: 1, qty: 2 }],
      }),
      request(50, "login2", "POST", "/api/login", {}),
      jsonResponse(60, "login2", {
        user: { id: 3 },
        mergedLines: 0,
      }),
      request(70, "cart2", "GET", "/api/cart"),
      jsonResponse(80, "cart2", {
        items: [{ productId: 1, qty: 2 }],
      }),
    ]);
    expect(found).not.toContain("cart_remerged_on_login");
  });
});
