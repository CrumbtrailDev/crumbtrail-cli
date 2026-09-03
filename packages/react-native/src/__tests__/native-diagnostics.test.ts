import { describe, expect, it, vi } from "vitest";
import {
  startReactNativeNativeDiagnostics,
  createReactNativeWatchdogHandoff,
} from "../native-diagnostics";
import type { ReactNativeCapabilities } from "../capabilities";

const capabilities: ReactNativeCapabilities = {
  bitset: 0,
  capabilities: [],
  modules: {
    asyncStorage: {
      packageName: "@react-native-async-storage/async-storage",
      present: false,
      status: "absent",
    },
    navigation: {
      packageName: "@react-navigation/native",
      present: false,
      status: "absent",
    },
    viewShot: {
      packageName: "react-native-view-shot",
      present: false,
      status: "absent",
    },
  },
};

function logger() {
  return { addEvent: vi.fn() };
}

describe("React Native native diagnostics bridge", () => {
  it("reports an explicit absent capability when the optional module is missing", async () => {
    const target = logger();
    const controller = startReactNativeNativeDiagnostics(target as any, capabilities, {
      module: null,
    });

    expect(controller.modulePresent).toBe(false);
    expect(target.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rn.native-capabilities",
        data: {
          native: expect.objectContaining({
            nativeDiagnostics: { supported: false, enabled: false, observed: false },
          }),
        },
      }),
    );
  });

  it("drains bounded native events and ignores unknown or malformed payloads", async () => {
    const target = logger();
    const controller = startReactNativeNativeDiagnostics(target as any, capabilities, {
      module: {
        getCapabilities: async () => ({
          nativeDiagnostics: { supported: true, enabled: true, observed: true },
          nativeHang: { supported: true, enabled: true, observed: true },
          nativeCrash: { supported: true, enabled: true, observed: false },
          appLifecycle: { supported: true, enabled: true, observed: true },
        }),
        drainDiagnostics: async () => [
          {
            kind: "native-hang",
            data: {
              source: "main-thread",
              thresholdMs: 5000,
              observedDurationMs: 7420,
              recovered: false,
              previousLaunch: true,
              stk: "Checkout.submit()",
            },
          },
          { kind: "native-crash", data: { msg: "boom", source: "previous-launch" } },
          { kind: "unknown", data: {} },
          { kind: "native-hang", data: { source: "main-thread" } },
        ],
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.modulePresent).toBe(true);
    expect(target.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "native-hang" }),
    );
    expect(target.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "native-crash",
        data: { msg: "boom", source: "previous-launch" },
      }),
    );
    expect(target.addEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "unknown" }),
    );

    controller.cleanup();
  });

  it("keeps the AsyncStorage handoff bounded and non-throwing", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const handoff = createReactNativeWatchdogHandoff(storage);
    const event = {
      source: "js" as const,
      thresholdMs: 5000,
      observedDurationMs: 6000,
      recovered: true,
      previousLaunch: false,
    };

    await handoff.write(event);
    await expect(handoff.read()).resolves.toEqual(event);
    await handoff.clear();
    await expect(handoff.read()).resolves.toBeUndefined();
  });
});
