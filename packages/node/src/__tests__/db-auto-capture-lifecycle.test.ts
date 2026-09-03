import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoCapture,
  __resetAutoCaptureInstallForTests,
  type AutoCaptureHandle,
} from "../auto-capture";
import {
  type DuckTypedPrismaExtension,
  type DuckTypedPrismaQueryInput,
} from "../db";
import { runInBackendRequestContext } from "../request-context";

const ENDPOINT = "http://127.0.0.1:9899";

function makeFakeProcess(): NodeJS.Process {
  const process = new EventEmitter() as unknown as NodeJS.Process;
  (process as unknown as { env: Record<string, string> }).env = {
    CRUMBTRAIL_KEY: "k",
  };
  (process as unknown as { exit: (code: number) => void }).exit = vi.fn();
  return process;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  ) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function eventsFrom(
  calls: FetchCall[],
  from = 0,
): Array<{ k: string; d: Record<string, unknown> }> {
  const events: Array<{ k: string; d: Record<string, unknown> }> = [];
  for (const call of calls.slice(from)) {
    if (!call.url.endsWith("/api/events")) continue;
    const body = JSON.parse(call.init.body as string) as {
      events?: Array<{ k: string; d: Record<string, unknown> }>;
    };
    events.push(...(body.events ?? []));
  }
  return events;
}

async function flushCapture(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function captureOptions(
  fetchImpl: typeof fetch,
  processImpl: NodeJS.Process,
  databaseDrivers: readonly ("@prisma/client" | "mongodb")[],
  databaseResolve: (specifier: string) => unknown,
  service: string,
) {
  return {
    endpoint: ENDPOINT,
    service,
    processImpl,
    consoleImpl: { error: vi.fn() },
    fetchImpl,
    onCrashExit: () => {},
    databaseDrivers,
    databaseResolve,
    instrumentCaches: false,
    captureRuntimeWarnings: false,
    captureLogs: false,
    captureHttpRequests: false,
    captureOutboundHttp: false,
  } as const;
}

interface FakePrismaClient {
  $extends(extension: DuckTypedPrismaExtension): FakeExtendedPrismaClient;
}

interface FakeExtendedPrismaClient extends FakePrismaClient {
  run(
    input: Omit<DuckTypedPrismaQueryInput, "query">,
    result: unknown,
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
      };
    },
  };
  return client;
}

type Listener = (event: unknown) => void;

class FakeMongoClient {
  readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  succeed(
    requestId: number,
    commandName: string,
    command: Record<string, unknown>,
    reply: Record<string, unknown>,
  ): void {
    this.fire("commandStarted", { requestId, commandName, command });
    this.fire("commandSucceeded", { requestId, commandName, reply });
  }

  private fire(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

let openHandles: AutoCaptureHandle[] = [];
afterEach(() => {
  for (const handle of openHandles) handle.stop();
  openHandles = [];
  __resetAutoCaptureInstallForTests();
});

describe("auto-captured database client lifecycle", () => {
  it("rebinds an existing Prisma client after stop/start exactly once", async () => {
    class PrismaClient {
      $extends(extension: DuckTypedPrismaExtension): FakeExtendedPrismaClient {
        return makePrismaClient().$extends(extension);
      }
    }
    const mod: Record<string, unknown> = { PrismaClient };
    const firstTransport = makeFetch();
    const first = await autoCapture(
      captureOptions(
        firstTransport.fetchImpl,
        makeFakeProcess(),
        ["@prisma/client"],
        () => mod,
        "prisma-first",
      ),
    );
    openHandles.push(first);

    const client = new (mod.PrismaClient as new () => FakeExtendedPrismaClient)();
    await runInBackendRequestContext({ requestId: "prisma-before-stop" }, () =>
      client.run(
        { model: "Order", operation: "create", args: { data: { id: 1 } } },
        { id: 1 },
      ),
    );
    await flushCapture();
    first.stop();

    const secondTransport = makeFetch();
    const second = await autoCapture(
      captureOptions(
        secondTransport.fetchImpl,
        makeFakeProcess(),
        ["@prisma/client"],
        () => mod,
        "prisma-second",
      ),
    );
    openHandles.push(second);
    const beforeOperation = secondTransport.calls.length;

    await runInBackendRequestContext({ requestId: "prisma-after-stop" }, () =>
      client.run(
        { model: "Order", operation: "create", args: { data: { id: 2 } } },
        { id: 2 },
      ),
    );
    await flushCapture();

    const diffs = eventsFrom(secondTransport.calls, beforeOperation).filter(
      (event) => event.k === "db.diff",
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.d.requestId).toBe("prisma-after-stop");
  });

  it("rebinds an existing Mongo client after stop/start exactly once", async () => {
    class MongoClient extends FakeMongoClient {}
    const mod: Record<string, unknown> = { MongoClient };
    const firstTransport = makeFetch();
    const first = await autoCapture(
      captureOptions(
        firstTransport.fetchImpl,
        makeFakeProcess(),
        ["mongodb"],
        () => mod,
        "mongo-first",
      ),
    );
    openHandles.push(first);

    const client = new (mod.MongoClient as new () => FakeMongoClient)();
    client.succeed(
      1,
      "insert",
      { insert: "accounts", documents: [{ _id: "before-stop" }] },
      { ok: 1, n: 1 },
    );
    await flushCapture();
    first.stop();

    const secondTransport = makeFetch();
    const second = await autoCapture(
      captureOptions(
        secondTransport.fetchImpl,
        makeFakeProcess(),
        ["mongodb"],
        () => mod,
        "mongo-second",
      ),
    );
    openHandles.push(second);
    const beforeOperation = secondTransport.calls.length;

    runInBackendRequestContext({ requestId: "mongo-after-stop" }, () =>
      client.succeed(
        2,
        "insert",
        { insert: "accounts", documents: [{ _id: "after-stop" }] },
        { ok: 1, n: 1 },
      ),
    );
    await flushCapture();

    const diffs = eventsFrom(secondTransport.calls, beforeOperation).filter(
      (event) => event.k === "db.diff",
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.d.requestId).toBe("mongo-after-stop");
  });
});
