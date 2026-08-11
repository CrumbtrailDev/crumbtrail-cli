// Client source provenance, end to end through the assembly half.
//
// The failure this exists to prevent, measured on a real 405-event session for
// a React stale-closure defect in `client/src/pages/Account.jsx`: the bundle's
// only two code locations were a Node internal and `server/src/repos/
// addresses-repo.js`. The string `Account.jsx` appeared nowhere in 47 KB. The
// evidence did not merely omit the client — by naming only server files it
// argued for the wrong class of fix.
//
// The trap these tests are written against is the one that made the old
// behaviour invisible: the ranked candidate for that request HAS a db.write, so
// any test that only exercises a client-only candidate would pass while the one
// signal that matters still published a server file alone.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_CALLER_FRAMES,
  MAX_CODE_LOCATIONS,
  buildCodeLocations,
} from "../code-locations";
import {
  buildEvidenceCandidates,
  writeEvidenceIndex,
  type EvidenceCandidate,
} from "../evidence-index";
import type { LlmBundle } from "../llm-bundle";
import type { BugEvent } from "crumbtrail-core";

const candidate = (over: Partial<EvidenceCandidate> = {}): EvidenceCandidate =>
  ({
    schemaVersion: 1,
    id: "cand_0001",
    detector: "http_error",
    title: "POST /api/addresses saved the wrong address",
    severity: "high",
    score: 90,
    confidence: "high",
    anchor: { t: 1 },
    ...over,
  }) as unknown as EvidenceCandidate;

const bundleWith = (databaseDiffs: unknown[]): LlmBundle =>
  ({ databaseDiffs }) as unknown as LlmBundle;

describe("buildCodeLocations – client frames", () => {
  it("surfaces the client module that issued the request", () => {
    const locations = buildCodeLocations(undefined, [
      candidate({
        anchor: {
          t: 1,
          requestId: "req_1",
          clientFrames: ["client/src/pages/Account.jsx:118:11"],
        },
      } as Partial<EvidenceCandidate>),
    ]);
    expect(locations).toEqual([
      {
        path: "client/src/pages/Account.jsx",
        line: 118,
        column: 11,
        via: "client.request",
        signalId: "cand_0001",
        signalTitle: "POST /api/addresses saved the wrong address",
      },
    ]);
  });

  it("publishes the client line ALONGSIDE the server write for the same signal", () => {
    // The regression this whole change exists for. A `continue` here meant the
    // reader saw `addresses-repo.js` and nothing else for a browser defect.
    const locations = buildCodeLocations(
      bundleWith([
        {
          requestId: "req_1",
          callsite: {
            file: "server/src/repos/addresses-repo.js",
            line: 20,
            column: 20,
            fn: "insertAddress",
          },
        },
      ]),
      [
        candidate({
          anchor: {
            t: 1,
            requestId: "req_1",
            clientFrames: ["client/src/pages/Account.jsx:118:11"],
          },
        } as Partial<EvidenceCandidate>),
      ],
    );

    expect(locations?.map((location) => [location.via, location.path])).toEqual([
      ["db.write", "server/src/repos/addresses-repo.js"],
      ["client.request", "client/src/pages/Account.jsx"],
    ]);
    // Adjacent, and in that order: the pair belongs to one ranked signal, so
    // neither is re-sorted against the ranking the product already publishes.
    expect(locations?.[0].signalId).toBe(locations?.[1].signalId);
  });

  it("keeps the callers above the innermost frame", () => {
    const [location] = buildCodeLocations(undefined, [
      candidate({
        anchor: {
          t: 1,
          requestId: "req_1",
          clientFrames: [
            "client/src/lib/api-client.js:31:9",
            "client/src/pages/Account.jsx:118:11",
            "client/src/pages/Account.jsx:142:5",
          ],
        },
      } as Partial<EvidenceCandidate>),
    ])!;
    // The innermost frame is the shared helper; the line a fix has to change is
    // one frame out. Both ends are reported because only a reader can tell.
    expect(location.path).toBe("client/src/lib/api-client.js");
    expect(location.callers?.map((frame) => frame.line)).toEqual([118, 142]);
    expect(location.callers!.length).toBeLessThanOrEqual(MAX_CALLER_FRAMES);
  });

  it("marks a source-mapped client frame so a stale map is detectable", () => {
    const [location] = buildCodeLocations(undefined, [
      candidate({
        anchor: {
          t: 1,
          clientFrames: ["client/src/pages/Account.jsx:118:11"],
          minifiedClientFrames: ["https://cdn/app.9f2c.js:1:88213"],
        },
      } as Partial<EvidenceCandidate>),
    ])!;
    expect(location.sourceMapped).toBe(true);
  });

  it("refuses a client frame with no line number", () => {
    // Same refusal `parseFrame` applies everywhere: a module URL without a
    // position is a provenance label, not a place to open.
    expect(
      buildCodeLocations(undefined, [
        candidate({
          anchor: { t: 1, clientFrames: ["http://localhost:5637/src/pages/Account.jsx"] },
        } as Partial<EvidenceCandidate>),
      ]),
    ).toBeUndefined();
  });

  it("degrades to exactly today's output when nothing recorded an origin", () => {
    const bundle = bundleWith([
      {
        requestId: "req_1",
        callsite: { file: "server/src/repos/addresses-repo.js", line: 20 },
      },
    ]);
    const ranked = [candidate({ anchor: { t: 1, requestId: "req_1" } } as Partial<EvidenceCandidate>)];
    expect(buildCodeLocations(bundle, ranked)).toEqual([
      {
        path: "server/src/repos/addresses-repo.js",
        line: 20,
        via: "db.write",
        signalId: "cand_0001",
        signalTitle: "POST /api/addresses saved the wrong address",
      },
    ]);
  });

  it("still honours the cap when a signal contributes two locations", () => {
    const ranked = Array.from({ length: MAX_CODE_LOCATIONS }, (_, i) =>
      candidate({
        id: `cand_${i}`,
        anchor: {
          t: i,
          requestId: `req_${i}`,
          clientFrames: [`client/src/pages/P${i}.jsx:${i + 1}:1`],
        },
      } as Partial<EvidenceCandidate>),
    );
    const bundle = bundleWith(
      ranked.map((_, i) => ({
        requestId: `req_${i}`,
        callsite: { file: `server/src/repos/r${i}.js`, line: i + 1 },
      })),
    );
    expect(buildCodeLocations(bundle, ranked)!.length).toBe(MAX_CODE_LOCATIONS);
  });
});

/* ------------------------------------------------------------------ */
/* Attribution: net.req d.origin -> candidate anchor                   */
/* ------------------------------------------------------------------ */

const event = (k: string, d: Record<string, unknown>, t: number): BugEvent =>
  ({ t, k, d }) as unknown as BugEvent;

/** A 5xx is the cheapest way to make the builder rank a request candidate. */
function failedRequestEvents(origin?: string[]): BugEvent[] {
  return [
    event(
      "net.req",
      {
        id: "req_addr",
        requestId: "req_addr",
        m: "POST",
        url: "http://localhost:7461/api/addresses",
        ...(origin ? { origin } : {}),
      },
      1_000_000,
    ),
    event(
      "net.res",
      { id: "req_addr", requestId: "req_addr", st: 500 },
      1_000_050,
    ),
  ];
}

const failedRequestIndex = {
  start: 999_000,
  failedReqs: [
    {
      t: 1_000_000,
      m: "POST",
      url: "http://localhost:7461/api/addresses",
      st: 500,
      id: "req_addr",
      reason: "http_error",
    },
  ],
};

describe("evidence index – client origin attribution", () => {
  it("attaches the frames a net.req recorded to the candidates for that request", () => {
    const candidates = buildEvidenceCandidates(
      failedRequestEvents(["client/src/pages/Account.jsx:118:11"]),
      failedRequestIndex,
    );
    const anchored = candidates.filter(
      (item) => item.anchor.requestId === "req_addr",
    );
    expect(anchored.length).toBeGreaterThan(0);
    for (const item of anchored) {
      expect(item.anchor.clientFrames).toEqual([
        "client/src/pages/Account.jsx:118:11",
      ]);
    }
  });

  it("attaches nothing when the request carried no origin", () => {
    const candidates = buildEvidenceCandidates(failedRequestEvents(), failedRequestIndex);
    for (const item of candidates) {
      expect(item.anchor.clientFrames).toBeUndefined();
    }
  });

  it("never attributes a frame to a request that did not carry it", () => {
    // Attribution is by requestId only. A same-URL, nearby-in-time request is
    // the exact shape a looser rule would mis-attribute, and a wrong location
    // is worse than none.
    const events = [
      ...failedRequestEvents(["client/src/pages/Account.jsx:118:11"]),
      event(
        "net.req",
        { id: 9, method: "POST", url: "/api/addresses", requestId: "req_other" },
        1_100,
      ),
      event(
        "net.res",
        {
          id: 9,
          method: "POST",
          url: "/api/addresses",
          status: 500,
          dur: 9,
          requestId: "req_other",
        },
        1_150,
      ),
    ];
    for (const item of buildEvidenceCandidates(events, failedRequestIndex)) {
      if (item.anchor.requestId === "req_other") {
        expect(item.anchor.clientFrames).toBeUndefined();
      }
    }
  });

  it("ignores a malformed origin without dropping the candidate", () => {
    const events = failedRequestEvents();
    (events[0].d as Record<string, unknown>).origin = [42, null, {}];
    const candidates = buildEvidenceCandidates(events, failedRequestIndex);
    expect(candidates.length).toBeGreaterThan(0);
    for (const item of candidates) {
      expect(item.anchor.clientFrames).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Source map resolution                                              */
/* ------------------------------------------------------------------ */

// The same real esbuild output `source-map.test.ts` uses. A hand written map
// tends to encode the decoder's own assumptions; this one came from a bundler.
const BUNDLE_MAP = JSON.stringify({
  version: 3,
  sources: ["board.ts"],
  mappings:
    "MAAO,SAASA,EAAYC,EAAyB,CACnD,IAAMC,EAAQD,EAAM,OACpB,GAAIC,IAAU,EACZ,MAAM,IAAI,MAAM,eAAe,EAEjC,OAAOA,CACT",
  names: ["renderBoard", "items", "total"],
});

describe("client frames – source map resolution", () => {
  let sessionDir: string;
  let mapDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-cf-ses-"));
    mapDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-cf-dist-"));
    fs.writeFileSync(path.join(mapDir, "board.min.js.map"), BUNDLE_MAP);
    previous = process.env.CRUMBTRAIL_SOURCEMAP_DIR;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CRUMBTRAIL_SOURCEMAP_DIR;
    else process.env.CRUMBTRAIL_SOURCEMAP_DIR = previous;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(mapDir, { recursive: true, force: true });
  });

  it("resolves a client frame naming a bundler chunk back to the repository file", async () => {
    // This is what turns a production capture — where every frame names a
    // hashed chunk — into a path a reader can open. Same resolver, lookup and
    // cache the existing `frame` resolution uses.
    process.env.CRUMBTRAIL_SOURCEMAP_DIR = mapDir;
    const events = failedRequestEvents([
      "https://app.example.test/assets/board.min.js:1:45",
    ]);
    const candidates = await writeEvidenceIndex({
      sessionDir,
      events: events as never,
      index: failedRequestIndex as never,
      causalGraph: undefined,
    });
    const anchored = candidates.find(
      (item) => item.anchor.requestId === "req_addr",
    );
    expect(anchored?.anchor.clientFrames).toEqual(["board.ts:4:5"]);
    expect(anchored?.anchor.minifiedClientFrames).toEqual([
      "https://app.example.test/assets/board.min.js:1:45",
    ]);
    const [location] = buildCodeLocations(undefined, [anchored!])!;
    expect(location.path).toBe("board.ts");
    expect(location.sourceMapped).toBe(true);
  });

  it("leaves a client frame alone when no map covers it", async () => {
    process.env.CRUMBTRAIL_SOURCEMAP_DIR = mapDir;
    const events = failedRequestEvents([
      "https://app.example.test/assets/unmapped.js:9:3",
    ]);
    const candidates = await writeEvidenceIndex({
      sessionDir,
      events: events as never,
      index: failedRequestIndex as never,
      causalGraph: undefined,
    });
    const anchored = candidates.find(
      (item) => item.anchor.requestId === "req_addr",
    );
    expect(anchored?.anchor.clientFrames).toEqual([
      "https://app.example.test/assets/unmapped.js:9:3",
    ]);
    expect(anchored?.anchor.minifiedClientFrames).toBeUndefined();
  });
});
