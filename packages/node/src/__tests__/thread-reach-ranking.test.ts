import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { buildCausalGraph } from "../causal-graph";

/**
 * REACH — the ranker's only incident-relative term, pinned on the thing it decides: ORDER.
 *
 * A support ticket is written about what happened when the person acted. So a thread whose evidence
 * had all finished before the user's last action is, far more often than not, ambient truth about
 * the app rather than the incident being reported — and it must not lead the ranked list ahead of a
 * thread that reaches that action.
 *
 * The two threads below are made comparable BY CONSTRUCTION: the same detector fires on each, on its
 * own request, so they carry the same score and neither can bind the other into its chain. The only
 * thing separating them is when their evidence happened relative to the user's last action. That is
 * what makes the inversion between the two sessions attributable to reach and to nothing else.
 *
 * Nothing here asserts a score, a weight or a margin. The claim is ordinal, so a legitimate retune of
 * the weights leaves it green and only a change to the BEHAVIOUR can turn it red.
 */

const write = (t: number, requestId: string, table: string): BugEvent => ({
  t,
  k: "db.diff",
  d: {
    engine: "postgres",
    op: "insert",
    table,
    pk: { id: 1 },
    after: { id: 1 },
    requestId,
  },
});

/** Finishes well before the user acts. */
const earlyThread: BugEvent[] = [
  { t: 1_000, k: "backend.req.start", d: { requestId: "req-early", route: "/one" } },
  write(1_100, "req-early", "settings"),
  { t: 1_200, k: "backend.req.end", d: { requestId: "req-early", route: "/one" } },
];

/** Happens after the user acts, so it reaches the action. */
const lateThread: BugEvent[] = [
  { t: 9_000, k: "backend.req.start", d: { requestId: "req-late", route: "/two" } },
  write(9_100, "req-late", "sessions"),
  { t: 9_200, k: "backend.req.end", d: { requestId: "req-late", route: "/two" } },
];

/** The anchor: the last thing the user did, between the two threads. */
const userAction: BugEvent = {
  t: 5_000,
  k: "clk",
  d: { el: { txt: "Continue" }, route: "/two" },
};

const byTime = (events: BugEvent[]): BugEvent[] =>
  [...events].sort((a, b) => a.t - b.t);

const withUserAction = byTime([...earlyThread, userAction, ...lateThread]);
const withoutUserAction = byTime([...earlyThread, ...lateThread]);

function rank(events: BugEvent[]) {
  const candidates = buildEvidenceCandidates(
    events,
    { start: 0 },
    buildCausalGraph({ events }),
  );
  // Match on " on <table>" so one table name cannot also match another.
  const at = (table: string) =>
    candidates.findIndex((c) => c.title.includes(` on ${table}`));
  const get = (table: string) => candidates[at(table)];
  return { candidates, at, get };
}

/**
 * The premise, asserted rather than assumed: the two threads really are comparable. Without this a
 * later change that made one of them score differently, or bound the two into one thread, would let
 * the ordering assertions below pass for a reason that has nothing to do with reach.
 */
function expectComparable(events: BugEvent[]): void {
  const { at, get } = rank(events);
  const early = get("settings");
  const late = get("sessions");

  expect(at("settings")).toBeGreaterThanOrEqual(0);
  expect(at("sessions")).toBeGreaterThanOrEqual(0);
  expect(early.detector).toBe(late.detector);
  expect(early.score).toBe(late.score);
  // Separate threads: neither is bound under the other.
  expect(early.rootCauseId).not.toBe(late.id);
  expect(late.rootCauseId).not.toBe(early.id);
}

describe("thread ranking — evidence that reaches the user's last action", () => {
  it("keeps the two threads comparable in both sessions", () => {
    expectComparable(withUserAction);
    expectComparable(withoutUserAction);
  });

  it("ranks a thread that ended before the user's last action BELOW one that reaches it", () => {
    const { at } = rank(withUserAction);
    expect(at("sessions")).toBeLessThan(at("settings"));
  });

  /**
   * The other half of the term, and the half that stops it being applied blindly: with no user
   * action in the session there is no anchor, the term does not apply, and neither thread is demoted
   * for it. The two are then genuinely equal and fall to the ranker's ordinary earliest-first
   * tie-break — so this case pins that the demotion is absent, not that reach was measured.
   */
  it("demotes neither thread when the session carries no user action at all", () => {
    const { at } = rank(withoutUserAction);
    expect(at("settings")).toBeLessThan(at("sessions"));
  });
});
