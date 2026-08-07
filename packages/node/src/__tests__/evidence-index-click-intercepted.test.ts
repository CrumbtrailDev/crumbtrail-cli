import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * The detector's whole reason for existing is that a rendered fact nobody ranks is a fact nobody
 * reads: four eval batches ran a session whose defect WAS an overlay eating the checkout click,
 * and every one produced a candidate set with nothing about the click in it. These assert the
 * candidate exists and says what was measured — not that the reader draws the right conclusion.
 */
function clickEvent(d: Record<string, unknown>): BugEvent {
  return { t: 1000, k: "clk", d };
}

const index = { start: 1000, navs: [{ t: 900, to: "/cart" }] };

describe("click_target_intercepted", () => {
  it("surfaces a click taken by an element covering the control beneath it", () => {
    const candidates = buildEvidenceCandidates(
      [
        clickEvent({
          el: { tag: "DIV", path: "div[id=sp-offers-frame]" },
          box: { w: 1280, h: 720, viewportPct: 100 },
          covered: [{ tag: "BUTTON", path: "button[data-testid=cart-checkout]" }],
        }),
      ],
      index,
    );
    const found = candidates.find(
      (c) => c.detector === "click_target_intercepted",
    );
    expect(found).toBeDefined();
    expect(found!.title).toContain("100% of the viewport");
    expect(found!.title).toContain("button");
  });

  it("distinguishes a target absent from its own hit-test stack", () => {
    const candidates = buildEvidenceCandidates(
      [
        clickEvent({
          el: { tag: "BUTTON", path: "button[id=pay]" },
          covered: [{ tag: "DIV", path: "div[id=modal]" }],
          targetNotInStack: true,
        }),
      ],
      index,
    );
    const found = candidates.find(
      (c) => c.detector === "click_target_intercepted",
    );
    expect(found!.title).toContain("outside its own hit-test stack");
  });

  // An ordinary click has neither field, and the overwhelming majority of clicks in any session
  // are ordinary. A detector that fired on those would bury every real one.
  it("stays silent on a click with no integrity findings", () => {
    const candidates = buildEvidenceCandidates(
      [clickEvent({ el: { tag: "BUTTON", path: "button[id=pay]" } })],
      index,
    );
    expect(
      candidates.some((c) => c.detector === "click_target_intercepted"),
    ).toBe(false);
  });

  // A shopper clicking a dead button four times is one finding. Four identical candidates would
  // read as four defects and would crowd out everything else in the ranked set.
  it("collapses repeated clicks on the same intercepted control", () => {
    const d = {
      el: { tag: "DIV", path: "div[id=sp-offers-frame]" },
      covered: [{ tag: "BUTTON", path: "button[data-testid=cart-checkout]" }],
    };
    const candidates = buildEvidenceCandidates(
      [
        { t: 1000, k: "clk", d },
        { t: 1400, k: "clk", d },
        { t: 1900, k: "clk", d },
      ] as BugEvent[],
      index,
    );
    expect(
      candidates.filter((c) => c.detector === "click_target_intercepted").length,
    ).toBe(1);
  });

  // Confidence tracks how legible the measurement is, never how likely a defect is. A small
  // covering element is the same KIND of fact as a full-viewport one, just weaker evidence.
  it("reports lower confidence when the receiver does not dominate the viewport", () => {
    const candidates = buildEvidenceCandidates(
      [
        clickEvent({
          el: { tag: "SPAN", path: "span[id=badge]" },
          box: { w: 40, h: 20, viewportPct: 1 },
          covered: [{ tag: "BUTTON", path: "button[id=pay]" }],
        }),
      ],
      index,
    );
    const found = candidates.find(
      (c) => c.detector === "click_target_intercepted",
    );
    expect(found!.confidence).toBe("low");
    expect(found!.severity).toBe("medium");
  });
});

// A detector whose entire subject is one click must be able to reach that click's node. Without a
// node-kind mapping it took the empty default, the temporal fallback found nothing compatible, and
// the candidate reported `isolated` — out of the incident thread, with `causal_chain` null.
describe("click_target_intercepted — attribution", () => {
  it("reaches the click's own node instead of reporting isolated", async () => {
    const { buildCausalGraph, attributeCandidates } = await import(
      "../causal-graph"
    );
    const events: BugEvent[] = [
      clickEvent({
        el: { tag: "DIV", path: "div[id=sp-offers-frame]" },
        box: { w: 1280, h: 720, viewportPct: 100 },
        covered: [{ tag: "BUTTON", path: "button[data-testid=cart-checkout]" }],
      }),
    ];
    const graph = buildCausalGraph({ events });
    const attribution = attributeCandidates(
      graph,
      [{ id: "c1", anchor: { t: 1000 } }],
      () => "click_target_intercepted",
    );
    expect(attribution.get("c1")?.causalRole).not.toBe("isolated");
  });
});
