import * as inspector from "node:inspector";
import {
  CPU_PROFILE_MAX_FUNCTIONS,
  CPU_PROFILE_MAX_SAMPLE_COUNT,
  type CpuProfileFunction,
  type CpuProfileProbeData,
  type CpuProfileProbeExecutor,
} from "crumbtrail-core";
import { redactUrl } from "crumbtrail-core";

/** The fixed CPU sampling window. It is intentionally not an option. */
export const CPU_PROFILE_DURATION_MS = 1_000;

/** The hard wall clock deadline for profiling and inspector cleanup. */
export const CPU_PROFILE_DEADLINE_MS = 2_000;

/** The fixed V8 sampling interval in microseconds. It is intentionally not an option. */
const CPU_PROFILE_SAMPLING_INTERVAL_US = 1_000;

const FUNCTION_NAME_MAX_LENGTH = 160;
const URL_MAX_LENGTH = 512;
const SOURCE_POSITION_MAX = 1_000_000_000;

export interface CpuProfileInspectorSession {
  connect(): void;
  disconnect(): void;
  post(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type CpuProfileInspectorSessionFactory = () =>
  CpuProfileInspectorSession | undefined;

export interface CpuProfileProbeExecutorOptions {
  /** Test seam for the process-global inspector session. */
  createSession?: CpuProfileInspectorSessionFactory;
  /** Test seams for deterministic timer assertions. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export class CpuProfileProbeError extends Error {
  readonly reason:
    | "unsupported inspector"
    | "profile already active"
    | "aborted"
    | "timeout"
    | "profiler stop failed";

  constructor(reason: CpuProfileProbeError["reason"], cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "CpuProfileProbeError";
    this.reason = reason;
  }
}

interface ProfileNode {
  id?: unknown;
  callFrame?: unknown;
}

interface RawCpuProfile {
  nodes?: unknown;
  samples?: unknown;
}

interface Deadline {
  expired: () => boolean;
  promise: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

let activeProfile = false;

function defaultSessionFactory(): CpuProfileInspectorSession | undefined {
  const Session = inspector.Session;
  if (typeof Session !== "function") return undefined;
  try {
    const session = new Session();
    return {
      connect: () => session.connect(),
      disconnect: () => session.disconnect(),
      post: (method, params) =>
        new Promise((resolve, reject) => {
          try {
            session.post(method, params ?? {}, (error, result) => {
              if (error) reject(error);
              else resolve(result);
            });
          } catch (error) {
            reject(error);
          }
        }),
    };
  } catch {
    return undefined;
  }
}

function makeDeadline(setTimeoutImpl: typeof setTimeout): Deadline {
  let expired = false;
  let resolveDeadline!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeadline = resolve;
  });
  const timer = setTimeoutImpl(() => {
    expired = true;
    resolveDeadline();
  }, CPU_PROFILE_DEADLINE_MS);
  return { expired: () => expired, promise, timer };
}

function abortPromise(signal: AbortSignal): {
  promise: Promise<never>;
  remove: () => void;
} {
  let rejectAbort!: (reason: CpuProfileProbeError) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(new CpuProfileProbeError("aborted"));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  promise.catch(() => undefined);
  return {
    promise,
    remove: () => signal.removeEventListener("abort", onAbort),
  };
}

function timeoutPromise(deadline: Deadline): Promise<never> {
  return deadline.promise.then(() => {
    throw new CpuProfileProbeError("timeout");
  });
}

async function postWithGuards(
  session: CpuProfileInspectorSession,
  method: string,
  params: Record<string, unknown> | undefined,
  deadline: Deadline,
  aborted: Promise<never>,
): Promise<unknown> {
  let operation: Promise<unknown>;
  try {
    operation = Promise.resolve(session.post(method, params));
  } catch (error) {
    throw error;
  }
  // A timed out inspector call may still settle after disconnect. Attach a
  // rejection handler before abandoning it so it cannot become an unhandled
  // rejection in the host process.
  operation.catch(() => undefined);
  return Promise.race([operation, timeoutPromise(deadline), aborted]);
}

function profileStartError(error: unknown): CpuProfileProbeError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /already|started|active/i.test(message)
    ? new CpuProfileProbeError("profile already active", error)
    : undefined;
}

function boundedInteger(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return Math.min(max, Math.floor(value));
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function normalizedFunctionName(value: unknown): string {
  const name = boundedString(value, FUNCTION_NAME_MAX_LENGTH);
  if (!name || name === "(anonymous)" || name === "(program)")
    return "(anonymous)";
  if (
    ["(root)", "(idle)", "(garbage collector)"].includes(name) ||
    name.startsWith("internal/") ||
    name.startsWith("node:internal/")
  )
    return "[internal]";
  return name;
}

function normalizedUrl(value: unknown): string | undefined {
  const url = boundedString(value, URL_MAX_LENGTH);
  if (!url) return undefined;
  try {
    return boundedString(
      redactUrl(url, "probe.runtime.cpu_profile.url").value,
      URL_MAX_LENGTH,
    );
  } catch {
    return undefined;
  }
}

function readCallFrame(value: unknown): {
  functionName: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
} {
  const frame =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const lineNumber = boundedInteger(frame.lineNumber, SOURCE_POSITION_MAX);
  const columnNumber = boundedInteger(frame.columnNumber, SOURCE_POSITION_MAX);
  const url = normalizedUrl(frame.url);
  return {
    functionName: normalizedFunctionName(frame.functionName),
    ...(url ? { url } : {}),
    ...(lineNumber !== undefined ? { lineNumber } : {}),
    ...(columnNumber !== undefined ? { columnNumber } : {}),
  };
}

function normalizeProfile(value: unknown): CpuProfileProbeData {
  const profile =
    value && typeof value === "object" ? (value as RawCpuProfile) : undefined;
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : undefined;
  const samples = Array.isArray(profile?.samples) ? profile.samples : undefined;
  if (!nodes || !samples || samples.length === 0)
    throw new Error("empty cpu profile");

  const frames = new Map<number, ReturnType<typeof readCallFrame>>();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const candidate = node as ProfileNode;
    const id = boundedInteger(candidate.id, CPU_PROFILE_MAX_SAMPLE_COUNT);
    if (id === undefined) continue;
    frames.set(id, readCallFrame(candidate.callFrame));
  }

  const rows = new Map<string, CpuProfileFunction>();
  const sampleLimit = Math.min(samples.length, CPU_PROFILE_MAX_SAMPLE_COUNT);
  for (let index = 0; index < sampleLimit; index += 1) {
    const id = boundedInteger(samples[index], CPU_PROFILE_MAX_SAMPLE_COUNT);
    if (id === undefined) continue;
    const frame = frames.get(id) ?? {
      functionName: "(anonymous)",
    };
    const key = [
      frame.functionName,
      frame.url ?? "",
      frame.lineNumber ?? "",
      frame.columnNumber ?? "",
    ].join("\u0000");
    const existing = rows.get(key);
    if (existing) {
      existing.selfSamples = Math.min(
        CPU_PROFILE_MAX_SAMPLE_COUNT,
        existing.selfSamples + 1,
      );
    } else {
      rows.set(key, { ...frame, selfSamples: 1 });
    }
  }

  const topFunctions = [...rows.values()]
    .sort((left, right) => {
      if (right.selfSamples !== left.selfSamples)
        return right.selfSamples - left.selfSamples;
      return left.functionName.localeCompare(right.functionName);
    })
    .slice(0, CPU_PROFILE_MAX_FUNCTIONS);
  if (topFunctions.length === 0) throw new Error("empty cpu profile");

  return {
    durationMs: CPU_PROFILE_DURATION_MS,
    sampleCount: Math.min(samples.length, CPU_PROFILE_MAX_SAMPLE_COUNT),
    topFunctions,
  };
}

/** Test-only reset for the process-global profiler lock. */
export function __resetCpuProfileStateForTests(): void {
  activeProfile = false;
}

/**
 * Create the Node-only executor used by `runtime.cpu_profile`.
 *
 * The returned function has no duration or sampling options. It owns a fresh
 * inspector session, one fixed one-second window, and a two-second hard
 * deadline on every invocation.
 */
export function createCpuProfileProbeExecutor(
  options: CpuProfileProbeExecutorOptions = {},
): CpuProfileProbeExecutor {
  const createSession = options.createSession ?? defaultSessionFactory;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;

  return async (signal: AbortSignal): Promise<CpuProfileProbeData> => {
    if (signal.aborted) throw new CpuProfileProbeError("aborted");
    if (activeProfile) throw new CpuProfileProbeError("profile already active");
    activeProfile = true;

    const deadline = makeDeadline(setTimeoutImpl);
    const aborted = abortPromise(signal);
    let session: CpuProfileInspectorSession | undefined;
    let stopAttempted = false;
    let disableAttempted = false;

    const cleanupPost = async (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<void> => {
      if (!session) return;
      try {
        await postWithGuards(
          session,
          method,
          params,
          deadline,
          aborted.promise,
        );
      } catch {
        // The primary outcome is retained. Cleanup is best effort but every
        // cleanup command is attempted before disconnecting.
      }
    };

    try {
      try {
        session = createSession();
      } catch (error) {
        throw new CpuProfileProbeError("unsupported inspector", error);
      }
      if (
        !session ||
        typeof session.connect !== "function" ||
        typeof session.disconnect !== "function" ||
        typeof session.post !== "function"
      ) {
        throw new CpuProfileProbeError("unsupported inspector");
      }
      try {
        session.connect();
      } catch (error) {
        throw new CpuProfileProbeError("unsupported inspector", error);
      }

      await postWithGuards(
        session,
        "Profiler.enable",
        undefined,
        deadline,
        aborted.promise,
      );

      await postWithGuards(
        session,
        "Profiler.setSamplingInterval",
        { interval: CPU_PROFILE_SAMPLING_INTERVAL_US },
        deadline,
        aborted.promise,
      );

      try {
        await postWithGuards(
          session,
          "Profiler.start",
          undefined,
          deadline,
          aborted.promise,
        );
      } catch (error) {
        throw profileStartError(error) ?? error;
      }

      let windowTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            windowTimer = setTimeoutImpl(resolve, CPU_PROFILE_DURATION_MS);
          }),
          timeoutPromise(deadline),
          aborted.promise,
        ]);
      } finally {
        if (windowTimer !== undefined) clearTimeoutImpl(windowTimer);
      }
      if (deadline.expired()) throw new CpuProfileProbeError("timeout");

      stopAttempted = true;
      let stopped: unknown;
      try {
        stopped = await postWithGuards(
          session,
          "Profiler.stop",
          undefined,
          deadline,
          aborted.promise,
        );
      } catch (error) {
        throw new CpuProfileProbeError("profiler stop failed", error);
      }
      if (deadline.expired()) throw new CpuProfileProbeError("timeout");
      const profile =
        stopped && typeof stopped === "object"
          ? (stopped as Record<string, unknown>).profile
          : undefined;
      return normalizeProfile(profile);
    } finally {
      if (session && !stopAttempted) {
        stopAttempted = true;
        await cleanupPost("Profiler.stop");
      }
      if (session && !disableAttempted) {
        disableAttempted = true;
        await cleanupPost("Profiler.disable");
      }
      aborted.remove();
      clearTimeoutImpl(deadline.timer);
      try {
        session?.disconnect();
      } catch {
        // Disconnect is the last cleanup action and cannot change the result.
      }
      activeProfile = false;
    }
  };
}
