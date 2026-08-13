import { DEFAULT_SESSION_STORAGE_KEY } from "crumbtrail-core";
import type { PersistedSession, SessionStore } from "crumbtrail-core";
import type { CapacitorPreferencesPluginLike } from "./plugins";

/**
 * A Preferences-backed session store.
 *
 * The WebView's own `localStorage` looks like it would do this job, and on
 * Android it mostly does. It is the wrong choice anyway: on iOS the WKWebView
 * data store is evictable, so the OS can clear it under storage pressure or on
 * an app update, and a cleared store silently starts a NEW session id. That
 * turns one user's week of intermittent bug reports into a pile of unrelated
 * single-event sessions, which is exactly the correlation the product exists to
 * preserve. `@capacitor/preferences` writes to UserDefaults / SharedPreferences
 * instead, which survives both.
 *
 * Reads are async and the core session store interface is sync, so this mirrors
 * the React Native store: `hydrate()` once before init, then serve from cache.
 */
export interface CapacitorSessionStore extends SessionStore {
  hydrate(): Promise<PersistedSession | undefined>;
}

export function createCapacitorSessionStore(
  preferences: CapacitorPreferencesPluginLike | null | undefined,
  key = DEFAULT_SESSION_STORAGE_KEY,
): CapacitorSessionStore | undefined {
  if (!preferences?.get || !preferences.set) return undefined;
  const get = preferences.get.bind(preferences);
  const set = preferences.set.bind(preferences);

  let cached: PersistedSession | undefined;

  return {
    read() {
      return cached;
    },
    write(session) {
      cached = session;
      try {
        void Promise.resolve(
          set({ key, value: JSON.stringify(session) }),
        ).catch(() => {
          // A failed durable write must never break capture. The in-memory
          // cache still holds the id for the rest of this process, so the
          // current session stays coherent; only cross-launch stitching is lost.
        });
      } catch {
        // Same reasoning for a synchronous throw.
      }
    },
    async hydrate() {
      try {
        const result = await get({ key });
        cached = parsePersistedSession(result?.value);
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
