import { describe, expect, it, vi } from "vitest";
import { createCapacitorSessionStore } from "../session-store";
import type { CapacitorPreferencesPluginLike } from "../plugins";

function preferences(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const plugin: CapacitorPreferencesPluginLike = {
    get: vi.fn(async ({ key }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }) => {
      store.set(key, value);
    }),
  };
  return { plugin, store };
}

describe("createCapacitorSessionStore", () => {
  it("returns undefined without a usable Preferences plugin", () => {
    expect(createCapacitorSessionStore(undefined)).toBeUndefined();
    expect(createCapacitorSessionStore({})).toBeUndefined();
  });

  it("restores a session id written by a previous launch", async () => {
    const { plugin } = preferences({
      crumbtrail_session: JSON.stringify({ id: "sess-1", lastActivity: 42 }),
    });
    const store = createCapacitorSessionStore(plugin, "crumbtrail_session")!;

    expect(store.read()).toBeUndefined();
    await store.hydrate();
    expect(store.read()).toEqual({ id: "sess-1", lastActivity: 42 });
  });

  it("persists writes and serves them from cache without re-reading", async () => {
    const { plugin, store: backing } = preferences();
    const store = createCapacitorSessionStore(plugin, "crumbtrail_session")!;

    store.write({ id: "sess-2", lastActivity: 7 });

    expect(store.read()).toEqual({ id: "sess-2", lastActivity: 7 });
    await vi.waitFor(() => {
      expect(backing.get("crumbtrail_session")).toBe(
        JSON.stringify({ id: "sess-2", lastActivity: 7 }),
      );
    });
  });

  it("keeps capture alive when the durable write rejects", async () => {
    const plugin: CapacitorPreferencesPluginLike = {
      get: async () => ({ value: null }),
      set: async () => {
        throw new Error("disk full");
      },
    };
    const store = createCapacitorSessionStore(plugin)!;

    expect(() => store.write({ id: "sess-3", lastActivity: 1 })).not.toThrow();
    expect(store.read()).toEqual({ id: "sess-3", lastActivity: 1 });
  });

  it("ignores stored values that are not a usable session", async () => {
    for (const value of ["", "not json", "{}", '{"id":""}', '{"id":5}']) {
      const { plugin } = preferences({ crumbtrail_session: value });
      const store = createCapacitorSessionStore(plugin, "crumbtrail_session")!;
      await store.hydrate();
      expect(store.read()).toBeUndefined();
    }
  });

  it("defaults a missing lastActivity to zero rather than dropping the id", async () => {
    const { plugin } = preferences({
      crumbtrail_session: JSON.stringify({ id: "sess-4" }),
    });
    const store = createCapacitorSessionStore(plugin, "crumbtrail_session")!;
    await store.hydrate();
    expect(store.read()).toEqual({ id: "sess-4", lastActivity: 0 });
  });

  it("returns undefined when the read itself rejects", async () => {
    const store = createCapacitorSessionStore({
      get: async () => {
        throw new Error("bridge unavailable");
      },
      set: async () => {},
    })!;

    await expect(store.hydrate()).resolves.toBeUndefined();
  });
});
