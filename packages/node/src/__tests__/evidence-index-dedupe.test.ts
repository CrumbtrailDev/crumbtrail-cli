import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

describe("buildEvidenceCandidates — content-signature dedupe", () => {
  it("collapses N identical re-thrown uncaught errors into one candidate (earliest anchor)", () => {
    const msg = "TypeError: Cannot read properties of null (reading 'weight')";
    const events: BugEvent[] = [
      { t: 1000, k: "err", d: { msg } },
      { t: 1200, k: "err", d: { msg } },
      { t: 1400, k: "err", d: { msg } },
      { t: 1600, k: "err", d: { msg } },
    ];
    const index = {
      start: 1000,
      errs: [
        { t: 1000, msg },
        { t: 1200, msg },
        { t: 1400, msg },
        { t: 1600, msg },
      ],
    };
    const candidates = buildEvidenceCandidates(events, index);
    const runtime = candidates.filter((c) => c.detector === "uncaught_error");
    expect(runtime.length).toBe(1);
    // Earliest anchor is kept.
    expect(runtime[0].anchor.t).toBe(1000);
  });

  it("collapses console errors differing only by embedded ids/timestamps", () => {
    const index = {
      start: 1000,
      consoleErrors: [
        {
          t: 1000,
          lv: "error",
          msg: "Checkout failed for order 1001 at 1699999999",
        },
        {
          t: 1500,
          lv: "error",
          msg: "Checkout failed for order 2002 at 1700000000",
        },
      ],
    };
    const candidates = buildEvidenceCandidates([], index);
    const consoleCands = candidates.filter(
      (c) => c.detector === "console_error",
    );
    expect(consoleCands.length).toBe(1);
  });

  it("keeps genuinely distinct errors on different routes separate", () => {
    const msg = "TypeError: boom";
    const events: BugEvent[] = [
      { t: 1000, k: "nav", d: { to: "/product/a" } },
      { t: 1100, k: "err", d: { msg } },
      { t: 2000, k: "nav", d: { to: "/cart" } },
      { t: 2100, k: "err", d: { msg } },
    ];
    const index = {
      start: 1000,
      navs: [
        { t: 1000, to: "/product/a" },
        { t: 2000, to: "/cart" },
      ],
      errs: [
        { t: 1100, msg },
        { t: 2100, msg },
      ],
    };
    const candidates = buildEvidenceCandidates(events, index);
    const runtime = candidates.filter((c) => c.detector === "uncaught_error");
    expect(runtime.length).toBe(2);
  });
});
