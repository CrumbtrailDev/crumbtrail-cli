import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  instrumentPlanetScaleClient,
  type DuckTypedPlanetScaleConnection,
  type DuckTypedPlanetScaleResult,
} from "../db/planetscale";
import { autoInstrumentDbClients } from "../db/auto-instrument";

function makeConnection() {
  const executed: string[] = [];
  const hostMutationResult: DuckTypedPlanetScaleResult = {
    rows: [],
    rowsAffected: 1,
    insertId: "0",
    fields: [],
  };
  const connection: DuckTypedPlanetScaleConnection = {
    async execute(sql) {
      const text = String(sql);
      executed.push(text);
      if (/^select/i.test(text)) {
        const after = executed.some((statement) => /^update/i.test(statement));
        return {
          rows: [
            {
              id: 7,
              total_cents: after ? 500 : 400,
              password: "drop-me",
            },
          ],
          rowsAffected: 0,
        };
      }
      return hostMutationResult;
    },
  };
  return { connection, executed, hostMutationResult };
}

describe("instrumentPlanetScaleClient", () => {
  it("captures HTTP update images and returns the exact driver result", async () => {
    const { connection, executed, hostMutationResult } = makeConnection();
    const events: BugEvent[] = [];
    const db = instrumentPlanetScaleClient(connection, {
      requestId: "req_1",
      captureBefore: true,
      emit: (event) => events.push(event),
    });

    const result = await db.execute(
      "update carts set total_cents = ? where id = ?",
      [500, 7],
    );

    expect(result).toBe(hostMutationResult);
    expect(executed).toEqual([
      "SELECT * FROM carts where id = ?",
      "update carts set total_cents = ? where id = ?",
      "SELECT * FROM carts WHERE id IN (?)",
    ]);
    const diff = events.find((event) => event.k === "db.diff");
    expect(diff?.d).toMatchObject({
      engine: "mysql",
      op: "update",
      table: "carts",
      pk: { id: 7 },
      before: { id: 7, total_cents: 400 },
      after: { id: 7, total_cents: 500 },
    });
    expect((diff?.d.before as Record<string, unknown>).password).toBe(
      "[REDACTED]",
    );
    expect((diff?.d.after as Record<string, unknown>).password).toBe(
      "[REDACTED]",
    );
  });

  it("wraps Client.connection() results", async () => {
    const { connection } = makeConnection();
    const client = { connection: vi.fn(() => connection) };
    const events: BugEvent[] = [];
    const wrapped = instrumentPlanetScaleClient(client, {
      requestId: "req_1",
      emit: (event) => events.push(event),
    });

    await wrapped.connection().execute(
      "delete from carts where id = ?",
      [7],
    );

    expect(client.connection).toHaveBeenCalledOnce();
    expect(events.find((event) => event.k === "db.diff")?.d).toMatchObject({
      engine: "mysql",
      op: "delete",
      before: { id: 7, total_cents: 400 },
    });
  });

  it("never lets capture emission failure break execute", async () => {
    const { connection, hostMutationResult } = makeConnection();
    const db = instrumentPlanetScaleClient(connection, {
      requestId: "req_1",
      emit: () => {
        throw new Error("sink failed");
      },
    });

    await expect(
      db.execute("insert into carts (total_cents) values (?)", [500]),
    ).resolves.toBe(hostMutationResult);
  });
});

describe("PlanetScale auto instrumentation", () => {
  it("wraps both connect() and Client connection factories", () => {
    const first = makeConnection().connection;
    const second = makeConnection().connection;
    class Client {
      connection() {
        return second;
      }
    }
    const mod: Record<string, unknown> = {
      connect: () => first,
      Client,
    };

    const report = autoInstrumentDbClients({
      drivers: ["@planetscale/database"],
      requestId: "req_1",
      emit: vi.fn(),
      resolve: () => mod,
    });

    expect(report.results[0]?.status).toBe("patched");
    expect((mod.connect as () => unknown)()).not.toBe(first);
    const WrappedClient = mod.Client as new () => { connection(): unknown };
    expect(new WrappedClient().connection()).not.toBe(second);
  });
});
