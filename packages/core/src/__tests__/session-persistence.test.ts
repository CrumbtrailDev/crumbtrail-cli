import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crumbtrail } from "../bug-logger";

function makeStorage(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    _store: store,
  };
}

const KEY = "__crumbtrail_session";

const mockTransport = () => ({
  sendEvents: vi.fn().mockResolvedValue(undefined),
  sendBlob: vi.fn().mockResolvedValue(undefined),
  startSession: vi.fn().mockResolvedValue(undefined),
  endSession: vi.fn().mockResolvedValue(undefined),
  sendBugReport: vi.fn().mockResolvedValue(undefined),
});

const baseConfig = () => ({
  transportInstance: mockTransport(),
  flushIntervalMs: 100_000,
  flushBufferSize: 1000,
  network: false as const,
});

describe("Crumbtrail — session persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reuses a persisted session id on re-init within the idle window", async () => {
    const storage = makeStorage({
      [KEY]: JSON.stringify({ id: "ses_persisted", lastActivity: Date.now() }),
    });
    vi.stubGlobal("sessionStorage", storage);

    const logger = Crumbtrail.init(baseConfig());
    expect(logger.getSessionId()).toBe("ses_persisted");
    await logger.stop();
  });

  it("mints a fresh session id when the persisted session is past the idle window", async () => {
    const storage = makeStorage({
      [KEY]: JSON.stringify({
        id: "ses_stale",
        lastActivity: Date.now() - 40 * 60 * 1000,
      }),
    });
    vi.stubGlobal("sessionStorage", storage);

    const logger = Crumbtrail.init(baseConfig());
    expect(logger.getSessionId()).not.toBe("ses_stale");
    expect(logger.getSessionId()).toMatch(/^ses_\d{8}_\d{6}_[0-9a-f]{12}$/);
    // The fresh id is persisted for the next reload.
    expect(JSON.parse(storage._store.get(KEY)!).id).toBe(logger.getSessionId());
    await logger.stop();
  });

  it("persists a newly minted session id when none exists", async () => {
    const storage = makeStorage();
    vi.stubGlobal("sessionStorage", storage);

    const logger = Crumbtrail.init(baseConfig());
    const id = logger.getSessionId();
    expect(JSON.parse(storage._store.get(KEY)!).id).toBe(id);
    await logger.stop();
  });

  it("lets an explicit sessionId override win and persists it", async () => {
    const storage = makeStorage({
      [KEY]: JSON.stringify({ id: "ses_persisted", lastActivity: Date.now() }),
    });
    vi.stubGlobal("sessionStorage", storage);

    const logger = Crumbtrail.init({
      ...baseConfig(),
      sessionId: "ses_explicit",
    });
    expect(logger.getSessionId()).toBe("ses_explicit");
    expect(JSON.parse(storage._store.get(KEY)!).id).toBe("ses_explicit");
    await logger.stop();
  });

  it('does not read or write storage when sessionPersistence is "none"', async () => {
    const storage = makeStorage({
      [KEY]: JSON.stringify({ id: "ses_persisted", lastActivity: Date.now() }),
    });
    vi.stubGlobal("sessionStorage", storage);

    const logger = Crumbtrail.init({
      ...baseConfig(),
      sessionPersistence: "none",
    });
    expect(logger.getSessionId()).not.toBe("ses_persisted");
    // The pre-existing entry is left untouched (not overwritten by the fresh session).
    expect(JSON.parse(storage._store.get(KEY)!).id).toBe("ses_persisted");
    await logger.stop();
  });

  it("uses an injected SessionStore instead of browser storage when provided", async () => {
    const sessionStore = {
      read: vi.fn(() => ({ id: "ses_injected", lastActivity: Date.now() })),
      write: vi.fn(),
    };
    const browserStorage = makeStorage({
      [KEY]: JSON.stringify({ id: "ses_browser", lastActivity: Date.now() }),
    });
    vi.stubGlobal("sessionStorage", browserStorage);

    const logger = Crumbtrail.init({ ...baseConfig(), sessionStore });

    expect(logger.getSessionId()).toBe("ses_injected");
    expect(sessionStore.write).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ses_injected" }),
    );
    expect(JSON.parse(browserStorage._store.get(KEY)!).id).toBe("ses_browser");
    await logger.stop();
  });

  it("is SSR-safe: mints a session id when sessionStorage is unavailable", async () => {
    // No sessionStorage stubbed → hasSessionStorage() is false in the node test env.
    const logger = Crumbtrail.init(baseConfig());
    expect(logger.getSessionId()).toMatch(/^ses_\d{8}_\d{6}_[0-9a-f]{12}$/);
    await logger.stop();
  });
});
