import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CPU_PROFILE_DEADLINE_MS,
  CPU_PROFILE_DURATION_MS,
  __resetCpuProfileStateForTests,
  createCpuProfileProbeExecutor,
  type CpuProfileInspectorSession,
} from "../cpu-profile";

interface SessionOptions {
  profile?: unknown;
  stop?: () => Promise<unknown>;
  hangingMethods?: string[];
}

function makeSession(options: SessionOptions = {}): {
  session: CpuProfileInspectorSession;
  calls: string[];
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const connect = vi.fn();
  const disconnect = vi.fn();
  const session: CpuProfileInspectorSession = {
    connect,
    disconnect,
    post: vi.fn((method: string) => {
      calls.push(method);
      if (options.hangingMethods?.includes(method))
        return new Promise(() => {});
      if (method === "Profiler.stop" && options.stop) return options.stop();
      if (method === "Profiler.stop")
        return Promise.resolve({ profile: options.profile ?? profile() });
      return Promise.resolve({});
    }),
  };
  return { session, calls, connect, disconnect };
}

function profile(): Record<string, unknown> {
  return {
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "checkout",
          url: "https://app.example.test/checkout.js",
          lineNumber: 12,
          columnNumber: 4,
          args: [{ secret: "not exported" }],
          scriptId: "17",
        },
      },
      {
        id: 2,
        callFrame: { functionName: "(program)" },
      },
    ],
    samples: [1, 1, 2],
    timeDeltas: [1, 1, 1],
    arbitraryNestedData: { source: { body: "not exported" } },
  };
}

function executorFor(
  session: CpuProfileInspectorSession,
  createSession = vi.fn(() => session),
) {
  return createCpuProfileProbeExecutor({
    createSession,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  __resetCpuProfileStateForTests();
});

describe("runtime.cpu_profile Node executor", () => {
  it("uses one fixed sampling window and returns the bounded summary", async () => {
    vi.useFakeTimers();
    const fake = makeSession();
    const executor = executorFor(fake.session);
    const pending = executor(new AbortController().signal);
    await flush();
    await vi.advanceTimersByTimeAsync(CPU_PROFILE_DURATION_MS);

    await expect(pending).resolves.toEqual({
      durationMs: 1_000,
      sampleCount: 3,
      topFunctions: [
        {
          functionName: "checkout",
          url: "https://app.example.test/checkout.js",
          lineNumber: 12,
          columnNumber: 4,
          selfSamples: 2,
        },
        { functionName: "(anonymous)", selfSamples: 1 },
      ],
    });
    expect(fake.calls).toEqual([
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable",
    ]);
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the hard deadline when an inspector command never settles", async () => {
    vi.useFakeTimers();
    const fake = makeSession({ hangingMethods: ["Profiler.start"] });
    const pending = executorFor(fake.session)(new AbortController().signal);
    await flush();
    const rejected = expect(pending).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(CPU_PROFILE_DEADLINE_MS);

    await rejected;
    expect(fake.calls).toEqual([
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable",
    ]);
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts cooperatively and still stops, disables, disconnects, and clears timers", async () => {
    vi.useFakeTimers();
    const fake = makeSession();
    const controller = new AbortController();
    const pending = executorFor(fake.session)(controller.signal);
    await flush();
    const rejected = expect(pending).rejects.toMatchObject({
      reason: "aborted",
    });
    controller.abort();

    await rejected;
    expect(fake.calls).toContain("Profiler.stop");
    expect(fake.calls).toContain("Profiler.disable");
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a stop failure and runs cleanup", async () => {
    vi.useFakeTimers();
    const fake = makeSession({
      stop: () => Promise.reject(new Error("stop rejected")),
    });
    const pending = executorFor(fake.session)(new AbortController().signal);
    await flush();
    const rejected = expect(pending).rejects.toMatchObject({
      reason: "profiler stop failed",
    });
    await vi.advanceTimersByTimeAsync(CPU_PROFILE_DURATION_MS);

    await rejected;
    expect(fake.calls).toEqual([
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable",
    ]);
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports unsupported inspector without creating a session", async () => {
    vi.useFakeTimers();
    const createSession = vi.fn(() => undefined);
    const pending = createCpuProfileProbeExecutor({
      createSession,
      setTimeoutImpl: setTimeout,
      clearTimeoutImpl: clearTimeout,
    })(new AbortController().signal);

    await expect(pending).rejects.toMatchObject({
      reason: "unsupported inspector",
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a simultaneous request before opening a second inspector session", async () => {
    vi.useFakeTimers();
    const firstSession = makeSession({ hangingMethods: ["Profiler.start"] });
    const secondSession = makeSession();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(firstSession.session)
      .mockReturnValueOnce(secondSession.session);
    const executor = executorFor(firstSession.session, createSession);
    const first = executor(new AbortController().signal);
    await flush();
    const firstRejected = expect(first).rejects.toMatchObject({
      reason: "timeout",
    });
    const second = executor(new AbortController().signal);

    await expect(second).rejects.toMatchObject({
      reason: "profile already active",
    });
    expect(createSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CPU_PROFILE_DEADLINE_MS);
    await firstRejected;
  });

  it("normalizes names, strips raw nodes, and caps rows and scalars", async () => {
    vi.useFakeTimers();
    const nodes = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      callFrame: {
        functionName: index === 0 ? "(root)" : `fn-${index}-${"x".repeat(300)}`,
        url:
          index === 0
            ? "https://app.example.test/a?access_token=secret-123456789"
            : undefined,
        lineNumber: 9_999_999_999,
        columnNumber: 9_999_999_999,
        scopeChain: [{ object: { value: "not exported" } }],
      },
    }));
    const fake = makeSession({
      profile: {
        nodes,
        samples: nodes.map((node) => node.id),
      },
    });
    const pending = executorFor(fake.session)(new AbortController().signal);
    await flush();
    await vi.advanceTimersByTimeAsync(CPU_PROFILE_DURATION_MS);
    const result = await pending;

    expect(result.sampleCount).toBe(60);
    expect(result.topFunctions).toHaveLength(50);
    expect(result.topFunctions[0].functionName).toBe("[internal]");
    expect(result.topFunctions[0].url).not.toContain("secret-123456789");
    expect(result.topFunctions[0].lineNumber).toBe(1_000_000_000);
    expect(result.topFunctions[0].columnNumber).toBe(1_000_000_000);
    for (const row of result.topFunctions) {
      expect(
        Object.keys(row).every((key) =>
          [
            "functionName",
            "url",
            "lineNumber",
            "columnNumber",
            "selfSamples",
          ].includes(key),
        ),
      ).toBe(true);
      expect(row.functionName.length).toBeLessThanOrEqual(160);
    }
    expect(JSON.stringify(result)).not.toContain("not exported");
  });

  it("cleans up after an enable failure before profiling starts", async () => {
    vi.useFakeTimers();
    const fake = makeSession();
    fake.session.post = vi.fn((method: string) => {
      fake.calls.push(method);
      if (method === "Profiler.enable")
        return Promise.reject(new Error("enable failed"));
      return Promise.resolve({});
    });
    const pending = executorFor(fake.session)(new AbortController().signal);
    await expect(pending).rejects.toThrow("enable failed");
    expect(fake.calls).toEqual([
      "Profiler.enable",
      "Profiler.stop",
      "Profiler.disable",
    ]);
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
