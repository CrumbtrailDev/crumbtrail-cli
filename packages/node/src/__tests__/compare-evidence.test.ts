import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareSessions } from "../compare";
import type { BugEvent } from "crumbtrail-core";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-compare-"));
  tempRoots.push(root);
  return root;
}

function sessionDir(root: string, name: string, events: BugEvent[]): string {
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

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("compareSessions evidence seam", () => {
  it("additively emits evidence alongside the unchanged verdict", async () => {
    const root = makeRoot();
    const aDir = sessionDir(root, "sess-a", checkoutEvents(1299, 200));
    const bDir = sessionDir(root, "sess-b", checkoutEvents(1299, 500));

    const result = await compareSessions(aDir, bDir);

    // existing contract still intact
    expect(result.verdict).toBe("regression");
    expect(Array.isArray(result.divergences)).toBe(true);
    expect(result.divergences.length).toBeGreaterThan(0);

    // new additive contract
    expect(result.evidence).toHaveLength(result.divergences.length);
    expect(result.evidence[0].id).toContain(":");
    expect(result.intent).toEqual([]);
  });

  it("emits empty evidence and intent for identical sessions", async () => {
    const root = makeRoot();
    const aDir = sessionDir(root, "sess-a", checkoutEvents(1299, 200));

    const result = await compareSessions(aDir, aDir);
    expect(result.verdict).toBe("clean");
    expect(result.evidence).toEqual([]);
    expect(result.intent).toEqual([]);
  });
});
