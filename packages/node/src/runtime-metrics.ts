import { readFile as readFileAsync } from "node:fs/promises";
import {
  monitorEventLoopDelay,
  performance as nodePerformance,
} from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import type { BugEvent } from "crumbtrail-core";

/** Canonical event kind for a bounded Node process health sample. */
export const BACKEND_RUNTIME_EVENT = "backend.runtime" as const;

/** Default runtime health sample cadence. */
export const DEFAULT_RUNTIME_METRIC_INTERVAL_MS = 30_000;

/** The sampler never runs more frequently than this. */
export const MIN_RUNTIME_METRIC_INTERVAL_MS = 10_000;

/** Node's maximum supported timer delay before it wraps to a near-immediate timer. */
export const MAX_RUNTIME_METRIC_INTERVAL_MS = 2_147_483_647;

/** Keep a sample small enough that it cannot crowd out incident evidence. */
export const MAX_RUNTIME_SAMPLE_BYTES = 4_096;

export interface NodeRuntimeSample {
  rssBytes?: number;
  heapUsedBytes?: number;
  heapLimitBytes?: number;
  externalBytes?: number;
  cpuUserDeltaMicros?: number;
  cpuSystemDeltaMicros?: number;
  cpuTotalDeltaMicros?: number;
  cpuIntervalMs?: number;
  /** CPU time divided by elapsed wall time, where both are available. */
  cpuUtilization?: number;
  eventLoopUtilization?: number;
  eventLoopDelayP95Ms?: number;
  eventLoopDelayMaxMs?: number;
  uptimeMs?: number;
  processStartMarker?: string;
  processStartedAt?: number;
  memoryLimitBytes?: number;
  cpuQuotaCores?: number;
}

export interface RuntimeContainerLimits {
  memoryLimitBytes?: number;
  cpuQuotaCores?: number;
}

export type RuntimeMetricsReadFile = (
  path: string,
  options: { encoding: "utf8" },
) => Promise<string>;

export interface RuntimeEventLoopDelayMonitor {
  enable(): unknown;
  disable(): unknown;
  reset(): unknown;
  percentile(percentile: number): number;
  max: number;
}

export interface RuntimePerformance {
  now?: () => number;
  eventLoopUtilization?: (
    utilization1?: RuntimeEventLoopUtilization,
    utilization2?: RuntimeEventLoopUtilization,
  ) => RuntimeEventLoopUtilization;
}

export interface RuntimeEventLoopUtilization {
  active: number;
  idle: number;
  utilization: number;
}

export interface RuntimeCpuUsage {
  user: number;
  system: number;
}

export interface RuntimeMemoryUsage {
  rss?: number;
  heapUsed?: number;
  external?: number;
}

export interface RuntimeProcess {
  pid?: number;
  memoryUsage?: () => RuntimeMemoryUsage;
  cpuUsage?: () => RuntimeCpuUsage;
  uptime?: () => number;
}

export interface RuntimeMetricsOptions {
  /** Sink for the bounded `backend.runtime` event. Its throws are swallowed. */
  emit: (event: BugEvent) => void;
  sessionId?: string;
  processImpl?: RuntimeProcess;
  now?: () => number;
  intervalMs?: number;
  readFile?: RuntimeMetricsReadFile;
  performanceImpl?: RuntimePerformance;
  heapLimitImpl?: () => number;
  eventLoopDelayImpl?: (options: {
    resolution: number;
  }) => RuntimeEventLoopDelayMonitor;
  setIntervalImpl?: (callback: () => void, delay: number) => unknown;
  clearIntervalImpl?: (timer: unknown) => void;
  monotonicNow?: () => number;
}

export interface RuntimeMetricsHandle {
  stop(): void;
}

const CGROUP_MEMORY_PATHS = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
] as const;

const CGROUP_CPU_V2_PATH = "/sys/fs/cgroup/cpu.max";
const CGROUP_CPU_V1_QUOTA_PATH = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const CGROUP_CPU_V1_PERIOD_PATH = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";

const RUNTIME_SAMPLE_FIELDS = new Set<keyof NodeRuntimeSample>([
  "rssBytes",
  "heapUsedBytes",
  "heapLimitBytes",
  "externalBytes",
  "cpuUserDeltaMicros",
  "cpuSystemDeltaMicros",
  "cpuTotalDeltaMicros",
  "cpuIntervalMs",
  "cpuUtilization",
  "eventLoopUtilization",
  "eventLoopDelayP95Ms",
  "eventLoopDelayMaxMs",
  "uptimeMs",
  "processStartMarker",
  "processStartedAt",
  "memoryLimitBytes",
  "cpuQuotaCores",
]);

const defaultReadFile: RuntimeMetricsReadFile = (path, options) =>
  readFileAsync(path, options);

/**
 * Read the small, numeric subset of cgroup limits that helps interpret a
 * runtime sample. This is intentionally a best-effort one-time operation.
 * Missing files, `max`, and unlimited v1 values produce no limit field.
 */
export async function readRuntimeContainerLimits(
  readFile: RuntimeMetricsReadFile = defaultReadFile,
): Promise<RuntimeContainerLimits | undefined> {
  const memoryValues = await Promise.all(
    CGROUP_MEMORY_PATHS.map((path) => readText(readFile, path)),
  );
  const memoryLimitBytes = memoryValues
    .map(parseMemoryLimit)
    .find((value): value is number => value !== undefined);

  const cpuV2 = await readText(readFile, CGROUP_CPU_V2_PATH);
  const cpuQuotaCores = parseCpuV2Limit(cpuV2);
  const cpuLimit =
    cpuQuotaCores === undefined
      ? await readV1CpuLimit(readFile)
      : cpuQuotaCores;

  if (memoryLimitBytes === undefined && cpuLimit === undefined)
    return undefined;
  return {
    ...(memoryLimitBytes !== undefined ? { memoryLimitBytes } : {}),
    ...(cpuLimit !== undefined ? { cpuQuotaCores: cpuLimit } : {}),
  };
}

/** Normalize a user cadence without allowing a hot timer. */
export function normalizeRuntimeMetricIntervalMs(value?: number): number {
  if (value === undefined || !Number.isFinite(value))
    return DEFAULT_RUNTIME_METRIC_INTERVAL_MS;
  return Math.min(
    MAX_RUNTIME_METRIC_INTERVAL_MS,
    Math.max(MIN_RUNTIME_METRIC_INTERVAL_MS, Math.round(value)),
  );
}

/** Build a bounded event from a sample for tests and low-level consumers. */
export function buildNodeRuntimeEvent(
  sample: NodeRuntimeSample,
  context: {
    sessionId?: string;
    now?: number;
  } = {},
): BugEvent {
  const t = finiteNonNegative(context.now) ?? Date.now();
  const data = boundedSample(sample);
  const event: BugEvent = {
    t,
    k: BACKEND_RUNTIME_EVENT,
    platform: "node",
    d: data as Record<string, unknown>,
  };
  if (context.sessionId) event.sessionId = context.sessionId;
  return event;
}

/**
 * Start bounded runtime health sampling. The returned handle owns only the
 * interval and event-loop monitor it creates, so `stop()` is safe and idempotent.
 */
export function installRuntimeMetrics(
  options: RuntimeMetricsOptions,
): RuntimeMetricsHandle {
  const proc = options.processImpl ?? process;
  const now = options.now ?? Date.now;
  const performanceImpl = options.performanceImpl ?? nodePerformance;
  const monotonicNow =
    options.monotonicNow ??
    (() => {
      if (typeof performanceImpl.now === "function")
        return performanceImpl.now();
      return now();
    });
  const sampleIntervalMs = normalizeRuntimeMetricIntervalMs(options.intervalMs);
  const startedAt = finiteNumber(now());
  const uptimeMs = readUptimeMs(proc);
  const processStartedAt =
    startedAt !== undefined && uptimeMs !== undefined
      ? Math.max(0, Math.round(startedAt - uptimeMs))
      : undefined;
  const processStartMarker = makeProcessStartMarker(
    proc.pid,
    processStartedAt ?? startedAt,
  );

  let limits: RuntimeContainerLimits | undefined;
  let stopped = false;
  let previousCpu = readCpuUsage(proc);
  let previousMonotonic = monotonicNow();
  let previousEventLoopUtilization =
    readEventLoopUtilizationSnapshot(performanceImpl);

  const eventLoopDelay = createEventLoopDelay(options);
  try {
    eventLoopDelay?.enable();
  } catch {
    // A restricted runtime can expose perf_hooks but refuse the monitor.
  }

  // cgroup reads are asynchronous and happen once, outside the interval path.
  void (
    options.readFile
      ? readRuntimeContainerLimits(options.readFile)
      : readRuntimeContainerLimits()
  )
    .then((readLimits) => {
      if (!stopped) limits = readLimits;
    })
    .catch(() => {
      // Container limits are contextual evidence, never a reason to affect the host.
    });

  const sample = (): void => {
    if (stopped) return;
    try {
      const currentMonotonic = monotonicNow();
      const elapsedMs = finiteNonNegative(currentMonotonic - previousMonotonic);
      previousMonotonic = currentMonotonic;

      const currentCpu = readCpuUsage(proc);
      const cpuUserDeltaMicros = delta(currentCpu?.user, previousCpu?.user);
      const cpuSystemDeltaMicros = delta(
        currentCpu?.system,
        previousCpu?.system,
      );
      previousCpu = currentCpu;
      const cpuTotalDeltaMicros =
        cpuUserDeltaMicros !== undefined && cpuSystemDeltaMicros !== undefined
          ? cpuUserDeltaMicros + cpuSystemDeltaMicros
          : undefined;

      const eventLoopUtilization = readEventLoopUtilization(
        performanceImpl,
        previousEventLoopUtilization,
      );
      previousEventLoopUtilization =
        readEventLoopUtilizationSnapshot(performanceImpl);

      const memory = readMemoryUsage(proc);
      const heapLimitBytes = readHeapLimit(options.heapLimitImpl);
      const eventLoopDelayValues = readEventLoopDelay(eventLoopDelay);
      const sampleUptimeMs = uptimeMsForSample(proc);
      const event = buildNodeRuntimeEvent(
        {
          ...(memory?.rss !== undefined ? { rssBytes: memory.rss } : {}),
          ...(memory?.heapUsed !== undefined
            ? { heapUsedBytes: memory.heapUsed }
            : {}),
          ...(heapLimitBytes !== undefined ? { heapLimitBytes } : {}),
          ...(memory?.external !== undefined
            ? { externalBytes: memory.external }
            : {}),
          ...(cpuUserDeltaMicros !== undefined ? { cpuUserDeltaMicros } : {}),
          ...(cpuSystemDeltaMicros !== undefined
            ? { cpuSystemDeltaMicros }
            : {}),
          ...(cpuTotalDeltaMicros !== undefined ? { cpuTotalDeltaMicros } : {}),
          ...(elapsedMs !== undefined ? { cpuIntervalMs: elapsedMs } : {}),
          ...(cpuTotalDeltaMicros !== undefined &&
          elapsedMs !== undefined &&
          elapsedMs > 0
            ? {
                cpuUtilization: Math.min(
                  1_000,
                  cpuTotalDeltaMicros / (elapsedMs * 1_000),
                ),
              }
            : {}),
          ...(eventLoopUtilization !== undefined
            ? { eventLoopUtilization }
            : {}),
          ...(eventLoopDelayValues?.p95Ms !== undefined
            ? { eventLoopDelayP95Ms: eventLoopDelayValues.p95Ms }
            : {}),
          ...(eventLoopDelayValues?.maxMs !== undefined
            ? { eventLoopDelayMaxMs: eventLoopDelayValues.maxMs }
            : {}),
          ...(sampleUptimeMs !== undefined ? { uptimeMs: sampleUptimeMs } : {}),
          processStartMarker,
          ...(processStartedAt !== undefined ? { processStartedAt } : {}),
          ...(limits?.memoryLimitBytes !== undefined
            ? { memoryLimitBytes: limits.memoryLimitBytes }
            : {}),
          ...(limits?.cpuQuotaCores !== undefined
            ? { cpuQuotaCores: limits.cpuQuotaCores }
            : {}),
        },
        { sessionId: options.sessionId, now: now() },
      );
      try {
        options.emit(event);
      } finally {
        try {
          eventLoopDelay?.reset();
        } catch {
          // Histogram reset is best effort and never affects the host.
        }
      }
    } catch {
      // Runtime introspection must never affect the application process.
    }
  };

  const setIntervalImpl: (callback: () => void, delay: number) => unknown =
    options.setIntervalImpl ??
    ((callback, delay) => setInterval(callback, delay));
  const clearIntervalImpl: (timer: unknown) => void =
    options.clearIntervalImpl ??
    ((timer) => clearInterval(timer as NodeJS.Timeout));
  let timer: unknown;
  try {
    timer = setIntervalImpl(sample, sampleIntervalMs);
  } catch (error) {
    try {
      eventLoopDelay?.disable();
    } catch {
      // Teardown is best effort for restricted runtimes.
    }
    try {
      eventLoopDelay?.reset();
    } catch {
      // Teardown is best effort for restricted runtimes.
    }
    throw error;
  }
  try {
    (timer as { unref?: () => void }).unref?.();
  } catch {
    // A test or embedded runtime may expose a timer without unref.
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        clearIntervalImpl(timer);
      } catch {
        // Teardown is best effort for custom timer implementations.
      }
      try {
        eventLoopDelay?.disable();
      } catch {
        // Teardown is best effort for restricted runtimes.
      }
      try {
        eventLoopDelay?.reset();
      } catch {
        // Teardown is best effort for restricted runtimes.
      }
    },
  };
}

function createEventLoopDelay(
  options: RuntimeMetricsOptions,
): RuntimeEventLoopDelayMonitor | undefined {
  const create =
    options.eventLoopDelayImpl ??
    ((monitorOptions: { resolution: number }) =>
      monitorEventLoopDelay(
        monitorOptions,
      ) as unknown as RuntimeEventLoopDelayMonitor);
  try {
    return create({ resolution: 20 });
  } catch {
    return undefined;
  }
}

function readMemoryUsage(proc: RuntimeProcess): RuntimeMemoryUsage | undefined {
  try {
    const usage = proc.memoryUsage?.();
    if (!usage) return undefined;
    return {
      ...(finiteNonNegative(usage.rss) !== undefined
        ? { rss: finiteNonNegative(usage.rss) }
        : {}),
      ...(finiteNonNegative(usage.heapUsed) !== undefined
        ? { heapUsed: finiteNonNegative(usage.heapUsed) }
        : {}),
      ...(finiteNonNegative(usage.external) !== undefined
        ? { external: finiteNonNegative(usage.external) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function readHeapLimit(heapLimitImpl?: () => number): number | undefined {
  try {
    const value = heapLimitImpl
      ? heapLimitImpl()
      : getHeapStatistics().heap_size_limit;
    return finiteNonNegative(value);
  } catch {
    return undefined;
  }
}

function readCpuUsage(proc: RuntimeProcess): RuntimeCpuUsage | undefined {
  try {
    const usage = proc.cpuUsage?.();
    if (!usage) return undefined;
    const user = finiteNonNegative(usage.user);
    const system = finiteNonNegative(usage.system);
    if (user === undefined || system === undefined) return undefined;
    return { user, system };
  } catch {
    return undefined;
  }
}

function readUptimeMs(proc: RuntimeProcess): number | undefined {
  try {
    const uptime = proc.uptime?.();
    return uptime === undefined ? undefined : finiteNonNegative(uptime * 1_000);
  } catch {
    return undefined;
  }
}

function uptimeMsForSample(proc: RuntimeProcess): number | undefined {
  const uptime = readUptimeMs(proc);
  return uptime === undefined ? undefined : Math.round(uptime);
}

function readEventLoopUtilization(
  performanceImpl: RuntimePerformance,
  previous?: RuntimeEventLoopUtilization,
): number | undefined {
  try {
    if (typeof performanceImpl.eventLoopUtilization !== "function")
      return undefined;
    const result = performanceImpl.eventLoopUtilization(previous);
    const utilization = result?.utilization;
    if (utilization === undefined || !Number.isFinite(utilization))
      return undefined;
    return Math.max(0, Math.min(1, utilization));
  } catch {
    return undefined;
  }
}

function readEventLoopUtilizationSnapshot(
  performanceImpl: RuntimePerformance,
): RuntimeEventLoopUtilization | undefined {
  try {
    if (typeof performanceImpl.eventLoopUtilization !== "function")
      return undefined;
    return performanceImpl.eventLoopUtilization();
  } catch {
    return undefined;
  }
}

function readEventLoopDelay(
  monitor: RuntimeEventLoopDelayMonitor | undefined,
): { p95Ms?: number; maxMs?: number } | undefined {
  if (!monitor) return undefined;
  try {
    const p95Ms = finiteNonNegative(monitor.percentile(95) / 1_000_000);
    const maxMs = finiteNonNegative(monitor.max / 1_000_000);
    return {
      ...(p95Ms !== undefined ? { p95Ms } : {}),
      ...(maxMs !== undefined ? { maxMs } : {}),
    };
  } catch {
    return undefined;
  }
}

function delta(current?: number, previous?: number): number | undefined {
  if (current === undefined || previous === undefined) return undefined;
  return finiteNonNegative(current - previous);
}

function boundedSample(sample: NodeRuntimeSample): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sample)) {
    if (!RUNTIME_SAMPLE_FIELDS.has(key as keyof NodeRuntimeSample)) continue;
    if (typeof value === "number") {
      const normalized =
        key === "cpuUtilization" || key === "eventLoopUtilization"
          ? finiteNonNegative(value)
          : finiteNonNegative(value);
      if (normalized !== undefined) result[key] = normalized;
    } else if (key === "processStartMarker" && typeof value === "string") {
      const marker = value
        .trim()
        .replace(/[^A-Za-z0-9:_.-]/g, "")
        .slice(0, 128);
      if (marker) result[key] = marker;
    }
  }
  // All fields are fixed numeric values and the marker is bounded above. This
  // defensive check protects future additions from turning a sample into an
  // oversized event without making the host process pay for serialization.
  if (byteLength(result) <= MAX_RUNTIME_SAMPLE_BYTES) return result;
  delete result.processStartMarker;
  return result;
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function makeProcessStartMarker(pid?: number, startedAt?: number): string {
  const pidPart = Number.isFinite(pid)
    ? String(Math.max(0, Math.round(pid as number)))
    : "unknown";
  const startPart =
    startedAt !== undefined
      ? String(Math.max(0, Math.round(startedAt)))
      : "unknown";
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `node:${pidPart}:${startPart}:${randomPart}`.slice(0, 128);
}

async function readText(
  readFile: RuntimeMetricsReadFile,
  path: string,
): Promise<string | undefined> {
  try {
    const value = await readFile(path, { encoding: "utf8" });
    return typeof value === "string" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseMemoryLimit(value: string | undefined): number | undefined {
  if (!value || value === "max") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  // cgroup v1 commonly reports this sentinel for an unlimited limit.
  if (parsed >= 9_000_000_000_000_000_000) return undefined;
  return parsed;
}

function parseCpuV2Limit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [quotaText, periodText] = value.split(/\s+/);
  if (!quotaText || quotaText === "max") return undefined;
  const quota = Number(quotaText);
  const period = Number(periodText);
  if (
    !Number.isFinite(quota) ||
    !Number.isFinite(period) ||
    quota <= 0 ||
    period <= 0
  )
    return undefined;
  return Math.min(256, quota / period);
}

async function readV1CpuLimit(
  readFile: RuntimeMetricsReadFile,
): Promise<number | undefined> {
  const [quotaText, periodText] = await Promise.all([
    readText(readFile, CGROUP_CPU_V1_QUOTA_PATH),
    readText(readFile, CGROUP_CPU_V1_PERIOD_PATH),
  ]);
  const quota = Number(quotaText);
  const period = Number(periodText);
  if (
    !Number.isFinite(quota) ||
    !Number.isFinite(period) ||
    quota <= 0 ||
    period <= 0
  )
    return undefined;
  return Math.min(256, quota / period);
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  const normalized = finiteNumber(value);
  return normalized === undefined || normalized < 0 ? undefined : normalized;
}
