import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import {
  attachRedactionMetadata,
  mergeRedactionMetadata,
  redactCookieMap,
  redactStorageKey,
  redactStoredValue,
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

function dumpStorage(storage: Storage): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) {
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
    const valueResult = redactStoredValue(value, {
      key,
      maxLength: maxLen,
      path: `${type}.${keyResult.value}.value`,
    });
    out[keyResult.value] = valueResult.value;
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

export function storageCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const maxLen = config.storageValueMaxLength;
  const excludeKeys = new Set(config.storageExcludeKeys);

  const cookieSnap = redactCookieMap(
    parseCookies(document.cookie),
    "cookies",
    config.cookieMaskNames,
  );
  const localStorageSnap = redactStorageSnapshot(
    dumpStorage(localStorage),
    "localStorage",
    maxLen,
  );
  const sessionStorageSnap = redactStorageSnapshot(
    dumpStorage(sessionStorage),
    "sessionStorage",
    maxLen,
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
  function makeSetItem(
    type: "local" | "session",
    storage: Storage,
    origFn: (key: string, value: string) => void,
  ) {
    return function patchedSetItem(key: string, value: string) {
      if (!excludeKeys.has(key)) {
        const keyResult = redactStorageKey(key, `${type}.key`);
        const d: Record<string, unknown> = {
          type,
          op: "set",
          key: keyResult.value,
        };
        const oldValMetadata = assignRedactedStorageValue(
          d,
          "oldVal",
          redactStoredValue(storage.getItem(key), {
            key,
            maxLength: maxLen,
            path: `${type}.${keyResult.value}.oldVal`,
          }),
        );
        const newValMetadata = assignRedactedStorageValue(
          d,
          "newVal",
          redactStoredValue(value, {
            key,
            maxLength: maxLen,
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
      return origFn(key, value);
    };
  }

  function makeRemoveItem(
    type: "local" | "session",
    storage: Storage,
    origFn: (key: string) => void,
  ) {
    return function patchedRemoveItem(key: string) {
      if (!excludeKeys.has(key)) {
        const keyResult = redactStorageKey(key, `${type}.key`);
        const d: Record<string, unknown> = {
          type,
          op: "del",
          key: keyResult.value,
        };
        const oldValMetadata = assignRedactedStorageValue(
          d,
          "oldVal",
          redactStoredValue(storage.getItem(key), {
            key,
            maxLength: maxLen,
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
      return origFn(key);
    };
  }

  function makeClear(type: "local" | "session", origFn: () => void) {
    return function patchedClear() {
      bus.emit({
        t: now(),
        k: "stor",
        d: { type, op: "clear" },
      });
      return origFn();
    };
  }

  // Patch prototype (works in real browsers where instance methods resolve via prototype)
  Storage.prototype.setItem = makeSetItem(
    "local",
    localStorage,
    origProtoSetItem,
  );
  Storage.prototype.removeItem = makeRemoveItem(
    "local",
    localStorage,
    origProtoRemoveItem,
  );
  Storage.prototype.clear = makeClear("local", origProtoClear);

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
        d: { type, op: "clear" },
      });
    } else if (event.newValue === null) {
      const keyResult = redactStorageKey(event.key, `${type}.key`);
      const d: Record<string, unknown> = {
        type,
        op: "del",
        key: keyResult.value,
      };
      const oldValMetadata = assignRedactedStorageValue(
        d,
        "oldVal",
        redactStoredValue(event.oldValue, {
          key: event.key,
          maxLength: maxLen,
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
      };
      const oldValMetadata = assignRedactedStorageValue(
        d,
        "oldVal",
        redactStoredValue(event.oldValue, {
          key: event.key,
          maxLength: maxLen,
          path: `${type}.${keyResult.value}.oldVal`,
        }),
      );
      const newValMetadata = assignRedactedStorageValue(
        d,
        "newVal",
        redactStoredValue(event.newValue, {
          key: event.key,
          maxLength: maxLen,
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
  return () => {
    Storage.prototype.setItem = origProtoSetItem;
    Storage.prototype.removeItem = origProtoRemoveItem;
    Storage.prototype.clear = origProtoClear;

    // Restore instance methods to their original bound functions
    restoreStorageMethod(localStorage, "setItem", origLocalSetItem);
    restoreStorageMethod(localStorage, "removeItem", origLocalRemoveItem);
    restoreStorageMethod(localStorage, "clear", origLocalClear);
    restoreStorageMethod(sessionStorage, "setItem", origSessionSetItem);
    restoreStorageMethod(sessionStorage, "removeItem", origSessionRemoveItem);
    restoreStorageMethod(sessionStorage, "clear", origSessionClear);

    window.removeEventListener("storage", storageHandler);
  };
}
