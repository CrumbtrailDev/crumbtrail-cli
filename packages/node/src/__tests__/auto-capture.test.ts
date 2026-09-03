import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_CAPTURE_ERROR_EVENT,
  autoCapture,
  __resetAutoCaptureInstallForTests,
} from "../auto-capture";
import { withCrumbtrailJob } from "../jobs";
import {
  getBackendRequestContext,
  runInBackendRequestContext,
} from "../request-context";
import type { AutoCaptureHandle } from "../auto-capture";

const PARENT_TRACEPARENT =
  "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

// A minimal stand-in for `process` the hooks attach to. It is a real
// EventEmitter (so on/removeListener/emit behave), plus the fields autoCapture
// reads: `env`, an optional `loadEnvFile`, and `exit`.
function makeFakeProcess(opts: {
  env?: Record<string, string | undefined>;
  loadEnvFile?: () => void;
  runtime?: {
    pid?: number;
    memoryUsage?: () => {
      rss?: number;
      heapUsed?: number;
      external?: number;
    };
    cpuUsage?: () => { user: number; system: number };
    uptime?: () => number;
  };
}): NodeJS.Process {
  const emitter = new EventEmitter() as unknown as NodeJS.Process;
  (emitter as unknown as { env: Record<string, string | undefined> }).env =
    opts.env ?? {};
  if (opts.loadEnvFile) {
    (emitter as unknown as { loadEnvFile: () => void }).loadEnvFile =
      opts.loadEnvFile;
  }
  (emitter as unknown as { exit: (code: number) => void }).exit = vi.fn();
  Object.assign(emitter, opts.runtime);
  return emitter;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

// A fetch mock that records every call and returns a 200 session envelope.
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
): Array<{ k: string; d: Record<string, unknown> }> {
  const out: Array<{ k: string; d: Record<string, unknown> }> = [];
  for (const call of calls) {
    if (!call.url.endsWith("/api/events")) continue;
    const body = JSON.parse(call.init.body as string) as {
      events?: Array<{ k: string; d: Record<string, unknown> }>;
    };
    for (const ev of body.events ?? []) out.push(ev);
  }
  return out;
}

const ENDPOINT = "http://127.0.0.1:9899";

// Every test MUST stop its handle so the module-level double-install guard
// resets before the next test.
let openHandles: AutoCaptureHandle[] = [];
function track(handle: AutoCaptureHandle): AutoCaptureHandle {
  openHandles.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of openHandles) handle.stop();
  openHandles = [];
  __resetAutoCaptureInstallForTests();
});

describe("autoCapture", () => {
  it("registers a process binding and sends it only as top level session fields", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "project-key" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    const runtime = {
      instanceId: "ri_runtime_node",
      instanceProof: `proof_${"x".repeat(40)}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).includes("/api/runtime/register"))
          return new Response(JSON.stringify(runtime), { status: 201 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        captureHttpRequests: false,
        captureOutboundHttp: false,
        captureRuntimeWarnings: false,
        captureLogs: false,
        captureProcessSignals: false,
      }),
    );

    const registration = calls.find((call) =>
      call.url.includes("/api/runtime/register"),
    );
    expect(registration?.url).toContain("projectKey=project-key");
    expect(registration?.init.method).toBe("POST");
    const start = calls.find((call) => call.url.endsWith("/api/session/start"));
    const body = JSON.parse(String(start?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      instanceId: runtime.instanceId,
      instanceProof: runtime.instanceProof,
      metadata: { source: "headless" },
    });
    expect((body.metadata as Record<string, unknown>).instanceProof).toBe(
      undefined,
    );
  });

  it("keeps capture untargeted when runtime registration is rate limited", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "project-key" } });
    const calls: FetchCall[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).includes("/api/runtime/register"))
          return new Response(JSON.stringify({ code: "rate_limited" }), {
            status: 429,
            headers: { "Retry-After": "120" },
          });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        captureHttpRequests: false,
        captureOutboundHttp: false,
        captureRuntimeWarnings: false,
        captureLogs: false,
        captureProcessSignals: false,
      }),
    );

    const start = calls.find((call) => call.url.endsWith("/api/session/start"));
    const body = JSON.parse(String(start?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body.instanceId).toBeUndefined();
    expect(body.instanceProof).toBeUndefined();
    expect(
      calls.filter((call) => call.url.includes("/api/runtime/register")),
    ).toHaveLength(1);
  });

  it("loads .env and reads the ingest key from process.env.CRUMBTRAIL_KEY", async () => {
    const env: Record<string, string | undefined> = {};
    const loadEnvFile = vi.fn(() => {
      // Simulate process.loadEnvFile() populating the key from .env.
      env.CRUMBTRAIL_KEY = "bl_key_from_dotenv";
    });
    const proc = makeFakeProcess({ env, loadEnvFile });
    const { fetchImpl, calls } = makeFetch();

    const handle = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    expect(loadEnvFile).toHaveBeenCalledTimes(1);
    const start = calls.find((c) => c.url.endsWith("/api/session/start"));
    expect(start).toBeDefined();
    expect(start!.init.headers).toMatchObject({
      "x-crumbtrail-auth": "bl_key_from_dotenv",
    });
    expect(handle.sessionId).toBeTruthy();
  });

  it("installs uncaughtException + unhandledRejection hooks and patches console.error", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const originalError = consoleImpl.error;
    const { fetchImpl } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
    expect(consoleImpl.error).not.toBe(originalError);
  });

  it("does not crash when .env is missing (loadEnvFile throws)", async () => {
    const loadEnvFile = vi.fn(() => {
      throw new Error("ENOENT: no such file or directory, open '.env'");
    });
    const proc = makeFakeProcess({ env: {}, loadEnvFile });
    const { fetchImpl } = makeFetch();

    const handle = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    expect(loadEnvFile).toHaveBeenCalledTimes(1);
    // Hooks still installed; the session simply starts without an auth token.
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(handle.sessionId).toBeTruthy();
  });

  it("preserves crash semantics: bound-flushes the record THEN exits(1) on uncaughtException (fast path)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    // Snapshot how many event batches had reached ingest at the instant exit
    // fires: the bounded flush must have awaited the record, so this is >= 1.
    let eventsAtExit = -1;
    const onCrashExit = vi.fn(() => {
      eventsAtExit = eventsFrom(calls).length;
    });

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    const boom = new Error("boom");
    proc.emit("uncaughtException", boom);
    // Let the bounded flush resolve (the mocked fetch resolves fast, so the race
    // settles on the record long before the ~150ms ceiling).
    await new Promise((r) => setTimeout(r, 0));

    expect(onCrashExit).toHaveBeenCalledWith(1);
    // Exit waited for the record: the crash event was in ingest before exit ran.
    expect(eventsAtExit).toBeGreaterThanOrEqual(1);
    const events = eventsFrom(calls);
    const crash = events.find(
      (e) =>
        e.k === AUTO_CAPTURE_ERROR_EVENT && e.d.source === "uncaughtException",
    );
    expect(crash).toBeDefined();
    expect((crash!.d.error as { message: string }).message).toBe("boom");
  });

  it("bounded crash flush: still exits(1) when the record never resolves (timeout path)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onCrashExit = vi.fn();
    // session/start resolves so the hooks install, but the /api/events POST hangs
    // forever — the record promise never settles.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/session/start")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Promise<Response>(() => {}); // never resolves
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    const started = Date.now();
    proc.emit("uncaughtException", new Error("boom"));
    // Past the ~150ms ceiling but far under any hang.
    await new Promise((r) => setTimeout(r, 400));

    expect(onCrashExit).toHaveBeenCalledWith(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("re-entrant crash during the flush does not recurse or double-exit", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onCrashExit = vi.fn();
    // Hang the record so the first flush is still in flight when the second
    // crash fires.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/session/start")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    proc.emit("uncaughtException", new Error("first"));
    // Second crash raised while the first flush is still awaiting the record.
    proc.emit("uncaughtException", new Error("second"));
    await new Promise((r) => setTimeout(r, 400));

    // The re-entrancy guard collapsed both into a single bounded exit.
    expect(onCrashExit).toHaveBeenCalledTimes(1);
    expect(onCrashExit).toHaveBeenCalledWith(1);
  });

  it("suppressed unhandledRejection still exits(1) after best-effort record", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onCrashExit = vi.fn();
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    proc.emit("unhandledRejection", new Error("rejected"), Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));

    expect(onCrashExit).toHaveBeenCalledWith(1);
    const events = eventsFrom(calls);
    expect(events.some((e) => e.d.source === "unhandledRejection")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Never end a process Node itself would not have ended.
  //
  // Hooking uncaughtException/unhandledRejection suppresses Node's default
  // terminate-on-crash, which hands capture a decision that belongs to the host.
  // A service with its own crash handler keeps the process alive on purpose and
  // recovers; exiting underneath it turns a recoverable fault into an outage
  // caused by being observed.
  // --------------------------------------------------------------------------

  it("a host with no crash listener still gets Node's exit(1)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setTimeout(r, 0));

    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it("a host that handles its own uncaughtException keeps its process", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    // The shape this exists for: a worker that recovers from a crashed child
    // (a Playwright browser pool, a Temporal activity) rather than dying.
    const hostRecovered = vi.fn();
    proc.on("uncaughtException", hostRecovered);

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    proc.emit("uncaughtException", new Error("recoverable"));
    await new Promise((r) => setTimeout(r, 0));

    expect(hostRecovered).toHaveBeenCalledTimes(1);
    expect(proc.exit).not.toHaveBeenCalled();
    // Deferring is not declining to capture: the crash is still recorded.
    const events = eventsFrom(calls);
    expect(events.some((e) => e.d.source === "uncaughtException")).toBe(true);
  });

  it("a host that handles its own unhandledRejection keeps its process", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl } = makeFetch();
    proc.on("unhandledRejection", vi.fn());

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    proc.emit("unhandledRejection", new Error("rejected"), Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));

    expect(proc.exit).not.toHaveBeenCalled();
  });

  it("a deferred crash leaves the next one capturable", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    proc.on("uncaughtException", vi.fn());

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    // The re-entrancy guard exists for a process on its way down. A process the
    // host kept alive is not on its way down, so a later crash is a NEW crash
    // and latching the guard shut would silently stop capturing after the first.
    proc.emit("uncaughtException", new Error("first"));
    await new Promise((r) => setTimeout(r, 0));
    proc.emit("uncaughtException", new Error("second"));
    await new Promise((r) => setTimeout(r, 0));

    const messages = eventsFrom(calls)
      .filter((e) => e.d.source === "uncaughtException")
      .map((e) => (e.d.error as { message: string }).message);
    expect(messages).toContain("first");
    expect(messages).toContain("second");
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it("an explicit onCrashExit wins over the host's own listener", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl } = makeFetch();
    const onCrashExit = vi.fn();
    proc.on("uncaughtException", vi.fn());

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setTimeout(r, 0));

    // Setting it is the host stating its crash semantics outright, so it is
    // honoured rather than second-guessed against the listener list.
    expect(onCrashExit).toHaveBeenCalledWith(1);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it("double-install guard: a second call is inert and does not re-patch", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const { fetchImpl } = makeFetch();

    const first = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );
    const patchedAfterFirst = consoleImpl.error;

    const second = await autoCapture({
      endpoint: ENDPOINT,
      processImpl: proc,
      consoleImpl,
      fetchImpl,
    });

    // No second listener, no re-patch, and the inert handle exposes no session.
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(consoleImpl.error).toBe(patchedAfterFirst);
    expect(second.sessionId).toBeUndefined();

    // stop() on the inert handle is a no-op and must not restore/reset.
    second.stop();
    expect(proc.listenerCount("uncaughtException")).toBe(1);

    first.stop();
  });

  it("waits for same-key binding retirement before restarting", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "project-key" } });
    const calls: FetchCall[] = [];
    const firstRuntime = {
      instanceId: "ri_runtime_first",
      instanceProof: `proof_first_${"x".repeat(40)}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const secondRuntime = {
      instanceId: "ri_runtime_second",
      instanceProof: `proof_second_${"x".repeat(40)}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const pendingDelete = deferred<Response>();
    let registrationCount = 0;
    let firstDelete = true;
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const call = { url: String(url), init: init ?? {} };
        calls.push(call);
        if (call.url.includes("/api/runtime/register")) {
          if (call.init.method === "DELETE") {
            if (firstDelete) {
              firstDelete = false;
              return pendingDelete.promise;
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          registrationCount += 1;
          return new Response(
            JSON.stringify(
              registrationCount === 1 ? firstRuntime : secondRuntime,
            ),
            { status: 201 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as unknown as typeof fetch;
    const options = {
      endpoint: ENDPOINT,
      processImpl: proc,
      consoleImpl: { error: vi.fn() },
      fetchImpl,
      captureHttpRequests: false,
      captureOutboundHttp: false,
      captureRuntimeWarnings: false,
      captureLogs: false,
      captureProcessSignals: false,
    };

    const first = track(await autoCapture(options));
    first.stop();

    const secondPromise = autoCapture(options);
    await Promise.resolve();
    expect(
      calls.filter(
        (call) =>
          call.url.includes("/api/runtime/register") &&
          call.init.method === "POST",
      ),
    ).toHaveLength(1);

    pendingDelete.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const second = track(await secondPromise);
    expect(second.sessionId).toBeDefined();
    const firstDeleteIndex = calls.findIndex(
      (call) =>
        call.url.includes("/api/runtime/register") &&
        call.init.method === "DELETE",
    );
    const secondRegistrationIndex = calls.findIndex(
      (call, index) =>
        index > firstDeleteIndex &&
        call.url.includes("/api/runtime/register") &&
        call.init.method === "POST",
    );
    expect(firstDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(secondRegistrationIndex).toBeGreaterThan(firstDeleteIndex);
  });

  it("console.error capture records the error and passes through to the original", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    const err = new Error("logged failure");
    consoleImpl.error(err, "extra context");
    await new Promise((r) => setTimeout(r, 0));

    // Pass-through: the original console.error still ran with the same args.
    expect(originalError).toHaveBeenCalledWith(err, "extra context");
    // And the error was recorded.
    const events = eventsFrom(calls);
    const logged = events.find(
      (e) => e.k === AUTO_CAPTURE_ERROR_EVENT && e.d.source === "console.error",
    );
    expect(logged).toBeDefined();
    expect((logged!.d.error as { message: string }).message).toBe(
      "logged failure",
    );
  });

  it("keeps the sentence the developer wrote alongside the Error's own message", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    // The ordinary shape: a sentence naming what was attempted, then the Error.
    consoleImpl.error("worker tick failed", new Error("keepa refused"));
    await new Promise((r) => setTimeout(r, 0));

    const logged = eventsFrom(calls).find(
      (e) => e.k === AUTO_CAPTURE_ERROR_EVENT && e.d.source === "console.error",
    );
    expect(logged).toBeDefined();
    // The Error still supplies name/message/stack …
    expect((logged!.d.error as { message: string }).message).toBe(
      "keepa refused",
    );
    // … and the words the author chose are no longer dropped.
    expect(logged!.d.message).toBe("worker tick failed");
  });

  it("records no message field when console.error was given only an Error", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    consoleImpl.error(new Error("bare failure"));
    await new Promise((r) => setTimeout(r, 0));

    const logged = eventsFrom(calls).find(
      (e) => e.k === AUTO_CAPTURE_ERROR_EVENT && e.d.source === "console.error",
    );
    expect(logged!.d.message).toBeUndefined();
  });

  it("routes runtime samples through the session and stops the sampler with capture", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let cpuReads = 0;
      const proc = makeFakeProcess({
        env: { CRUMBTRAIL_KEY: "k" },
        runtime: {
          pid: 321,
          memoryUsage: () => ({ rss: 4_000, heapUsed: 2_000, external: 700 }),
          cpuUsage: () => {
            cpuReads += 1;
            return cpuReads === 1
              ? { user: 10_000, system: 5_000 }
              : { user: 10_300, system: 5_500 };
          },
          uptime: () => 12.5,
        },
      });
      const { fetchImpl, calls } = makeFetch();

      track(
        await autoCapture({
          endpoint: ENDPOINT,
          processImpl: proc,
          consoleImpl: { error: vi.fn() },
          fetchImpl,
          runtimeMetrics: true,
          // The sampler clamps this to its 10 second minimum.
          runtimeMetricIntervalMs: 1,
          instrumentDatabases: false,
          captureLogs: false,
          captureRuntimeWarnings: false,
          captureHttpRequests: false,
          captureOutboundHttp: false,
        }),
      );

      await vi.advanceTimersByTimeAsync(9_999);
      expect(
        eventsFrom(calls).some((event) => event.k === "backend.runtime"),
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(
          eventsFrom(calls).filter((event) => event.k === "backend.runtime"),
        ).toHaveLength(1);
      });

      const runtimeEvent = eventsFrom(calls).find(
        (event) => event.k === "backend.runtime",
      );
      expect(runtimeEvent?.d).toMatchObject({
        rssBytes: 4_000,
        heapUsedBytes: 2_000,
        externalBytes: 700,
        cpuUserDeltaMicros: 300,
        cpuSystemDeltaMicros: 500,
        processStartMarker: expect.stringMatching(/^node:321:/),
      });
      expect(runtimeEvent?.d).not.toHaveProperty("CRUMBTRAIL_KEY");
      expect(JSON.stringify(runtimeEvent?.d).length).toBeLessThan(4_096);

      const runtimeCount = eventsFrom(calls).filter(
        (event) => event.k === "backend.runtime",
      ).length;
      for (const handle of openHandles) handle.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(
        eventsFrom(calls).filter((event) => event.k === "backend.runtime"),
      ).toHaveLength(runtimeCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the auto-capture sink available for distributed job sessions", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    const capture = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        runtimeMetrics: false,
        instrumentDatabases: false,
        captureLogs: false,
        captureRuntimeWarnings: false,
        captureHttpRequests: false,
        captureOutboundHttp: false,
      }),
    );

    const result = await runInBackendRequestContext(
      {
        sessionId: capture.sessionId,
        sessionIdSource: "process",
        requestId: "request_parent",
        traceparent: PARENT_TRACEPARENT,
      },
      () =>
        withCrumbtrailJob(
          {
            name: "record-payment",
            queue: "payments",
            jobId: "job_991",
            now: () => 1_500,
          },
          async (context) => {
            expect(context.sessionId).not.toBe(capture.sessionId);
            expect(getBackendRequestContext()).toMatchObject({
              sessionId: context.sessionId,
              requestId: "request_parent",
            });
            return 42;
          },
        ),
    );

    expect(result).toBe(42);
    const linkCall = calls.find((call) =>
      call.url.endsWith("/api/session/link"),
    );
    expect(linkCall).toBeDefined();
    expect(JSON.parse(linkCall!.init.body as string)).toMatchObject({
      fromSessionId: capture.sessionId,
      relation: "caused",
      method: "trace_context",
      matchedOn: {
        requestId: "request_parent",
        name: "record-payment",
        queue: "payments",
        jobId: "job_991",
      },
    });

    const jobEvents = calls
      .filter((call) => call.url.endsWith("/api/events"))
      .flatMap((call) => {
        const body = JSON.parse(call.init.body as string) as {
          events?: Array<Record<string, unknown>>;
        };
        return body.events ?? [];
      })
      .filter(
        (event) =>
          event.k === "backend.job.start" || event.k === "backend.job.end",
      );
    expect(jobEvents).toHaveLength(2);
    expect(jobEvents[0]?.sessionId).toBe(jobEvents[1]?.sessionId);
    expect(jobEvents[0]?.sessionId).not.toBe(capture.sessionId);
  });

  it("onError surfaces a session-start failure (endpoint unreachable / bad cert)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onError = vi.fn();
    // session/start rejects, mirroring a TLS/DNS failure or a non-2xx ingest.
    const fetchImpl = vi.fn(async () => {
      throw new Error("SSL certificate problem");
    }) as unknown as typeof fetch;

    const handle = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onError,
      }),
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, context] = onError.mock.calls[0];
    expect((error as Error).message).toContain("SSL certificate problem");
    expect(context).toEqual({ phase: "session-start" });
    // Hooks still installed, but the session is dark (no recording).
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(handle.sessionId).toBeUndefined();
  });

  it("onError surfaces a record failure (events POST rejected)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onError = vi.fn();
    // session/start succeeds so hooks install, but the events POST is rejected.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/session/start")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onError,
      }),
    );

    proc.emit("unhandledRejection", new Error("boom"), Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalled();
    const recordCall = onError.mock.calls.find(
      ([, ctx]) => (ctx as { phase: string }).phase === "record",
    );
    expect(recordCall).toBeDefined();
    expect((recordCall![1] as { source: string }).source).toBe(
      "unhandledRejection",
    );
  });

  it("debug logs a session-start failure via the original (unpatched) console.error", async () => {
    const proc = makeFakeProcess({
      env: { CRUMBTRAIL_KEY: "k", CRUMBTRAIL_DEBUG: "1" },
    });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    // Logged through the reference captured before patching — not the patched
    // console.error — so a failure can never recurse through capture.
    expect(originalError).toHaveBeenCalledWith(
      "[crumbtrail] ingest session-start failed",
      expect.any(Error),
    );
  });

  it("stays quiet on failure when neither onError nor debug is set", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    const fetchImpl = vi.fn(async () => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        // The DB report is a separate lane with its own contract (it always
        // states when no driver was instrumented); this test is about ingest
        // failures staying quiet.
        instrumentDatabases: false,
      }),
    );

    // No diagnostic noise for a healthy-by-default install. A transport
    // rejection is usually transient and the session self-heals; only a server
    // explained refusal gets a default console line (tested below).
    expect(originalError).not.toHaveBeenCalled();
  });

  it("surfaces a server explained session start refusal to the default console once", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    let clock = 1000;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/session/start")) {
        return new Response(
          JSON.stringify({ error: "This project API key was not accepted." }),
          { status: 401 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
        instrumentDatabases: false,
      }),
    );

    // The boot handshake was refused and the server's sentence reaches the
    // default console even with no onError wired.
    expect(originalError).toHaveBeenCalledTimes(1);
    expect(originalError.mock.calls[0][0]).toContain(
      "[crumbtrail] the capture endpoint refused session start with HTTP 401: This project API key was not accepted.; nothing from this session will be captured",
    );
    // A 401 usually means no key was loaded, not that the key is wrong, so the
    // line names where the key comes from and which directory was in play.
    expect(originalError.mock.calls[0][0]).toContain(
      "The key is read from a .env file in the package directory",
    );
    expect(originalError.mock.calls[0][0]).toContain(process.cwd());

    // A later capture, after the backoff gate opens, is refused again — but the
    // same condition is still one console line. (The mirrored console.error
    // passes the error through the original sink, so count refusal lines only.)
    clock += 60_000;
    consoleImpl.error(new Error("later failure"));
    await new Promise((r) => setTimeout(r, 0));
    const refusalLines = originalError.mock.calls.filter((call) =>
      String(call[0]).startsWith("[crumbtrail]"),
    );
    expect(refusalLines).toHaveLength(1);
  });

  const startCountOf = (calls: FetchCall[]): number =>
    calls.filter((c) => c.url.endsWith("/api/session/start")).length;

  it("self-heals: a dark boot session recovers on a later console.error once the endpoint returns", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    let healthy = false;
    // session/start fails until `healthy` flips (endpoint recovers); /api/events
    // always succeeds so a re-established session's record lands.
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/api/session/start") && !healthy) {
          throw new Error("ECONNREFUSED");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    const handle = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
      }),
    );

    // Boot handshake failed: session is dark, exactly one attempt so far.
    expect(handle.sessionId).toBeUndefined();
    expect(startCountOf(calls)).toBe(1);

    // Endpoint recovers; advance the clock past the ~1s backoff gate.
    healthy = true;
    clock += 2000;

    // The next captured error lazily re-establishes the session and lands — no
    // redeploy needed.
    consoleImpl.error(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 0));

    expect(startCountOf(calls)).toBe(2);
    const events = eventsFrom(calls);
    const healed = events.find(
      (e) => e.k === AUTO_CAPTURE_ERROR_EVENT && e.d.source === "console.error",
    );
    expect(healed).toBeDefined();
    expect((healed!.d.error as { message: string }).message).toBe(
      "late failure",
    );
  });

  it("backoff gate: repeated captures inside the window do not spam session-start attempts", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    // Endpoint stays down: every session/start rejects.
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        throw new Error("still down");
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
      }),
    );

    // Boot attempt only.
    expect(startCountOf(calls)).toBe(1);

    // A burst of captures with the clock frozen inside the backoff window makes
    // NO further handshake attempts.
    for (let i = 0; i < 5; i++) {
      consoleImpl.error(new Error(`e${i}`));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(startCountOf(calls)).toBe(1);

    // Once the clock moves past the backoff, exactly one new attempt is made.
    clock += 60_000;
    consoleImpl.error(new Error("after-window"));
    await new Promise((r) => setTimeout(r, 0));
    expect(startCountOf(calls)).toBe(2);
  });

  it("respects a Retry-After header as the backoff floor before re-establishing", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    // 503 + Retry-After: 120s. The exponential base backoff (~1s) is far shorter,
    // so the server floor must win.
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("busy", {
          status: 503,
          headers: { "retry-after": "120" },
        });
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
      }),
    );

    expect(startCountOf(calls)).toBe(1);

    // 10s later: past the ~1s exponential backoff, but under the 120s floor.
    clock += 10_000;
    consoleImpl.error(new Error("too soon"));
    await new Promise((r) => setTimeout(r, 0));
    expect(startCountOf(calls)).toBe(1);

    // Past the Retry-After floor: a new attempt is allowed.
    clock += 120_000;
    consoleImpl.error(new Error("now allowed"));
    await new Promise((r) => setTimeout(r, 0));
    expect(startCountOf(calls)).toBe(2);
  });

  it("clamps an absurd Retry-After so capture is not parked indefinitely", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    // A hostile/buggy server asks us to wait ~31 years. Without a clamp this would
    // park self-heal until process restart; the clamp bounds it to a few minutes.
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("busy", {
          status: 503,
          headers: { "retry-after": "999999999" },
        });
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
      }),
    );

    expect(startCountOf(calls)).toBe(1);

    // Just over the clamp ceiling (5 min): a new attempt is allowed rather than
    // being blocked for the ~31 years the header nominally requested.
    clock += 5 * 60_000 + 1000;
    consoleImpl.error(new Error("after clamp window"));
    await new Promise((r) => setTimeout(r, 0));
    expect(startCountOf(calls)).toBe(2);
  });

  it("crash path with a dark session still exits(1) within the bound and never re-establishes", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onCrashExit = vi.fn();
    const calls: FetchCall[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        throw new Error("down");
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
        nowImpl: () => clock,
      }),
    );

    expect(startCountOf(calls)).toBe(1); // boot attempt only

    // Advance well past the backoff so a re-establish WOULD be permitted if the
    // crash path tried one — it must not, to stay inside the bounded exit.
    clock += 60_000;
    const started = Date.now();
    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setTimeout(r, 50));

    expect(onCrashExit).toHaveBeenCalledWith(1);
    expect(Date.now() - started).toBeLessThan(500);
    // No re-establish on the crash path: still just the boot attempt.
    expect(startCountOf(calls)).toBe(1);
  });

  it("onError fires again when a lazy re-establish attempt also fails", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("still unreachable");
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        onError,
        nowImpl: () => clock,
      }),
    );

    // Boot failure surfaced once.
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][1] as { phase: string }).phase).toBe(
      "session-start",
    );

    // Past the backoff, a capture triggers a re-establish that also fails —
    // surfaced again with the same phase.
    clock += 60_000;
    consoleImpl.error(new Error("trigger re-establish"));
    await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[1][1] as { phase: string }).phase).toBe(
      "session-start",
    );
  });

  // One ingest key covers the whole project, so the key cannot say which app
  // this process is. The session handshake has to, or a repository of six
  // backends arrives as six anonymous senders.
  it("names its app in the session handshake", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        service: "job-engine",
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    const start = calls.find((c) => c.url.endsWith("/api/session/start"));
    expect(start).toBeDefined();
    const body = JSON.parse(String(start!.init.body)) as {
      metadata: Record<string, unknown>;
    };
    expect(body.metadata.service).toBe("job-engine");
  });

  it("sends no app name when it was not given one", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    const start = calls.find((c) => c.url.endsWith("/api/session/start"));
    const body = JSON.parse(String(start!.init.body)) as {
      metadata: Record<string, unknown>;
    };
    expect(body.metadata).not.toHaveProperty("service");
  });

  // The Hono/pino case: a backend that logs through a logger and never crashes.
  // Before structured log capture existed this session came out completely
  // empty — the app's own statement of the cause was written to stdout and
  // nothing was watching stdout.
  it("captures a pino error line the app logged instead of throwing", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    const written: string[] = [];
    const stdout = {
      write(chunk: unknown) {
        written.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        logStreams: { stdout, stderr: stdout },
      }),
    );

    const line = `${JSON.stringify({
      level: 50,
      time: 1_700_000_000_000,
      pid: 1,
      hostname: "api",
      status: 503,
      err: {
        type: "UpstreamError",
        message: "keepa product lookup failed",
        stack:
          "UpstreamError: keepa product lookup failed\\n    at fetchKeepaProduct (/app/src/services/keepa/fetchProduct.ts:68:11)",
      },
      msg: "request failed",
    })}\n`;
    stdout.write(line);
    await new Promise((resolve) => setImmediate(resolve));

    const logged = eventsFrom(calls).filter((ev) => ev.k === "backend.log");
    expect(logged).toHaveLength(1);
    expect(logged[0].d.level).toBe("error");
    expect(String((logged[0].d.error as { stack?: string }).stack)).toContain(
      "fetchKeepaProduct",
    );
    // The application's own logging is delivered unchanged.
    expect(written).toEqual([line]);
  });

  it("leaves the streams alone when log capture is switched off", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    const stdout = { write: () => true } as unknown as NodeJS.WriteStream;
    const originalWrite = stdout.write;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        captureLogs: false,
        logStreams: { stdout, stderr: stdout },
      }),
    );

    expect(stdout.write).toBe(originalWrite);
    stdout.write('{"level":50,"msg":"ignored"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(eventsFrom(calls).filter((ev) => ev.k === "backend.log")).toEqual(
      [],
    );
  });

  it("restores console.error and removes hooks on stop()", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    const { fetchImpl } = makeFetch();

    const handle = await autoCapture({
      endpoint: ENDPOINT,
      processImpl: proc,
      consoleImpl,
      fetchImpl,
    });
    handle.stop();

    expect(consoleImpl.error).toBe(originalError);
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
  });
});

describe("autoCapture double install", () => {
  const ENDPOINT_LOCAL = ENDPOINT;

  async function install(service: string | undefined, error: () => void) {
    const { fetchImpl } = makeFetch();
    return track(
      await autoCapture({
        endpoint: ENDPOINT_LOCAL,
        processImpl: makeFakeProcess({ env: {} }),
        consoleImpl: { error } as unknown as Pick<Console, "error">,
        fetchImpl,
        ...(service ? { service } : {}),
      }),
    );
  }

  it("keeps the first capture and names both services when a second one differs", async () => {
    const firstError = vi.fn();
    const first = await install("api", firstError);

    const secondError = vi.fn();
    const second = await install("worker", secondError);

    expect(secondError).toHaveBeenCalledTimes(1);
    const line = String(secondError.mock.calls[0][0]);
    expect(line).toContain('service "api"');
    expect(line).toContain('service "worker"');
    expect(line).toContain("one process captures under one service name");
    // The handle stays inert: a second caller's stop() must not tear down a
    // capture it does not own.
    expect(second.sessionId).toBeUndefined();
    expect(first.sessionId).toBeDefined();
  });

  it("stays silent for an ordinary repeat call under the same name", async () => {
    await install("api", vi.fn());
    const secondError = vi.fn();
    await install("api", secondError);
    expect(secondError).not.toHaveBeenCalled();
  });
});

// ============================================================================
// COMPLETENESS: a capture outage must leave a mark
// ============================================================================

describe("autoCapture completeness ledger", () => {
  it("holds evidence produced while the endpoint is down and delivers it when the endpoint returns", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    let clock = 1_000;
    let reachable = false;
    const calls: FetchCall[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (!reachable) throw new TypeError("fetch failed");
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    const consoleImpl = { error: vi.fn() };
    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
        instrumentDatabases: false,
        captureLogs: false,
        captureRuntimeWarnings: false,
        captureHttpRequests: false,
        captureOutboundHttp: false,
      }),
    );

    // The boot handshake failed, so nothing is live. An error raised now used to
    // be discarded without a trace.
    consoleImpl.error(new Error("db timeout during the outage"));
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    // The endpoint comes back and the backoff gate opens.
    reachable = true;
    clock += 60_000;
    consoleImpl.error(new Error("later failure"));
    await vi.waitFor(() => {
      const kinds = eventsFrom(calls).map((e) => e.k);
      expect(kinds.filter((k) => k === AUTO_CAPTURE_ERROR_EVENT)).toHaveLength(
        2,
      );
    });

    // Both errors landed, including the one raised while the endpoint was dark.
    const messages = eventsFrom(calls)
      .filter((e) => e.k === AUTO_CAPTURE_ERROR_EVENT)
      .map((e) => (e.d.error as { message?: string } | undefined)?.message);
    expect(messages).toContain("db timeout during the outage");
    expect(messages).toContain("later failure");
  });

  it("records a capture gap for evidence that could not be held", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    let clock = 1_000;
    let reachable = false;
    const calls: FetchCall[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (!reachable) throw new TypeError("fetch failed");
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    const consoleImpl = { error: vi.fn() };
    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
        // One held event; everything past it must be counted, not silently lost.
        maxPendingEvents: 1,
        instrumentDatabases: false,
        captureLogs: false,
        captureRuntimeWarnings: false,
        captureHttpRequests: false,
        captureOutboundHttp: false,
      }),
    );

    for (let index = 0; index < 4; index += 1) {
      consoleImpl.error(new Error(`failure ${index}`));
      await Promise.resolve();
    }

    reachable = true;
    clock += 60_000;
    consoleImpl.error(new Error("recovered"));

    await vi.waitFor(() => {
      const gap = eventsFrom(calls).find((e) => e.k === "capture_gap");
      expect(gap).toBeDefined();
      // The count is the point: a brief that knows three events are missing is
      // worth far more than one that quietly is missing them.
      expect(gap?.d.droppedEventCount).toBeGreaterThanOrEqual(1);
      expect(gap?.d.reason).toBe("delivery_failed");
    });
  });

  it("records that the process was terminated by a signal", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    // `kill` is what the handler uses to re-raise the signal once it has
    // recorded; the fake records the call instead of ending the test runner.
    const kill = vi.fn();
    (proc as unknown as { kill: unknown }).kill = kill;
    (proc as unknown as { pid: number }).pid = 4321;
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        instrumentDatabases: false,
        captureLogs: false,
        captureRuntimeWarnings: false,
        captureHttpRequests: false,
        captureOutboundHttp: false,
      }),
    );

    proc.emit("SIGTERM" as never);

    await vi.waitFor(() => {
      const lifecycle = eventsFrom(calls).find(
        (e) => e.k === "session.lifecycle",
      );
      expect(lifecycle).toBeDefined();
      expect(lifecycle?.d.action).toBe("process-terminated");
      expect(lifecycle?.d.reason).toBe("SIGTERM");
      expect(lifecycle?.d.pid).toBe(4321);
    });

    // Having recorded, the handler removes itself and re-raises, so the process
    // still dies exactly as the operator asked.
    await vi.waitFor(() => {
      expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
    });
    expect(proc.listenerCount("SIGTERM" as never)).toBe(0);
  });

  it("names the session start metadata that identifies the process", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    (proc as unknown as { pid: number }).pid = 99;
    (proc as unknown as { uptime: () => number }).uptime = () => 12.5;
    (proc as unknown as { version: string }).version = "v24.0.0";
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        instrumentDatabases: false,
      }),
    );

    const start = calls.find((c) => c.url.endsWith("/api/session/start"));
    const body = JSON.parse(start?.init.body as string) as {
      metadata?: { process?: Record<string, unknown> };
    };
    expect(body.metadata?.process?.pid).toBe(99);
    expect(body.metadata?.process?.uptimeMs).toBe(12_500);
    expect(body.metadata?.process?.node).toBe("v24.0.0");
  });
  // The regression this pins: DB instrumentation used to be installed after the
  // initial handshake, so the driver factories were only replaced once a network
  // round trip had finished. A host that builds its pool at module load — the
  // ordinary shape of a Node service — had already built it, and the swapped
  // factory wrapped nothing. Creating the pool here without awaiting autoCapture
  // reproduces that timing exactly.
  it("patches DB drivers before it first yields, so a pool built at import time is wrapped", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    const executed: string[] = [];
    class Client {
      async query(
        text: unknown,
      ): Promise<{ rows: unknown[]; rowCount: number }> {
        executed.push(String(text));
        return { rows: [{ id: 1, total: 10 }], rowCount: 1 };
      }
    }
    class Pool extends Client {}
    const pgModule: Record<string, unknown> = { Client, Pool };

    const pending = autoCapture({
      endpoint: ENDPOINT,
      service: "svc",
      processImpl: proc,
      consoleImpl: { error: vi.fn() } as unknown as Console,
      fetchImpl,
      onCrashExit: () => {},
      databaseDrivers: ["pg"],
      captureDatabaseReads: true,
      captureDatabaseBeforeImages: true,
      captureDatabaseCallsites: true,
      databaseResolve: (specifier: string) => {
        if (specifier === "pg") return pgModule;
        const error = new Error(`Cannot find module '${specifier}'`);
        (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
        throw error;
      },
    });

    // The host's own module graph is still evaluating: the handshake has not
    // resolved, and this is the only chance the patch gets.
    const PatchedPool = pgModule.Pool as new () => {
      query(text: string): Promise<unknown>;
    };
    const pool = new PatchedPool();

    track(await pending);
    // Statements carry evidence only inside a request scope, which is what a
    // recorder establishes for a real request.
    await runInBackendRequestContext(
      { requestId: "req_1", sessionId: "sess_1", sessionIdSource: "header" },
      () => pool.query("UPDATE carts SET total = 10 WHERE id = 1"),
    );
    await runInBackendRequestContext(
      { requestId: "req_1", sessionId: "sess_1", sessionIdSource: "header" },
      () => pool.query("SELECT * FROM carts WHERE id = 1"),
    );
    await new Promise((r) => setTimeout(r, 0));

    // The host's statement still ran, and it carried evidence with it.
    expect(executed.some((sql) => sql.includes("UPDATE carts"))).toBe(true);
    const kinds = eventsFrom(calls).map((e) => e.k);
    expect(kinds.some((k) => k.startsWith("db"))).toBe(true);
    const databaseEvents = eventsFrom(calls).filter((e) =>
      e.k.startsWith("db"),
    );
    expect(databaseEvents.some((event) => event.k === "db.read")).toBe(true);
    expect(
      databaseEvents.some(
        (event) =>
          event.k === "db.diff" &&
          event.d.before !== undefined &&
          event.d.callsite !== undefined,
      ),
    ).toBe(true);
  });

  it("patches cache drivers before it first yields and correlates their operations", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    const redisModule = {
      createClient() {
        return {
          async get(_key: string) {
            return "cached value";
          },
        };
      },
    } as Record<string, unknown>;

    const pending = autoCapture({
      endpoint: ENDPOINT,
      service: "svc",
      processImpl: proc,
      consoleImpl: { error: vi.fn() } as unknown as Console,
      fetchImpl,
      onCrashExit: () => {},
      instrumentDatabases: false,
      cacheDrivers: ["redis"],
      cacheResolve: (specifier: string) => {
        if (specifier === "redis") return redisModule;
        throw new Error(`Cannot find module '${specifier}'`);
      },
    });

    const createClient = redisModule.createClient as () => {
      get(key: string): Promise<string>;
    };
    const client = createClient();

    track(await pending);
    await runInBackendRequestContext(
      {
        requestId: "req_cache",
        sessionId: "sess_1",
        sessionIdSource: "header",
      },
      () => client.get("user:12345:profile"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventsFrom(calls)).toContainEqual(
      expect.objectContaining({
        k: "cache",
        d: expect.objectContaining({
          requestId: "req_cache",
          key: "user:*:profile",
          hit: true,
        }),
      }),
    );
  });
});
