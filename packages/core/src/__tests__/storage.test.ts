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
    expect(storEvents[0].d).toMatchObject({ type: "local", op: "clear" });

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
