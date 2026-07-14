import type { Crumbtrail, TargetDescriptor } from "crumbtrail-core";
import {
  createReactNativeReplayLite,
  type ReactNativeReplayLiteController,
  type ReactNativeViewShotModule,
} from "./replay-lite";
import type {
  OptionalModuleResolver,
  ReactNativeCapabilities,
} from "./capabilities";

export type ReactNativeCollectorName =
  | "console"
  | "errors"
  | "network"
  | "appState"
  | "environment"
  | "navigation"
  | "replayLite";

export type ReactNativeCollectorConfig =
  | boolean
  | Partial<Record<ReactNativeCollectorName, boolean>>;

export interface ReactNativeAppStateModule {
  currentState?: string;
  addEventListener?: (
    type: string,
    listener: (state: string) => void,
  ) => { remove?: () => void } | (() => void);
}

export interface ReactNativePlatformModule {
  OS?: string;
  Version?: string | number;
  constants?: Record<string, unknown>;
}

export interface ReactNativeDimensionsModule {
  get?: (dimension: "window" | "screen") => {
    width?: number;
    height?: number;
    scale?: number;
    fontScale?: number;
  };
  addEventListener?: (
    type: string,
    listener: (event: Record<string, unknown>) => void,
  ) => { remove?: () => void } | (() => void);
}

export interface ReactNativeModule {
  AppState?: ReactNativeAppStateModule;
  Platform?: ReactNativePlatformModule;
  Dimensions?: ReactNativeDimensionsModule;
}

export interface ReactNativeNavigationLike {
  getCurrentRoute?: () =>
    | { name?: string; path?: string; key?: string }
    | undefined;
  addListener?: (
    event: string,
    listener: () => void,
  ) => (() => void) | { remove?: () => void };
}

export interface ReactNativeErrorUtilsLike {
  getGlobalHandler?: () =>
    | ((error: unknown, isFatal?: boolean) => void)
    | undefined;
  setGlobalHandler?: (
    handler: (error: unknown, isFatal?: boolean) => void,
  ) => void;
}

export interface ReactNativeCollectorRuntime {
  globalObject?: typeof globalThis & Record<string, unknown>;
  reactNative?: ReactNativeModule | null;
  navigation?: ReactNativeNavigationLike | null;
  errorUtils?: ReactNativeErrorUtilsLike | null;
}

export interface StartReactNativeCollectorsOptions extends ReactNativeCollectorRuntime {
  config?: ReactNativeCollectorConfig;
  capabilities: ReactNativeCapabilities;
  resolver?: OptionalModuleResolver;
}

export interface ReactNativeCollectorController {
  cleanup(): void;
  replayLite?: ReactNativeReplayLiteController;
}

const DEFAULT_COLLECTORS: Record<ReactNativeCollectorName, boolean> = {
  console: true,
  errors: true,
  network: true,
  appState: true,
  environment: true,
  navigation: true,
  replayLite: true,
};

type Cleanup = () => void;

export function startReactNativeCollectors(
  logger: Crumbtrail,
  options: StartReactNativeCollectorsOptions,
): ReactNativeCollectorController {
  const enabled = resolveCollectorConfig(options.config);
  const globalObject =
    options.globalObject ??
    (globalThis as typeof globalThis & Record<string, unknown>);
  const reactNative =
    options.reactNative ??
    resolveModule<ReactNativeModule>("react-native", options.resolver);
  const cleanup: Cleanup[] = [];

  if (enabled.console)
    cleanup.push(
      startConsoleCollector(logger, options.capabilities, globalObject),
    );
  if (enabled.errors)
    cleanup.push(
      startErrorCollector(
        logger,
        options.capabilities,
        globalObject,
        options.errorUtils,
      ),
    );
  if (enabled.network)
    cleanup.push(
      startNetworkCollector(logger, options.capabilities, globalObject),
    );
  if (enabled.appState)
    cleanup.push(
      startAppStateCollector(
        logger,
        options.capabilities,
        reactNative?.AppState,
      ),
    );
  if (enabled.environment)
    startEnvironmentCollector(logger, options.capabilities, reactNative);
  if (enabled.navigation)
    cleanup.push(
      startNavigationCollector(
        logger,
        options.capabilities,
        options.navigation,
      ),
    );

  const viewShot = resolveModule<ReactNativeViewShotModule>(
    "react-native-view-shot",
    options.resolver,
  );
  const replayLite = enabled.replayLite
    ? createReactNativeReplayLite({
        logger,
        capabilities: options.capabilities.capabilities,
        viewShot,
      })
    : undefined;

  return {
    cleanup() {
      for (const stop of cleanup.splice(0).reverse()) stop();
    },
    replayLite,
  };
}

function resolveCollectorConfig(
  config: ReactNativeCollectorConfig | undefined,
): Record<ReactNativeCollectorName, boolean> {
  if (config === false) {
    return Object.fromEntries(
      Object.keys(DEFAULT_COLLECTORS).map((key) => [key, false]),
    ) as Record<ReactNativeCollectorName, boolean>;
  }
  if (config === true || config === undefined) return { ...DEFAULT_COLLECTORS };
  return { ...DEFAULT_COLLECTORS, ...config };
}

function emit(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  type: string,
  data: Record<string, unknown>,
  target?: TargetDescriptor,
): void {
  logger.addEvent({
    type,
    data,
    platform: "react-native",
    sdk: { name: "crumbtrail-react-native" },
    capabilities: capabilities.capabilities,
    ...(target ? { target } : {}),
  });
}

function startConsoleCollector(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  globalObject: typeof globalThis & Record<string, unknown>,
): Cleanup {
  const consoleObject = globalObject.console;
  if (!consoleObject) return () => {};
  const mutableConsole = consoleObject as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  const methods = ["log", "warn", "error", "debug", "info"] as const;
  const originals = new Map<string, (...args: unknown[]) => void>();
  const level: Record<string, string> = {
    log: "log",
    warn: "warn",
    error: "err",
    debug: "dbg",
    info: "info",
  };

  for (const method of methods) {
    if (typeof mutableConsole[method] !== "function") continue;
    const original = mutableConsole[method].bind(consoleObject);
    originals.set(method, original);
    mutableConsole[method] = (...args: unknown[]) => {
      emit(logger, capabilities, "con", {
        lv: level[method],
        args: args.map((arg) => safeStringify(arg)),
      });
      original(...args);
    };
  }

  return () => {
    for (const [method, original] of originals) {
      mutableConsole[method] = original;
    }
  };
}

function startErrorCollector(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  globalObject: typeof globalThis & Record<string, unknown>,
  suppliedErrorUtils?: ReactNativeErrorUtilsLike | null,
): Cleanup {
  const cleanup: Cleanup[] = [];
  const errorUtils =
    suppliedErrorUtils ??
    (globalObject.ErrorUtils as ReactNativeErrorUtilsLike | undefined);
  if (errorUtils?.setGlobalHandler && errorUtils.getGlobalHandler) {
    const previous = errorUtils.getGlobalHandler();
    if (typeof previous !== "function") return () => {};
    errorUtils.setGlobalHandler((error, isFatal) => {
      emit(logger, capabilities, "err", {
        msg: error instanceof Error ? error.message : String(error),
        stk: error instanceof Error ? error.stack : undefined,
        fatal: Boolean(isFatal),
        source: "react-native-global-handler",
      });
      previous?.(error, isFatal);
    });
    cleanup.push(() => {
      if (previous) errorUtils.setGlobalHandler?.(previous);
    });
  }

  const addEventListener = globalObject.addEventListener as
    | undefined
    | ((type: string, listener: (event: { reason?: unknown }) => void) => void);
  const removeEventListener = globalObject.removeEventListener as
    | undefined
    | ((type: string, listener: (event: { reason?: unknown }) => void) => void);
  if (addEventListener && removeEventListener) {
    const onUnhandledRejection = (event: { reason?: unknown }) => {
      const reason = event.reason;
      emit(logger, capabilities, "rej", {
        msg: reason instanceof Error ? reason.message : String(reason),
        stk: reason instanceof Error ? reason.stack : undefined,
        source: "react-native-unhandled-rejection",
      });
    };
    addEventListener.call(
      globalObject,
      "unhandledrejection",
      onUnhandledRejection,
    );
    cleanup.push(() =>
      removeEventListener.call(
        globalObject,
        "unhandledrejection",
        onUnhandledRejection,
      ),
    );
  }

  return () => {
    for (const stop of cleanup.reverse()) stop();
  };
}

function startNetworkCollector(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  globalObject: typeof globalThis & Record<string, unknown>,
): Cleanup {
  const cleanup: Cleanup[] = [];
  const originalFetch = globalObject.fetch as typeof fetch | undefined;
  if (typeof originalFetch === "function") {
    globalObject.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const startedAt = Date.now();
      const method = init?.method?.toUpperCase() ?? "GET";
      const url = extractUrl(input);
      try {
        const response = await originalFetch(input, init);
        emit(logger, capabilities, "net", {
          url,
          method,
          status: response.status,
          ok: response.ok,
          dur: Date.now() - startedAt,
          source: "fetch",
        });
        return response;
      } catch (error) {
        emit(logger, capabilities, "net", {
          url,
          method,
          error: error instanceof Error ? error.message : String(error),
          dur: Date.now() - startedAt,
          source: "fetch",
        });
        throw error;
      }
    }) as typeof fetch;
    cleanup.push(() => {
      globalObject.fetch = originalFetch;
    });
  }

  const Xhr = globalObject.XMLHttpRequest as unknown as
    | undefined
    | { prototype?: Record<string, unknown> };
  if (Xhr?.prototype) {
    const originalOpen = Xhr.prototype.open as
      | undefined
      | ((method: string, url: string, ...rest: unknown[]) => unknown);
    const originalSend = Xhr.prototype.send as
      | undefined
      | ((body?: unknown) => unknown);
    if (
      typeof originalOpen === "function" &&
      typeof originalSend === "function"
    ) {
      Xhr.prototype.open = function open(
        this: Record<string, unknown>,
        method: string,
        url: string,
        ...rest: unknown[]
      ) {
        this.__crumbtrailNetwork = { method, url };
        return originalOpen.call(this, method, url, ...rest);
      };
      Xhr.prototype.send = function send(
        this: Record<string, unknown>,
        body?: unknown,
      ) {
        const startedAt = Date.now();
        const info = this.__crumbtrailNetwork as
          | { method?: string; url?: string }
          | undefined;
        const previous = this.onreadystatechange as undefined | (() => void);
        this.onreadystatechange = () => {
          if (this.readyState === 4) {
            emit(logger, capabilities, "net", {
              url: info?.url,
              method: info?.method?.toUpperCase(),
              status: this.status,
              dur: Date.now() - startedAt,
              source: "xmlhttprequest",
            });
          }
          previous?.call(this);
        };
        return originalSend.call(this, body);
      };
      cleanup.push(() => {
        Xhr.prototype!.open = originalOpen;
        Xhr.prototype!.send = originalSend;
      });
    }
  }

  return () => {
    for (const stop of cleanup.reverse()) stop();
  };
}

function startAppStateCollector(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  appState?: ReactNativeAppStateModule,
): Cleanup {
  if (!appState?.addEventListener) return () => {};
  const subscription = appState.addEventListener("change", (state) => {
    emit(logger, capabilities, "app-lifecycle", { state, source: "AppState" });
  });
  emit(logger, capabilities, "app-lifecycle", {
    state: appState.currentState,
    source: "AppState",
    kind: "initial",
  });
  return toCleanup(subscription);
}

function startEnvironmentCollector(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  reactNative?: ReactNativeModule | null,
): void {
  const window = reactNative?.Dimensions?.get?.("window");
  emit(logger, capabilities, "env", {
    kind: "snapshot",
    platform: {
      os: reactNative?.Platform?.OS,
      version: reactNative?.Platform?.Version,
      constants: reactNative?.Platform?.constants,
    },
    viewport: window
      ? {
          w: window.width,
          h: window.height,
          scale: window.scale,
          fontScale: window.fontScale,
        }
      : undefined,
  });
}

function startNavigationCollector(
  logger: Crumbtrail,
  capabilities: ReactNativeCapabilities,
  navigation?: ReactNativeNavigationLike | null,
): Cleanup {
  if (!navigation?.addListener) return () => {};
  let previousRouteKey: string | undefined;
  const emitCurrentRoute = () => {
    const route = navigation.getCurrentRoute?.();
    if (!route || route.key === previousRouteKey) return;
    previousRouteKey = route.key;
    emit(logger, capabilities, "navigation", {
      name: route.name,
      path: route.path,
      key: route.key,
    });
  };
  const subscription = navigation.addListener("state", emitCurrentRoute);
  emitCurrentRoute();
  return toCleanup(subscription);
}

function resolveModule<T>(
  packageName: string,
  resolver?: OptionalModuleResolver,
): T | undefined {
  if (!resolver) return undefined;
  try {
    return resolver(packageName) as T | undefined;
  } catch {
    return undefined;
  }
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request)
    return input.url;
  return String(input);
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toCleanup(
  subscription: { remove?: () => void } | (() => void) | undefined,
): Cleanup {
  if (typeof subscription === "function") return subscription;
  if (subscription?.remove) return () => subscription.remove?.();
  return () => {};
}
