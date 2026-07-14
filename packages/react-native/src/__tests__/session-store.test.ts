import { describe, expect, it, vi } from "vitest";
import { createReactNativeSessionStore } from "../session-store";

describe("createReactNativeSessionStore", () => {
  it("accepts an AsyncStorage-like object and never exposes async throws to core", async () => {
    const setItem = vi.fn(async () => {});
    const storage = {
      getItem: vi.fn(async () =>
        JSON.stringify({ id: "ses_existing", lastActivity: 123 }),
      ),
      setItem,
    };
    const store = createReactNativeSessionStore(storage);

    expect(store).toBeDefined();
    expect(store!.read()).toBeUndefined();
    await expect(store!.hydrate()).resolves.toEqual({
      id: "ses_existing",
      lastActivity: 123,
    });
    expect(store!.read()).toEqual({ id: "ses_existing", lastActivity: 123 });

    store!.write({ id: "ses_next", lastActivity: 456 });

    expect(setItem).toHaveBeenCalledWith(
      "__crumbtrail_session",
      JSON.stringify({ id: "ses_next", lastActivity: 456 }),
    );
    expect(store!.read()).toEqual({ id: "ses_next", lastActivity: 456 });
  });

  it("returns undefined without a storage object", () => {
    expect(createReactNativeSessionStore(undefined)).toBeUndefined();
  });

  it("swallows async write rejections after updating the in-memory session", async () => {
    const storage = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    };
    const store = createReactNativeSessionStore(storage)!;

    expect(() =>
      store.write({ id: "ses_next", lastActivity: 456 }),
    ).not.toThrow();
    await Promise.resolve();

    expect(store.read()).toEqual({ id: "ses_next", lastActivity: 456 });
  });
});
