import { describe, expect, it, vi } from "vitest";
import { startReactNativeCollectors } from "../collectors";
import type { ReactNativeCapabilities } from "../capabilities";

const capabilities: ReactNativeCapabilities = {
  bitset: 0,
  capabilities: ["navigation", "view-snapshot"],
  modules: {
    asyncStorage: {
      packageName: "@react-native-async-storage/async-storage",
      present: false,
      status: "absent",
    },
    navigation: {
      packageName: "@react-navigation/native",
      present: true,
      status: "present",
    },
    viewShot: {
      packageName: "react-native-view-shot",
      present: true,
      status: "present",
    },
  },
};

function logger() {
  return {
    addEvent: vi.fn(),
    stop: vi.fn(async () => ({ sessionId: "ses_test" })),
  };
}

describe("startReactNativeCollectors", () => {
  it("emits environment, app lifecycle, navigation, console, and replay-lite events", () => {
    const testLogger = logger();
    const originalLog = vi.fn();
    const globalObject = {
      console: {
        log: originalLog,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
      },
    } as unknown as typeof globalThis & Record<string, unknown>;
    let appStateListener: ((state: string) => void) | undefined;
    const reactNative = {
      AppState: {
        currentState: "active",
        addEventListener: vi.fn((_type, listener) => {
          appStateListener = listener;
          return { remove: vi.fn() };
        }),
      },
      Platform: {
        OS: "ios",
        Version: "17.0",
        constants: { appOwnership: "expo" },
      },
      Dimensions: {
        get: vi.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 })),
      },
    };
    let navigationListener: (() => void) | undefined;
    const navigation = {
      getCurrentRoute: vi.fn(() => ({
        name: "Home",
        path: "/home",
        key: "home-1",
      })),
      addListener: vi.fn((_event, listener) => {
        navigationListener = listener;
        return { remove: vi.fn() };
      }),
    };

    const controller = startReactNativeCollectors(testLogger as any, {
      capabilities,
      config: {
        errors: false,
        network: false,
      },
      globalObject,
      reactNative,
      navigation,
      resolver(packageName) {
        return packageName === "react-native-view-shot"
          ? { captureScreen: vi.fn(async () => "file://shot.jpg") }
          : undefined;
      },
    });

    globalObject.console.log("hello", { count: 1 });
    appStateListener?.("background");
    navigationListener?.();
    controller.replayLite!.recordViewSnapshot({
      routePath: "/home",
      root: {
        componentName: "Screen",
        children: [{ componentName: "Button", testID: "save" }],
      },
    });
    controller.replayLite!.recordTouch({
      x: 12,
      y: 34,
      target: { role: "button", testID: "save", componentName: "Pressable" },
    });

    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "env",
        platform: "react-native",
        sdk: { name: "crumbtrail-react-native" },
        capabilities: ["navigation", "view-snapshot"],
      }),
    );
    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "app-lifecycle",
        data: expect.objectContaining({ state: "background" }),
      }),
    );
    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "navigation",
        data: expect.objectContaining({ name: "Home" }),
      }),
    );
    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "con",
        data: expect.objectContaining({ lv: "log" }),
      }),
    );
    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "view-snapshot",
        data: expect.objectContaining({ kind: "component-tree" }),
      }),
    );
    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "touch",
        target: expect.objectContaining({ role: "button", testID: "save" }),
      }),
    );
    expect(originalLog).toHaveBeenCalledWith("hello", { count: 1 });

    controller.cleanup();
  });

  it("patches fetch and restores globals on cleanup", async () => {
    const testLogger = logger();
    const originalFetch = vi.fn(
      async () => new Response("ok", { status: 201 }),
    );
    const globalObject = {
      console,
      fetch: originalFetch,
    } as unknown as typeof globalThis & Record<string, unknown>;

    const controller = startReactNativeCollectors(testLogger as any, {
      capabilities,
      config: {
        console: false,
        errors: false,
        appState: false,
        environment: false,
        navigation: false,
        replayLite: false,
      },
      globalObject,
    });

    await globalObject.fetch("https://example.test/api", { method: "POST" });
    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "net",
        data: expect.objectContaining({
          url: "https://example.test/api",
          method: "POST",
          status: 201,
        }),
      }),
    );

    controller.cleanup();
    expect(globalObject.fetch).toBe(originalFetch);
  });

  it("captures global errors when ErrorUtils is available and degrades when it is absent", () => {
    const testLogger = logger();
    let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    const previous = vi.fn();
    const errorUtils = {
      getGlobalHandler: vi.fn(() => previous),
      setGlobalHandler: vi.fn((next) => {
        handler = next;
      }),
    };

    const controller = startReactNativeCollectors(testLogger as any, {
      capabilities,
      config: {
        console: false,
        network: false,
        appState: false,
        environment: false,
        navigation: false,
        replayLite: false,
      },
      errorUtils,
    });

    handler?.(new Error("boom"), true);
    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "err",
        data: expect.objectContaining({ msg: "boom", fatal: true }),
      }),
    );
    expect(previous).toHaveBeenCalled();

    controller.cleanup();
    expect(errorUtils.setGlobalHandler).toHaveBeenLastCalledWith(previous);

    expect(() =>
      startReactNativeCollectors(testLogger as any, {
        capabilities,
        config: {
          errors: true,
          console: false,
          network: false,
          appState: false,
          environment: false,
          navigation: false,
          replayLite: false,
        },
        errorUtils: null,
      }).cleanup(),
    ).not.toThrow();
  });

  it("skips missing console methods and non-restorable ErrorUtils patches", () => {
    const testLogger = logger();
    const globalObject = {
      console: { log: vi.fn() },
    } as unknown as typeof globalThis & Record<string, unknown>;
    const errorUtilsWithoutGetter = {
      setGlobalHandler: vi.fn(),
    };
    const errorUtilsWithoutPrevious = {
      getGlobalHandler: vi.fn(() => undefined),
      setGlobalHandler: vi.fn(),
    };

    const controller = startReactNativeCollectors(testLogger as any, {
      capabilities,
      config: {
        network: false,
        appState: false,
        environment: false,
        navigation: false,
        replayLite: false,
      },
      globalObject,
      errorUtils: errorUtilsWithoutGetter,
    });

    globalObject.console.log("safe");
    controller.cleanup();

    expect(testLogger.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "con",
        data: expect.objectContaining({ args: ["safe"] }),
      }),
    );
    expect(errorUtilsWithoutGetter.setGlobalHandler).not.toHaveBeenCalled();
    expect(() =>
      startReactNativeCollectors(testLogger as any, {
        capabilities,
        config: {
          console: false,
          errors: true,
          network: false,
          appState: false,
          environment: false,
          navigation: false,
          replayLite: false,
        },
        errorUtils: errorUtilsWithoutPrevious,
      }).cleanup(),
    ).not.toThrow();
    expect(errorUtilsWithoutPrevious.setGlobalHandler).not.toHaveBeenCalled();
    expect(() =>
      startReactNativeCollectors(testLogger as any, {
        capabilities,
        config: {
          console: true,
          errors: false,
          network: false,
          appState: false,
          environment: false,
          navigation: false,
          replayLite: false,
        },
        globalObject: {} as typeof globalThis & Record<string, unknown>,
      }).cleanup(),
    ).not.toThrow();
  });
});
