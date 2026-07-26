import { describe, expect, it } from "vitest";
import { buildReplayFlow, flowCarriesSecret } from "../replay/flow";
import type { ReplayFlowEvent } from "../replay/flow";

const TARGET = "http://localhost:4173";

function flowOf(events: ReplayFlowEvent[], targetUrl = TARGET) {
  return buildReplayFlow({ sourceSessionId: "ses_src_001", events, targetUrl });
}

describe("buildReplayFlow", () => {
  it("distils nav/clk/inp events into an ordered flow", () => {
    const flow = flowOf([
      { k: "nav", d: { to: "https://shop.example.com/cart" } },
      { k: "perf", d: { metric: "lcp" } },
      {
        k: "inp",
        d: {
          el: {
            sig: "sig-qty",
            path: "#qty",
            tag: "INPUT",
            type: "number",
            name: "qty",
          },
          val: "3",
        },
      },
      {
        k: "clk",
        d: {
          el: {
            sig: "sig-checkout",
            path: "#checkout",
            tag: "BUTTON",
            txt: "Checkout",
          },
        },
      },
    ]);

    expect(flow.sourceSessionId).toBe("ses_src_001");
    expect(flow.targetUrl).toBe(TARGET);
    expect(flow.capturedOrigin).toBe("https://shop.example.com");
    expect(flow.steps).toEqual([
      { index: 0, sig: "nav:/cart", action: "navigate", path: "/cart" },
      {
        index: 1,
        sig: "sig-qty",
        action: "input",
        selector: "#qty",
        tag: "input",
        role: "textbox",
        label: "qty",
        value: { kind: "literal", value: "3" },
      },
      {
        index: 2,
        sig: "sig-checkout",
        action: "click",
        selector: "#checkout",
        tag: "button",
        role: "button",
        label: "Checkout",
      },
    ]);
  });

  it("rebases navigation onto a path so the captured origin is never carried", () => {
    const flow = flowOf([
      { k: "nav", d: { to: "https://prod.example.com/orders/17?view=grid" } },
    ]);

    expect(flow.steps[0]).toMatchObject({
      action: "navigate",
      path: "/orders/17?view=grid",
    });
    expect(JSON.stringify(flow.steps)).not.toContain("prod.example.com");
  });

  it("drops a credential-bearing query parameter and flags it", () => {
    const flow = flowOf([
      {
        k: "nav",
        d: { to: "https://prod.example.com/cb?access_token=abc123" },
      },
    ]);

    expect(flow.steps[0]).toMatchObject({
      action: "navigate",
      path: "/cb",
      queryWithheld: true,
    });
    expect(JSON.stringify(flow.steps)).not.toContain("abc123");
  });

  it("keeps benign query parameters while dropping the credential-bearing one", () => {
    const flow = flowOf([
      {
        k: "nav",
        d: { to: "https://prod.example.com/list?view=grid&apiKey=k-9&page=2" },
      },
    ]);

    expect(flow.steps[0]).toMatchObject({
      action: "navigate",
      path: "/list?view=grid&page=2",
      queryWithheld: true,
    });
    expect(JSON.stringify(flow.steps)).not.toContain("k-9");
  });

  it("skips non-http navigations and events without an element signature", () => {
    const flow = flowOf([
      { k: "nav", d: { to: "about:blank" } },
      { k: "nav", d: { to: "not a url" } },
      { k: "clk", d: { el: { path: "#no-sig" } } },
      { k: "clk", d: null },
      { k: "inp", d: {} },
    ]);

    expect(flow.steps).toEqual([]);
  });

  it("marks a redacted input value rather than inventing one", () => {
    const flow = flowOf([
      {
        k: "inp",
        d: {
          el: { sig: "s1", path: "#note", tag: "INPUT" },
          val: "[REDACTED]",
        },
      },
    ]);

    expect(flow.steps[0].value).toEqual({ kind: "redacted" });
  });

  it("treats a missing value as redacted", () => {
    const flow = flowOf([
      { k: "inp", d: { el: { sig: "s1", path: "#note", tag: "INPUT" } } },
    ]);

    expect(flow.steps[0].value).toEqual({ kind: "redacted" });
  });

  it("drops a password field value and marks the step secret", () => {
    const flow = flowOf([
      {
        k: "inp",
        d: {
          el: { sig: "s-pw", path: "#pw", tag: "INPUT", type: "password" },
          val: "hunter2-plaintext",
        },
      },
    ]);

    expect(flow.steps[0].value).toMatchObject({ kind: "secret" });
    expect(JSON.stringify(flow)).not.toContain("hunter2-plaintext");
    expect(flowCarriesSecret(flow)?.sig).toBe("s-pw");
  });

  it("drops a sensitively named field value even when the type is plain text", () => {
    const flow = flowOf([
      {
        k: "inp",
        d: {
          el: {
            sig: "s-key",
            path: "#k",
            tag: "INPUT",
            type: "text",
            name: "apiKey",
          },
          val: "plain-but-named-secret",
        },
      },
    ]);

    expect(flow.steps[0].value).toMatchObject({ kind: "secret" });
    expect(JSON.stringify(flow)).not.toContain("plain-but-named-secret");
  });

  it("drops a token-shaped value from an innocuously named field", () => {
    const token = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(40)}.${"b".repeat(40)}`;
    const flow = flowOf([
      {
        k: "inp",
        d: {
          el: { sig: "s-note", path: "#note", tag: "INPUT", type: "text" },
          val: token,
        },
      },
    ]);

    expect(flow.steps[0].value).toMatchObject({ kind: "secret" });
    expect(JSON.stringify(flow)).not.toContain(token);
  });

  it("derives roles from tag and input type", () => {
    const flow = flowOf([
      { k: "clk", d: { el: { sig: "a", tag: "A", txt: "Home" } } },
      { k: "clk", d: { el: { sig: "b", tag: "INPUT", type: "checkbox" } } },
      { k: "clk", d: { el: { sig: "c", tag: "SELECT" } } },
      { k: "clk", d: { el: { sig: "d", tag: "DIV", role: "TAB" } } },
    ]);

    expect(flow.steps.map((step) => step.role)).toEqual([
      "link",
      "checkbox",
      "combobox",
      "tab",
    ]);
  });

  it("returns no steps and no captured origin for an empty session", () => {
    const flow = flowOf([]);

    expect(flow.steps).toEqual([]);
    expect(flow.capturedOrigin).toBeUndefined();
  });
});

describe("flowCarriesSecret", () => {
  it("returns undefined when no step depends on a credential", () => {
    const flow = flowOf([
      { k: "clk", d: { el: { sig: "s1", path: "#go", tag: "BUTTON" } } },
    ]);

    expect(flowCarriesSecret(flow)).toBeUndefined();
  });
});
