import { Crumbtrail } from "crumbtrail-core";
import type { CrumbtrailConfig } from "crumbtrail-core";
import { createReactNativeSessionStore } from "./session-store";
import { detectReactNativeCapabilities } from "./capabilities";
import { startReactNativeCollectors } from "./collectors";
import type { AsyncStorageLike } from "./session-store";
import type {
  DetectReactNativeCapabilitiesOptions,
  ReactNativeCapabilities,
} from "./capabilities";
import type {
  ReactNativeCollectorConfig,
  ReactNativeCollectorController,
  ReactNativeCollectorRuntime,
} from "./collectors";

export interface ReactNativeCrumbtrailOptions
  extends DetectReactNativeCapabilitiesOptions, ReactNativeCollectorRuntime {
  config?: Partial<CrumbtrailConfig>;
  asyncStorage?: AsyncStorageLike | null;
  reportCapabilities?: boolean;
  collectors?: ReactNativeCollectorConfig;
}

export interface ReactNativeCrumbtrailResult {
  logger: Crumbtrail;
  capabilities: ReactNativeCapabilities;
  collectors: ReactNativeCollectorController;
}

const REACT_NATIVE_DEFAULT_CONFIG: Partial<CrumbtrailConfig> = {
  network: false,
  interactions: false,
  keystrokes: false,
  scroll: false,
  visibility: false,
  clipboard: false,
  cookies: false,
  storage: false,
  performance: false,
  video: false,
  audio: false,
  widget: false,
  sessionPersistence: "session",
};

export function createReactNativeCrumbtrail(
  options: ReactNativeCrumbtrailOptions = {},
): ReactNativeCrumbtrailResult {
  const capabilities = detectReactNativeCapabilities({
    resolver: options.resolver,
  });
  const userConfig = options.config;
  const sessionStore = options.asyncStorage
    ? createReactNativeSessionStore(options.asyncStorage)
    : userConfig?.sessionStore;
  const config = {
    ...REACT_NATIVE_DEFAULT_CONFIG,
    ...userConfig,
    ...(sessionStore ? { sessionStore } : {}),
  };
  const logger = Crumbtrail.init(config);

  if (options.reportCapabilities !== false) {
    logger.addEvent({
      type: "rn.capabilities",
      data: {
        bitset: capabilities.bitset,
        capabilities: capabilities.capabilities,
        modules: capabilities.modules,
      },
      platform: "react-native",
      sdk: { name: "crumbtrail-react-native" },
      capabilities: capabilities.capabilities,
    });
  }

  const collectors = startReactNativeCollectors(logger, {
    config: options.collectors,
    capabilities,
    resolver: options.resolver,
    globalObject: options.globalObject,
    reactNative: options.reactNative,
    navigation: options.navigation,
    errorUtils: options.errorUtils,
  });
  wrapStopWithCollectorCleanup(logger, collectors);

  return { logger, capabilities, collectors };
}

export async function createReactNativeCrumbtrailAsync(
  options: ReactNativeCrumbtrailOptions = {},
): Promise<ReactNativeCrumbtrailResult> {
  const sessionStore = options.asyncStorage
    ? createReactNativeSessionStore(options.asyncStorage)
    : undefined;
  await sessionStore?.hydrate();

  return createReactNativeCrumbtrail({
    ...options,
    asyncStorage: undefined,
    config: {
      ...options.config,
      ...(sessionStore ? { sessionStore } : {}),
    },
  });
}

function wrapStopWithCollectorCleanup(
  logger: Crumbtrail,
  collectors: ReactNativeCollectorController,
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
