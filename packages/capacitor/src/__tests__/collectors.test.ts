import { describe, expect, it, vi } from "vitest";
import type { Crumbtrail } from "crumbtrail-core";
import {
  resolveCapacitorPlatform,
  startCapacitorCollectors,
} from "../collectors";
import type { CapacitorCapabilities } from "../capabilities";
import type { CapacitorPluginBundle, PluginListenerHandle } from "../plugins";

interface RecordedEvent {
  type: string;
  data: Record<string, unknown>;
  platform?: string;
  sdk?: { name: string };
  capabilities?: string[];
}

function fakeLogger(): { logger: Crumbtrail; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const logger = {
    addEvent: (event: RecordedEvent) => {
      events.push(event);
    },
  } as unknown as Crumbtrail;
  return { logger, events };
}

const CAPABILITIES: CapacitorCapabilities = {
  bitset: 0,
  capabilities: ["app-lifecycle", "device-info"],
  modules: {} as CapacitorCapabilities["modules"],
};

/** A listener registry that lets a test fire plugin events by name. */
function listenerHub() {
  const listeners = new Map<
    string,
    ((event: Record<string, unknown>) => void)[]
  >();
  const removed: string[] = [];
  const addListener = vi.fn(
    async (
      eventName: string,
      listener: (event: Record<string, unknown>) => void,
    ): Promise<PluginListenerHandle> => {
      const bucket = listeners.get(eventName) ?? [];
      bucket.push(listener);
      listeners.set(eventName, bucket);
      return {
        remove: () => {
          removed.push(eventName);
        },
      };
    },
  );
  const fire = (eventName: string, event: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(eventName) ?? []) listener(event);
  };
  return { addListener, fire, removed, listeners };
}

function start(plugins: CapacitorPluginBundle, config?: never) {
  const { logger, events } = fakeLogger();
  const controller = startCapacitorCollectors(logger, {
    capabilities: CAPABILITIES,
    plugins,
    config,
  });
  return { events, controller };
}

describe("resolveCapacitorPlatform", () => {
  it("reports the concrete OS so sessions can be filtered to one platform", () => {
    expect(resolveCapacitorPlatform({ getPlatform: () => "ios" })).toBe("ios");
    expect(resolveCapacitorPlatform({ getPlatform: () => "android" })).toBe(
      "android",
    );
  });

  it("falls back to webview for the browser target and for a missing plugin", () => {
    expect(resolveCapacitorPlatform({ getPlatform: () => "web" })).toBe(
      "webview",
    );
    expect(resolveCapacitorPlatform(undefined)).toBe("webview");
  });

  it("does not propagate a throwing getPlatform", () => {
    expect(
      resolveCapacitorPlatform({
        getPlatform: () => {
          throw new Error("bridge not ready");
        },
      }),
    ).toBe("webview");
  });
});

describe("environment collector", () => {
  it("emits one snapshot carrying device, app, battery and WebView version", async () => {
    const { events, controller } = start({
      Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
      Device: {
        getInfo: async () => ({
          model: "Pixel 8",
          manufacturer: "Google",
          operatingSystem: "android",
          osVersion: "15",
          webViewVersion: "129.0.6668.70",
          isVirtual: false,
        }),
        getBatteryInfo: async () => ({ batteryLevel: 0.42, isCharging: false }),
        getLanguageTag: async () => ({ value: "en-GB" }),
      },
      App: {
        getInfo: async () => ({
          id: "ai.crumbtrail.demo",
          name: "Demo",
          version: "1.4.0",
          build: "204",
        }),
      },
    });
    await controller.ready;

    const env = events.filter((event) => event.type === "env");
    expect(env).toHaveLength(1);
    expect(env[0].platform).toBe("android");
    expect(env[0].sdk).toEqual({ name: "crumbtrail-capacitor" });
    expect(env[0].data.device).toMatchObject({
      model: "Pixel 8",
      osVersion: "15",
      webViewVersion: "129.0.6668.70",
    });
    expect(env[0].data.app).toMatchObject({ version: "1.4.0", build: "204" });
    expect(env[0].data.battery).toEqual({ level: 0.42, charging: false });
    expect(env[0].data.locale).toBe("en-GB");
  });

  // Build.MODEL and its siblings are platform build properties: a rooted or
  // emulated device can set them to anything. They are bounded, not redacted --
  // naming the device is the whole point of the snapshot.
  it("bounds device identifier strings without redacting them", async () => {
    const { events, controller } = start({
      Device: {
        getInfo: async () => ({
          model: "M".repeat(5000),
          manufacturer: "Google",
          operatingSystem: "android",
          osVersion: "15",
          webViewVersion: "129.0.6668.70",
        }),
      },
    });
    await controller.ready;

    const device = events[0].data.device as Record<string, unknown>;
    expect((device.model as string).length).toBe(128);
    expect(device.manufacturer).toBe("Google");
    expect(device.webViewVersion).toBe("129.0.6668.70");
  });

  it("still emits a snapshot when every device call rejects", async () => {
    const { events, controller } = start({
      Device: {
        getInfo: async () => {
          throw new Error("no bridge");
        },
        getBatteryInfo: async () => {
          throw new Error("no bridge");
        },
      },
    });
    await controller.ready;

    const env = events.filter((event) => event.type === "env");
    expect(env).toHaveLength(1);
    expect(env[0].data.device).toBeUndefined();
    expect(env[0].data.runtime).toMatchObject({ container: "capacitor" });
  });
});

describe("app lifecycle collector", () => {
  it("records the initial state and every later transition", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: {
        addListener: hub.addListener,
        getState: async () => ({ isActive: true }),
      },
    });
    await controller.ready;

    hub.fire("appStateChange", { isActive: false });
    hub.fire("appStateChange", { isActive: true });

    const lifecycle = events.filter((e) => e.type === "app-lifecycle");
    expect(lifecycle.map((e) => e.data.state)).toEqual([
      "active",
      "background",
      "active",
    ]);
    expect(lifecycle[0].data.kind).toBe("initial");
  });

  it("records native pause and resume separately from appStateChange", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: { addListener: hub.addListener },
    });
    await controller.ready;

    hub.fire("pause");
    hub.fire("resume");

    const sources = events
      .filter((e) => e.type === "app-lifecycle")
      .map((e) => e.data.source);
    expect(sources).toContain("pause");
    expect(sources).toContain("resume");
  });
});

describe("network collector", () => {
  it("emits the initial radio state and each change", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      Network: {
        addListener: hub.addListener,
        getStatus: async () => ({ connected: true, connectionType: "wifi" }),
      },
    });
    await controller.ready;

    hub.fire("networkStatusChange", {
      connected: false,
      connectionType: "none",
    });

    const status = events.filter((e) => e.type === "net-status");
    expect(status).toHaveLength(2);
    expect(status[0].data).toMatchObject({
      connected: true,
      type: "wifi",
      kind: "initial",
    });
    expect(status[1].data).toMatchObject({ connected: false, type: "none" });
  });
});

describe("deep link collector", () => {
  // These two cases assert that a credential-free link survives redaction
  // intact. They used to read as "the URL arrives verbatim", but their
  // fixtures carry no query string, fragment or credentials, so `redactUrl`
  // was always a no-op on them and they never covered the leak. They are kept
  // as the no-op side of the contract; the cases below cover the other side.
  it("captures the cold-start launch URL, which no listener can see", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: {
        addListener: hub.addListener,
        getLaunchUrl: async () => ({ url: "demo://orders/42" }),
      },
    });
    await controller.ready;

    const nav = events.filter((e) => e.type === "navigation");
    expect(nav).toHaveLength(1);
    expect(nav[0].data).toMatchObject({
      url: "demo://orders/42",
      kind: "cold-start",
    });
    expect(nav[0].data.redaction).toBeUndefined();
  });

  it("captures links opened while the app is already running", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: { addListener: hub.addListener },
    });
    await controller.ready;

    hub.fire("appUrlOpen", { url: "demo://settings" });

    const nav = events.filter((e) => e.type === "navigation");
    expect(nav[0].data).toMatchObject({
      url: "demo://settings",
      source: "appUrlOpen",
    });
  });

  // A deep link is where OAuth callback codes, magic link tokens, password
  // reset tokens, invite codes and session ids reach a mobile app. Redaction
  // is delegated to core's shared `redactUrl`, so these assert that the
  // collector calls it and reports what it did, not the engine's own rules.
  it("redacts credentials out of a cold-start OAuth callback", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: {
        addListener: hub.addListener,
        getLaunchUrl: async () => ({
          url: "demo://auth/callback?code=4/0AY0e-g7abcdef&state=xyz",
        }),
      },
    });
    await controller.ready;

    const nav = events.filter((e) => e.type === "navigation")[0];
    const url = nav.data.url as string;
    expect(url).not.toContain("4/0AY0e-g7abcdef");
    expect(url).toContain("demo://auth/callback");
    expect(nav.data.redaction).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ path: "url.query.code" }),
      ]),
    });
  });

  it("drops the fragment, where implicit-flow tokens ride", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: { addListener: hub.addListener },
    });
    await controller.ready;

    hub.fire("appUrlOpen", {
      url: "https://app.example.com/magic#access_token=ya29.secret",
    });

    const nav = events.filter((e) => e.type === "navigation")[0];
    expect(nav.data.url).toBe("https://app.example.com/magic");
    expect(nav.data.redaction).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ path: "url.hash", action: "dropped" }),
      ]),
    });
  });

  it("strips credentials embedded in the deep link authority", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: { addListener: hub.addListener },
    });
    await controller.ready;

    hub.fire("appUrlOpen", { url: "demo://user:pass@host/path" });

    const nav = events.filter((e) => e.type === "navigation")[0];
    expect(nav.data.url).not.toContain("pass");
    expect(nav.data.redaction).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ path: "url.credentials" }),
      ]),
    });
  });

  // The URL is handed to the app by the OS, so its length is chosen by whoever
  // crafted the link. Without the bound one hostile link dominates the payload.
  it("bounds an oversized link and says that it did", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: { addListener: hub.addListener },
    });
    await controller.ready;

    hub.fire("appUrlOpen", { url: `demo://x/${"a".repeat(9000)}` });

    const nav = events.filter((e) => e.type === "navigation")[0];
    expect((nav.data.url as string).length).toBeLessThanOrEqual(2048);
    expect(nav.data.redaction).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          reason: "url_truncated",
          action: "summarized",
        }),
      ]),
    });
  });

  it("still records that a link opened when the OS supplies no URL", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: { addListener: hub.addListener },
    });
    await controller.ready;

    hub.fire("appUrlOpen", {});

    const nav = events.filter((e) => e.type === "navigation")[0];
    expect(nav.data).toMatchObject({ url: undefined, source: "appUrlOpen" });
  });

  it("records an OS-restored plugin result as a lifecycle event", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: { addListener: hub.addListener },
    });
    await controller.ready;

    hub.fire("appRestoredResult", {
      pluginId: "Camera",
      methodName: "getPhoto",
    });

    const restored = events.find((e) => e.data.state === "restored");
    expect(restored?.data).toMatchObject({
      pluginId: "Camera",
      methodName: "getPhoto",
    });
  });
});

describe("back button collector", () => {
  it("observes the press without consuming it", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      App: { addListener: hub.addListener },
    });
    await controller.ready;

    const preventDefault = vi.fn();
    hub.fire("backButton", { canGoBack: true, preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    const intent = events.find((e) => e.type === "nav-intent");
    expect(intent?.data).toMatchObject({ action: "back", canGoBack: true });
  });
});

describe("orientation collector", () => {
  it("emits the initial orientation and each rotation", async () => {
    const hub = listenerHub();
    const { events, controller } = start({
      ScreenOrientation: {
        addListener: hub.addListener,
        orientation: async () => ({ type: "portrait-primary" }),
      },
    });
    await controller.ready;

    hub.fire("screenOrientationChange", { type: "landscape-primary" });

    const orientation = events.filter((e) => e.data.kind === "orientation");
    expect(orientation.map((e) => e.data.orientation)).toEqual([
      "portrait-primary",
      "landscape-primary",
    ]);
  });
});

describe("collector configuration and teardown", () => {
  it("attaches nothing when collectors are disabled wholesale", async () => {
    const hub = listenerHub();
    const { events, controller } = start(
      { App: { addListener: hub.addListener }, Device: {} },
      false as never,
    );
    await controller.ready;

    expect(events).toHaveLength(0);
    expect(hub.addListener).not.toHaveBeenCalled();
  });

  it("removes every plugin listener on cleanup", async () => {
    const hub = listenerHub();
    const { controller } = start({
      App: { addListener: hub.addListener },
      Network: { addListener: hub.addListener, getStatus: async () => ({}) },
    });
    await controller.ready;

    const attached = hub.addListener.mock.calls.length;
    expect(attached).toBeGreaterThan(0);
    controller.cleanup();
    expect(hub.removed).toHaveLength(attached);
  });

  it("survives a plugin whose addListener rejects", async () => {
    const { controller, events } = start({
      App: {
        addListener: async () => {
          throw new Error("not implemented on this platform");
        },
        getState: async () => ({ isActive: true }),
      },
    });

    await expect(controller.ready).resolves.toBeUndefined();
    expect(events.some((e) => e.type === "app-lifecycle")).toBe(true);
  });

  it("emits nothing at all when no plugins are installed", async () => {
    const { controller, events } = start({});
    await controller.ready;

    // The environment collector always reports, since it can describe the
    // runtime container even with no Device plugin. Nothing else should fire.
    expect(events.map((e) => e.type)).toEqual(["env"]);
  });
});
