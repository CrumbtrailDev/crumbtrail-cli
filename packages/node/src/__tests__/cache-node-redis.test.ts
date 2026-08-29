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
});
