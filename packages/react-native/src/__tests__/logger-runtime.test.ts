// The entry point, against the real `crumbtrail-core`.
//
// `logger.test.ts` mocks `crumbtrail-core` wholesale, so it proves what config
// this package hands over and nothing about whether core survives being handed
// it. That gap is why an RN app could red-screen on `createReactNativeCrumbtrail`
// while this package's suite stayed green: the wizard prepends an un-caught call
// to it at the top of the entry file, so anything init() throws lands before the
// app's own code runs.
//
// The environment below is React Native's, not a browser's and not Node's.
// `setUpGlobals` does `global.window = global`, so `typeof window` is "object"
// while that object has no `addEventListener`, and RN polyfills the DOM classes
// without ever defining a `document` instance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactNativeCrumbtrail } from "../logger";
import type { BugEvent, CrumbtrailTransport } from "crumbtrail-core";

function reactNativeGlobals(): void {
  vi.stubGlobal("navigator", { product: "ReactNative" });
  vi.stubGlobal("window", globalThis);
}

/**
 * Read the wire, not an internal. Core exposes no event buffer, and the wire is
 * the honest place to assert from anyway: it is what an RN app actually sends.
 */
function capturingTransport(): CrumbtrailTransport & { sent: BugEvent[] } {
  const sent: BugEvent[] = [];
  return {
    sent,
    async sendEvents(events) {
      sent.push(...events);
    },
    async sendBlob() {},
    async startSession() {},
    async endSession() {},
    async sendBugReport() {},
  };
}

beforeEach(() => {
  // Nothing is listening on core's default endpoint, and an unhandled rejected
  // fetch fails the run even when every assertion passed.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createReactNativeCrumbtrail on a React Native global", () => {
  it("starts without throwing", () => {
    reactNativeGlobals();
    expect(typeof window).toBe("object");
    expect(
      typeof (window as unknown as Record<string, unknown>).addEventListener,
    ).toBe("undefined");
    expect(typeof document).toBe("undefined");

    expect(() =>
      createReactNativeCrumbtrail({
        config: { httpEndpoint: "http://127.0.0.1:9898" },
        resolver: () => undefined,
        collectors: false,
      }),
    ).not.toThrow();
  });

  it("captures through the real core pipeline once started", async () => {
    reactNativeGlobals();
    const transport = capturingTransport();
    const { logger } = createReactNativeCrumbtrail({
      config: {
        httpEndpoint: "http://127.0.0.1:9898",
        transportInstance: transport,
      },
      resolver: () => undefined,
      collectors: false,
    });

    expect(logger.getSessionId()).toMatch(/^ses_/);
    logger.addEvent({ type: "err", data: { msg: "boom" } });
    // `stop()` flushes what it has before it closes the session.
    await logger.stop();
    expect(transport.sent.some((event) => event.k === "err")).toBe(true);
  });

  it("leaves core's DOM error collector off, because RN reports through ErrorUtils", async () => {
    reactNativeGlobals();
    const globalObject = globalThis as typeof globalThis &
      Record<string, unknown>;
    // RN always has a global handler installed before any SDK runs, and the
    // collector chains to it rather than replacing it, so it declines to
    // install when there is none to chain to.
    let handler:
      ((error: unknown, isFatal?: boolean) => void) | undefined = () => {};
    const errorUtils = {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next: (error: unknown, isFatal?: boolean) => void) => {
        handler = next;
      },
    };

    const transport = capturingTransport();
    const { logger } = createReactNativeCrumbtrail({
      config: {
        httpEndpoint: "http://127.0.0.1:9898",
        transportInstance: transport,
      },
      resolver: () => undefined,
      globalObject,
      errorUtils,
      collectors: {
        console: false,
        network: false,
        environment: false,
        appState: false,
        navigation: false,
        replayLite: false,
      },
    });

    handler?.(new Error("thrown"), true);
    // `stop()` flushes what it has before it closes the session.
    await logger.stop();
    const errs = transport.sent.filter((event) => event.k === "err");
    expect(errs).toHaveLength(1);
    expect(errs[0]?.d).toMatchObject({ msg: "thrown", fatal: true });
  });
});
