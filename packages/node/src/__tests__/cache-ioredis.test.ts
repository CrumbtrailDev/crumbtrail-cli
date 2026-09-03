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

  it("scans every ioredis tuple while capping the reported failure count", async () => {
    const events: BugEvent[] = [];
    const tuples: unknown[] = Array.from({ length: 150 }, (_, index) =>
      index < 100 || index === 149
        ? [new Error(`command ${index} failed`), null]
        : [null, "ok"],
    );
    const client = instrumentIoredisClient(
      {
        pipeline() {
          const batch = {
            exec: async () => tuples,
          };
          return batch;
        },
      },
      { emit: (event) => events.push(event), requestId: "req_ioredis_cap" },
    );

    await client.pipeline().exec();

    expect(events[0]?.d).toMatchObject({
      outcome: "failure",
      summary: {
        failureCount: 100,
        failureCountTruncated: true,
      },
    });
  });

  it("reports an ioredis WATCH abort when EXEC resolves null", async () => {
    const events: BugEvent[] = [];
    const client = instrumentIoredisClient(
      {
        multi(_commands?: unknown[]) {
          const batch = {
            exec: async () => null,
          };
          return batch;
        },
      },
      { emit: (event) => events.push(event), requestId: "req_ioredis_abort" },
    );

    const result = await client.multi([["set", "cart:123", "private"]]).exec();

    expect(result).toBeNull();
    expect(events[0]?.d).toMatchObject({
      outcome: "aborted",
      summary: {
        operationCount: 1,
        operations: ["set"],
      },
    });
  });

  it("summarizes constructor supplied pipeline and multi commands without raw arguments", async () => {
    const events: BugEvent[] = [];
    const client = instrumentIoredisClient(
      {
        pipeline(_commands?: unknown[]) {
          return { exec: async () => [] };
        },
        multi(_commands?: unknown[]) {
          return { exec: async () => [] };
        },
      },
      {
        emit: (event) => events.push(event),
        requestId: "req_ioredis_constructor",
      },
    );

    await client
      .pipeline([
        ["set", "cart:123", "private value"],
        ["get", "cart:123"],
        ["addCommand", ["set", "secret:key", "private value"]],
      ])
      .exec();
    await client
      .multi([
        { command: "hset", args: ["profile:123", "password", "private value"] },
        {
          name: "sendCommand",
          args: [{ args: ["secret:key", "private value"] }],
        },
      ])
      .exec();

    expect(events[0]?.d).toMatchObject({
      key: ["cart:*", "cart:*"],
      summary: {
        operationCount: 3,
        operations: ["set", "get", "addcommand"],
      },
    });
    expect(events[1]?.d).toMatchObject({
      key: "profile:*",
      summary: {
        operationCount: 2,
        operations: ["hset", "sendcommand"],
      },
    });
    expect(JSON.stringify(events)).not.toContain("private value");
    expect(JSON.stringify(events)).not.toContain("secret:key");
  });

  it("keeps root ioredis pipeline:false QUEUED replies out of command evidence", async () => {
    const events: BugEvent[] = [];
    const tuples: unknown[] = [
      [null, "OK"],
      [new Error("private transaction failure"), null],
    ];
    let resolveExecution!: (value: unknown[]) => void;
    const executionResult = new Promise<unknown[]>((resolve) => {
      resolveExecution = resolve;
    });
    const client = instrumentIoredisClient(
      {
        multi(options?: unknown) {
          expect(options).toEqual({ pipeline: false });
          return Promise.resolve("OK");
        },
        set(_key: string, _value: string) {
          return Promise.resolve("QUEUED");
        },
        get(_key: string) {
          return Promise.resolve("QUEUED");
        },
        exec: () => executionResult,
      },
      { emit: (event) => events.push(event), requestId: "req_ioredis_queued" },
    );

    const start = client.multi({ pipeline: false });
    const queuedSet = client.set("cart:123", "private value");
    const queuedGet = client.get("cart:123");
    const execution = client.exec();

    await expect(start).resolves.toBe("OK");
    await expect(queuedSet).resolves.toBe("QUEUED");
    await expect(queuedGet).resolves.toBe("QUEUED");
    expect(events).toHaveLength(0);

    resolveExecution(tuples);
    const result = await execution;
    expect(result).toBe(tuples);
    expect(events).toHaveLength(1);
    expect(events[0]?.d).toMatchObject({
      op: "transaction",
      outcome: "failure",
      summary: {
        operationCount: 2,
        operations: ["set", "get"],
        failureCount: 1,
      },
    });
    expect(JSON.stringify(events)).not.toContain("private value");
    expect(JSON.stringify(events)).not.toContain("private transaction failure");

    await expect(client.get("cart:after-transaction")).resolves.toBe("QUEUED");
    expect(events[1]?.d).toMatchObject({ op: "get", hit: true });
  });

  it("clears root ioredis pipeline:false state after multi rejection", async () => {
    const events: BugEvent[] = [];
    const startFailure = new Error("MULTI failure token=multi-secret");
    const client = instrumentIoredisClient(
      {
        multi(_options?: unknown) {
          return Promise.reject(startFailure);
        },
        get(_key: string) {
          return Promise.resolve("public value");
        },
      },
      {
        emit: (event) => events.push(event),
        requestId: "req_ioredis_start_error",
      },
    );

    const start = client.multi({ pipeline: false });
    const queued = client.get("cart:123");
    await expect(queued).resolves.toBe("public value");
    await expect(start).rejects.toBe(startFailure);
    await expect(client.get("cart:after-rejection")).resolves.toBe(
      "public value",
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.d).toMatchObject({
      op: "transaction",
      outcome: "failure",
    });
    expect(events[1]?.d).toMatchObject({ op: "get", hit: true });
    expect(JSON.stringify(events)).not.toContain("multi-secret");
  });

  it("clears root ioredis pipeline:false state after exec rejection", async () => {
    const events: BugEvent[] = [];
    const execFailure = new Error("EXEC failure token=exec-secret");
    const client = instrumentIoredisClient(
      {
        multi(_options?: unknown) {
          return Promise.resolve("OK");
        },
        set(_key: string, _value: string) {
          return Promise.resolve("QUEUED");
        },
        exec() {
          return Promise.reject(execFailure);
        },
        get(_key: string) {
          return Promise.resolve("public value");
        },
      },
      {
        emit: (event) => events.push(event),
        requestId: "req_ioredis_exec_error",
      },
    );

    await client.multi({ pipeline: false });
    await expect(client.set("cart:123", "private value")).resolves.toBe(
      "QUEUED",
    );
    await expect(client.exec()).rejects.toBe(execFailure);
    await expect(client.get("cart:123")).resolves.toBe("public value");

    expect(events).toHaveLength(2);
    expect(events[0]?.d).toMatchObject({
      op: "transaction",
      outcome: "failure",
      summary: { operationCount: 1, operations: ["set"] },
    });
    expect(events[1]?.d).toMatchObject({ op: "get", hit: true });
    expect(JSON.stringify(events)).not.toContain("exec-secret");
  });

  it("does not resurrect a root transaction after exec before MULTI settles", async () => {
    const events: BugEvent[] = [];
    const tuples: unknown[] = [[null, "OK"]];
    let resolveStart!: (value: string) => void;
    const startResult = new Promise<string>((resolve) => {
      resolveStart = resolve;
    });
    const client = instrumentIoredisClient(
      {
        multi(_options?: unknown) {
          return startResult;
        },
        get(_key: string) {
          return Promise.resolve("QUEUED");
        },
        exec() {
          return Promise.resolve(tuples);
        },
      },
      {
        emit: (event) => events.push(event),
        requestId: "req_ioredis_late_start",
      },
    );

    const start = client.multi({ pipeline: false });
    const queued = client.get("cart:123");
    const execution = client.exec();
    const result = await execution;

    expect(result).toBe(tuples);
    expect(events[0]?.d).toMatchObject({
      op: "transaction",
      summary: { operationCount: 1, operations: ["get"] },
    });

    resolveStart("OK");
    await expect(start).resolves.toBe("OK");
    await expect(queued).resolves.toBe("QUEUED");
    await expect(client.get("cart:after-exec")).resolves.toBe("QUEUED");

    expect(events).toHaveLength(2);
    expect(events[1]?.d).toMatchObject({ op: "get", hit: true });
  });

  it("clears root ioredis pipeline:false state after an exec abort", async () => {
    const events: BugEvent[] = [];
    const client = instrumentIoredisClient(
      {
        multi(_options?: unknown) {
          return Promise.resolve("OK");
        },
        get(_key: string) {
          return Promise.resolve("QUEUED");
        },
        exec() {
          return Promise.resolve(null);
        },
      },
      {
        emit: (event) => events.push(event),
        requestId: "req_ioredis_abort_cleanup",
      },
    );

    await client.multi({ pipeline: false });
    await expect(client.get("cart:123")).resolves.toBe("QUEUED");
    await expect(client.exec()).resolves.toBeNull();
    await expect(client.get("cart:after-abort")).resolves.toBe("QUEUED");

    expect(events).toHaveLength(2);
    expect(events[0]?.d).toMatchObject({
      op: "transaction",
      outcome: "aborted",
      summary: { operationCount: 1, operations: ["get"] },
    });
    expect(events[1]?.d).toMatchObject({ op: "get", hit: true });
  });

  it("emits the aggregate outcome from root ioredis execBuffer", async () => {
    const events: BugEvent[] = [];
    const tuples: unknown[] = [
      [new Error("buffer failure token=buffer-secret"), null],
    ];
    const client = instrumentIoredisClient(
      {
        multi(_options?: unknown) {
          return Promise.resolve("OK");
        },
        getBuffer(_key: string) {
          return Promise.resolve("QUEUED");
        },
        execBuffer() {
          return Promise.resolve(tuples);
        },
      },
      {
        emit: (event) => events.push(event),
        requestId: "req_ioredis_exec_buffer",
      },
    );

    await client.multi({ pipeline: false });
    await expect(client.getBuffer("blob:123")).resolves.toBe("QUEUED");
    const result = await client.execBuffer();

    expect(result).toBe(tuples);
    expect(events[0]?.d).toMatchObject({
      op: "transaction",
      outcome: "failure",
      summary: {
        operationCount: 1,
        operations: ["getbuffer"],
        failureCount: 1,
      },
    });
    expect(JSON.stringify(events)).not.toContain("buffer-secret");
  });

  it("inspects nested ioredis transaction tuples without copying results", async () => {
    const events: BugEvent[] = [];
    const nestedTuples: unknown[] = [
      [
        null,
        [
          [null, "OK"],
          [new Error("nested private failure"), "private result"],
        ],
      ],
      [null, "outer OK"],
    ];
    const client = instrumentIoredisClient(
      {
        pipeline() {
          return { exec: async () => nestedTuples };
        },
      },
      { emit: (event) => events.push(event), requestId: "req_ioredis_nested" },
    );

    const result = await client.pipeline().exec();

    expect(result).toBe(nestedTuples);
    expect(events[0]?.d).toMatchObject({
      outcome: "failure",
      summary: { failureCount: 1 },
    });
    expect(JSON.stringify(events)).not.toContain("private result");
    expect(JSON.stringify(events)).not.toContain("nested private failure");
  });
});
