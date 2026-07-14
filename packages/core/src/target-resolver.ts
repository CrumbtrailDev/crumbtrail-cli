import { computeElementSignature } from "./signature";
import type { TargetDescriptor } from "./types";

/**
 * Converts a runtime-specific target object into the shared, privacy-safe target descriptor.
 * Mobile SDKs can implement this against native view metadata without depending on DOM APIs.
 */
export interface TargetDescriptorResolver<TTarget = unknown> {
  resolve(target: TTarget): TargetDescriptor | undefined;
}

export class WebTargetDescriptorResolver implements TargetDescriptorResolver<Element> {
  resolve(element: Element): TargetDescriptor | undefined {
    try {
      const signature = computeElementSignature(element);
      return {
        componentName: element.tagName.toLowerCase(),
        ancestryHash: signature.sig,
        selector: signature.path,
      };
    } catch {
      return undefined;
    }
  }
}

export const webTargetDescriptorResolver = new WebTargetDescriptorResolver();
