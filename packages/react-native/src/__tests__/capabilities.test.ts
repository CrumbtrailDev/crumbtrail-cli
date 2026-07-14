import { describe, expect, it, vi } from "vitest";
import {
  detectReactNativeCapabilities,
  REACT_NATIVE_CAPABILITY_BITS,
} from "../capabilities";

describe("detectReactNativeCapabilities", () => {
  it("reports optional peer dependencies absent without throwing", () => {
    const capabilities = detectReactNativeCapabilities({
      resolver() {
        throw new Error("not installed");
      },
    });

    expect(capabilities.bitset).toBe(0);
    expect(capabilities.capabilities).toEqual([]);
    expect(capabilities.modules.asyncStorage.status).toBe("absent");
    expect(capabilities.modules.navigation.status).toBe("absent");
    expect(capabilities.modules.viewShot.status).toBe("absent");
  });

  it("reports mocked-present optional peer dependencies", () => {
    const resolver = vi.fn((packageName: string) => {
      if (packageName === "@react-native-async-storage/async-storage")
        return { default: {} };
      if (packageName === "react-native-view-shot")
        return { captureRef: vi.fn() };
      return undefined;
    });

    const capabilities = detectReactNativeCapabilities({ resolver });

    expect(capabilities.bitset).toBe(
      REACT_NATIVE_CAPABILITY_BITS.asyncStorage |
        REACT_NATIVE_CAPABILITY_BITS.viewShot,
    );
    expect(capabilities.capabilities).toEqual([
      "async-storage",
      "view-snapshot",
    ]);
    expect(capabilities.modules.asyncStorage.status).toBe("present");
    expect(capabilities.modules.navigation.status).toBe("absent");
    expect(capabilities.modules.viewShot.status).toBe("present");
    expect(resolver).toHaveBeenCalledWith("@react-navigation/native");
  });

  it("uses the default resolver safely in non-RN test environments", () => {
    expect(() => detectReactNativeCapabilities()).not.toThrow();
  });
});
