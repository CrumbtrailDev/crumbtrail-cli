import { describe, expect, it } from "vitest";
import { divergencesToEvidence } from "../compare/evidence-map";
import type { Divergence } from "../compare/types";

const netStatus: Divergence = {
  plane: "network",
  kind: "net.status",
  requestId: "req-1",
  sig: "POST /checkout",
  before: 200,
  after: 500,
  brief: "POST /checkout status 200 -> 500",
};

const dbRow: Divergence = {
  plane: "db",
  kind: "db.row-value",
  table: "orders",
  pk: { id: 7 },
  before: { total: 10 },
  after: { total: 0 },
  brief: "orders#7 total 10 -> 0",
};

describe("divergencesToEvidence", () => {
  it("maps one evidence item per divergence, preserving order", () => {
    const items = divergencesToEvidence([netStatus, dbRow]);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("net.status");
    expect(items[1].kind).toBe("db.row-value");
  });

  it("carries plane to lane, brief, before/after, and ref discriminators", () => {
    const [net, db] = divergencesToEvidence([netStatus, dbRow]);
    expect(net.lane).toBe("network");
    expect(net.brief).toBe("POST /checkout status 200 -> 500");
    expect(net.before).toBe(200);
    expect(net.after).toBe(500);
    expect(net.ref).toEqual({ requestId: "req-1", sig: "POST /checkout" });

    expect(db.lane).toBe("db");
    expect(db.ref).toEqual({ table: "orders", pk: { id: 7 } });
  });

  it("produces unique, stable ids for IntentSignal foreign keys", () => {
    const items = divergencesToEvidence([netStatus, dbRow]);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(items[0].id).toBe("network:net.status:POST /checkout#0");
    expect(items[1].id).toBe("db:db.row-value:orders#1");
  });

  it("falls back to index for id when no discriminator exists", () => {
    const bare: Divergence = {
      plane: "env",
      kind: "env.snapshot",
      before: { flag: true },
      after: { flag: false },
      brief: "flags changed",
    };
    const [item] = divergencesToEvidence([bare]);
    expect(item.id).toBe("env:env.snapshot:0#0");
    expect(item.ref).toEqual({});
  });

  it("keeps ids distinct when two divergences share the same discriminator", () => {
    const dbRowA: Divergence = {
      plane: "db",
      kind: "db.row-value",
      table: "orders",
      pk: { id: 41 },
      before: { total: 10 },
      after: { total: 0 },
      brief: "orders#41 total 10 -> 0",
    };
    const dbRowB: Divergence = {
      plane: "db",
      kind: "db.row-value",
      table: "orders",
      pk: { id: 42 },
      before: { total: 20 },
      after: { total: 0 },
      brief: "orders#42 total 20 -> 0",
    };
    const items = divergencesToEvidence([dbRowA, dbRowB]);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });
});
