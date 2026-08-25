// Every kind an SDK in this repo can EMIT is a kind this build says it can
// index, or the build fails.
//
// The defect this closes is not any one missing kind. It is that
// INDEXED_EVENT_KINDS is a hand-kept list of strings sitting next to the
// constants that define those same strings, so a kind could be added, emitted,
// read by a detector, and still be reported back to the sender as unrecognized
// — `backend.warning` was, for its whole life, and `capture.gap` was listed
// under a spelling nothing has ever sent. The list also decides the
// `nothing_indexable` session warning, so a session made entirely of one of
// these kinds was told none of its evidence counted.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { INDEXED_EVENT_KINDS } from "../event-kinds";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_SRC = path.resolve(HERE, "..");
const CORE_SRC = path.resolve(HERE, "../../../core/src");

/** Every `.ts` file under a directory, tests excluded. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Event kinds declared as constants, read from the source that declares them.
 *
 * Extraction, not a maintained list: a second hand-kept list would drift from
 * the first exactly the way the one under test did. The floor below is what
 * makes the extraction safe to trust.
 */
function declaredEventKinds(): Map<string, string> {
  const found = new Map<string, string>();
  // Anchored at the end of the name so `COLD_EVENTS_ARTIFACT` (a filename) is
  // not mistaken for a kind.
  const pattern =
    /(?:export\s+)?const\s+([A-Z0-9_]+_EVENT(?:_KIND)?)\s*=\s*"([a-z0-9._-]+)"/g;
  for (const file of [...sourceFiles(NODE_SRC), ...sourceFiles(CORE_SRC)]) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      found.set(match[2], `${match[1]} (${path.basename(file)})`);
    }
  }
  return found;
}

/**
 * Kinds that ARE emitted and are knowingly not indexed, each with the reason.
 *
 * Frozen by name, and that is the ratchet: entries may leave this list by being
 * indexed or by stopping being emitted. Nothing may join it — a new kind arrives
 * either indexed or with a decision recorded here.
 */
const NOT_INDEXED_BY_DECISION: ReadonlyMap<string, string> = new Map([
  [
    "probe.result",
    "emitted by the browser SDK's page probe; post-process reads probe.ready and probe.error but has never read the result payload, so listing it would claim an index that does not exist",
  ],
]);

describe("INDEXED_EVENT_KINDS covers what the SDKs emit", () => {
  it("extracts a plausible number of declared kinds, or says so instead of passing", () => {
    // The load-bearing control. If the constants stop matching this shape the
    // extraction returns a handful of names and every assertion below passes
    // vacuously.
    expect(declaredEventKinds().size).toBeGreaterThanOrEqual(15);
  });

  it("indexes every kind declared as an event-kind constant", () => {
    const declared = declaredEventKinds();
    const missing = [...declared.entries()]
      .filter(
        ([kind]) =>
          !INDEXED_EVENT_KINDS.has(kind) && !NOT_INDEXED_BY_DECISION.has(kind),
      )
      .map(([kind, where]) => `${kind} — ${where}`);
    expect(
      missing,
      `these kinds are emitted but reported back to the sender as unrecognized, and contribute to no index: ${missing.join(", ")}. Add them to INDEXED_EVENT_KINDS, or stop emitting them.`,
    ).toEqual([]);
  });

  it("never lets an unindexed kind become a decision nobody wrote down", () => {
    // The exceptions have to stay real: a kind listed here that IS indexed, or
    // one that no longer exists, is a stale excuse rather than a decision.
    const declared = declaredEventKinds();
    for (const kind of NOT_INDEXED_BY_DECISION.keys()) {
      expect(declared.has(kind), `${kind} is no longer emitted`).toBe(true);
      expect(INDEXED_EVENT_KINDS.has(kind), `${kind} is indexed now`).toBe(
        false,
      );
    }
  });

  it("indexes the kinds detectors read that no constant names", () => {
    // `backend.http` has no constant in this repo — it arrives from a host's own
    // instrumentation — but the payment and checkout boundary detectors read it,
    // so it is as indexable as anything with a constant behind it.
    expect(INDEXED_EVENT_KINDS.has("backend.http")).toBe(true);
  });
});
