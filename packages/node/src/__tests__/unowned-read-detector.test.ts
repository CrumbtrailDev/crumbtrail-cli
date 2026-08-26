import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { jsonResponse, request } from "./fixtures/net-res";

function unownedReads(
  events: BugEvent[],
  identity?: { userId?: string; accountId?: string },
) {
  return buildEvidenceCandidates(events, {
    start: 0,
    ...(identity === undefined ? {} : { identity }),
  }).filter((candidate) => candidate.detector === "unowned_read");
}

describe("unowned_read", () => {
  it("fires when an authenticated identity receives an unowned record", () => {
    const hits = unownedReads(
      [
        request(100, "order", "GET", "/resource/1"),
        jsonResponse(110, "order", {
          resource: {
            id: 1,
            user_id: null,
            total_cents: 79_600,
          },
        }),
      ],
      { userId: "5" },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain("without a relationship");
    expect(hits[0].anchor.message).toContain("user_id=null");
    expect(hits[0].anchor.message).toContain("identity 5");
  });

  it("fires for a different owner-shaped value without naming an application route", () => {
    const hits = unownedReads(
      [
        request(100, "read", "GET", "/records/1"),
        jsonResponse(110, "read", {
          record: { id: 1, ownerId: 9, status: "placed" },
        }),
      ],
      { userId: "5" },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].anchor.message).toContain("ownerId=9");
  });

  it("stays silent when the authenticated session owns the record it read", () => {
    const events = [
      request(100, "write", "POST", "/records", { total: 79_600 }),
      jsonResponse(110, "write", { ok: true }),
      request(200, "read", "GET", "/records/1"),
      jsonResponse(210, "read", {
        record: { id: 1, user_id: 5, status: "placed" },
      }),
    ];

    expect(unownedReads(events, { userId: "5" })).toHaveLength(0);
  });

  it("stays silent on a shared catalogue response", () => {
    const events = [
      request(100, "catalogue", "GET", "/catalogue"),
      jsonResponse(110, "catalogue", {
        products: [{ id: 1, name: "Aurora", price_cents: 19_900 }],
      }),
    ];

    expect(unownedReads(events, { userId: "5" })).toHaveLength(0);
  });

  it("stays silent when no authenticated identity was established", () => {
    const events = [
      request(100, "read", "GET", "/records/1"),
      jsonResponse(110, "read", {
        record: { id: 1, user_id: 9, status: "placed" },
      }),
    ];

    expect(unownedReads(events)).toHaveLength(0);
  });
});
