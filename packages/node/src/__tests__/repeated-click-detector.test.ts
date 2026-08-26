import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function click(t: number, sig: string, text = "Continue"): BugEvent {
  return {
    t,
    k: "clk",
    d: {
      el: {
        sig,
        path: `main>${sig}`,
        tag: "BUTTON",
        txt: text,
      },
    },
  };
}

function repeatedClickDetector(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).find(
    (candidate) => candidate.detector === "repeated_clicks",
  );
}

describe("repeated_clicks", () => {
  it("raises for three activations on one stable target with no consequence", () => {
    const candidate = repeatedClickDetector([
      click(100, "target-a"),
      click(500, "target-a"),
      click(900, "target-a"),
    ]);

    expect(candidate).toMatchObject({
      detector: "repeated_clicks",
      severity: "low",
      confidence: "low",
      anchor: {
        elementSignature: "target-a",
        elementLabel: "Continue",
      },
    });
    expect(candidate?.title).toContain("no recorded consequence");
  });

  it("stays silent when a navigation follows the activations", () => {
    const candidate = repeatedClickDetector([
      click(100, "target-a"),
      click(500, "target-a"),
      click(900, "target-a"),
      { t: 1_000, k: "nav", d: { to: "/next" } },
    ]);

    expect(candidate).toBeUndefined();
  });

  it("stays silent when a request follows the activations", () => {
    const candidate = repeatedClickDetector([
      click(100, "target-a"),
      click(500, "target-a"),
      click(900, "target-a"),
      { t: 1_000, k: "net.req", d: { id: "r1", m: "GET", url: "/next" } },
    ]);

    expect(candidate).toBeUndefined();
  });

  it.each([
    ["DOM mutation", "dom.mutation"],
    ["recorded state", "state.snap"],
  ])("stays silent when %s evidence follows the activations", (_name, kind) => {
    const candidate = repeatedClickDetector([
      click(100, "target-a"),
      click(500, "target-a"),
      click(900, "target-a"),
      { t: 1_000, k: kind, d: {} },
    ]);

    expect(candidate).toBeUndefined();
  });

  it("does not merge different targets that share a label", () => {
    const candidate = repeatedClickDetector([
      click(100, "target-a"),
      click(500, "target-b"),
      click(900, "target-a"),
      click(1_300, "target-b"),
    ]);

    expect(candidate).toBeUndefined();
  });
});
