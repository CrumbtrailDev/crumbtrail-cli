import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  AUTO_INSTRUMENT_DRIVERS,
  autoInstrumentDbClients,
  formatAutoInstrumentReport,
  type AutoInstrumentDriver,
} from "../db/auto-instrument";

/** A `pg`-shaped module whose clients record every statement they were asked to run. */
function fakePgModule() {
  const executed: string[] = [];
  class Client {
    public tag = "client";
    async query(text: unknown): Promise<{ rows: unknown[]; rowCount: number }> {
      executed.push(String(text));
      return { rows: [{ id: 1, total: 10 }], rowCount: 1 };
    }
  }
  class Pool extends Client {
    public override tag = "pool";
  }
  return { mod: { Client, Pool } as Record<string, unknown>, executed };
}

function resolverFor(
  modules: Partial<Record<AutoInstrumentDriver, unknown>>,
): (specifier: string) => unknown {
  return (specifier: string) => {
    if (specifier in modules)
      return modules[specifier as AutoInstrumentDriver] as unknown;
    const error = new Error(`Cannot find module '${specifier}'`);
    (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
    throw error;
  };
}

describe("autoInstrumentDbClients", () => {
  it("wraps a pg client so a mutation emits db evidence with no host wiring", async () => {
    const { mod, executed } = fakePgModule();
    const emit = vi.fn<(event: BugEvent) => void>();

    autoInstrumentDbClients({
      emit,
      requestId: "req_1",
      drivers: ["pg"],
      resolve: resolverFor({ pg: mod }),
    });

    const Pool = mod.Pool as new () => { query(t: string): Promise<unknown> };
    const pool = new Pool();
    await pool.query("UPDATE carts SET total = 10 WHERE id = 1");

    // The host's statement still ran.
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("UPDATE carts");
    // …and produced evidence the app never asked for.
    expect(emit).toHaveBeenCalled();
    const kinds = emit.mock.calls.map((c) => c[0]?.k);
    expect(kinds.some((k) => typeof k === "string" && k.startsWith("db"))).toBe(
      true,
    );
  });

  it("reports a driver the app does not depend on as not-installed, not an error", () => {
    const report = autoInstrumentDbClients({
      emit: vi.fn(),
      resolve: resolverFor({}),
    });
    expect(report.results).toHaveLength(AUTO_INSTRUMENT_DRIVERS.length);
    for (const result of report.results) {
      expect(result.status).toBe("not-installed");
    }
    // Nothing patched ⇒ nothing claimed.
    expect(formatAutoInstrumentReport(report)).toBe("");
  });

  it("restores the original factories", async () => {
    const { mod, executed } = fakePgModule();
    const original = mod.Pool;
    const emit = vi.fn<(event: BugEvent) => void>();

    const report = autoInstrumentDbClients({
      emit,
      requestId: "req_1",
      drivers: ["pg"],
      resolve: resolverFor({ pg: mod }),
    });
    expect(mod.Pool).not.toBe(original);

    report.restore();
    expect(mod.Pool).toBe(original);

    const Pool = mod.Pool as new () => { query(t: string): Promise<unknown> };
    await new Pool().query("UPDATE carts SET total = 11 WHERE id = 1");
    expect(executed).toHaveLength(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("restore() is idempotent", () => {
    const { mod } = fakePgModule();
    const original = mod.Pool;
    const report = autoInstrumentDbClients({
      emit: vi.fn(),
      drivers: ["pg"],
      resolve: resolverFor({ pg: mod }),
    });
    report.restore();
    report.restore();
    expect(mod.Pool).toBe(original);
  });

  it("does not double-wrap on a second install", async () => {
    const { mod } = fakePgModule();
    const emit = vi.fn<(event: BugEvent) => void>();
    const opts = {
      emit,
      requestId: "req_1",
      drivers: ["pg"] as AutoInstrumentDriver[],
      resolve: resolverFor({ pg: mod }),
    };

    autoInstrumentDbClients(opts);
    const second = autoInstrumentDbClients(opts);
    expect(second.results[0]?.status).toBe("already-patched");

    const Pool = mod.Pool as new () => { query(t: string): Promise<unknown> };
    await new Pool().query("UPDATE carts SET total = 12 WHERE id = 1");

    // One mutation ⇒ one diff event, not two.
    const diffs = emit.mock.calls.filter((c) =>
      String(c[0]?.k ?? "").startsWith("db.diff"),
    );
    expect(diffs.length).toBeLessThanOrEqual(1);
  });

  it("skips a driver whose exports are not the expected shape, without throwing", () => {
    const report = autoInstrumentDbClients({
      emit: vi.fn(),
      drivers: ["pg"],
      resolve: resolverFor({ pg: { Client: 42, Pool: "nope" } }),
    });
    expect(report.results[0]).toMatchObject({ status: "unsupported-shape" });
  });

  it("unwraps an ESM-wrapped CJS module via its default export", async () => {
    const { mod, executed } = fakePgModule();
    const emit = vi.fn<(event: BugEvent) => void>();

    autoInstrumentDbClients({
      emit,
      requestId: "req_1",
      drivers: ["pg"],
      resolve: resolverFor({ pg: { default: mod } }),
    });

    const Pool = mod.Pool as new () => { query(t: string): Promise<unknown> };
    await new Pool().query("UPDATE carts SET total = 13 WHERE id = 1");
    expect(executed).toHaveLength(1);
    expect(emit).toHaveBeenCalled();
  });

  it("keeps instanceof working through the wrapper", () => {
    const { mod } = fakePgModule();
    const original = mod.Pool as new () => object;
    autoInstrumentDbClients({
      emit: vi.fn(),
      drivers: ["pg"],
      resolve: resolverFor({ pg: mod }),
    });
    const Pool = mod.Pool as new () => object;
    // The proxy the adapter returns must still satisfy the driver's own type
    // checks, or host code doing `if (x instanceof pg.Pool)` breaks.
    expect(new Pool()).toBeInstanceOf(original);
  });

  it("never lets a resolver explosion escape into the host", () => {
    expect(() =>
      autoInstrumentDbClients({
        emit: vi.fn(),
        resolve: () => {
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
  });

  it("disables entirely on an empty driver list", () => {
    const resolve = vi.fn();
    const report = autoInstrumentDbClients({ emit: vi.fn(), drivers: [], resolve });
    expect(report.results).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("names what it patched and what it could not", () => {
    const { mod } = fakePgModule();
    const report = autoInstrumentDbClients({
      emit: vi.fn(),
      drivers: ["pg", "mysql2"],
      resolve: resolverFor({ pg: mod, mysql2: { createPool: 1 } }),
    });
    const line = formatAutoInstrumentReport(report);
    expect(line).toContain("pg");
    expect(line).toContain("mysql2");
  });
});
