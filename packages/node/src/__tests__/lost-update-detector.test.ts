import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function update(
  t: number,
  requestId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  table = "carts",
  pk: Record<string, unknown> = { id: 1 },
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op: "update", table, pk, before, after, requestId },
  } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("lost_update", () => {
  it("names a read-modify-write that raced itself across two requests", () => {
    // Both writers read qty 1. The second wrote 2 from that stale read, so the
    // first writer's increment is gone and the row holds 2 instead of 3.
    const found = detectors([
      update(10, "req-a", { qty: 1 }, { qty: 2 }),
      update(20, "req-b", { qty: 1 }, { qty: 2 }),
    ]);
    expect(found).toContain("lost_update");
  });

  it("stays silent when the second writer read what the first wrote", () => {
    const found = detectors([
      update(10, "req-a", { qty: 1 }, { qty: 2 }),
      update(20, "req-b", { qty: 2 }, { qty: 3 }),
    ]);
    expect(found).not.toContain("lost_update");
  });

  it("stays silent on two writes from one request", () => {
    // A handler that updates the same row twice wrote a sequence on purpose.
    const found = detectors([
      update(10, "req-a", { qty: 1 }, { qty: 2 }),
      update(20, "req-a", { qty: 1 }, { qty: 2 }),
    ]);
    expect(found).not.toContain("lost_update");
  });

  it("stays silent on writes to different rows", () => {
    const found = detectors([
      update(10, "req-a", { qty: 1 }, { qty: 2 }, "carts", { id: 1 }),
      update(20, "req-b", { qty: 1 }, { qty: 2 }, "carts", { id: 2 }),
    ]);
    expect(found).not.toContain("lost_update");
  });

  it("stays silent when the two writers disagree on the new value", () => {
    // Stale read, but the writes differ, so an absolute `SET qty = n` cannot be
    // told apart from a lost increment. Ambiguity stays quiet.
    const found = detectors([
      update(10, "req-a", { qty: 1 }, { qty: 5 }),
      update(20, "req-b", { qty: 1 }, { qty: 9 }),
    ]);
    expect(found).not.toContain("lost_update");
  });

  it("ignores identity and clock columns, which are supposed to differ", () => {
    const found = detectors([
      update(10, "req-a", { updated_at: 100 }, { updated_at: 200 }),
      update(20, "req-b", { updated_at: 100 }, { updated_at: 300 }),
    ]);
    expect(found).not.toContain("lost_update");
  });

  it("cannot fire without before images", () => {
    const noBefore = [
      { t: 10, k: "db.diff", d: { op: "update", table: "carts", pk: { id: 1 }, after: { qty: 2 }, requestId: "a" } },
      { t: 20, k: "db.diff", d: { op: "update", table: "carts", pk: { id: 1 }, after: { qty: 2 }, requestId: "b" } },
    ] as unknown as BugEvent[];
    expect(detectors(noBefore)).not.toContain("lost_update");
  });
});
