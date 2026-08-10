// Every emitted detector has a DECIDED causal anchoring, or the build fails.
//
// The defect this closes is not any one unmapped detector. It is that
// `nodeKindsForDetector` ended in a silent empty default, so a detector that
// could not be placed produced `causalRole: "isolated"` — indistinguishable from
// a detector genuinely unrelated to the incident — and `causal_chain` went null
// with no way to tell the two apart. Four detectors were added to that table one
// at a time, each comment recording that it was the same failure paid for again.
//
// So this file does not assert that the mapping is COMPLETE. It asserts that
// every gap in it is a decision somebody made, and that the number of undecided
// ones can only go down.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DETECTOR_ANCHORING_DECLARED,
  DETECTOR_ANCHORING_UNREVIEWED,
} from "../causal-graph";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/**
 * The detectors the SDK can actually emit, read from the source that emits them.
 *
 * Extraction, not a maintained list: a second hand-kept list of detector names
 * would drift from the first and this test would grade the drift instead of the
 * product. The floor below is what makes the extraction safe to trust.
 */
function emittedDetectors(): string[] {
  const source = fs.readFileSync(path.join(SRC, "evidence-index.ts"), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/detector:\s*"([a-z0-9_]+)"/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * Anchorings expressed as rules rather than as names, mirrored from
 * `nodeKindsForDetector`. Read from the source for the same reason as above: a
 * restated copy would let the two drift apart silently.
 */
function ruleCoveredDetectors(): { prefixes: string[]; explicit: Set<string> } {
  const source = fs.readFileSync(path.join(SRC, "causal-graph.ts"), "utf8");
  const start = source.indexOf("function nodeKindsForDetector");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n}\n", start));

  const prefixes = [...body.matchAll(/startsWith\("([a-z_]+)"\)/g)].map((m) => m[1]);
  const explicit = new Set([...body.matchAll(/case "([a-z0-9_]+)"/g)].map((m) => m[1]));

  const dbBlock = source.match(/DB_WRITE_DETECTORS = new Set\(\[([\s\S]*?)\]\)/);
  expect(dbBlock).not.toBeNull();
  for (const m of dbBlock![1].matchAll(/"([a-z0-9_]+)"/g)) explicit.add(m[1]);

  return { prefixes, explicit };
}

/**
 * The count frozen when this ratchet was installed, measured on the tree that
 * installed it. It may go DOWN — reviewing a detector is a one-line change — and
 * it may never go up.
 */
const UNREVIEWED_AT_INSTALL = 77;

describe("causal anchoring is declared, never defaulted", () => {
  it("extracts a plausible number of detectors, or says so instead of passing", () => {
    // The load-bearing control. If `evidence-index.ts` stops writing
    // `detector: "..."` literally, the extraction returns a handful of names,
    // every other assertion here passes vacuously, and this file becomes a green
    // check over nothing.
    expect(emittedDetectors().length).toBeGreaterThanOrEqual(90);
  });

  it("gives every emitted detector a mapping, a prefix rule, or a written decision", () => {
    const { prefixes, explicit } = ruleCoveredDetectors();
    const undecided = emittedDetectors().filter(
      (detector) =>
        !explicit.has(detector) &&
        !prefixes.some((prefix) => detector.startsWith(prefix)) &&
        !DETECTOR_ANCHORING_DECLARED.has(detector) &&
        !DETECTOR_ANCHORING_UNREVIEWED.has(detector),
    );
    expect(
      undecided,
      `these detectors fall through to the empty default with no decision recorded: ${undecided.join(", ")}. Map them in nodeKindsForDetector, or declare them in DETECTOR_ANCHORING_DECLARED with the reason they have no node.`,
    ).toEqual([]);
  });

  it("never lets the undecided count grow", () => {
    expect(DETECTOR_ANCHORING_UNREVIEWED.size).toBeLessThanOrEqual(UNREVIEWED_AT_INSTALL);
  });

  it("keeps the two lists disjoint", () => {
    // A detector in both is a decision recorded twice with two different answers.
    const both = [...DETECTOR_ANCHORING_DECLARED.keys()].filter((d) =>
      DETECTOR_ANCHORING_UNREVIEWED.has(d),
    );
    expect(both).toEqual([]);
  });

  it("requires a real reason on every reviewed declaration", () => {
    // "n/a" is not a decision. A reason short enough to be a placeholder is one.
    for (const [detector, reason] of DETECTOR_ANCHORING_DECLARED) {
      expect(reason.length, `${detector} needs a reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  it("does not declare a detector the SDK never emits", () => {
    // A stale entry is worse than a missing one: it reads as coverage.
    const emitted = new Set(emittedDetectors());
    const ghosts = [
      ...DETECTOR_ANCHORING_DECLARED.keys(),
      ...DETECTOR_ANCHORING_UNREVIEWED,
    ].filter((detector) => !emitted.has(detector));
    expect(ghosts).toEqual([]);
  });
});
