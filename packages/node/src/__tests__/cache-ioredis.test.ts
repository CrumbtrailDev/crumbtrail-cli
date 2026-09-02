import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { instrumentIoredisClient } from "../cache";

function fakeIoredis(values: Record<string, string> = {}) {
  return {
    async get(key: string) {
      return values[key] ?? null;
    },
    async set(_key: string, _value: string, ..._options: unknown[]) {
      return "OK";
    },
    async del(...keys: string[]) {
      return keys.filter((key) => key in values).length;
    },
  };
}

describe("instrumentIoredisClient", () => {
  it("captures redacted hits and misses with request correlation", async () => {
    const events: BugEvent[] = [];
    const client = instrumentIoredisClient(
      fakeIoredis({ "user:alice@example.com:profile": "private profile text" }),
      {
        emit: (event) => events.push(event),
        getRequestId: () => "req_cache_1",
      },
    );

    await expect(client.get("user:alice@example.com:profile")).resolves.toBe(
      "private profile text",
    );
    await expect(client.get("user:999:missing")).resolves.toBeNull();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      k: "cache",
      d: {
        driver: "ioredis",
        op: "get",
        key: "user:*:profile",
        requestId: "req_cache_1",
        hit: true,
      },
    });
    expect(events[0]?.d.value).toEqual(
      expect.objectContaining({ $redacted: "[REDACTED]" }),
    );
    expect(events[1]?.d).toMatchObject({
      key: "user:*:missing",
      hit: false,
    });
  });

  it("captures set TTL and redacts the stored value", async () => {
    const events: BugEvent[] = [];
    const client = instrumentIoredisClient(fakeIoredis(), {
      emit: (event) => events.push(event),
      requestId: "req_cache_2",
    });

    await expect(
      client.set("account:12345:cart", "customer address", "EX", 60),
    ).resolves.toBe("OK");

    expect(events[0]).toMatchObject({
      k: "cache",
      d: {
        driver: "ioredis",
        op: "set",
        key: "account:*:cart",
        requestId: "req_cache_2",
        ttlMs: 60_000,
      },
    });
    expect(events[0]?.d.value).toEqual(
      expect.objectContaining({ $redacted: "[REDACTED]" }),
    );
  });

  it("captures delete outcomes and never fails the host when capture throws", async () => {
    const emit = vi.fn(() => {
      throw new Error("sink unavailable");
    });
    const client = instrumentIoredisClient(fakeIoredis({ "cart:7": "x" }), {
      emit,
      requestId: "req_cache_3",
    });

    await expect(client.del("cart:7")).resolves.toBe(1);
    expect(emit).toHaveBeenCalledOnce();
  });

  it("does not emit outside a request scope", async () => {
    const emit = vi.fn();
    const client = instrumentIoredisClient(fakeIoredis(), {
      emit,
      getRequestId: () => undefined,
    });

    await expect(client.get("public:key")).resolves.toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("preserves ioredis exec tuples and reports bounded per-command failures", async () => {
    const events: BugEvent[] = [];
    const commandFailure = new Error("private cache failure token=secret");
    const tuples: unknown[] = [
      [null, "private value"],
      [commandFailure, null],
    ];
    const client = instrumentIoredisClient(
      {
        pipeline() {
          const batch = {
            get(_key: string) {
              return batch;
            },
            set(_key: string, _value: string) {
              return batch;
            },
            exec: async () => tuples,
          };
          return batch;
        },
      },
      { emit: (event) => events.push(event), requestId: "req_ioredis_exec" },
    );

    const result = await client
      .pipeline()
      .get("cart:123")
      .set("cart:123", "secret")
      .exec();

    expect(result).toBe(tuples);
    expect(events).toContainEqual(
      expect.objectContaining({
        k: "cache",
        d: expect.objectContaining({
          op: "pipeline",
          outcome: "failure",
          summary: {
            operationCount: 2,
            operations: ["get", "set"],
            failureCount: 1,
          },
        }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("private value");
    expect(JSON.stringify(events)).not.toContain("private cache failure");
  });

  it("summarizes ioredis execBuffer without reading command results", async () => {
    const events: BugEvent[] = [];
    const tuples: unknown[] = [[null, Buffer.from([1, 2, 3])]];
    const client = instrumentIoredisClient(
      {
        pipeline() {
          const batch = {
            getBuffer(_key: string) {
              return batch;
            },
            execBuffer: async () => tuples,
          };
          return batch;
        },
      },
      { emit: (event) => events.push(event), requestId: "req_ioredis_buffer" },
    );

    const result = await client.pipeline().getBuffer("blob:123").execBuffer();

    expect(result).toBe(tuples);
    expect(events[0]?.d).toMatchObject({
      op: "pipeline",
      summary: {
        operationCount: 1,
        operations: ["getbuffer"],
      },
    });
    expect(events[0]?.d).not.toHaveProperty("value");
    expect(JSON.stringify(events)).not.toContain('"data":[1,2,3]');
  });
});
