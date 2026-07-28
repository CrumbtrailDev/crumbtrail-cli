import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

function diff(
  t: number,
  requestId: string,
  op: string,
  table: string,
  after: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", requestId, op, table, after },
  } as unknown as BugEvent;
}

describe("data lifecycle integrity", () => {
  it("flags a derived count below rows inserted for the same parent", () => {
    expect(
      detectors([
        diff(100, "a", "insert", "reviews", {
          id: 1,
          product_id: 2,
        }),
        diff(110, "b", "insert", "reviews", {
          id: 2,
          product_id: 2,
        }),
        diff(120, "b", "update", "product_rating_cache", {
          product_id: 2,
          rating_count: 1,
        }),
      ]),
    ).toContain("derived_count_below_observed_inserts");
  });

  it("accepts a derived count that covers the observed inserts", () => {
    expect(
      detectors([
        diff(100, "a", "insert", "reviews", {
          id: 1,
          product_id: 2,
        }),
        diff(120, "a", "update", "product_rating_cache", {
          product_id: 2,
          rating_count: 1,
        }),
      ]),
    ).not.toContain("derived_count_below_observed_inserts");
  });

  it("flags a successful write that returns a shorter persisted text field", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "net.req",
          d: {
            requestId: "review-1",
            method: "POST",
            url: "/api/reviews",
            body: JSON.stringify({
              body: { $redacted: "[REDACTED]", len: 1025 },
            }),
          },
        },
        {
          t: 120,
          k: "net.res",
          d: {
            requestId: "review-1",
            st: 201,
            body: JSON.stringify({
              review: {
                body: { $redacted: "[REDACTED]", len: 140 },
              },
            }),
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("accepted_text_was_truncated");
  });

  it("accepts a successful write that preserves text length", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "net.req",
          d: {
            requestId: "review-1",
            method: "POST",
            url: "/api/reviews",
            body: JSON.stringify({
              body: { $redacted: "[REDACTED]", len: 140 },
            }),
          },
        },
        {
          t: 120,
          k: "net.res",
          d: {
            requestId: "review-1",
            st: 201,
            body: JSON.stringify({
              review: {
                body: { $redacted: "[REDACTED]", len: 140 },
              },
            }),
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("accepted_text_was_truncated");
  });

  it("flags a collection larger than the explicit request limit", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "net.req",
          d: {
            requestId: "list-1",
            method: "GET",
            url: "/api/products?limit=2",
          },
        },
        {
          t: 120,
          k: "net.res",
          d: {
            requestId: "list-1",
            st: 200,
            body: JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("response_exceeded_requested_limit");
  });

  it("accepts a collection within the explicit request limit", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "net.req",
          d: {
            requestId: "list-1",
            method: "GET",
            url: "/api/products?limit=3",
          },
        },
        {
          t: 120,
          k: "net.res",
          d: {
            requestId: "list-1",
            st: 200,
            body: JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("response_exceeded_requested_limit");
  });

  it("flags a sent confirmation after cancellation for the same order", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "db.read",
          d: {
            table: "notifications",
            row: {
              id: 1,
              order_id: 7,
              type: "order_cancelled",
              status: "sent",
            },
          },
        },
        {
          t: 120,
          k: "db.read",
          d: {
            table: "notifications",
            row: {
              id: 2,
              order_id: 7,
              type: "order_confirmed",
              status: "sent",
            },
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("notification_lifecycle_order_inverted");
  });

  it("does not compare lifecycle notifications for different orders", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "db.read",
          d: {
            table: "notifications",
            row: { order_id: 7, type: "order_cancelled", status: "sent" },
          },
        },
        {
          t: 120,
          k: "db.read",
          d: {
            table: "notifications",
            row: { order_id: 8, type: "order_confirmed", status: "sent" },
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("notification_lifecycle_order_inverted");
  });
});
