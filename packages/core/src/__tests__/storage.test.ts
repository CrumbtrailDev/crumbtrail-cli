import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { REDACTED_VALUE } from "../redaction";
import { storageCollector } from "../collectors/storage";

function makeConfig(
  overrides: Partial<CrumbtrailConfig> = {},
): CrumbtrailConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("storageCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let origProtoSetItem: typeof Storage.prototype.setItem;
  let origProtoRemoveItem: typeof Storage.prototype.removeItem;
  let origProtoClear: typeof Storage.prototype.clear;
  let origLocalSetItem: Function;
  let origLocalRemoveItem: Function;
  let origLocalClear: Function;
  let origSessionSetItem: Function;
  let origSessionRemoveItem: Function;
  let origSessionClear: Function;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));

    // Save original prototype methods before each test
    origProtoSetItem = Storage.prototype.setItem;
    origProtoRemoveItem = Storage.prototype.removeItem;
    origProtoClear = Storage.prototype.clear;

    // Save original instance methods (bound)
    origLocalSetItem = localStorage.setItem.bind(localStorage);
    origLocalRemoveItem = localStorage.removeItem.bind(localStorage);
    origLocalClear = localStorage.clear.bind(localStorage);
    origSessionSetItem = sessionStorage.setItem.bind(sessionStorage);
    origSessionRemoveItem = sessionStorage.removeItem.bind(sessionStorage);
    origSessionClear = sessionStorage.clear.bind(sessionStorage);

    // Clear storage
    localStorage.clear();
    sessionStorage.clear();
  });

  function restoreInstance(storage: Storage, method: string, fn: Function) {
    Object.defineProperty(storage, method, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  afterEach(() => {
    // Restore prototype originals in case cleanup didn't run
    Storage.prototype.setItem = origProtoSetItem;
    Storage.prototype.removeItem = origProtoRemoveItem;
    Storage.prototype.clear = origProtoClear;
    // Restore instance methods via defineProperty
    restoreInstance(localStorage, "setItem", origLocalSetItem);
    restoreInstance(localStorage, "removeItem", origLocalRemoveItem);
    restoreInstance(localStorage, "clear", origLocalClear);
    restoreInstance(sessionStorage, "setItem", origSessionSetItem);
    restoreInstance(sessionStorage, "removeItem", origSessionRemoveItem);
    restoreInstance(sessionStorage, "clear", origSessionClear);
    vi.restoreAllMocks();
  });

  // The prototype patch used to be handed the *unbound* Storage.prototype
  // method and invoke it as `origFn(key, value)` with no receiver. A real
  // browser throws `TypeError: Illegal invocation` from inside the host page's
  // own write, so the SDK breaks the application it is observing. The same
  // wrapper hardcoded `type: "local"` and read `oldVal` out of localStorage,
  // so a sessionStorage write through it was filed against the wrong store.
  describe("the prototype patch", () => {
    it("calls the original with the receiver it was given", () => {
      const cleanup = storageCollector(
        bus,
        makeConfig({ captureIdb: false, captureCacheApi: false }),
      );

      expect(() =>
        Storage.prototype.setItem.call(sessionStorage, "theme", "dark"),
      ).not.toThrow();
      expect(sessionStorage.getItem("theme")).toBe("dark");

      expect(() =>
        Storage.prototype.removeItem.call(sessionStorage, "theme"),
      ).not.toThrow();
      expect(sessionStorage.getItem("theme")).toBeNull();

      cleanup();
    });

    it("files the write against the store it actually happened in", () => {
      const cleanup = storageCollector(
        bus,
        makeConfig({ captureIdb: false, captureCacheApi: false }),
      );
      events.length = 0;

      Storage.prototype.setItem.call(sessionStorage, "step", "2");
      bus.flush();

      const stor = events.filter((event) => event.k === "stor");
      expect(stor).toHaveLength(1);
      expect(stor[0].d).toMatchObject({
        type: "session",
        op: "set",
        key: "step",
      });

      cleanup();
    });

    // The key exists only in sessionStorage, so an oldVal read from
    // localStorage reports "there was nothing here before" about a write that
    // overwrote something.
    it("reads the previous value from the same store", () => {
      sessionStorage.setItem("step", "1");
      const cleanup = storageCollector(
        bus,
        makeConfig({ captureIdb: false, captureCacheApi: false }),
      );
      events.length = 0;

      Storage.prototype.setItem.call(sessionStorage, "step", "2");
      bus.flush();

      const stor = events.filter((event) => event.k === "stor")[0];
      expect(stor.d).toMatchObject({ type: "session" });
      expect(stor.d.oldVal).toBeDefined();

      cleanup();
    });
  });

  it("emits snap event with localStorage and sessionStorage contents on init", () => {
    localStorage.setItem("lk", "lv");
    sessionStorage.setItem("sk", "sv");

    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();

    const snapEvents = events.filter((e) => e.k === "snap");
    expect(snapEvents).toHaveLength(1);
    const d = snapEvents[0].d as Record<string, Record<string, string>>;
    expect(d.localStorage).toEqual({ lk: REDACTED_VALUE });
    expect(d.sessionStorage).toEqual({ sk: REDACTED_VALUE });
    expect(snapEvents[0].d.redaction).toBeDefined();

    cleanup();
  });

  /**
   * The consented capture path. Live probes gained a stricter, structure preserving key treatment
   * because a probe is answered by a bystander's browser; this path records the session that
   * actually hit the defect, so its keys are unchanged and the probe work must not touch them.
   */
  it("still emits an identifier bearing key verbatim in its snapshot", () => {
    localStorage.setItem("user_12345_prefs", "{}");
    sessionStorage.setItem("cart:alice@example.com:items", "[]");

    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();

    const snap = events.filter((e) => e.k === "snap")[0];
    const d = snap.d as Record<string, Record<string, string>>;
    expect(d.localStorage).toEqual({ user_12345_prefs: REDACTED_VALUE });
    expect(d.sessionStorage).toEqual({
      "cart:alice@example.com:items": REDACTED_VALUE,
    });

    cleanup();
  });

  it("setItem monkey-patch emits stor event with old and new values", () => {
    localStorage.setItem("key1", "old");

    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();
    events.length = 0;

    localStorage.setItem("key1", "new");
    bus.flush();

    const storEvents = events.filter((e) => e.k === "stor" && e.d.op === "set");
    expect(storEvents).toHaveLength(1);
    expect(storEvents[0].d).toMatchObject({
      type: "local",
      op: "set",
      key: "key1",
      oldVal: REDACTED_VALUE,
      newVal: REDACTED_VALUE,
      outcome: "success",
    });

    cleanup();
  });

  it("removeItem monkey-patch emits stor event", () => {
    localStorage.setItem("del", "val");

    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();
    events.length = 0;

    localStorage.removeItem("del");
    bus.flush();

    const storEvents = events.filter((e) => e.k === "stor" && e.d.op === "del");
    expect(storEvents).toHaveLength(1);
    expect(storEvents[0].d).toMatchObject({
      type: "local",
      op: "del",
      key: "del",
      oldVal: REDACTED_VALUE,
      outcome: "success",
    });

    cleanup();
  });

  it("clear monkey-patch emits stor event", () => {
    localStorage.setItem("a", "1");

    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();
    events.length = 0;

    localStorage.clear();
    bus.flush();

    const storEvents = events.filter(
      (e) => e.k === "stor" && e.d.op === "clear",
    );
    expect(storEvents).toHaveLength(1);
    expect(storEvents[0].d).toMatchObject({
      type: "local",
      op: "clear",
      outcome: "success",
    });

    cleanup();
  });

  it("records a rejected setItem after the failure and rethrows the original error", () => {
    const quotaError = new DOMException("storage quota exceeded", "QuotaExceededError");
    Object.defineProperty(localStorage, "setItem", {
      value: vi.fn(() => {
        throw quotaError;
      }),
      writable: true,
      configurable: true,
    });
    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();
    events.length = 0;

    let thrown: unknown;
    try {
      localStorage.setItem("checkoutDraft", "customer secret");
    } catch (error) {
      thrown = error;
    }
    bus.flush();

    expect(thrown).toBe(quotaError);
    const event = events.find((entry) => entry.k === "stor");
    expect(event?.d).toMatchObject({
      type: "local",
      op: "set",
      key: "checkoutDraft",
      outcome: "failure",
      errorName: "QuotaExceededError",
      newVal: REDACTED_VALUE,
    });
    expect(JSON.stringify(event)).not.toContain("customer secret");

    cleanup();
  });

  it("records rejected removeItem and clear mutations with bounded error names", () => {
    localStorage.setItem("draft", "value");
    const removeError = new Error("remove failed with a secret");
    Object.defineProperty(localStorage, "removeItem", {
      value: vi.fn(() => {
        throw removeError;
      }),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(localStorage, "clear", {
      value: vi.fn(() => {
        throw { name: "X".repeat(500), message: "clear secret" };
      }),
      writable: true,
      configurable: true,
    });
    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();
    events.length = 0;

    expect(() => localStorage.removeItem("draft")).toThrow(removeError);
    expect(() => localStorage.clear()).toThrow();
    bus.flush();

    const failures = events.filter(
      (entry) => entry.k === "stor" && entry.d.outcome === "failure",
    );
    expect(failures).toHaveLength(2);
    expect(failures[0].d).toMatchObject({
      op: "del",
      errorName: "Error",
    });
    expect(failures[1].d).toMatchObject({
      op: "clear",
      errorName: "X".repeat(100),
    });
    expect(JSON.stringify(failures)).not.toContain("clear secret");

    cleanup();
  });

  it("storageExcludeKeys are skipped", () => {
    const cleanup = storageCollector(
      bus,
      makeConfig({
        storageExcludeKeys: ["ignored"],
        captureIdb: false,
        captureCacheApi: false,
      }),
    );
    bus.flush();
    events.length = 0;

    localStorage.setItem("ignored", "value");
    localStorage.setItem("tracked", "value");
    bus.flush();

    const storEvents = events.filter((e) => e.k === "stor");
    expect(storEvents).toHaveLength(1);
    expect(storEvents[0].d.key).toBe("tracked");

    cleanup();
  });

  // A key already present at init() had its NAME published in the opening
  // snapshot despite an explicit opt-out: the exclude list gated setItem,
  // removeItem and the cross-tab handler, and never the snapshot.
  it("storageExcludeKeys are skipped by the opening snapshot too", () => {
    localStorage.setItem("patient_record_blob", "{}");
    sessionStorage.setItem("patient_record_blob", "{}");
    localStorage.setItem("tracked", "{}");

    const cleanup = storageCollector(
      bus,
      makeConfig({
        storageExcludeKeys: ["patient_record_blob"],
        captureIdb: false,
        captureCacheApi: false,
      }),
    );
    bus.flush();

    const snap = events.filter((event) => event.k === "snap")[0];
    expect(JSON.stringify(snap.d)).not.toContain("patient_record_blob");
    expect(
      (snap.d as Record<string, Record<string, string>>).localStorage,
    ).toHaveProperty("tracked");

    cleanup();
  });

  // Every sensitive key redacts to the same constant, so three tokens used to
  // collapse into one snapshot entry and "the token was never written" became
  // indistinguishable from "it was written under three names".
  it("keeps one snapshot entry per sensitive key", () => {
    localStorage.setItem("authToken", "a");
    localStorage.setItem("refreshToken", "b");
    localStorage.setItem("user_session_secret", "c");

    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();

    const snap = events.filter((event) => event.k === "snap")[0];
    const local = (snap.d as Record<string, Record<string, string>>)
      .localStorage;
    expect(Object.keys(local)).toHaveLength(3);
    // The names themselves stay redacted; only the cardinality survives.
    expect(Object.keys(local).join(",")).not.toContain("authToken");

    cleanup();
  });

  it("records oversized storage value length without persisting the value", () => {
    const cleanup = storageCollector(
      bus,
      makeConfig({
        storageValueMaxLength: 5,
        captureIdb: false,
        captureCacheApi: false,
      }),
    );
    bus.flush();
    events.length = 0;

    localStorage.setItem("k", "abcdefghij");
    bus.flush();

    const storEvents = events.filter((e) => e.k === "stor");
    expect(storEvents).toHaveLength(1);
    expect(storEvents[0].d.newVal).toBe(REDACTED_VALUE);
    expect(storEvents[0].d.newValSummary).toMatchObject({
      kind: "storage",
      action: "redacted",
      reason: "storage_value_too_large",
      originalLength: 10,
      limit: 5,
    });

    cleanup();
  });

  it("redacts sensitive storage keys and snapshot values without persisting raw secrets", () => {
    localStorage.setItem("refreshToken", "storage-secret-token");
    sessionStorage.setItem("userEmail", "ada@example.test");

    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();

    const snap = events.find((e) => e.k === "snap");
    expect(snap?.d.localStorage).toEqual({ "[REDACTED_KEY]": REDACTED_VALUE });
    expect(snap?.d.sessionStorage).toEqual({
      "[REDACTED_KEY]": REDACTED_VALUE,
    });
    expect(snap?.d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
    });
    expect(JSON.stringify(snap)).not.toContain("refreshToken");
    expect(JSON.stringify(snap)).not.toContain("storage-secret-token");
    expect(JSON.stringify(snap)).not.toContain("ada@example.test");

    cleanup();
  });

  it("redacts sensitive storage change keys and value summaries", () => {
    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();
    events.length = 0;

    localStorage.setItem("authToken", "storage-change-secret");
    bus.flush();

    const stor = events.find((e) => e.k === "stor" && e.d.op === "set");
    expect(stor?.d).toMatchObject({
      type: "local",
      op: "set",
      key: "[REDACTED_KEY]",
      newVal: REDACTED_VALUE,
      newValSummary: expect.objectContaining({
        kind: "storage",
        reason: "sensitive_storage_value",
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });
    expect(JSON.stringify(stor)).not.toContain("authToken");
    expect(JSON.stringify(stor)).not.toContain("storage-change-secret");

    cleanup();
  });

  it("records one IndexedDB request failure without changing the request or its listeners", () => {
    const failure = new DOMException("database secret", "InvalidStateError");
    const request = new EventTarget() as IDBRequest;
    Object.defineProperty(request, "error", { value: failure });
    const factory = {
      open: vi.fn(() => request),
      deleteDatabase: vi.fn(() => request),
    };
    vi.stubGlobal("indexedDB", factory);
    const cleanup = storageCollector(bus, makeConfig({ autoFlagOnStorageFailure: true }));
    const returned = factory.open("customer-private-db");
    const appListener = vi.fn();
    returned.addEventListener("error", appListener);

    returned.dispatchEvent(new Event("error"));
    returned.dispatchEvent(new Event("error"));
    bus.flush();

    expect(returned).toBe(request);
    expect(appListener).toHaveBeenCalledTimes(2);
    const failures = events.filter((event) => event.k === "stor" && event.d.type === "idb");
    expect(failures).toHaveLength(1);
    expect(failures[0].d).toMatchObject({
      op: "open",
      outcome: "failure",
      errorName: "InvalidStateError",
    });
    expect(JSON.stringify(failures)).not.toContain("customer-private-db");
    expect(JSON.stringify(failures)).not.toContain("database secret");

    cleanup();
  });

  it("records IndexedDB synchronous throws and ignores aborted requests", () => {
    const syncFailure = new DOMException("private database", "SecurityError");
    const abortedRequest = new EventTarget() as IDBRequest;
    Object.defineProperty(abortedRequest, "error", {
      value: new DOMException("cancelled", "AbortError"),
    });
    const factory = {
      open: vi
        .fn()
        .mockImplementationOnce(() => {
          throw syncFailure;
        })
        .mockReturnValue(abortedRequest),
      deleteDatabase: vi.fn(),
    };
    vi.stubGlobal("indexedDB", factory);
    const cleanup = storageCollector(bus, makeConfig({ autoFlagOnStorageFailure: true }));

    expect(() => factory.open("private-db")).toThrow(syncFailure);
    factory.open("private-db").dispatchEvent(new Event("error"));
    bus.flush();

    expect(events.filter((event) => event.k === "stor")).toEqual([
      expect.objectContaining({
        d: expect.objectContaining({
          type: "idb",
          op: "open",
          errorName: "SecurityError",
        }),
      }),
    ]);
    cleanup();
  });

  it("records Cache API promise failures without changing promise identity or payload privacy", async () => {
    const failure = new DOMException("request body secret", "QuotaExceededError");
    const cache = {
      put: vi.fn(() => Promise.reject(failure)),
    };
    const openResult = Promise.resolve(cache);
    const cacheStorage = {
      open: vi.fn(() => openResult),
      delete: vi.fn(),
      has: vi.fn(),
      match: vi.fn(),
      keys: vi.fn(),
    };
    vi.stubGlobal("caches", cacheStorage);
    const cleanup = storageCollector(bus, makeConfig({ autoFlagOnStorageFailure: true }));

    const returnedOpen = cacheStorage.open("private-cache");
    expect(returnedOpen).toBe(openResult);
    const returnedCache = await returnedOpen;
    const returnedPut = returnedCache.put(
      new Request("https://example.test/private"),
      new Response("response secret"),
    );
    await expect(returnedPut).rejects.toBe(failure);
    await Promise.resolve();
    bus.flush();

    const failures = events.filter((event) => event.k === "stor" && event.d.type === "cache");
    expect(failures).toHaveLength(1);
    expect(failures[0].d).toMatchObject({
      op: "put",
      outcome: "failure",
      errorName: "QuotaExceededError",
    });
    expect(JSON.stringify(failures)).not.toContain("private-cache");
    expect(JSON.stringify(failures)).not.toContain("response secret");
    cleanup();
  });

  it("does not emit IndexedDB or Cache API failures while the trigger is disabled", async () => {
    const request = new EventTarget() as IDBRequest;
    Object.defineProperty(request, "error", {
      value: new DOMException("private", "UnknownError"),
    });
    const factory = { open: vi.fn(() => request), deleteDatabase: vi.fn() };
    const cacheStorage = {
      open: vi.fn(() => Promise.reject(new Error("private cache failure"))),
      delete: vi.fn(),
      has: vi.fn(),
      match: vi.fn(),
      keys: vi.fn(),
    };
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("caches", cacheStorage);
    const cleanup = storageCollector(bus, makeConfig({ autoFlagOnStorageFailure: false }));

    factory.open("private").dispatchEvent(new Event("error"));
    await expect(cacheStorage.open("private")).rejects.toThrow("private cache failure");
    await Promise.resolve();
    bus.flush();

    expect(events.filter((event) => event.k === "stor")).toHaveLength(0);
    cleanup();
  });

  it("cleanup restores original Storage methods", () => {
    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );

    // Prototype methods should be patched
    expect(Storage.prototype.setItem).not.toBe(origProtoSetItem);

    cleanup();

    // Prototype methods should be restored
    expect(Storage.prototype.setItem).toBe(origProtoSetItem);
    expect(Storage.prototype.removeItem).toBe(origProtoRemoveItem);
    expect(Storage.prototype.clear).toBe(origProtoClear);
  });

  it("cross-tab storage event is captured", () => {
    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();
    events.length = 0;

    // Dispatch a StorageEvent (simulates cross-tab change)
    const storageEvent = new StorageEvent("storage", {
      key: "crossTab",
      oldValue: "old",
      newValue: "new",
      storageArea: localStorage,
    });
    window.dispatchEvent(storageEvent);
    bus.flush();

    const storEvents = events.filter(
      (e) => e.k === "stor" && e.d.key === "crossTab",
    );
    expect(storEvents).toHaveLength(1);
    expect(storEvents[0].d).toMatchObject({
      type: "local",
      op: "set",
      key: "crossTab",
      oldVal: REDACTED_VALUE,
      newVal: REDACTED_VALUE,
    });

    cleanup();
  });
});
