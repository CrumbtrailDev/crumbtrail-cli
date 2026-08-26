import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { buildCausalGraph } from "../causal-graph";

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

function repeatedClickDetector(events: BugEvent[], withGraph = false) {
  return buildEvidenceCandidates(
    events,
    { start: 0 },
    withGraph ? buildCausalGraph({ events }) : undefined,
  ).find((candidate) => candidate.detector === "repeated_clicks");
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

  it("ignores unrelated requests and mutations from earlier in the flow", () => {
    const candidate = repeatedClickDetector(
      [
        { t: 100, k: "net.req", d: { id: "cart", m: "POST", url: "/api/cart" } },
        { t: 200, k: "net.res", d: { id: "cart", st: 200 } },
        {
          t: 250,
          k: "db.diff",
          d: {
            engine: "sqlite",
            op: "update",
            table: "cart_items",
            pk: { id: 1 },
            after: { quantity: 1 },
            requestId: "cart",
          },
        },
        click(1000, "target-a"),
        click(1400, "target-a"),
        click(1800, "target-a"),
        click(2200, "target-a"),
      ],
      true,
    );

    expect(candidate?.detector).toBe("repeated_clicks");
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

  it("stays silent when the activation group initiates a request", () => {
    const events = [
      click(100, "target-a"),
      click(500, "target-a"),
      click(900, "target-a"),
      { t: 1_000, k: "net.req", d: { id: "r1", m: "POST", url: "/checkout" } },
    ] satisfies BugEvent[];

    expect(repeatedClickDetector(events, true)).toBeUndefined();
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
