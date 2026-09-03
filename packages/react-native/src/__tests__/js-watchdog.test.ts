import { afterEach, describe, expect, it, vi } from "vitest";
import { startReactNativeJsWatchdog } from "../js-watchdog";
import type { ReactNativeCapabilities } from "../capabilities";

const capabilities: ReactNativeCapabilities = {
  bitset: 0,
  capabilities: [],
  modules: {
    asyncStorage: { packageName: "async", present: false, status: "absent" },
    navigation: { packageName: "navigation", present: false, status: "absent" },
    viewShot: { packageName: "view-shot", present: false, status: "absent" },
  },
};

describe("React Native JavaScript event-loop watchdog", () => {
  afterEach(() => vi.useRealTimers());

  it("records one foreground stall and cleans up its timer and listener", () => {
    vi.useFakeTimers();
    const addEvent = vi.fn();
    let clock = 0;
    const remove = vi.fn();
    const appState = {
      currentState: "active",
      addEventListener: vi.fn(() => ({ remove })),
    };
    const controller = startReactNativeJsWatchdog({ addEvent } as any, {
      capabilities,
      appState,
      globalObject: { __DEV__: false } as any,
      thresholdMs: 5000,
      checkIntervalMs: 1000,
      now: () => clock,
    });

    clock = 6500;
    vi.advanceTimersByTime(1000);
    expect(addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "native-hang",
        data: expect.objectContaining({
          source: "js",
          thresholdMs: 5000,
          recovered: true,
          previousLaunch: false,
        }),
      }),
    );
    const eventCount = addEvent.mock.calls.length;
    clock = 7500;
    vi.advanceTimersByTime(1000);
    expect(addEvent).toHaveBeenCalledTimes(eventCount);

    controller.cleanup();
    expect(remove).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    expect(addEvent).toHaveBeenCalledTimes(eventCount);
  });

  it("does not report background time or development/debugger time", () => {
    vi.useFakeTimers();
    const addEvent = vi.fn();
    let listener: ((state: string) => void) | undefined;
    const controller = startReactNativeJsWatchdog({ addEvent } as any, {
      capabilities,
      appState: {
        currentState: "background",
        addEventListener: vi.fn((_type, next) => {
          listener = next;
          return { remove: vi.fn() };
        }),
      },
      globalObject: { __DEV__: true } as any,
      debuggerAttached: () => false,
    });

    vi.advanceTimersByTime(20_000);
    listener?.("active");
    vi.advanceTimersByTime(20_000);
    expect(addEvent).not.toHaveBeenCalled();
    controller.cleanup();
  });

  it("keeps a timer alive when the debugger is attached at startup", () => {
    vi.useFakeTimers();
    const addEvent = vi.fn();
    let clock = 0;
    let debuggerAttached = true;
    const controller = startReactNativeJsWatchdog({ addEvent } as any, {
      capabilities,
      globalObject: { __DEV__: false } as any,
      thresholdMs: 5000,
      checkIntervalMs: 1000,
      now: () => clock,
      debuggerAttached: () => debuggerAttached,
    });

    clock = 6500;
    vi.advanceTimersByTime(1000);
    expect(addEvent).not.toHaveBeenCalled();

    debuggerAttached = false;
    clock = 13000;
    vi.advanceTimersByTime(1000);
    expect(addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "native-hang" }),
    );
    controller.cleanup();
  });

  it("uses the runtime monotonic clock by default", () => {
    vi.useFakeTimers();
    const addEvent = vi.fn();
    let clock = 0;
    const controller = startReactNativeJsWatchdog({ addEvent } as any, {
      capabilities,
      globalObject: {
        __DEV__: false,
        performance: { now: () => clock },
      } as any,
      thresholdMs: 5000,
      checkIntervalMs: 1000,
    });

    clock = 6500;
    vi.advanceTimersByTime(1000);
    expect(addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "native-hang" }),
    );
    controller.cleanup();
  });
});
