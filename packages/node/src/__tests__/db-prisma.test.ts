import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  autoInstrumentDbClients,
  instrumentPrismaClient,
  type DuckTypedPrismaExtension,
  type DuckTypedPrismaQueryInput,
} from "../db";

interface FakePrismaClient {
  $extends(extension: DuckTypedPrismaExtension): FakeExtendedPrismaClient;
}

interface FakeExtendedPrismaClient extends FakePrismaClient {
  run(
    input: Omit<DuckTypedPrismaQueryInput, "query">,
    result: unknown,
  ): Promise<unknown>;
  reject(
    input: Omit<DuckTypedPrismaQueryInput, "query">,
    error: unknown,
  ): Promise<unknown>;
}

function makePrismaClient(): FakePrismaClient {
  const client: FakePrismaClient = {
    $extends(extension) {
      return {
        ...client,
        run(input, result) {
          return extension.query.$allOperations({
            ...input,
            query: async () => result,
          });
        },
        reject(input, error) {
          return extension.query.$allOperations({
            ...input,
            query: async () => {
              throw error;
            },
          });
        },
      };
    },
  };
  return client;
}

function setup(extra: Record<string, unknown> = {}) {
  const events: BugEvent[] = [];
  const client = instrumentPrismaClient(makePrismaClient(), {
    requestId: "req_prisma",
    emit: (event) => events.push(event),
    ...extra,
  }) as FakeExtendedPrismaClient;
  return { client, events };
}

describe("instrumentPrismaClient", () => {
  it("uses delete's returned row as the real before-image", async () => {
    const { client, events } = setup();
    const deleted = {
      id: 7,
      email: "person@example.test",
      password: "must-not-rest",
    };

    await expect(
      client.run(
        { model: "User", operation: "delete", args: { where: { id: 7 } } },
        deleted,
      ),
    ).resolves.toBe(deleted);

    const diff = events.find((event) => event.k === "db.diff");
    expect(diff?.d).toMatchObject({
      engine: "prisma",
      op: "delete",
      table: "User",
      pk: { id: 7 },
      before: {
        id: 7,
        email: "[REDACTED]",
        password: "[REDACTED]",
      },
    });
    expect(diff?.d.beforeImageStatus).toBeUndefined();
  });

  it("marks an update before-image unavailable instead of doing a racy pre-read", async () => {
    const { client, events } = setup();

    await client.run(
      {
        model: "Order",
        operation: "update",
        args: { where: { id: 4 }, data: { state: "paid" } },
      },
      { id: 4, state: "paid" },
    );

    const diff = events.find((event) => event.k === "db.diff");
    expect(diff?.d.before).toBeUndefined();
    expect(diff?.d.beforeImageStatus).toEqual({
      status: "unavailable",
      reason: "prisma_extension_no_transaction_context",
    });
    expect(diff?.d.after).toEqual({ id: 4, state: "paid" });
  });

  it("marks a selected delete result as a partial before-image", async () => {
    const { client, events } = setup();

    await client.run(
      {
        model: "Session",
        operation: "delete",
        args: { where: { id: "s1" }, select: { id: true } },
      },
      { id: "s1" },
    );

    const diff = events.find((event) => event.k === "db.diff");
    expect(diff?.d.before).toEqual({ id: "s1" });
    expect(diff?.d.beforeImageStatus).toEqual({
      status: "partial",
      reason: "prisma_result_selection",
    });
  });

  it("does not mistake a model's count column for a bulk result envelope", async () => {
    const { client, events } = setup();

    await client.run(
      {
        model: "Inventory",
        operation: "create",
        args: { data: { id: 2, count: 12 } },
      },
      { id: 2, count: 12 },
    );

    expect(events.find((event) => event.k === "db.diff")?.d.after).toEqual({
      id: 2,
      count: 12,
    });
    expect(
      events.find((event) => event.k === "db.diff")?.d.rowCount,
    ).toBeUndefined();
  });

  it("captures returning bulk rows and marks count-only bulk deletes unavailable", async () => {
    const { client, events } = setup();

    await client.run(
      {
        model: "Ledger",
        operation: "updateManyAndReturn",
        args: { where: { state: "open" }, data: { state: "closed" } },
      },
      [
        { id: 1, state: "closed" },
        { id: 2, state: "closed" },
      ],
    );
    await client.run(
      {
        model: "Session",
        operation: "deleteMany",
        args: { where: { expired: true } },
      },
      { count: 3 },
    );

    const ledger = events.filter(
      (event) => event.k === "db.diff" && event.d.table === "Ledger",
    );
    expect(ledger).toHaveLength(2);
    expect(ledger[0]?.d.beforeImageStatus).toEqual({
      status: "unavailable",
      reason: "prisma_extension_no_transaction_context",
    });
    expect(
      events.find(
        (event) => event.k === "db.diff" && event.d.table === "Session",
      )?.d.beforeImageStatus,
    ).toEqual({
      status: "unavailable",
      reason: "prisma_bulk_result_no_row_images",
    });
  });

  it("preserves bulk semantics when a returning bulk mutation yields one row", async () => {
    const { client, events } = setup({
      raceEvidence: {
        enabled: true,
        identifiers: { entityHash: "e".repeat(64) },
      },
    });

    await client.run(
      {
        model: "Ledger",
        operation: "updateManyAndReturn",
        args: { where: { id: 1 }, data: { state: "closed" } },
      },
      [{ id: 1, state: "closed" }],
    );
    await client.run(
      {
        model: "Ledger",
        operation: "createManyAndReturn",
        args: { data: [{ id: 2 }] },
      },
      [{ id: 2 }],
    );

    const diffs = events.filter((event) => event.k === "db.diff");
    expect(diffs).toHaveLength(2);
    expect(diffs.every((event) => event.d.raceEvidence === undefined)).toBe(
      true,
    );
  });

  it("suppresses race evidence for successful and failed work without transaction outcome", async () => {
    const { client, events } = setup({
      raceEvidence: {
        enabled: true,
        identifiers: { entityHash: "e".repeat(64) },
      },
    });
    const failure = new Error("rolled back");

    await client.run(
      {
        model: "Order",
        operation: "update",
        args: { where: { id: 4 }, data: { state: "paid" } },
      },
      { id: 4, state: "paid" },
    );
    await expect(
      client.reject(
        {
          model: "Order",
          operation: "update",
          args: { where: { id: 4 }, data: { state: "rolled-back" } },
        },
        failure,
      ),
    ).rejects.toBe(failure);

    expect(events.filter((event) => event.k === "db.diff")).toHaveLength(1);
    expect(
      events.find((event) => event.k === "db.diff")?.d.raceEvidence,
    ).toBeUndefined();
  });

  it("keeps upsert distinct when Prisma cannot reveal which branch ran", async () => {
    const { client, events } = setup();

    await client.run(
      {
        model: "Profile",
        operation: "upsert",
        args: {
          where: { id: 5 },
          create: { id: 5, name: "Ada" },
          update: { name: "Ada" },
        },
      },
      { id: 5, name: "Ada" },
    );

    expect(events.find((event) => event.k === "db.diff")?.d).toMatchObject({
      op: "upsert",
      after: { id: 5, name: "Ada" },
      beforeImageStatus: {
        status: "unavailable",
        reason: "prisma_upsert_branch_unknown",
      },
    });
  });

  it("captures raw reads and raw count-only mutations without retaining bind values", async () => {
    const { client, events } = setup({ captureReads: true });

    await client.run(
      {
        operation: "$queryRaw",
        args: [
          {
            text: "SELECT id, email FROM users WHERE id = $1",
            values: [9],
          },
        ],
      },
      [{ id: 9, email: "person@example.test" }],
    );
    await client.run(
      {
        operation: "$executeRaw",
        args: [
          {
            text: "DELETE FROM sessions WHERE user_id = $1",
            values: [9],
          },
        ],
      },
      2,
    );

    expect(events.find((event) => event.k === "db.read")?.d).toMatchObject({
      engine: "prisma",
      table: "users",
      row: { id: 9, email: "[REDACTED]" },
    });
    const rawDelete = events.find(
      (event) => event.k === "db.diff" && event.d.table === "sessions",
    );
    expect(rawDelete?.d).toMatchObject({
      op: "delete",
      rowCount: 2,
      beforeImageStatus: {
        status: "unavailable",
        reason: "prisma_raw_result_no_row_images",
      },
    });
    expect(JSON.stringify(events)).not.toContain('"values":[9]');
  });

  it("returns the host result when capture emission throws", async () => {
    const result = { id: 1, state: "ready" };
    const client = instrumentPrismaClient(makePrismaClient(), {
      requestId: "req_throw",
      emit: () => {
        throw new Error("sink failed");
      },
    }) as FakeExtendedPrismaClient;

    await expect(
      client.run(
        { model: "Job", operation: "create", args: { data: result } },
        result,
      ),
    ).resolves.toBe(result);
  });

  it("returns the same extension instead of double instrumenting a client", () => {
    const base = makePrismaClient();
    const options = { requestId: "req_once", emit: vi.fn() };
    const first = instrumentPrismaClient(base, options);
    const second = instrumentPrismaClient(base, options);
    const third = instrumentPrismaClient(first, options);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("rethrows the host's own raw query error object", async () => {
    const { client } = setup();
    const failure = Object.assign(new Error("database failed"), {
      code: "P2002",
    });

    await expect(
      client.reject(
        {
          operation: "$executeRaw",
          args: ["UPDATE users SET email = ? WHERE id = ?"],
        },
        failure,
      ),
    ).rejects.toBe(failure);
  });
});

describe("Prisma auto-instrumentation", () => {
  it("wraps @prisma/client's constructor and restores it", async () => {
    const events: BugEvent[] = [];
    class PrismaClient {
      $extends(extension: DuckTypedPrismaExtension): FakeExtendedPrismaClient {
        return makePrismaClient().$extends(extension);
      }
    }
    const mod: Record<string, unknown> = { PrismaClient };

    const report = autoInstrumentDbClients({
      requestId: "req_auto",
      emit: (event) => events.push(event),
      drivers: ["@prisma/client"],
      resolve: () => mod,
    });
    expect(report.results).toEqual([
      { driver: "@prisma/client", status: "patched" },
    ]);

    const Patched = mod.PrismaClient as new () => FakeExtendedPrismaClient;
    const client = new Patched();
    await client.run(
      { model: "Cart", operation: "create", args: { data: { id: 3 } } },
      { id: 3 },
    );
    expect(events.some((event) => event.k === "db.diff")).toBe(true);

    report.restore();
    expect(mod.PrismaClient).toBe(PrismaClient);
  });

  it("leaves a non-Prisma value untouched", () => {
    const value = { query: vi.fn() };
    expect(instrumentPrismaClient(value as never, { emit: vi.fn() })).toBe(
      value,
    );
  });
});
