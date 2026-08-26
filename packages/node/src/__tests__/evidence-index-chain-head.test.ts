import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { buildCausalGraph } from "../causal-graph";

/**
 * CHAIN HEAD — a causal chain leads with the member that PLACED it.
 *
 * A chain is positioned by its strongest member, so whichever member carries the highest effective
 * score is the reason the whole chain sits where it does. Laying the chain out root first regardless
 * therefore hands the reader a headline that is not the evidence the ranking was based on: when the
 * root is a generic observation and the named failure hangs off it, the first row is the WEAKEST
 * statement of the incident and the thing that earned the position sits below it.
 *
 * Both sessions below are synthetic and built to isolate that one decision. They differ only in
 * which member of the chain is the strongest, which is what makes the difference in outcome
 * attributable to the head rule and to nothing else. Nothing here asserts a weight, a margin or a
 * total ordering across chains — the claim is ordinal and about ONE chain, so a legitimate retune of
 * the scores leaves it green and only a change to the layout behaviour can turn it red.
 */

const T0 = 1_700_000_000_000;
const REQ = "chainheadreq0000000000000000000a";

const spine = (status: number, body?: string): BugEvent[] => [
  { t: T0, k: "clk", d: { el: { txt: "Continue" }, route: "/one" } },
  {
    t: T0 + 5,
    k: "net.req",
    d: {
      id: 1,
      method: "POST",
      url: "/api/one",
      requestId: REQ,
      traceId: REQ,
      ...(body ? { body } : {}),
    },
  },
  {
    t: T0 + 6,
    k: "backend.req.start",
    d: { requestId: REQ, method: "POST", url: "/api/one" },
  },
  {
    t: T0 + 45,
    k: "backend.req.end",
    d: {
      requestId: REQ,
      method: "POST",
      url: "/api/one",
      route: "/one",
      statusCode: status,
      durationMs: 40,
    },
  },
  { t: T0 + 46, k: "net.res", d: { id: 1, st: status, requestId: REQ } },
];

const THROWN = "Cannot read properties of undefined (reading 'total')";

/** The defective shape: the chain's root is the weaker member, its descendant the stronger. */
function weakRootSession(): Parameters<typeof buildEvidenceCandidates> {
  const events: BugEvent[] = [
    ...spine(400),
    {
      t: T0 + 60,
      k: "err",
      d: {
        msg: THROWN,
        stack: "TypeError: t\n    at render (src/one.js:12:3)",
      },
    },
  ].sort((a, b) => a.t - b.t);
  return [
    events,
    {
      start: T0 - 1_000,
      end: T0 + 5_000,
      errs: [{ t: T0 + 60, msg: THROWN, requestId: REQ }],
    } as unknown as Parameters<typeof buildEvidenceCandidates>[1],
    buildCausalGraph({ events }),
  ];
}

/** The control: the same assembly, but the root is itself the chain's strongest member. */
function strongRootSession(): Parameters<typeof buildEvidenceCandidates> {
  const events: BugEvent[] = [
    ...spine(400, JSON.stringify({ count: 3 })),
    {
      t: T0 + 20,
      k: "db.diff",
      d: {
        engine: "postgres",
        op: "update",
        table: "widgets",
        pk: { id: 1 },
        before: { id: 1, count: 2, note: "keep me" },
        after: { id: 1, count: 3, note: null },
        requestId: REQ,
      },
    },
  ].sort((a, b) => a.t - b.t);
  return [
    events,
    {
      start: T0 - 1_000,
      end: T0 + 5_000,
    } as unknown as Parameters<typeof buildEvidenceCandidates>[1],
    buildCausalGraph({ events }),
  ];
}

const rank = (args: Parameters<typeof buildEvidenceCandidates>) =>
  buildEvidenceCandidates(...args);

describe("buildEvidenceCandidates — a chain leads with the member that placed it", () => {
  const weak = rank(weakRootSession());
  const strong = rank(strongRootSession());

  /**
   * The premise, asserted rather than assumed. Without this the ordering assertions below could
   * pass because the two signals never formed a chain at all, which says nothing about the layout.
   */
  it("assembles one chain of a root and the symptom attributed to it", () => {
    for (const candidates of [weak, strong]) {
      const chain = candidates.filter((c) => c.causalRole !== "isolated");
      expect(chain).toHaveLength(2);
      const root = candidates.find((c) => c.causalRole === "root")!;
      const symptom = candidates.find((c) => c.causalRole === "symptom")!;
      expect(root).toBeDefined();
      expect(symptom).toBeDefined();
      expect(symptom.rootCauseId).toBe(root.id);
      expect(root.rootCauseId).toBeUndefined();
    }
  });

  it("heads the chain with its strongest member when that member is not the root", () => {
    expect(weak[0].causalRole).toBe("symptom");
    expect(weak[0].score).toBeGreaterThan(weak[1].score);
  });

  it("still puts the cause the head was attributed to on the very next row", () => {
    expect(weak[1].id).toBe(weak[0].rootCauseId);
  });

  it("moves the head rather than copying it, so it appears exactly once", () => {
    const ids = weak.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The emitted set must be identical to the set the same input produces with no graph at all,
    // which skips attribution and the chain layout entirely. Identity by the fields that name a
    // signal, since `id` is assigned from rank and is expected to differ.
    const [events, index] = weakRootSession();
    const identify = (list: typeof weak) =>
      list.map((c) => `${c.detector}|${c.anchor.t}`).sort();
    expect(identify(weak)).toEqual(
      identify(buildEvidenceCandidates(events, index)),
    );
  });

  it("leaves a chain whose root is already its strongest member root first", () => {
    expect(strong[0].causalRole).toBe("root");
    expect(strong[0].score).toBeGreaterThan(strong[1].score);
    expect(strong[1].rootCauseId).toBe(strong[0].id);
  });

  it("is deterministic across runs", () => {
    expect(JSON.stringify(rank(weakRootSession()))).toBe(JSON.stringify(weak));
  });
});
