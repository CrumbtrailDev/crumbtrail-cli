import type { BugEvent } from "crumbtrail-core";
import { startHeadlessSession, type HeadlessSession } from "./headless-session";

/**
 * Canonical event kind emitted for an auto-captured backend error (crash or
 * console.error). It is deliberately NOT `backend.req.error` (that kind is
 * request-scoped and joins on a requestId this hook never has) and NOT
 * `backend.error` (that literal is a causal-graph NODE kind, not an event kind —
 * reusing it would collide). This request-less kind carries only the error and
 * the hook that surfaced it.
 *
 * Downstream wiring (all requestId-free, so every site fits): causal-graph
 * `nodeKindFor` maps it onto the `backend.error` node kind, post-process
 * `FULL_STACK_BACKEND_KINDS` + `mergeBackendEvent` summarize its error, and
 * evidence-index surfaces it as a `backend_request_error` candidate + error
 * moment — mirroring `backend.req.error` at each site.
 */
export const AUTO_CAPTURE_ERROR_EVENT = "backend.uncaught";

/** Hooks a crash/console capture handler can surface an error from. */
export type AutoCaptureSource =
  | "uncaughtException"
  | "unhandledRejection"
  | "console.error";

export interface AutoCaptureOptions {
  /** Ingest endpoint (baked into the injected snippet by the CLI). */
  endpoint: string;
  /**
   * Ingest key. Defaults to `process.env.CRUMBTRAIL_KEY`, which is populated from
   * the project's `.env` by `autoCapture` itself (see `loadEnv`).
   */
  authToken?: string;
  /** Explicit session id; a stable auto-generated one is used when omitted. */
  sessionId?: string;
  /** Extra session metadata merged into the headless session start. */
  metadata?: Record<string, unknown>;
  /** Injectable fetch (tests); forwarded to `startHeadlessSession`. */
  fetchImpl?: typeof fetch;
  /**
   * When true (default) attempt `process.loadEnvFile()` so the key in `.env`
   * lands in `process.env` before the session starts. Guarded: a no-op when the
   * API is unavailable (<20.12) or the `.env` file is missing/unreadable.
   */
  loadEnv?: boolean;
  /** Console object to patch (tests). Defaults to the global `console`. */
  consoleImpl?: Pick<Console, "error">;
  /** Process to hook (tests). Defaults to the global `process`. */
  processImpl?: NodeJS.Process;
  /**
   * Called after a best-effort record on an unrecoverable crash
   * (`uncaughtException` / `unhandledRejection`) IN PLACE of `process.exit`.
   * Tests inject this to assert crash semantics are preserved without killing
   * the runner. Defaults to `process.exit`.
   */
  onCrashExit?: (code: number) => void;
}

export interface AutoCaptureHandle {
  /** The started session id, when the session start succeeded. */
  sessionId?: string;
  /** Restore the original console.error and remove the process hooks. */
  stop(): void;
}

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
// Hard ceiling for the crash flush: the exit waits at most this long for the
// crash event's fetch to land, then exits(1) no matter what.
const CRASH_FLUSH_MS = 150;

/** Resolve after `ms`, without keeping the event loop alive for the timer. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as {
      unref?: () => void;
    };
    timer.unref?.();
  });
}

// Double-install guard, scoped to this module instance: prepend-injected into an
// app entry, `autoCapture` must be idempotent if the same module instance is
// invoked twice (e.g. test re-imports, or an entry that calls it more than once).
// A second call on the same instance returns an inert handle. (A distinct module
// instance — a separate CJS/ESM copy — has its own guard and is not covered.)
let installed = false;

/**
 * Install best-effort backend crash + console.error capture and start a headless
 * ingest session. Returns a handle whose `stop()` restores every hook.
 *
 * Crash semantics are preserved: on `uncaughtException` (and a suppressed
 * `unhandledRejection`) we best-effort record the error, bound-flush it (race the
 * record against a hard ~150ms ceiling so the crash event can actually reach
 * ingest before the process dies), then exit non-zero — the bounded flush can
 * never hang, and capture never converts a crash into survival.
 */
export async function autoCapture(
  options: AutoCaptureOptions,
): Promise<AutoCaptureHandle> {
  if (installed) {
    return { stop() {} };
  }
  installed = true;

  const proc = options.processImpl ?? process;
  const consoleRef = options.consoleImpl ?? console;

  if (options.loadEnv !== false) {
    try {
      const loader = (proc as unknown as { loadEnvFile?: (p?: string) => void })
        .loadEnvFile;
      if (typeof loader === "function") loader.call(proc);
    } catch {
      // .env missing/unreadable, or loadEnvFile unavailable (<20.12): proceed
      // with whatever is already in the environment.
    }
  }

  const authToken = options.authToken ?? proc.env.CRUMBTRAIL_KEY;

  let session: HeadlessSession | undefined;
  try {
    session = await startHeadlessSession({
      endpoint: options.endpoint,
      sessionId: options.sessionId ?? generateSessionId(),
      authToken,
      metadata: { ...options.metadata, capture: "auto" },
      fetchImpl: options.fetchImpl,
    });
  } catch {
    // Could not reach the ingest endpoint. Still install the hooks so the host's
    // crash semantics stay intact; recording is simply a no-op.
    session = undefined;
  }

  let capturing = false;
  // Best-effort record. Returns the in-flight record promise (already
  // `.catch`-guarded so it never rejects) so a crash handler can bound-flush it;
  // returns undefined when there is nothing to await (no session / re-entrant).
  const record = (
    error: unknown,
    source: AutoCaptureSource,
  ): Promise<void> | undefined => {
    if (!session || capturing) return undefined;
    capturing = true;
    try {
      return session.record(buildErrorEvent(error, source)).catch(() => {});
    } catch {
      // Capture must never throw back into the host application.
      return undefined;
    } finally {
      capturing = false;
    }
  };

  // Keep the exact original reference so stop() can restore it identically.
  const originalError = consoleRef.error;
  const patchedError = (...args: unknown[]): void => {
    const errorArg = args.find((a) => a instanceof Error);
    record(errorArg ?? args.map((a) => String(a)).join(" "), "console.error");
    originalError.apply(consoleRef, args as []);
  };
  consoleRef.error = patchedError as typeof consoleRef.error;

  const exit = (code: number): void => {
    const exiter = options.onCrashExit ?? ((c: number) => proc.exit(c));
    exiter(code);
  };

  // Crash-path re-entrancy guard: a second crash raised WHILE we are flushing the
  // first must not recurse, restart the flush, or double-exit — the process is
  // already on its way down.
  let crashing = false;

  // Bounded crash flush: on an unrecoverable crash we give the error event's
  // in-flight fetch a chance to land, but never let it hang the exit. We race the
  // record promise against a hard ~150ms ceiling, then exit(1) regardless — a
  // stalled network, a throwing record, or a rejecting record can never keep the
  // process alive. Because an installed uncaughtException/unhandledRejection
  // listener suppresses Node's default terminate-on-crash, the process stays up
  // just long enough for this flush before we re-assert the non-zero exit.
  const flushThenExit = async (
    error: unknown,
    source: AutoCaptureSource,
  ): Promise<void> => {
    if (crashing) return;
    crashing = true;
    try {
      const recordPromise = record(error, source);
      if (recordPromise) {
        await Promise.race([recordPromise, sleep(CRASH_FLUSH_MS)]);
      }
    } catch {
      // A throwing/rejecting flush must never prevent the exit below.
    } finally {
      exit(1);
    }
  };

  const onUncaught = (error: unknown): void => {
    void flushThenExit(error, "uncaughtException");
  };
  proc.on("uncaughtException", onUncaught);

  const onUnhandled = (reason: unknown): void => {
    void flushThenExit(reason, "unhandledRejection");
  };
  proc.on("unhandledRejection", onUnhandled);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (consoleRef.error === patchedError) {
      consoleRef.error = originalError as typeof consoleRef.error;
    }
    proc.removeListener("uncaughtException", onUncaught);
    proc.removeListener("unhandledRejection", onUnhandled);
    installed = false;
  };

  return { sessionId: session?.sessionId, stop };
}

function generateSessionId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `auto_${Date.now().toString(36)}_${random}`;
}

function buildErrorEvent(error: unknown, source: AutoCaptureSource): BugEvent {
  const normalized = normalizeError(error);
  return {
    t: Date.now(),
    k: AUTO_CAPTURE_ERROR_EVENT,
    d: {
      source,
      error: normalized,
    },
  };
}

function normalizeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: bounded(error.message, MAX_MESSAGE),
      ...(error.stack ? { stack: bounded(error.stack, MAX_STACK) } : {}),
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: bounded(error, MAX_MESSAGE) };
  }
  return {
    name: typeof error,
    message: bounded(safeString(error), MAX_MESSAGE),
  };
}

function safeString(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return "Non-serializable value";
  }
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
