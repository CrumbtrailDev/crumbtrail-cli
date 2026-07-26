import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// Replay of a real browser run against a deployed store, session
// ses_20260726_012746_db06caef2034. The run mixed one genuine defect with six
// deliberate failures to see whether the analyzer could tell them apart.
//
// It could not. The session produced 29 signals ranked like this:
//
//   #1  High    duplicate_write            3 "identical" order_items rows  (false)
//   #2–13       http_error / backend_*     the expected 401s and 400
//   #14–24      db_mutation                ordinary checkout writes "near an error"
//   #25–26      repeated_clicks            scripted clicks
//   #29  Low    console_warning            Total mismatch 107104¢ vs 91400¢  ← the bug
//
// The only real defect — a client-supplied order total persisted verbatim,
// charging $1071.04 for $914.00 of goods — ranked last of 29. This test pins the
// corrected ranking against the same input shape.

const T0 = 1785000000000;
const at = (seconds: number): number => T0 + seconds * 1000;

/** The events and failedReqs the live run produced, in one place. */
function liveSession(): {
  events: BugEvent[];
  index: Parameters<typeof buildEvidenceCandidates>[1];
} {
  const events: BugEvent[] = [];
  const failedReqs: Array<Record<string, unknown>> = [];

  // Four sign-in attempts with a deliberately wrong password.
  for (const [i, seconds] of [241, 255, 256, 257].entries()) {
    events.push({
      t: at(seconds),
      k: "net.res",
      d: {
        id: `b${i}`,
        st: 401,
        body: '{"error":"invalid_credentials"}',
        requestId: `shared-login-${i}`,
      },
    });
    failedReqs.push({
      t: at(seconds),
      m: "POST",
      url: "/api/login",
      st: 401,
      id: `b${i}`,
    });
    events.push({
      t: at(seconds),
      k: "backend.req.end",
      d: {
        requestId: `shared-login-${i}`,
        method: "POST",
        route: "/login",
        statusCode: 401,
      },
    });
    events.push({
      t: at(seconds),
      k: "con",
      d: {
        lv: "err",
        args: ['"login failed"', "401", '{"error":"invalid_credentials"}'],
      },
    });
  }

  // A logged-out visitor polling /api/me on every page load.
  events.push({
    t: at(436),
    k: "net.res",
    d: { id: "bme", st: 401, requestId: "shared-me" },
  });
  failedReqs.push({
    t: at(436),
    m: "GET",
    url: "/api/me",
    st: 401,
    id: "bme",
  });
  events.push({
    t: at(436),
    k: "backend.req.end",
    d: {
      requestId: "shared-me",
      method: "GET",
      route: "/me",
      statusCode: 401,
    },
  });

  // The defect. HTTP 200, no exception, one console.warn.
  events.push({
    t: at(437),
    k: "con",
    d: {
      lv: "warn",
      args: [
        "Total mismatch — persisted 107104¢ but server computed 91400¢",
      ],
    },
  });

  // The three order_items rows of ONE order — different product, quantity and
  // price — as a partial after image recorded them.
  for (const [i, pk] of [1, 2, 3].entries()) {
    events.push({
      t: at(436) + i,
      k: "db.diff",
      d: {
        engine: "postgres",
        op: "insert",
        table: "order_items",
        pk: { id: pk },
        after: { id: pk, order_id: 1 },
        requestId: "9193460967ef978fb61fbc35cdfd1b8f",
      },
    });
  }

  // An expired coupon, deliberately rejected by the checkout handler.
  events.push({
    t: at(499),
    k: "net.res",
    d: {
      id: "bck",
      st: 400,
      body: '{"error":"expired_coupon"}',
      requestId: "shared-checkout",
    },
  });
  failedReqs.push({
    t: at(499),
    m: "POST",
    url: "/api/checkout",
    st: 400,
    id: "bck",
  });
  events.push({
    t: at(499),
    k: "backend.req.end",
    d: {
      requestId: "shared-checkout",
      method: "POST",
      route: "/",
      statusCode: 400,
    },
  });
  events.push({
    t: at(499),
    k: "con",
    d: {
      lv: "err",
      args: ['"Checkout failed"', "400", '{"error":"expired_coupon"}'],
    },
  });

  events.sort((a, b) => a.t - b.t);
  return {
    events,
    index: {
      start: T0,
      navs: [
        { t: at(0), to: "https://shop.example/" },
        { t: at(422), to: "https://shop.example/checkout" },
      ],
      failedReqs: failedReqs as never,
      stats: { clk: 14 },
    } as Parameters<typeof buildEvidenceCandidates>[1],
  };
}

describe("buildEvidenceCandidates — live session ranking", () => {
  const { events, index } = liveSession();
  const candidates = buildEvidenceCandidates(events, index);

  it("ranks the one real defect first", () => {
    expect(candidates[0].detector).toBe("console_warning");
    expect(candidates[0].anchor.message).toContain("Total mismatch");
  });

  it("does not claim the three order_items rows were duplicates", () => {
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(0);
  });

  it("emits no signal above the real defect", () => {
    const top = candidates[0].score;
    expect(candidates.every((c) => c.score <= top)).toBe(true);
  });

  it("collapses the four sign-in attempts into one counted signal", () => {
    const logins = candidates.filter(
      (c) => c.detector === "http_error" && c.anchor.url === "/api/login",
    );
    expect(logins).toHaveLength(1);
    expect(logins[0].occurrences).toBe(4);
    expect(logins[0].severity).toBe("low");
  });

  it("keeps every deliberate failure below the real defect", () => {
    const realDefectRank = candidates.findIndex(
      (c) => c.detector === "console_warning",
    );
    const expected = candidates
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          c.anchor.status === 401 ||
          (c.anchor.status === 400 && c.anchor.url === "/api/checkout"),
      );
    expect(expected.length).toBeGreaterThan(0);
    for (const { c, i } of expected) {
      expect(
        i,
        `${c.detector} ${c.title} outranked the real defect`,
      ).toBeGreaterThan(realDefectRank);
    }
  });

  it("still reports the deliberate failures rather than hiding them", () => {
    // Demoted, never dropped: "login 401s for every user" must stay findable.
    const auth = candidates.filter((c) => c.anchor.status === 401);
    expect(auth.length).toBeGreaterThan(0);
  });
});
