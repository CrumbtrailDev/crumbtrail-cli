import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_RUNTIME_EVENT,
  DEFAULT_RUNTIME_METRIC_INTERVAL_MS,
  MAX_RUNTIME_METRIC_INTERVAL_MS,
  MIN_RUNTIME_METRIC_INTERVAL_MS,
  buildNodeRuntimeEvent,
  installRuntimeMetrics,
  normalizeRuntimeMetricIntervalMs,
  readRuntimeContainerLimits,
  type RuntimeMetricsReadFile,
} from "../runtime-metrics";

interface TimerHandle {
  callback: () => void;
  unref: ReturnType<typeof vi.fn>;
}

function makeReader(files: Record<string, string>): RuntimeMetricsReadFile {
  return vi.fn(async (path: string) => {
    const value = files[path];
    if (value === undefined) throw new Error("ENOENT");
    return value;
  }) as unknown as RuntimeMetricsReadFile;
}

function makeMonitor() {
  return {
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    percentile: vi.fn(() => 12_500_000),
    max: 25_000_000,
  };
}

describe("Node runtime metrics", () => {
  const openHandles: Array<{ stop(): void }> = [];
  afterEach(() => {
    for (const handle of openHandles) handle.stop();
    openHandles.length = 0;
  });

  it("uses a 30 second default and enforces a 10 second minimum", () => {
    expect(DEFAULT_RUNTIME_METRIC_INTERVAL_MS).toBe(30_000);
    expect(MIN_RUNTIME_METRIC_INTERVAL_MS).toBe(10_000);
    expect(normalizeRuntimeMetricIntervalMs()).toBe(30_000);
    expect(normalizeRuntimeMetricIntervalMs(1_000)).toBe(10_000);
    expect(normalizeRuntimeMetricIntervalMs(Number.NaN)).toBe(30_000);
    expect(normalizeRuntimeMetricIntervalMs(10_001.4)).toBe(10_001);
    expect(
      normalizeRuntimeMetricIntervalMs(MAX_RUNTIME_METRIC_INTERVAL_MS),
    ).toBe(MAX_RUNTIME_METRIC_INTERVAL_MS);
    expect(
      normalizeRuntimeMetricIntervalMs(MAX_RUNTIME_METRIC_INTERVAL_MS + 1),
    ).toBe(MAX_RUNTIME_METRIC_INTERVAL_MS);
  });

  it("passes the maximum safe delay to the timer and clamps larger values", () => {
    const delays: number[] = [];
    const timer = { unref: vi.fn() };
    const handle = installRuntimeMetrics({
      emit: () => {},
      readFile: makeReader({}),
      intervalMs: MAX_RUNTIME_METRIC_INTERVAL_MS + 1,
      setIntervalImpl: (_callback, delay) => {
        delays.push(delay);
        return timer;
      },
      clearIntervalImpl: () => {},
    });
    handle.stop();

    expect(delays).toEqual([MAX_RUNTIME_METRIC_INTERVAL_MS]);
    expect(timer.unref).toHaveBeenCalledOnce();
  });

  it("emits bounded memory, CPU, event loop, uptime, marker, and cgroup fields", async () => {
    const emitted: Array<{ k: string; d: Record<string, unknown> }> = [];
    const timers: TimerHandle[] = [];
    const monitor = makeMonitor();
    const cpuUsages = [
      { user: 10_000, system: 5_000 },
      { user: 10_300, system: 5_500 },
    ];
    const monotonicValues = [1_000, 3_000];
    const performanceImpl = {
      eventLoopUtilization: vi.fn((previous?: object) =>
        previous
          ? { active: 200, idle: 100, utilization: 0.4 }
          : { active: 100, idle: 100, utilization: 0.2 },
      ),
    };
    const processImpl = {
      pid: 42,
      memoryUsage: vi.fn(() => ({
        rss: 4_000,
        heapUsed: 2_000,
        external: 700,
      })),
      cpuUsage: vi.fn(
        () => cpuUsages.shift() ?? { user: 10_300, system: 5_500 },
      ),
      uptime: vi.fn(() => 12.5),
    };

    const handle = installRuntimeMetrics({
      emit: (event) => emitted.push(event as (typeof emitted)[number]),
      sessionId: "ses_runtime",
      processImpl,
      now: () => 2_000_000,
      monotonicNow: () => monotonicValues.shift() ?? 3_000,
      performanceImpl,
      heapLimitImpl: () => 8_000,
      eventLoopDelayImpl: () => monitor,
      readFile: makeReader({
        "/sys/fs/cgroup/memory.max": "16000",
        "/sys/fs/cgroup/cpu.max": "200000 100000",
      }),
      setIntervalImpl: (callback) => {
        const timer: TimerHandle = { callback, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      clearIntervalImpl: vi.fn(),
    });
    openHandles.push(handle);

    await new Promise<void>((resolve) => setImmediate(resolve));
    timers[0]!.callback();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      k: BACKEND_RUNTIME_EVENT,
      d: {
        rssBytes: 4_000,
        heapUsedBytes: 2_000,
        heapLimitBytes: 8_000,
        externalBytes: 700,
        cpuUserDeltaMicros: 300,
        cpuSystemDeltaMicros: 500,
        cpuTotalDeltaMicros: 800,
        cpuIntervalMs: 2_000,
        cpuUtilization: 0.0004,
        eventLoopUtilization: 0.4,
        eventLoopDelayP95Ms: 12.5,
        eventLoopDelayMaxMs: 25,
        uptimeMs: 12_500,
        processStartMarker: expect.stringMatching(/^node:42:/),
        processStartedAt: 1_987_500,
        memoryLimitBytes: 16_000,
        cpuQuotaCores: 2,
      },
      sessionId: "ses_runtime",
      platform: "node",
    });
    expect(JSON.stringify(emitted[0]).length).toBeLessThan(4_096);
    expect(timers[0]!.unref).toHaveBeenCalledOnce();
    expect(monitor.enable).toHaveBeenCalledOnce();
  });

  it("omits unavailable cgroup limits without failing", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("cgroup is not mounted");
    }) as unknown as RuntimeMetricsReadFile;

    await expect(readRuntimeContainerLimits(readFile)).resolves.toBeUndefined();
  });

  it("clears and disables the monitor on stop, and does not sample afterward", () => {
    const emitted: unknown[] = [];
    const timers: TimerHandle[] = [];
    const monitor = makeMonitor();
    const clearIntervalImpl = vi.fn();
    const handle = installRuntimeMetrics({
      emit: (event) => emitted.push(event),
      processImpl: {
        memoryUsage: () => ({ rss: 1, heapUsed: 1, external: 1 }),
        cpuUsage: () => ({ user: 1, system: 1 }),
        uptime: () => 1,
      },
      eventLoopDelayImpl: () => monitor,
      readFile: makeReader({}),
      setIntervalImpl: (callback) => {
        const timer: TimerHandle = { callback, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      clearIntervalImpl,
    });

    handle.stop();
    handle.stop();
    timers[0]!.callback();

    expect(clearIntervalImpl).toHaveBeenCalledOnce();
    expect(monitor.disable).toHaveBeenCalledOnce();
    expect(monitor.reset).toHaveBeenCalledOnce();
    expect(emitted).toHaveLength(0);
  });

  it("swallows introspection and sink failures", () => {
    const timer: TimerHandle = { callback: () => {}, unref: vi.fn() };
    const handle = installRuntimeMetrics({
      emit: () => {
        throw new Error("sink unavailable");
      },
      processImpl: {
        memoryUsage: () => {
          throw new Error("memory unavailable");
        },
        cpuUsage: () => {
          throw new Error("cpu unavailable");
        },
      },
      readFile: makeReader({}),
      setIntervalImpl: (callback) => {
        timer.callback = callback;
        return timer;
      },
      clearIntervalImpl: () => {},
    });
    expect(() => timer.callback()).not.toThrow();
    handle.stop();
  });

  it("tears down the monitor when interval creation fails", () => {
    const monitor = makeMonitor();

    expect(() =>
      installRuntimeMetrics({
        emit: () => {},
        eventLoopDelayImpl: () => monitor,
        readFile: makeReader({}),
        setIntervalImpl: () => {
          throw new Error("timer unavailable");
        },
      }),
    ).toThrow("timer unavailable");

    expect(monitor.enable).toHaveBeenCalledOnce();
    expect(monitor.disable).toHaveBeenCalledOnce();
    expect(monitor.reset).toHaveBeenCalledOnce();
  });

  it("bounds arbitrary low level markers and ignores non numeric fields", () => {
    const event = buildNodeRuntimeEvent(
      {
        rssBytes: -1,
        heapUsedBytes: Number.POSITIVE_INFINITY,
        processStartMarker: " marker with spaces and ! ".repeat(20),
        // Keep this cast to exercise the runtime boundary against JavaScript callers.
        unexpected: "discarded",
        unexpectedNumber: 123,
      } as never,
      { sessionId: "ses", now: 10 },
    );

    expect(event.d).toEqual({
      processStartMarker: expect.any(String),
    });
    expect(String(event.d.processStartMarker)).not.toContain(" ");
    expect(String(event.d.processStartMarker).length).toBeLessThanOrEqual(128);
  });
});
