export interface PersistedSession {
  id: string;
  lastActivity: number;
}

export interface SessionStore {
  read(): PersistedSession | undefined;
  write(session: PersistedSession): void;
}

export const DEFAULT_SESSION_STORAGE_KEY = "__crumbtrail_session";

export function createWebSessionStore(
  storage?: Pick<Storage, "getItem" | "setItem">,
  key = DEFAULT_SESSION_STORAGE_KEY,
): SessionStore | undefined {
  const resolvedStorage =
    arguments.length === 0 ? getBrowserSessionStorage() : storage;
  if (!resolvedStorage) return undefined;

  return {
    read() {
      try {
        const raw = resolvedStorage.getItem(key);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as {
          id?: unknown;
          lastActivity?: unknown;
        };
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
    },
    write(session) {
      try {
        resolvedStorage.setItem(key, JSON.stringify(session));
      } catch {
        // Storage can be full, disabled, or denied in sandboxed frames.
      }
    },
  };
}

function getBrowserSessionStorage(): Storage | undefined {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage !== null
      ? sessionStorage
      : undefined;
  } catch {
    return undefined;
  }
}
