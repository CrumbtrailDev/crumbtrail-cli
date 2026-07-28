import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function layout(
  t: number,
  overflowX: number,
  options: { dir?: string; url?: string; lang?: string } = {},
): BugEvent {
  const clientW = 390;
  return {
    t,
    k: "ui.layout",
    d: {
      dir: options.dir ?? "ltr",
      lang: options.lang ?? "en-US",
      clientW,
      scrollW: clientW + overflowX,
      overflowX,
      url: options.url ?? "/checkout",
    },
  } as unknown as BugEvent;
}

function candidatesFor(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (candidate) => candidate.detector === "layout_overflow",
  );
}

describe("layout_overflow", () => {
  it("names a page that is wider than its viewport", () => {
    const [candidate] = candidatesFor([layout(10, 120)]);
    expect(candidate).toBeDefined();
    expect(candidate.title).toContain("overflows its viewport by 120 px");
    expect(candidate.severity).toBe("medium");
    expect(candidate.confidence).toBe("high");
  });

  it("names the direction, the overflow and the url in the detail", () => {
    const [candidate] = candidatesFor([
      layout(10, 120, { url: "/ar/checkout" }),
    ]);
    expect(candidate.anchor.message).toContain("dir=ltr");
    expect(candidate.anchor.message).toContain("120 px");
    expect(candidate.anchor.message).toContain("/ar/checkout");
    expect(candidate.anchor.message).toContain("scrollWidth 510");
  });

  it("ranks a right-to-left overflow higher, because the lost edge is the first one", () => {
    const [rtl] = candidatesFor([layout(10, 120, { dir: "rtl" })]);
    const [ltr] = candidatesFor([layout(10, 120)]);
    expect(rtl.severity).toBe("high");
    expect(rtl.score).toBeGreaterThan(ltr.score);
    expect(rtl.anchor.message).toContain("mirrored");
  });

  it("treats a few pixels as measurement noise", () => {
    expect(candidatesFor([layout(10, 12)])).toHaveLength(0);
    expect(candidatesFor([layout(10, 24)])).toHaveLength(0);
    expect(candidatesFor([layout(10, 25)])).toHaveLength(1);
  });

  it("keeps one candidate per url, carrying the worst measurement", () => {
    const candidates = candidatesFor([
      layout(10, 40, { url: "/checkout" }),
      layout(20, 260, { url: "/checkout" }),
      layout(30, 90, { url: "/checkout" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toContain("260 px");
  });

  it("keeps different urls apart", () => {
    const candidates = candidatesFor([
      layout(10, 40, { url: "/checkout" }),
      layout(20, 60, { url: "/cart" }),
    ]);
    expect(candidates).toHaveLength(2);
  });
});
