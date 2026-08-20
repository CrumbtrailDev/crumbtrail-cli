// @vitest-environment node
//
// React Native is the third environment core has to survive, after a browser
// and SSR, and it is the one that looks most like a browser without being one.
// RN's `setUpGlobals` does `global.window = global`, so `typeof window` is
// "object" and the SSR escape hatch at the top of init() never fires — but that
// global carries no `addEventListener` and RN never defines a `document`
// instance (it polyfills the DOM *classes* only).
//
// The shape below is exactly that: a `window` that is the global object, with
// `fetch` and a `navigator`, and nothing else a DOM would bring. Every throw
// this file catches is a red screen on the first launch after `npx crumbtrail`,
// because the wizard prepends an un-caught `createReactNativeCrumbtrail(...)`
// at the top of the app entry file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../bug-logger";
import type { CrumbtrailConfig } from "../types";

/**
 * The collectors `crumbtrail-react-native` switches off, because they bind DOM
 * event targets that RN does not have. Whether that list is still the right one
 * is pinned in the RN package's own suite; here it only sets the stage, so that
 * what this file asserts is the part core owns: the two bindings that run
 * REGARDLESS of collector config — init()'s `pagehide` hook, and the `errors`
 * collector, which RN leaves on for its own `ErrorUtils` capture.
 */
const RN_DISABLED_DOM_COLLECTORS: Partial<CrumbtrailConfig> = {
  network: false,
  interactions: false,
  keystrokes: false,
  scroll: false,
  visibility: false,
  clipboard: false,
  cookies: false,
  storage: false,
  performance: false,
  video: false,
  audio: false,
  widget: false,
};

/** RN's global: `window === global`, no `addEventListener`, no `document`. */
function reactNativeGlobals(): void {
  vi.stubGlobal("navigator", { product: "ReactNative" });
  vi.stubGlobal("window", globalThis);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Crumbtrail.init() in a React Native runtime", () => {
  it("does not throw when window exists but has no addEventListener and there is no document", () => {
    reactNativeGlobals();
    expect(typeof window).toBe("object");
    expect(
      typeof (window as unknown as Record<string, unknown>).addEventListener,
    ).toBe("undefined");
    expect(typeof document).toBe("undefined");

    expect(() =>
      Crumbtrail.init({
        ...RN_DISABLED_DOM_COLLECTORS,
        httpEndpoint: "https://example.com",
        httpAuthToken: "ctkey_rn",
      }),
    ).not.toThrow();
  });

  it("still captures: addEvent works and the session id is real", () => {
    reactNativeGlobals();
    const logger = Crumbtrail.init({
      ...RN_DISABLED_DOM_COLLECTORS,
      httpEndpoint: "https://example.com",
      httpAuthToken: "ctkey_rn",
    });
    expect(logger.getSessionId()).toMatch(/^ses_/);
    expect(() =>
      logger.addEvent({ type: "err", data: { msg: "boom" } }),
    ).not.toThrow();
  });
});
