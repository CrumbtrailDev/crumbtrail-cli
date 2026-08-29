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
});
