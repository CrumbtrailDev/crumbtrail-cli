import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function uiNum(
  t: number,
  items: Array<{ label: string; value: number; unit?: string }>,
  region = "dl.totals",
): BugEvent {
  return { t, k: "ui.num", d: { region, items } };
}

describe("buildEvidenceCandidates — ui_arithmetic_mismatch", () => {
  it("fires on the P3 shape: Subtotal 199.00 + Tax 16.42 but Total 199.00", () => {
    const events: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 199.0, unit: "$" },
        { label: "Tax (8.25%)", value: 16.42, unit: "$" },
        { label: "Total", value: 199.0, unit: "$" },
      ]),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "ui_arithmetic_mismatch");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("medium");
    expect(cand!.score).toBe(60);
    expect(cand!.confidence).toBe("high");
    // Evidence carries the snapshot items verbatim.
    expect(cand!.anchor.message).toContain("Subtotal:199");
    expect(cand!.anchor.message).toContain("Tax (8.25%):16.42");
    expect(cand!.anchor.message).toContain("Total:199");
  });

  it("stays silent when the total is correct (Total 215.42)", () => {
    const events: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 199.0 },
        { label: "Tax (8.25%)", value: 16.42 },
        { label: "Total", value: 215.42 },
      ]),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "ui_arithmetic_mismatch"),
    ).toBe(false);
  });

  it("respects the epsilon boundary of 1 cent per component", () => {
    // Two components → ε = 0.02. Off by exactly 0.02 → silent.
    const atBoundary: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 100.0 },
        { label: "Tax", value: 10.0 },
        { label: "Total", value: 110.02 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(atBoundary, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
    // Off by 0.03 (> ε) → fires.
    const pastBoundary: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 100.0 },
        { label: "Tax", value: 10.0 },
        { label: "Total", value: 110.03 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(pastBoundary, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(true);
  });

  it("subtracts discounts from the component sum", () => {
    const matching: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 100.0 },
        { label: "Discount", value: 20.0 },
        { label: "Total", value: 80.0 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(matching, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
    const broken: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 100.0 },
        { label: "Discount", value: 20.0 },
        { label: "Total", value: 100.0 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(broken, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(true);
  });

  it("classifies 'Total tax' as the tax component, not THE total (probe regression)", () => {
    // Correct arithmetic: Subtotal 199.00 + Total tax 16.42 = Total 215.42 → silent.
    const correct: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 199.0 },
        { label: "Total tax", value: 16.42 },
        { label: "Total", value: 215.42 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(correct, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
    // Wrong total with the same components → fires.
    const broken: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 199.0 },
        { label: "Total tax", value: 16.42 },
        { label: "Total", value: 199.0 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(broken, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(true);
  });

  it("does not treat count-style 'Total items' as a currency total (probe regression)", () => {
    const events: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 199.0, unit: "$" },
        { label: "Shipping", value: 10.0, unit: "$" },
        { label: "Total items", value: 3 },
      ]),
    ];
    // No usable total remains → silent.
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
  });

  it("stays silent when the total's unit disagrees with component units", () => {
    const events: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 199.0, unit: "$" },
        { label: "Shipping", value: 10.0, unit: "$" },
        { label: "Grand total", value: 3, unit: "pcs" },
      ]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
  });

  it("handles negatively displayed discounts without double-subtracting (probe regression)", () => {
    // Subtotal 100, Discount −20, Total 80 — correct on screen → silent.
    const negativeDiscount: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 100.0 },
        { label: "Discount", value: -20.0 },
        { label: "Total", value: 80.0 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(negativeDiscount, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
    // Negative discount with a wrong total still fires.
    const broken: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 100.0 },
        { label: "Discount", value: -20.0 },
        { label: "Total", value: 100.0 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(broken, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(true);
  });

  it("stays silent when any label is [REDACTED]", () => {
    const events: BugEvent[] = [
      uiNum(1000, [
        { label: "[REDACTED]", value: 199.0 },
        { label: "Tax", value: 16.42 },
        { label: "Total", value: 199.0 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
  });

  it("stays silent on ambiguous roles: two totals", () => {
    const events: BugEvent[] = [
      uiNum(1000, [
        { label: "Subtotal", value: 199.0 },
        { label: "Total", value: 199.0 },
        { label: "Grand Total", value: 215.42 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
  });

  it("stays silent when a total has no component parts", () => {
    const events: BugEvent[] = [
      uiNum(1000, [
        { label: "Total", value: 199.0 },
        { label: "Items", value: 3 },
      ]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_arithmetic_mismatch",
      ),
    ).toBe(false);
  });

  it("dedupes re-emits of the same broken region by mismatch amounts", () => {
    const snapshot = [
      { label: "Subtotal", value: 199.0 },
      { label: "Tax", value: 16.42 },
      { label: "Total", value: 199.0 },
    ];
    const events: BugEvent[] = [
      uiNum(1000, snapshot),
      uiNum(2000, snapshot),
      uiNum(3000, snapshot),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.filter((c) => c.detector === "ui_arithmetic_mismatch"),
    ).toHaveLength(1);
  });

  it("is inert when there are no ui.num events (existing sessions unaffected)", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "net.req", d: { id: "r1", m: "POST", url: "https://a/b" } },
      { t: 1100, k: "net.res", d: { id: "r1", st: 200 } },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "ui_arithmetic_mismatch"),
    ).toBe(false);
  });
});
