import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The request a piece of backend evidence was produced inside.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * A browser click that gets a 500, and the backend log line that explains it
 * ("relation public.marginary_events does not exist"), are two halves of one
 * failure. Correlating them is the product's core promise, and the join is the
 * request id: the browser stamps a 32 hex trace id on its fetch, the request
 * recorders read it back, and the cloud groups occurrences that share it.
 *
 * The log lane had no such id. `installBackendLogCapture` watches file
 * descriptors, and a file descriptor knows nothing about requests, so a
 * `backend.log` event carried whatever id the application's own logger had put
 * in the line — pino-http's per request uuid, which no browser has ever seen —
 * or none at all. The two halves therefore landed in two issues, each reporting
 * that no counterpart was found, while the id that would have joined them was
 * sitting in the request recorder a stack frame away.
 *
 * `AsyncLocalStorage` is what closes the gap. The request recorders claim a
 * request at the one place every Node framework converges on (`http.Server`
 * emitting `"request"`, and the Express middleware for a hand wired app), and
 * establish a store there. Everything the handler does afterwards — including
 * the awaits, the driver callbacks and the logger's write — runs inside that
 * store, so the log hook can ask "which request am I inside?" and stamp the
 * SAME id the request span carries.
 *
 * Three constraints shape this module:
 *
 * - **The lookup runs on every write the process makes.** `getStore()` is a
 *   pointer read on the current async resource, so it costs nothing measurable,
 *   and nothing here allocates on the read path.
 * - **It can never throw into the host.** Every accessor is wrapped: a runtime
 *   without `AsyncLocalStorage`, or a store some other code corrupted, degrades
 *   to "no request context", which is exactly the behaviour that existed before
 *   this module.
 * - **The store is mutable in place.** The http recorder establishes the
 *   context before it knows whether a framework aware recorder will claim the
 *   request; the Express middleware, which knows the matched route and mints
 *   the id the request's own events carry, upgrades the same store rather than
 *   opening a second one. One request, one context, whichever recorders saw it.
 */
export interface BackendRequestContext {
  /** The id this request's `backend.req.*` events carry. */
  requestId?: string;
  /** The session those events were filed to. */
  sessionId?: string;
  /**
   * Where that session came from, in the vocabulary of
   * `BackendRequestCorrelation`. `"process"` means nothing correlated this
   * request and the process's own session took it, so evidence produced inside
   * it must not be presented as joined to a browser.
   */
  sessionIdSource?: string;
}

const storage = new AsyncLocalStorage<BackendRequestContext>();

/**
 * Run `fn` with `context` as the ambient request context.
 *
 * The context object is stored by reference, so a later
 * {@link updateBackendRequestContext} inside the same request is visible to
 * everything already running in it.
 */
export function runInBackendRequestContext<T>(
  context: BackendRequestContext,
  fn: () => T,
): T {
  // Never wrapped in a try/catch that could swallow `fn`: an error the host's
  // request dispatch throws has to propagate exactly as it would without this.
  if (!storageUsable) return fn();
  return storage.run(context, fn);
}

/**
 * Whether `AsyncLocalStorage` works in this runtime, decided once at load.
 * Every accessor degrades to "no request context" when it does not, which is
 * precisely the behaviour that existed before this module.
 */
const storageUsable = ((): boolean => {
  try {
    storage.getStore();
    return true;
  } catch {
    return false;
  }
})();

/** The request being handled on this async path, when a recorder claimed one. */
export function getBackendRequestContext(): BackendRequestContext | undefined {
  if (!storageUsable) return undefined;
  try {
    const store = storage.getStore();
    return store && typeof store === "object" ? store : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fill in (or correct) the ambient request context.
 *
 * A no-op outside a request, so a recorder can call it unconditionally. Only
 * defined values are written: a framework recorder that knows the request id
 * but not the session must not erase a session the http recorder resolved.
 */
export function updateBackendRequestContext(
  patch: BackendRequestContext,
): void {
  const store = getBackendRequestContext();
  if (!store) return;
  try {
    if (patch.requestId !== undefined) store.requestId = patch.requestId;
    if (patch.sessionId !== undefined) store.sessionId = patch.sessionId;
    if (patch.sessionIdSource !== undefined)
      store.sessionIdSource = patch.sessionIdSource;
  } catch {
    // A frozen or exotic store is not worth failing a request over.
  }
}

/**
 * The correlation a piece of non request evidence should carry, or `undefined`
 * when it was produced outside any request.
 *
 * Returns the session only when a browser or a caller correlated the request:
 * evidence produced inside a process owned request already belongs to the
 * process session its capture is filing to, and re-stating it here would let a
 * caller present an unjoined request as a joined one.
 */
export function readRequestCorrelation():
  | { requestId?: string; sessionId?: string }
  | undefined {
  const context = getBackendRequestContext();
  if (!context) return undefined;
  const correlated =
    context.sessionIdSource !== undefined &&
    context.sessionIdSource !== "process" &&
    context.sessionIdSource !== "missing";
  const requestId =
    typeof context.requestId === "string" && context.requestId
      ? context.requestId
      : undefined;
  const sessionId =
    correlated && typeof context.sessionId === "string" && context.sessionId
      ? context.sessionId
      : undefined;
  if (!requestId && !sessionId) return undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
