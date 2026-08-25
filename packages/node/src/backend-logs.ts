import nodeFs from "node:fs";
import nodeModule from "node:module";
import type { BugEvent } from "crumbtrail-core";
import { redactTokenLikeString, redactValue } from "crumbtrail-core";
import { readRequestCorrelation } from "./request-context";

/**
 * Canonical event kind for one structured log line the backend wrote while
 * capture was live.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * The backend capture surface hooked three things: `console.error`,
 * `uncaughtException`/`unhandledRejection`, and `process.on("warning")`. A real
 * server logs through none of them. It logs through pino, winston or bunyan, and
 * a handled failure — the 503 an API returns when its upstream provider refuses,
 * caught, logged with the stack, and answered with a status — never touches the
 * console and never crashes the process. So a whole class of backend, the
 * ordinary one, opened a session, captured nothing, and left the diagnosis to
 * guess at a cause that was sitting in the log the whole time.
 *
 * Structured loggers bypass `console` on purpose: pino serializes to NDJSON and
 * writes the line itself. The only place every logger converges is the file
 * descriptor, so that is where this listens — `process.stdout.write` /
 * `process.stderr.write` (pino's default destination, winston's Console
 * transport, morgan) and `fs.write` / `fs.writeSync` on fd 1 and 2 (SonicBoom,
 * which `pino(pino.destination(1))` writes through and which never touches
 * `process.stdout`), plus the `writev` forms a buffered stream flushes several
 * lines through. All of them are needed: a probe of pino 9 shows the default
 * destination taking the first path and an explicit `pino.destination(1)` taking
 * the second.
 *
 * One pino option escapes every one of those, and `installTransportHook` below
 * is why this file also watches `thread-stream`: with `transport` configured
 * (pino-pretty, pino/file, pino-loki) the writing happens on a worker thread and
 * no file descriptor on this thread is ever touched.
 *
 * Deliberately NOT `backend.uncaught` (that kind carries crash semantics — the
 * process is on its way down) and NOT `con` (that is the browser console plane).
 * A logged error is neither: the process handled it and kept serving.
 */
export const BACKEND_LOG_EVENT = "backend.log";

/** Normalized log levels, in ascending severity. */
export const BACKEND_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export type BackendLogLevel = (typeof BACKEND_LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<BackendLogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Message ceiling, matching `backend.warning`'s. */
const MAX_MESSAGE = 300;
/** Error message ceiling. */
const MAX_ERROR_MESSAGE = 500;
/** Stack lines kept — enough to name the throw site and its two callers. */
const MAX_STACK_LINES = 8;
const MAX_STACK_LINE = 300;
/** How many context fields ride along. A log line can carry dozens; a reader needs a few. */
const MAX_FIELDS = 12;
const MAX_FIELD_STRING = 200;
/** A line longer than this is not a log line; drop the buffer rather than grow it. */
const MAX_BUFFERED_LINE = 64 * 1024;
/**
 * Per-install ceiling on emitted log events. A server that logs a warning per
 * request would otherwise turn one session into tens of thousands of events. The
 * first N are what a diagnosis reads; the rest are the same sentence again.
 */
const DEFAULT_MAX_EVENTS = 500;

/**
 * Logger bookkeeping, not evidence. Dropped from the context fields so a reader
 * meets the request's own values rather than the same pid and hostname on every
 * line.
 */
const IGNORED_FIELDS: ReadonlySet<string> = new Set([
  "level",
  "levelname",
  "severity",
  "time",
  "timestamp",
  "@timestamp",
  "msg",
  "message",
  "err",
  "error",
  "exception",
  "pid",
  "hostname",
  "v",
  "name",
  "stack",
]);

/** One structured log line, normalized across pino, winston and bunyan. */
export interface ParsedStructuredLog {
  level: BackendLogLevel;
  message: string;
  /** The logger's own name (`name` in pino/bunyan), when it set one. */
  logger?: string;
  error?: { name?: string; message?: string; stack?: string };
  /** The line's remaining scalar context fields, bounded. */
  fields?: Record<string, unknown>;
}

/**
 * Parse one written line as a structured log record, or `undefined` when it is
 * not one.
 *
 * Strict on purpose. Stdout carries a program's ordinary output as well as its
 * logs, and mistaking a JSON payload the app printed for a log line would put
 * arbitrary data into a session. A record qualifies only when it is a JSON
 * object carrying a level this understands — the one field every structured
 * logger writes and nothing else routinely does.
 */
export function parseStructuredLogLine(
  line: string,
): ParsedStructuredLog | undefined {
  const trimmed = line.trim();
  // Cheap gate first: the overwhelming majority of written lines are not JSON
  // objects, and this runs on every line the process writes.
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;

  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(record)) return undefined;

  const level = normalizeLevel(record.level ?? record.severity ?? record.levelname);
  if (!level) return undefined;

  const message = firstString(record.msg, record.message) ?? "";
  const error = normalizeLoggedError(
    record.err ?? record.error ?? record.exception,
  );
  // A record with neither a message nor an error names nothing; it is a metric
  // or a heartbeat, not something a reader can act on.
  if (!message && !error) return undefined;

  const parsed: ParsedStructuredLog = { level, message };
  const logger = firstString(record.name);
  if (logger) parsed.logger = logger;
  if (error) parsed.error = error;
  const fields = contextFields(record);
  if (fields) parsed.fields = fields;
  return parsed;
}

/** Build the `backend.log` event for one parsed line. */
export function buildBackendLogEvent(
  parsed: ParsedStructuredLog,
  context: {
    sessionId?: string;
    sessionStartedAt?: number | Date;
    now?: number;
    /**
     * The request this line was written inside, when one was in flight.
     *
     * This is the join key. Without it a logged error and the browser click
     * that provoked it share nothing an occurrence can be grouped on, and each
     * half reports that no counterpart was found. `requestId` is the id the
     * request's own `backend.req.*` events carry — the browser's trace id when
     * a browser correlated the call — never a second id minted here.
     */
    requestId?: string;
  } = {},
): BugEvent {
  const now = Number.isFinite(context.now)
    ? Math.round(context.now as number)
    : Date.now();

  const event: BugEvent = {
    t: now,
    k: BACKEND_LOG_EVENT,
    d: {
      level: parsed.level,
      message: scrub(parsed.message, "backend.log.message", MAX_MESSAGE),
      // `null` rather than absent, so a reader can tell "the line carried no
      // error object" apart from "this capture did not record one".
      error: parsed.error
        ? {
            name: parsed.error.name ?? "Error",
            message: scrub(
              parsed.error.message ?? "",
              "backend.log.error.message",
              MAX_ERROR_MESSAGE,
            ),
            stack: parsed.error.stack ?? null,
          }
        : null,
      ...(parsed.logger ? { logger: parsed.logger } : {}),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(parsed.fields ? { fields: parsed.fields } : {}),
    },
  };
  if (context.sessionId) event.sessionId = context.sessionId;

  const startedAt = normalizeStartedAt(context.sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);
  return event;
}

/**
 * The write paths a log line can arrive on.
 *
 * `stdout` and `stderr` are the file descriptors. `transport` is pino's
 * worker-thread lane: the line never reaches either descriptor on this thread,
 * so it gets its own line buffer rather than interleaving its partial writes
 * with the descriptors'.
 */
type LogStream = "stdout" | "stderr" | "transport";

export interface BackendLogCaptureOptions {
  /** Sink for the `backend.log` events. Its own throws are swallowed. */
  emit: (event: BugEvent) => void;
  /** Lowest level captured. Defaults to `warn` — below that is not evidence. */
  minLevel?: BackendLogLevel;
  /** Stream to patch (tests). Defaults to `process.stdout`. */
  stdout?: NodeJS.WriteStream;
  /** Stream to patch (tests). Defaults to `process.stderr`. */
  stderr?: NodeJS.WriteStream;
  /** `fs` module to patch (tests). Defaults to `node:fs`. */
  fsImpl?: typeof nodeFs;
  /** Session id stamped on emitted events, when the caller has one. */
  sessionId?: string;
  /** Session start, used to stamp `offsetMs` like every other backend event. */
  sessionStartedAt?: number | Date;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Per-install event ceiling. Defaults to 500. */
  maxEvents?: number;
}

export interface BackendLogCaptureHandle {
  /** Restore every patched write. Idempotent. */
  stop(): void;
}

/**
 * One hub per stdout object, so N concurrent captures share ONE set of patched
 * writes.
 *
 * The same reasoning as the runtime-warning hub, and the same failure it avoids:
 * `autoCapture` and the Express middleware are both installed in some processes,
 * a middleware may be created more than once, and a second wrapper around
 * `process.stdout.write` would report every log line twice and grow the call
 * stack of the host's own logging on each install. The hub is created on the
 * first install, shared by every later one, and unpatched when the last handle
 * stops.
 */
interface LogHub {
  sinks: Set<(parsed: ParsedStructuredLog) => void>;
  buffers: Record<LogStream, string>;
  /** Held across the inspection of one write: no recursion, no double count. */
  inspecting: boolean;
  restore: (() => void)[];
}

const hubs = new WeakMap<object, LogHub>();

function hubFor(
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
  fs: typeof nodeFs,
): LogHub {
  const existing = hubs.get(stdout as unknown as object);
  if (existing) return existing;

  const hub: LogHub = {
    sinks: new Set(),
    buffers: { stdout: "", stderr: "", transport: "" },
    inspecting: false,
    restore: [],
  };

  const observe = (stream: LogStream, chunk: unknown): void => {
    if (hub.inspecting) return;
    hub.inspecting = true;
    try {
      const text = chunkToString(chunk);
      if (!text) return;
      const combined = hub.buffers[stream] + text;
      const lines = combined.split("\n");
      // The trailing element is whatever came after the last newline: an
      // unterminated line still being written, kept for the next chunk.
      hub.buffers[stream] = lines.pop() ?? "";
      if (hub.buffers[stream].length > MAX_BUFFERED_LINE)
        hub.buffers[stream] = "";
      for (const line of lines) {
        if (!line) continue;
        const parsed = parseStructuredLogLine(line);
        if (!parsed) continue;
        for (const sink of [...hub.sinks]) sink(parsed);
      }
    } catch {
      // Capture must never throw back into the host application.
    } finally {
      hub.inspecting = false;
    }
  };

  // `process.stdout` and `process.stderr` are two objects, but a host (or a
  // test) may hand the same one for both; wrapping it twice would report every
  // line twice.
  const patchedStreams = new Set<unknown>();
  for (const [name, stream] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ] as const) {
    if (!stream || typeof stream.write !== "function") continue;
    if (patchedStreams.has(stream)) continue;
    patchedStreams.add(stream);
    const original = stream.write;
    const patched = function (this: unknown, ...args: unknown[]): boolean {
      observe(name, args[0]);
      return (original as (...a: unknown[]) => boolean).apply(stream, args);
    };
    (stream as { write: unknown }).write = patched;
    hub.restore.push(() => {
      if ((stream as { write: unknown }).write === patched) {
        (stream as { write: unknown }).write = original;
      }
    });
  }

  // fd 1 / fd 2 writes. This is the path pino takes when it is given an explicit
  // `pino.destination()` (SonicBoom), and it never touches `process.stdout`.
  //
  // All four variants, not just `write`/`writeSync`: SonicBoom picks between the
  // async and sync forms from its own options, and a stream flushing more than
  // one buffered chunk at once goes out through `writev`/`writevSync` instead —
  // the same log lines, on a method name this used to not be watching.
  for (const method of ["write", "writeSync", "writev", "writevSync"] as const) {
    const original = fs[method] as unknown;
    if (typeof original !== "function") continue;
    const patched = function (this: unknown, ...args: unknown[]): unknown {
      const fd = args[0];
      if (fd === 1 || fd === 2) observe(fd === 1 ? "stdout" : "stderr", args[1]);
      return (original as (...a: unknown[]) => unknown).apply(fs, args);
    };
    (fs as unknown as Record<string, unknown>)[method] = patched;
    hub.restore.push(() => {
      if ((fs as unknown as Record<string, unknown>)[method] === patched) {
        (fs as unknown as Record<string, unknown>)[method] = original;
      }
    });
  }

  installTransportHook(hub, observe);

  hubs.set(stdout as unknown as object, hub);
  return hub;
}

/** Marks a wrapper this module installed, so a second install does not stack. */
const TRANSPORT_PATCH = Symbol.for("crumbtrail.threadStreamPatched");

/**
 * Watch pino's worker-thread transport lane.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Every descriptor-level patch above is defeated by one pino option. With
 * `transport` set — `pino-pretty` in development, `pino/file`, `pino-roll`,
 * `pino-loki`, any of them — pino stops writing to a descriptor on this thread
 * altogether. It hands each line to `thread-stream`, which copies it into a
 * SharedArrayBuffer and lets a worker thread do the writing. `process.stdout`,
 * `fs.write` and every sibling see nothing, on any file descriptor, ever. A
 * probe of pino 10 shows exactly that: the four descriptor paths capture the
 * default, `sync` and `async` destinations, and capture zero lines under
 * `transport`.
 *
 * The one point that stays on the main thread is `ThreadStream.prototype.write`
 * — pino calls it with the finished NDJSON line before the worker exists in the
 * picture. So that is where this listens. Reaching it means seeing the module
 * as the host loads it, which is what the `Module.prototype.require` wrapper is
 * for: pino requires `thread-stream` lazily, only when a transport is actually
 * configured, so the module is usually not loaded yet when capture installs.
 *
 * Deliberately narrow. The wrapper forwards every other request untouched and
 * only ever looks at one module id, the patch is idempotent across installs,
 * and both the wrapper and the prototype patch are undone by `stop()`.
 */
function installTransportHook(
  hub: LogHub,
  observe: (stream: LogStream, chunk: unknown) => void,
): void {
  const ModuleCtor = (
    nodeModule as unknown as { Module?: { prototype?: Record<string, unknown> } }
  ).Module ?? (nodeModule as unknown as { prototype?: Record<string, unknown> });
  const proto = ModuleCtor?.prototype;
  if (!proto || typeof proto.require !== "function") return;

  const patchExport = (exported: unknown): void => {
    const streamProto = (
      exported as { prototype?: Record<string, unknown> } | undefined
    )?.prototype;
    if (!streamProto) return;
    const originalWrite = streamProto.write;
    if (typeof originalWrite !== "function") return;
    if ((originalWrite as unknown as Record<symbol, unknown>)[TRANSPORT_PATCH])
      return;
    const patchedWrite = function (this: unknown, ...args: unknown[]): unknown {
      observe("transport", args[0]);
      return (originalWrite as (...a: unknown[]) => unknown).apply(this, args);
    };
    (patchedWrite as unknown as Record<symbol, unknown>)[TRANSPORT_PATCH] = true;
    streamProto.write = patchedWrite;
    hub.restore.push(() => {
      if (streamProto.write === patchedWrite) streamProto.write = originalWrite;
    });
  };

  // Already loaded — a host that built its logger before capture installed.
  const cache = (ModuleCtor as unknown as { _cache?: Record<string, unknown> })
    ._cache;
  if (cache) {
    for (const key of Object.keys(cache)) {
      if (!key.includes("thread-stream")) continue;
      const entry = cache[key] as { exports?: unknown } | undefined;
      try {
        patchExport(entry?.exports);
      } catch {
        // A cache entry we cannot read is not worth a throw into the host.
      }
    }
  }

  const originalRequire = proto.require as (...a: unknown[]) => unknown;
  const patchedRequire = function (this: unknown, ...args: unknown[]): unknown {
    const exported = originalRequire.apply(this, args);
    if (args[0] === "thread-stream") {
      try {
        patchExport(exported);
      } catch {
        // Never let capture break the host's module loading.
      }
    }
    return exported;
  };
  proto.require = patchedRequire;
  hub.restore.push(() => {
    if (proto.require === patchedRequire) proto.require = originalRequire;
  });
}

/**
 * Install structured-log capture. Returns a handle whose `stop()` releases this
 * installation's claim on the shared patches.
 *
 * Best effort in the same sense as the rest of the backend capture surface: the
 * host's own write always happens, with its original arguments and its original
 * return value, and nothing in the parse path can change how the application
 * behaves. Capture is skipped entirely while a write is already being inspected,
 * so a sink that logs — or a stream whose implementation writes through the file
 * descriptor we also watch — can neither recurse nor double-count.
 */
export function installBackendLogCapture(
  options: BackendLogCaptureOptions,
): BackendLogCaptureHandle {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const fs = options.fsImpl ?? nodeFs;
  const floor = LEVEL_RANK[options.minLevel ?? "warn"];
  const budget = options.maxEvents ?? DEFAULT_MAX_EVENTS;

  let emitted = 0;
  let stopped = false;

  const sink = (parsed: ParsedStructuredLog): void => {
    if (stopped || emitted >= budget) return;
    if (LEVEL_RANK[parsed.level] < floor) return;
    emitted += 1;
    try {
      // Which request is being handled on this async path, if any. A pointer
      // read on the current async resource, so it costs nothing on a write
      // that turns out not to be a log line at all, and it never throws: a
      // line written outside every request keeps exactly its old shape.
      const correlation = readRequestCorrelation();
      options.emit(
        buildBackendLogEvent(parsed, {
          // A request a browser correlated owns the line written inside it:
          // filing it to the process session instead is what put the log and
          // the click it explains into two unjoinable halves.
          sessionId: correlation?.sessionId ?? options.sessionId,
          sessionStartedAt: options.sessionStartedAt,
          now: options.now?.(),
          ...(correlation?.requestId
            ? { requestId: correlation.requestId }
            : {}),
        }),
      );
    } catch {
      // A throwing sink must never reach the host's write.
    }
  };

  const hub = hubFor(stdout, stderr, fs);
  hub.sinks.add(sink);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const live = hubs.get(stdout as unknown as object);
      if (!live) return;
      live.sinks.delete(sink);
      if (live.sinks.size > 0) return;
      for (const undo of live.restore) {
        try {
          undo();
        } catch {
          // Restoring must never throw either.
        }
      }
      hubs.delete(stdout as unknown as object);
    },
  };
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  // `fs.writev` hands an array of buffers — several buffered log lines flushed
  // in one syscall. Concatenating them is exactly right: the line splitter
  // downstream reads the result the same way it reads one big write.
  if (Array.isArray(chunk)) return chunk.map(chunkToString).join("");
  // A Buffer or a TypedArray, which is what SonicBoom and a piped stdout write.
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength,
    ).toString("utf8");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * Normalize a level field. Numbers are the pino/bunyan scale (10 trace … 60
 * fatal), read by band so a custom level between two standard ones still lands
 * on the nearest name. Strings are the winston/console vocabulary.
 */
function normalizeLevel(value: unknown): BackendLogLevel | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 60) return "fatal";
    if (value >= 50) return "error";
    if (value >= 40) return "warn";
    if (value >= 30) return "info";
    if (value >= 20) return "debug";
    if (value >= 10) return "trace";
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "fatal":
    case "crit":
    case "critical":
    case "emerg":
    case "alert":
      return "fatal";
    case "error":
    case "err":
      return "error";
    case "warn":
    case "warning":
      return "warn";
    case "info":
    case "notice":
    case "log":
      return "info";
    case "debug":
      return "debug";
    case "trace":
    case "verbose":
    case "silly":
      return "trace";
    default:
      return undefined;
  }
}

/**
 * Read the error a log line carried. pino's default serializer writes
 * `{ type, message, stack }`; winston and hand-rolled loggers write
 * `{ name, message, stack }` or a bare string.
 */
function normalizeLoggedError(
  value: unknown,
): { name?: string; message?: string; stack?: string } | undefined {
  if (typeof value === "string" && value.trim()) {
    return { name: "Error", message: value };
  }
  if (!isRecord(value)) return undefined;
  const name = firstString(value.type, value.name);
  const message = firstString(value.message, value.msg);
  const stack = boundedStack(value.stack);
  if (!name && !message && !stack) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(message ? { message } : {}),
    ...(stack ? { stack } : {}),
  };
}

/**
 * The stack, bounded and token-redacted per line.
 *
 * Kept longer than a warning's three lines because this is the whole point of
 * the hook: the frame that names the failing function — `at fetchKeepaProduct
 * (services/keepa/fetchProduct.ts:68:11)` — is what turns "the backend returned
 * 503" into a diagnosis, and it is rarely the first frame.
 */
function boundedStack(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_STACK_LINES)
    .map(
      (line) =>
        redactTokenLikeString(line, "backend.log.error.stack").value.slice(
          0,
          MAX_STACK_LINE,
        ),
    );
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * The line's remaining context — a request id, a status, a provider name — is
 * what joins a log to the request that produced it. Bounded in count and in
 * value size, and passed through the same key-aware redaction as any other
 * captured object, because an application is free to log whatever it holds.
 */
function contextFields(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(record)) {
    if (count >= MAX_FIELDS) break;
    if (IGNORED_FIELDS.has(key)) continue;
    if (value === null) continue;
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") continue;
    fields[key] =
      type === "string"
        ? (value as string).slice(0, MAX_FIELD_STRING)
        : (value as number | boolean);
    count += 1;
  }
  if (count === 0) return undefined;
  return redactValue(fields, "backend.log.fields").value;
}

function scrub(value: string, path: string, max: number): string {
  return redactTokenLikeString(value, path).value.slice(0, max);
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
