export const REACT_NATIVE_CAPABILITY_BITS = {
  asyncStorage: 1 << 0,
  navigation: 1 << 1,
  viewShot: 1 << 2,
} as const;

export type ReactNativeOptionalModuleName =
  | "asyncStorage"
  | "navigation"
  | "viewShot";
export type ReactNativeCapabilityStatus = "present" | "absent";

export interface ReactNativeCapabilityDetail {
  packageName: string;
  present: boolean;
  status: ReactNativeCapabilityStatus;
}

export type ReactNativeCapabilityModules = Record<
  ReactNativeOptionalModuleName,
  ReactNativeCapabilityDetail
>;

export interface ReactNativeCapabilities {
  bitset: number;
  capabilities: string[];
  modules: ReactNativeCapabilityModules;
}

export type OptionalModuleResolver = (packageName: string) => unknown;

const OPTIONAL_MODULES = [
  {
    key: "asyncStorage",
    packageName: "@react-native-async-storage/async-storage",
    capability: "async-storage",
    bit: REACT_NATIVE_CAPABILITY_BITS.asyncStorage,
  },
  {
    key: "navigation",
    packageName: "@react-navigation/native",
    capability: "navigation",
    bit: REACT_NATIVE_CAPABILITY_BITS.navigation,
  },
  {
    key: "viewShot",
    packageName: "react-native-view-shot",
    capability: "view-snapshot",
    bit: REACT_NATIVE_CAPABILITY_BITS.viewShot,
  },
] as const;

export interface DetectReactNativeCapabilitiesOptions {
  resolver?: OptionalModuleResolver;
}

export function detectReactNativeCapabilities(
  options: DetectReactNativeCapabilitiesOptions = {},
): ReactNativeCapabilities {
  const resolver = options.resolver ?? safeRequireOptionalModule;
  const modules = {} as ReactNativeCapabilityModules;
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
