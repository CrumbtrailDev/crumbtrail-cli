import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { instrumentNodeRedisClient } from "../cache";

function fakeNodeRedis(values: Record<string, string> = {}) {
  return {
    async get(key: string) {
      return values[key] ?? null;
    },
    async set(_key: string, _value: string, _options?: unknown) {
      return "OK";
    },
    async setEx(_key: string, _seconds: number, _value: string) {
      return "OK";
    },
    async del(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      return list.filter((key) => key in values).length;
    },
    async hGet(_key: string, _field: string) {
      return "hash value";
    },
    async hMGet(_key: string, _fields: string[]) {
      return ["hash value", null];
    },
    async hSet(_key: string, _field: string, _value: string) {
      return 1;
    },
    async hDel(_key: string, _field: string) {
      return 1;
    },
    async getDel(_key: string) {
      return "deleted value";
    },
    async incr(_key: string) {
      return 2;
    },
    async decr(_key: string) {
      return 1;
    },
    async expire(_key: string, _seconds: number) {
      return 1;
    },
    async persist(_key: string) {
      return 1;
    },
    async ttl(_key: string) {
      return 30;
    },
  };
}

describe("instrumentNodeRedisClient", () => {
  it("captures a redacted hit with the active request id", async () => {
    const events: BugEvent[] = [];
    const client = instrumentNodeRedisClient(
      fakeNodeRedis({ "customer:12345:profile": "personal profile text" }),
      {
        emit: (event) => events.push(event),
        getRequestId: () => "req_redis_1",
      },
    );

    await expect(client.get("customer:12345:profile")).resolves.toBe(
      "personal profile text",
    );

    expect(events[0]).toMatchObject({
      k: "cache",
      d: {
        driver: "redis",
        op: "get",
        key: "customer:*:profile",
        requestId: "req_redis_1",
        hit: true,
      },
    });
    expect(events[0]?.d.value).toEqual(
      expect.objectContaining({ $redacted: "[REDACTED]" }),
    );
  });

  it("captures object and setEx TTL forms", async () => {
    const events: BugEvent[] = [];
    const client = instrumentNodeRedisClient(fakeNodeRedis(), {
      emit: (event) => events.push(event),
      requestId: "req_redis_2",
    });

    await client.set("cart:88", "first value", { EX: 30 });
    await client.setEx("cart:99", 45, "second value");

    expect(events.map((event) => event.d.ttlMs)).toEqual([30_000, 45_000]);
    expect(events.map((event) => event.d.op)).toEqual(["set", "setex"]);
    expect(events.map((event) => event.d.key)).toEqual(["cart:*", "cart:*"]);
  });

  it("captures multi-key delete outcome", async () => {
    const events: BugEvent[] = [];
    const client = instrumentNodeRedisClient(
      fakeNodeRedis({ "cart:1": "a", "cart:2": "b" }),
      {
        emit: (event) => events.push(event),
        requestId: "req_redis_3",
      },
    );

    await expect(client.del(["cart:1", "cart:missing"])).resolves.toBe(1);

    expect(events[0]?.d).toMatchObject({
      op: "del",
      key: ["cart:*", "cart:missing"],
      hit: true,
    });
  });

  it("returns the host result when request resolution or emission fails", async () => {
    const requestFailure = instrumentNodeRedisClient(fakeNodeRedis(), {
      emit: vi.fn(),
      getRequestId: () => {
        throw new Error("context unavailable");
      },
    });
    await expect(requestFailure.get("safe:key")).resolves.toBeNull();

    const sinkFailure = instrumentNodeRedisClient(fakeNodeRedis(), {
      emit: () => {
        throw new Error("sink unavailable");
      },
      requestId: "req_redis_4",
    });
    await expect(sinkFailure.set("safe:key", "value")).resolves.toBe("OK");
  });

  it("captures hash, atomic, counter, and expiry operations", async () => {
    const events: BugEvent[] = [];
    const client = instrumentNodeRedisClient(fakeNodeRedis(), {
      emit: (event) => events.push(event),
      requestId: "req_redis_operations",
    });

    await client.hGet("profile:123", "displayName");
    await client.hMGet("profile:123", ["displayName", "timezone"]);
    await client.hSet("profile:123", "displayName", "Private Name");
    await client.hDel("profile:123", "displayName");
    await client.getDel("session:123");
    await client.incr("counter:123");
    await client.decr("counter:123");
    await client.expire("profile:123", 60);
    await client.persist("profile:123");
    await client.ttl("profile:123");

    expect(events.map((event) => event.d.op)).toEqual([
      "hget",
      "hmget",
      "hset",
      "hdel",
      "getdel",
      "incr",
      "decr",
      "expire",
      "persist",
      "ttl",
    ]);
    expect(events[0]?.d).toMatchObject({
      key: "profile:*",
      hit: true,
    });
    expect(events[1]?.d).toMatchObject({
      key: "profile:*",
      hit: true,
    });
    expect(events[4]?.d).toMatchObject({ key: "session:*", hit: true });
    expect(events[7]?.d).toMatchObject({
      key: "profile:*",
      hit: true,
      ttlMs: 60_000,
    });
    expect(events[9]?.d).toMatchObject({
      key: "profile:*",
      hit: true,
      ttlMs: 30_000,
      value: 30,
    });
  });

  it("records a bounded pipeline summary and preserves a rejected command", async () => {
    const events: BugEvent[] = [];
    const client = instrumentNodeRedisClient(
      {
        ...fakeNodeRedis(),
        multi() {
          const batch = {
            get(_key: string) {
              return batch;
            },
            hSet(_key: string, _field: string, _value: string) {
              return batch;
            },
            exec: async () => ["cached value", 1],
          };
          return batch;
        },
        pipeline() {
          const batch = {
            get(_key: string) {
              return batch;
            },
            exec: async () => ["cached value"],
          };
          return batch;
        },
      },
      {
        emit: (event) => events.push(event),
        requestId: "req_redis_pipeline",
      },
    );

    const batch = client.multi();
    await batch.get("cart:123").hSet("cart:123", "sku", "private sku").exec();

    expect(events).toContainEqual(
      expect.objectContaining({
        k: "cache",
        d: expect.objectContaining({
          op: "transaction",
          summary: {
            operationCount: 2,
            operations: ["get", "hset"],
          },
        }),
      }),
    );
    await client.pipeline().get("cart:456").exec();
    expect(events).toContainEqual(
      expect.objectContaining({
        k: "cache",
        d: expect.objectContaining({
          op: "pipeline",
          summary: {
            operationCount: 1,
            operations: ["get"],
          },
        }),
      }),
    );

    const failingClient = instrumentNodeRedisClient(
      {
        ...fakeNodeRedis(),
        async get(_key: string) {
          throw failure;
        },
      },
      {
        emit: (event) => events.push(event),
        requestId: "req_redis_failure",
      },
    );
    await expect(failingClient.get("cache:123")).rejects.toBe(failure);
    expect(events).toContainEqual(
      expect.objectContaining({
        k: "cache",
        d: expect.objectContaining({
          op: "get",
          outcome: "failure",
          errorName: "Error",
          error: "cache backend token=[REDACTED]",
        }),
      }),
    );
  });
});

const failure = new Error("cache backend token=secret");
