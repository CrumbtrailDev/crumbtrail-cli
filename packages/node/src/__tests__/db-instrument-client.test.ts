import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoCapture,
  __resetAutoCaptureInstallForTests,
} from "../auto-capture";
import type { AutoCaptureHandle } from "../auto-capture";
import { instrumentDatabaseClient } from "../db/instrument-client";
import { runInBackendRequestContext } from "../request-context";

const ENDPOINT = "http://127.0.0.1:9899";

function makeFakeProcess(
  opts: {
    env?: Record<string, string | undefined>;
  } = {},
): NodeJS.Process {
  const emitter = new EventEmitter() as unknown as NodeJS.Process;
  (emitter as unknown as { env: Record<string, string | undefined> }).env = {
    CRUMBTRAIL_KEY: "k",
    ...opts.env,
  };
  (emitter as unknown as { exit: (code: number) => void }).exit = vi.fn();
  return emitter;
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

function eventKinds(calls: FetchCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    if (!call.url.endsWith("/api/events")) continue;
    const body = JSON.parse(call.init.body as string) as {
      events?: Array<{ k: string }>;
    };
    for (const ev of body.events ?? []) out.push(ev.k);
  }
  return out;
}

function eventsFrom(
  calls: FetchCall[],
): Array<{ k: string; d: Record<string, unknown> }> {
  const out: Array<{ k: string; d: Record<string, unknown> }> = [];
  for (const call of calls) {
    if (!call.url.endsWith("/api/events")) continue;
    const body = JSON.parse(call.init.body as string) as {
      events?: Array<{ k: string; d: Record<string, unknown> }>;
    };
    out.push(...(body.events ?? []));
  }
  return out;
}

/** A `pg`-shaped pool that records the statements it was asked to run. */
function makePool(): {
  pool: { query(t: string): Promise<unknown> };
  executed: string[];
} {
  const executed: string[] = [];
  const pool = {
    async query(text: string): Promise<{ rows: unknown[]; rowCount: number }> {
      executed.push(String(text));
      return { rows: [{ id: 1, total: 10 }], rowCount: 1 };
    },
  };
  return { pool, executed };
}

let openHandles: AutoCaptureHandle[] = [];
afterEach(() => {
  for (const handle of openHandles) handle.stop();
  openHandles = [];
  __resetAutoCaptureInstallForTests();
});

describe("instrumentDatabaseClient", () => {
  // The order a real service has: the database module is imported and builds its
  // pool, and capture starts afterwards. Automatic instrumentation cannot help
  // here, because the factory it swaps has already been called.
  it("instruments a pool built before capture starts, and evidence still lands", async () => {
    const { pool, executed } = makePool();
    const instrumented = instrumentDatabaseClient(pool);

    const { fetchImpl, calls } = makeFetch();
    const handle = await autoCapture({
      endpoint: ENDPOINT,
      service: "svc",
      processImpl: makeFakeProcess(),
      consoleImpl: { error: vi.fn() } as unknown as Console,
      fetchImpl,
      onCrashExit: () => {},
      instrumentDatabases: false,
    });
    openHandles.push(handle);

    await runInBackendRequestContext(
      { requestId: "req_1", sessionId: "sess_1", sessionIdSource: "header" },
      () => instrumented.query("UPDATE carts SET total = 10 WHERE id = 1"),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(executed.some((sql) => sql.includes("UPDATE carts"))).toBe(true);
    expect(eventKinds(calls).some((k) => k.startsWith("db"))).toBe(true);
  });

  it("reads later active race configuration when an explicit client was instrumented first", async () => {
    const { pool } = makePool();
    const instrumented = instrumentDatabaseClient(pool);
    const { fetchImpl, calls } = makeFetch();
    const handle = await autoCapture({
      endpoint: ENDPOINT,
      service: "svc-race",
      processImpl: makeFakeProcess({
        env: {
          CRUMBTRAIL_KEY:
            "ctkey_0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      }),
      consoleImpl: { error: vi.fn() } as unknown as Console,
      fetchImpl,
      onCrashExit: () => {},
      instrumentDatabases: false,
      raceEvidence: { enabled: true },
    });
    openHandles.push(handle);

    await runInBackendRequestContext(
      { requestId: "req-race", sessionId: "sess-race" },
      () => instrumented.query("UPDATE carts SET total = 10 WHERE id = 1"),
    );
    await new Promise((r) => setTimeout(r, 0));

    const diffs = eventsFrom(calls).filter((event) => event.k === "db.diff");
    expect(diffs.some((event) => event.d.raceEvidence)).toBe(true);
  });

  it("is inert, not fatal, when no capture is running", async () => {
    const { pool, executed } = makePool();
    const instrumented = instrumentDatabaseClient(pool);

    await runInBackendRequestContext({ requestId: "req_1" }, () =>
      instrumented.query("UPDATE carts SET total = 10 WHERE id = 1"),
    );

    // The host's statement ran; nothing was emitted because nothing is listening.
    expect(executed).toHaveLength(1);
  });

  it("detects postgres.js, whose client is the callable itself", () => {
    const sql = Object.assign(() => ({}), {
      unsafe: () => ({}),
      begin: (fn: unknown) => fn,
      reserve: async () => ({}),
    });
    expect(instrumentDatabaseClient(sql)).not.toBe(sql);
  });

  it("returns an unrecognised client untouched rather than guessing a driver", () => {
    const mystery = { doThing() {} };
    expect(instrumentDatabaseClient(mystery)).toBe(mystery);
  });
});
