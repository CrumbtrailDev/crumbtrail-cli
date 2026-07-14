import { describe, it, expect } from "vitest";
import {
  BUDGET_SLACK_TOKENS,
  attachTokenEstimate,
  estimateTokens,
  fillToBudget,
} from "../token-estimate";

/** A deterministic filler item of roughly `chars` serialized characters. */
function item(id: string, chars = 200) {
  return { id, pad: "x".repeat(chars) };
}

const serialize = (value: unknown) => JSON.stringify(value, null, 2);

describe("estimateTokens", () => {
  it("is Math.ceil(chars / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(8))).toBe(2);
    expect(estimateTokens("x".repeat(9))).toBe(3);
  });
});

describe("fillToBudget", () => {
  const refOf = (entry: { id: string }) => entry.id;

  it("keeps everything (no report) when the budget fits all items", () => {
    const items = [item("a"), item("b"), item("c")];
    const { kept, report } = fillToBudget(items, {
      maxTokens: 100_000,
      baseTokens: 50,
      refOf,
      serialize,
    });
    expect(kept).toEqual(items);
    expect(report).toBeUndefined();
  });

  it("drops strictly from the bottom of the rank order", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const costPerItem = Math.ceil(serialize(items[0]).length / 4);
    // Budget for roughly two items.
    const { kept, report } = fillToBudget(items, {
      maxTokens: 100 + Math.floor(costPerItem * 2.5),
      baseTokens: 100,
      refOf,
      serialize,
    });
    expect(kept.map(refOf)).toEqual(["a", "b"]);
    expect(report!.droppedRefs).toEqual(["c", "d"]);
    expect(report!.droppedCount).toBe(2);
  });

  it("never drops a mid-rank item before a lower-ranked one, even when the lower one would fit", () => {
    // b is huge; c is tiny and WOULD fit after a — but the kept set must stay a
    // strict prefix, so once b falls out of budget, c is dropped too.
    const items = [item("a", 100), item("b", 5000), item("c", 20)];
    const budget =
      Math.ceil(serialize(items[0]).length / 4) +
      Math.ceil(serialize(items[2]).length / 4) +
      60; // fits a + c comfortably, nowhere near b
    const { kept, report } = fillToBudget(items, {
      maxTokens: budget,
      baseTokens: 0,
      refOf,
      serialize,
    });
    expect(kept.map(refOf)).toEqual(["a"]);
    expect(report!.droppedRefs).toEqual(["b", "c"]);
  });

  it("reports shape and message for drops", () => {
    const items = [item("keep"), item("drop_1"), item("drop_2")];
    // Fits item one (standalone estimate + a small margin for the in-array
    // overhead), but nowhere near two items.
    const { report } = fillToBudget(items, {
      maxTokens: Math.ceil(serialize(items[0]).length / 4) + 20,
      baseTokens: 0,
      refOf,
      serialize,
    });
    expect(report).toBeDefined();
    expect(report!.droppedCount).toBe(2);
    expect(report!.droppedTokenEstimate).toBeGreaterThan(0);
    expect(report!.droppedRefs).toEqual(["drop_1", "drop_2"]);
    expect(report!.message).toMatch(
      /^omitted 2 items, ~\d+(\.\d+)?k? tokens, refs: drop_1, drop_2$/,
    );
  });

  it("caps droppedRefs at 10 and marks the message with an ellipsis", () => {
    const items = Array.from({ length: 16 }, (_, i) =>
      item(`ref_${String(i).padStart(2, "0")}`),
    );
    const { kept, report } = fillToBudget(items, {
      maxTokens: 1,
      baseTokens: 0,
      refOf,
      serialize,
    });
    expect(kept).toEqual([]);
    expect(report!.droppedCount).toBe(16);
    expect(report!.droppedRefs).toHaveLength(10);
    expect(report!.droppedRefs[0]).toBe("ref_00");
    expect(report!.message).toContain("…");
  });

  it("keeps nothing (never throws, never loops) when the budget is below even the base", () => {
    const items = [item("a"), item("b")];
    const { kept, report } = fillToBudget(items, {
      maxTokens: 1,
      baseTokens: 500,
      refOf,
      serialize,
    });
    expect(kept).toEqual([]);
    expect(report!.droppedCount).toBe(2);
    expect(report!.droppedRefs).toEqual(["a", "b"]);
  });

  it("returns no report for an empty item list", () => {
    expect(
      fillToBudget([], { maxTokens: 1, baseTokens: 999, refOf, serialize }),
    ).toEqual({ kept: [] });
  });

  it("keeps the final serialized response within maxTokens + BUDGET_SLACK_TOKENS", () => {
    // Simulate the exact MCP assembly: payload with an item array under a
    // top-level key, base measured with the array emptied, fill, then attach
    // dropReport + tokenEstimate and measure the true final serialization.
    const items = Array.from({ length: 30 }, (_, i) =>
      item(`cand_${String(i).padStart(4, "0")}`, 300),
    );
    const payload: Record<string, unknown> = {
      schemaVersion: "test.v1",
      header: "h".repeat(120),
      ranked: items,
    };
    const baseTokens = estimateTokens(
      JSON.stringify({ ...payload, ranked: [] }, null, 2),
    );

    for (const maxTokens of [
      baseTokens + 50,
      baseTokens + 400,
      baseTokens + 1200,
      estimateTokens(JSON.stringify(payload, null, 2)) + 100,
    ]) {
      const { kept, report } = fillToBudget(items, {
        maxTokens,
        baseTokens,
        refOf,
        serialize,
      });
      const out: Record<string, unknown> = { ...payload, ranked: kept };
      if (report) out.dropReport = report;
      const final = attachTokenEstimate(out);
      const finalText = JSON.stringify(final, null, 2);
      expect(estimateTokens(finalText)).toBeLessThanOrEqual(
        maxTokens + BUDGET_SLACK_TOKENS,
      );
      expect(final.tokenEstimate).toBe(estimateTokens(finalText));
    }
  });
});

describe("attachTokenEstimate", () => {
  it("reaches a fixed point: the estimate covers the serialized payload including itself", () => {
    const out = attachTokenEstimate({ a: 1, b: "x".repeat(500) });
    expect(out.tokenEstimate).toBe(
      estimateTokens(JSON.stringify(out, null, 2)),
    );
  });

  it("exports the pinned slack constant", () => {
    expect(BUDGET_SLACK_TOKENS).toBe(256);
  });
});
