import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 });
}

describe("display_date_timezone_mismatch", () => {
  it("flags a UTC day rendered for an instant that is still yesterday locally", () => {
    const events = [
      {
        t: 1,
        k: "env",
        d: { timezone: "America/Los_Angeles" },
      },
      {
        t: 2,
        k: "net.res",
        d: {
          id: 1,
          requestId: "req-orders",
          body: JSON.stringify({
            orders: [{ created_at: "2026-07-01T03:30:00.000Z" }],
          }),
        },
      },
      {
        t: 3,
        k: "ui.num",
        d: {
          region: "ul.order-list",
          items: [{ label: "Order #1", value: 20635, unit: "iso-day" }],
        },
      },
    ] as unknown as BugEvent[];

    const candidate = detectors(events).find(
      (entry) => entry.detector === "display_date_timezone_mismatch",
    );
    expect(candidate).toBeDefined();
    expect(candidate?.confidence).toBe("high");
    expect(candidate?.anchor.requestId).toBe("req-orders");
  });

  it("stays silent when the rendered day is correct for the browser timezone", () => {
    const events = [
      {
        t: 1,
        k: "env",
        d: { timezone: "America/Los_Angeles" },
      },
      {
        t: 2,
        k: "net.res",
        d: {
          body: JSON.stringify({
            created_at: "2026-07-01T03:30:00.000Z",
          }),
        },
      },
      {
        t: 3,
        k: "ui.num",
        d: {
          items: [{ label: "Order #1", value: 20634, unit: "iso-day" }],
        },
      },
    ] as unknown as BugEvent[];

    expect(
      detectors(events).map((entry) => entry.detector),
    ).not.toContain("display_date_timezone_mismatch");
  });
});
