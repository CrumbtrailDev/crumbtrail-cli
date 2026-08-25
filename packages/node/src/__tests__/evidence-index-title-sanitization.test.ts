import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * A title is a permanent name, so it may not carry one occurrence's data or an internal
 * marker the capture policy wrote for machines.
 *
 * The observed title was:
 *   Backend HTTP 500 from GET /varying: Checkout failed for order ord_7885f1c8
 *   (user [REDACTED:email:17], flag "beta_pricing" enabled)
 * — an internal typed marker and one order's id promoted into the name of a fault that
 * happened eight times with eight different order ids.
 */

function backendError(message: string, pathname = "/varying"): BugEvent[] {
  return [
    {
      t: 1000,
      k: "backend.req.error",
      d: {
        requestId: "req-1",
        method: "GET",
        pathname,
        statusCode: 500,
        error: { name: "Error", message },
      },
    },
  ];
}

function titleFor(message: string): string {
  const [candidate] = buildEvidenceCandidates(backendError(message), {
    start: 1000,
  });
  return candidate.title;
}

describe("minted candidate titles", () => {
  it("humanizes a typed redaction marker and drops the volatile order id", () => {
    expect(
      titleFor(
        'Checkout failed for order ord_7885f1c8 (user [REDACTED:email:17], flag "beta_pricing" enabled)',
      ),
    ).toBe(
      'Backend HTTP 500 from GET /varying: Checkout failed for order (user email, flag "beta_pricing" enabled)',
    );
  });

  it("mints the same title whichever occurrence produced it", () => {
    expect(titleFor("Checkout failed for order ord_7885f1c8")).toBe(
      titleFor("Checkout failed for order ord_1a2b3c4d"),
    );
  });

  it("drops emails, uuids and long hex runs", () => {
    expect(titleFor("Cannot find user alice@example.com")).toBe(
      titleFor("Cannot find user bob@example.com"),
    );
    expect(
      titleFor("Session 4f1c2b3a-1111-2222-3333-444455556666 expired"),
    ).toBe(titleFor("Session 9a8b7c6d-9999-8888-7777-666655554444 expired"));
    expect(titleFor("Failed to load module chunk-abcdefabcdef")).toBe(
      titleFor("Failed to load module chunk-fedcbafedcba"),
    );
  });

  it("keeps a fault name that merely looks like an id", () => {
    // `payment_declined` is what went wrong, not which occurrence went wrong.
    expect(titleFor("Payment payment_declined")).toContain("payment_declined");
  });

  it("drops a suffix that was nothing but a marker, and the colon it left behind", () => {
    expect(titleFor("[REDACTED]")).toBe("Backend HTTP 500 from GET /varying");
  });
});
