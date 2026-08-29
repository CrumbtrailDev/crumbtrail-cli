import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  AUTO_INSTRUMENT_CACHE_DRIVERS,
  autoInstrumentCacheClients,
  type AutoInstrumentCacheDriver,
} from "../cache";

function resolverFor(
  modules: Partial<Record<AutoInstrumentCacheDriver, unknown>>,
) {
  return (specifier: string): unknown => {
    if (specifier in modules) {
      return modules[specifier as AutoInstrumentCacheDriver];
    }
    throw new Error(`Cannot find module '${specifier}'`);
  };
}

describe("autoInstrumentCacheClients", () => {
  it("wraps node-redis createClient and restores it", async () => {
    const executed: string[] = [];
    const redis = {
      createClient() {
        return {
          async get(key: string) {
            executed.push(key);
            return "cached value";
          },
        };
      },
    } as Record<string, unknown>;
    const original = redis.createClient;
    const events: BugEvent[] = [];
    const report = autoInstrumentCacheClients({
      emit: (event) => events.push(event),
      requestId: "req_auto_1",
      drivers: ["redis"],
      resolve: resolverFor({ redis }),
    });

    expect(report.results[0]).toMatchObject({
      driver: "redis",
      status: "patched",
    });
    const createClient = redis.createClient as () => {
      get(key: string): Promise<string>;
    };
    await expect(createClient().get("user:123:profile")).resolves.toBe(
      "cached value",
    );
    expect(events[0]?.d).toMatchObject({
      driver: "redis",
      requestId: "req_auto_1",
      key: "user:*:profile",
    });

    report.restore();
    expect(redis.createClient).toBe(original);
  });

  it("replaces the callable ioredis module export", async () => {
    class Redis {
      async get(_key: string) {
        return null;
      }
    }
    const registry: Record<string, unknown> = { ioredis: Redis };
    const events: BugEvent[] = [];
    const report = autoInstrumentCacheClients({
      emit: (event) => events.push(event),
      requestId: "req_auto_2",
      drivers: ["ioredis"],
      resolve: () => registry.ioredis,
      replaceModule: (specifier, value) => {
        registry[specifier] = value;
        return true;
      },
      hostIsEsm: () => false,
    });

    const PatchedRedis = registry.ioredis as new () => Redis;
    await expect(new PatchedRedis().get("cart:404")).resolves.toBeNull();
    expect(report.results[0]?.status).toBe("patched");
    expect(events[0]?.d).toMatchObject({
      driver: "ioredis",
      hit: false,
      requestId: "req_auto_2",
    });

    report.restore();
    expect(registry.ioredis).toBe(Redis);
  });

  it("wraps the Cluster constructor carried by the ioredis export", async () => {
    class Redis {
      static Cluster = class Cluster {
        async get(_key: string) {
          return "cluster value";
        }
      };
      async get(_key: string) {
        return "client value";
      }
    }
    const registry: Record<string, unknown> = { ioredis: Redis };
    const events: BugEvent[] = [];
    autoInstrumentCacheClients({
      emit: (event) => events.push(event),
      requestId: "req_cluster",
      drivers: ["ioredis"],
      resolve: () => registry.ioredis,
      replaceModule: (specifier, value) => {
        registry[specifier] = value;
        return true;
      },
      hostIsEsm: () => false,
    });

    const PatchedRedis = registry.ioredis as typeof Redis;
    await expect(new PatchedRedis.Cluster().get("cart:123")).resolves.toBe(
      "cluster value",
    );
    expect(events[0]?.d).toMatchObject({
      driver: "ioredis",
      key: "cart:*",
      requestId: "req_cluster",
    });
  });

  it("reports missing drivers without throwing", () => {
    const report = autoInstrumentCacheClients({
      emit: vi.fn(),
      resolve: resolverFor({}),
    });
    expect(report.results).toHaveLength(AUTO_INSTRUMENT_CACHE_DRIVERS.length);
    expect(
      report.results.every((result) => result.status === "not-installed"),
    ).toBe(true);
  });

  it("does not double-wrap a patched node-redis factory", () => {
    const redis = {
      createClient() {
        return { get: async () => null };
      },
      createCluster() {
        return { get: async () => null };
      },
    } as Record<string, unknown>;
    const options = {
      emit: vi.fn(),
      drivers: ["redis"] as const,
      resolve: resolverFor({ redis }),
    };
    autoInstrumentCacheClients(options);
    const second = autoInstrumentCacheClients(options);
    expect(second.results[0]?.status).toBe("already-patched");
  });
});
