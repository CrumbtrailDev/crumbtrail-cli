import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { jsonResponse, request } from "./fixtures/net-res";

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("locale-sensitive input invariants", () => {
  it("flags a non-US postal code rejected by generic postal validation", () => {
    const found = detectors([
      request(10, "r1", "POST", "/api/addresses", {
        name: "Test Shopper",
        line1: "10 Downing St",
        city: "London",
        country: "GB",
        postalCode: { $redacted: "[REDACTED]", len: 8 },
      }),
      jsonResponse(
        20,
        "r1",
        {
          error: "validation_failed",
          errors: { postalCode: "Invalid postal code" },
        },
        { status: 400 },
      ),
    ]);
    expect(found).toContain("country_postal_validation_mismatch");
  });

  it("does not reinterpret an ordinary US postal validation error", () => {
    const found = detectors([
      request(10, "r1", "POST", "/api/addresses", {
        country: "US",
        postalCode: "nope",
      }),
      jsonResponse(
        20,
        "r1",
        {
          error: "validation_failed",
          errors: { postalCode: "Invalid postal code" },
        },
        { status: 400 },
      ),
    ]);
    expect(found).not.toContain("country_postal_validation_mismatch");
  });

  it("flags a decimal-comma amount accepted at 100 times its value", () => {
    const found = detectors([
      request(10, "r1", "POST", "/api/addresses/store-credit", {
        amountCents: 19_900,
        raw: "1,99",
        locale: "de-DE",
      }),
      jsonResponse(20, "r1", { ok: true, appliedCents: 19_900 }),
    ]);
    expect(found).toContain("locale_decimal_scale_shift");
  });

  it("accepts a correctly parsed decimal-comma amount", () => {
    const found = detectors([
      request(10, "r1", "POST", "/api/addresses/store-credit", {
        amountCents: 199,
        raw: "1,99",
        locale: "de-DE",
      }),
      jsonResponse(20, "r1", { ok: true, appliedCents: 199 }),
    ]);
    expect(found).not.toContain("locale_decimal_scale_shift");
  });
});
