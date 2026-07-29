import type { BugEvent } from "crumbtrail-core";
import { redactTokenLikeString } from "crumbtrail-core";

/**
 * Canonical event kind for a Node runtime warning observed while capture is
 * live.
 *
 * `process.on("warning")` is the platform announcing a defect the application
 * itself never logs: a `MaxListenersExceededWarning` names a subscribe without
 * cleanup that will grow until the process dies, a `DeprecationWarning` names an
 * API that is already scheduled to stop working. None of it reaches a console
 * the app owns, so without this hook the whole class is invisible to a session —
 * the runtime said the thing out loud and nobody wrote it down.
 *
 * Deliberately NOT `backend.uncaught` (that kind means the process is on its way
 * down and carries crash semantics) and NOT `con` (that kind is the browser
 * console plane). A warning is neither: the process keeps running and the
 * statement came from the runtime, not from application code.
 */
export const BACKEND_WARNING_EVENT = "backend.warning";

/** Warning message ceiling. Matches the contract the evidence index reads. */
const MAX_WARNING_MESSAGE = 300;
/** Warning name ceiling; a name longer than this is not a warning name. */
const MAX_WARNING_NAME = 120;
/** Stack lines kept. The first three name the warning and where it was raised. */
const MAX_WARNING_STACK_LINES = 3;
/** Per-line ceiling so one pathological frame cannot dominate the event. */
const MAX_WARNING_STACK_LINE = 300;

/** The subset of `Error` a Node runtime warning is guaranteed to carry. */
export interface RuntimeWarningLike {
  name?: string;
  message?: string;
  stack?: string;
}

export interface BackendWarningCaptureOptions {
  /** Sink for the `backend.warning` events. Its own throws are swallowed. */
  emit: (event: BugEvent) => void;
  /** Process to hook (tests). Defaults to the global `process`. */
  processImpl?: NodeJS.Process;
  /** Session id stamped on emitted events, when the caller has one. */
  sessionId?: string;
  /** Session start, used to stamp `offsetMs` like every other backend event. */
  sessionStartedAt?: number | Date;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface BackendWarningCaptureHandle {
  /**
   * Release this installation's claim on the shared listener. Idempotent; the
   * process listener is only removed once the last live installation stops.
   */
  stop(): void;
}

interface WarningHub {
  listener: (warning: Error) => void;
  sinks: Set<(warning: RuntimeWarningLike) => void>;
}

/**
 * One hub per process object, so N concurrent captures share ONE
 * `process.on("warning")` registration.
 *
 * Ref counting is the point. Node warns about listener accumulation on its own
 * emitters, and a capture layer that added a listener per Express app (or per
 * `autoCapture` call in a test file) would trip exactly the
 * MaxListenersExceededWarning it exists to report — a capture tool manufacturing
 * its own evidence. The hub is created on the first install, shared by every
 * later one, and torn down only when the last handle stops.
 */
const hubs = new WeakMap<NodeJS.Process, WarningHub>();

/**
 * Install runtime warning capture. Returns a handle whose `stop()` releases this
 * installation's claim on the shared `process.on("warning")` listener.
 *
 * Best effort in the same sense as the rest of the backend capture surface: a
 * throwing sink is contained, and nothing here can change how the host
 * application behaves. Node's own default warning printing is untouched, because
 * adding a `warning` listener does not suppress it the way an
 * `uncaughtException` listener suppresses the default crash.
 */
export function installBackendWarningCapture(
  options: BackendWarningCaptureOptions,
): BackendWarningCaptureHandle {
  const proc = options.processImpl ?? process;
  const sink = (warning: RuntimeWarningLike): void => {
    try {
      options.emit(
        buildBackendWarningEvent(warning, {
          sessionId: options.sessionId,
          sessionStartedAt: options.sessionStartedAt,
          now: options.now?.(),
        }),
      );
    } catch {
      // Capture must never throw back into the host application.
    }
  };

  let hub = hubs.get(proc);
  if (!hub) {
    const created: WarningHub = {
      sinks: new Set(),
      listener: (warning: Error) => {
        for (const registered of [...created.sinks]) registered(warning);
      },
    };
    hubs.set(proc, created);
    proc.on("warning", created.listener);
    hub = created;
  }
  hub.sinks.add(sink);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const live = hubs.get(proc);
      if (!live) return;
      live.sinks.delete(sink);
      if (live.sinks.size > 0) return;
      proc.removeListener("warning", live.listener);
      hubs.delete(proc);
    },
  };
}

/**
 * Builds the `backend.warning` event for one runtime warning.
 *
 * `stack` is `null` rather than absent when the warning carried none, so a
 * reader can tell "the runtime gave no location" apart from "this capture did
 * not record one".
 */
export function buildBackendWarningEvent(
  warning: RuntimeWarningLike,
  context: {
    sessionId?: string;
    sessionStartedAt?: number | Date;
    now?: number;
  } = {},
): BugEvent {
  const now = Number.isFinite(context.now)
    ? Math.round(context.now as number)
    : Date.now();

  const event: BugEvent = {
    t: now,
    k: BACKEND_WARNING_EVENT,
    d: {
      name: warningName(warning),
      message: warningMessage(warning),
      stack: warningStack(warning),
    },
  };
  if (context.sessionId) event.sessionId = context.sessionId;

  const startedAt = normalizeStartedAt(context.sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);
  return event;
}

function warningName(warning: RuntimeWarningLike): string {
  const raw = typeof warning?.name === "string" ? warning.name : "";
  const name = raw.replace(/\s+/g, " ").trim();
  return name ? name.slice(0, MAX_WARNING_NAME) : "Warning";
}

function warningMessage(warning: RuntimeWarningLike): string {
  const raw = warning?.message === undefined ? "" : String(warning.message);
  // Token redaction before the slice: a warning message is runtime text, but a
  // deprecation notice can quote a connection string the app passed in, and a
  // secret must not rest in an event just because the platform printed it.
  return redactTokenLikeString(raw, "backend.warning.message").value.slice(
    0,
    MAX_WARNING_MESSAGE,
  );
}

function warningStack(warning: RuntimeWarningLike): string | null {
  if (typeof warning?.stack !== "string") return null;
  const lines = warning.stack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_WARNING_STACK_LINES)
    .map(
      (line) =>
        redactTokenLikeString(line, "backend.warning.stack").value.slice(
          0,
          MAX_WARNING_STACK_LINE,
        ),
    );
  return lines.length > 0 ? lines.join("\n") : null;
}

function normalizeStartedAt(
  startedAt: number | Date | undefined,
): number | undefined {
  if (startedAt instanceof Date) {
    const time = startedAt.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return Number.isFinite(startedAt)
    ? Math.round(startedAt as number)
    : undefined;
}
