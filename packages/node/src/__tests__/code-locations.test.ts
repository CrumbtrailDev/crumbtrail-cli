// Where each ranked signal physically came from.
//
// The failure this exists to prevent, measured on the harness: an engineer given
// a bundle that recorded `maxPrice=28` leaving the browser spent thirty turns and
// most of a million tokens reading the application to find the line that built
// that number. The evidence named the symptom exactly and the source not at all.
//
// The failure this must not CAUSE is the opposite one: a location that is wrong.
// A missing path makes a reader search; a wrong path sends them somewhere
// confidently irrelevant, and unlike a missing one it does not announce itself.
// So every test here is either "the fact survives" or "the guess is refused".

import { describe, expect, it } from "vitest";

import {
  MAX_CALLER_FRAMES,
  MAX_CODE_LOCATIONS,
  buildCodeLocations,
  parseFrame,
} from "../code-locations";
import type { EvidenceCandidate } from "../evidence-index";
import type { LlmBundle } from "../llm-bundle";

const candidate = (over: Partial<EvidenceCandidate> = {}): EvidenceCandidate =>
  ({
    schemaVersion: 1,
    id: "cand_0001",
    detector: "http_error",
    title: "GET /api/search returned an empty result set",
    severity: "high",
    score: 90,
    confidence: "high",
    anchor: { t: 1 },
    ...over,
  }) as unknown as EvidenceCandidate;

const bundleWith = (databaseDiffs: unknown[]): LlmBundle =>
  ({ databaseDiffs }) as unknown as LlmBundle;

describe("parseFrame", () => {
  it("reads a file, line and column", () => {
    expect(parseFrame("client/src/lib/api-search.js:59:21")).toEqual({
      path: "client/src/lib/api-search.js",
      line: 59,
      column: 21,
    });
  });

  it("accepts a frame with no column", () => {
    expect(parseFrame("server/src/routes/search.js:12")).toEqual({
      path: "server/src/routes/search.js",
      line: 12,
    });
  });

  it("refuses anything that is not a location", () => {
    // `anchor.source` carries provenance labels — "backend", a transport name.
    // Accepting those here fills the field with strings that look like paths and
    // open nothing, which is the wrong-location failure in its cheapest form.
    for (const junk of ["backend", "", "   ", "otel", undefined, null, 42, {}]) {
      expect(parseFrame(junk)).toBeUndefined();
    }
  });

  it("keeps a windows-style path intact rather than splitting on its drive letter", () => {
    expect(parseFrame("C:\\app\\src\\repo.js:7:3")).toEqual({
      path: "C:\\app\\src\\repo.js",
      line: 7,
      column: 3,
    });
  });
});

describe("buildCodeLocations", () => {
  it("returns undefined when nothing was captured", () => {
    // Not an empty array. A consumer must be able to tell "the SDK was not
    // capturing callsites" from "it was, and there were none"; an empty list
    // reads as the second and is almost always the first.
    expect(buildCodeLocations(undefined, [])).toBeUndefined();
    expect(buildCodeLocations(bundleWith([]), [candidate()])).toBeUndefined();
  });

  it("carries the frame a candidate reported, with the signal that backs it", () => {
    const locations = buildCodeLocations(undefined, [
      candidate({ anchor: { t: 1, frame: "client/src/lib/api-search.js:59:21" } } as never),
    ]);
    expect(locations).toEqual([
      {
        path: "client/src/lib/api-search.js",
        line: 59,
        column: 21,
        via: "signal",
        signalId: "cand_0001",
        signalTitle: "GET /api/search returned an empty result set",
      },
    ]);
  });

  it("prefers the structured write callsite over a candidate's flattened frame", () => {
    // The formatted string has already lost the function name and the caller
    // chain. Where both describe the same request, the structured one is the
    // better record of the same fact — not a second opinion about it.
    const locations = buildCodeLocations(
      bundleWith([
        {
          requestId: "req-1",
          callsite: {
            file: "server/src/repos/products-repo.js",
            line: 40,
            fn: "setPrice",
            stack: [{ file: "server/src/routes/admin.js", line: 12, fn: "handler" }],
          },
        },
      ]),
      [candidate({ anchor: { t: 1, requestId: "req-1", frame: "server/src/db.js:3:1" } } as never)],
    );
    expect(locations?.[0]).toMatchObject({
      path: "server/src/repos/products-repo.js",
      line: 40,
      fn: "setPrice",
      via: "db.write",
      callers: [{ path: "server/src/routes/admin.js", line: 12, fn: "handler" }],
    });
  });

  it("keeps the callers, because the innermost frame is usually a shared helper", () => {
    // `updateOrder` is named identically for every defect that touches that
    // table; the line a fix has to change sits one or two frames out.
    const stack = Array.from({ length: MAX_CALLER_FRAMES + 3 }, (_, i) => ({
      file: `server/src/layer-${i}.js`,
      line: i,
    }));
    const locations = buildCodeLocations(
      bundleWith([{ requestId: "r", callsite: { file: "server/src/repo.js", line: 1, stack } }]),
      [],
    );
    expect(locations?.[0]?.callers).toHaveLength(MAX_CALLER_FRAMES);
    expect(locations?.[0]?.callers?.[0]?.path).toBe("server/src/layer-0.js");
  });

  it("reports the ranked order, not an order of its own", () => {
    // Re-sorting these would be a second, silent opinion about what matters,
    // competing with the ranking the product already publishes.
    const locations = buildCodeLocations(undefined, [
      candidate({ id: "cand_0001", anchor: { t: 1, frame: "a.js:1" } } as never),
      candidate({ id: "cand_0002", anchor: { t: 2, frame: "b.js:2" } } as never),
      candidate({ id: "cand_0003", anchor: { t: 3, frame: "c.js:3" } } as never),
    ]);
    expect(locations?.map((l) => l.path)).toEqual(["a.js", "b.js", "c.js"]);
  });

  it("records that a frame was resolved through a source map", () => {
    // A direct frame is a fact. A mapped frame is a fact plus a build artifact
    // that may be stale, and a reader who opens the wrong line deserves to know
    // which of the two they were handed.
    const locations = buildCodeLocations(undefined, [
      candidate({
        anchor: {
          t: 1,
          frame: "client/src/lib/api-search.js:59:21",
          minifiedFrame: "assets/index-a1b2c3.js:1:48210",
        },
      } as never),
    ]);
    expect(locations?.[0]?.sourceMapped).toBe(true);
  });

  it("does not repeat one place because two signals reached it", () => {
    const locations = buildCodeLocations(undefined, [
      candidate({ id: "cand_0001", anchor: { t: 1, frame: "a.js:7:1" } } as never),
      candidate({ id: "cand_0002", anchor: { t: 2, frame: "a.js:7:9" } } as never),
    ]);
    expect(locations).toHaveLength(1);
    expect(locations?.[0]?.signalId).toBe("cand_0001");
  });

  it("surfaces a write whose request never produced a ranked candidate", () => {
    // Last, because nothing ranked it — but present, because "which line wrote
    // this row" is the question a db.diff most often provokes.
    const locations = buildCodeLocations(
      bundleWith([{ requestId: "orphan", callsite: { file: "server/src/jobs/sweep.js", line: 8 } }]),
      [candidate({ anchor: { t: 1, frame: "a.js:1" } } as never)],
    );
    expect(locations?.map((l) => l.path)).toEqual(["a.js", "server/src/jobs/sweep.js"]);
  });

  it("stops before a reader is searching again", () => {
    const many = Array.from({ length: MAX_CODE_LOCATIONS + 10 }, (_, i) =>
      candidate({ id: `cand_${i}`, anchor: { t: i, frame: `file-${i}.js:1` } } as never),
    );
    expect(buildCodeLocations(undefined, many)).toHaveLength(MAX_CODE_LOCATIONS);
  });

  it("skips a candidate whose anchor carries a label instead of a location", () => {
    // The whole candidate is skipped, not defaulted to something plausible.
    const locations = buildCodeLocations(undefined, [
      candidate({ id: "cand_0001", anchor: { t: 1, source: "backend" } } as never),
      candidate({ id: "cand_0002", anchor: { t: 2, frame: "real.js:4" } } as never),
    ]);
    expect(locations).toEqual([
      expect.objectContaining({ path: "real.js", signalId: "cand_0002" }),
    ]);
  });
});
