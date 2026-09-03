import { describe, expect, it, vi } from "vitest";
import {
  startReactNativeNativeDiagnostics,
  createReactNativeWatchdogHandoff,
} from "../native-diagnostics";
import type { ReactNativeCapabilities } from "../capabilities";
import { Crumbtrail } from "crumbtrail-core";

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
  return { addEvent: vi.fn(() => true) };
}

describe("React Native native diagnostics bridge", () => {
  it("retains a native batch until real core consent admission succeeds", async () => {
    vi.useFakeTimers();
    const target = Crumbtrail.init({
      consentMode: "required", environment: false, domSnapshot: false,
      console: false, errors: false, network: false, interactions: false,
      keystrokes: false, scroll: false, visibility: false, clipboard: false,
      cookies: false, storage: false, performance: false, video: false,
      audio: false, widget: false,
      sessionPersistence: "memory",
      transportInstance: { startSession: vi.fn(), endSession: vi.fn(), sendEvents: vi.fn(), sendBlob: vi.fn() } as any,
    });
    const acknowledgeDiagnostics = vi.fn(async () => true);
    const controller = startReactNativeNativeDiagnostics(target, capabilities, {
      module: {
        drainDiagnostics: async () => ({ token: "pending", events: [{ kind: "native-crash", data: { msg: "crash" } }] }),
        acknowledgeDiagnostics,
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(acknowledgeDiagnostics).not.toHaveBeenCalled();
      target.consent(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(acknowledgeDiagnostics).toHaveBeenCalledOnce();
    } finally {
      await controller.cleanup();
      await target.stop();
      vi.useRealTimers();
    }
  });
  it("reports an explicit absent capability when the optional module is missing", async () => {
    const target = logger();
    const controller = startReactNativeNativeDiagnostics(
      target as any,
      capabilities,
      {
        module: null,
      },
    );

    expect(controller.modulePresent).toBe(false);
    expect(target.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rn.native-capabilities",
        data: {
          native: expect.objectContaining({
            nativeDiagnostics: {
              supported: false,
              enabled: false,
              observed: false,
            },
          }),
        },
      }),
    );
  });

  it("drains bounded native events and ignores unknown or malformed payloads", async () => {
    const target = logger();
    const controller = startReactNativeNativeDiagnostics(
      target as any,
      capabilities,
      {
        module: {
          getCapabilities: async () => ({
            nativeDiagnostics: {
              supported: true,
              enabled: true,
              observed: true,
            },
            nativeHang: { supported: true, enabled: true, observed: true },
            nativeCrash: { supported: true, enabled: true, observed: false },
            appLifecycle: { supported: true, enabled: true, observed: true },
          }),
          drainDiagnostics: async () => ({
            token: "batch-1",
            events: [
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
              {
                kind: "native-crash",
                data: { msg: "boom", source: "previous-launch" },
              },
            ],
          }),
          acknowledgeDiagnostics: vi.fn(async () => true),
        },
      },
    );

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

    await controller.cleanup();
  });

  it("keeps a supported native module disabled without draining it", async () => {
    const target = logger();
    const setEnabled = vi.fn();
    const drainDiagnostics = vi.fn(async () => [
      { kind: "native-crash", data: { msg: "must not drain" } },
    ]);
    const controller = startReactNativeNativeDiagnostics(
      target as any,
      capabilities,
      {
        module: {
          setEnabled,
          getCapabilities: async () => ({
            nativeDiagnostics: {
              supported: true,
              enabled: true,
              observed: false,
            },
            nativeHang: { supported: true, enabled: true, observed: false },
            nativeCrash: { supported: true, enabled: true, observed: false },
            appLifecycle: { supported: true, enabled: true, observed: false },
          }),
          drainDiagnostics,
          acknowledgeDiagnostics: vi.fn(async () => true),
        },
        enabled: false,
      },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.modulePresent).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(drainDiagnostics).not.toHaveBeenCalled();
    expect(target.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rn.native-capabilities",
        data: {
          native: expect.objectContaining({
            nativeDiagnostics: {
              supported: true,
              enabled: false,
              observed: false,
            },
          }),
        },
      }),
    );
    await controller.cleanup();
    expect(setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("retains a native batch when the host acknowledgment fails", async () => {
    const target = logger();
    const acknowledgeDiagnostics = vi.fn(async () => false);
    const drainDiagnostics = vi.fn(async () => ({
      token: "batch-retry",
      events: [{ kind: "native-crash", data: { msg: "retry" } }],
    }));
    const controller = startReactNativeNativeDiagnostics(
      target as any,
      capabilities,
      { module: { drainDiagnostics, acknowledgeDiagnostics } },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(drainDiagnostics).toHaveBeenCalledOnce();
    expect(acknowledgeDiagnostics).toHaveBeenCalledWith("batch-retry");
    expect(target.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "native-crash" }),
    );
    await controller.cleanup();
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

    await expect(handoff.deliver(event, () => true)).resolves.toBe(true);
    await expect(handoff.drain(() => true)).resolves.toBe(false);
  });

  it("does not clear a handoff when persistence fails", async () => {
    const storage = {
      getItem: vi.fn(async () => "older"),
      setItem: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    };
    const handoff = createReactNativeWatchdogHandoff(storage);
    await expect(
      handoff.deliver({
        source: "js",
        thresholdMs: 5000,
        observedDurationMs: 6000,
        recovered: true,
        previousLaunch: false,
      }, () => true),
    ).resolves.toBe(false);
    expect(storage.setItem).toHaveBeenCalled();
  });

  it("does not let clearing an older event erase a newer pending event", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const handoff = createReactNativeWatchdogHandoff(storage);
    const older = {
      source: "js" as const,
      thresholdMs: 5000,
      observedDurationMs: 6000,
      recovered: true,
      previousLaunch: false,
    };
    const newer = { ...older, observedDurationMs: 7000 };

    await expect(handoff.deliver(older, () => false)).resolves.toBe(false);
    await expect(handoff.deliver(newer, () => true)).resolves.toBe(true);
    await expect(handoff.drain(() => true)).resolves.toBe(false);
  });

  it("keeps concurrent custom handoff operations serialized", async () => {
    const values = new Map<string, string>();
    const order: string[] = [];
    const storage = {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const handoff = createReactNativeWatchdogHandoff(storage);
    const older = {
      source: "js" as const,
      thresholdMs: 5000,
      observedDurationMs: 6000,
      recovered: true,
      previousLaunch: false,
    };
    const newer = { ...older, observedDurationMs: 7000 };

    const first = handoff.deliver(older, async () => {
      order.push("accept-older");
      return false;
    });
    const second = handoff.deliver(newer, async () => {
      order.push("accept-newer");
      return true;
    });

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(order).toEqual(["accept-older", "accept-newer"]);
    await expect(handoff.drain(() => true)).resolves.toBe(false);
  });
});
