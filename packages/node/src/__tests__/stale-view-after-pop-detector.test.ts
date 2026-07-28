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
});
