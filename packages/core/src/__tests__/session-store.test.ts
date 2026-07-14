import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SESSION_STORAGE_KEY,
  createWebSessionStore,
} from "../session-store";

function makeStorage(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    _store: store,
  };
}

describe("SessionStore", () => {
  it("reads and writes browser sessionStorage-compatible records", () => {
    const storage = makeStorage({
      [DEFAULT_SESSION_STORAGE_KEY]: JSON.stringify({
        id: "ses_existing",
        lastActivity: 123,
      }),
    });
    const store = createWebSessionStore(storage)!;

    expect(store.read()).toEqual({ id: "ses_existing", lastActivity: 123 });

    store.write({ id: "ses_next", lastActivity: 456 });
    expect(storage._store.get(DEFAULT_SESSION_STORAGE_KEY)).toBe(
      JSON.stringify({ id: "ses_next", lastActivity: 456 }),
    );
  });

  it("falls back to undefined when storage is absent", () => {
    expect(createWebSessionStore(undefined)).toBeUndefined();
  });

  it("treats malformed or throwing storage as empty without throwing", () => {
    const invalidStore = createWebSessionStore(
      makeStorage({ [DEFAULT_SESSION_STORAGE_KEY]: "{not-json" }),
    )!;
    expect(invalidStore.read()).toBeUndefined();

    const throwingStore = createWebSessionStore({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    })!;

    expect(throwingStore.read()).toBeUndefined();
    expect(() =>
      throwingStore.write({ id: "ses_ignored", lastActivity: 1 }),
    ).not.toThrow();
  });
});
