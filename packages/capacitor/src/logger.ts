import { Crumbtrail } from "crumbtrail-core";
import type { CrumbtrailConfig, CrumbtrailPlatform } from "crumbtrail-core";
import { detectCapacitorCapabilities } from "./capabilities";
import { resolveCapacitorPlugins } from "./plugins";
import { createCapacitorSessionStore } from "./session-store";
import {
  resolveCapacitorPlatform,
  startCapacitorCollectors,
} from "./collectors";
import type {
  CapacitorCapabilities,
  DetectCapacitorCapabilitiesOptions,
} from "./capabilities";
import type {
  CapacitorCollectorConfig,
  CapacitorCollectorController,
} from "./collectors";
import type { CapacitorPluginBundle } from "./plugins";

export interface CapacitorCrumbtrailOptions
  extends DetectCapacitorCapabilitiesOptions {
  config?: Partial<CrumbtrailConfig>;
  /**
   * Plugin instances to use instead of resolving them.
   *
   * An app that already imports `{ App } from "@capacitor/app"` should pass
   * them here: bundlers tree-shake the dynamic resolution path away, so the
   * automatic lookup can come back empty in a production build even though the
   * plugin is installed and working.
   */
  plugins?: CapacitorPluginBundle;
  collectors?: CapacitorCollectorConfig;
  reportCapabilities?: boolean;
  /** Override the reported platform tag. Defaults to the live Capacitor platform. */
  platform?: CrumbtrailPlatform;
}

export interface CapacitorCrumbtrailResult {
  logger: Crumbtrail;
  capabilities: CapacitorCapabilities;
  collectors: CapacitorCollectorController;
  /** The platform tag every event from this SDK carries. */
  platform: CrumbtrailPlatform;
}

/**
 * Defaults for a Capacitor WebView.
 *
 * Deliberately much thinner than the React Native defaults. React Native has no
 * DOM, so its SDK has to switch off every web collector in `crumbtrail-core`
 * and reimplement what it needs. A Capacitor app runs real web code in a real
 * WebView, so console, network, errors, interactions and DOM replay all work
 * as shipped — turning them off would throw away the capture this package is
 * supposed to be adding native context to.
 *
 * Only two things change from the web defaults, both for the same reason: a
 * phone is battery- and bandwidth-constrained in a way a desktop tab is not.
 * Media capture is the single most expensive collector, and on cellular it is
 * also the most expensive to upload, so it is opt-in here rather than opt-out.
 */
export const CAPACITOR_DEFAULT_CONFIG: Partial<CrumbtrailConfig> = {
  video: false,
  audio: false,
};

/**
 * Merge caller config over the Capacitor defaults.
 *
 * Extracted as a pure function purely so it is testable: `Crumbtrail` keeps its
 * resolved config private, so asserting on the live logger is impossible and a
 * test that tried would pass vacuously.
 */
export function resolveCapacitorConfig(
  config: Partial<CrumbtrailConfig> | undefined,
): Partial<CrumbtrailConfig> {
  return { ...CAPACITOR_DEFAULT_CONFIG, ...config };
}

/**
 * Initialise Crumbtrail for a Capacitor / Ionic app, synchronously.
 *
 * Prefer `createCapacitorCrumbtrailAsync` when `@capacitor/preferences` is
 * installed: session persistence needs one async read before init, and the sync
 * entry point cannot wait for it, so a session id from a previous launch will
 * not be restored.
 */
export function createCapacitorCrumbtrail(
  options: CapacitorCrumbtrailOptions = {},
): CapacitorCrumbtrailResult {
  const capabilities = detectCapacitorCapabilities({
    resolver: options.resolver,
  });
  const plugins =
    options.plugins ?? resolveCapacitorPlugins(options.resolver);
  const platform = options.platform ?? resolveCapacitorPlatform(plugins.Capacitor);

  const logger = Crumbtrail.init(resolveCapacitorConfig(options.config));

  if (options.reportCapabilities !== false) {
    logger.addEvent({
      type: "capacitor.capabilities",
      data: {
        bitset: capabilities.bitset,
        capabilities: capabilities.capabilities,
        modules: capabilities.modules,
      },
      platform,
      sdk: { name: "crumbtrail-capacitor" },
      capabilities: capabilities.capabilities,
    });
  }

  const collectors = startCapacitorCollectors(logger, {
    config: options.collectors,
    capabilities,
    plugins,
    platform,
  });
  wrapStopWithCollectorCleanup(logger, collectors);

  return { logger, capabilities, collectors, platform };
}

/**
 * Initialise Crumbtrail for a Capacitor / Ionic app, restoring any persisted
 * session id first.
 *
 * This is the entry point the setup wizard injects. The extra await buys
 * cross-launch session continuity: without it, every cold start opens a new
 * session, and an intermittent bug that a user hits once a day looks like a
 * series of unrelated one-event sessions rather than one recurring signature.
 */
export async function createCapacitorCrumbtrailAsync(
  options: CapacitorCrumbtrailOptions = {},
): Promise<CapacitorCrumbtrailResult> {
  const plugins =
    options.plugins ?? resolveCapacitorPlugins(options.resolver);
  const sessionStore = createCapacitorSessionStore(plugins.Preferences);
  await sessionStore?.hydrate();

  const result = createCapacitorCrumbtrail({
    ...options,
    plugins,
    config: {
      ...options.config,
      ...(sessionStore
        ? { sessionStore, sessionPersistence: "session" as const }
        : {}),
    },
  });

  await result.collectors.ready;
  return result;
}

function wrapStopWithCollectorCleanup(
  logger: Crumbtrail,
  collectors: CapacitorCollectorController,
): void {
  const stop = logger.stop.bind(logger);
  let cleaned = false;
  logger.stop = async () => {
    if (!cleaned) {
      cleaned = true;
      collectors.cleanup();
    }
    return stop();
  };
}
