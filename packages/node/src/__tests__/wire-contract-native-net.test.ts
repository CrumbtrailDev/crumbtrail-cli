/**
 * Native `k:"net"` events must index as network evidence.
 *
 * `test-fixtures/wire-contract/events/net.json` is normative: every native SDK
 * (Swift, Kotlin, Dart) emits ONE `net` event per completed request, with the
 * status under `d.status`. The browser SDK emits the three event shape
 * `net.req` / `net.res` / `net.err`, with the status under `d.st`. The evidence
 * indexer only ever understood the browser spelling — 42 references to
 * `net.res` and none at all to bare `net` — so every mobile session's network
 * plane indexed as an empty set: failed requests, latency outliers and every
 * full stack join were computed over nothing.
 *
 * The fixture is read rather than restated so that a field rename in the wire
 * contract fails here too, which is the whole reason the fixture directory
 * exists.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildEvidenceCandidates } from "../evidence-index";
import type { BugEvent } from "crumbtrail-core";

function wireContractDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, "test-fixtures", "wire-contract");
    try {
      readFileSync(join(candidate, "transport.json"));
      return candidate;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("test-fixtures/wire-contract not found");
}

const NET_FIXTURE = JSON.parse(
  readFileSync(join(wireContractDir(), "events", "net.json"), "utf8"),
) as BugEvent & { d: Record<string, unknown> };

/** The fixture, restamped, with the payload fields the case needs overridden. */
function nativeNet(
  t: number,
  overrides: Record<string, unknown> = {},
): BugEvent {
  return {
    ...NET_FIXTURE,
    t,
    d: { ...NET_FIXTURE.d, ...overrides },
  } as BugEvent;
}

describe("the wire contract fixture is the shape this test assumes", () => {
  it("is a single `net` event carrying status, method, url and dur", () => {
    expect(NET_FIXTURE.k).toBe("net");
    expect(NET_FIXTURE.d).toMatchObject({
      status: expect.any(Number),
      method: expect.any(String),
      url: expect.any(String),
      dur: expect.any(Number),
    });
    // The browser spelling, which the indexer already understood, is absent.
    expect(NET_FIXTURE.d).not.toHaveProperty("st");
  });
});

describe("a mobile session's network plane is not an empty set", () => {
  /** Eight quick calls and one slow one — the latency outlier shape. */
  function mobileSession(): BugEvent[] {
    const quick = Array.from({ length: 8 }, (_, i) =>
      nativeNet(1_000 + i * 100, {
        dur: 20,
        status: 200,
        ok: true,
        url: `https://api.example.com/v1/items/${i}`,
      }),
    );
    return [
      ...quick,
      nativeNet(2_000, {
        dur: 900,
        status: 200,
        ok: true,
        url: "https://api.example.com/v1/checkout",
      }),
    ];
  }

  it("indexes native `net` events as network evidence", () => {
    const candidates = buildEvidenceCandidates(mobileSession(), {
      start: 1_000,
    });

    const outlier = candidates.find((c) => c.detector === "latency_outlier");
    expect(outlier).toBeDefined();
    // The request identity has to survive the normalisation too, or the
    // candidate names a hole where the URL should be.
    expect(outlier?.title).toContain("checkout");
  });

  it("still reads the browser three event shape identically", () => {
    const browser: BugEvent[] = [];
    for (let i = 0; i < 8; i += 1) {
      browser.push({
        t: 1_000 + i * 100,
        k: "net.req",
        d: { id: i, method: "POST", url: `https://api.example.com/v1/items/${i}` },
      });
      browser.push({ t: 1_000 + i * 100 + 20, k: "net.res", d: { id: i, st: 200, dur: 20 } });
    }
    browser.push({
      t: 1_900,
      k: "net.req",
      d: { id: 99, method: "POST", url: "https://api.example.com/v1/checkout" },
    });
    browser.push({ t: 2_000, k: "net.res", d: { id: 99, st: 200, dur: 900 } });

    const detectors = buildEvidenceCandidates(browser, { start: 1_000 }).map(
      (c) => c.detector,
    );
    expect(detectors).toContain("latency_outlier");
  });

  it("leaves a session with no net events alone", () => {
    expect(
      buildEvidenceCandidates([{ t: 1_000, k: "con", d: { lv: "log", args: [] } }], {
        start: 1_000,
      }),
    ).toBeInstanceOf(Array);
  });
});

describe("a failed native request reaches the error moment plane", () => {
  it("treats d.status >= 400 the way it treats d.st >= 400", () => {
    // The fixture is itself a 402. A native 500 alongside a database write is
    // the join that was silently computed over an empty set.
    const events: BugEvent[] = [
      nativeNet(1_000, { status: 500, ok: false }),
      {
        t: 1_020,
        k: "db.diff",
        d: {
          engine: "postgres",
          op: "insert",
          table: "orders",
          after: [{ id: 1 }],
        },
      },
    ];

    // `db_mutation` only fires when the write sits beside an ERROR MOMENT, and
    // the only error in this session is the native 500. Before the native shape
    // was indexed there was no moment, so the write read as routine.
    const candidates = buildEvidenceCandidates(events, { start: 1_000 });
    const mutation = candidates.find((c) => c.detector === "db_mutation");
    expect(mutation).toBeDefined();
    expect(mutation?.title).toContain("near an error");
  });
});
