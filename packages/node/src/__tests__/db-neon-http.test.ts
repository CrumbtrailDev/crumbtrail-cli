import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { instrumentNeonHttpQuery } from "../db/neon-http";
import { autoInstrumentDbClients } from "../db/auto-instrument";

interface FakeNeonQuery {
  (...args: unknown[]): Promise<unknown>;
  query(text: string, params?: unknown[], options?: unknown): Promise<unknown>;
  executed: string[];
}

function tag(parts: string[]): string[] {
  const strings = [...parts] as string[] & { raw?: string[] };
  strings.raw = [...parts];
  return strings;
}

function makeNeon(): FakeNeonQuery {
  const executed: string[] = [];
  const run = (text: string): Promise<unknown> => {
    executed.push(text);
    const result = /update/i.test(text)
      ? [{ id: 7, total_cents: 500, password: "drop-me" }]
      : [{ id: 7, total_cents: 400 }];
    const promise = Promise.resolve(result);
    Object.defineProperty(promise, "queryData", {
      value: { query: text },
      enumerable: true,
    });
    return promise;
  };
  const sql = ((...args: unknown[]) => {
    const strings = args[0] as string[];
    let text = strings[0] ?? "";
    for (let index = 1; index < strings.length; index += 1) {
      text += `$${index}${strings[index]}`;
    }
    return run(text);
  }) as FakeNeonQuery;
  sql.query = (text) => run(text);
  sql.executed = executed;
  return sql;
}

describe("instrumentNeonHttpQuery", () => {
  it("captures tagged HTTP mutations with a redacted after-image", async () => {
    const events: BugEvent[] = [];
    const raw = makeNeon();
    const sql = instrumentNeonHttpQuery(raw, {
      requestId: "req_1",
      emit: (event) => events.push(event),
    });

    const result = sql(
      tag(["update carts set total_cents = ", " where id = ", ""]),
      500,
      7,
    ) as Promise<unknown> & { queryData?: unknown };

    expect(result.queryData).toBeDefined();
    await expect(result).resolves.toEqual([
      { id: 7, total_cents: 500, password: "drop-me" },
    ]);
    expect(raw.executed[0]).toMatch(/RETURNING \*$/i);

    const diff = events.find((event) => event.k === "db.diff");
    expect(diff?.d).toMatchObject({
      engine: "postgres",
      op: "update",
      table: "carts",
      pk: { id: 7 },
      after: { id: 7, total_cents: 500 },
    });
    expect(diff?.d.before).toBeUndefined();
  });

  it("captures the query(text, params) form and preserves query options", async () => {
    const events: BugEvent[] = [];
    const raw = makeNeon();
    const query = vi.spyOn(raw, "query");
    const sql = instrumentNeonHttpQuery(raw, {
      requestId: "req_1",
      captureReads: true,
      emit: (event) => events.push(event),
    });
    const queryOptions = { fullResults: false };

    await sql.query!(
      "select * from carts where id = $1",
      [7],
      queryOptions,
    );

    expect(query).toHaveBeenCalledWith(
      "select * from carts where id = $1",
      [7],
      queryOptions,
    );
    expect(events.some((event) => event.k === "db.statement")).toBe(true);
    expect(events.some((event) => event.k === "db.read")).toBe(true);
  });

  it("returns the original rejection and records the failed statement", async () => {
    const failure = new Error("fetch failed");
    const raw = makeNeon();
    raw.query = () => Promise.reject(failure);
    const events: BugEvent[] = [];
    const sql = instrumentNeonHttpQuery(raw, {
      requestId: "req_1",
      emit: (event) => events.push(event),
    });

    await expect(sql.query!("select * from carts")).rejects.toBe(failure);
    expect(events.find((event) => event.k === "db.error")?.d.table).toBe(
      "carts",
    );
  });

  it("leaves composed template fragments untouched", () => {
    const raw = makeNeon();
    const sql = instrumentNeonHttpQuery(raw, {
      requestId: "req_1",
      emit: vi.fn(),
    });
    const fragment = { queryData: { query: "where id = $1" } };

    void sql(tag(["select * from carts ", ""]), fragment);

    expect(raw.executed[0]).toBe("select * from carts $1");
  });
});

describe("Neon HTTP auto instrumentation", () => {
  it("wraps query functions returned by the neon factory", async () => {
    const raw = makeNeon();
    const mod: Record<string, unknown> = { neon: () => raw };
    const events: BugEvent[] = [];

    const report = autoInstrumentDbClients({
      drivers: ["@neondatabase/serverless"],
      requestId: "req_1",
      emit: (event) => events.push(event),
      resolve: () => mod,
    });

    expect(report.results[0]?.status).toBe("patched");
    const neon = mod.neon as () => FakeNeonQuery;
    await neon().query("update carts set total_cents = $1 where id = $2", [
      500,
      7,
    ]);
    expect(events.some((event) => event.k === "db.diff")).toBe(true);
  });
});
