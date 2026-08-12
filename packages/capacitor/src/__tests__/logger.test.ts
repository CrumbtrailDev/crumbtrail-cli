// @vitest-environment happy-dom
//
// Integration test for the real entry point.
//
// The collector tests drive `startCapacitorCollectors` with a fake logger, which
// proves the collectors but says nothing about whether they compose with
// `crumbtrail-core`. This file runs the actual `Crumbtrail.init` in a DOM (a
// Capacitor WebView is a DOM, so happy-dom is the honest environment) and
// asserts that native context reaches the same buffer as the web capture.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCapacitorCrumbtrail,
  createCapacitorCrumbtrailAsync,
  resolveCapacitorConfig,
} from "../logger";
import type { CrumbtrailConfig } from "crumbtrail-core";
import type { CapacitorPluginBundle, PluginListenerHandle } from "../plugins";

function listenerHub() {
  const listeners = new Map<
    string,
    ((event: Record<string, unknown>) => void)[]
  >();
  const addListener = async (
    eventName: string,
    listener: (event: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle> => {
    const bucket = listeners.get(eventName) ?? [];
    bucket.push(listener);
    listeners.set(eventName, bucket);
    return { remove: () => {} };
  };
  const fire = (eventName: string, event: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(eventName) ?? []) listener(event);
  };
  return { addListener, fire };
}

function plugins(
  hub: ReturnType<typeof listenerHub>,
  overrides: Partial<CapacitorPluginBundle> = {},
): CapacitorPluginBundle {
  return {
    Capacitor: { getPlatform: () => "ios", isNativePlatform: () => true },
    App: {
      addListener: hub.addListener,
      getState: async () => ({ isActive: true }),
      getInfo: async () => ({ id: "ai.crumbtrail.demo", version: "1.0.0" }),
    },
    Device: {
      getInfo: async () => ({ model: "iPhone15,2", osVersion: "18.2" }),
    },
    ...overrides,
  };
}

/**
 * In-memory session state by default, so one test cannot leak a session id into
 * the next. Note this does NOT make the logger offline — core falls back to a
 * default `http://localhost:9898` endpoint when none is configured, which is
 * why `fetch` is stubbed below rather than left to fail.
 */
const OFFLINE_CONFIG: Partial<CrumbtrailConfig> = {
  sessionPersistence: "memory",
};

/**
 * Swallow the transport.
 *
 * Without this the logger posts to core's default localhost endpoint, nothing
 * is listening, and the rejected fetches surface as unhandled rejections that
 * fail the run even though every assertion passed. Stubbing `fetch` keeps the
 * test genuinely offline instead of merely assuming it is.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCapacitorConfig", () => {
  it("defaults media capture off, which a phone pays for twice", () => {
    const config = resolveCapacitorConfig(undefined);
    expect(config.video).toBe(false);
    expect(config.audio).toBe(false);
  });

  it("leaves every web collector alone, because a WebView is a real DOM", () => {
    // The premise of this package is that it ADDS to the web capture rather
    // than replacing it, unlike the React Native SDK which has no DOM to
    // capture from and must switch every web collector off. If a future change
    // starts disabling these, the package has quietly become a downgrade for
    // every Ionic user — so assert on the exact key set, not just a few keys.
    expect(Object.keys(resolveCapacitorConfig(undefined)).sort()).toEqual([
      "audio",
      "video",
    ]);
  });

  it("lets the caller turn media capture back on", () => {
    expect(resolveCapacitorConfig({ video: true }).video).toBe(true);
  });

  it("does not let a default silently override caller config", () => {
    const config = resolveCapacitorConfig({ audio: true, console: false });
    expect(config.audio).toBe(true);
    expect(config.console).toBe(false);
  });
});

describe("createCapacitorCrumbtrail", () => {
  it("returns a live logger tagged with the concrete platform", async () => {
    const hub = listenerHub();
    const result = createCapacitorCrumbtrail({
      plugins: plugins(hub),
      config: OFFLINE_CONFIG,
      resolver: () => undefined,
    });

    expect(result.platform).toBe("ios");
    expect(result.logger).toBeDefined();
    await result.collectors.ready;
    await result.logger.stop();
  });

  it("removes native listeners when the logger is stopped", async () => {
    const removed: string[] = [];
    const hub = listenerHub();
    const result = createCapacitorCrumbtrail({
      plugins: plugins(hub, {
        App: {
          addListener: async (name) => ({
            remove: () => {
              removed.push(name);
            },
          }),
          getState: async () => ({ isActive: true }),
        },
      }),
      config: OFFLINE_CONFIG,
      resolver: () => undefined,
    });
    await result.collectors.ready;

    await result.logger.stop();
    expect(removed.length).toBeGreaterThan(0);
  });

  it("initialises with no plugins at all", async () => {
    const result = createCapacitorCrumbtrail({
      plugins: {},
      config: OFFLINE_CONFIG,
      resolver: () => undefined,
    });
    await result.collectors.ready;

    expect(result.platform).toBe("webview");
    await result.logger.stop();
  });
});

describe("createCapacitorCrumbtrailAsync", () => {
  it("restores a session id persisted by a previous launch", async () => {
    // `lastActivity` must be recent: core expires a session that has been idle
    // past its window, so a stale stored id correctly starts a new session
    // rather than stitching a bug onto last week's timeline.
    const stored = JSON.stringify({
      id: "sess-prev",
      lastActivity: Date.now(),
    });
    const hub = listenerHub();
    const result = await createCapacitorCrumbtrailAsync({
      plugins: plugins(hub, {
        Preferences: {
          get: async () => ({ value: stored }),
          set: async () => {},
        },
      }),
      config: OFFLINE_CONFIG,
      resolver: () => undefined,
    });

    // Continuity across cold starts is the entire reason the async entry point
    // exists; without it every launch is an unrelated one-event session.
    expect(result.logger.getSessionId?.()).toBe("sess-prev");
    await result.logger.stop();
  });

  it("resolves only once every collector has attached", async () => {
    const hub = listenerHub();
    const result = await createCapacitorCrumbtrailAsync({
      plugins: plugins(hub),
      config: OFFLINE_CONFIG,
      resolver: () => undefined,
    });

    // `ready` has already been awaited inside the async entry point, so firing
    // a plugin event immediately afterwards must be observed.
    await expect(result.collectors.ready).resolves.toBeUndefined();
    await result.logger.stop();
  });

  it("starts a fresh session when the persisted one has gone stale", async () => {
    const stored = JSON.stringify({ id: "sess-ancient", lastActivity: 1 });
    const hub = listenerHub();
    const result = await createCapacitorCrumbtrailAsync({
      plugins: plugins(hub, {
        Preferences: {
          get: async () => ({ value: stored }),
          set: async () => {},
        },
      }),
      config: OFFLINE_CONFIG,
      resolver: () => undefined,
    });

    expect(result.logger.getSessionId?.()).not.toBe("sess-ancient");
    await result.logger.stop();
  });

  it("still initialises when Preferences is absent", async () => {
    const hub = listenerHub();
    const result = await createCapacitorCrumbtrailAsync({
      plugins: plugins(hub),
      config: OFFLINE_CONFIG,
      resolver: () => undefined,
    });

    expect(result.logger).toBeDefined();
    await result.logger.stop();
  });
});
