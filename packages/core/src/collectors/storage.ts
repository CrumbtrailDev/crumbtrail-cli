import type { EventBus } from "../event-bus";
import type {
  CollectorCleanup,
  CollectorContext,
  CrumbtrailConfig,
} from "../types";
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

function restoreOwnedStorageMethod(
  storage: object,
  method: string,
  wrapper: Function,
  originalDescriptor: PropertyDescriptor | undefined,
  originalFunction: Function,
): void {
  if ((storage as Record<string, unknown>)[method] !== wrapper)
    throw new Error(`storage wrapper for ${method} is no longer owned`);
  if (originalDescriptor)
    Object.defineProperty(storage, method, originalDescriptor);
  else {
    // happy-dom exposes Storage instances through a Proxy that rejects deleting
    // these properties. Re-defining the original bound method is reversible and
    // keeps the instance usable in that environment.
    Object.defineProperty(storage, method, {
      configurable: true,
      enumerable: false,
      value: originalFunction,
      writable: true,
    });
  }

  const restored = originalDescriptor
    ? Object.getOwnPropertyDescriptor(storage, method)?.value ===
      originalDescriptor.value
    : (storage as Record<string, unknown>)[method] === originalFunction;
  if (!restored)
    throw new Error(`storage wrapper for ${method} was not restored`);
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

type StorageFailureType = "idb" | "cache";
type StorageMethod = (this: unknown, ...args: unknown[]) => unknown;

interface StorageLifecycle {
  active: boolean;
}

interface OwnedPatch {
  owner: symbol;
  createWrapper: (original: StorageMethod) => StorageMethod;
  wrapper?: StorageMethod;
  active: boolean;
}

interface PatchStack {
  baseDescriptor?: PropertyDescriptor;
  baseFunction: StorageMethod;
  patches: OwnedPatch[];
}

const ownedPatches = new WeakMap<object, Map<string, PatchStack>>();

function currentMethod(target: object, method: string): StorageMethod | undefined {
  try {
    const value = (target as Record<string, unknown>)[method];
    return typeof value === "function" ? (value as StorageMethod) : undefined;
  } catch {
    return undefined;
  }
}

function materializePatchStack(
  target: object,
  method: string,
  stack: PatchStack,
): void {
  let value = stack.baseFunction;
  for (const patch of stack.patches) {
    value = patch.createWrapper(value);
    patch.wrapper = value;
  }

  const descriptor = stack.baseDescriptor
    ? { ...stack.baseDescriptor, value }
    : {
        configurable: true,
        enumerable: false,
        value,
        writable: true,
      };
  Object.defineProperty(target, method, descriptor);
}

function restorePatchStack(
  target: object,
  method: string,
  stack: PatchStack,
): void {
  if (stack.baseDescriptor) {
    Object.defineProperty(target, method, stack.baseDescriptor);
  } else {
    delete (target as Record<string, unknown>)[method];
  }

  const restored = stack.baseDescriptor
    ? Object.getOwnPropertyDescriptor(target, method)?.value ===
      stack.baseDescriptor.value
    : Object.getOwnPropertyDescriptor(target, method) === undefined;
  if (!restored)
    throw new Error(`storage wrapper for ${method} was not restored`);
}

function patchOwnedMethod(
  target: object,
  method: string,
  owner: symbol,
  createWrapper: (original: StorageMethod) => StorageMethod,
): CollectorCleanup {
  let methods = ownedPatches.get(target);
  let stack = methods?.get(method);
  if (stack?.patches.some((patch) => patch.owner === owner)) return () => {};

  const current = currentMethod(target, method);
  if (!current) return () => {};

  if (!stack) {
    let baseDescriptor: PropertyDescriptor | undefined;
    try {
      baseDescriptor = Object.getOwnPropertyDescriptor(target, method);
    } catch {
      return () => {};
    }
    stack = {
      baseDescriptor,
      baseFunction: current,
      patches: [],
    };
    methods ??= new Map();
    methods.set(method, stack);
    ownedPatches.set(target, methods);
  } else {
    const top = stack.patches[stack.patches.length - 1];
    if (top && current !== top.wrapper) {
      return () => {};
    }
  }

  const patch: OwnedPatch = { owner, createWrapper, active: true };
  stack.patches.push(patch);
  try {
    materializePatchStack(target, method, stack);
  } catch {
    stack.patches.pop();
    if (stack.patches.length === 0) {
      methods?.delete(method);
      if (methods?.size === 0) ownedPatches.delete(target);
    }
    return () => {};
  }

  return () => {
    if (!patch.active) return;
    const currentStack = ownedPatches.get(target)?.get(method);
    if (!currentStack || !currentStack.patches.includes(patch)) {
      patch.active = false;
      return;
    }

    const top = currentStack.patches[currentStack.patches.length - 1];
    if (!top || currentMethod(target, method) !== top.wrapper) {
      throw new Error(`storage wrapper for ${method} is no longer owned`);
    }

    const index = currentStack.patches.indexOf(patch);
    currentStack.patches.splice(index, 1);
    try {
      if (currentStack.patches.length > 0)
        materializePatchStack(target, method, currentStack);
      else restorePatchStack(target, method, currentStack);
    } catch (error) {
      currentStack.patches.splice(index, 0, patch);
      throw error;
    }

    patch.active = false;
    if (currentStack.patches.length === 0) {
      const targetMethods = ownedPatches.get(target);
      targetMethods?.delete(method);
      if (targetMethods?.size === 0) ownedPatches.delete(target);
    }
  };
}

function isAbortedStorageError(error: unknown): boolean {
  return boundedStorageErrorName(error) === "AbortError";
}

function reportAsyncStorageFailure(
  bus: EventBus,
  config: CrumbtrailConfig,
  type: StorageFailureType,
  op: string,
  error: unknown,
  lifecycle: StorageLifecycle,
): void {
  if (
    !lifecycle.active ||
    !config.autoFlagOnStorageFailure ||
    isAbortedStorageError(error)
  )
    return;
  try {
    bus.emit({
      t: now(),
      k: "stor",
      d: {
        type,
        op,
        outcome: "failure",
        errorName: boundedStorageErrorName(error),
      },
    });
  } catch {
    // Observing a failure must never alter the host API's failure path.
  }
}

function observePromise(
  value: unknown,
  report: (error: unknown) => void,
  onFulfilled?: (value: unknown) => void,
): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    return value;
  let rejectedByThen = false;
  try {
    const then = (value as Promise<unknown>).then;
    if (typeof then === "function") {
      // The returned branch rethrows so an ignored host operation still produces
      // an unhandled rejection. Attaching a rejection handler and returning the
      // host promise would mark that promise handled and hide the failure.
      return then.call(
        value,
        (result: unknown) => {
          try {
            onFulfilled?.(result);
          } catch {
            // Storage instrumentation is observational only.
          }
          return result;
        },
        (error: unknown) => {
          rejectedByThen = true;
          try {
            report(error);
          } catch {
            // Storage instrumentation is observational only.
          }
          throw error;
        },
      );
    }
  } catch (error) {
    if (rejectedByThen) return Promise.reject(error);
    // An exotic thenable is not worth changing the host operation for.
  }
  return value;
}

function patchFailureMethod(
  target: object,
  method: string,
  operation: string,
  type: StorageFailureType,
  bus: EventBus,
  config: CrumbtrailConfig,
  lifecycle: StorageLifecycle,
  owner: symbol,
  onResult?: (value: unknown, receiver: unknown) => void,
  onFulfilled?: (value: unknown) => void,
): () => void {
  return patchOwnedMethod(
    target,
    method,
    owner,
    (original) =>
      function patchedStorageFailureMethod(this: unknown, ...args: unknown[]) {
        try {
          const result = original.apply(this, args);
          const observed = observePromise(
            result,
            (error) =>
              reportAsyncStorageFailure(
                bus,
                config,
                type,
                operation,
                error,
                lifecycle,
              ),
            onFulfilled,
          );
          if (onResult) {
            try {
              onResult(result, this);
            } catch {
              // Storage instrumentation is observational only.
            }
          }
          return observed;
        } catch (error) {
          reportAsyncStorageFailure(
            bus,
            config,
            type,
            operation,
            error,
            lifecycle,
          );
          throw error;
        }
      },
  );
}

type IdempotentListenerCleanup = () => void;

function isObjectLike(value: unknown): value is object {
  return !!value && (typeof value === "object" || typeof value === "function");
}

function readObjectProperty(target: object, property: string): unknown {
  try {
    return (target as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function hasOwnProperty(target: object, property: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(target, property);
  } catch {
    return false;
  }
}

function installIndexedDbFailureCapture(
  bus: EventBus,
  config: CrumbtrailConfig,
  lifecycle: StorageLifecycle,
): CollectorCleanup {
  const factory = readObjectProperty(globalThis, "indexedDB");
  if (!isObjectLike(factory)) return () => {};

  const owner = Symbol("crumbtrail-indexeddb");
  const restores: CollectorCleanup[] = [];
  const listenerRestores: IdempotentListenerCleanup[] = [];
  const requests = new WeakMap<
    object,
    { operation: string; reported: boolean }
  >();
  const transactions = new WeakMap<object, { reported: boolean }>();
  const patchedPrototypeMethods = new Map<string, Set<string>>();

  const report = (operation: string, error: unknown) =>
    reportAsyncStorageFailure(bus, config, "idb", operation, error, lifecycle);

  const listen = (
    target: object,
    event: string,
    listener: EventListener,
  ): void => {
    const add = readObjectProperty(target, "addEventListener");
    const remove = readObjectProperty(target, "removeEventListener");
    if (typeof add !== "function" || typeof remove !== "function") return;
    try {
      (add as StorageMethod).call(target, event, listener);
      let removed = false;
      listenerRestores.push(() => {
        if (removed) return;
        (remove as StorageMethod).call(target, event, listener);
        removed = true;
      });
    } catch {
      // The host object remains usable if its event surface is not patchable.
    }
  };

  const attachTransaction = (transaction: unknown): void => {
    if (!lifecycle.active || !isObjectLike(transaction)) return;
    if (transactions.has(transaction)) return;
    const state = { reported: false };
    transactions.set(transaction, state);
    const transactionError = () => {
      if (state.reported) return;
      state.reported = true;
      report(
        "database.transaction.error",
        readObjectProperty(transaction, "error"),
      );
    };
    const transactionAbort = () => {
      if (state.reported) return;
      const error = readObjectProperty(transaction, "error");
      // A clean, deliberate abort has no error. An AbortError is ignored by
      // report() for the same reason as request AbortError failures.
      if (!error) return;
      state.reported = true;
      report("database.transaction.abort", error);
    };
    listen(transaction, "error", transactionError);
    listen(transaction, "abort", transactionAbort);
  };

  const attachRequest = (
    request: unknown,
    operation: string,
    onSuccess?: (result: unknown) => void,
  ): void => {
    if (!lifecycle.active || !isObjectLike(request)) return;
    const existing = requests.get(request);
    if (existing) {
      existing.operation = operation;
      return;
    }
    const state = { operation, reported: false };
    requests.set(request, state);
    const requestError = () => {
      if (state.reported) return;
      state.reported = true;
      report(state.operation, readObjectProperty(request, "error"));
    };
    const requestSuccess = () => {
      if (!lifecycle.active || !onSuccess) return;
      onSuccess(readObjectProperty(request, "result"));
    };
    listen(request, "error", requestError);
    listen(request, "success", requestSuccess);
  };

  const attachCursorRequest = (cursor: unknown, operation: string): void => {
    if (!isObjectLike(cursor)) return;
    attachRequest(readObjectProperty(cursor, "request"), operation);
  };

  type MethodDefinition = [
    method: string,
    operation: string,
    onResult?: (result: unknown, receiver: unknown) => void,
  ];

  const patchMethods = (
    target: object,
    group: string,
    definitions: readonly MethodDefinition[],
    skipPatchedPrototypeMethods = false,
  ): void => {
    const patched = patchedPrototypeMethods.get(group);
    for (const [method, operation, onResult] of definitions) {
      if (
        skipPatchedPrototypeMethods &&
        patched?.has(method) &&
        !hasOwnProperty(target, method)
      )
        continue;
      const before = currentMethod(target, method);
      const restore = patchFailureMethod(
        target,
        method,
        operation,
        "idb",
        bus,
        config,
        lifecycle,
        owner,
        onResult,
      );
      restores.push(restore);
      if (target !== factory && currentMethod(target, method) !== before) {
        const methods = patchedPrototypeMethods.get(group) ?? new Set<string>();
        methods.add(method);
        patchedPrototypeMethods.set(group, methods);
      }
    }
  };

  const databaseMethods: MethodDefinition[] = [
    [
      "transaction",
      "database.transaction",
      (result) => attachTransaction(result),
    ],
    [
      "createObjectStore",
      "database.createObjectStore",
      (result) => attachObjectStore(result),
    ],
    ["deleteObjectStore", "database.deleteObjectStore"],
  ];
  const transactionMethods: MethodDefinition[] = [
    [
      "objectStore",
      "transaction.objectStore",
      (result) => attachObjectStore(result),
    ],
    ["abort", "transaction.abort"],
    ["commit", "transaction.commit"],
  ];
  const objectStoreMethods: MethodDefinition[] = [
    [
      "add",
      "objectStore.add",
      (result) => attachRequest(result, "objectStore.add"),
    ],
    [
      "clear",
      "objectStore.clear",
      (result) => attachRequest(result, "objectStore.clear"),
    ],
    [
      "count",
      "objectStore.count",
      (result) => attachRequest(result, "objectStore.count"),
    ],
    [
      "delete",
      "objectStore.delete",
      (result) => attachRequest(result, "objectStore.delete"),
    ],
    [
      "get",
      "objectStore.get",
      (result) => attachRequest(result, "objectStore.get"),
    ],
    [
      "getAll",
      "objectStore.getAll",
      (result) => attachRequest(result, "objectStore.getAll"),
    ],
    [
      "getAllKeys",
      "objectStore.getAllKeys",
      (result) => attachRequest(result, "objectStore.getAllKeys"),
    ],
    [
      "getKey",
      "objectStore.getKey",
      (result) => attachRequest(result, "objectStore.getKey"),
    ],
    ["index", "objectStore.index", (result) => attachIndex(result)],
    [
      "openCursor",
      "objectStore.openCursor",
      (result) => attachRequest(result, "objectStore.openCursor", attachCursor),
    ],
    [
      "openKeyCursor",
      "objectStore.openKeyCursor",
      (result) =>
        attachRequest(result, "objectStore.openKeyCursor", attachCursor),
    ],
    [
      "put",
      "objectStore.put",
      (result) => attachRequest(result, "objectStore.put"),
    ],
  ];
  const indexMethods: MethodDefinition[] = [
    ["count", "index.count", (result) => attachRequest(result, "index.count")],
    ["get", "index.get", (result) => attachRequest(result, "index.get")],
    [
      "getAll",
      "index.getAll",
      (result) => attachRequest(result, "index.getAll"),
    ],
    [
      "getAllKeys",
      "index.getAllKeys",
      (result) => attachRequest(result, "index.getAllKeys"),
    ],
    [
      "getKey",
      "index.getKey",
      (result) => attachRequest(result, "index.getKey"),
    ],
    [
      "openCursor",
      "index.openCursor",
      (result) => attachRequest(result, "index.openCursor", attachCursor),
    ],
    [
      "openKeyCursor",
      "index.openKeyCursor",
      (result) => attachRequest(result, "index.openKeyCursor", attachCursor),
    ],
  ];
  const cursorMethods: MethodDefinition[] = [
    [
      "advance",
      "cursor.advance",
      (_result, receiver) => attachCursorRequest(receiver, "cursor.advance"),
    ],
    [
      "continue",
      "cursor.continue",
      (_result, receiver) => attachCursorRequest(receiver, "cursor.continue"),
    ],
    [
      "continuePrimaryKey",
      "cursor.continuePrimaryKey",
      (_result, receiver) =>
        attachCursorRequest(receiver, "cursor.continuePrimaryKey"),
    ],
  ];

  function attachObjectStore(store: unknown): void {
    if (!lifecycle.active || !isObjectLike(store)) return;
    patchMethods(store, "objectStore", objectStoreMethods, true);
  }

  function attachIndex(index: unknown): void {
    if (!lifecycle.active || !isObjectLike(index)) return;
    patchMethods(index, "index", indexMethods, true);
  }

  function attachCursor(cursor: unknown): void {
    if (!lifecycle.active || !isObjectLike(cursor)) return;
    patchMethods(cursor, "cursor", cursorMethods, true);
  }

  const constructorNames: Array<
    [name: string, group: string, definitions: readonly MethodDefinition[]]
  > = [
    ["IDBDatabase", "database", databaseMethods],
    ["IDBTransaction", "transaction", transactionMethods],
    ["IDBObjectStore", "objectStore", objectStoreMethods],
    ["IDBIndex", "index", indexMethods],
    ["IDBCursor", "cursor", cursorMethods],
  ];
  for (const [name, group, definitions] of constructorNames) {
    const constructor = readObjectProperty(globalThis, name);
    const prototype = isObjectLike(constructor)
      ? readObjectProperty(constructor, "prototype")
      : undefined;
    if (!isObjectLike(prototype)) continue;
    const before = new Map(
      definitions.map(([method]) => [method, currentMethod(prototype, method)]),
    );
    patchMethods(prototype, group, definitions);
    for (const [method] of definitions) {
      if (currentMethod(prototype, method) !== before.get(method)) {
        const methods = patchedPrototypeMethods.get(group) ?? new Set<string>();
        methods.add(method);
        patchedPrototypeMethods.set(group, methods);
      }
    }
  }

  patchMethods(factory, "factory", [
    [
      "open",
      "open",
      (result) =>
        attachRequest(result, "open", (database) => {
          attachDatabase(database);
        }),
    ],
    [
      "deleteDatabase",
      "deleteDatabase",
      (result) => attachRequest(result, "deleteDatabase"),
    ],
    ["databases", "databases"],
  ]);

  function attachDatabase(database: unknown): void {
    if (!lifecycle.active || !isObjectLike(database)) return;
    patchMethods(database, "database", databaseMethods, true);
  }

  return () => {
    lifecycle.active = false;
    const failures: unknown[] = [];
    for (const restore of [...listenerRestores].reverse()) {
      try {
        restore();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const restore of [...restores].reverse()) {
      try {
        restore();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new Error("IndexedDB instrumentation could not be fully restored");
  };
}

function installCacheFailureCapture(
  bus: EventBus,
  config: CrumbtrailConfig,
  lifecycle: StorageLifecycle,
): CollectorCleanup {
  const cacheStorage = readObjectProperty(globalThis, "caches");
  if (!isObjectLike(cacheStorage)) return () => {};

  const owner = Symbol("crumbtrail-cache");
  const restores: CollectorCleanup[] = [];
  const cacheMethods = [
    ["match", "match"],
    ["matchAll", "matchAll"],
    ["add", "add"],
    ["addAll", "addAll"],
    ["put", "put"],
    ["delete", "delete"],
    ["keys", "keys"],
  ] as const;
  const patchedPrototypeMethods = new Set<string>();

  const patchCache = (cache: unknown): void => {
    if (!lifecycle.active || !isObjectLike(cache)) return;
    // Cache.prototype covers objects acquired before init. Without it, the
    // platform exposes no safe way to enumerate and patch those objects, so
    // this fallback only covers objects returned by caches.open after init.
    for (const [method] of cacheMethods) {
      if (patchedPrototypeMethods.has(method) && !hasOwnProperty(cache, method))
        continue;
      restores.push(
        patchFailureMethod(
          cache,
          method,
          method,
          "cache",
          bus,
          config,
          lifecycle,
          owner,
        ),
      );
    }
  };

  const cacheConstructor = readObjectProperty(globalThis, "Cache");
  const cachePrototype = isObjectLike(cacheConstructor)
    ? readObjectProperty(cacheConstructor, "prototype")
    : undefined;
  if (isObjectLike(cachePrototype)) {
    for (const [method] of cacheMethods) {
      const before = currentMethod(cachePrototype, method);
      restores.push(
        patchFailureMethod(
          cachePrototype,
          method,
          method,
          "cache",
          bus,
          config,
          lifecycle,
          owner,
        ),
      );
      if (currentMethod(cachePrototype, method) !== before)
        patchedPrototypeMethods.add(method);
    }
  }

  for (const method of ["open", "delete", "has", "match", "keys"]) {
    restores.push(
      patchFailureMethod(
        cacheStorage,
        method,
        method,
        "cache",
        bus,
        config,
        lifecycle,
        owner,
        undefined,
        method === "open" ? patchCache : undefined,
      ),
    );
  }

  return () => {
    lifecycle.active = false;
    const failures: unknown[] = [];
    for (const restore of [...restores].reverse()) {
      try {
        restore();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new Error("Cache instrumentation could not be fully restored");
  };
}

export function storageCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
  context?: CollectorContext,
): CollectorCleanup {
  const collectorLifecycle: StorageLifecycle = { active: true };
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
            if (!collectorLifecycle.active) return;
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
            if (!collectorLifecycle.active) return;
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
  const origProtoSetItemDescriptor = Object.getOwnPropertyDescriptor(
    Storage.prototype,
    "setItem",
  );
  const origProtoRemoveItemDescriptor = Object.getOwnPropertyDescriptor(
    Storage.prototype,
    "removeItem",
  );
  const origProtoClearDescriptor = Object.getOwnPropertyDescriptor(
    Storage.prototype,
    "clear",
  );

  // Bind originals from instances (before any patching) so we can call through
  const origLocalSetItem = localStorage.setItem.bind(localStorage);
  const origLocalRemoveItem = localStorage.removeItem.bind(localStorage);
  const origLocalClear = localStorage.clear.bind(localStorage);

  const origSessionSetItem = sessionStorage.setItem.bind(sessionStorage);
  const origSessionRemoveItem = sessionStorage.removeItem.bind(sessionStorage);
  const origSessionClear = sessionStorage.clear.bind(sessionStorage);
  const origLocalSetItemDescriptor = Object.getOwnPropertyDescriptor(
    localStorage,
    "setItem",
  );
  const origLocalRemoveItemDescriptor = Object.getOwnPropertyDescriptor(
    localStorage,
    "removeItem",
  );
  const origLocalClearDescriptor = Object.getOwnPropertyDescriptor(
    localStorage,
    "clear",
  );
  const origSessionSetItemDescriptor = Object.getOwnPropertyDescriptor(
    sessionStorage,
    "setItem",
  );
  const origSessionRemoveItemDescriptor = Object.getOwnPropertyDescriptor(
    sessionStorage,
    "removeItem",
  );
  const origSessionClearDescriptor = Object.getOwnPropertyDescriptor(
    sessionStorage,
    "clear",
  );

  // --- Patched method factories ---
  function recordSet(
    type: "local" | "session",
    key: string,
    value: string,
    oldValue: string | null | undefined,
    outcome: "success" | "failure",
    errorName?: string,
  ): void {
    if (collectorLifecycle.active && !excludeKeys.has(key)) {
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
    if (collectorLifecycle.active && !excludeKeys.has(key)) {
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
    if (!collectorLifecycle.active) return;
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
  const patchedProtoSetItem = function patchedProtoSetItem(
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
  Storage.prototype.setItem = patchedProtoSetItem;
  const patchedProtoRemoveItem = function patchedProtoRemoveItem(
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
  Storage.prototype.removeItem = patchedProtoRemoveItem;
  const patchedProtoClear = function patchedProtoClear(this: Storage) {
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
  Storage.prototype.clear = patchedProtoClear;

  // Patch instances via Object.defineProperty (works in Proxy-based environments
  // like happy-dom where direct assignment and prototype patching are bypassed)
  const patchedLocalSetItem = makeSetItem(
    "local",
    localStorage,
    origLocalSetItem,
  );
  const patchedLocalRemoveItem = makeRemoveItem(
    "local",
    localStorage,
    origLocalRemoveItem,
  );
  const patchedLocalClear = makeClear("local", origLocalClear);
  patchStorageMethod(localStorage, "setItem", patchedLocalSetItem);
  patchStorageMethod(localStorage, "removeItem", patchedLocalRemoveItem);
  patchStorageMethod(localStorage, "clear", patchedLocalClear);

  const patchedSessionSetItem = makeSetItem(
    "session",
    sessionStorage,
    origSessionSetItem,
  );
  const patchedSessionRemoveItem = makeRemoveItem(
    "session",
    sessionStorage,
    origSessionRemoveItem,
  );
  const patchedSessionClear = makeClear("session", origSessionClear);
  patchStorageMethod(sessionStorage, "setItem", patchedSessionSetItem);
  patchStorageMethod(sessionStorage, "removeItem", patchedSessionRemoveItem);
  patchStorageMethod(sessionStorage, "clear", patchedSessionClear);

  let storageFailureHooksActive = false;
  let storageFailureHooksPoisoned = false;
  let storageFailureCleanupError: unknown;
  let storageFailureCleanup: CollectorCleanup = () => {};

  const syncStorageFailureHooks = (): void => {
    if (!collectorLifecycle.active || storageFailureHooksPoisoned) return;
    const shouldCapture = config.autoFlagOnStorageFailure;
    if (shouldCapture && !storageFailureHooksActive) {
      const hookLifecycle: StorageLifecycle = { active: true };
      const indexedDbCleanup = config.captureIdb
        ? installIndexedDbFailureCapture(bus, config, hookLifecycle)
        : () => {};
      const cacheCleanup = config.captureCacheApi
        ? installCacheFailureCapture(bus, config, hookLifecycle)
        : () => {};
      storageFailureCleanup = () => {
        const failures: unknown[] = [];
        for (const cleanup of [cacheCleanup, indexedDbCleanup]) {
          try {
            cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0)
          throw new Error(
            "storage failure instrumentation could not be fully restored",
          );
      };
      storageFailureHooksActive = true;
      return;
    }
    if (!shouldCapture && storageFailureHooksActive) {
      const cleanup = storageFailureCleanup;
      storageFailureCleanup = () => {};
      storageFailureHooksActive = false;
      try {
        cleanup();
      } catch (error) {
        storageFailureCleanupError ??= error;
        storageFailureHooksPoisoned = true;
      }
    }
  };
  const unregisterStorageFailureSync = context?.registerStorageFailureSync?.(
    syncStorageFailureHooks,
  );
  syncStorageFailureHooks();

  // --- Cross-tab storage events ---
  const storageHandler = (event: StorageEvent) => {
    if (!collectorLifecycle.active) return;
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
  let cleanupComplete = false;

  return () => {
    if (cleanupComplete) return;
    collectorLifecycle.active = false;
    unregisterStorageFailureSync?.();
    const results = [
      step(() => {
        restoreOwnedStorageMethod(
          Storage.prototype,
          "setItem",
          patchedProtoSetItem,
          origProtoSetItemDescriptor,
          origProtoSetItem,
        );
      }),
      step(() => {
        restoreOwnedStorageMethod(
          Storage.prototype,
          "removeItem",
          patchedProtoRemoveItem,
          origProtoRemoveItemDescriptor,
          origProtoRemoveItem,
        );
      }),
      step(() => {
        restoreOwnedStorageMethod(
          Storage.prototype,
          "clear",
          patchedProtoClear,
          origProtoClearDescriptor,
          origProtoClear,
        );
      }),
      // Restore instance methods to their original bound functions
      step(() =>
        restoreOwnedStorageMethod(
          localStorage,
          "setItem",
          patchedLocalSetItem,
          origLocalSetItemDescriptor,
          origLocalSetItem,
        ),
      ),
      step(() =>
        restoreOwnedStorageMethod(
          localStorage,
          "removeItem",
          patchedLocalRemoveItem,
          origLocalRemoveItemDescriptor,
          origLocalRemoveItem,
        ),
      ),
      step(() =>
        restoreOwnedStorageMethod(
          localStorage,
          "clear",
          patchedLocalClear,
          origLocalClearDescriptor,
          origLocalClear,
        ),
      ),
      step(() =>
        restoreOwnedStorageMethod(
          sessionStorage,
          "setItem",
          patchedSessionSetItem,
          origSessionSetItemDescriptor,
          origSessionSetItem,
        ),
      ),
      step(() =>
        restoreOwnedStorageMethod(
          sessionStorage,
          "removeItem",
          patchedSessionRemoveItem,
          origSessionRemoveItemDescriptor,
          origSessionRemoveItem,
        ),
      ),
      step(() =>
        restoreOwnedStorageMethod(
          sessionStorage,
          "clear",
          patchedSessionClear,
          origSessionClearDescriptor,
          origSessionClear,
        ),
      ),
      step(() => window.removeEventListener("storage", storageHandler)),
      step(storageFailureCleanup),
      step(() => {
        if (storageFailureCleanupError) throw storageFailureCleanupError;
      }),
    ];

    // Reported, not swallowed: the caller's teardown handler is what stops a half-restored
    // collector from being installed over a second time.
    if (results.some((ok) => !ok))
      throw new Error("storage collector could not fully restore its patches");
    cleanupComplete = true;
  };
}
