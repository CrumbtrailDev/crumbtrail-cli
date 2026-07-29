import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function snapshot(
  t: number,
  lang: string | undefined,
  items: Array<{ label: string; value: number; unit?: string }>,
): BugEvent {
  return {
    t,
    k: "ui.num",
    d: {
      region: "checkout",
      items,
      ...(lang === undefined ? {} : { lang, dir: "ltr" }),
    },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("currency_locale_mismatch", () => {
  it("names a German page pricing in dollars", () => {
    const found = detectors([
      snapshot(10, "de-DE", [
        { label: "Zwischensumme", value: 40, unit: "$" },
        { label: "Versand", value: 5, unit: "$" },
      ]),
    ]);
    expect(found).toContain("currency_locale_mismatch");
  });

  it("says the mapping is a heuristic", () => {
    const candidate = buildEvidenceCandidates(
      [
        snapshot(10, "de-DE", [
          { label: "Zwischensumme", value: 40, unit: "$" },
          { label: "Versand", value: 5, unit: "$" },
        ]),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "currency_locale_mismatch");
    expect(candidate?.severity).toBe("medium");
    expect(candidate?.confidence).toBe("low");
    expect(candidate?.anchor.message).toContain("heuristic");
    expect(candidate?.title).toContain('lang "de-DE"');
  });

  it("needs two amounts, or the same mismatch on a second emission", () => {
    const single = detectors([
      snapshot(10, "de-DE", [{ label: "Summe", value: 40, unit: "$" }]),
    ]);
    expect(single).not.toContain("currency_locale_mismatch");

    const repeated = detectors([
      snapshot(10, "de-DE", [{ label: "Summe", value: 40, unit: "$" }]),
      snapshot(20, "de-DE", [{ label: "Summe", value: 45, unit: "$" }]),
    ]);
    expect(repeated).toContain("currency_locale_mismatch");
  });

  it("maps en-GB to sterling", () => {
    expect(
      detectors([
        snapshot(10, "en-GB", [
          { label: "Subtotal", value: 40, unit: "$" },
          { label: "Shipping", value: 5, unit: "$" },
        ]),
      ]),
    ).toContain("currency_locale_mismatch");
    expect(
      detectors([
        snapshot(10, "en-GB", [
          { label: "Subtotal", value: 40, unit: "£" },
          { label: "Shipping", value: 5, unit: "£" },
        ]),
      ]),
    ).not.toContain("currency_locale_mismatch");
  });

  it("maps Japanese to yen", () => {
    expect(
      detectors([
        snapshot(10, "ja", [
          { label: "Subtotal", value: 40, unit: "$" },
          { label: "Shipping", value: 5, unit: "$" },
        ]),
      ]),
    ).toContain("currency_locale_mismatch");
  });

  it("stays silent on the matching locale", () => {
    const found = detectors([
      snapshot(10, "en-US", [
        { label: "Subtotal", value: 40, unit: "$" },
        { label: "Shipping", value: 5, unit: "$" },
      ]),
    ]);
    expect(found).not.toContain("currency_locale_mismatch");
  });

  it("cannot run without a declared language", () => {
    const found = detectors([
      snapshot(10, undefined, [
        { label: "Subtotal", value: 40, unit: "$" },
        { label: "Shipping", value: 5, unit: "$" },
      ]),
    ]);
    expect(found).not.toContain("currency_locale_mismatch");
  });

  it("stays silent on a language it has no opinion about", () => {
    const found = detectors([
      snapshot(10, "sw-KE", [
        { label: "Subtotal", value: 40, unit: "$" },
        { label: "Shipping", value: 5, unit: "$" },
      ]),
    ]);
    expect(found).not.toContain("currency_locale_mismatch");
  });

  it("ignores non-currency units", () => {
    const found = detectors([
      snapshot(10, "de-DE", [
        { label: "Artikel", value: 4, unit: "items" },
        { label: "Gewicht", value: 5, unit: "kg" },
      ]),
    ]);
    expect(found).not.toContain("currency_locale_mismatch");
  });
});
