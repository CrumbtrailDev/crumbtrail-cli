import {
  BROWSER_REDACTION_POLICY,
  attachRedactionMetadata,
  mergeRedactionMetadata,
  redactUrl,
} from "crumbtrail-core";
import type {
  Crumbtrail,
  CrumbtrailPlatform,
  RedactionMetadata,
} from "crumbtrail-core";
import type { CapacitorCapabilities } from "./capabilities";
import type {
  CapacitorAppPluginLike,
  CapacitorCoreLike,
  CapacitorDevicePluginLike,
  CapacitorNetworkPluginLike,
  CapacitorPluginBundle,
  CapacitorScreenOrientationPluginLike,
  PluginListenerHandle,
} from "./plugins";

export type CapacitorCollectorName =
  | "environment"
  | "appLifecycle"
  | "network"
  | "deepLinks"
  | "backButton"
  | "orientation";

export type CapacitorCollectorConfig =
  | boolean
  | Partial<Record<CapacitorCollectorName, boolean>>;

export interface CapacitorCollectorController {
  cleanup(): void;
  /**
   * Resolves once every collector's async setup has settled.
   *
   * Several Capacitor plugin APIs are promise-returning (`addListener`,
   * `getInfo`), so a collector cannot finish attaching synchronously. Capture
   * still starts immediately — this handle exists so tests and any caller that
   * needs determinism can await the point where listeners are actually live.
   */
  ready: Promise<void>;
}

export interface StartCapacitorCollectorsOptions {
  config?: CapacitorCollectorConfig;
  capabilities: CapacitorCapabilities;
  plugins: CapacitorPluginBundle;
  /** Platform tag for emitted events; defaults to the resolved Capacitor platform. */
  platform?: CrumbtrailPlatform;
}

const DEFAULT_COLLECTORS: Record<CapacitorCollectorName, boolean> = {
  environment: true,
  appLifecycle: true,
  network: true,
  deepLinks: true,
  backButton: true,
  orientation: true,
};

const SDK_NAME = "crumbtrail-capacitor";

/**
 * Longest deep link kept before redaction.
 *
 * The URL is handed to the app by the OS, so its length is chosen by whoever
 * crafted the link, not by the app or by this SDK. Without a bound, one hostile
 * `myapp://` link dominates the session payload and pays unbounded parse cost on
 * the device. 2048 holds a real OAuth callback, which is the longest link this
 * collector is expected to see, with room to spare.
 */
const MAX_DEEP_LINK_LENGTH = 2048;

/**
 * Longest device-reported identifier kept.
 *
 * `model`, `manufacturer`, `operatingSystem`, `osVersion` and `webViewVersion`
 * come from the platform build properties (`Build.MODEL` and friends on
 * Android), which a rooted or emulated device can set to anything. They carry no
 * personal data, so they are kept in full up to the bound rather than redacted --
 * the whole point of the environment snapshot is to say which device this was.
 */
const MAX_DEVICE_STRING_LENGTH = 128;

type Cleanup = () => void;

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

interface RedactedDeepLink {
  url: string | undefined;
  metadata: RedactionMetadata | undefined;
}

/**
 * Bound and redact a deep link before it leaves the device.
 *
 * A mobile deep link is where OAuth callback codes, magic link tokens, password
 * reset tokens, invite codes and session ids arrive, so the raw URL is the single
 * most credential-dense value this package touches. `redactUrl` is core's shared
 * engine -- the same one core's own navigation collector uses -- and it already
 * understands custom app schemes: it drops URL credentials and the whole
 * fragment, and replaces sensitive query values with a shape token. A local deny
 * list here would drift away from it, which is exactly the failure this avoids.
 *
 * The length bound is applied to the raw URL, before parsing, so the parse cost
 * is bounded too. Truncation can only make the result more conservative: a
 * sliced URL that no longer parses falls through to core's stricter relative and
 * malformed handling.
 */
function redactDeepLink(raw: unknown): RedactedDeepLink {
  if (typeof raw !== "string" || raw.length === 0)
    return { url: undefined, metadata: undefined };

  const truncated = raw.length > MAX_DEEP_LINK_LENGTH;
  const result = redactUrl(
    truncated ? raw.slice(0, MAX_DEEP_LINK_LENGTH) : raw,
    "url",
  );
  const truncation: RedactionMetadata | undefined = truncated
    ? {
        policy: BROWSER_REDACTION_POLICY,
        fields: [{ path: "url", reason: "url_truncated", action: "summarized" }],
      }
    : undefined;

  return {
    url: result.value,
    metadata: mergeRedactionMetadata(truncation, result.metadata),
  };
}

/**
 * Map `Capacitor.getPlatform()` onto the shared platform tag.
 *
 * Reporting the concrete OS rather than a flat "webview" is what lets an
 * ingested session be filtered to "iOS only" — and iOS-only is the shape of a
 * large share of hybrid bugs, because WKWebView and the Android System WebView
 * disagree about storage eviction, back navigation, and media autoplay.
 */
export function resolveCapacitorPlatform(
  capacitor: CapacitorCoreLike | null | undefined,
): CrumbtrailPlatform {
  let name: string | undefined;
  try {
    name = capacitor?.getPlatform?.();
  } catch {
    name = undefined;
  }
  if (name === "ios") return "ios";
  if (name === "android") return "android";
  return "webview";
}

export function startCapacitorCollectors(
  logger: Crumbtrail,
  options: StartCapacitorCollectorsOptions,
): CapacitorCollectorController {
  const enabled = resolveCollectorConfig(options.config);
  const { plugins, capabilities } = options;
  const platform =
    options.platform ?? resolveCapacitorPlatform(plugins.Capacitor);
  const cleanup: Cleanup[] = [];
  const pending: Promise<void>[] = [];

  const context: CollectorContext = {
    logger,
    capabilities,
    platform,
    register(stop) {
      cleanup.push(stop);
    },
  };

  if (enabled.environment)
    pending.push(
      collectEnvironment(context, plugins.Capacitor, plugins.Device, plugins.App),
    );
  if (enabled.appLifecycle) pending.push(collectAppLifecycle(context, plugins.App));
  if (enabled.network) pending.push(collectNetwork(context, plugins.Network));
  if (enabled.deepLinks) pending.push(collectDeepLinks(context, plugins.App));
  if (enabled.backButton) pending.push(collectBackButton(context, plugins.App));
  if (enabled.orientation)
    pending.push(collectOrientation(context, plugins.ScreenOrientation));

  return {
    cleanup() {
      for (const stop of cleanup.splice(0).reverse()) stop();
    },
    ready: Promise.all(pending).then(() => undefined),
  };
}

interface CollectorContext {
  logger: Crumbtrail;
  capabilities: CapacitorCapabilities;
  platform: CrumbtrailPlatform;
  register(stop: Cleanup): void;
}

function resolveCollectorConfig(
  config: CapacitorCollectorConfig | undefined,
): Record<CapacitorCollectorName, boolean> {
  if (config === false) {
    return Object.fromEntries(
      Object.keys(DEFAULT_COLLECTORS).map((key) => [key, false]),
    ) as Record<CapacitorCollectorName, boolean>;
  }
  if (config === true || config === undefined) return { ...DEFAULT_COLLECTORS };
  return { ...DEFAULT_COLLECTORS, ...config };
}

function emit(
  context: CollectorContext,
  type: string,
  data: Record<string, unknown>,
): void {
  context.logger.addEvent({
    type,
    data,
    platform: context.platform,
    sdk: { name: SDK_NAME },
    capabilities: context.capabilities.capabilities,
  });
}

/**
 * One-shot device/app/OS snapshot.
 *
 * Emitted once at init rather than per-event: it does not change during a
 * session, and repeating ~15 fields on every crumb would dominate the payload
 * of a long session for no added information.
 */
async function collectEnvironment(
  context: CollectorContext,
  capacitor: CapacitorCoreLike | null | undefined,
  device: CapacitorDevicePluginLike | null | undefined,
  app: CapacitorAppPluginLike | null | undefined,
): Promise<void> {
  const [info, battery, language, appInfo] = await Promise.all([
    safeCall(() => device?.getInfo?.()),
    safeCall(() => device?.getBatteryInfo?.()),
    safeCall(() => device?.getLanguageTag?.()),
    safeCall(() => app?.getInfo?.()),
  ]);

  emit(context, "env", {
    kind: "snapshot",
    runtime: {
      container: "capacitor",
      platform: safeSync(() => capacitor?.getPlatform?.()),
      native: safeSync(() => capacitor?.isNativePlatform?.()),
    },
    device: info
      ? {
          model: boundedString(info.model, MAX_DEVICE_STRING_LENGTH),
          manufacturer: boundedString(
            info.manufacturer,
            MAX_DEVICE_STRING_LENGTH,
          ),
          os: boundedString(info.operatingSystem, MAX_DEVICE_STRING_LENGTH),
          osVersion: boundedString(info.osVersion, MAX_DEVICE_STRING_LENGTH),
          // A hybrid bug is very often a WebView-engine bug, and the WebView
          // version moves independently of the OS version on Android. Without
          // it, "works on my Android 14 device" is unfalsifiable.
          webViewVersion: boundedString(
            info.webViewVersion,
            MAX_DEVICE_STRING_LENGTH,
          ),
          virtual: info.isVirtual,
          memUsed: info.memUsed,
          diskFree: info.realDiskFree,
          diskTotal: info.realDiskTotal,
        }
      : undefined,
    app: appInfo
      ? {
          id: appInfo.id,
          name: appInfo.name,
          version: appInfo.version,
          build: appInfo.build,
        }
      : undefined,
    battery: battery
      ? { level: battery.batteryLevel, charging: battery.isCharging }
      : undefined,
    locale: language?.value,
  });
}

/**
 * Foreground/background transitions.
 *
 * Backgrounding is load-bearing evidence on mobile in a way it never is on
 * desktop web: the OS suspends timers, drops sockets, and may kill the process
 * outright. A request that "hung" is usually a request whose app was suspended
 * mid-flight, and only the lifecycle track distinguishes the two.
 */
async function collectAppLifecycle(
  context: CollectorContext,
  app: CapacitorAppPluginLike | null | undefined,
): Promise<void> {
  if (!app?.addListener) return;

  const state = await safeCall(() => app.getState?.());
  emit(context, "app-lifecycle", {
    state: state?.isActive === undefined ? undefined : stateName(state.isActive),
    kind: "initial",
    source: "capacitor-app",
  });

  await attach(context, app.addListener, "appStateChange", (event) => {
    emit(context, "app-lifecycle", {
      state: stateName(Boolean(event.isActive)),
      source: "capacitor-app",
    });
  });

  // `pause`/`resume` are the native-side counterparts of `appStateChange` and
  // fire in cases where the WebView never regains focus (an iOS app killed in
  // the background, an Android activity recreated on rotation). Listening to
  // both is intentional: they are not duplicates, and the ingest side prefers
  // whichever arrived.
  await attach(context, app.addListener, "pause", () => {
    emit(context, "app-lifecycle", { state: "background", source: "pause" });
  });
  await attach(context, app.addListener, "resume", () => {
    emit(context, "app-lifecycle", { state: "active", source: "resume" });
  });
}

/**
 * Radio state and its transitions.
 *
 * Captured as its own track, not folded into request events, because the
 * interesting case is the transition WITHOUT a request: an app that went
 * offline for 300ms and came back with stale state produces no failed request
 * at all, and the connectivity blip is the only surviving evidence.
 */
async function collectNetwork(
  context: CollectorContext,
  network: CapacitorNetworkPluginLike | null | undefined,
): Promise<void> {
  if (!network) return;

  const status = await safeCall(() => network.getStatus?.());
  if (status) {
    emit(context, "net-status", {
      connected: status.connected,
      type: status.connectionType,
      kind: "initial",
    });
  }

  if (!network.addListener) return;
  await attach(context, network.addListener, "networkStatusChange", (event) => {
    emit(context, "net-status", {
      connected: event.connected,
      type: event.connectionType,
    });
  });
}

/**
 * Deep links, including the one that cold-started the app.
 *
 * `getLaunchUrl()` is checked separately from the `appUrlOpen` listener because
 * a cold start delivers the URL to the native layer BEFORE any JavaScript runs,
 * so the listener alone would miss precisely the launch that caused the bug.
 */
async function collectDeepLinks(
  context: CollectorContext,
  app: CapacitorAppPluginLike | null | undefined,
): Promise<void> {
  if (!app) return;

  const launch = await safeCall(() => app.getLaunchUrl?.());
  const launchLink = redactDeepLink(launch?.url);
  if (launchLink.url !== undefined) {
    const data: Record<string, unknown> = {
      url: launchLink.url,
      source: "launch-url",
      kind: "cold-start",
    };
    attachRedactionMetadata(data, launchLink.metadata);
    emit(context, "navigation", data);
  }

  if (!app.addListener) return;
  await attach(context, app.addListener, "appUrlOpen", (event) => {
    const link = redactDeepLink(event.url);
    const data: Record<string, unknown> = {
      url: link.url,
      source: "appUrlOpen",
    };
    attachRedactionMetadata(data, link.metadata);
    emit(context, "navigation", data);
  });

  // Android can restore a plugin result after the OS killed the app mid-flow
  // (a camera or file picker round trip). Without this the session shows a gap
  // and then an unexplained state change.
  await attach(context, app.addListener, "appRestoredResult", (event) => {
    emit(context, "app-lifecycle", {
      state: "restored",
      source: "appRestoredResult",
      pluginId: event.pluginId,
      methodName: event.methodName,
    });
  });
}

/**
 * The Android hardware/gesture back button.
 *
 * Purely additive observation: the listener records the press and does nothing
 * else. It must never call `preventDefault` or exit the app — a telemetry SDK
 * that changes navigation behaviour is a bug factory, and Capacitor gives the
 * last registered listener the ability to do exactly that.
 */
async function collectBackButton(
  context: CollectorContext,
  app: CapacitorAppPluginLike | null | undefined,
): Promise<void> {
  if (!app?.addListener) return;
  await attach(context, app.addListener, "backButton", (event) => {
    emit(context, "nav-intent", {
      action: "back",
      canGoBack: event.canGoBack,
      source: "hardware-back",
    });
  });
}

/** Portrait/landscape, which reproduces a whole class of layout-only defects. */
async function collectOrientation(
  context: CollectorContext,
  orientation: CapacitorScreenOrientationPluginLike | null | undefined,
): Promise<void> {
  if (!orientation) return;

  const current = await safeCall(() => orientation.orientation?.());
  if (current?.type) {
    emit(context, "env", {
      kind: "orientation",
      orientation: current.type,
      initial: true,
    });
  }

  if (!orientation.addListener) return;
  await attach(
    context,
    orientation.addListener,
    "screenOrientationChange",
    (event) => {
      emit(context, "env", { kind: "orientation", orientation: event.type });
    },
  );
}

/**
 * Attach one plugin listener and register its removal.
 *
 * Capacitor's `addListener` returns `PluginListenerHandle | Promise<handle>`
 * depending on plugin and version, so both are awaited here rather than at each
 * call site. A rejected attach is swallowed: one unavailable plugin event must
 * not take down the collectors that did attach.
 */
async function attach(
  context: CollectorContext,
  addListener: NonNullable<CapacitorAppPluginLike["addListener"]>,
  eventName: string,
  listener: (event: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const handle = (await addListener(eventName, listener)) as
      | PluginListenerHandle
      | undefined;
    context.register(() => {
      try {
        void handle?.remove?.();
      } catch {
        // Removal is best-effort; the app is usually tearing down anyway.
      }
    });
  } catch {
    // Plugin does not support this event on this platform.
  }
}

function stateName(isActive: boolean): string {
  return isActive ? "active" : "background";
}

async function safeCall<T>(
  call: () => Promise<T | undefined> | undefined,
): Promise<T | undefined> {
  try {
    return (await call()) ?? undefined;
  } catch {
    return undefined;
  }
}

function safeSync<T>(call: () => T | undefined): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
