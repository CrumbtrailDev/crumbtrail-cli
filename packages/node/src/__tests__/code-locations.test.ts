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
  isServedUrl,
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

// The client plane.
//
// Measured on nine real harness bundles across five scenarios: ZERO carried any
// code location from the browser. For `autofill-stomped-by-effect`, whose ground
// truth is a stale closure in a React page, the locations were a Node internal
// and a backend repository write — the page's own filename appeared nowhere in
// the 47KB bundle. These pin the plane back on.
describe("buildCodeLocations — client request callsites", () => {
  const linkedBundle = (over: Record<string, unknown> = {}): LlmBundle =>
    ({
      databaseDiffs: [
        {
          requestId: "req-1",
          callsite: { file: "server/src/repos/addresses-repo.js", line: 20, fn: "insertAddress" },
        },
      ],
      fullStackEvidence: {
        linked: [
          {
            requestId: "req-1",
            sessionId: "ses-1",
            frontend: {
              requestId: "req-1",
              requestCallsite: {
                file: "http://127.0.0.1:5637/src/lib/api-addresses.js",
                line: 12,
                column: 9,
                fn: "saveAddress",
                stack: [
                  { file: "http://127.0.0.1:5637/src/pages/Account.jsx", line: 88, column: 13, fn: "onSave" },
                ],
              },
            },
            backend: {},
          },
        ],
        gaps: [],
      },
      ...over,
    }) as unknown as LlmBundle;

  it("emits the client line alongside the server write for one request", () => {
    const locations = buildCodeLocations(linkedBundle(), [
      candidate({ id: "cand_0007", anchor: { t: 1, requestId: "req-1" } } as Partial<EvidenceCandidate>),
    ]);
    const via = locations?.map((location) => location.via);
    // Both planes. Before this, the `db.write` branch returned early and the
    // client line — the one a fix to a client defect has to change — was never
    // reachable at all.
    expect(via).toContain("db.write");
    expect(via).toContain("client.request");
  });

  it("keeps the component that called the helper, as a caller frame", () => {
    const locations = buildCodeLocations(linkedBundle(), [
      candidate({ id: "cand_0007", anchor: { t: 1, requestId: "req-1" } } as Partial<EvidenceCandidate>),
    ]);
    const client = locations?.find((location) => location.via === "client.request");
    expect(client?.path).toBe("http://127.0.0.1:5637/src/lib/api-addresses.js");
    expect(client?.fn).toBe("saveAddress");
    // The helper is shared by every request in the app; Account.jsx is the file
    // the defect is in. Losing the caller chain would name the wrong one.
    expect(client?.callers?.[0]?.path).toBe("http://127.0.0.1:5637/src/pages/Account.jsx");
  });

  it("emits a client location for a request the server never answered", () => {
    // A gap is a frontend request with no backend counterpart — a client-side
    // story by construction, and the case where the client line is the only one.
    const bundle = {
      databaseDiffs: [],
      fullStackEvidence: {
        linked: [],
        gaps: [
          {
            type: "frontend_only",
            requestId: "req-9",
            frontend: {
              requestId: "req-9",
              requestCallsite: { file: "http://127.0.0.1:5637/src/lib/thirdparty.js", line: 4, column: 1 },
            },
          },
        ],
      },
    } as unknown as LlmBundle;
    const locations = buildCodeLocations(bundle, []);
    expect(locations?.[0]?.via).toBe("client.request");
    expect(locations?.[0]?.path).toBe("http://127.0.0.1:5637/src/lib/thirdparty.js");
  });

  it("is still undefined when the browser captured no callsite", () => {
    // The negative direction. Without it, a change that emitted a client
    // location unconditionally — from a request id alone, with no frame behind
    // it — would pass every test above.
    const bundle = {
      databaseDiffs: [],
      fullStackEvidence: {
        linked: [{ requestId: "req-2", sessionId: "s", frontend: { requestId: "req-2" }, backend: {} }],
        gaps: [],
      },
    } as unknown as LlmBundle;
    expect(buildCodeLocations(bundle, [])).toBeUndefined();
  });
});

describe("buildCodeLocations — the unranked client tail", () => {
  const helper = (line: number) => ({
    file: "http://127.0.0.1:5637/src/lib/api.js",
    line,
    column: 9,
    fn: "request",
  });

  const linkedWith = (requestIds: string[], lineFor: (id: string, i: number) => number): LlmBundle =>
    ({
      databaseDiffs: [],
      fullStackEvidence: {
        linked: requestIds.map((requestId, i) => ({
          requestId,
          sessionId: "s",
          frontend: { requestId, requestCallsite: helper(lineFor(requestId, i)) },
          backend: {},
        })),
        gaps: [],
      },
    }) as unknown as LlmBundle;

  it("labels a client location no candidate ranked as unranked", () => {
    // The request id is NOT a signal id. `signalId` is what makes a location
    // checkable — a reader follows it back to the claim behind the path — and a
    // request id sends them looking for a signal that does not exist.
    const locations = buildCodeLocations(linkedWith(["req-9"], () => 40), []);
    expect(locations?.[0]?.signalId).toBe("unranked");
    expect(locations?.[0]?.signalId).not.toBe("req-9");
  });

  it("leaves a ranked request's own signal id alone", () => {
    const locations = buildCodeLocations(
      linkedWith(["req-a", "req-b"], (_id, i) => 12 + i),
      [candidate({ id: "cand_0001", anchor: { t: 1, requestId: "req-a" } } as never)],
    );
    const ranked = locations?.find((location) => location.line === 12);
    const tail = locations?.find((location) => location.line === 13);
    expect(ranked?.signalId).toBe("cand_0001");
    expect(tail?.signalId).toBe("unranked");
  });

  it("still stops at the cap when a candidate yields two locations", () => {
    // Eleven single-location candidates take the count to MAX - 1, so the
    // twelfth — which yields BOTH a server write and a client request — is the
    // one that overflows an array whose cap is only checked at the loop top.
    const singles = Array.from({ length: MAX_CODE_LOCATIONS - 1 }, (_, i) =>
      candidate({ id: `cand_s${i}`, anchor: { t: i, frame: `file-${i}.js:1` } } as never),
    );
    const bundle = {
      databaseDiffs: [{ requestId: "req-x", callsite: { file: "server/w.js", line: 1 } }],
      fullStackEvidence: {
        linked: [
          {
            requestId: "req-x",
            sessionId: "s",
            frontend: { requestId: "req-x", requestCallsite: { file: "http://h/c.js", line: 1 } },
            backend: {},
          },
        ],
        gaps: [],
      },
    } as unknown as LlmBundle;
    const locations = buildCodeLocations(bundle, [
      ...singles,
      candidate({ id: "cand_both", anchor: { t: 99, requestId: "req-x" } } as never),
    ]);
    expect(locations).toHaveLength(MAX_CODE_LOCATIONS);
  });
});

/**
 * The flag on the OTHER road into this function.
 *
 * `sourceMapped` was set only from `anchor.minifiedFrame`, which a structured
 * client callsite never has — so a client location resolved through a source map
 * arrived looking exactly like a direct frame. That is the same "a build artifact
 * presented as a fact" problem the flag was added to prevent, on the path that
 * needs it most: a browser frame is minified far more often than a server one.
 */
describe("buildCodeLocations — a mapped client callsite says so", () => {
  const bundleWithClientCallsite = (callsite: unknown) =>
    ({
      fullStackEvidence: {
        linked: [{ requestId: "req-1", frontend: { requestCallsite: callsite } }],
      },
    }) as unknown as Parameters<typeof buildCodeLocations>[0];

  it("marks a client location that a source map resolved", () => {
    const locations = buildCodeLocations(
      bundleWithClientCallsite({
        file: "client/src/pages/Account.jsx",
        line: 88,
        column: 13,
        minifiedFile: "https://app.example.test/assets/index-a3f2c1.js",
      }),
      [candidate({ id: "cand_0001", anchor: { t: 1, requestId: "req-1" } } as never)],
    );
    expect(locations?.[0]).toMatchObject({
      path: "client/src/pages/Account.jsx",
      via: "client.request",
      sourceMapped: true,
    });
  });

  it("does not mark one the runtime reported directly", () => {
    // The negative half. Without it the flag could be attached unconditionally
    // and every assertion above would still pass.
    const locations = buildCodeLocations(
      bundleWithClientCallsite({
        file: "http://127.0.0.1:5637/src/pages/Account.jsx",
        line: 88,
        column: 13,
      }),
      [candidate({ id: "cand_0001", anchor: { t: 1, requestId: "req-1" } } as never)],
    );
    expect(locations?.[0]?.sourceMapped).toBeUndefined();
  });
});

// A served URL is not a file path, and its line is not a line in the file of
// the same name. Measured on a real capture: `http://localhost:5599/src/App.tsx:19:11`
// for an App.tsx whose last line is 3 — the dev server rewrites JSX and
// prepends its own preamble, so the number belongs to the served module. The
// URL is still worth reporting; presenting it as a place to open is not.
describe("served script URLs", () => {
  it("recognises http and https paths, and nothing else", () => {
    expect(isServedUrl("http://localhost:5599/src/App.tsx")).toBe(true);
    expect(isServedUrl("https://app.example.com/assets/main-a1b2.js")).toBe(true);
    expect(isServedUrl("src/App.tsx")).toBe(false);
    expect(isServedUrl("/Users/me/app/src/App.tsx")).toBe(false);
    expect(isServedUrl("file:///Users/me/app/src/App.tsx")).toBe(false);
  });

  it("marks a signal frame that is a served URL", () => {
    const [location] = buildCodeLocations(undefined, [
      candidate({
        anchor: { t: 1, frame: "http://localhost:5599/src/App.tsx:19:11" },
      }),
    ])!;
    expect(location.path).toBe("http://localhost:5599/src/App.tsx");
    expect(location.line).toBe(19);
    // The fact is carried through unchanged; only the caveat is added.
    expect(location.servedUrl).toBe(true);
  });

  it("does not mark a real repository path", () => {
    const [location] = buildCodeLocations(undefined, [
      candidate({ anchor: { t: 1, frame: "client/src/lib/api-search.js:59:21" } }),
    ])!;
    expect(location.servedUrl).toBeUndefined();
  });

  it("does not mark a frame a source map already resolved", () => {
    // Once a map has moved it, `path` is the file the map named, not the URL.
    const [location] = buildCodeLocations(undefined, [
      candidate({
        anchor: {
          t: 1,
          frame: "src/pages/Account.jsx:88:13",
          minifiedFrame: "http://host/assets/main-a1b2.js:1:24488",
        },
      }),
    ])!;
    expect(location.sourceMapped).toBe(true);
    expect(location.servedUrl).toBeUndefined();
  });
});
