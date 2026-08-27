/**
 * The seam between a running `autoCapture` and an instrumentation call the host
 * makes itself.
 *
 * Zero-config instrumentation works by swapping a driver's exported factories,
 * which reaches only clients created afterwards, in a module graph the swap can
 * actually see. Two ordinary situations fall outside that: a client the host
 * already holds, and postgres.js loaded as an ES module, where the CommonJS
 * factory the patch replaces is a different copy from the one the app imported.
 *
 * Both need the host to say "instrument this one", and that call needs the same
 * event sink and request scope `autoCapture` gave the automatic path. Keeping
 * the sink here rather than on the capture handle means the host can instrument
 * a client before capture starts, which is the order a real service has: the
 * database module is imported, and initialisation runs later.
 */

import type { BugEvent } from "crumbtrail-core";

interface ActiveDbSink {
  emit: (event: BugEvent) => void;
  getRequestId: () => string | undefined;
}

let active: ActiveDbSink | undefined;

/** Installed by `autoCapture`; replaced wholesale if capture is re-established. */
export function setActiveDbSink(sink: ActiveDbSink): void {
  active = sink;
}

/** Cleared by `stop()`, after which a host-instrumented client emits nothing. */
export function clearActiveDbSink(sink?: ActiveDbSink): void {
  if (!sink || active === sink) active = undefined;
}

/**
 * Forward one event to the live capture, or drop it when none is running.
 *
 * Dropping is the correct behaviour and not a gap worth recording: with no
 * capture there is no session to hold the event for, and a host that
 * instruments a client without ever starting capture has asked for nothing.
 */
export function emitActiveDbEvent(event: BugEvent): void {
  active?.emit(event);
}

/** The request the current statement is running inside, when capture is live. */
export function readActiveDbRequestId(): string | undefined {
  return active?.getRequestId();
}
