import type { TargetDescriptor } from "crumbtrail-core";

export interface ReactNativeTargetInput {
  role?: string;
  label?: string;
  testID?: string;
  testId?: string;
  accessibilityId?: string;
  accessibilityLabel?: string;
  componentName?: string;
  routePath?: string;
  ancestryHash?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  redaction?: unknown;
}

export function createReactNativeTargetDescriptor(
  input: ReactNativeTargetInput,
): TargetDescriptor | undefined {
  const descriptor = {
    role: input.role,
    label: input.label ?? input.accessibilityLabel,
    testID: input.testID ?? input.testId,
    accessibilityId: input.accessibilityId,
    componentName: input.componentName,
    routePath: input.routePath,
    ancestryHash: input.ancestryHash,
    bounds: input.bounds,
    redaction: input.redaction,
  };

  const hasIdentity = Boolean(
    descriptor.role ||
    descriptor.label ||
    descriptor.testID ||
    descriptor.accessibilityId ||
    descriptor.componentName ||
    descriptor.routePath ||
    descriptor.ancestryHash,
  );

  return hasIdentity ? (descriptor as TargetDescriptor) : undefined;
}
