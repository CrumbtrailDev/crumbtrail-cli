import { buildCaptureGapEvent, type BugEvent } from "crumbtrail-core";
import {
  HeadlessRequestError,
  startHeadlessSession,
  type HeadlessSession,
} from "./headless-session";
import { clearActiveDbSink, setActiveDbSink } from "./db/active-sink";
import {
  autoInstrumentDbClients,
  autoInstrumentPatchedAnything,
  formatAutoInstrumentReport,
  type AutoInstrumentDriver,
  type AutoInstrumentReport,
} from "./db/auto-instrument";
import {
  installBackendWarningCapture,
  type BackendWarningCaptureHandle,
} from "./backend-warnings";
import {
  installBackendLogCapture,
  type BackendLogCaptureHandle,
  type BackendLogCaptureOptions,
  type BackendLogLevel,
} from "./backend-logs";
import {
  installHttpRequestCapture,
  installOutboundHttpCapture,
  type HttpRequestCaptureHandle,
  type HttpRequestCaptureOptions,
  type OutboundHttpCaptureHandle,
  type OutboundHttpCaptureOptions,
} from "./http-server";
import { sendBackendEvent } from "./backend-intake";
import {
  clearProcessSessionId,
  setProcessSessionId,
} from "./process-session";
import { readRequestCorrelation } from "./request-context";

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

/**
 * Stage of the ingest pipeline that failed. `session-start` is the initial
 * `/api/session/start` handshake (a TLS/DNS/non-2xx failure here means the whole
 * capture is dark); `record` is a later `/api/events` POST for a captured error.
 */
export type AutoCaptureErrorPhase = "session-start" | "record";

/** Context handed to `onError` describing which send failed and why. */
export interface AutoCaptureErrorContext {
  phase: AutoCaptureErrorPhase;
  /** The capture source, when the failure was recording a specific error. */
  source?: AutoCaptureSource;
}

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
  /**
   * Which app in the project this process is. One ingest key covers a whole
   * project, so the key cannot say — this can. The name is created on first
   * sight and reused after, and a key minted for a single app ignores it.
   */
  service?: string;
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
  /**
   * Notified whenever an ingest send fails — the session handshake could not be
   * reached (TLS/DNS) or a captured error's POST was rejected. Wire it to the
   * host's logger to make ingest problems observable in that logger. A server
   * explained refusal (a revoked key, a cap wall) additionally reaches the
   * process console by default, once per condition, like the browser SDK; a
   * transport rejection is only console logged under `CRUMBTRAIL_DEBUG`. It is
   * called best-effort and its own throws are swallowed, so it can never break
   * the host or the capture path. Avoid calling the patched `console.error`
   * from here during the `record` phase — prefer a real logger.
   */
  onError?: (error: unknown, context: AutoCaptureErrorContext) => void;
  /**
   * When true (or when `CRUMBTRAIL_DEBUG` is set) and no `onError` is provided,
   * ingest failures are logged to the original (unpatched) `console.error`.
   * Defaults to false so a healthy install stays quiet.
   */
  debug?: boolean;
  /**
   * Injectable monotonic-ish clock (tests). Defaults to `Date.now`. Drives the
   * lazy re-establishment backoff gate so tests can advance time deterministically
   * without real timers.
   */
  nowImpl?: () => number;
  /**
   * When true (default) wrap whichever SQL driver the app already depends on so
   * `db.diff` evidence is captured with no `instrument*` call in host code. This
   * is what makes the DB detectors — `db_delta_mismatch`, `db_field_divergence`,
   * `duplicate_write` — reachable in a stock install rather than only for apps
   * that wired them by hand.
   *
   * Set false to keep drivers untouched, e.g. when the app already calls
   * `instrumentPgClient` itself and would otherwise double-instrument.
   */
  instrumentDatabases?: boolean;
  /** Restrict auto-instrumentation to specific drivers. Absent ⇒ all known ones. */
  databaseDrivers?: readonly AutoInstrumentDriver[];
  /** Module resolver seam for auto-instrumentation (tests). */
  databaseResolve?: (specifier: string) => unknown;
  /**
   * When true (default) record Node runtime warnings (`process.on("warning")`)
   * as `backend.warning` events. This is the only path by which a
   * MaxListenersExceededWarning or a DeprecationWarning — the platform naming a
   * defect the application never logs — reaches a session.
   *
   * Set false to leave the process untouched.
   */
  captureRuntimeWarnings?: boolean;
  /**
   * When true (default) record structured log lines the process writes —
   * pino, winston, bunyan and anything else emitting NDJSON with a level — as
   * `backend.log` events.
   *
   * This is the only path by which an ORDINARY backend failure reaches a
   * session. A handled 503 is caught, logged with its stack, and answered; it
   * never touches `console.error` and never crashes the process, so without
   * this hook a server that logs through a logger captures nothing at all.
   *
   * Set false to leave `process.stdout`/`process.stderr` and `fs.write`
   * untouched.
   */
  captureLogs?: boolean;
  /** Lowest log level captured. Defaults to `warn`. */
  logLevel?: BackendLogLevel;
  /** Streams and `fs` the log capture patches (tests). Defaults to the process's. */
  logStreams?: Pick<
    BackendLogCaptureOptions,
    "stdout" | "stderr" | "fsImpl" | "maxEvents"
  >;
  /**
   * When true (default) record inbound HTTP requests that arrive carrying the
   * browser's correlation headers as `backend.req.start` / `backend.req.end`
   * events in THAT browser's session.
   *
   * This is the only path by which frontend to backend correlation works at all
   * on a stock install. It hooks `http.Server` rather than any one framework, so
   * express, hono, fastify, nest and a hand-written `createServer` are all
   * covered by the same code with no application change. A request that carries
   * no session correlation is not recorded: there is nothing to join it to, and
   * a server's health checks must not become egress.
   *
   * Set false to leave `node:http` untouched.
   */
  captureHttpRequests?: boolean;
  /**
   * Response body and header capture policy for the inbound requests above,
   * identical in shape and default to the Express middleware's.
   */
  httpResponseCapture?: HttpRequestCaptureOptions["response"];
  /** `node:http`/`node:https` the request capture patches (tests). */
  httpModules?: Pick<
    HttpRequestCaptureOptions,
    "httpImpl" | "httpsImpl" | "maxRequests"
  >;
  /**
   * When true (default) record the calls this process makes OUTWARD — every
   * `fetch`, `http.request` and `https.request` — as `backend.http` events.
   *
   * This is the only path by which an infrastructure failure names itself. A
   * DNS failure, an upstream timeout, a dead cache or a dependency 502 is what
   * turned the inbound request into a 500, and without this the session holds
   * the 500 and nothing that explains it.
   *
   * Set false to leave the outbound transports untouched.
   */
  captureOutboundHttp?: boolean;
  /** Modules and clock the outbound capture patches (tests). */
  outboundHttpModules?: Pick<
    OutboundHttpCaptureOptions,
    "httpImpl" | "httpsImpl" | "fetchHost" | "maxCalls"
  >;
  /**
   * Ceiling on one ingest POST, in milliseconds. Defaults to the headless
   * session's own default; pass 0 to disable. An endpoint that accepts the
   * connection and never answers is otherwise indistinguishable from a healthy
   * one, and every event handed to it waits forever.
   */
  requestTimeoutMs?: number;
  /**
   * How many events are held locally while the ingest session is dark, before
   * further ones are counted as a gap instead. Defaults to
   * {@link DEFAULT_MAX_PENDING_EVENTS}. Bounded on purpose: capture may never be
   * the reason a host process runs out of memory.
   */
  maxPendingEvents?: number;
  /**
   * When true (default) record that the process was terminated by a signal
   * (`SIGTERM`, `SIGINT`, `SIGHUP`, `SIGQUIT`) as a `session.lifecycle` event,
   * then restore the default termination behaviour.
   *
   * A container that is killed mid request otherwise says nothing at all: the
   * session simply stops, and it is later finalized as though it had ended
   * normally. Recording the signal is what separates "the process was killed"
   * from "nothing else happened".
   *
   * The listener never keeps the process alive: once the record has been
   * bound-flushed, the handler removes itself and re-raises the signal so Node's
   * default terminate-on-signal applies. When the host has its own handler for
   * the signal, the host owns the shutdown and this only records.
   *
   * Set false to leave the signal handlers untouched.
   */
  captureProcessSignals?: boolean;
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
// Lazy re-establishment backoff. When the ingest session is not live, the next
// captured error tries to (re-)start it — but only after this backoff has elapsed
// since the last failed attempt, so a persistently-down endpoint is not hammered.
// Exponential from ~1s, capped at ~30s: 1s, 2s, 4s, 8s, 16s, 30s, 30s, …
const REESTABLISH_BASE_MS = 1000;
const REESTABLISH_CAP_MS = 30_000;
// Upper bound on a server-requested `Retry-After` floor. A trusted server asking
// us to wait a few minutes is honored, but an absurd (or hostile/buggy) value
// like `Retry-After: 999999999` (~31 years) must not silently park capture until
// the process restarts — clamp it so self-heal always resumes within a bounded
// window.
const RETRY_AFTER_MAX_MS = 5 * 60_000;

/**
 * Events held locally while the ingest session is dark.
 *
 * Five hundred events is a few hundred kilobytes at the sizes this SDK emits,
 * which is a price a host process can pay for a capture outage; unbounded is
 * not. Everything past the cap is counted rather than kept, and the count is
 * what the capture gap reports.
 */
export const DEFAULT_MAX_PENDING_EVENTS = 500;

/** Events per POST when the held queue drains. Matches the intake's batch size. */
const FLUSH_BATCH_SIZE = 64;

/**
 * Delivery attempts one held event gets before it is counted as lost.
 *
 * Without a ceiling, a permanently refused event (a revoked key, a payload the
 * endpoint will never accept) would be requeued and retried for the life of the
 * process, and would keep every event behind it from ever being sent.
 */
const MAX_PENDING_ATTEMPTS = 3;

/**
 * Grace given to the termination record before the signal is re-raised. A
 * SIGTERM normally carries a grace period measured in seconds, so 400ms is
 * comfortably inside it while still being a hard ceiling: a wedged endpoint can
 * never turn a fast shutdown into a slow one.
 */
const TERMINATION_FLUSH_MS = 400;

/** Signals that mean "this process is being stopped", not "this process failed". */
const TERMINATION_SIGNALS = [
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
] as const;

/** Event kind carrying the process's own statement about how it ended. */
export const AUTO_CAPTURE_LIFECYCLE_EVENT = "session.lifecycle";

/** The completeness surface a dropped event belongs to, from its kind. */
type CaptureGapSurface = "db_diff" | "backend_request" | "browser" | "queue";

function gapSurfaceFor(kind: string): CaptureGapSurface {
  if (kind.startsWith("db.")) return "db_diff";
  if (kind.startsWith("backend.req")) return "backend_request";
  // Everything else — a crash, a runtime warning, a log line, an outbound call —
  // was lost in this SDK's own delivery queue, and that is what the reader needs
  // to know about it.
  return "queue";
}

/** One event waiting for a live session, with the attempts already spent on it. */
interface PendingEvent {
  event: BugEvent;
  attempts: number;
}

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
 * The service the live capture was installed for.
 *
 * Two apps in one process — a worker imported into the API, an entry that calls
 * `autoCapture` again under a second name — used to be indistinguishable from a
 * duplicate call: the second name was dropped without a word, and every event the
 * second app produced was filed under the first app's name for the life of the
 * process. That is a wrong answer presented as a working install, so the conflict
 * is now stated once and the first capture stands. The second caller still gets an
 * inert handle, so its `stop()` cannot tear down a capture it does not own.
 */
let installedService: string | undefined;

/** Test seam: forget the process-wide install so a suite can install again. */
export function __resetAutoCaptureInstallForTests(): void {
  installed = false;
  installedService = undefined;
}

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
    // Same name (or no name either time) is an ordinary double call — idempotent,
    // and silent as it has always been. A DIFFERENT name is two apps, and saying
    // nothing would file one app's events under the other app's name.
    if (options.service !== installedService) {
      const consoleForWarning = options.consoleImpl ?? console;
      consoleForWarning.error(
        `[crumbtrail] capture is already running for ${describeService(installedService)}, ` +
          `so the later call for ${describeService(options.service)} was ignored: ` +
          "one process captures under one service name. Run the second app in its own " +
          "process, or give both calls the same service name.",
      );
    }
    // Still an inert handle, never the live one: a second caller's `stop()` must not
    // tear down a capture it does not own. The existing double-install contract.
    return { stop() {} };
  }
  installed = true;
  installedService = options.service;

  const proc = options.processImpl ?? process;
  const consoleRef = options.consoleImpl ?? console;

  // The real console.error, captured before we patch it. The `debug` fallback
  // logs through this so a `record`-phase failure can never re-enter the patched
  // console.error and loop.
  const originalConsoleError = consoleRef.error;
  const debug = options.debug ?? isTruthyFlag(proc.env.CRUMBTRAIL_DEBUG);

  // One default console line per refused phase+status, process lifetime. A
  // revoked key refuses the session start on every re-establish attempt; the
  // sentence that explains it is worth printing once, not on each backoff.
  const surfacedRefusals = new Set<string>();

  // Surface an ingest failure that would otherwise be swallowed. Best-effort:
  // its own throws are contained so diagnostics can never break the host.
  // A server explained refusal (the 401 of a revoked key, a cap wall) reaches
  // the operator by default, matching the browser SDK's console line; a
  // transport rejection stays behind the `debug` flag because it is usually
  // transient and the session self-heals on its backoff.
  const emitError = (
    error: unknown,
    context: AutoCaptureErrorContext,
  ): void => {
    try {
      if (options.onError) {
        options.onError(error, context);
      } else if (
        error instanceof HeadlessRequestError &&
        typeof error.status === "number"
      ) {
        const key = `${context.phase}:${error.status}`;
        if (surfacedRefusals.has(key)) return;
        surfacedRefusals.add(key);
        originalConsoleError.call(
          consoleRef,
          `[crumbtrail] ${refusalSentence(error, context.phase)}`,
        );
      } else if (debug) {
        originalConsoleError.call(
          consoleRef,
          `[crumbtrail] ingest ${context.phase} failed`,
          error,
        );
      }
    } catch {
      // Diagnostics must never throw back into the host application.
    }
  };

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
  const now = options.nowImpl ?? Date.now;
  // Stable id reused across every (re-)establishment attempt so events correlate
  // to one logical session even if the first handshake failed and a later one
  // succeeds.
  const stableSessionId = options.sessionId ?? generateSessionId();

  // Re-establishment state. `session` is the live handle when the handshake has
  // succeeded and is still believed good. `nextAttemptAt` is the backoff gate:
  // a re-establish is only attempted once the clock reaches it. `establishing`
  // dedups concurrent attempts so a burst of captures triggers at most one
  // in-flight handshake.
  let session: HeadlessSession | undefined;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0; // 0 => attempt immediately (boot / after success)
  let establishing: Promise<HeadlessSession | undefined> | undefined;
  let stopped = false;

  // ==========================================================================
  // COMPLETENESS LEDGER
  // ==========================================================================
  //
  // Every lane below — a crash, a runtime warning, a structured log line, a
  // database diff, an outbound call — used to be DROPPED when the ingest
  // session was dark, and dropped without a word. A capture endpoint that fails
  // DNS, TLS or availability therefore produced a session that looked complete:
  // the events that happened to be sent before the outage survived, the ones
  // during it vanished, and nothing anywhere said which was which. A brief built
  // on that grades the survivors as the whole story.
  //
  // Two things fix it, and both are needed. Evidence produced while the endpoint
  // is unreachable is HELD, bounded, and delivered when the session comes back.
  // Evidence that could not be held or could not be delivered is COUNTED, and
  // the count is delivered as a `capture_gap` event — so a session that is
  // missing evidence says so, in the evidence stream, where the reader is.
  const maxPending = normalizePendingCap(options.maxPendingEvents);
  const pendingEvents: PendingEvent[] = [];
  const droppedBySurface = new Map<CaptureGapSurface, number>();
  let draining = false;

  /** Record that `count` events of this kind were lost and will not arrive. */
  const noteDropped = (kind: string, count = 1): void => {
    if (count <= 0) return;
    const surface = gapSurfaceFor(kind);
    droppedBySurface.set(surface, (droppedBySurface.get(surface) ?? 0) + count);
  };

  /** Hold an event for a session that is not live yet, or count it as lost. */
  const holdEvent = (event: BugEvent, attempts = 0): void => {
    if (stopped) return;
    if (pendingEvents.length >= maxPending) {
      noteDropped(event.k);
      return;
    }
    pendingEvents.push({ event, attempts });
  };

  /**
   * Drop the live session and arm the re-establish backoff.
   *
   * Called on a handshake failure AND on a delivery failure, because a session
   * handle that cannot deliver is not a live session. Leaving it in place is
   * what let a whole outage pass with the SDK still believing it was connected.
   */
  const armBackoff = (err: unknown): void => {
    session = undefined;
    consecutiveFailures += 1;
    const backoff = Math.min(
      REESTABLISH_BASE_MS * 2 ** (consecutiveFailures - 1),
      REESTABLISH_CAP_MS,
    );
    const floor = Math.min(retryAfterMsOf(err) ?? 0, RETRY_AFTER_MAX_MS);
    nextAttemptAt = now() + Math.max(backoff, floor);
  };

  /**
   * Deliver the recorded gaps, newest counts included, and clear them only once
   * the endpoint has accepted them. A gap that fails to send is still a gap.
   */
  const flushGaps = async (live: HeadlessSession): Promise<void> => {
    if (droppedBySurface.size === 0) return;
    const snapshot = [...droppedBySurface.entries()];
    const events = snapshot.map(([surface, count]) =>
      buildCaptureGapEvent({
        surface,
        reason: "delivery_failed",
        droppedEventCount: count,
        sessionId: stableSessionId,
        t: now(),
      }),
    );
    try {
      await live.record(events);
    } catch (err) {
      emitError(err, { phase: "record", source: "console.error" });
      armBackoff(err);
      return;
    }
    // Subtract what was reported rather than clearing, so a drop that happened
    // while this POST was in flight is not reported as already accounted for.
    for (const [surface, count] of snapshot) {
      const remaining = (droppedBySurface.get(surface) ?? 0) - count;
      if (remaining > 0) droppedBySurface.set(surface, remaining);
      else droppedBySurface.delete(surface);
    }
  };

  /**
   * Send everything held for this session, then the gap ledger. Re-entrant safe
   * and never throws: a failure mid drain requeues the batch, arms the backoff
   * and leaves the rest held for the next successful handshake.
   */
  const drainPending = async (live: HeadlessSession): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && session === live && pendingEvents.length > 0) {
        const batch = pendingEvents.splice(0, FLUSH_BATCH_SIZE);
        try {
          await live.record(batch.map((entry) => entry.event));
        } catch (err) {
          emitError(err, { phase: "record", source: "console.error" });
          armBackoff(err);
          for (const entry of batch) {
            const attempts = entry.attempts + 1;
            if (attempts >= MAX_PENDING_ATTEMPTS) noteDropped(entry.event.k);
            else holdEvent(entry.event, attempts);
          }
          return;
        }
      }
      if (!stopped && session === live) await flushGaps(live);
    } finally {
      draining = false;
    }
  };

  const startSession = (): Promise<HeadlessSession> =>
    startHeadlessSession({
      endpoint: options.endpoint,
      sessionId: stableSessionId,
      authToken,
      metadata: {
        ...(options.service ? { service: options.service } : {}),
        ...options.metadata,
        capture: "auto",
        // The cold start marker. A session that carries a pid and a boot time
        // is a process that started; a later session under the same service with
        // a different pid is a restart, and that is a fact a reader cannot infer
        // from the events alone.
        process: describeProcess(proc),
      },
      fetchImpl: options.fetchImpl,
      ...(options.requestTimeoutMs !== undefined
        ? { timeoutMs: options.requestTimeoutMs }
        : {}),
    });

  // Lazily (re-)establish the ingest session, bounded by the backoff gate.
  // Returns the live session, or undefined when the gate is closed, an attempt is
  // already in flight (awaited and shared), the handshake failed, or we've been
  // stopped. A failure surfaces through `emitError({ phase: "session-start" })`
  // and arms the backoff (respecting a server `Retry-After` as a floor) so the
  // endpoint is not hammered — the NEXT capture after recovery lands.
  const ensureSession = async (): Promise<HeadlessSession | undefined> => {
    if (session) return session;
    if (stopped) return undefined;
    if (establishing) return establishing;
    if (now() < nextAttemptAt) return undefined;

    establishing = (async (): Promise<HeadlessSession | undefined> => {
      try {
        const started = await startSession();
        if (stopped) return undefined;
        session = started;
        // Announced only once the endpoint has acknowledged the session, so a
        // request recorder falling back to it addresses a session that exists.
        // This is what lets a backend with no browser in front of it record its
        // requests instead of having every one of them refused for having no
        // session id.
        setProcessSessionId(stableSessionId);
        consecutiveFailures = 0;
        nextAttemptAt = 0;
        // Everything the outage held now has somewhere to go, and so does the
        // count of everything it could not hold. Deliberately not awaited: a
        // caller recording one error must not wait on a backlog drain.
        void drainPending(started);
        return session;
      } catch (err) {
        armBackoff(err);
        emitError(err, { phase: "session-start" });
        return undefined;
      } finally {
        establishing = undefined;
      }
    })();
    return establishing;
  };

  /**
   * The one way a non request lane (a runtime warning, a log line, a database
   * diff) reaches the session.
   *
   * Every one of these used to read `if (!session) return`, which is where the
   * silence came from: a database timeout raised during a Crumbtrail outage was
   * discarded, and the session it belonged to was later graded complete. Now the
   * event is held for the next live session, the dark session is nudged to
   * re-establish behind its backoff gate, and anything that still cannot be kept
   * is counted into the gap ledger.
   */
  const emitSessionEvent = (event: BugEvent): void => {
    if (stopped) return;
    const live = session;
    if (!live) {
      holdEvent(event);
      // Self-heal for a backend that never calls console.error: these lanes are
      // often the only ones producing evidence, so they must be able to trigger
      // the re-establishment the console path triggers.
      void ensureSession();
      return;
    }
    void live.record(event).catch((sendErr) => {
      holdEvent(event);
      armBackoff(sendErr);
      emitError(sendErr, { phase: "record", source: "console.error" });
    });
  };

  // Zero-config DB capture. Installed BEFORE the initial handshake, and so
  // before this function first yields, because the patch works by replacing the
  // driver's exported factories: a pool the host builds at module load — the
  // ordinary shape of a Node service — already exists by the time an await here
  // resumes, and a factory swapped after that wraps nothing. Best-effort in the
  // same sense as the rest of this module: a driver with an unexpected shape is
  // reported, never fatal. Events ride the same headless session as everything
  // else, and one emitted before the session is live is held for it, not dropped.
  // Published before the factory patch, and independently of it: a host that
  // instruments a client itself — because it already built one, or because its
  // driver lives in an ESM graph the patch cannot reach — routes through this
  // same sink and request scope.
  const dbSink = {
    emit: emitSessionEvent,
    getRequestId: () => readRequestCorrelation()?.requestId,
  };
  setActiveDbSink(dbSink);

  let dbInstrumentation: AutoInstrumentReport | undefined;
  if (options.instrumentDatabases !== false) {
    try {
      dbInstrumentation = autoInstrumentDbClients({
        emit: emitSessionEvent,
        // The bridge to the request the statement ran inside. Without it every
        // wrapped driver reads an undefined request id and hands the statement
        // straight back to the host, so a correctly patched pool still produced
        // no evidence — the instrumentation was installed and inert. Resolved
        // per statement, because the scope is AsyncLocalStorage state that only
        // exists once a request is in flight.
        getRequestId: dbSink.getRequestId,
        drivers: options.databaseDrivers,
        resolve: options.databaseResolve,
      });
      const line = formatAutoInstrumentReport(dbInstrumentation);
      // The success line stays behind `debug`: a healthy install is quiet. The
      // "nothing was instrumented" line does NOT, because that is the sentence
      // that explains a session with no database evidence in it, and leaving it
      // behind a flag is what made that outcome look like a working install.
      if (line && (debug || !autoInstrumentPatchedAnything(dbInstrumentation))) {
        originalConsoleError.call(consoleRef, line);
      }
    } catch (error) {
      emitError(error, { phase: "record", source: "console.error" });
    }
  }

  // Boot: attempt the initial handshake. On failure the hooks still install so
  // the host's crash semantics stay intact and a later capture can self-heal.
  await ensureSession();

  let capturing = false;
  const recordLive = (
    live: HeadlessSession,
    error: unknown,
    source: AutoCaptureSource,
    logMessage?: string,
  ): Promise<void> => {
    const event = buildErrorEvent(error, source, logMessage);
    // An error logged inside a browser correlated request belongs to that
    // browser's session, exactly like the request's own events — otherwise the
    // click and the sentence explaining it land in two sessions that share
    // nothing. Only the logged path is re-routed: a crash is the process's own
    // ending, and its bounded exit flush goes through the live session.
    const correlated =
      source === "console.error" ? readRequestCorrelation()?.sessionId : undefined;
    if (correlated && correlated !== live.sessionId) {
      return sendBackendEvent({
        event: { ...event, sessionId: correlated },
        sessionId: correlated,
        endpoint: options.endpoint,
        ...(authToken ? { authToken } : {}),
        ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
      })
        .then((delivered) => {
          // `sendBackendEvent` reports its own failures and resolves false
          // rather than rejecting, so without this a refused correlated error
          // was the one send in this module that could vanish with no trace at
          // all — not even a gap.
          if (!delivered) noteDropped(event.k);
        })
        .catch((sendErr) => {
          noteDropped(event.k);
          emitError(sendErr, { phase: "record", source });
        });
    }
    return live.record(event).catch((sendErr) => {
      // The event never landed. Hold it for the next live session and treat the
      // handle as dead, so the next capture re-establishes instead of handing
      // more evidence to an endpoint that is not answering.
      holdEvent(event);
      armBackoff(sendErr);
      emitError(sendErr, { phase: "record", source });
    });
  };

  // Best-effort record. Returns the in-flight record promise (already
  // `.catch`-guarded so it never rejects) so a crash handler can bound-flush it;
  // returns undefined when there is nothing to await (no session and no
  // re-establish, or a re-entrant call).
  //
  // `allowReestablish` (default false) opts into lazy re-establishment: when the
  // session is dark it first tries to (re-)start it behind the backoff gate, then
  // records. The crash path passes false — re-establishing there risks the
  // bounded exit ceiling, so a crash only records through an already-live session.
  const record = (
    error: unknown,
    source: AutoCaptureSource,
    allowReestablish = false,
    logMessage?: string,
  ): Promise<void> | undefined => {
    if (capturing) {
      // Re-entrant: this capture was raised by the capture path itself and must
      // not recurse. The evidence is still gone, so it is counted rather than
      // discarded in silence.
      noteDropped(AUTO_CAPTURE_ERROR_EVENT);
      return undefined;
    }
    try {
      if (session) {
        capturing = true;
        try {
          return recordLive(session, error, source, logMessage);
        } finally {
          capturing = false;
        }
      }
      if (stopped) return undefined;
      if (!allowReestablish) {
        // The crash path. It may not wait on a handshake, but the crash is the
        // most valuable event in the session and losing it silently is the worst
        // case of all: hold it so a later re-establish still delivers it, and
        // count it if the process never gets one.
        holdEvent(buildErrorEvent(error, source, logMessage));
        return undefined;
      }
      // Dark session: re-establish (backoff-gated) then record.
      //
      // `capturing` is held only around the record itself, not across the whole
      // async attempt. Holding it for the duration made every error raised while
      // a handshake was in flight hit the re-entrancy guard and vanish — during
      // an outage, which is exactly when errors arrive in bursts. Concurrent
      // handshakes are already deduped by `ensureSession`'s own `establishing`.
      return (async () => {
        const live = await ensureSession();
        if (!live) {
          // The backoff gate is still closed, or the handshake failed again.
          // The evidence is real either way, so it is held rather than dropped.
          holdEvent(buildErrorEvent(error, source, logMessage));
          return;
        }
        if (capturing) {
          holdEvent(buildErrorEvent(error, source, logMessage));
          return;
        }
        capturing = true;
        try {
          await recordLive(live, error, source, logMessage);
        } finally {
          capturing = false;
        }
      })();
    } catch {
      // Capture must never throw back into the host application.
      capturing = false;
      return undefined;
    }
  };

  // Keep the exact original reference so stop() can restore it identically.
  const originalError = originalConsoleError;
  const patchedError = (...args: unknown[]): void => {
    const errorArg = args.find((a) => a instanceof Error);
    // The sentence the developer wrote, kept alongside the Error rather than
    // instead of it. `console.error("worker tick failed", err)` used to arrive
    // as nothing but the Error's own message, so the words the author chose —
    // the ones they would search for, and the only part naming what was being
    // attempted — were dropped on exactly the call shape that carries a stack.
    const logMessage = errorArg
      ? args
          .filter((a) => !(a instanceof Error))
          .map((a) => safeString(a))
          .join(" ")
          .trim()
      : "";
    // The non-crash capture path opts into lazy re-establishment: if the session
    // went dark at boot (or later), this is what heals it — the next logged error
    // after the endpoint recovers re-starts the session and lands.
    record(
      errorArg ?? args.map((a) => String(a)).join(" "),
      "console.error",
      true,
      logMessage || undefined,
    );
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

  // ==========================================================================
  // TERMINATION
  // ==========================================================================
  //
  // A crash says something. A process that is STOPPED said nothing at all: only
  // `uncaughtException` and `unhandledRejection` were hooked, so a container
  // killed mid request — a deploy, a scale-in, an OOM-killed sibling, a failing
  // liveness probe — simply stopped emitting, and the sweeper later finalized
  // the session as though it had ended on its own terms. The evidence that DID
  // land then reads as the complete story of a request that never finished.
  //
  // The signal is recorded as a `session.lifecycle` event, which the bundle
  // renders on the timeline, and it carries the held and lost counts so the
  // reader learns in one place both that the process was killed and how much
  // evidence went with it.
  //
  // What this cannot see, and does not pretend to: `SIGKILL` and a kernel OOM
  // kill deliver no signal to the process at all. Nothing in-process can record
  // those. They surface instead as a session that stops without a termination
  // record, which is exactly what the sweeper reports.
  let terminating = false;
  const signalHandlers = new Map<string, () => void>();

  /** The gap ledger as events, without clearing it — the process is ending. */
  const gapEventsSnapshot = (): BugEvent[] =>
    [...droppedBySurface.entries()].map(([surface, count]) =>
      buildCaptureGapEvent({
        surface,
        reason: "delivery_failed",
        droppedEventCount: count,
        sessionId: stableSessionId,
        t: now(),
      }),
    );

  const recordTermination = async (signal: string): Promise<void> => {
    const live = session ?? (await ensureSession());
    if (!live) return;
    // Anything past one batch cannot be sent inside the grace period, and
    // saying so is worth more than pretending it landed.
    const batch = pendingEvents.splice(0, FLUSH_BATCH_SIZE);
    for (const rest of pendingEvents.splice(0)) noteDropped(rest.event.k);
    const lifecycle: BugEvent = {
      t: now(),
      k: AUTO_CAPTURE_LIFECYCLE_EVENT,
      sessionId: stableSessionId,
      d: {
        action: "process-terminated",
        reason: signal,
        ...(options.service ? { service: options.service } : {}),
        ...describeProcess(proc),
        heldEvents: batch.length,
        lostEvents: [...droppedBySurface.values()].reduce((a, b) => a + b, 0),
      },
    };
    await live.record([
      ...batch.map((entry) => entry.event),
      lifecycle,
      ...gapEventsSnapshot(),
    ]);
  };

  /**
   * Put the signal back the way it was and let it do what it was going to do.
   *
   * Installing a signal listener SUPPRESSES Node's default terminate-on-signal,
   * so capture would otherwise keep alive a process the operator asked to stop —
   * the one change to host behaviour that would be indefensible. Once the record
   * has been bound-flushed the listener removes itself; if nothing else is
   * listening the signal is re-raised, which both terminates the process and
   * preserves its real exit code (143 for SIGTERM). When the host has its own
   * handler, the host owns the shutdown and this only recorded it.
   */
  const releaseSignal = (signal: string): void => {
    const handler = signalHandlers.get(signal);
    if (handler) {
      signalHandlers.delete(signal);
      try {
        proc.removeListener(signal as NodeJS.Signals, handler);
      } catch {
        // A process seam without removeListener still gets the record.
      }
    }
    try {
      if (proc.listenerCount?.(signal as NodeJS.Signals) > 0) return;
      const kill = (proc as { kill?: (pid: number, sig: string) => void }).kill;
      if (typeof kill === "function") kill.call(proc, proc.pid, signal);
    } catch {
      // Re-raising is best effort; never throw out of a shutdown path.
    }
  };

  if (options.captureProcessSignals !== false) {
    for (const signal of TERMINATION_SIGNALS) {
      const handler = (): void => {
        if (terminating) return;
        terminating = true;
        void (async () => {
          try {
            await Promise.race([
              recordTermination(signal).catch((err) =>
                emitError(err, { phase: "record" }),
              ),
              sleep(TERMINATION_FLUSH_MS),
            ]);
          } catch {
            // A failed record must never prevent the process from stopping.
          } finally {
            releaseSignal(signal);
          }
        })();
      };
      try {
        proc.on(signal, handler);
        signalHandlers.set(signal, handler);
      } catch {
        // A platform (or a test seam) that refuses this signal is left alone.
      }
    }
  }

  // Runtime warnings. Ref-counted inside `installBackendWarningCapture`, so two
  // captures in one process (or two test files) share a single process listener
  // rather than each adding one — the thing MaxListenersExceededWarning exists
  // to complain about. Emitted through the same session as everything else, and
  // dropped rather than queued while the session is dark, matching db events.
  let warningCapture: BackendWarningCaptureHandle | undefined;
  if (options.captureRuntimeWarnings !== false) {
    try {
      warningCapture = installBackendWarningCapture({
        processImpl: proc,
        sessionId: stableSessionId,
        emit: emitSessionEvent,
      });
    } catch (error) {
      emitError(error, { phase: "record", source: "console.error" });
    }
  }

  // Structured log capture. The lane that carries an ordinary handled failure:
  // the app logged the 503 and its stack through pino, kept serving, and no
  // other hook here would ever have seen it. Emitted through the same session as
  // everything else, and dropped rather than queued while the session is dark,
  // matching db events and runtime warnings.
  let logCapture: BackendLogCaptureHandle | undefined;
  if (options.captureLogs !== false) {
    try {
      logCapture = installBackendLogCapture({
        sessionId: stableSessionId,
        minLevel: options.logLevel,
        ...options.logStreams,
        emit: (event) => {
          if (stopped) return;
          // A line written inside a browser correlated request belongs to the
          // BROWSER's session, exactly like the request events themselves —
          // that is the whole point of the join. Filing it to the process
          // session instead is what produced two issues, the click's and the
          // log's, each reporting no counterpart. The log capture resolves the
          // target and stamps it on the event; anything it did not correlate
          // still rides the headless session as before.
          const correlated =
            typeof event.sessionId === "string" &&
            event.sessionId &&
            event.sessionId !== stableSessionId
              ? event.sessionId
              : undefined;
          if (correlated) {
            void sendBackendEvent({
              event,
              sessionId: correlated,
              endpoint: options.endpoint,
              ...(authToken ? { authToken } : {}),
              ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
            })
              .then((delivered) => {
                if (!delivered) noteDropped(event.k);
              })
              .catch((sendErr) => {
                noteDropped(event.k);
                emitError(sendErr, { phase: "record", source: "console.error" });
              });
            return;
          }
          emitSessionEvent(event);
        },
      });
    } catch (error) {
      emitError(error, { phase: "record", source: "console.error" });
    }
  }

  // Inbound request capture. The lane that carries the product's core promise:
  // the browser stamped its session and request ids on the fetch, and until this
  // existed nothing on a non-Express backend read them back, so every session
  // came back with zero backend requests and nothing linked.
  //
  // These events do NOT ride the headless session. They belong to the BROWSER's
  // session — that is the whole point of the join — so each is posted to the
  // session id the request carried, through the same intake the Express
  // middleware uses. A request without one is never emitted, so there is nothing
  // here to misfile.
  let httpCapture: HttpRequestCaptureHandle | undefined;
  if (options.captureHttpRequests !== false) {
    try {
      httpCapture = installHttpRequestCapture({
        ...options.httpModules,
        now: options.nowImpl,
        ...(options.httpResponseCapture
          ? { response: options.httpResponseCapture }
          : {}),
        emit: (event) => {
          if (stopped) return;
          const target =
            typeof event.sessionId === "string" ? event.sessionId : undefined;
          if (!target) return;
          void sendBackendEvent({
            event,
            sessionId: target,
            endpoint: options.endpoint,
            ...(authToken ? { authToken } : {}),
            ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
          })
            .then((delivered) => {
              if (!delivered) noteDropped(event.k);
            })
            .catch((sendErr) => {
              noteDropped(event.k);
              emitError(sendErr, { phase: "record", source: "console.error" });
            });
        },
      });
    } catch (error) {
      emitError(error, { phase: "record", source: "console.error" });
    }
  }

  // Outbound call capture. The lane that carries INFRASTRUCTURE.
  //
  // Everything above records what arrived and what this process did with it.
  // None of it records what this process ASKED OF ANYTHING ELSE, and that is
  // where an infrastructure failure lives: the checkout 500 is captured, the
  // pricing call that timed out and caused it is not. `backend.http` is already
  // read by the pricing, declined-payment and downstream-timeout detectors and
  // rendered by the bundle as the calls the server made outward; nothing had
  // ever produced one.
  //
  // Like the inbound recorder, these events belong to whichever session the
  // request was correlated to, falling back to the process session, so they are
  // posted through the intake rather than the headless session. The capture
  // endpoint itself is excluded: ingest travels over the same transports, and
  // observing it would make every captured event produce another one.
  let outboundCapture: OutboundHttpCaptureHandle | undefined;
  if (options.captureOutboundHttp !== false) {
    try {
      outboundCapture = installOutboundHttpCapture({
        ...options.outboundHttpModules,
        now: options.nowImpl,
        ignoreOrigins: [options.endpoint],
        emit: (event) => {
          if (stopped) return;
          const target =
            typeof event.sessionId === "string" ? event.sessionId : undefined;
          if (!target) return;
          void sendBackendEvent({
            event,
            sessionId: target,
            endpoint: options.endpoint,
            ...(authToken ? { authToken } : {}),
            ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
          })
            .then((delivered) => {
              if (!delivered) noteDropped(event.k);
            })
            .catch((sendErr) => {
              noteDropped(event.k);
              emitError(sendErr, { phase: "record", source: "console.error" });
            });
        },
      });
    } catch (error) {
      emitError(error, { phase: "record", source: "console.error" });
    }
  }


  const stop = (): void => {
    if (stopped) return;
    // Setting `stopped` also cancels any pending re-establishment: the backoff
    // gate is pull-based (no background timer to clear), so a captured error after
    // stop() short-circuits and an in-flight handshake resolves to a discarded
    // session instead of arming further retries.
    stopped = true;
    clearProcessSessionId(stableSessionId);
    if (consoleRef.error === patchedError) {
      consoleRef.error = originalError as typeof consoleRef.error;
    }
    proc.removeListener("uncaughtException", onUncaught);
    proc.removeListener("unhandledRejection", onUnhandled);
    for (const [signal, handler] of signalHandlers) {
      try {
        proc.removeListener(signal as NodeJS.Signals, handler);
      } catch {
        // Nothing to restore if the seam never accepted the listener.
      }
    }
    signalHandlers.clear();
    warningCapture?.stop();
    logCapture?.stop();
    httpCapture?.stop();
    outboundCapture?.stop();
    clearActiveDbSink(dbSink);
    dbInstrumentation?.restore();
    installed = false;
    installedService = undefined;
  };

  return { sessionId: session?.sessionId, stop };
}

/** Normalize the held-event cap, refusing a negative or non-finite value. */
function normalizePendingCap(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value))
    return DEFAULT_MAX_PENDING_EVENTS;
  return Math.max(0, Math.floor(value));
}

/**
 * The process's own identity, carried on the session start and on the
 * termination record. `pid` plus `startedAt` is what makes a restart legible: a
 * second session for the same service with a different pid is a new process, and
 * no event in the stream says that on its own.
 */
function describeProcess(proc: NodeJS.Process): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  try {
    if (typeof proc.pid === "number") record.pid = proc.pid;
    const uptime = typeof proc.uptime === "function" ? proc.uptime() : undefined;
    if (typeof uptime === "number" && Number.isFinite(uptime)) {
      record.uptimeMs = Math.round(uptime * 1000);
      record.startedAt = Math.round(Date.now() - uptime * 1000);
    }
    if (typeof proc.version === "string") record.node = proc.version;
    if (typeof proc.platform === "string") record.platform = proc.platform;
  } catch {
    // A process seam that answers none of this still gets a session.
  }
  return record;
}

/** A service name for a message, or the phrase for a call that named none. */
function describeService(service: string | undefined): string {
  return service ? `service "${service}"` : "an unnamed service";
}

/** Truthy for `1`/`true`/`yes`/`on` (case-insensitive); false for unset/empty. */
function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * The default console sentence for a server explained refusal, phrased like the
 * browser SDK's: the status, the server's own sentence, and the consequence.
 */
function refusalSentence(error: HeadlessRequestError, phase: string): string {
  const refused =
    phase === "session-start"
      ? "session start"
      : phase === "record"
        ? "backend events"
        : `ingest ${phase}`;
  return (
    `the capture endpoint refused ${refused} with HTTP ${error.status}` +
    `${error.serverMessage ? `: ${error.serverMessage}` : ""}` +
    "; nothing from this session will be captured" +
    (error.status === 401 ? ` ${missingKeyHint()}` : "")
  );
}

/**
 * A 401 reads as "your key is wrong", and the key is usually fine: the process was
 * started from a directory the `.env` holding it is not in, so no key was ever loaded
 * and none was sent. Naming the mechanism costs one sentence and saves the reader from
 * rotating a working key.
 */
function missingKeyHint(): string {
  return (
    "The key is read from a .env file in the package directory, so check the working " +
    `directory the process was started from (currently ${process.cwd()}).`
  );
}

/**
 * The server-requested backoff floor (ms) from a non-2xx `Retry-After`, when the
 * error carries one. A transport failure (TLS/DNS) has none; returns undefined.
 */
function retryAfterMsOf(err: unknown): number | undefined {
  if (
    err instanceof HeadlessRequestError &&
    typeof err.retryAfterMs === "number"
  ) {
    return err.retryAfterMs;
  }
  return undefined;
}

function generateSessionId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `auto_${Date.now().toString(36)}_${random}`;
}

function buildErrorEvent(
  error: unknown,
  source: AutoCaptureSource,
  logMessage?: string,
): BugEvent {
  const normalized = normalizeError(error);
  // The request being handled when this was raised, when there was one. A
  // `console.error` inside a handler is the same failure as the 500 the browser
  // saw; without the request's id on it, the two are two issues that each
  // report no counterpart found.
  const correlation = readRequestCorrelation();
  return {
    t: Date.now(),
    k: AUTO_CAPTURE_ERROR_EVENT,
    d: {
      source,
      error: normalized,
      ...(logMessage ? { message: bounded(logMessage, MAX_MESSAGE) } : {}),
      ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
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
