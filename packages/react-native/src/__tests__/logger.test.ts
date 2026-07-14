import { afterEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const stop = vi.fn(async () => ({ sessionId: "ses_test" }));

vi.mock("crumbtrail-core", () => ({
  DEFAULT_SESSION_STORAGE_KEY: "__crumbtrail_session",
  Crumbtrail: {
    init,
  },
}));

describe("createReactNativeCrumbtrail", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes the shared Crumbtrail pipeline with RN-safe defaults and reports capabilities", async () => {
    const addEvent = vi.fn();
    init.mockReturnValue({ addEvent, stop });
    const { createReactNativeCrumbtrail } = await import("../logger");

    const result = createReactNativeCrumbtrail({
      resolver(packageName) {
        return packageName === "@react-navigation/native"
          ? { NavigationContainer: {} }
          : undefined;
      },
      config: { httpEndpoint: "http://127.0.0.1:9898" },
      collectors: false,
    });

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        httpEndpoint: "http://127.0.0.1:9898",
        network: false,
        interactions: false,
        storage: false,
        sessionPersistence: "session",
      }),
    );
    expect(addEvent).toHaveBeenCalledWith({
      type: "rn.capabilities",
      data: expect.objectContaining({
        bitset: 2,
        capabilities: ["navigation"],
      }),
      platform: "react-native",
      sdk: { name: "crumbtrail-react-native" },
      capabilities: ["navigation"],
    });
    expect(result.capabilities.modules.navigation.status).toBe("present");
  });

  it("passes an AsyncStorage-like session store into core config when provided", async () => {
    const addEvent = vi.fn();
    init.mockReturnValue({ addEvent, stop });
    const { createReactNativeCrumbtrail } = await import("../logger");
    const asyncStorage = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => {}),
    };

    createReactNativeCrumbtrail({
      asyncStorage,
      reportCapabilities: false,
      collectors: false,
    });

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionStore: expect.objectContaining({
          read: expect.any(Function),
          write: expect.any(Function),
          hydrate: expect.any(Function),
        }),
      }),
    );
    expect(addEvent).not.toHaveBeenCalled();
  });

  it("hydrates AsyncStorage before initializing the shared Crumbtrail pipeline", async () => {
    const addEvent = vi.fn();
    init.mockReturnValue({ addEvent, stop });
    const { createReactNativeCrumbtrailAsync } = await import("../logger");
    const asyncStorage = {
      getItem: vi.fn(async () =>
        JSON.stringify({ id: "ses_persisted", lastActivity: Date.now() }),
      ),
      setItem: vi.fn(async () => {}),
    };

    await createReactNativeCrumbtrailAsync({
      asyncStorage,
      reportCapabilities: false,
      collectors: false,
    });

    expect(asyncStorage.getItem).toHaveBeenCalledWith("__crumbtrail_session");
    const config = init.mock.calls[0][0];
    expect(config.sessionStore.read()).toEqual(
      expect.objectContaining({ id: "ses_persisted" }),
    );
  });
});
