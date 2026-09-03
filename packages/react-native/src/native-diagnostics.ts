import type { Crumbtrail } from "crumbtrail-core";
import {
  isNativeHangEventData,
  NATIVE_HANG_EVENT_KIND,
  type NativeHangEventData,
} from "crumbtrail-core";
import type {
  OptionalModuleResolver,
  ReactNativeCapabilities,
} from "./capabilities";
import type { AsyncStorageLike } from "./session-store";

/** The native module name used by React Native autolinking. */
export const REACT_NATIVE_NATIVE_DIAGNOSTICS_MODULE =
  "CrumbtrailNativeDiagnostics" as const;

/** The event kinds a native bridge may hand to the JavaScript SDK. */
export type ReactNativeNativeDiagnosticKind =
  typeof NATIVE_HANG_EVENT_KIND | "native-crash" | "app-lifecycle";

export interface ReactNativeNativeDiagnosticEvent {
  kind: ReactNativeNativeDiagnosticKind;
  data: Record<string, unknown>;
}

export interface ReactNativeNativeCapabilityDetail {
  supported: boolean;
  enabled: boolean;
  observed: boolean;
}

export interface ReactNativeNativeCapabilities {
  nativeDiagnostics: ReactNativeNativeCapabilityDetail;
  nativeHang: ReactNativeNativeCapabilityDetail;
  nativeCrash: ReactNativeNativeCapabilityDetail;
  appLifecycle: ReactNativeNativeCapabilityDetail;
}

export interface ReactNativeNativeDiagnosticsModule {
  getCapabilities?: () => Promise<unknown> | unknown;
  /** Returns one durable batch. Native retains it until this is acknowledged. */
  drainDiagnostics: () => Promise<unknown> | unknown;
  /** Clears exactly the batch returned by the matching drain. */
  acknowledgeDiagnostics: (token: string) => Promise<boolean> | boolean;
  setEnabled?: (enabled: boolean) => Promise<void> | void;
}

export interface ReactNativeNativeDiagnosticsOptions {
  module?: ReactNativeNativeDiagnosticsModule | null;
  resolver?: OptionalModuleResolver;
  enabled?: boolean;
}

export interface ReactNativeNativeDiagnosticsController {
  cleanup(): Promise<void>;
  modulePresent: boolean;
}

const EMPTY_CAPABILITIES: ReactNativeNativeCapabilities = {
  nativeDiagnostics: { supported: false, enabled: false, observed: false },
  nativeHang: { supported: false, enabled: false, observed: false },
  nativeCrash: { supported: false, enabled: false, observed: false },
  appLifecycle: { supported: false, enabled: false, observed: false },
};

/**
 * Drain the optional native module without making it a required dependency.
 * Missing modules, rejected promises, malformed events, and platform errors
 * are all capture failures. They must never become application failures.
 */
export function startReactNativeNativeDiagnostics(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  options: ReactNativeNativeDiagnosticsOptions = {},
): ReactNativeNativeDiagnosticsController {
  const nativeModule =
    options.module === undefined
      ? resolveNativeDiagnosticsModule(options.resolver)
      : options.module;
  const enabled = options.enabled !== false;

  if (!nativeModule) {
    emitCapabilityEvent(logger, capabilities, EMPTY_CAPABILITIES);
    return { cleanup: async () => {}, modulePresent: false };
  }

  let active = true;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let startup = drainNativeDiagnostics(
    logger,
    capabilities,
    nativeModule,
    enabled,
  ).catch(() => {
    // Native diagnostics are best effort. The native module has no permission
    // to make a host startup or render fail.
  });

  return {
    modulePresent: true,
    async cleanup() {
      active = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      await startup;
      if (typeof nativeModule.setEnabled === "function") {
        try {
          await nativeModule.setEnabled(false);
        } catch {
          // A synchronous teardown failure is also isolated from the host.
        }
      }
    },
  };

  async function drainNativeDiagnostics(
    target: Crumbtrail,
    sdkCapabilities: ReactNativeCapabilities,
    module: ReactNativeNativeDiagnosticsModule,
    shouldEnable: boolean,
  ): Promise<void> {
    if (typeof module.setEnabled === "function") {
      try {
        await module.setEnabled(shouldEnable);
      } catch {
        // An older or partially registered native module may not expose the
        // configuration call. Capability reads still remain useful.
      }
    }
    const reported = await readCapabilities(module);
    if (!active) return;
    emitCapabilityEvent(
      target,
      sdkCapabilities,
      shouldEnable ? reported : disabledCapabilities(reported),
    );

    if (!shouldEnable) return;
    const raw = await module.drainDiagnostics();
    const batch = normalizeNativeDiagnosticBatch(raw);
    if (!active || !batch) return;
    for (const event of batch.events) {
      if (!active) return;
      if (!emitNativeDiagnostic(target, sdkCapabilities, event)) {
        retryTimer = setTimeout(() => {
          if (active) startup = drainNativeDiagnostics(target, sdkCapabilities, module, shouldEnable).catch(() => {});
        }, 1000);
        return;
      }
    }
    if (!batch.events.length || !active) return;
    try {
      if (await module.acknowledgeDiagnostics(batch.token) !== true) return;
    } catch {
      // The native batch remains durable until an explicit acknowledgement.
    }
  }
}

function emitNativeDiagnostic(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  event: ReactNativeNativeDiagnosticEvent,
): boolean {
  try {
    return logger.addEvent({
      type: event.kind,
      data: event.data,
      platform: "react-native",
      sdk: { name: "crumbtrail-react-native" },
      capabilities: capabilities.capabilities,
    });
  } catch {
    return false;
  }
}

/** Alias kept beside the start form for applications that use factory naming. */
export const createReactNativeNativeDiagnostics =
  startReactNativeNativeDiagnostics;

export function createReactNativeWatchdogHandoff(
  storage: AsyncStorageLike | null | undefined,
  key = "@crumbtrail/react-native/native-hang",
): ReactNativeWatchdogHandoff {
  if (!storage) return new MemoryReactNativeWatchdogHandoff();
  let tail = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    deliver(event, accept) {
      return enqueue(async () => {
        const durable = boundedHang(event);
        try {
          await storage.setItem(key, JSON.stringify(durable));
        } catch {
          return false;
        }
        if (!(await safeAccept(accept, durable))) return false;
        return clearStorageIfCurrent(storage, key, JSON.stringify(durable));
      });
    },
    drain(accept) {
      return enqueue(async () => {
        const raw = await storage.getItem(key);
        if (!raw) return false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return false;
        }
        if (!isNativeHangEventData(parsed)) return false;
        const durable = boundedHang(parsed);
        if (!(await safeAccept(accept, { ...durable, previousLaunch: true, recovered: false }))) {
          return false;
        }
        return clearStorageIfCurrent(storage, key, raw);
      });
    },
  };
}

export interface ReactNativeWatchdogHandoff {
  /** Serialize durable write, host acceptance, and compare-and-clear. */
  deliver(
    event: NativeHangEventData,
    accept: (event: NativeHangEventData) => Promise<boolean> | boolean,
  ): Promise<boolean>;
  /** Serialize previous-launch read, host acceptance, and compare-and-clear. */
  drain(
    accept: (event: NativeHangEventData) => Promise<boolean> | boolean,
  ): Promise<boolean>;
}

class MemoryReactNativeWatchdogHandoff implements ReactNativeWatchdogHandoff {
  private pending: NativeHangEventData | undefined;
  private tail = Promise.resolve();

  deliver(
    event: NativeHangEventData,
    accept: (event: NativeHangEventData) => Promise<boolean> | boolean,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const durable = boundedHang(event);
      this.pending = durable;
      if (!(await safeAccept(accept, durable))) return false;
      if (!sameHang(this.pending, durable)) return false;
      this.pending = undefined;
      return true;
    });
  }

  drain(
    accept: (event: NativeHangEventData) => Promise<boolean> | boolean,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const durable = this.pending;
      if (!durable) return false;
      const previous = { ...durable, previousLaunch: true, recovered: false };
      if (!(await safeAccept(accept, previous))) return false;
      if (!sameHang(this.pending, durable)) return false;
      this.pending = undefined;
      return true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function boundedHang(event: NativeHangEventData): NativeHangEventData {
  return {
    source: event.source,
    thresholdMs: event.thresholdMs,
    observedDurationMs: event.observedDurationMs,
    recovered: event.recovered,
    previousLaunch: event.previousLaunch,
    ...(event.stk ? { stk: event.stk.slice(0, 8192) } : {}),
  };
}

async function safeAccept(
  accept: (event: NativeHangEventData) => Promise<boolean> | boolean,
  event: NativeHangEventData,
): Promise<boolean> {
  try {
    return (await accept(event)) === true;
  } catch {
    return false;
  }
}

async function clearStorageIfCurrent(
  storage: AsyncStorageLike,
  key: string,
  expectedRaw: string,
): Promise<boolean> {
  try {
    if ((await storage.getItem(key)) !== expectedRaw) return false;
    await storage.setItem(key, "");
    return true;
  } catch {
    return false;
  }
}

function disabledCapabilities(
  capabilities: ReactNativeNativeCapabilities,
): ReactNativeNativeCapabilities {
  return Object.fromEntries(
    Object.entries(capabilities).map(([key, detail]) => [
      key,
      { ...detail, enabled: false },
    ]),
  ) as ReactNativeNativeCapabilities;
}

function sameHang(
  left: NativeHangEventData | undefined,
  right: NativeHangEventData,
): boolean {
  return (
    left?.source === right.source &&
    left.thresholdMs === right.thresholdMs &&
    left.observedDurationMs === right.observedDurationMs &&
    left.recovered === right.recovered &&
    left.previousLaunch === right.previousLaunch &&
    left.stk === right.stk
  );
}

async function readCapabilities(
  module: ReactNativeNativeDiagnosticsModule,
): Promise<ReactNativeNativeCapabilities> {
  if (typeof module.getCapabilities !== "function") {
    return EMPTY_CAPABILITIES;
  }
  try {
    return normalizeCapabilities(await module.getCapabilities());
  } catch {
    return EMPTY_CAPABILITIES;
  }
}

function normalizeCapabilities(value: unknown): ReactNativeNativeCapabilities {
  const record = asRecord(value);
  const detail = (key: string): ReactNativeNativeCapabilityDetail => {
    const candidate = asRecord(record?.[key]);
    return {
      supported: candidate?.supported === true,
      enabled: candidate?.enabled === true,
      observed: candidate?.observed === true,
    };
  };
  return {
    nativeDiagnostics: detail("nativeDiagnostics"),
    nativeHang: detail("nativeHang"),
    nativeCrash: detail("nativeCrash"),
    appLifecycle: detail("appLifecycle"),
  };
}

function emitCapabilityEvent(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  native: ReactNativeNativeCapabilities,
): void {
  logger.addEvent({
    type: "rn.native-capabilities",
    data: { native },
    platform: "react-native",
    sdk: { name: "crumbtrail-react-native" },
    capabilities: capabilities.capabilities,
  });
}

function normalizeNativeDiagnosticBatch(
  value: unknown,
): { token: string; events: ReactNativeNativeDiagnosticEvent[] } | undefined {
  const record = asRecord(value);
  if (!record || typeof record.token !== "string" || !Array.isArray(record.events)) {
    return undefined;
  }
  const events = record.events.map(normalizeNativeDiagnostic);
  if (events.some((event) => !event)) return undefined;
  if (events.length > 0 && record.token.length === 0) return undefined;
  return {
    token: record.token,
    events: events as ReactNativeNativeDiagnosticEvent[],
  };
}

function normalizeNativeDiagnostic(
  value: unknown,
): ReactNativeNativeDiagnosticEvent | undefined {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string") return undefined;
  if (
    record.kind !== NATIVE_HANG_EVENT_KIND &&
    record.kind !== "native-crash" &&
    record.kind !== "app-lifecycle"
  ) {
    return undefined;
  }
  const data = asRecord(record.data);
  if (!data) return undefined;
  if (record.kind === NATIVE_HANG_EVENT_KIND && !isNativeHangEventData(data)) {
    return undefined;
  }
  const bounded = boundedRecord(data);
  // A drain happens during the next launch. Native watchdog evidence is
  // therefore prior-launch evidence even when the native process recorded it
  // with its live-process defaults.
  if (record.kind === NATIVE_HANG_EVENT_KIND) {
    return {
      kind: record.kind as ReactNativeNativeDiagnosticKind,
      data: {
        ...bounded,
        recovered: false,
        previousLaunch: true,
      },
    };
  }
  return {
    kind: record.kind as ReactNativeNativeDiagnosticKind,
    data: bounded,
  };
}

function resolveNativeDiagnosticsModule(
  resolver?: OptionalModuleResolver,
): ReactNativeNativeDiagnosticsModule | undefined {
  const resolve = resolver ?? safeRequireOptionalModule;
  try {
    const reactNative = resolve("react-native") as
      { NativeModules?: Record<string, unknown> } | undefined;
    const nativeModule =
      reactNative?.NativeModules?.[REACT_NATIVE_NATIVE_DIAGNOSTICS_MODULE];
    return isNativeDiagnosticsModule(nativeModule) ? nativeModule : undefined;
  } catch {
    return undefined;
  }
}

function isNativeDiagnosticsModule(
  value: unknown,
): value is ReactNativeNativeDiagnosticsModule {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.drainDiagnostics === "function" &&
    typeof record.acknowledgeDiagnostics === "function"
  );
}

function safeRequireOptionalModule(packageName: string): unknown {
  try {
    const requireFn = Function(
      'return typeof require === "function" ? require : undefined',
    )() as ((name: string) => unknown) | undefined;
    return requireFn?.(packageName);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value).slice(0, 32)) {
    if (key.length > 64) continue;
    if (typeof candidate === "string") result[key] = candidate.slice(0, 8192);
    else if (typeof candidate === "number" && Number.isFinite(candidate)) {
      result[key] = candidate;
    } else if (typeof candidate === "boolean") result[key] = candidate;
  }
  return result;
}
