import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import {
  attachRedactionMetadata,
  mergeRedactionMetadata,
  redactCookieMap,
  redactStorageKey,
  redactStoredValue,
  uniqueOutputKey,
  type RedactionMetadata,
  type RedactionResult,
} from "../redaction";
import { now } from "../utils";

function parseCookies(cookieStr: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!cookieStr) return map;
  const pairs = cookieStr.split(";");
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name) map[name] = value;
  }
  return map;
}

/**
 * The store's current contents, minus anything the deployment excluded.
 *
 * `storageExcludeKeys` gated `setItem`, `removeItem` and the cross-tab handler
 * and not this, so a key already present at `init()` had its NAME published in
 * the opening snapshot despite an explicit opt-out.
 */
function dumpStorage(
  storage: Storage,
  excludeKeys: Set<string>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && !excludeKeys.has(key)) {
      map[key] = storage.getItem(key) ?? "";
    }
  }
  return map;
}

function redactStorageSnapshot(
  values: Record<string, string>,
  type: "localStorage" | "sessionStorage",
  maxLen: number,
): RedactionResult<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  const metadataItems: Array<RedactionMetadata | undefined> = [];

  for (const [key, value] of Object.entries(values)) {
    const keyResult = redactStorageKey(key, `${type}.key`);
    // Every sensitive key redacts to one constant, so `authToken`,
    // `refreshToken` and `user_session_secret` used to write a single entry.
    // The suffix keeps the count honest without naming anything.
    const outKey = uniqueOutputKey(keyResult.value, out);
    const valueResult = redactStoredValue(value, {
      key,
      maxLength: maxLen,
      path: `${type}.${outKey}.value`,
    });
    out[outKey] = valueResult.value;
    metadataItems.push(keyResult.metadata, valueResult.metadata);
  }

  const metadata = mergeRedactionMetadata(...metadataItems);
  return { value: out, ...(metadata ? { metadata } : {}) };
}

function redactStorageNameList(
  values: Array<string | undefined>,
  path: string,
): RedactionResult<string[]> {
  const out: string[] = [];
  const metadataItems: Array<RedactionMetadata | undefined> = [];

  values.forEach((value, index) => {
    if (!value) {
      out.push("");
      return;
    }
    const result = redactStorageKey(value, `${path}[${index}]`);
    out.push(result.value);
    metadataItems.push(result.metadata);
  });

  const metadata = mergeRedactionMetadata(...metadataItems);
  return { value: out, ...(metadata ? { metadata } : {}) };
}

function mergeIntoRedactionMetadata(
  target: Record<string, unknown>,
  metadata?: RedactionMetadata,
): void {
  if (!metadata) return;
  const existing = isRedactionMetadata(target.redaction)
    ? target.redaction
    : undefined;
  attachRedactionMetadata(target, existing, metadata);
}

function isRedactionMetadata(value: unknown): value is RedactionMetadata {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as RedactionMetadata).policy === "crumbtrail.browser-redaction.v1" &&
    Array.isArray((value as RedactionMetadata).fields)
  );
}

function assignRedactedStorageValue(
  target: Record<string, unknown>,
  field: "oldVal" | "newVal",
  result: RedactionResult<string | undefined>,
): RedactionMetadata | undefined {
  if (result.value !== undefined) target[field] = result.value;
  if (result.summary) target[`${field}Summary`] = result.summary;
  return result.metadata;
}

/**
 * Patch a method on a Storage instance using Object.defineProperty.
 * Direct assignment (e.g. `localStorage.setItem = fn`) doesn't work in
 * environments that use a Proxy (like happy-dom), because the set trap
 * treats it as a storage key-value write. defineProperty bypasses the
 * Proxy set trap.
 */
function patchStorageMethod(
  storage: Storage,
  method: string,
  fn: Function,
): void {
  Object.defineProperty(storage, method, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function restoreStorageMethod(
  storage: Storage,
  method: string,
  origFn: Function,
): void {
  // Re-define back to the original bound function.
  // We can't use delete because happy-dom's Proxy rejects deleteProperty.
  Object.defineProperty(storage, method, {
    value: origFn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function boundedStorageErrorName(error: unknown): string {
  let name: unknown;
  try {
    name =
      error && (typeof error === "object" || typeof error === "function")
        ? (error as Record<string, unknown>).name
        : undefined;
  } catch {
    name = undefined;
  }
  if (typeof name !== "string") return "Error";
  const trimmed = name.trim().slice(0, 100);
  return trimmed || "Error";
}

function previousStorageValue(storage: Storage, key: string): string | null | undefined {
  try {
    return storage.getItem(key);
  } catch {
    return undefined;
  }
}

export function storageCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  // Read per emit rather than snapshotted at install: a remote policy lowers this cap
  // mid-session and the running collector is the one it has to reach.
  const maxLen = (): number => config.storageValueMaxLength;
  const excludeKeys = new Set(config.storageExcludeKeys);

  const cookieSnap = redactCookieMap(
    parseCookies(document.cookie),
    "cookies",
    config.cookieMaskNames,
  );
  const localStorageSnap = redactStorageSnapshot(
    dumpStorage(localStorage, excludeKeys),
    "localStorage",
    maxLen(),
  );
  const sessionStorageSnap = redactStorageSnapshot(
    dumpStorage(sessionStorage, excludeKeys),
    "sessionStorage",
    maxLen(),
  );

  // --- Emit initial snap ---
  const snapData: Record<string, unknown> = {
    cookies: cookieSnap.value,
    localStorage: localStorageSnap.value,
    sessionStorage: sessionStorageSnap.value,
  };
  attachRedactionMetadata(
    snapData,
    cookieSnap.metadata,
    localStorageSnap.metadata,
    sessionStorageSnap.metadata,
  );

  // IndexedDB (best-effort, async — fire and forget for snap)
  if (config.captureIdb) {
    try {
      const idbFactory =
        typeof indexedDB !== "undefined" ? indexedDB : undefined;
      if (idbFactory && typeof idbFactory.databases === "function") {
        idbFactory
          .databases()
          .then((dbs) => {
            const names = redactStorageNameList(
              dbs.map((db) => db.name),
              "idb.name",
            );
            snapData.idb = dbs.map((db, index) => ({
              name: names.value[index],
              version: db.version,
            }));
            mergeIntoRedactionMetadata(snapData, names.metadata);
          })
          .catch(() => {
            // locked or unavailable — ignore
          });
      }
    } catch {
      // indexedDB not available in this env
    }
  }

  // Cache API (best-effort)
  if (config.captureCacheApi) {
    try {
      if (typeof caches !== "undefined" && typeof caches.keys === "function") {
        caches
          .keys()
          .then((names) => {
            const redactedNames = redactStorageNameList(names, "cacheApi.name");
            snapData.cacheApi = redactedNames.value;
            mergeIntoRedactionMetadata(snapData, redactedNames.metadata);
          })
          .catch(() => {
            // unavailable — ignore
          });
      }
    } catch {
      // caches not available in this env
    }
  }

  bus.emit({ t: now(), k: "snap", d: snapData });

  // --- Save originals ---
  const origProtoSetItem = Storage.prototype.setItem;
  const origProtoRemoveItem = Storage.prototype.removeItem;
  const origProtoClear = Storage.prototype.clear;

  // Bind originals from instances (before any patching) so we can call through
  const origLocalSetItem = localStorage.setItem.bind(localStorage);
  const origLocalRemoveItem = localStorage.removeItem.bind(localStorage);
  const origLocalClear = localStorage.clear.bind(localStorage);

  const origSessionSetItem = sessionStorage.setItem.bind(sessionStorage);
  const origSessionRemoveItem = sessionStorage.removeItem.bind(sessionStorage);
  const origSessionClear = sessionStorage.clear.bind(sessionStorage);

  // --- Patched method factories ---
  function recordSet(
    type: "local" | "session",
    key: string,
    value: string,
    oldValue: string | null | undefined,
    outcome: "success" | "failure",
    errorName?: string,
  ): void {
    if (!excludeKeys.has(key)) {
      const keyResult = redactStorageKey(key, `${type}.key`);
      const d: Record<string, unknown> = {
        type,
        op: "set",
        key: keyResult.value,
        outcome,
        ...(errorName ? { errorName } : {}),
      };
      const oldValMetadata = assignRedactedStorageValue(
        d,
        "oldVal",
        redactStoredValue(oldValue, {
          key,
          maxLength: maxLen(),
          path: `${type}.${keyResult.value}.oldVal`,
        }),
      );
      const newValMetadata = assignRedactedStorageValue(
        d,
        "newVal",
        redactStoredValue(value, {
          key,
          maxLength: maxLen(),
          path: `${type}.${keyResult.value}.newVal`,
        }),
      );
      attachRedactionMetadata(
        d,
        keyResult.metadata,
        oldValMetadata,
        newValMetadata,
      );
      bus.emit({
        t: now(),
        k: "stor",
        d,
      });
    }
  }

  function makeSetItem(
    type: "local" | "session",
    storage: Storage,
    origFn: (key: string, value: string) => void,
  ) {
    return function patchedSetItem(key: string, value: string) {
      const oldValue = excludeKeys.has(key)
        ? undefined
        : previousStorageValue(storage, key);
      try {
        const result = origFn(key, value);
        try {
          recordSet(type, key, value, oldValue, "success");
        } catch {
          // Instrumentation must never change a successful host mutation.
        }
        return result;
      } catch (error) {
        try {
          recordSet(
            type,
            key,
            value,
            oldValue,
            "failure",
            boundedStorageErrorName(error),
          );
        } catch {
          // Preserve the original storage exception if redaction cannot run.
        }
        throw error;
      }
    };
  }

  function recordRemove(
    type: "local" | "session",
    key: string,
    oldValue: string | null | undefined,
    outcome: "success" | "failure",
    errorName?: string,
  ): void {
    if (!excludeKeys.has(key)) {
      const keyResult = redactStorageKey(key, `${type}.key`);
      const d: Record<string, unknown> = {
        type,
        op: "del",
        key: keyResult.value,
        outcome,
        ...(errorName ? { errorName } : {}),
      };
      const oldValMetadata = assignRedactedStorageValue(
        d,
        "oldVal",
        redactStoredValue(oldValue, {
          key,
          maxLength: maxLen(),
          path: `${type}.${keyResult.value}.oldVal`,
        }),
      );
      attachRedactionMetadata(d, keyResult.metadata, oldValMetadata);
      bus.emit({
        t: now(),
        k: "stor",
        d,
      });
    }
  }

  function makeRemoveItem(
    type: "local" | "session",
    storage: Storage,
    origFn: (key: string) => void,
  ) {
    return function patchedRemoveItem(key: string) {
      const oldValue = excludeKeys.has(key)
        ? undefined
        : previousStorageValue(storage, key);
      try {
        const result = origFn(key);
        try {
          recordRemove(type, key, oldValue, "success");
        } catch {
          // Instrumentation must never change a successful host mutation.
        }
        return result;
      } catch (error) {
        try {
          recordRemove(
            type,
            key,
            oldValue,
            "failure",
            boundedStorageErrorName(error),
          );
        } catch {
          // Preserve the original storage exception if redaction cannot run.
        }
        throw error;
      }
    };
  }

  function recordClear(
    type: "local" | "session",
    outcome: "success" | "failure",
    errorName?: string,
  ): void {
    bus.emit({
      t: now(),
      k: "stor",
      d: { type, op: "clear", outcome, ...(errorName ? { errorName } : {}) },
    });
  }

  function makeClear(type: "local" | "session", origFn: () => void) {
    return function patchedClear() {
      try {
        const result = origFn();
        try {
          recordClear(type, "success");
        } catch {
          // Instrumentation must never change a successful host mutation.
        }
        return result;
      } catch (error) {
        try {
          recordClear(type, "failure", boundedStorageErrorName(error));
        } catch {
          // Preserve the original storage exception if redaction cannot run.
        }
        throw error;
      }
    };
  }

  /**
   * Which store a prototype call was actually made against.
   *
   * The prototype patch used to hardcode `"local"` and read `oldVal` out of
   * `localStorage`, so `Storage.prototype.setItem.call(sessionStorage, k, v)` —
   * the usual way a wrapper bypasses an instance patch — was recorded as a
   * local write with a previous value taken from the wrong store.
   */
  function storageOf(self: unknown): {
    type: "local" | "session";
    storage: Storage;
  } {
    try {
      if (self === sessionStorage)
        return { type: "session", storage: sessionStorage };
      if (self instanceof Storage) return { type: "local", storage: self };
    } catch {
      // Cross-origin or a host without Storage: fall through to localStorage.
    }
    return { type: "local", storage: localStorage };
  }

  // Patch the prototype, for a call that reaches the method through it rather
  // than through one of the two instances patched below.
  //
  // These wrappers are deliberately not arrow functions and they call the
  // original with `.call(this, …)`. The original taken off `Storage.prototype`
  // is unbound, and a real browser throws `TypeError: Illegal invocation` when
  // it is invoked with no receiver — from inside the host page's own write, so
  // the SDK would break the application it is there to observe. happy-dom does
  // not, which is why the suite never saw it.
  Storage.prototype.setItem = function patchedProtoSetItem(
    this: Storage,
    key: string,
    value: string,
  ) {
    const { type, storage } = storageOf(this);
    const oldValue = excludeKeys.has(key)
      ? undefined
      : previousStorageValue(storage, key);
    try {
      const result = origProtoSetItem.call(this ?? storage, key, value);
      try {
        recordSet(type, key, value, oldValue, "success");
      } catch {
        // Instrumentation must never change a successful host mutation.
      }
      return result;
    } catch (error) {
      try {
        recordSet(
          type,
          key,
          value,
          oldValue,
          "failure",
          boundedStorageErrorName(error),
        );
      } catch {
        // Preserve the original storage exception if redaction cannot run.
      }
      throw error;
    }
  };
  Storage.prototype.removeItem = function patchedProtoRemoveItem(
    this: Storage,
    key: string,
  ) {
    const { type, storage } = storageOf(this);
    const oldValue = excludeKeys.has(key)
      ? undefined
      : previousStorageValue(storage, key);
    try {
      const result = origProtoRemoveItem.call(this ?? storage, key);
      try {
        recordRemove(type, key, oldValue, "success");
      } catch {
        // Instrumentation must never change a successful host mutation.
      }
      return result;
    } catch (error) {
      try {
        recordRemove(
          type,
          key,
          oldValue,
          "failure",
          boundedStorageErrorName(error),
        );
      } catch {
        // Preserve the original storage exception if redaction cannot run.
      }
      throw error;
    }
  };
  Storage.prototype.clear = function patchedProtoClear(this: Storage) {
    const { type, storage } = storageOf(this);
    try {
      const result = origProtoClear.call(this ?? storage);
      try {
        recordClear(type, "success");
      } catch {
        // Instrumentation must never change a successful host mutation.
      }
      return result;
    } catch (error) {
      try {
        recordClear(type, "failure", boundedStorageErrorName(error));
      } catch {
        // Preserve the original storage exception if redaction cannot run.
      }
      throw error;
    }
  };

  // Patch instances via Object.defineProperty (works in Proxy-based environments
  // like happy-dom where direct assignment and prototype patching are bypassed)
  patchStorageMethod(
    localStorage,
    "setItem",
    makeSetItem("local", localStorage, origLocalSetItem),
  );
  patchStorageMethod(
    localStorage,
    "removeItem",
    makeRemoveItem("local", localStorage, origLocalRemoveItem),
  );
  patchStorageMethod(localStorage, "clear", makeClear("local", origLocalClear));

  patchStorageMethod(
    sessionStorage,
    "setItem",
    makeSetItem("session", sessionStorage, origSessionSetItem),
  );
  patchStorageMethod(
    sessionStorage,
    "removeItem",
    makeRemoveItem("session", sessionStorage, origSessionRemoveItem),
  );
  patchStorageMethod(
    sessionStorage,
    "clear",
    makeClear("session", origSessionClear),
  );

  // --- Cross-tab storage events ---
  const storageHandler = (event: StorageEvent) => {
    if (event.key && excludeKeys.has(event.key)) return;

    const type = event.storageArea === localStorage ? "local" : "session";

    if (event.key === null) {
      bus.emit({
        t: now(),
        k: "stor",
        d: { type, op: "clear", outcome: "success" },
      });
    } else if (event.newValue === null) {
      const keyResult = redactStorageKey(event.key, `${type}.key`);
      const d: Record<string, unknown> = {
        type,
        op: "del",
        key: keyResult.value,
        outcome: "success",
      };
      const oldValMetadata = assignRedactedStorageValue(
        d,
        "oldVal",
        redactStoredValue(event.oldValue, {
          key: event.key,
          maxLength: maxLen(),
          path: `${type}.${keyResult.value}.oldVal`,
        }),
      );
      attachRedactionMetadata(d, keyResult.metadata, oldValMetadata);
      bus.emit({
        t: now(),
        k: "stor",
        d,
      });
    } else {
      const keyResult = redactStorageKey(event.key, `${type}.key`);
      const d: Record<string, unknown> = {
        type,
        op: "set",
        key: keyResult.value,
        outcome: "success",
      };
      const oldValMetadata = assignRedactedStorageValue(
        d,
        "oldVal",
        redactStoredValue(event.oldValue, {
          key: event.key,
          maxLength: maxLen(),
          path: `${type}.${keyResult.value}.oldVal`,
        }),
      );
      const newValMetadata = assignRedactedStorageValue(
        d,
        "newVal",
        redactStoredValue(event.newValue, {
          key: event.key,
          maxLength: maxLen(),
          path: `${type}.${keyResult.value}.newVal`,
        }),
      );
      attachRedactionMetadata(
        d,
        keyResult.metadata,
        oldValMetadata,
        newValMetadata,
      );
      bus.emit({
        t: now(),
        k: "stor",
        d,
      });
    }
  };

  window.addEventListener("storage", storageHandler);

  // --- Cleanup ---
  // Each restore runs on its own. This cleanup undoes nine independent patches, and a host that
  // has since frozen one of them throws on assignment. Sequentially, that first throw skipped
  // every restore after it, leaving the rest of the collector patched in with no teardown left
  // to remove it.
  const step = (restore: () => void): boolean => {
    try {
      restore();
      return true;
    } catch {
      return false;
    }
  };

  return () => {
    const results = [
      step(() => {
        Storage.prototype.setItem = origProtoSetItem;
      }),
      step(() => {
        Storage.prototype.removeItem = origProtoRemoveItem;
      }),
      step(() => {
        Storage.prototype.clear = origProtoClear;
      }),
      // Restore instance methods to their original bound functions
      step(() =>
        restoreStorageMethod(localStorage, "setItem", origLocalSetItem),
      ),
      step(() =>
        restoreStorageMethod(localStorage, "removeItem", origLocalRemoveItem),
      ),
      step(() => restoreStorageMethod(localStorage, "clear", origLocalClear)),
      step(() =>
        restoreStorageMethod(sessionStorage, "setItem", origSessionSetItem),
      ),
      step(() =>
        restoreStorageMethod(
          sessionStorage,
          "removeItem",
          origSessionRemoveItem,
        ),
      ),
      step(() =>
        restoreStorageMethod(sessionStorage, "clear", origSessionClear),
      ),
      step(() => window.removeEventListener("storage", storageHandler)),
    ];

    // Reported, not swallowed: the caller's teardown handler is what stops a half-restored
    // collector from being installed over a second time.
    if (results.some((ok) => !ok))
      throw new Error("storage collector could not fully restore its patches");
  };
}
