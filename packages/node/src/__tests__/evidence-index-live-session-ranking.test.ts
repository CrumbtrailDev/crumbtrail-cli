import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// Replay of a real browser run that contains both user-visible consequences of
// failed client operations and a silent data defect. Client errors with a
// surfaced console error remain findings. A client error with no consequence is
// covered by evidence-index-handled-client-error.test.ts.

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
      requestId: `shared-login-${i}`,
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
    requestId: "shared-me",
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
    requestId: "shared-checkout",
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

  it("keeps a surfaced client-error consequence visible", () => {
    expect(candidates[0].detector).toBe("http_error");
    expect(candidates[0].anchor.url).toBe("/api/login");
  });

  it("does not claim the three order_items rows were duplicates", () => {
    expect(
      candidates.filter((c) => c.detector === "duplicate_write"),
    ).toHaveLength(0);
  });

  it("collapses the four sign-in attempts into one counted signal", () => {
    const logins = candidates.filter(
      (c) => c.detector === "http_error" && c.anchor.url === "/api/login",
    );
    expect(logins).toHaveLength(1);
    expect(logins[0].occurrences).toBe(4);
    expect(logins[0].severity).toBe("medium");
  });

  it("keeps the client error that the checkout flow surfaced", () => {
    const checkout = candidates.find(
      (c) => c.detector === "http_error" && c.anchor.url === "/api/checkout",
    );
    expect(checkout).toMatchObject({ severity: "medium", score: 70 });
  });

  it("does not hide client errors that had a visible consequence", () => {
    const auth = candidates.filter((c) => c.anchor.status === 401);
    expect(auth.length).toBeGreaterThan(0);
  });
});
