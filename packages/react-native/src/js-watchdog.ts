import type { Crumbtrail } from "crumbtrail-core";
import {
  isNativeHangEventData,
  NATIVE_HANG_EVENT_KIND,
  NATIVE_HANG_MAX_DURATION_MS,
  type NativeHangEventData,
} from "crumbtrail-core";
import type { ReactNativeAppStateModule } from "./collectors";
import type { ReactNativeCapabilities } from "./capabilities";
import type { ReactNativeWatchdogHandoff } from "./native-diagnostics";

export interface ReactNativeJsWatchdogOptions {
  appState?: ReactNativeAppStateModule | null;
  globalObject?: typeof globalThis & Record<string, unknown>;
  capabilities: ReactNativeCapabilities;
  thresholdMs?: number;
  checkIntervalMs?: number;
  now?: () => number;
  handoff?: ReactNativeWatchdogHandoff;
  suppressInDev?: boolean;
  debuggerAttached?: () => boolean;
}

export interface ReactNativeJsWatchdogController {
  cleanup(): void;
  pause(): void;
  resume(): void;
}

const DEFAULT_THRESHOLD_MS = 5_000;
const DEFAULT_CHECK_INTERVAL_MS = 1_000;

/**
 * Detect a blocked React Native JavaScript event loop with a timer that is
 * checked after the loop gets a chance to run again. It records only recovered
 * observations in this launch. A native main-thread watchdog remains the
 * source for a process killed while the JS loop was blocked.
 */
export function startReactNativeJsWatchdog(
  logger: Crumbtrail,
  options: ReactNativeJsWatchdogOptions,
): ReactNativeJsWatchdogController {
  const globalObject =
    options.globalObject ??
    (globalThis as typeof globalThis & Record<string, unknown>);
  const now = options.now ?? (() => monotonicNow(globalObject));
  const thresholdMs = clampDuration(
    options.thresholdMs ?? DEFAULT_THRESHOLD_MS,
  );
  const checkIntervalMs = Math.max(
    100,
    Math.min(
      NATIVE_HANG_MAX_DURATION_MS,
      Math.floor(options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS),
    ),
  );
  const timer = globalObject.setInterval?.bind(globalObject) ?? setInterval;
  const clearTimer =
    globalObject.clearInterval?.bind(globalObject) ?? clearInterval;
  const debuggerAttached =
    options.debuggerAttached ?? (() => isDebuggerAttached(globalObject));
  const suppressInDev = options.suppressInDev ?? true;
  const isSuppressed = () =>
    debuggerAttached() || (suppressInDev && globalObject.__DEV__ === true);

  let foreground = options.appState?.currentState
    ? options.appState.currentState === "active"
    : true;
  let lastTickAt = now();
  let reportedForBlock = false;
  let stopped = false;
  let timerId: ReturnType<typeof setInterval> | undefined;

  const pending = safeCall(() => options.handoff?.read());
  void Promise.resolve(pending).then(async (event) => {
    if (!event || stopped || !isNativeHangEventData(event)) return;
    emit(logger, options.capabilities, {
      ...event,
      previousLaunch: true,
      recovered: false,
    });
    await clearHandoff(options.handoff, event);
  });

  const onState = (state: string) => {
    if (state === "active") resume();
    else pause();
  };
  const subscription = options.appState?.addEventListener?.("change", onState);

  function tick(): void {
    const current = now();
    const elapsed = Math.max(0, current - lastTickAt);
    lastTickAt = current;
    if (!foreground || isSuppressed()) {
      reportedForBlock = false;
      return;
    }
    const blockedFor = elapsed - checkIntervalMs;
    if (blockedFor < thresholdMs || reportedForBlock) return;
    reportedForBlock = true;
    const event: NativeHangEventData = {
      source: "js",
      thresholdMs,
      observedDurationMs: clampDuration(blockedFor),
      recovered: true,
      previousLaunch: false,
    };
    void persistAndEmit(event);
  }

  async function persistAndEmit(event: NativeHangEventData): Promise<void> {
    let persisted = false;
    if (options.handoff) {
      try {
        await options.handoff.write(event);
        persisted = true;
      } catch {
        // A storage failure must not suppress an in-memory observation.
      }
    }
    emit(logger, options.capabilities, event);
    if (persisted) await clearHandoff(options.handoff, event);
  }

  function pause(): void {
    foreground = false;
    reportedForBlock = false;
    lastTickAt = now();
  }

  function resume(): void {
    foreground = true;
    reportedForBlock = false;
    lastTickAt = now();
  }

  function cleanup(): void {
    if (stopped) return;
    stopped = true;
    if (timerId !== undefined) clearTimer(timerId);
    toCleanup(subscription)();
  }

  // Keep checking while suppressed so a debugger attached at startup can be
  // detached later without requiring a second SDK start.
  timerId = timer(tick, checkIntervalMs);

  return { cleanup, pause, resume };
}

function emit(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  data: NativeHangEventData,
): void {
  logger.addEvent({
    type: NATIVE_HANG_EVENT_KIND,
    data: { ...data },
    platform: "react-native",
    sdk: { name: "crumbtrail-react-native" },
    capabilities: capabilities.capabilities,
  });
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD_MS;
  return Math.max(1, Math.min(NATIVE_HANG_MAX_DURATION_MS, Math.floor(value)));
}

function monotonicNow(
  globalObject: typeof globalThis & Record<string, unknown>,
): number {
  const performanceObject = globalObject.performance as
    { now?: () => number } | undefined;
  try {
    if (typeof performanceObject?.now === "function") {
      return performanceObject.now.call(performanceObject);
    }
  } catch {
    // Fall through to the platform clock when the runtime exposes no usable
    // monotonic clock.
  }
  return Date.now();
}

async function clearHandoff(
  handoff: ReactNativeWatchdogHandoff | undefined,
  expected: NativeHangEventData,
): Promise<void> {
  if (!handoff) return;
  try {
    await handoff.clear(expected);
  } catch {
    // A failed clear leaves the handoff for the next launch.
  }
}

function isDebuggerAttached(
  globalObject: typeof globalThis & Record<string, unknown>,
): boolean {
  return (
    globalObject.__REMOTEDEV__ === true ||
    globalObject.__RN_DEBUG__ === true ||
    globalObject.__CRUMBTRAIL_DEBUGGER__ === true
  );
}

function toCleanup(
  subscription: { remove?: () => void } | (() => void) | undefined,
): () => void {
  if (typeof subscription === "function") return subscription;
  return subscription?.remove ? () => subscription.remove?.() : () => {};
}

function safeCall<T>(call: () => T): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
