// Structural types for the first-party Capacitor plugins this package reads.
//
// These are deliberately hand-written and structural rather than imported from
// `@capacitor/app` and friends. Two reasons:
//
//   1. Every one of those plugins is an OPTIONAL peer. Importing their types
//      for real would make `crumbtrail-capacitor` fail to typecheck in an app
//      that installed only the ones it wanted, which is most apps.
//   2. Structural types let the tests drive the collectors with plain object
//      literals instead of standing up a Capacitor runtime, which is what keeps
//      this package testable in a plain node vitest environment.
//
// Each type covers only the members the collectors actually touch. Anything the
// plugin returns beyond that is carried through untouched as `unknown`.

export interface PluginListenerHandle {
  remove?: () => void | Promise<void>;
}

/** `@capacitor/core`'s `Capacitor` global. */
export interface CapacitorCoreLike {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
}

/** `@capacitor/app` — foreground/background, cold start, deep links, back button. */
export interface CapacitorAppPluginLike {
  addListener?: (
    eventName: string,
    listener: (event: Record<string, unknown>) => void,
  ) => PluginListenerHandle | Promise<PluginListenerHandle>;
  getState?: () => Promise<{ isActive?: boolean } | undefined>;
  getLaunchUrl?: () => Promise<{ url?: string } | undefined>;
  getInfo?: () => Promise<
    | {
        name?: string;
        id?: string;
        build?: string;
        version?: string;
      }
    | undefined
  >;
}

/** `@capacitor/device` — the hardware and OS the bug happened on. */
export interface CapacitorDevicePluginLike {
  getInfo?: () => Promise<
    | {
        model?: string;
        platform?: string;
        operatingSystem?: string;
        osVersion?: string;
        manufacturer?: string;
        isVirtual?: boolean;
        webViewVersion?: string;
        memUsed?: number;
        realDiskFree?: number;
        realDiskTotal?: number;
      }
    | undefined
  >;
  getBatteryInfo?: () => Promise<
    { batteryLevel?: number; isCharging?: boolean } | undefined
  >;
  getId?: () => Promise<{ identifier?: string } | undefined>;
  getLanguageTag?: () => Promise<{ value?: string } | undefined>;
}

/** `@capacitor/network` — radio state, which explains a whole class of mobile bugs. */
export interface CapacitorNetworkPluginLike {
  getStatus?: () => Promise<
    { connected?: boolean; connectionType?: string } | undefined
  >;
  addListener?: (
    eventName: string,
    listener: (status: Record<string, unknown>) => void,
  ) => PluginListenerHandle | Promise<PluginListenerHandle>;
}

/** `@capacitor/preferences` — durable key/value, used to persist the session id. */
export interface CapacitorPreferencesPluginLike {
  get?: (options: { key: string }) => Promise<{ value?: string | null }>;
  set?: (options: { key: string; value: string }) => Promise<void>;
  remove?: (options: { key: string }) => Promise<void>;
}

/** `@capacitor/screen-orientation` — portrait/landscape at the moment of the bug. */
export interface CapacitorScreenOrientationPluginLike {
  orientation?: () => Promise<{ type?: string } | undefined>;
  addListener?: (
    eventName: string,
    listener: (event: Record<string, unknown>) => void,
  ) => PluginListenerHandle | Promise<PluginListenerHandle>;
}

/**
 * The full set of plugin instances the collectors can use. Every field is
 * optional and independently absent: an app with only `@capacitor/app`
 * installed gets lifecycle events and nothing else, rather than an error.
 */
export interface CapacitorPluginBundle {
  Capacitor?: CapacitorCoreLike | null;
  App?: CapacitorAppPluginLike | null;
  Device?: CapacitorDevicePluginLike | null;
  Network?: CapacitorNetworkPluginLike | null;
  Preferences?: CapacitorPreferencesPluginLike | null;
  ScreenOrientation?: CapacitorScreenOrientationPluginLike | null;
}

/**
 * Resolve the plugin bundle from installed packages.
 *
 * Returns whatever resolves and silently omits the rest — an absent optional
 * plugin is the normal case, not a failure. A caller that wants to inject its
 * own doubles (the tests, or an app that already imported the plugins itself)
 * passes them to `createCapacitorCrumbtrail` directly and never reaches here.
 *
 * With no resolver supplied this falls back to a guarded `require`, which is
 * what works in a Capacitor dev build. It can legitimately come back empty in a
 * bundled production build, because bundlers cannot see through the indirection
 * and drop the modules — which is exactly why `plugins` is a public option.
 */
export function resolveCapacitorPlugins(
  resolver: ((packageName: string) => unknown) | undefined =
    safeRequireOptionalModule,
): CapacitorPluginBundle {
  if (!resolver) return {};
  return {
    Capacitor: read<CapacitorCoreLike>(resolver, "@capacitor/core", "Capacitor"),
    App: read<CapacitorAppPluginLike>(resolver, "@capacitor/app", "App"),
    Device: read<CapacitorDevicePluginLike>(
      resolver,
      "@capacitor/device",
      "Device",
    ),
    Network: read<CapacitorNetworkPluginLike>(
      resolver,
      "@capacitor/network",
      "Network",
    ),
    Preferences: read<CapacitorPreferencesPluginLike>(
      resolver,
      "@capacitor/preferences",
      "Preferences",
    ),
    ScreenOrientation: read<CapacitorScreenOrientationPluginLike>(
      resolver,
      "@capacitor/screen-orientation",
      "ScreenOrientation",
    ),
  };
}

function safeRequireOptionalModule(packageName: string): unknown {
  try {
    const maybeRequire = Function(
      'return typeof require === "function" ? require : undefined',
    )() as unknown;
    return typeof maybeRequire === "function"
      ? (maybeRequire as (name: string) => unknown)(packageName)
      : undefined;
  } catch {
    return undefined;
  }
}

function read<T>(
  resolver: (packageName: string) => unknown,
  packageName: string,
  exportName: string,
): T | undefined {
  try {
    const mod = resolver(packageName) as Record<string, unknown> | undefined;
    const value = mod?.[exportName];
    return value ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}
