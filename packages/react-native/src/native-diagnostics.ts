import type { Crumbtrail } from "crumbtrail-core";
import {
  isNativeHangEventData,
  NATIVE_HANG_EVENT_KIND,
  type NativeHangEventData,
} from "crumbtrail-core";
import type { OptionalModuleResolver, ReactNativeCapabilities } from "./capabilities";
import type { AsyncStorageLike } from "./session-store";

/** The native module name used by React Native autolinking. */
export const REACT_NATIVE_NATIVE_DIAGNOSTICS_MODULE =
  "CrumbtrailNativeDiagnostics" as const;

/** The event kinds a native bridge may hand to the JavaScript SDK. */
export type ReactNativeNativeDiagnosticKind =
  | typeof NATIVE_HANG_EVENT_KIND
  | "native-crash"
  | "app-lifecycle";

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
  drainDiagnostics?: () => Promise<unknown> | unknown;
}

export interface ReactNativeNativeDiagnosticsOptions {
  module?: ReactNativeNativeDiagnosticsModule | null;
  resolver?: OptionalModuleResolver;
  enabled?: boolean;
}

export interface ReactNativeNativeDiagnosticsController {
  cleanup(): void;
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

  if (!enabled || !nativeModule) {
    emitCapabilityEvent(logger, capabilities, EMPTY_CAPABILITIES);
    return { cleanup() {}, modulePresent: false };
  }

  let active = true;
  void drainNativeDiagnostics(logger, capabilities, nativeModule).catch(() => {
    // Native diagnostics are best effort. The native module has no permission
    // to make a host startup or render fail.
  });

  return {
    modulePresent: true,
    cleanup() {
      active = false;
    },
  };

  async function drainNativeDiagnostics(
    target: Crumbtrail,
    sdkCapabilities: ReactNativeCapabilities,
    module: ReactNativeNativeDiagnosticsModule,
  ): Promise<void> {
    const reported = await readCapabilities(module);
    if (!active) return;
    emitCapabilityEvent(target, sdkCapabilities, reported);

    if (typeof module.drainDiagnostics !== "function") return;
    const raw = await module.drainDiagnostics();
    if (!active || !Array.isArray(raw)) return;
    for (const candidate of raw) {
      const event = normalizeNativeDiagnostic(candidate);
      if (!event) continue;
      target.addEvent({
        type: event.kind,
        data: event.data,
        platform: "react-native",
        sdk: { name: "crumbtrail-react-native" },
        capabilities: sdkCapabilities.capabilities,
      });
    }
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
  return {
    async read() {
      try {
        const raw = await storage.getItem(key);
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return isNativeHangEventData(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    async write(event) {
      try {
        await storage.setItem(key, JSON.stringify(event));
      } catch {
        // Handoff loss is reported by the next native or JS event, not thrown.
      }
    },
    async clear() {
      // AsyncStorageLike intentionally has no removeItem in the public peer
      // contract. Writing an empty value is compatible with the narrow seam.
      try {
        await storage.setItem(key, "");
      } catch {
        // Best effort only.
      }
    },
  };
}

export interface ReactNativeWatchdogHandoff {
  read(): Promise<NativeHangEventData | undefined> | NativeHangEventData | undefined;
  write(event: NativeHangEventData): Promise<void> | void;
  clear(): Promise<void> | void;
}

class MemoryReactNativeWatchdogHandoff implements ReactNativeWatchdogHandoff {
  private pending: NativeHangEventData | undefined;

  read(): NativeHangEventData | undefined {
    return this.pending;
  }

  write(event: NativeHangEventData): void {
    this.pending = event;
  }

  clear(): void {
    this.pending = undefined;
  }
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
      | { NativeModules?: Record<string, unknown> }
      | undefined;
    const nativeModule = reactNative?.NativeModules?.[
      REACT_NATIVE_NATIVE_DIAGNOSTICS_MODULE
    ];
    return isNativeDiagnosticsModule(nativeModule) ? nativeModule : undefined;
  } catch {
    return undefined;
  }
}

function isNativeDiagnosticsModule(
  value: unknown,
): value is ReactNativeNativeDiagnosticsModule {
  return asRecord(value) !== undefined;
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

function boundedRecord(value: Record<string, unknown>): Record<string, unknown> {
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
