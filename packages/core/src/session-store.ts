import { MAX_APPLICATION_ASSERTIONS_PER_SESSION } from "./assertion";
import { MAX_APPLICATION_RESPONSE_ASSERTIONS_PER_SESSION } from "./application-contracts";

export interface PersistedSession {
  id: string;
  lastActivity: number;
  /** Count only. Assertion values and identifiers are never persisted. */
  applicationAssertionCount?: number;
  applicationResponseAssertionCount?: number;
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
          applicationAssertionCount?: unknown;
          applicationResponseAssertionCount?: unknown;
        };
        if (typeof parsed.id !== "string" || parsed.id.length === 0)
          return undefined;
        if (
          typeof parsed.lastActivity !== "number" ||
          !Number.isSafeInteger(parsed.lastActivity) ||
          parsed.lastActivity < 0
        )
          return undefined;
        const applicationAssertionCount = parsed.applicationAssertionCount;
        const applicationResponseAssertionCount =
          parsed.applicationResponseAssertionCount;
        if (
          applicationResponseAssertionCount !== undefined &&
          (typeof applicationResponseAssertionCount !== "number" ||
            !Number.isSafeInteger(applicationResponseAssertionCount) ||
            applicationResponseAssertionCount < 0 ||
            applicationResponseAssertionCount >
              MAX_APPLICATION_RESPONSE_ASSERTIONS_PER_SESSION)
        )
          return undefined;
        if (
          applicationAssertionCount !== undefined &&
          (typeof applicationAssertionCount !== "number" ||
            !Number.isSafeInteger(applicationAssertionCount) ||
            applicationAssertionCount < 0 ||
            applicationAssertionCount > MAX_APPLICATION_ASSERTIONS_PER_SESSION)
        )
          return undefined;
        return {
          id: parsed.id,
          lastActivity: parsed.lastActivity,
          ...(applicationResponseAssertionCount === undefined
            ? {}
            : { applicationResponseAssertionCount }),
          ...(applicationAssertionCount === undefined
            ? {}
            : { applicationAssertionCount }),
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
