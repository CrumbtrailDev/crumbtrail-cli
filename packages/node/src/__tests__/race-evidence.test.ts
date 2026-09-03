import { describe, expect, it } from "vitest";
import type {
  BugEvent,
  DbDiffEventData,
  DbReadEventData,
} from "crumbtrail-core";
import { buildCacheEvent, instrumentIoredisClient } from "../cache";
import { buildDbDiffEvent, buildDbReadEvent, instrumentPgClient } from "../db";
import {
  buildRaceEvidence,
  createHmacRaceEvidenceResolver,
  RACE_EVIDENCE_IDENTIFIER_LENGTH,
} from "../race-evidence";

const opaque = (character: string): string =>
  character.repeat(RACE_EVIDENCE_IDENTIFIER_LENGTH);

function fakePgClient(rows: Array<Record<string, unknown>>) {
  return {
    query(text: string) {
      if (/^select/i.test(text)) {
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

describe("race evidence contract", () => {
  it("derives deterministic domain separated identifiers without exposing the credential", () => {
    const credential = `ctkey_${"x".repeat(48)}`;
    const resolver = createHmacRaceEvidenceResolver(credential)!;
    const first = resolver({
      surface: "db.read",
      operation: "read",
      table: "orders",
      primaryKey: { id: 42 },
      resourceSubject: "order:42",
      currentVersion: 7,
    });
    const second = resolver({
      surface: "db.read",
      operation: "read",
      table: "orders",
      primaryKey: { id: 42 },
      resourceSubject: "order:42",
      currentVersion: 7,
    });

    expect(first).toEqual(second);
    expect(first?.entityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.resourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.versionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.entityHash).not.toBe(first?.resourceHash);
    expect(JSON.stringify(first)).not.toContain(credential);
    expect(
      resolver({
        surface: "cache",
        operation: "get",
        cacheKey: "orders:42",
        resourceSubject: "order:42",
      })?.entityHash,
    ).not.toBe(first?.entityHash);
  });

  it("refuses weak credentials and malformed opaque output", () => {
    expect(createHmacRaceEvidenceResolver("short")).toBeUndefined();
    expect(
      buildRaceEvidence(
        {
          enabled: true,
          identifiers: {
            entityHash: "raw-primary-key",
          },
        },
        { surface: "cache", operation: "get", cacheKey: "key" },
      ),
    ).toBeUndefined();
    expect(
      buildRaceEvidence(
        {
          enabled: true,
          identifiers: {
            entityHash: opaque("a"),
            extra: opaque("b"),
          } as never,
        },
        { surface: "cache", operation: "get", cacheKey: "key" },
      ),
    ).toBeUndefined();
  });

  it("seals accepted application supplied identifiers", () => {
    const evidence = buildRaceEvidence(
      {
        enabled: true,
        identifiers: {
          resourceHash: opaque("r"),
          entityHash: opaque("e"),
          versionHash: opaque("v"),
        },
      },
      { surface: "db.read", operation: "read", primaryKey: { id: 1 } },
    );

    expect(evidence).toEqual({
      resourceHash: opaque("r"),
      entityHash: opaque("e"),
      versionHash: opaque("v"),
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(() => {
      (evidence as Record<string, unknown>).extra = opaque("x");
    }).toThrow();
  });

  it("adds only DB read and diff evidence for one entity, including configured versions", () => {
    const raceEvidence = {
      enabled: true,
      resolve: createHmacRaceEvidenceResolver(`ctkey_${"x".repeat(48)}`),
      resourceSubject: "order:42",
      optimisticVersionField: "version",
    };
    const diff = buildDbDiffEvent({
      op: "update",
      table: "orders",
      pk: { id: 42 },
      before: { id: 42, version: 3, total: 10 },
      after: { id: 42, version: 4, total: 11 },
      requestId: "req-1",
      raceEvidence,
    });
    const read = buildDbReadEvent({
      table: "orders",
      pk: { id: 42 },
      row: { id: 42, version: 4 },
      requestId: "req-2",
      raceEvidence,
    });

    const diffEvidence = (diff.d as unknown as DbDiffEventData).raceEvidence!;
    const readEvidence = (read.d as unknown as DbReadEventData).raceEvidence!;
    expect(diffEvidence.entityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(diffEvidence.entityHash).toBe(readEvidence.entityHash);
    expect(diffEvidence.resourceHash).toBe(readEvidence.resourceHash);
    expect(diffEvidence.beforeVersionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(diffEvidence.afterVersionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readEvidence.versionHash).toBe(diffEvidence.afterVersionHash);
    expect(JSON.stringify(diffEvidence)).not.toContain("order:42");
    expect(JSON.stringify(diffEvidence)).not.toContain('"version":3');
  });

  it("omits DB evidence for bulk rows and transaction scoped work", () => {
    const identifiers = {
      enabled: true,
      identifiers: { entityHash: opaque("e") },
    };
    const bulk = buildDbDiffEvent({
      op: "update",
      table: "orders",
      pk: { id: 1 },
      after: { id: 1 },
      rowCount: 2,
      requestId: "req-bulk",
      raceEvidence: identifiers,
    });
    const transaction = buildDbDiffEvent({
      op: "update",
      table: "orders",
      pk: { id: 1 },
      after: { id: 1 },
      transactionId: "tx-1",
      requestId: "req-tx",
      raceEvidence: identifiers,
    });

    expect((bulk.d as unknown as DbDiffEventData).raceEvidence).toBeUndefined();
    expect(
      (transaction.d as unknown as DbDiffEventData).raceEvidence,
    ).toBeUndefined();
  });

  it("omits race evidence from adapter emitted bulk rows and multi row reads", async () => {
    const identifiers = {
      enabled: true,
      identifiers: { entityHash: opaque("e") },
    };
    const events: BugEvent[] = [];
    const db = instrumentPgClient(
      fakePgClient([
        { id: 1, version: 1 },
        { id: 2, version: 1 },
      ]),
      {
        requestId: "req-bulk-adapter",
        captureReads: true,
        emit: (event) => events.push(event),
        raceEvidence: identifiers,
      },
    );

    await db.query("UPDATE orders SET version = version + 1");
    await db.query("SELECT * FROM orders");

    const rowEvents = events.filter(
      (event) => event.k === "db.diff" || event.k === "db.read",
    );
    expect(rowEvents.length).toBeGreaterThan(0);
    expect(rowEvents.every((event) => event.d.raceEvidence === undefined)).toBe(
      true,
    );
  });

  it("omits cache evidence for multi key operations and preserves normal capture", () => {
    const identifiers = {
      enabled: true,
      identifiers: { entityHash: opaque("e") },
    };
    const one = buildCacheEvent({
      driver: "redis",
      op: "get",
      keys: ["orders:42"],
      requestId: "req-cache",
      raceEvidence: identifiers,
    });
    const many = buildCacheEvent({
      driver: "redis",
      op: "del",
      keys: ["orders:42", "orders:43"],
      requestId: "req-cache",
      raceEvidence: identifiers,
    });

    expect(one.d.raceEvidence).toEqual({ entityHash: opaque("e") });
    expect(many.d.raceEvidence).toBeUndefined();
    expect(many.d.key).toEqual(["orders:*", "orders:*"]);
  });

  it("passes race evidence through instrumented cache and DB operations without changing results", async () => {
    const identifiers = {
      enabled: true,
      identifiers: { entityHash: opaque("e") },
    };
    const cacheEvents: BugEvent[] = [];
    const cache = instrumentIoredisClient(
      {
        async get(key: string) {
          return key === "orders:42" ? "private value" : null;
        },
      },
      {
        requestId: "req-cache",
        emit: (event) => cacheEvents.push(event),
        raceEvidence: identifiers,
      },
    );
    await expect(cache.get("orders:42")).resolves.toBe("private value");
    expect(cacheEvents[0]?.d.raceEvidence).toEqual({ entityHash: opaque("e") });

    const dbEvents: BugEvent[] = [];
    const db = instrumentPgClient(fakePgClient([{ id: 42, version: 2 }]), {
      requestId: "req-db",
      captureReads: true,
      emit: (event) => dbEvents.push(event),
      raceEvidence: { ...identifiers, optimisticVersionField: "version" },
    });
    await expect(
      db.query("SELECT * FROM orders WHERE id = $1", [42]),
    ).resolves.toEqual({
      rows: [{ id: 42, version: 2 }],
      rowCount: 1,
    });
    const read = dbEvents.find((event) => event.k === "db.read");
    expect(read?.d.raceEvidence).toEqual({ entityHash: opaque("e") });
  });
});
