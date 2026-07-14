import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { compareSessions, SESSION_COMPARE_SCHEMA_VERSION } from "../index";
import type { BugEvent } from "crumbtrail-core";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-compare-"));
  tempRoots.push(root);
  return root;
}

function sessionDir(
  root: string,
  name: string,
  events: BugEvent[],
  options: { staleCold?: boolean } = {},
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: name }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n"),
  );
  if (options.staleCold) {
    fs.writeFileSync(
      path.join(dir, "events.ndjson.zst"),
      zlib.zstdCompressSync(
        Buffer.from(`${JSON.stringify(events[0])}\n`, "utf8"),
      ),
    );
  }
  return dir;
}

function stubSessionDir(
  root: string,
  name: string,
  behaviorHash: string,
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "stub-behavior.json"),
    JSON.stringify({ sessionId: name, behaviorHash, steps: 5 }),
  );
  return dir;
}

function coldSessionDir(root: string, name: string, sig: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: name }),
  );
  fs.writeFileSync(
    path.join(dir, "signatures.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        { id: 1, sig, path: `button[data-testid="${sig}"]`, tag: "BUTTON" },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson.zst"),
    zlib.zstdCompressSync(
      Buffer.from(
        `${JSON.stringify({ t: 1000, k: "clk", d: { el: { sigRef: 1 } } })}\n`,
        "utf8",
      ),
    ),
  );
  return dir;
}

function checkoutEvents(totalCents: number, status = 200): BugEvent[] {
  return [
    {
      t: 1000,
      k: "clk",
      d: { el: { sig: "checkout-submit", txt: "Place order" } },
    },
    {
      t: 1100,
      k: "net.req",
      d: { id: "r1", requestId: "req-1", method: "POST", url: "/api/checkout" },
    },
    {
      t: 1200,
      k: "net.res",
      d: {
        id: "r1",
        requestId: "req-1",
        st: status,
        body: { ok: status < 400 },
      },
    },
    {
      t: 1300,
      k: "db.diff",
      d: {
        table: "orders",
        op: "insert",
        pk: { id: 1 },
        after: { id: 1, total_cents: totalCents },
        requestId: "req-1",
      },
    },
  ];
}

function checkoutEventsWithRow(row: Record<string, unknown>): BugEvent[] {
  return checkoutEvents(Number(row.total_cents ?? 1299)).map((event) => {
    if (event.k !== "db.diff") return event;
    return { ...event, d: { ...event.d, after: row } };
  });
}

function withDbEngine(events: BugEvent[], engine: string): BugEvent[] {
  return events.map((event) =>
    event.k === "db.diff" ? { ...event, d: { ...event.d, engine } } : event,
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("compareSessions", () => {
  it("returns the C2 clean contract for equivalent reruns", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", checkoutEvents(1299));
    const b = sessionDir(root, "sess-b", checkoutEvents(1299));

    const comparison = await compareSessions(a, b);

    expect(comparison.schemaVersion).toBe(SESSION_COMPARE_SCHEMA_VERSION);
    expect(comparison.verdict).toBe("clean");
    expect(comparison.confidence).toBe("high");
    expect(comparison.alignment).toEqual({
      matchedSteps: 1,
      unmatchedA: 0,
      unmatchedB: 0,
    });
    expect(comparison.divergences).toEqual([]);
  });

  it("reports a database row-value divergence when the durable result changes", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", checkoutEvents(1299));
    const b = sessionDir(root, "sess-b", checkoutEvents(1399));

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.confidence).toBe("high");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plane: "db",
          kind: "db.row-value",
          table: "orders",
          before: expect.objectContaining({ total_cents: 1299 }),
          after: expect.objectContaining({ total_cents: 1399 }),
        }),
      ]),
    );
  });

  it("reports a network status divergence on the same anchored call", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", checkoutEvents(1299, 200));
    const b = sessionDir(root, "sess-b", checkoutEvents(1299, 500));

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plane: "network",
          kind: "net.status",
          before: 200,
          after: 500,
        }),
      ]),
    );
  });

  it("reports environment diffs and can expose otherwise suppressed timestamp noise", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", [
      {
        t: 900,
        k: "env",
        d: {
          kind: "snapshot",
          flags: { checkout: true },
          config: { generatedAt: "2026-07-03T12:00:00Z" },
        },
      },
      ...checkoutEvents(1299),
    ]);
    const b = sessionDir(root, "sess-b", [
      {
        t: 900,
        k: "env",
        d: {
          kind: "snapshot",
          flags: { checkout: true },
          config: { generatedAt: "2026-07-03T12:01:00Z" },
        },
      },
      ...checkoutEvents(1299),
    ]);

    const suppressed = await compareSessions(a, b);
    expect(suppressed.verdict).toBe("clean");
    expect(suppressed.noise.rules).toContain("value.timestamp-iso");

    const exposed = await compareSessions(a, b, {
      disableNoiseRules: ["value.timestamp-iso"],
    });
    expect(exposed.verdict).toBe("regression");
    expect(exposed.divergences).toEqual([
      expect.objectContaining({ plane: "env", kind: "env.snapshot" }),
    ]);
  });

  it("ignores browser-only environment differences in the compare channel", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", [
      {
        t: 900,
        k: "env",
        d: {
          kind: "snapshot",
          userAgent: "Chrome/120",
          browser: { name: "Chrome", version: "120" },
          viewport: { w: 1440, h: 900 },
          flags: { checkout: true },
          config: { region: "us" },
        },
      },
      ...checkoutEvents(1299),
    ]);
    const b = sessionDir(root, "sess-b", [
      {
        t: 900,
        k: "env",
        d: {
          kind: "snapshot",
          userAgent: "Firefox/130",
          browser: { name: "Firefox", version: "130" },
          viewport: { w: 390, h: 844 },
          flags: { checkout: true },
          config: { region: "us" },
        },
      },
      ...checkoutEvents(1299),
    ]);

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("clean");
    expect(
      comparison.divergences.some((divergence) => divergence.plane === "env"),
    ).toBe(false);
  });

  it("reports release/build metadata differences through the env channel", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", checkoutEvents(1299));
    const b = sessionDir(root, "sess-b", checkoutEvents(1299));
    fs.writeFileSync(
      path.join(a, "meta.json"),
      JSON.stringify({ sessionId: "sess-a", release: "R181", build: "sha-a" }),
    );
    fs.writeFileSync(
      path.join(b, "meta.json"),
      JSON.stringify({ sessionId: "sess-b", release: "R182", build: "sha-b" }),
    );

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.divergences).toEqual([
      expect.objectContaining({
        plane: "env",
        kind: "env.snapshot",
        before: { release: "R181", build: "sha-a" },
        after: { release: "R182", build: "sha-b" },
      }),
    ]);
  });

  it("emits a structured added/removed/changed env delta for flags and config", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", [
      {
        t: 900,
        k: "env",
        d: {
          kind: "snapshot",
          flags: { newCheckout: false, legacyBanner: true },
          config: { region: "us", tier: "free" },
        },
      },
      ...checkoutEvents(1299),
    ]);
    const b = sessionDir(root, "sess-b", [
      {
        t: 900,
        k: "env",
        d: {
          kind: "snapshot",
          flags: { newCheckout: true, betaSearch: true },
          config: { region: "us", tier: "pro" },
        },
      },
      ...checkoutEvents(1299),
    ]);

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    // Delta is surfaced both on the comparison and on the env divergence.
    const envDivergence = comparison.divergences.find(
      (divergence) => divergence.kind === "env.snapshot",
    );
    expect(envDivergence?.envDelta).toEqual(comparison.envDelta);

    const delta = comparison.envDelta!;
    // flags: newCheckout changed false->true, legacyBanner removed, betaSearch added.
    expect(delta.flags.changed).toEqual([
      { key: "newCheckout", before: false, after: true },
    ]);
    expect(delta.flags.removed).toEqual([
      { key: "legacyBanner", before: true },
    ]);
    expect(delta.flags.added).toEqual([{ key: "betaSearch", after: true }]);
    // config: tier changed free->pro, region unchanged (absent from delta).
    expect(delta.config.changed).toEqual([
      { key: "tier", before: "free", after: "pro" },
    ]);
    expect(delta.config.added).toEqual([]);
    expect(delta.config.removed).toEqual([]);
    // No release/build metadata was set, so those channels stay absent.
    expect(delta.release).toBeUndefined();
    expect(delta.build).toBeUndefined();
  });

  it("names release/build changes in the env delta channel", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", checkoutEvents(1299));
    const b = sessionDir(root, "sess-b", checkoutEvents(1299));
    fs.writeFileSync(
      path.join(a, "meta.json"),
      JSON.stringify({ sessionId: "sess-a", release: "R181", build: "sha-a" }),
    );
    fs.writeFileSync(
      path.join(b, "meta.json"),
      JSON.stringify({ sessionId: "sess-b", release: "R182", build: "sha-b" }),
    );

    const comparison = await compareSessions(a, b);

    expect(comparison.envDelta).toEqual({
      flags: { added: [], removed: [], changed: [] },
      config: { added: [], removed: [], changed: [] },
      release: { before: "R181", after: "R182" },
      build: { before: "sha-a", after: "sha-b" },
    });
  });

  it("leaves envDelta absent when the env plane does not diverge", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", [
      { t: 900, k: "env", d: { kind: "snapshot", flags: { checkout: true } } },
      ...checkoutEvents(1299),
    ]);
    const b = sessionDir(root, "sess-b", [
      { t: 900, k: "env", d: { kind: "snapshot", flags: { checkout: true } } },
      ...checkoutEvents(1299),
    ]);

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("clean");
    expect(comparison.envDelta).toBeUndefined();
  });

  it("chooses a richer plain stream over a stale finalized cold stream", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", checkoutEvents(1299), {
      staleCold: true,
    });
    const b = sessionDir(root, "sess-b", checkoutEvents(1399), {
      staleCold: true,
    });

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(
      comparison.divergences.some(
        (divergence) => divergence.kind === "db.row-value",
      ),
    ).toBe(true);
  });

  it("supports the lightweight FP-gate stub behavior fixture format", async () => {
    const root = makeRoot();
    const a = stubSessionDir(root, "sess-a", "hash-a");
    const b = stubSessionDir(root, "sess-b", "hash-b");

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.a.sessionId).toBe("sess-a");
    expect(comparison.b.sessionId).toBe("sess-b");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plane: "db",
          kind: "db.row-value",
          table: "orders",
        }),
      ]),
    );
  });

  it("uses stub behavior as deterministic CI witness evidence alongside real streams", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", checkoutEvents(1299));
    const b = sessionDir(root, "sess-b", checkoutEvents(1299));
    fs.writeFileSync(
      path.join(a, "stub-behavior.json"),
      JSON.stringify({
        sessionId: "sess-a",
        behaviorHash: "checkout:clean-baseline",
      }),
    );
    fs.writeFileSync(
      path.join(b, "stub-behavior.json"),
      JSON.stringify({
        sessionId: "sess-b",
        behaviorHash: "checkout:wrong-row-order-total",
      }),
    );

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plane: "db",
          kind: "db.row-value",
          table: "orders",
          before: expect.objectContaining({
            behavior_hash: "checkout:clean-baseline",
          }),
          after: expect.objectContaining({
            behavior_hash: "checkout:wrong-row-order-total",
          }),
        }),
      ]),
    );
  });

  it("reports B-only network calls and database writes", async () => {
    const root = makeRoot();
    const extra: BugEvent[] = [
      {
        t: 1400,
        k: "net.req",
        d: { id: "r2", requestId: "req-2", method: "POST", url: "/api/audit" },
      },
      { t: 1500, k: "net.res", d: { id: "r2", requestId: "req-2", st: 200 } },
      {
        t: 1600,
        k: "db.diff",
        d: {
          table: "audit_log",
          op: "insert",
          pk: { id: 2 },
          after: { action: "checkout" },
          requestId: "req-2",
        },
      },
    ];
    const a = sessionDir(root, "sess-a", checkoutEvents(1299));
    const b = sessionDir(root, "sess-b", [...checkoutEvents(1299), ...extra]);

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ plane: "network", kind: "net.call-added" }),
        expect.objectContaining({
          plane: "db",
          kind: "db.write-added",
          table: "audit_log",
        }),
      ]),
    );
  });

  it("suppresses presence-only noise for fully redacted network calls", async () => {
    const root = makeRoot();
    const redactedCall: BugEvent[] = [
      {
        t: 1400,
        k: "net.req",
        d: {
          id: "r2",
          requestId: "req-redacted",
          method: "GET",
          url: "/api/orders",
        },
      },
      {
        t: 1500,
        k: "net.res",
        d: { id: "r2", requestId: "req-redacted", st: 200, body: "[REDACTED]" },
      },
    ];
    const a = sessionDir(root, "sess-a", [
      ...checkoutEvents(1299),
      ...redactedCall,
    ]);
    const b = sessionDir(root, "sess-b", checkoutEvents(1299));

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("clean");
    expect(comparison.noise.rules).toContain("network.redacted-call-presence");
  });

  it("can disable redacted network presence suppression", async () => {
    const root = makeRoot();
    const redactedCall: BugEvent[] = [
      {
        t: 1400,
        k: "net.req",
        d: {
          id: "r2",
          requestId: "req-redacted",
          method: "GET",
          url: "/api/orders",
        },
      },
      {
        t: 1500,
        k: "net.res",
        d: { id: "r2", requestId: "req-redacted", st: 200, body: "[REDACTED]" },
      },
    ];
    const a = sessionDir(root, "sess-a", [
      ...checkoutEvents(1299),
      ...redactedCall,
    ]);
    const b = sessionDir(root, "sess-b", checkoutEvents(1299));

    const comparison = await compareSessions(a, b, {
      disableNoiseRules: ["network.redacted-call-presence"],
    });

    expect(comparison.verdict).toBe("regression");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "net.call-missing",
          before: expect.objectContaining({ route: "/api/orders" }),
        }),
      ]),
    );
  });

  it("rehydrates cold sigRef dictionaries before comparing flow identity", async () => {
    const root = makeRoot();
    const a = coldSessionDir(root, "sess-a", "sig_place_order");
    const b = coldSessionDir(root, "sess-b", "sig_retry_payment");

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plane: "flow",
          kind: "flow.step-missing",
          sig: "sig_place_order",
        }),
        expect.objectContaining({
          plane: "flow",
          kind: "flow.step-added",
          sig: "sig_retry_payment",
        }),
      ]),
    );
  });

  it("treats generated primary-key drift as row identity noise for otherwise equal inserts", async () => {
    const root = makeRoot();
    const a = sessionDir(
      root,
      "sess-a",
      checkoutEventsWithRow({ id: 1, total_cents: 1299, sku: "bike" }).map(
        (event) =>
          event.k === "db.diff"
            ? { ...event, d: { ...event.d, pk: { id: 1 } } }
            : event,
      ),
    );
    const b = sessionDir(
      root,
      "sess-b",
      checkoutEventsWithRow({ id: 2, total_cents: 1299, sku: "bike" }).map(
        (event) =>
          event.k === "db.diff"
            ? { ...event, d: { ...event.d, pk: { id: 2 } } }
            : event,
      ),
    );

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("clean");
    expect(comparison.divergences).toEqual([]);
  });

  it("suppresses timestamp-only row variance unless that specific rule is disabled", async () => {
    const root = makeRoot();
    const a = sessionDir(
      root,
      "sess-a",
      checkoutEventsWithRow({
        id: 1,
        total_cents: 1299,
        created_at: "2026-07-02T10:00:00Z",
      }),
    );
    const b = sessionDir(
      root,
      "sess-b",
      checkoutEventsWithRow({
        id: 1,
        total_cents: 1299,
        created_at: "2026-07-02T10:05:00Z",
      }),
    );

    const clean = await compareSessions(a, b);
    const surfaced = await compareSessions(a, b, {
      disableNoiseRules: ["value.timestamp-iso"],
    });

    expect(clean.verdict).toBe("clean");
    expect(clean.noise.rules).toContain("value.timestamp-iso");
    expect(surfaced.verdict).toBe("regression");
    expect(surfaced.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ plane: "db", kind: "db.row-value" }),
      ]),
    );
  });

  it("buckets the same table+op on different engines into DISTINCT dbKeys (no collision)", async () => {
    const root = makeRoot();
    // Identical flow/network/row values; the ONLY difference is the DB engine tag. Before the
    // engine-scoped dbKey these two writes collided and matched cleanly; now they must not.
    const a = sessionDir(
      root,
      "sess-a",
      withDbEngine(checkoutEvents(1299), "mysql"),
    );
    const b = sessionDir(
      root,
      "sess-b",
      withDbEngine(checkoutEvents(1299), "postgres"),
    );

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plane: "db",
          kind: "db.write-missing",
          table: "orders",
        }),
        expect.objectContaining({
          plane: "db",
          kind: "db.write-added",
          table: "orders",
        }),
      ]),
    );
  });

  it("buckets legacy engineless writes with explicit-postgres writes (back-compat default)", async () => {
    const root = makeRoot();
    // A carries no engine tag (legacy) → normalized to postgres; B is explicit postgres. Same
    // dbKey bucket, identical row → they match, so no write-added/write-missing divergence.
    const a = sessionDir(root, "sess-a", checkoutEvents(1299));
    const b = sessionDir(
      root,
      "sess-b",
      withDbEngine(checkoutEvents(1299), "postgres"),
    );

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("clean");
    expect(comparison.divergences.filter((d) => d.plane === "db")).toEqual([]);
  });
});
