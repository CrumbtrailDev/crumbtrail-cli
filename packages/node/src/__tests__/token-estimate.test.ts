import { describe, it, expect } from "vitest";
import {
  BUDGET_ENVELOPE_TOKENS,
  attachTokenEstimate,
  budgetPlane,
  estimateTokens,
  fillPlanesToBudget,
  fillPlanesWithDropReport,
  summarizeDrops,
  withPlaneValues,
} from "../token-estimate";

/** A deterministic filler item of roughly `chars` serialized characters. */
function item(id: string, chars = 200) {
  return { id, pad: "x".repeat(chars) };
}

const serialize = (value: unknown) => JSON.stringify(value, null, 2);
const refOf = (entry: { id: string }) => entry.id;

/** Kept ids for one plane path, for terse assertions. */
function keptIds(kept: ReadonlyMap<string, unknown[]>, path: string): string[] {
  return (kept.get(path) as { id: string }[]).map((entry) => entry.id);
}

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

describe("withPlaneValues", () => {
  it("writes nested paths immutably and preserves key order", () => {
    const payload = {
      schemaVersion: "test.v1",
      signals: [1, 2, 3],
      primary_window: {
        frontend: { window: null, requests: ["a", "b"] },
        db_diffs: ["d"],
      },
      trailer: true,
    };
    const out = withPlaneValues(payload, [
      ["signals", []],
      ["primary_window.frontend.requests", ["a"]],
    ]);

    expect(out).toEqual({
      schemaVersion: "test.v1",
      signals: [],
      primary_window: {
        frontend: { window: null, requests: ["a"] },
        db_diffs: ["d"],
      },
      trailer: true,
    });
    // Key order (and therefore the serialized bytes) is untouched.
    expect(Object.keys(out)).toEqual(Object.keys(payload));
    expect(
      Object.keys(
        (out.primary_window as Record<string, unknown>).frontend as Record<
          string,
          unknown
        >,
      ),
    ).toEqual(["window", "requests"]);
    // The input is not mutated.
    expect(payload.signals).toEqual([1, 2, 3]);
    expect(payload.primary_window.frontend.requests).toEqual(["a", "b"]);
  });
});

describe("fillPlanesToBudget", () => {
  it("keeps everything (no drops) when the budget fits all planes", () => {
    const signals = [item("a"), item("b")];
    const requests = [item("r1"), item("r2")];
    const { kept, dropped } = fillPlanesToBudget(
      [
        budgetPlane("signals", signals, refOf),
        budgetPlane("primary_window.frontend.requests", requests, refOf),
      ],
      { maxTokens: 100_000, baseTokens: 50 },
    );
    expect(kept.get("signals")).toEqual(signals);
    expect(kept.get("primary_window.frontend.requests")).toEqual(requests);
    expect(dropped).toEqual([]);
    expect(summarizeDrops(dropped)).toBeUndefined();
  });

  it("drops strictly from the bottom of a plane's rank order", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const costPerItem = Math.ceil(serialize(items[0]).length / 4);
    const { kept, dropped } = fillPlanesToBudget(
      [budgetPlane("signals", items, refOf)],
      { maxTokens: 100 + Math.floor(costPerItem * 2.5), baseTokens: 100 },
    );
    expect(keptIds(kept, "signals")).toEqual(["a", "b"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].plane).toBe("signals");
    expect(dropped[0].droppedRefs).toEqual(["c", "d"]);
    expect(dropped[0].droppedCount).toBe(2);
  });

  it("never drops a mid-rank item before a lower-ranked one in the same plane", () => {
    // b is huge; c is tiny and WOULD fit after a — but the kept set must stay a
    // strict prefix, so once b falls out of budget, c is dropped too.
    const items = [item("a", 100), item("b", 5000), item("c", 20)];
    const budget =
      Math.ceil(serialize(items[0]).length / 4) +
      Math.ceil(serialize(items[2]).length / 4) +
      60;
    const { kept, dropped } = fillPlanesToBudget(
      [budgetPlane("signals", items, refOf)],
      { maxTokens: budget, baseTokens: 0 },
    );
    expect(keptIds(kept, "signals")).toEqual(["a"]);
    expect(dropped[0].droppedRefs).toEqual(["b", "c"]);
  });

  it("spends the budget in plane priority order: a bulky low-priority plane never starves signals", () => {
    // The regression this checkpoint exists for: the request arrays used to be
    // fixed cost, so `signals` absorbed 100% of the drop.
    const signals = [item("cand_0001", 200), item("cand_0002", 200)];
    const requests = Array.from({ length: 10 }, (_, i) =>
      item(`req_${i}`, 400),
    );
    const { kept, dropped } = fillPlanesToBudget(
      [
        budgetPlane("signals", signals, refOf),
        budgetPlane("primary_window.frontend.requests", requests, refOf),
      ],
      { maxTokens: 300, baseTokens: 40 },
    );
    // Signals are served first and survive whole.
    expect(keptIds(kept, "signals")).toEqual(["cand_0001", "cand_0002"]);
    // The bulk plane pays for it.
    expect(
      keptIds(kept, "primary_window.frontend.requests").length,
    ).toBeLessThan(requests.length);
    expect(dropped.map((plane) => plane.plane)).toEqual([
      "primary_window.frontend.requests",
    ]);
  });

  it("is lexicographically monotonic in the budget across planes", () => {
    const signals = Array.from({ length: 6 }, (_, i) => item(`cand_${i}`, 250));
    const requests = Array.from({ length: 12 }, (_, i) =>
      item(`req_${i}`, 300),
    );
    const planes = () => [
      budgetPlane("signals", signals, refOf),
      budgetPlane("primary_window.frontend.requests", requests, refOf),
    ];

    let previous: number[] | undefined;
    for (const maxTokens of [60, 200, 500, 1200, 3000, 9000, 40_000]) {
      const { kept } = fillPlanesToBudget(planes(), {
        maxTokens,
        baseTokens: 50,
      });
      const vector = [
        kept.get("signals")!.length,
        kept.get("primary_window.frontend.requests")!.length,
      ];
      if (previous) {
        const firstDiff = vector.findIndex((v, i) => v !== previous![i]);
        if (firstDiff !== -1) {
          expect(vector[firstDiff]).toBeGreaterThan(previous[firstDiff]);
        }
      }
      previous = vector;
    }
    expect(previous).toEqual([signals.length, requests.length]);
  });

  it("keeps nothing (never throws, never loops) when the budget is below even the base", () => {
    const items = [item("a"), item("b")];
    const { kept, dropped } = fillPlanesToBudget(
      [budgetPlane("signals", items, refOf)],
      { maxTokens: 1, baseTokens: 500 },
    );
    expect(kept.get("signals")).toEqual([]);
    expect(dropped[0].droppedCount).toBe(2);
    expect(dropped[0].droppedRefs).toEqual(["a", "b"]);
  });

  it("records a kept entry for every requested plane, even empty ones", () => {
    const { kept, dropped } = fillPlanesToBudget(
      [
        budgetPlane("signals", [], refOf),
        budgetPlane("primary_window.db_diffs", [], refOf),
      ],
      { maxTokens: 1, baseTokens: 999 },
    );
    expect([...kept.keys()]).toEqual(["signals", "primary_window.db_diffs"]);
    expect(dropped).toEqual([]);
  });

  it("charges a nested plane for its deeper indentation", () => {
    const items = [item("a", 400)];
    const shallow = fillPlanesToBudget([budgetPlane("signals", items, refOf)], {
      maxTokens: 1_000_000,
      baseTokens: 0,
    }).usedTokens;
    const deep = fillPlanesToBudget(
      [budgetPlane("primary_window.frontend.requests", items, refOf)],
      { maxTokens: 1_000_000, baseTokens: 0 },
    ).usedTokens;
    expect(deep).toBeGreaterThan(shallow);
  });
});

describe("summarizeDrops", () => {
  it("names every trimmed plane, totals the drops, and caps refs at 10", () => {
    const signals = Array.from({ length: 12 }, (_, i) =>
      item(`cand_${String(i).padStart(4, "0")}`),
    );
    const requests = [item("req_0"), item("req_1")];
    const { dropped } = fillPlanesToBudget(
      [
        budgetPlane("signals", signals, refOf),
        budgetPlane("primary_window.backend.requests", requests, refOf),
      ],
      { maxTokens: 1, baseTokens: 0 },
    );
    const report = summarizeDrops(dropped)!;

    expect(report.planes.map((plane) => plane.plane)).toEqual([
      "signals",
      "primary_window.backend.requests",
    ]);
    expect(report.droppedCount).toBe(14);
    expect(report.droppedRefs).toHaveLength(10);
    expect(report.droppedRefs[0]).toBe("cand_0000");
    expect(report.message).toMatch(/^omitted 14 items, ~/);
    expect(report.message).toContain("signals");
    expect(report.message).toContain("primary_window.backend.requests");
    expect(report.message).toContain("…");
    expect(report.droppedTokenEstimate).toBeGreaterThan(0);
  });

  it("returns undefined when no plane lost anything", () => {
    expect(summarizeDrops([])).toBeUndefined();
  });

  it("uses the singular noun for a single dropped item", () => {
    const { dropped } = fillPlanesToBudget(
      [budgetPlane("signals", [item("only")], refOf)],
      { maxTokens: 1, baseTokens: 0 },
    );
    expect(summarizeDrops(dropped)!.message).toMatch(
      /^omitted 1 item, ~\d+(\.\d+)?k? tokens from signals; refs: only$/,
    );
  });
});

describe("fillPlanesWithDropReport", () => {
  const signals = Array.from({ length: 20 }, (_, i) =>
    item(`cand_${String(i).padStart(4, "0")}`, 300),
  );
  const requests = Array.from({ length: 20 }, (_, i) =>
    item(`req_${String(i).padStart(4, "0")}`, 300),
  );
  const payload: Record<string, unknown> = {
    schemaVersion: "test.v1",
    header: "h".repeat(120),
    signals,
    primary_window: { frontend: { requests } },
  };
  const planes = () => [
    budgetPlane("signals", signals, refOf),
    budgetPlane("primary_window.frontend.requests", requests, refOf),
  ];
  const baseTokens = estimateTokens(
    JSON.stringify(
      withPlaneValues(payload, [
        ["signals", []],
        ["primary_window.frontend.requests", []],
      ]),
      null,
      2,
    ),
  );

  it("keeps the final serialized response within maxTokens, with no tolerance", () => {
    // Simulate the exact MCP assembly: base measured with every plane emptied
    // PLUS the envelope reserve, fill, then attach dropReport +
    // budgetSatisfied + tokenEstimate and measure the truth over the real
    // serialization. The bound is the budget itself, not budget + a constant.
    //
    // The bound holds whenever the budget can actually pay for the fixed
    // fields, the envelope and the drop report the fill implies. Below that
    // there is no fill that fits: the report is unavoidable overhead once
    // anything is dropped, and the MCP path reports `budgetSatisfied: false`
    // rather than pretending a constant covers the gap.
    let affordableSeen = 0;
    for (const maxTokens of [
      baseTokens + 50,
      baseTokens + 400,
      baseTokens + 1200,
      baseTokens + 4000,
      estimateTokens(JSON.stringify(payload, null, 2)) + 100,
    ]) {
      const { kept, report, reservedTokens } = fillPlanesWithDropReport(
        planes(),
        { maxTokens, baseTokens: baseTokens + BUDGET_ENVELOPE_TOKENS },
      );
      const out = withPlaneValues(payload, kept);
      if (report) out.dropReport = report;
      out.budgetSatisfied = true;
      const final = attachTokenEstimate(out);
      const finalText = JSON.stringify(final, null, 2);
      expect(final.tokenEstimate).toBe(estimateTokens(finalText));
      if (baseTokens + BUDGET_ENVELOPE_TOKENS + reservedTokens <= maxTokens) {
        affordableSeen += 1;
        expect(estimateTokens(finalText)).toBeLessThanOrEqual(maxTokens);
      }
    }
    expect(affordableSeen).toBeGreaterThan(0);
  });

  it("charges every non-empty array's closing bracket, so the bound survives zero per-item slack", () => {
    // The band the per-item ceiling normally hides. `itemCost` rounds up per
    // item, and that rounding slack usually absorbs the one cost it does not
    // model: the base measurement serialized each plane as a bare `[]`, but a
    // non-empty array closes with "\n" + its own indent + "]". Size the items
    // so every itemCost is exact and the slack disappears, spread six arrays
    // over four depths, and the unmodelled columns add up to a real overrun.
    // Unless the fill pays for each array's closing bracket, the final
    // serialization exceeds maxTokens here even though the fixed fields, the
    // envelope and the drop report all fit.
    const paths = [
      "signals",
      "recommendations",
      "primary_window.events",
      "primary_window.frontend.requests",
      "primary_window.backend.requests",
      "primary_window.backend.logs",
    ];
    const indentOf = (path: string) => 2 * (path.split(".").length + 1);
    // A JSON string is one line, so it costs `length + indent + 2` columns.
    // Round its length up until that total is a multiple of 4: no slack.
    const alignedLength = (indent: number, approx: number) => {
      let length = approx;
      while ((length + indent + 2) % 4 !== 0) length += 1;
      return length;
    };

    let affordableSeen = 0;
    let tightSeen = 0;
    for (const perPlane of [2, 4, 6]) {
      for (const approx of [43, 63, 83]) {
        const lists = paths.map((path, planeIndex) =>
          Array.from({ length: perPlane }, (_, i) => {
            const ref = `r${planeIndex}${String(i).padStart(2, "0")}`;
            const length = alignedLength(indentOf(path), approx);
            return ref + "x".repeat(length - 2 - ref.length);
          }),
        );
        const full = withPlaneValues(
          {
            schemaVersion: "test.v1",
            summary: "s".repeat(40),
            primary_window: { frontend: {}, backend: {} },
          },
          paths.map((path, i) => [path, lists[i]] as const),
        );
        const planes = paths.map((path, i) =>
          budgetPlane(path, lists[i], (entry: string) => entry.slice(0, 4)),
        );
        const baseTokens = estimateTokens(
          serialize(
            withPlaneValues(
              full,
              paths.map((path) => [path, []] as const),
            ),
          ),
        );

        const ceiling = estimateTokens(serialize(full));
        for (let maxTokens = baseTokens; maxTokens <= ceiling + 4; maxTokens++) {
          const { kept, report, reservedTokens } = fillPlanesWithDropReport(
            planes,
            { maxTokens, baseTokens: baseTokens + BUDGET_ENVELOPE_TOKENS },
          );
          if (baseTokens + BUDGET_ENVELOPE_TOKENS + reservedTokens > maxTokens)
            continue;
          const out = withPlaneValues(full, kept);
          if (report) out.dropReport = report;
          out.budgetSatisfied = true;
          const estimate = estimateTokens(serialize(attachTokenEstimate(out)));

          affordableSeen += 1;
          if (estimate >= maxTokens - 8) tightSeen += 1;
          expect(estimate).toBeLessThanOrEqual(maxTokens);
        }
      }
    }
    // Guard the guard. A fixture that never comes near its budget would pass
    // the bound above without exercising the accounting this test exists to
    // pin, which is exactly how the previous version of this check stayed
    // green over a cost model that could overrun. Without the closing-bracket
    // charge these same points reach 3 tokens PAST the budget; with it the
    // tightest lands 4 tokens under.
    expect(affordableSeen).toBeGreaterThan(0);
    expect(tightSeen).toBeGreaterThan(0);
  });

  it("reserves the drop report's own cost out of the budget, not out of the slack", () => {
    const maxTokens = baseTokens + 1200;
    const unreserved = fillPlanesToBudget(planes(), { maxTokens, baseTokens });
    const reserved = fillPlanesWithDropReport(planes(), {
      maxTokens,
      baseTokens,
    });
    expect(reserved.reservedTokens).toBeGreaterThan(0);
    expect(reserved.kept.get("signals")!.length).toBeLessThanOrEqual(
      unreserved.kept.get("signals")!.length,
    );
  });

  it("folds an extra non-array drop into the report", () => {
    const { report } = fillPlanesWithDropReport(
      planes(),
      { maxTokens: baseTokens + 400, baseTokens },
      () => ({
        plane: "causal_chain",
        droppedCount: 1,
        droppedTokenEstimate: 42,
        droppedRefs: ["cand_0019"],
      }),
    );
    expect(report!.planes.map((plane) => plane.plane)).toContain(
      "causal_chain",
    );
  });

  it("reserves nothing when the whole payload fits", () => {
    const outcome = fillPlanesWithDropReport(planes(), {
      maxTokens: 1_000_000,
      baseTokens,
    });
    expect(outcome.report).toBeUndefined();
    expect(outcome.reservedTokens).toBe(0);
    expect(outcome.kept.get("signals")).toEqual(signals);
  });
});

describe("attachTokenEstimate", () => {
  it("reaches a fixed point: the estimate covers the serialized payload including itself", () => {
    const out = attachTokenEstimate({ a: 1, b: "x".repeat(500) });
    expect(out.tokenEstimate).toBe(
      estimateTokens(JSON.stringify(out, null, 2)),
    );
  });

  it("pins the envelope reserve to the real cost of the two appended fields", () => {
    // budgetSatisfied + tokenEstimate are the only budgeting fields written
    // after every measurement the fill can take, so the reserve has to cover
    // exactly them and nothing more. A constant big enough to also swallow a
    // small budget is what let a 51% overrun report budgetSatisfied: true.
    const withoutEnvelope = JSON.stringify({ a: 1 }, null, 2);
    const withEnvelope = JSON.stringify(
      { a: 1, budgetSatisfied: false, tokenEstimate: 123456 },
      null,
      2,
    );
    const realCost =
      estimateTokens(withEnvelope) - estimateTokens(withoutEnvelope);
    expect(BUDGET_ENVELOPE_TOKENS).toBeGreaterThanOrEqual(realCost);
    expect(BUDGET_ENVELOPE_TOKENS).toBeLessThan(realCost + 8);
  });
});
