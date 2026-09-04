import type {
  Crumbtrail,
  RedactionMetadata,
  TargetDescriptor,
} from "crumbtrail-core";
import {
  MOBILE_ERROR_MESSAGE_MAX_LENGTH,
  MOBILE_ERROR_STACK_MAX_LENGTH,
  attachMobileRedaction,
  redactMobileText,
  redactMobileUrl,
} from "./redaction-plane";
import type { MobileRedactedText } from "./redaction-plane";
import {
  createReactNativeReplayLite,
  type ReactNativeReplayLiteController,
  type ReactNativeViewShotModule,
} from "./replay-lite";
import type {
  OptionalModuleResolver,
  ReactNativeCapabilities,
} from "./capabilities";
import {
  startReactNativeNativeDiagnostics,
  type ReactNativeNativeDiagnosticsController,
  type ReactNativeNativeDiagnosticsModule,
  type ReactNativeWatchdogHandoff,
} from "./native-diagnostics";
import {
  startReactNativeJsWatchdog,
  type ReactNativeJsWatchdogController,
} from "./js-watchdog";

export type ReactNativeCollectorName =
  | "console"
  | "errors"
  | "network"
  | "appState"
  | "environment"
  | "navigation"
  | "replayLite"
  | "nativeDiagnostics"
  | "jsWatchdog";

export type ReactNativeCollectorConfig =
  boolean | Partial<Record<ReactNativeCollectorName, boolean>>;

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
    { name?: string; path?: string; key?: string } | undefined;
  addListener?: (
    event: string,
    listener: () => void,
  ) => (() => void) | { remove?: () => void };
}

export interface ReactNativeErrorUtilsLike {
  getGlobalHandler?: () =>
    ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (
    handler: (error: unknown, isFatal?: boolean) => void,
  ) => void;
}

export interface ReactNativeCollectorRuntime {
  globalObject?: typeof globalThis & Record<string, unknown>;
  reactNative?: ReactNativeModule | null;
  navigation?: ReactNativeNavigationLike | null;
  errorUtils?: ReactNativeErrorUtilsLike | null;
  nativeDiagnostics?: ReactNativeNativeDiagnosticsModule | null;
  watchdogHandoff?: ReactNativeWatchdogHandoff;
}

export interface StartReactNativeCollectorsOptions extends ReactNativeCollectorRuntime {
  config?: ReactNativeCollectorConfig;
  capabilities: ReactNativeCapabilities;
  resolver?: OptionalModuleResolver;
  nativeDiagnosticsEnabled?: boolean;
  jsWatchdogEnabled?: boolean;
}

export interface ReactNativeCollectorController {
  cleanup(): Promise<void>;
  replayLite?: ReactNativeReplayLiteController;
  nativeDiagnostics?: ReactNativeNativeDiagnosticsController;
  jsWatchdog?: ReactNativeJsWatchdogController;
}

const DEFAULT_COLLECTORS: Record<ReactNativeCollectorName, boolean> = {
  console: true,
  errors: true,
  network: true,
  appState: true,
  environment: true,
  navigation: true,
  replayLite: true,
  nativeDiagnostics: true,
  jsWatchdog: true,
};

type Cleanup = () => void | Promise<void>;

export function startReactNativeCollectors(
  logger: Crumbtrail,
  options: StartReactNativeCollectorsOptions,
): ReactNativeCollectorController {
  const enabled = resolveReactNativeCollectorConfig(options.config);
  const globalObject =
    options.globalObject ??
    (globalThis as typeof globalThis & Record<string, unknown>);
  const reactNative =
    options.reactNative ??
    resolveModule<ReactNativeModule>("react-native", options.resolver);
  const cleanup: Cleanup[] = [];

  const jsWatchdog = enabledJsWatchdog(options)
    ? startReactNativeJsWatchdog(logger, {
        globalObject,
        capabilities: options.capabilities,
        handoff: options.watchdogHandoff,
        appState: reactNative?.AppState,
      })
    : undefined;

  // No console collector here. `crumbtrail-core`'s own patches `globalThis.console`
  // and needs no DOM, so it runs on React Native already; a second one captured
  // every line twice, and its copy was the unredacted one. `logger.ts` maps the
  // `console` collector switch onto core's config so the knob still works.
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

  const nativeDiagnostics = startReactNativeNativeDiagnostics(
    logger,
    options.capabilities,
    {
      module: options.nativeDiagnostics,
      resolver: options.resolver,
      enabled:
        enabled.nativeDiagnostics && options.nativeDiagnosticsEnabled !== false,
    },
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
    async cleanup() {
      const jsCleanup = jsWatchdog?.cleanup();
      const nativeDiagnosticsCleanup = nativeDiagnostics?.cleanup();
      for (const stop of cleanup.splice(0).reverse()) await stop();
      await jsCleanup;
      await nativeDiagnosticsCleanup;
    },
    replayLite,
    nativeDiagnostics,
    jsWatchdog,
  };
}

export function resolveReactNativeCollectorConfig(
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
      emit(
        logger,
        capabilities,
        "err",
        redactedErrorData(error, {
          fatal: Boolean(isFatal),
          source: "react-native-global-handler",
        }),
      );
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
      emit(
        logger,
        capabilities,
        "rej",
        redactedErrorData(event.reason, {
          source: "react-native-unhandled-rejection",
        }),
      );
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
      const startedAt = monotonicNow(globalObject);
      const method = init?.method?.toUpperCase() ?? "GET";
      const url = redactMobileUrl(extractUrl(input));
      try {
        const response = await originalFetch(input, init);
        emit(
          logger,
          capabilities,
          "net",
          networkData(url, {
            method,
            status: response.status,
            ok: response.ok,
            dur: Math.max(0, monotonicNow(globalObject) - startedAt),
            source: "fetch",
          }),
        );
        return response;
      } catch (error) {
        const message = redactMobileText(
          error instanceof Error ? error.message : String(error),
          "error",
          MOBILE_ERROR_MESSAGE_MAX_LENGTH,
        );
        emit(
          logger,
          capabilities,
          "net",
          networkData(
            url,
            {
              method,
              error: message?.value,
              dur: Math.max(0, monotonicNow(globalObject) - startedAt),
              source: "fetch",
            },
            message?.metadata,
          ),
        );
        throw error;
      }
    }) as typeof fetch;
    cleanup.push(() => {
      globalObject.fetch = originalFetch;
    });
  }

  const Xhr = globalObject.XMLHttpRequest as unknown as
    undefined | { prototype?: Record<string, unknown> };
  if (Xhr?.prototype) {
    const originalOpen = Xhr.prototype.open as
      | undefined
      | ((method: string, url: string, ...rest: unknown[]) => unknown);
    const originalSend = Xhr.prototype.send as
      undefined | ((body?: unknown) => unknown);
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
        // Redacted at `open` rather than at `send`: the raw URL is never held
        // on the request object, so nothing else that reads it can leak it.
        this.__crumbtrailNetwork = { method, url: redactMobileUrl(url) };
        return originalOpen.call(this, method, url, ...rest);
      };
      Xhr.prototype.send = function send(
        this: Record<string, unknown>,
        body?: unknown,
      ) {
        const startedAt = monotonicNow(globalObject);
        const info = this.__crumbtrailNetwork as
          | { method?: string; url?: MobileRedactedText }
          | undefined;
        const previous = this.onreadystatechange as undefined | (() => void);
        this.onreadystatechange = () => {
          if (this.readyState === 4) {
            emit(
              logger,
              capabilities,
              "net",
              networkData(info?.url, {
                method: info?.method?.toUpperCase(),
                status: this.status,
                dur: Math.max(0, monotonicNow(globalObject) - startedAt),
                source: "xmlhttprequest",
              }),
            );
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
  onState?: (state: string) => void,
): Cleanup {
  if (!appState?.addEventListener) return () => {};
  const subscription = appState.addEventListener("change", (state) => {
    onState?.(state);
    emit(logger, capabilities, "app-lifecycle", { state, source: "AppState" });
  });
  onState?.(appState.currentState ?? "active");
  emit(logger, capabilities, "app-lifecycle", {
    state: appState.currentState,
    source: "AppState",
    kind: "initial",
  });
  return toCleanup(subscription);
}

function enabledJsWatchdog(
  options: StartReactNativeCollectorsOptions,
): boolean {
  const config = resolveReactNativeCollectorConfig(options.config);
  return config.jsWatchdog && options.jsWatchdogEnabled !== false;
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

/**
 * Assemble a `net` payload around an already redacted URL.
 *
 * The URL is passed in redacted rather than raw so there is no branch here that
 * can forget to call the engine.
 */
function networkData(
  url: MobileRedactedText | undefined,
  rest: Record<string, unknown>,
  ...extra: Array<RedactionMetadata | undefined>
): Record<string, unknown> {
  const d: Record<string, unknown> = { url: url?.value, ...rest };
  attachMobileRedaction(d, url?.metadata, ...extra);
  return d;
}

/** Redact a thrown value into the `err` / `rej` payload shape. */
function redactedErrorData(
  error: unknown,
  rest: Record<string, unknown>,
): Record<string, unknown> {
  const msg = redactMobileText(
    error instanceof Error ? error.message : String(error),
    "msg",
    MOBILE_ERROR_MESSAGE_MAX_LENGTH,
  );
  const stk = redactMobileText(
    error instanceof Error ? error.stack : undefined,
    "stk",
    MOBILE_ERROR_STACK_MAX_LENGTH,
  );
  const d: Record<string, unknown> = {
    msg: msg?.value ?? "",
    // Only when there is one: an empty `stk` slot reads downstream as
    // "captured, and it was blank".
    ...(stk ? { stk: stk.value } : {}),
    ...rest,
  };
  attachMobileRedaction(d, msg?.metadata, stk?.metadata);
  return d;
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request)
    return input.url;
  return String(input);
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
    // Fall through to the platform clock when no monotonic clock is exposed.
  }
  return Date.now();
}

function toCleanup(
  subscription: { remove?: () => void } | (() => void) | undefined,
): Cleanup {
  if (typeof subscription === "function") return subscription;
  if (subscription?.remove) return () => subscription.remove?.();
  return () => {};
}
