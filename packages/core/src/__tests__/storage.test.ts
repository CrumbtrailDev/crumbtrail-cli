import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { REDACTED_VALUE } from "../redaction";
import { storageCollector } from "../collectors/storage";
import { DEFAULT_SESSION_STORAGE_KEY } from "../session-store";

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
    vi.unstubAllGlobals();
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

  it("never captures the SDK session persistence key", () => {
    sessionStorage.setItem(
      DEFAULT_SESSION_STORAGE_KEY,
      "private session metadata",
    );
    const cleanup = storageCollector(
      bus,
      makeConfig({ captureIdb: false, captureCacheApi: false }),
    );
    bus.flush();
    expect(
      events.find((event) => event.k === "snap")?.d.sessionStorage,
    ).toEqual({});
    events.length = 0;
    sessionStorage.setItem(DEFAULT_SESSION_STORAGE_KEY, "updated metadata");
    Storage.prototype.setItem.call(
      sessionStorage,
      DEFAULT_SESSION_STORAGE_KEY,
      "prototype metadata",
    );
    sessionStorage.removeItem(DEFAULT_SESSION_STORAGE_KEY);
    bus.flush();
    expect(events).toEqual([]);
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
    const quotaError = new DOMException(
      "storage quota exceeded",
      "QuotaExceededError",
    );
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
      open: vi.fn((_name: string) => request),
      deleteDatabase: vi.fn((_name: string) => request),
    };
    vi.stubGlobal("indexedDB", factory);
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );
    const returned = factory.open("customer-private-db");
    const appListener = vi.fn();
    returned.addEventListener("error", appListener);

    returned.dispatchEvent(new Event("error"));
    returned.dispatchEvent(new Event("error"));
    bus.flush();

    expect(returned).toBe(request);
    expect(appListener).toHaveBeenCalledTimes(2);
    const failures = events.filter(
      (event) => event.k === "stor" && event.d.type === "idb",
    );
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
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );

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

  it("records Cache API promise failures without changing rejection or receiver behavior", async () => {
    const failure = new DOMException(
      "request body secret",
      "QuotaExceededError",
    );
    const cache = {
      put: vi.fn((_request: RequestInfo | URL, _response: Response) =>
        Promise.reject(failure),
      ),
    };
    const openResult = Promise.resolve(cache);
    const cacheStorage = {
      open: vi.fn((_name: string) => openResult),
      delete: vi.fn((_name: string) => Promise.resolve(false)),
      has: vi.fn((_name: string) => Promise.resolve(false)),
      match: vi.fn((_request: RequestInfo | URL) => Promise.resolve(undefined)),
      keys: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("caches", cacheStorage);
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );

    const returnedOpen = cacheStorage.open("private-cache");
    // The rejection branch is intentionally returned to the host. Returning
    // the original promise after observing its rejection would suppress the
    // host's unhandledrejection event.
    expect(returnedOpen).not.toBe(openResult);
    const returnedCache = await returnedOpen;
    const returnedPut = returnedCache.put(
      { body: "request body secret" } as unknown as Request,
      { body: "response secret" } as unknown as Response,
    );
    await expect(returnedPut).rejects.toBe(failure);
    await Promise.resolve();
    bus.flush();

    const failures = events.filter(
      (event) => event.k === "stor" && event.d.type === "cache",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].d).toMatchObject({
      op: "put",
      outcome: "failure",
      errorName: "QuotaExceededError",
    });
    expect(JSON.stringify(failures)).not.toContain("private-cache");
    expect(JSON.stringify(failures)).not.toContain("request body secret");
    expect(JSON.stringify(failures)).not.toContain("response secret");
    cleanup();
  });

  it("covers request-producing IndexedDB operations without collecting arguments or results", () => {
    class FakeRequest extends EventTarget {
      error: unknown;
      result: unknown;
    }

    const requests: FakeRequest[] = [];
    const request = (result?: unknown): FakeRequest => {
      const value = new FakeRequest();
      value.result = result;
      requests.push(value);
      return value;
    };

    class FakeCursor {
      request = request();

      advance(..._args: unknown[]) {
        this.request = request();
      }

      continue(..._args: unknown[]) {
        this.request = request();
      }

      continuePrimaryKey(..._args: unknown[]) {
        this.request = request();
      }
    }

    class FakeIndex {
      count(..._args: unknown[]) {
        return request();
      }

      get(..._args: unknown[]) {
        return request();
      }

      getAll(..._args: unknown[]) {
        return request();
      }

      getAllKeys(..._args: unknown[]) {
        return request();
      }

      getKey(..._args: unknown[]) {
        return request();
      }

      openCursor(..._args: unknown[]) {
        return request(new FakeCursor());
      }

      openKeyCursor(..._args: unknown[]) {
        return request(new FakeCursor());
      }
    }

    class FakeObjectStore {
      add(..._args: unknown[]) {
        return request();
      }

      clear(..._args: unknown[]) {
        return request();
      }

      createIndex(..._args: unknown[]) {
        return new FakeIndex();
      }

      count(..._args: unknown[]) {
        return request();
      }

      delete(..._args: unknown[]) {
        return request();
      }

      deleteIndex(..._args: unknown[]) {}

      get(..._args: unknown[]) {
        return request();
      }

      getAll(..._args: unknown[]) {
        return request();
      }

      getAllKeys(..._args: unknown[]) {
        return request();
      }

      getKey(..._args: unknown[]) {
        return request();
      }

      index(..._args: unknown[]) {
        return new FakeIndex();
      }

      openCursor(..._args: unknown[]) {
        return request(new FakeCursor());
      }

      openKeyCursor(..._args: unknown[]) {
        return request(new FakeCursor());
      }

      put(..._args: unknown[]) {
        return request();
      }
    }

    class FakeTransaction extends EventTarget {
      error: unknown;

      objectStore(..._args: unknown[]) {
        return new FakeObjectStore();
      }

      abort(..._args: unknown[]) {}

      commit(..._args: unknown[]) {}
    }

    class FakeDatabase {
      transaction(..._args: unknown[]) {
        return new FakeTransaction();
      }

      createObjectStore(..._args: unknown[]) {
        return new FakeObjectStore();
      }

      deleteObjectStore(..._args: unknown[]) {}
    }

    const openRequest = request(new FakeDatabase());
    const factory = {
      open: vi.fn(() => openRequest),
      deleteDatabase: vi.fn((_name: string) => request()),
      databases: vi.fn(() => Promise.resolve([])),
      cmp: vi.fn((_first: unknown, _second: unknown) => 0),
    };
    vi.stubGlobal("IDBDatabase", FakeDatabase);
    vi.stubGlobal("IDBTransaction", FakeTransaction);
    vi.stubGlobal("IDBObjectStore", FakeObjectStore);
    vi.stubGlobal("IDBIndex", FakeIndex);
    vi.stubGlobal("IDBCursor", FakeCursor);
    vi.stubGlobal("indexedDB", factory);

    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );
    openRequest.dispatchEvent(new Event("success"));
    factory.deleteDatabase("private-database");

    const database = openRequest.result as FakeDatabase;
    const transaction = database.transaction();
    const store = transaction.objectStore();
    const index = store.index();
    const storeCursorRequest = store.openCursor();
    storeCursorRequest.dispatchEvent(new Event("success"));
    const storeCursor = storeCursorRequest.result as FakeCursor;
    storeCursor.advance(999);
    storeCursor.continue("private-key");
    storeCursor.continuePrimaryKey("private-key", "private-primary-key");

    const indexCursorRequest = index.openCursor();
    indexCursorRequest.dispatchEvent(new Event("success"));
    const indexCursor = indexCursorRequest.result as FakeCursor;
    indexCursor.advance(999);
    indexCursor.continue("private-key");
    indexCursor.continuePrimaryKey("private-key", "private-primary-key");

    store.add({ private: "private-value" });
    store.clear();
    store.createIndex("private-index", "private-key-path");
    store.count();
    store.delete("private-key");
    store.deleteIndex("private-index");
    store.get("private-key");
    store.getAll("private-key");
    store.getAllKeys("private-key");
    store.getKey("private-key");
    store.openKeyCursor();
    store.put({ private: "private-value" }, "private-key");
    index.count("private-key");
    index.get("private-key");
    index.getAll("private-key");
    index.getAllKeys("private-key");
    index.getKey("private-key");
    index.openKeyCursor();
    database.createObjectStore("private-store");
    database.deleteObjectStore("private-store");
    transaction.commit();
    transaction.abort();

    const transactionFailure = new DOMException(
      "private details",
      "UnknownError",
    );
    transaction.error = transactionFailure;
    transaction.dispatchEvent(new Event("error"));
    const abortingTransaction = database.transaction();
    abortingTransaction.error = transactionFailure;
    abortingTransaction.dispatchEvent(new Event("abort"));

    for (const value of requests) {
      if (!value.error) value.error = transactionFailure;
      value.dispatchEvent(new Event("error"));
    }
    bus.flush();

    const failures = events.filter(
      (event) => event.k === "stor" && event.d.type === "idb",
    );
    const operations = new Set(failures.map((event) => event.d.op));
    expect(operations).toEqual(
      new Set([
        "database.transaction.error",
        "database.transaction.abort",
        "deleteDatabase",
        "objectStore.add",
        "objectStore.clear",
        "objectStore.count",
        "objectStore.delete",
        "objectStore.get",
        "objectStore.getAll",
        "objectStore.getAllKeys",
        "objectStore.getKey",
        "objectStore.openCursor",
        "objectStore.openKeyCursor",
        "objectStore.put",
        "index.count",
        "index.get",
        "index.getAll",
        "index.getAllKeys",
        "index.getKey",
        "index.openCursor",
        "index.openKeyCursor",
        "cursor.advance",
        "cursor.continue",
        "cursor.continuePrimaryKey",
      ]),
    );
    expect(JSON.stringify(failures)).not.toContain("private-store");
    expect(JSON.stringify(failures)).not.toContain("private-database");
    expect(JSON.stringify(failures)).not.toContain("private-key");
    expect(JSON.stringify(failures)).not.toContain("private-primary-key");
    expect(JSON.stringify(failures)).not.toContain("private-value");
    expect(JSON.stringify(failures)).not.toContain("private details");
    cleanup();
  });

  it("removes IndexedDB listeners and ignores late request failures after teardown", () => {
    const failure = new DOMException("private details", "UnknownError");
    const request = new EventTarget() as EventTarget & { error?: unknown };
    request.error = failure;
    const addEventListener = vi.spyOn(request, "addEventListener");
    const removeEventListener = vi.spyOn(request, "removeEventListener");
    const factory = {
      open: vi.fn(() => request),
      deleteDatabase: vi.fn(() => request),
    };
    vi.stubGlobal("indexedDB", factory);
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );
    factory.open();
    expect(addEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
    cleanup();
    request.dispatchEvent(new Event("error"));
    bus.flush();

    expect(removeEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
    expect(events.filter((event) => event.k === "stor")).toHaveLength(0);
  });

  it("captures synchronous IndexedDB failures through upgrade and versionchange paths", () => {
    const createFailure = new DOMException(
      "private schema details",
      "ConstraintError",
    );
    const deleteFailure = new DOMException(
      "private index details",
      "NotFoundError",
    );
    const cmpFailure = new DOMException("private key details", "DataError");

    class FakeRequest extends EventTarget {
      result: unknown;
    }

    class FakeObjectStore {
      createIndex(..._args: unknown[]) {
        throw createFailure;
      }

      deleteIndex(..._args: unknown[]) {
        throw deleteFailure;
      }
    }

    class FakeDatabase extends EventTarget {
      createObjectStore(..._args: unknown[]) {
        throw createFailure;
      }
    }

    const database = new FakeDatabase();
    const openRequest = new FakeRequest();
    openRequest.result = database;
    const factory = {
      open: vi.fn((_name?: string, _version?: number) => openRequest),
      cmp: vi.fn((_first?: unknown, _second?: unknown) => {
        throw cmpFailure;
      }),
    };
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("IDBDatabase", FakeDatabase);
    vi.stubGlobal("IDBObjectStore", FakeObjectStore);

    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true, captureCacheApi: false }),
    );

    const returnedRequest = factory.open("private-database", 2);
    returnedRequest.dispatchEvent(new Event("upgradeneeded"));
    expect(() => database.createObjectStore("private-store")).toThrow(
      createFailure,
    );
    database.dispatchEvent(new Event("versionchange"));
    expect(() => database.createObjectStore("private-version-store")).toThrow(
      createFailure,
    );

    const store = new FakeObjectStore();
    expect(() =>
      store.createIndex("private-index", "private-key-path"),
    ).toThrow(createFailure);
    expect(() => store.deleteIndex("private-index")).toThrow(deleteFailure);
    expect(() => factory.cmp("private-key-a", "private-key-b")).toThrow(
      cmpFailure,
    );
    bus.flush();

    const failures = events.filter(
      (event) => event.k === "stor" && event.d.type === "idb",
    );
    expect(failures.map((event) => event.d.op)).toEqual([
      "database.createObjectStore",
      "database.createObjectStore",
      "objectStore.createIndex",
      "objectStore.deleteIndex",
      "cmp",
    ]);
    expect(JSON.stringify(failures)).not.toContain("private schema details");
    expect(JSON.stringify(failures)).not.toContain("private index details");
    expect(JSON.stringify(failures)).not.toContain("private key details");
    expect(JSON.stringify(failures)).not.toContain("private-database");
    expect(JSON.stringify(failures)).not.toContain("private-store");
    cleanup();
  });

  it("deduplicates a bubbled request error while retaining genuine transaction errors and aborts", () => {
    type Listener = (event: Event) => void;
    class FakeTransaction {
      error: unknown;
      private listeners = new Map<string, Set<Listener>>();

      addEventListener(type: string, listener: Listener) {
        const listeners = this.listeners.get(type) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: Listener) {
        this.listeners.get(type)?.delete(listener);
      }

      dispatch(eventType: string, target: object) {
        const event = {
          type: eventType,
          target,
          currentTarget: this,
        } as unknown as Event;
        for (const listener of this.listeners.get(eventType) ?? [])
          listener(event);
      }
    }

    class FakeRequest {
      error: unknown;
      transaction: FakeTransaction;
      private listeners = new Set<Listener>();

      constructor(transaction: FakeTransaction) {
        this.transaction = transaction;
      }

      addEventListener(_type: string, listener: Listener) {
        this.listeners.add(listener);
      }

      removeEventListener(_type: string, listener: Listener) {
        this.listeners.delete(listener);
      }

      dispatchBubbledError() {
        const event = {
          type: "error",
          bubbles: true,
          target: this,
          currentTarget: this,
        } as unknown as Event;
        for (const listener of this.listeners) listener(event);
        this.transaction.dispatch("error", this);
      }
    }

    class FakeDatabase {
      constructor(private readonly transactionValue: FakeTransaction) {}

      transaction() {
        return this.transactionValue;
      }
    }

    const requestTransaction = new FakeTransaction();
    requestTransaction.error = new DOMException(
      "private request details",
      "UnknownError",
    );
    const request = new FakeRequest(requestTransaction);
    const genuineErrorTransaction = new FakeTransaction();
    genuineErrorTransaction.error = new DOMException(
      "private transaction details",
      "UnknownError",
    );
    const genuineAbortTransaction = new FakeTransaction();
    genuineAbortTransaction.error = new DOMException(
      "private abort details",
      "UnknownError",
    );
    const factory = {
      open: vi.fn((_name?: string) => request),
    };
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("IDBDatabase", FakeDatabase);
    vi.stubGlobal("IDBTransaction", FakeTransaction);

    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true, captureCacheApi: false }),
    );
    factory.open("private-database");

    // Attach each transaction through the same public database path the real
    // collector sees before an IDBRequest error bubbles to it.
    const requestDatabase = new FakeDatabase(requestTransaction);
    expect(requestDatabase.transaction()).toBe(requestTransaction);
    const genuineErrorDatabase = new FakeDatabase(genuineErrorTransaction);
    const genuineAbortDatabase = new FakeDatabase(genuineAbortTransaction);
    genuineErrorDatabase.transaction();
    genuineAbortDatabase.transaction();
    request.dispatchBubbledError();

    // These transaction events use their own target, so they are not request
    // bubbles and must each be reported once.
    genuineErrorTransaction.dispatch("error", genuineErrorTransaction);
    genuineErrorTransaction.dispatch("error", genuineErrorTransaction);
    genuineAbortTransaction.dispatch("abort", genuineAbortTransaction);
    genuineAbortTransaction.dispatch("abort", genuineAbortTransaction);
    bus.flush();

    const failures = events.filter(
      (event) => event.k === "stor" && event.d.type === "idb",
    );
    expect(failures.map((event) => event.d.op)).toEqual([
      "open",
      "database.transaction.error",
      "database.transaction.abort",
    ]);
    expect(JSON.stringify(failures)).not.toContain("private request details");
    expect(JSON.stringify(failures)).not.toContain(
      "private transaction details",
    );
    expect(JSON.stringify(failures)).not.toContain("private abort details");
    cleanup();
  });

  it("instruments Cache instances that existed before initialization and preserves receivers", async () => {
    const failure = new DOMException("private response", "QuotaExceededError");
    let receiverWasExisting = false;
    class FakeCache {
      put() {
        receiverWasExisting = this === existing;
        return Promise.reject(failure);
      }
    }
    const originalPut = FakeCache.prototype.put;
    const existing = new FakeCache();
    const cacheStorage = {
      open: vi.fn(() => Promise.resolve(existing)),
      keys: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("Cache", FakeCache);
    vi.stubGlobal("caches", cacheStorage);
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );

    const returned = existing.put();
    await expect(returned).rejects.toBe(failure);
    await Promise.resolve();
    bus.flush();

    expect(receiverWasExisting).toBe(true);
    expect(
      events.filter(
        (event) =>
          event.k === "stor" &&
          event.d.type === "cache" &&
          event.d.op === "put",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private response");
    cleanup();
    expect(FakeCache.prototype.put).toBe(originalPut);
  });

  it("owns each Cache object method once when caches.open returns the same object repeatedly", async () => {
    const failure = new DOMException("private response", "QuotaExceededError");
    const cache: {
      put: (...args: unknown[]) => Promise<never>;
    } = {
      put: vi.fn(() => Promise.reject(failure)),
    };
    const originalPut = cache.put;
    const cacheStorage = {
      open: vi.fn((_name: string) => Promise.resolve(cache)),
      delete: vi.fn(() => Promise.resolve(false)),
      has: vi.fn(() => Promise.resolve(false)),
      match: vi.fn(() => Promise.resolve(undefined)),
      keys: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("caches", cacheStorage);
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );

    await Promise.all([
      cacheStorage.open("private-cache"),
      cacheStorage.open("private-cache"),
    ]);
    await expect(cache.put("private-request", "private-response")).rejects.toBe(
      failure,
    );
    await Promise.resolve();
    bus.flush();

    expect(cache.put).not.toBe(originalPut);
    expect(
      events.filter(
        (event) =>
          event.k === "stor" &&
          event.d.type === "cache" &&
          event.d.op === "put",
      ),
    ).toHaveLength(1);
    cleanup();
    expect(cache.put).toBe(originalPut);
  });

  it("lets independent Cache collectors tear down in either order", async () => {
    const run = async (firstCleanupFirst: boolean) => {
      const failure = new DOMException(
        "private response",
        "QuotaExceededError",
      );
      const cache = {
        put: vi.fn(() => Promise.reject(failure)),
      };
      const originalPut = cache.put;
      const cacheStorage = {
        open: vi.fn(() => Promise.resolve(cache)),
        keys: vi.fn(() => Promise.resolve([])),
      };
      const originalOpen = cacheStorage.open;
      vi.stubGlobal("caches", cacheStorage);
      const first = storageCollector(
        bus,
        makeConfig({ autoFlagOnStorageFailure: true }),
      );
      const second = storageCollector(
        bus,
        makeConfig({ autoFlagOnStorageFailure: true }),
      );

      await cacheStorage.open();
      await expect(cache.put()).rejects.toBe(failure);
      await Promise.resolve();
      bus.flush();
      expect(
        events.filter(
          (event) =>
            event.k === "stor" &&
            event.d.type === "cache" &&
            event.d.op === "put",
        ),
      ).toHaveLength(2);

      if (firstCleanupFirst) {
        first();
        second();
      } else {
        second();
        first();
      }
      expect(cache.put).toBe(originalPut);
      expect(cacheStorage.open).toBe(originalOpen);
      events.length = 0;
    };

    await run(true);
    await run(false);
  });

  it("does not patch a Cache acquired after teardown from a pending caches.open", async () => {
    const failure = new DOMException("private response", "QuotaExceededError");
    const cache: {
      put: (...args: unknown[]) => Promise<never>;
    } = {
      put: vi.fn(() => Promise.reject(failure)),
    };
    const originalPut = cache.put;
    let resolveOpen: (value: typeof cache) => void = () => {};
    const openResult = new Promise<typeof cache>((resolve) => {
      resolveOpen = resolve;
    });
    const cacheStorage = {
      open: vi.fn((_name: string) => openResult),
      keys: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("caches", cacheStorage);
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );

    const returnedOpen = cacheStorage.open("private-cache");
    cleanup();
    resolveOpen(cache);
    await expect(returnedOpen).resolves.toBe(cache);
    await expect(cache.put("private-request", "private-response")).rejects.toBe(
      failure,
    );
    await Promise.resolve();
    bus.flush();

    expect(cache.put).toBe(originalPut);
    expect(events.filter((event) => event.k === "stor")).toHaveLength(0);
  });

  it("restores failure hooks across repeated collector start and stop cycles", () => {
    const failure = new DOMException("private database", "UnknownError");
    const request = new EventTarget() as EventTarget & { error?: unknown };
    request.error = failure;
    const factory = { open: vi.fn(() => request) };
    const originalOpen = factory.open;
    vi.stubGlobal("indexedDB", factory);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const cleanup = storageCollector(
        bus,
        makeConfig({ autoFlagOnStorageFailure: true }),
      );
      expect(factory.open).not.toBe(originalOpen);
      factory.open().dispatchEvent(new Event("error"));
      cleanup();
      expect(factory.open).toBe(originalOpen);
    }

    bus.flush();
    expect(
      events.filter((event) => event.k === "stor" && event.d.type === "idb"),
    ).toHaveLength(3);
  });

  it("tolerates absent and immutable optional storage APIs", () => {
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("caches", undefined);
    const absentCleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );
    expect(() => absentCleanup()).not.toThrow();

    const cacheStorage = {
      open: vi.fn(() => Promise.resolve({})),
      keys: vi.fn(() => Promise.resolve([])),
    };
    Object.defineProperty(cacheStorage, "open", {
      configurable: false,
      value: cacheStorage.open,
      writable: false,
    });
    vi.stubGlobal("caches", cacheStorage);
    const immutableCleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );
    expect(() => immutableCleanup()).not.toThrow();
  });

  it("surfaces failed storage wrapper restoration through collector cleanup", () => {
    const cacheStorage = {
      open: vi.fn(() => Promise.resolve({})),
      keys: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("caches", cacheStorage);
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: true }),
    );
    const wrappedOpen = cacheStorage.open;
    Object.defineProperty(cacheStorage, "open", {
      configurable: false,
      value: wrappedOpen,
      writable: false,
    });

    expect(() => cleanup()).toThrow(
      "storage collector could not fully restore its patches",
    );
  });

  it("does not emit IndexedDB or Cache API failures while the trigger is disabled", async () => {
    const request = new EventTarget() as IDBRequest;
    Object.defineProperty(request, "error", {
      value: new DOMException("private", "UnknownError"),
    });
    const factory = {
      open: vi.fn((_name: string) => request),
      deleteDatabase: vi.fn((_name: string) => request),
    };
    const cacheStorage = {
      open: vi.fn((_name: string) =>
        Promise.reject(new Error("private cache failure")),
      ),
      delete: vi.fn((_name: string) => Promise.resolve(false)),
      has: vi.fn((_name: string) => Promise.resolve(false)),
      match: vi.fn((_request: RequestInfo | URL) => Promise.resolve(undefined)),
      keys: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("caches", cacheStorage);
    const cleanup = storageCollector(
      bus,
      makeConfig({ autoFlagOnStorageFailure: false }),
    );

    factory.open("private").dispatchEvent(new Event("error"));
    await expect(cacheStorage.open("private")).rejects.toThrow(
      "private cache failure",
    );
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
