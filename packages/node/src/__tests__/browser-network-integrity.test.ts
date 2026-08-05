import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

function exchange(
  t: number,
  requestId: string,
  method: string,
  url: string,
  body: unknown,
  response: unknown,
): BugEvent[] {
  return [
    {
      t,
      k: "net.req",
      d: {
        requestId,
        method,
        url,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    },
    {
      t: t + 10,
      k: "net.res",
      d: { requestId, st: 200, body: JSON.stringify(response) },
    },
  ] as unknown as BugEvent[];
}

describe("browser and network integrity", () => {
  it("flags successful inserts whose identities differ only by case", () => {
    expect(
      detectors([
        ...exchange(
          100,
          "signup-a",
          "POST",
          "/api/signup",
          {
            email: {
              $redacted: "[REDACTED]",
              len: 16,
              hash8: "rawcaps1",
              casefoldHash8: "folded01",
            },
          },
          { ok: true },
        ),
        {
          t: 115,
          k: "db.diff",
          d: {
            requestId: "signup-a",
            op: "insert",
            table: "users",
            after: { id: 1, email: "[REDACTED]" },
          },
        },
        {
          t: 116,
          k: "db.diff",
          d: {
            requestId: "signup-a",
            op: "insert",
            table: "sessions",
            after: { id: "session-a", user_id: 1 },
          },
        },
        ...exchange(
          200,
          "signup-b",
          "POST",
          "/api/signup",
          {
            email: {
              $redacted: "[REDACTED]",
              len: 16,
              hash8: "rawlower",
              casefoldHash8: "folded01",
            },
          },
          { ok: true },
        ),
        {
          t: 215,
          k: "db.diff",
          d: {
            requestId: "signup-b",
            op: "insert",
            table: "users",
            after: { id: 2, email: "[REDACTED]" },
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("casefold_duplicate_identity_accepted");
  });

  it("does not group different normalized identities", () => {
    expect(
      detectors([
        ...exchange(
          100,
          "signup-a",
          "POST",
          "/api/signup",
          {
            email: {
              $redacted: "[REDACTED]",
              len: 16,
              hash8: "rawcaps1",
              casefoldHash8: "folded01",
            },
          },
          { ok: true },
        ),
        {
          t: 115,
          k: "db.diff",
          d: {
            requestId: "signup-a",
            op: "insert",
            table: "users",
            after: { id: 1 },
          },
        },
        ...exchange(
          200,
          "signup-b",
          "POST",
          "/api/signup",
          {
            email: {
              $redacted: "[REDACTED]",
              len: 16,
              hash8: "rawother",
              casefoldHash8: "folded02",
            },
          },
          { ok: true },
        ),
        {
          t: 215,
          k: "db.diff",
          d: {
            requestId: "signup-b",
            op: "insert",
            table: "users",
            after: { id: 2 },
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("casefold_duplicate_identity_accepted");
  });

  it("flags a checkout click stalled behind a zero-byte vendor script", () => {
    expect(
      detectors([
        ...exchange(
          100,
          "cart-1",
          "POST",
          "/api/cart/items",
          { productId: 1, qty: 1 },
          { items: [{ productId: 1, qty: 1 }] },
        ),
        {
          t: 150,
          k: "perf",
          d: {
            metric: "res",
            name: "https://shop.test/vendor/analytics.js",
            initiatorType: "script",
            transferSize: 0,
          },
        },
        {
          t: 200,
          k: "clk",
          d: { el: { path: "button[data-testid=cart-checkout]" } },
        },
      ] as unknown as BugEvent[]),
    ).toContain("blocked_script_prevented_action");
  });

  it("accepts checkout when the click progresses to its request", () => {
    expect(
      detectors([
        ...exchange(
          100,
          "cart-1",
          "POST",
          "/api/cart/items",
          { productId: 1, qty: 1 },
          { items: [{ productId: 1, qty: 1 }] },
        ),
        {
          t: 150,
          k: "perf",
          d: {
            metric: "res",
            name: "https://shop.test/vendor/analytics.js",
            initiatorType: "script",
            transferSize: 0,
          },
        },
        {
          t: 200,
          k: "clk",
          d: { el: { path: "button[data-testid=cart-checkout]" } },
        },
        {
          t: 220,
          k: "net.req",
          d: { requestId: "checkout-1", method: "POST", url: "/api/checkout" },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("blocked_script_prevented_action");
  });

  it("flags a stalled action on an app with no cart at all", () => {
    expect(
      detectors([
        ...exchange(
          100,
          "booking-1",
          "POST",
          "/api/bookings/42/passengers",
          { passengerId: 7 },
          { bookingId: 42, passengers: 1 },
        ),
        {
          t: 150,
          k: "perf",
          d: {
            metric: "res",
            name: "https://airline.test/tag/gtm.js",
            initiatorType: "script",
            transferSize: 0,
          },
        },
        {
          t: 200,
          k: "clk",
          d: { el: { path: "button[data-testid=confirm-purchase]" } },
        },
      ] as unknown as BugEvent[]),
    ).toContain("blocked_script_prevented_action");
  });

  it("accepts a zero-byte analytics script on a session that committed nothing", () => {
    expect(
      detectors([
        ...exchange(
          100,
          "search-1",
          "GET",
          "/api/flights?from=BOS",
          undefined,
          { flights: [{ id: 1 }] },
        ),
        {
          t: 150,
          k: "perf",
          d: {
            metric: "res",
            name: "https://airline.test/analytics/beacon.js",
            initiatorType: "script",
            transferSize: 0,
          },
        },
        {
          t: 200,
          k: "clk",
          d: { el: { path: "button[data-testid=submit-search]" } },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("blocked_script_prevented_action");
  });

  it("accepts an action clicked before the session committed anything", () => {
    expect(
      detectors([
        {
          t: 50,
          k: "perf",
          d: {
            metric: "res",
            name: "https://airline.test/tag/gtm.js",
            initiatorType: "script",
            transferSize: 0,
          },
        },
        {
          t: 100,
          k: "clk",
          d: { el: { path: "button[data-testid=confirm-purchase]" } },
        },
        ...exchange(
          200,
          "booking-1",
          "POST",
          "/api/bookings/42/passengers",
          { passengerId: 7 },
          { bookingId: 42, passengers: 1 },
        ),
      ] as unknown as BugEvent[]),
    ).not.toContain("blocked_script_prevented_action");
  });

  it("flags an acknowledged state change contradicted by the next read", () => {
    expect(
      detectors([
        ...exchange(
          100,
          "stock-write",
          "POST",
          "/api/stock/emit",
          { productId: 1, inventory: 0 },
          { ok: true },
        ),
        ...exchange(
          200,
          "stock-read",
          "GET",
          "/api/stock/levels",
          undefined,
          { levels: [{ productId: 1, inventory: 25 }] },
        ),
      ] as unknown as BugEvent[]),
    ).toContain("acknowledged_state_contradicted_by_read");
  });

  it("accepts a read that agrees with the acknowledged state", () => {
    expect(
      detectors([
        ...exchange(
          100,
          "stock-write",
          "POST",
          "/api/stock/emit",
          { productId: 1, inventory: 0 },
          { ok: true },
        ),
        ...exchange(
          200,
          "stock-read",
          "GET",
          "/api/stock/levels",
          undefined,
          { levels: [{ productId: 1, inventory: 0 }] },
        ),
      ] as unknown as BugEvent[]),
    ).not.toContain("acknowledged_state_contradicted_by_read");
  });

  it("flags a synchronized burst of failed same-endpoint requests", () => {
    const events: BugEvent[] = [];
    for (let index = 0; index < 6; index += 1) {
      events.push(
        {
          t: 100 + index,
          k: "net.req",
          d: {
            id: index,
            requestId: `stream-${index}`,
            method: "GET",
            url: "/api/stock/stream",
          },
        } as unknown as BugEvent,
        {
          t: 110 + index,
          k: "net.err",
          d: {
            id: index,
            requestId: `stream-${index}`,
            method: "GET",
            url: "/api/stock/stream",
          },
        } as unknown as BugEvent,
      );
    }
    expect(detectors(events)).toContain("request_reconnect_storm");
  });

  it("does not call spaced retries a reconnect storm", () => {
    const events: BugEvent[] = [];
    for (let index = 0; index < 6; index += 1) {
      events.push(
        {
          t: 100 + index * 1_000,
          k: "net.req",
          d: {
            requestId: `stream-${index}`,
            method: "GET",
            url: "/api/stock/stream",
          },
        } as unknown as BugEvent,
        {
          t: 110 + index * 1_000,
          k: "net.err",
          d: { requestId: `stream-${index}` },
        } as unknown as BugEvent,
      );
    }
    expect(detectors(events)).not.toContain("request_reconnect_storm");
  });

  it("flags a running client build that disagrees with the server build", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "env",
          d: { kind: "snapshot", appBuild: "release-old" },
        },
        ...exchange(
          200,
          "build-1",
          "GET",
          "/build-id.json",
          undefined,
          { build: "release-new" },
        ),
      ] as unknown as BugEvent[]),
    ).toContain("stale_client_build");
  });

  it("accepts a client and server on the same build", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "env",
          d: { kind: "snapshot", appBuild: "release-current" },
        },
        ...exchange(
          200,
          "build-1",
          "GET",
          "/build-id.json",
          undefined,
          { build: "release-current" },
        ),
      ] as unknown as BugEvent[]),
    ).not.toContain("stale_client_build");
  });

  it("flags physical anchoring plus physical spacing on an RTL page", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "ui.layout",
          d: {
            dir: "rtl",
            url: "https://shop.test/account",
            rtlPhysical: [
              { properties: ["left"], matched: 1 },
              { properties: ["margin-left"], matched: 1 },
            ],
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("rtl_physical_layout_rules");
  });

  it("accepts logical layout rules on an RTL page", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "ui.layout",
          d: {
            dir: "rtl",
            url: "https://shop.test/account",
            rtlPhysical: [],
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("rtl_physical_layout_rules");
  });
});
