// Capacitor optional-plugin detection.
//
// Unlike React Native, a Capacitor app runs inside a real WebView, so
// `crumbtrail-core` already captures console, errors, network, interactions and
// the DOM replay with no help from this package. What this package adds is the
// NATIVE half of the picture: which device, which OS build, whether the app was
// foregrounded or resumed from a cold start, what the radio was doing, and
// which deep link opened the screen.
//
// Every one of those comes from a first-party Capacitor plugin the app may or
// may not have installed. So detection is the same shape as the React Native
// package: resolve the module, record present/absent, and expose a bitset the
// ingest side can reason about without re-deriving it.

export const CAPACITOR_CAPABILITY_BITS = {
  core: 1 << 0,
  app: 1 << 1,
  device: 1 << 2,
  network: 1 << 3,
  preferences: 1 << 4,
  screenOrientation: 1 << 5,
} as const;

export type CapacitorOptionalModuleName =
  | "core"
  | "app"
  | "device"
  | "network"
  | "preferences"
  | "screenOrientation";

export type CapacitorCapabilityStatus = "present" | "absent";

export interface CapacitorCapabilityDetail {
  packageName: string;
  present: boolean;
  status: CapacitorCapabilityStatus;
}

export type CapacitorCapabilityModules = Record<
  CapacitorOptionalModuleName,
  CapacitorCapabilityDetail
>;

export interface CapacitorCapabilities {
  bitset: number;
  capabilities: string[];
  modules: CapacitorCapabilityModules;
}

export type OptionalModuleResolver = (packageName: string) => unknown;

const OPTIONAL_MODULES = [
  {
    key: "core",
    packageName: "@capacitor/core",
    capability: "capacitor-core",
    bit: CAPACITOR_CAPABILITY_BITS.core,
  },
  {
    key: "app",
    packageName: "@capacitor/app",
    capability: "app-lifecycle",
    bit: CAPACITOR_CAPABILITY_BITS.app,
  },
  {
    key: "device",
    packageName: "@capacitor/device",
    capability: "device-info",
    bit: CAPACITOR_CAPABILITY_BITS.device,
  },
  {
    key: "network",
    packageName: "@capacitor/network",
    capability: "network-status",
    bit: CAPACITOR_CAPABILITY_BITS.network,
  },
  {
    key: "preferences",
    packageName: "@capacitor/preferences",
    capability: "session-persistence",
    bit: CAPACITOR_CAPABILITY_BITS.preferences,
  },
  {
    key: "screenOrientation",
    packageName: "@capacitor/screen-orientation",
    capability: "orientation",
    bit: CAPACITOR_CAPABILITY_BITS.screenOrientation,
  },
] as const;

export interface DetectCapacitorCapabilitiesOptions {
  resolver?: OptionalModuleResolver;
}

export function detectCapacitorCapabilities(
  options: DetectCapacitorCapabilitiesOptions = {},
): CapacitorCapabilities {
  const resolver = options.resolver ?? safeRequireOptionalModule;
  const modules = {} as CapacitorCapabilityModules;
  const capabilities: string[] = [];
  let bitset = 0;

  for (const optionalModule of OPTIONAL_MODULES) {
    const present = isModulePresent(optionalModule.packageName, resolver);
    modules[optionalModule.key] = {
      packageName: optionalModule.packageName,
      present,
      status: present ? "present" : "absent",
    };

    if (present) {
      bitset |= optionalModule.bit;
      capabilities.push(optionalModule.capability);
    }
  }

  return { bitset, capabilities, modules };
}

function isModulePresent(
  packageName: string,
  resolver: OptionalModuleResolver,
): boolean {
  try {
    return resolver(packageName) !== undefined;
  } catch {
    return false;
  }
}

function safeRequireOptionalModule(packageName: string): unknown {
  try {
    const requireFn = getRequire();
    return requireFn ? requireFn(packageName) : undefined;
  } catch {
    return undefined;
  }
}

function getRequire(): ((name: string) => unknown) | undefined {
  try {
    const maybeRequire = Function(
      'return typeof require === "function" ? require : undefined',
    )() as unknown;
    return typeof maybeRequire === "function"
      ? (maybeRequire as (name: string) => unknown)
      : undefined;
  } catch {
    return undefined;
  }
}
