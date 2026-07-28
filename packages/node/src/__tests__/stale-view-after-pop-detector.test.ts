import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function nav(t: number, to: string, tr: string): BugEvent {
  return { t, k: "nav", d: { to, tr } } as unknown as BugEvent;
}

function apiCall(t: number, url = "/api/products?category=audio"): BugEvent {
  return {
    t,
    k: "net.req",
    d: { requestId: `req-${t}`, m: "GET", url },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

/**
 * The view proving it reacts to a parameter change: a push to the same path with
 * different parameters, answered by a data call inside the window.
 */
const provedReactive = [
  nav(1_000, "/products?category=all", "init"),
  apiCall(1_100, "/api/products?category=all"),
  nav(2_000, "/products?category=audio", "push"),
  apiCall(2_100, "/api/products?category=audio"),
];

describe("stale_view_after_pop", () => {
  it("names a back navigation the view never reacted to", () => {
    const found = detectors([
      ...provedReactive,
      nav(3_000, "/products?category=all", "pop"),
    ]);
    expect(found).toContain("stale_view_after_pop");
  });

  it("states that the URL and the screen now disagree", () => {
    const candidate = buildEvidenceCandidates(
      [...provedReactive, nav(3_000, "/products?category=all", "pop")],
      { start: 0 },
    ).find((entry) => entry.detector === "stale_view_after_pop");
    expect(candidate?.title).toBe(
      "Back navigation changed the URL but the view never refetched",
    );
    expect(candidate?.severity).toBe("high");
    expect(candidate?.anchor.message).toContain("no API request followed");
    expect(candidate?.anchor.message).toContain("disagree");
  });

  it("stays silent when the pop did trigger a data call", () => {
    const found = detectors([
      ...provedReactive,
      nav(3_000, "/products?category=all", "pop"),
      apiCall(3_200, "/api/products?category=all"),
    ]);
    expect(found).not.toContain("stale_view_after_pop");
  });

  it("stays silent when the view was never shown to react to parameters", () => {
    // A statically rendered list legitimately makes no call on a param change.
    const found = detectors([
      nav(1_000, "/products?category=all", "init"),
      nav(2_000, "/products?category=audio", "push"),
      nav(3_000, "/products?category=all", "pop"),
    ]);
    expect(found).not.toContain("stale_view_after_pop");
  });

  it("stays silent on a pop to a different page", () => {
    const found = detectors([
      ...provedReactive,
      nav(3_000, "/cart", "pop"),
    ]);
    expect(found).not.toContain("stale_view_after_pop");
  });

  it("stays silent when the pop left the query string unchanged", () => {
    const found = detectors([
      ...provedReactive,
      nav(3_000, "/products?category=audio", "pop"),
    ]);
    expect(found).not.toContain("stale_view_after_pop");
  });

  it("stays silent on a push, which the router owns", () => {
    const found = detectors([
      ...provedReactive,
      nav(3_000, "/products?category=lamp", "push"),
    ]);
    expect(found).not.toContain("stale_view_after_pop");
  });

  it("ignores a static asset fetched after the pop", () => {
    const found = detectors([
      ...provedReactive,
      nav(3_000, "/products?category=all", "pop"),
      apiCall(3_100, "/assets/chunk-9f2.js"),
    ]);
    expect(found).toContain("stale_view_after_pop");
  });

  it("ignores a call that arrived long after the window closed", () => {
    const found = detectors([
      ...provedReactive,
      nav(3_000, "/products?category=all", "pop"),
      apiCall(9_000, "/api/products?category=all"),
    ]);
    expect(found).toContain("stale_view_after_pop");
  });

  describe("a fetch that beats its own pushState", () => {
    /**
     * The live-session ordering, verbatim. The handler starts the fetch and
     * THEN commits the history entry, so the reactive request is recorded 100 ms
     * BEFORE the nav event it belongs to. A strictly-after precondition read
     * that as "this view was never shown to react" and stayed silent on the
     * textbook signature.
     */
    const search = [
      nav(1_000, "/search?q=sonar", "init"),
      apiCall(1_900, "/api/search?q=sonar&category=audio"),
      nav(2_000, "/search?q=sonar&category=audio", "push"),
    ];

    it("counts a request that lands just before the nav it caused", () => {
      const found = detectors([
        ...search,
        nav(3_000, "/search?q=sonar", "pop"),
      ]);
      expect(found).toContain("stale_view_after_pop");
    });

    it("stays silent when the pop is followed by a refetch", () => {
      const found = detectors([
        ...search,
        nav(3_000, "/search?q=sonar", "pop"),
        apiCall(3_150, "/api/search?q=sonar"),
      ]);
      expect(found).not.toContain("stale_view_after_pop");
    });

    it("stays silent when the pop's own fetch also beat its nav event", () => {
      // Same race on the pop side, inside the tighter 250 ms allowance.
      const found = detectors([
        ...search,
        apiCall(2_900, "/api/search?q=sonar"),
        nav(3_000, "/search?q=sonar", "pop"),
      ]);
      expect(found).not.toContain("stale_view_after_pop");
    });

    it("does not let a call serving the previous state excuse the pop", () => {
      // 900 ms before the pop: that request was answering the pushed state, and
      // forgiving it would silence a real finding.
      const found = detectors([
        ...search,
        apiCall(2_100, "/api/search?q=sonar&category=audio"),
        nav(3_000, "/search?q=sonar", "pop"),
      ]);
      expect(found).toContain("stale_view_after_pop");
    });

    it("does not accept an unrelated background call as proof of reactivity", () => {
      const unrelated = [
        nav(1_000, "/search?q=sonar", "init"),
        apiCall(1_900, "/api/telemetry?session=abc"),
        nav(2_000, "/search?q=sonar&category=audio", "push"),
        nav(3_000, "/search?q=sonar", "pop"),
      ];
      expect(detectors(unrelated)).not.toContain("stale_view_after_pop");
    });
  });
});
