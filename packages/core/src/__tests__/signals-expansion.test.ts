import { describe, expect, it } from "vitest";
import { resourceLoadFailureDetector, wrongNumberDetector } from "../signals";
import type { BugEvent } from "../types";

function uiNum(items: Array<Record<string, unknown>>): BugEvent {
  return { t: 1_000, k: "ui.num", d: { region: "Order summary", items } };
}

describe("wrongNumberDetector", () => {
  it("flags a rendered value that is not finite", () => {
    for (const value of [Number.NaN, Infinity, -Infinity, null, undefined]) {
      const signal = wrongNumberDetector().inspect(
        uiNum([{ label: "Total", value, unit: "$" }]),
      );

      expect(signal?.tag).toBe("auto:wrong-number");
      expect(signal?.reason).toContain("Total");
    }
  });

  it("stays silent for finite positive and negative values", () => {
    const detector = wrongNumberDetector();

    expect(
      detector.inspect(uiNum([{ label: "Credit", value: 12 }])),
    ).toBeNull();
    expect(
      detector.inspect(uiNum([{ label: "Balance", value: -12 }])),
    ).toBeNull();
  });

  it("stays silent for unrelated events", () => {
    expect(
      wrongNumberDetector().inspect({
        t: 1_000,
        k: "perf",
        d: { metric: "res", duration: Number.NaN },
      }),
    ).toBeNull();
  });

  it("gives repeats of the same rendered field the same key", () => {
    const detector = wrongNumberDetector();
    const event = uiNum([{ label: "Total", value: undefined }]);

    expect(detector.inspect(event)?.key).toBe(detector.inspect(event)?.key);
  });
});

function resource(d: Record<string, unknown>): BugEvent {
  return { t: 1_000, k: "perf", d: { metric: "res", ...d } };
}

describe("resourceLoadFailureDetector", () => {
  it("flags a script that completed with no transfer and no duration", () => {
    const signal = resourceLoadFailureDetector().inspect(
      resource({
        name: "https://shop.example.com/assets/checkout.js",
        duration: 0,
        transferSize: 0,
        initiatorType: "script",
      }),
    );

    expect(signal?.tag).toBe("auto:resource-load-failure");
    expect(signal?.reason).toContain("checkout.js");
  });

  it("stays silent for a zero-transfer cache hit with measurable duration", () => {
    expect(
      resourceLoadFailureDetector().inspect(
        resource({
          name: "https://shop.example.com/assets/checkout.js",
          duration: 2.4,
          transferSize: 0,
          initiatorType: "script",
        }),
      ),
    ).toBeNull();
  });

  it("stays silent when bytes transferred or the resource is not code", () => {
    const detector = resourceLoadFailureDetector();
    expect(
      detector.inspect(
        resource({
          name: "https://shop.example.com/assets/checkout.js",
          duration: 0,
          transferSize: 512,
          initiatorType: "script",
        }),
      ),
    ).toBeNull();
    expect(
      detector.inspect(
        resource({
          name: "https://shop.example.com/logo.svg",
          duration: 0,
          transferSize: 0,
          initiatorType: "img",
        }),
      ),
    ).toBeNull();
  });

  it("gives repeats of the same resource the same key", () => {
    const detector = resourceLoadFailureDetector();
    const event = resource({
      name: "https://shop.example.com/assets/site.css",
      duration: 0,
      transferSize: 0,
      initiatorType: "link",
    });

    expect(detector.inspect(event)?.key).toBe(detector.inspect(event)?.key);
  });
});
