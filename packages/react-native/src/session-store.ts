import { DEFAULT_SESSION_STORAGE_KEY } from "crumbtrail-core";
import type { PersistedSession, SessionStore } from "crumbtrail-core";

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
}

export interface ReactNativeSessionStore extends SessionStore {
  hydrate(): Promise<PersistedSession | undefined>;
}

export function createReactNativeSessionStore(
  storage: AsyncStorageLike | null | undefined,
  key = DEFAULT_SESSION_STORAGE_KEY,
): ReactNativeSessionStore | undefined {
  if (!storage) return undefined;

  let cached: PersistedSession | undefined;

  return {
    read() {
      return cached;
    },
    write(session) {
      cached = session;
      try {
        const result = storage.setItem(key, JSON.stringify(session));
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch(() => {});
        }
      } catch {
        // AsyncStorage-compatible implementations can reject or throw; session capture should continue.
      }
    },
    async hydrate() {
      try {
        const raw = await storage.getItem(key);
        cached = parsePersistedSession(raw);
        return cached;
      } catch {
        return undefined;
      }
    },
  };
}

function parsePersistedSession(
  raw: string | null | undefined,
): PersistedSession | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; lastActivity?: unknown };
    if (typeof parsed.id !== "string" || parsed.id.length === 0)
      return undefined;
    return {
      id: parsed.id,
      lastActivity:
        typeof parsed.lastActivity === "number" ? parsed.lastActivity : 0,
    };
  } catch {
    return undefined;
  }
}
