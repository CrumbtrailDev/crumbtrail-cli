import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    query(text: string, _params?: unknown[]) {
      if (/^select/i.test(text)) {
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

describe("race evidence contract", () => {
  it("derives deterministic domain separated identifiers without exposing the credential", () => {
    const credential = "ctkey_0123456789abcdef0123456789abcdef0123456789abcdef";
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
        surface: "db.read",
        operation: "read",
        table: "customers",
        primaryKey: { id: 42 },
      })?.entityHash,
    ).not.toBe(first?.entityHash);
    expect(
      resolver({
        surface: "cache",
        operation: "get",
        cacheKey: "orders:42",
        resourceSubject: "order:42",
      })?.entityHash,
    ).not.toBe(first?.entityHash);
    const cacheEvidence = buildCacheEvent({
      driver: "redis",
      op: "get",
      keys: ["orders:42"],
      requestId: "req-cache-hmac",
      raceEvidence: {
        enabled: true,
        resourceSubject: "order:42",
        resolve: resolver,
      },
    });
    expect(JSON.stringify(cacheEvidence.d.raceEvidence)).not.toContain(
      "orders:42",
    );
    expect(JSON.stringify(cacheEvidence.d.raceEvidence)).not.toContain(
      "[REDACTED_KEY]",
    );
  });

  it("refuses weak credentials and malformed opaque output", () => {
    expect(createHmacRaceEvidenceResolver("short")).toBeUndefined();
    expect(createHmacRaceEvidenceResolver("a".repeat(64))).toBeUndefined();
    const resolver = createHmacRaceEvidenceResolver(
      "ctkey_0123456789abcdef0123456789abcdef0123456789abcdef",
    )!;
    expect(
      resolver({ surface: "db.read", operation: "read", primaryKey: {} }),
    ).toBeUndefined();
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
    expect(
      buildRaceEvidence(
        {
          enabled: true,
          identifiers: {
            entityHash: opaque("e"),
          },
        },
        { surface: "cache", operation: "mget", cacheKey: ["a", "b"] },
      ),
    ).toBeUndefined();
    expect(
      buildRaceEvidence(
        {
          enabled: true,
          identifiers: {
            entityHash: opaque("e"),
          },
        },
        { surface: "cache", operation: "eval", cacheKey: "key" },
      ),
    ).toBeUndefined();
  });

  it("rejects inherited unknown fields and non plain identifier prototypes", () => {
    const inherited = Object.create({ extra: opaque("x") }) as {
      entityHash: string;
    };
    inherited.entityHash = opaque("e");
    expect(
      buildRaceEvidence(
        { enabled: true, identifiers: inherited },
        { surface: "cache", operation: "get", cacheKey: "key" },
      ),
    ).toBeUndefined();

    class Identifier {
      entityHash = opaque("e");
    }
    expect(
      buildRaceEvidence(
        { enabled: true, identifiers: new Identifier() },
        { surface: "cache", operation: "get", cacheKey: "key" },
      ),
    ).toBeUndefined();
  });

  it("supports common BSON ObjectId values without calling plain object lookalikes", () => {
    class ObjectId {
      constructor(private readonly value: string) {}

      toHexString(): string {
        return this.value;
      }
    }
    const credential = "ctkey_0123456789abcdef0123456789abcdef0123456789abcdef";
    const resolver = createHmacRaceEvidenceResolver(credential)!;
    const first = resolver({
      surface: "db.read",
      operation: "read",
      table: "orders",
      primaryKey: { _id: new ObjectId("0123456789abcdef01234567") },
    });
    const second = resolver({
      surface: "db.read",
      operation: "read",
      table: "orders",
      primaryKey: { _id: new ObjectId("0123456789ABCDEF01234567") },
    });
    expect(first?.entityHash).toBe(second?.entityHash);

    let called = false;
    const lookalike = {
      toHexString: () => {
        called = true;
        return "0123456789abcdef01234567";
      },
    };
    expect(
      resolver({
        surface: "db.read",
        operation: "read",
        table: "orders",
        primaryKey: { _id: lookalike },
      }),
    ).toBeUndefined();
    expect(called).toBe(false);
  });

  it("requires a complete nonempty configured DB primary key", () => {
    const identifiers = {
      enabled: true,
      identifiers: { entityHash: opaque("e") },
    };
    const base = {
      op: "update" as const,
      table: "orders",
      after: { tenantId: "t1", id: 1 },
      requestId: "req-pk",
      raceEvidence: identifiers,
      primaryKeyColumns: ["tenantId", "id"],
    };
    expect(
      buildDbDiffEvent({ ...base, pk: { tenantId: "t1" } }).d.raceEvidence,
    ).toBeUndefined();
    expect(
      buildDbDiffEvent({ ...base, pk: { tenantId: "t1", id: undefined } }).d
        .raceEvidence,
    ).toBeUndefined();
    expect(
      buildDbDiffEvent({ ...base, pk: { tenantId: "t1", id: 1 } }).d
        .raceEvidence,
    ).toEqual({ entityHash: opaque("e") });
  });

  it("keeps canonical object identity stable across process locale settings", () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const child = `
      import { createHmacRaceEvidenceResolver } from "./src/race-evidence.ts";
      const resolver = createHmacRaceEvidenceResolver("ctkey_0123456789abcdef0123456789abcdef0123456789abcdef");
      const primaryKey = { "\\uE000": "a", Z: "b", "\\u00E9": "c", e: "d" };
      process.stdout.write(JSON.stringify(resolver({ surface: "db.read", operation: "read", table: "orders", primaryKey })));
    `;
    const outputs = ["C", "en_US.UTF-8", "tr_TR.UTF-8", "sv_SE.UTF-8"].map(
      (locale) =>
        execFileSync(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", child],
          {
            cwd: packageRoot,
            env: { ...process.env, LANG: locale, LC_ALL: locale },
            encoding: "utf8",
          },
        ),
    );
    expect(new Set(outputs).size).toBe(1);
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

  it("rejects hidden and symbol metadata instead of relying on enumerable keys", () => {
    const identifiers = { entityHash: opaque("e") } as Record<
      string | symbol,
      string
    >;
    Object.defineProperty(identifiers, "hidden", {
      value: opaque("h"),
      enumerable: false,
    });
    identifiers[Symbol("metadata")] = opaque("m");

    expect(
      buildRaceEvidence(
        { enabled: true, identifiers: identifiers as never },
        { surface: "db.read", operation: "read", primaryKey: { id: 1 } },
      ),
    ).toBeUndefined();
  });

  it("adds only DB read and diff evidence for one entity, including configured versions", () => {
    const raceEvidence = {
      enabled: true,
      resolve: createHmacRaceEvidenceResolver(
        "ctkey_0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
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
        raceEvidence: identifiers as never,
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
        raceEvidence: {
          enabled: true,
          resolve: () => identifiers.identifiers,
        },
      },
    );
    await expect(cache.get("orders:42")).resolves.toBe("private value");
    expect(cacheEvents[0]?.d.raceEvidence).toEqual({ entityHash: opaque("e") });

    const dbEvents: BugEvent[] = [];
    const db = instrumentPgClient(fakePgClient([{ id: 42, version: 2 }]), {
      requestId: "req-db",
      captureReads: true,
      emit: (event) => dbEvents.push(event),
      raceEvidence: {
        enabled: true,
        optimisticVersionField: "version",
        resolve: () => identifiers.identifiers,
      },
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

  it("does not reuse static identifiers on a multi-operation cache wrapper", async () => {
    const events: BugEvent[] = [];
    const cache = instrumentIoredisClient(
      {
        async get(key: string) {
          return key;
        },
      },
      {
        requestId: "req-static",
        emit: (event) => events.push(event),
        raceEvidence: {
          enabled: true,
          identifiers: { entityHash: opaque("e") },
        } as never,
      },
    );
    const get = (cache as unknown as { get(key: string): Promise<unknown> })
      .get;
    await get.call(cache, "orders:1");
    await get.call(cache, "orders:2");
    expect(events.every((event) => event.d.raceEvidence === undefined)).toBe(
      true,
    );
  });

  it("does not reuse static identifiers on a multi-operation DB wrapper", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(fakePgClient([{ id: 1 }]), {
      requestId: "req-static-db",
      captureReads: true,
      emit: (event) => events.push(event),
      raceEvidence: {
        enabled: true,
        identifiers: { entityHash: opaque("e") },
      } as never,
    });
    await db.query("SELECT * FROM orders WHERE id = 1");
    await db.query("SELECT * FROM orders WHERE id = 2");
    expect(events.every((event) => event.d.raceEvidence === undefined)).toBe(
      true,
    );
  });
});
