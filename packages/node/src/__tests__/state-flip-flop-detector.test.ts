import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// The live case: order #1's status went placed → delivered → placed →
// refunded → shipped inside 31 ms, every write a 200, and the ranking showed
// only generic db_mutation candidates. The domain-free invariant is the
// revisit — a lifecycle value that was held, left, and reached again.

function update(
  t: number,
  table: string,
  pk: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  requestId = "req-1",
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op: "update", table, pk, before, after, requestId },
  } as unknown as BugEvent;
}

function flipFlops(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (c) => c.detector === "state_flip_flop",
  );
}

describe("buildEvidenceCandidates — state_flip_flop", () => {
  it("fires when a status value is held, left, and reached again", () => {
    const events = [
      update(1000, "orders", { id: 1 }, { status: "placed" }, { status: "delivered" }),
      update(1010, "orders", { id: 1 }, { status: "delivered" }, { status: "placed" }),
      update(1020, "orders", { id: 1 }, { status: "placed" }, { status: "refunded" }),
      update(1030, "orders", { id: 1 }, { status: "refunded" }, { status: "shipped" }),
    ];

    const hits = flipFlops(events);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe(
      'State went backward: orders.status returned to "placed"',
    );
    expect(hits[0].severity).toBe("high");
    expect(String(hits[0].anchor.message)).toContain(
      "placed → delivered → placed → refunded → shipped",
    );
  });

  it("stays silent on a lifecycle that only moves forward", () => {
    const events = [
      update(1000, "orders", { id: 1 }, { status: "placed" }, { status: "shipped" }),
      update(1010, "orders", { id: 1 }, { status: "shipped" }, { status: "delivered" }),
    ];
    expect(flipFlops(events)).toHaveLength(0);
  });

  it("keeps different rows' lifecycles separate", () => {
    // Row 1 goes placed→shipped, row 2 goes shipped→placed: each row is
    // internally consistent, so no revisit exists anywhere.
    const events = [
      update(1000, "orders", { id: 1 }, { status: "placed" }, { status: "shipped" }),
      update(1010, "orders", { id: 2 }, { status: "shipped" }, { status: "placed" }),
    ];
    expect(flipFlops(events)).toHaveLength(0);
  });

  it("ignores boolean toggles and non-lifecycle columns", () => {
    const events = [
      // A user flipping a switch twice is A→B→A by design.
      update(1000, "features", { id: 1 }, { enabled: "on" }, { enabled: "off" }),
      update(1010, "features", { id: 1 }, { enabled: "off" }, { enabled: "on" }),
      // Quantity going down and back up is commerce, not a state machine.
      update(1020, "products", { id: 1 }, { stock: "9" }, { stock: "8" }),
      update(1030, "products", { id: 1 }, { stock: "8" }, { stock: "9" }),
    ];
    expect(flipFlops(events)).toHaveLength(0);
  });

  it("seeds the chain from the first update's before image", () => {
    // The insert's after image may be redacted; the first update's before
    // value carries the starting state. placed → delivered → placed must fire
    // even though "placed" was never an after value twice.
    const events = [
      update(1000, "orders", { id: 1 }, { status: "placed" }, { status: "delivered" }),
      update(1010, "orders", { id: 1 }, { status: "delivered" }, { status: "placed" }),
    ];
    const hits = flipFlops(events);
    expect(hits).toHaveLength(1);
    expect(String(hits[0].anchor.message)).toContain("placed → delivered → placed");
  });
});
