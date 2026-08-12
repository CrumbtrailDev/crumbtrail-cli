export {
  detectCapacitorCapabilities,
  CAPACITOR_CAPABILITY_BITS,
} from "./capabilities";
export type {
  CapacitorCapabilities,
  CapacitorCapabilityDetail,
  CapacitorCapabilityModules,
  CapacitorCapabilityStatus,
  CapacitorOptionalModuleName,
  DetectCapacitorCapabilitiesOptions,
  OptionalModuleResolver,
} from "./capabilities";

export { resolveCapacitorPlugins } from "./plugins";
export type {
  CapacitorAppPluginLike,
  CapacitorCoreLike,
  CapacitorDevicePluginLike,
  CapacitorNetworkPluginLike,
  CapacitorPluginBundle,
  CapacitorPreferencesPluginLike,
  CapacitorScreenOrientationPluginLike,
  PluginListenerHandle,
} from "./plugins";

export { createCapacitorSessionStore } from "./session-store";
export type { CapacitorSessionStore } from "./session-store";

export {
  resolveCapacitorPlatform,
  startCapacitorCollectors,
} from "./collectors";
export type {
  CapacitorCollectorConfig,
  CapacitorCollectorController,
  CapacitorCollectorName,
  StartCapacitorCollectorsOptions,
} from "./collectors";

export {
  CAPACITOR_DEFAULT_CONFIG,
  createCapacitorCrumbtrail,
  createCapacitorCrumbtrailAsync,
  resolveCapacitorConfig,
} from "./logger";
export type {
  CapacitorCrumbtrailOptions,
  CapacitorCrumbtrailResult,
} from "./logger";
