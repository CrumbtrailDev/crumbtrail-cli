import nodeHttp from "node:http";
import nodeHttps from "node:https";
import { buildCaptureGapEvent, type BugEvent } from "crumbtrail-core";
import {
  buildBackendRequestEndEvent,
  buildBackendRequestStartEvent,
  type BackendRequestHeaders,
} from "./backend-events";
import {
  attachResponseRecorder,
  readResponseEvidence,
  safeStatusCode,
  type BackendResponseCaptureOptions,
  type BackendResponseLike,
  type ResponseRecorder,
} from "./backend-response";
import { isBackendRequestClaimed } from "./backend-request-claim";
import { getProcessSessionId } from "./process-session";

/**
 * Inbound HTTP request capture for every Node backend, with no application code.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Frontend to backend correlation is the product's core promise, and until this
 * existed it could not work on any install the wizard produced except Express.
 * The browser SDK stamps `x-crumbtrail-session-id`, `x-crumbtrail-request-id`
 * and `traceparent` on its fetches; `packages/node` had exactly one framework
 * module (`express.ts`) that read them back; and the hono, fastify, nestjs and
 * plain node recipes injected `autoCapture` and nothing else. So the browser
 * sent the ids, the backend recorded no inbound request at all, and the session
 * came back `backendRequests: 0`, `linked: 0`, gaps `frontend-only` — after the
 * user had been told to widen a security sensitive CORS allowlist for a payoff
 * that could not happen.
 *
 * A middleware per framework would have fixed four frameworks and left the
 * fifth. Every one of them — express, hono's `@hono/node-server`, fastify,
 * nest's express and fastify adapters, and a hand-written `createServer` — ends
 * up at one place: `http.Server` emitting `"request"`. That is what this
 * patches, so a stock `autoCapture` install records inbound requests whatever
 * the framework is, and adding a framework never means adding a module here.
 *
 * Three deliberate choices:
 *
 * - **Events are held until the response finishes.** The start event carries the
 *   real start timestamp, so the session's ordering is unaffected; holding it is
 *   what lets a framework-aware recorder (the Express middleware) claim the
 *   request in between and take ownership, instead of both recording it.
 * - **A request with no session at all emits nothing.** The intake addresses an
 *   existing session; an event with no session id has nowhere to land
 *   (`sendBackendEvent` refuses it). When `autoCapture` has established the
 *   process's own session, an uncorrelated request is filed there instead of
 *   being dropped — a backend with no browser in front of it is the ordinary
 *   case, not an unusable one — and the event records
 *   `sessionIdSource: "process"` so nothing downstream reads it as a join.
 *   With no process session either, the request is still skipped.
 * - **The host's behaviour is never altered.** Every hook is wrapped in a
 *   try/catch, the original `emit` is always called with its original arguments
 *   and its return value, and a throwing sink is swallowed.
 */

type ServerRequestLike = {
  method?: string;
  url?: string;
  headers?: BackendRequestHeaders;
};

export interface HttpRequestCaptureOptions {
  /** Sink for the `backend.req.*` events. Its own throws are swallowed. */
  emit: (event: BugEvent) => void;
  /** `node:http` to patch (tests). Defaults to the real module. */
  httpImpl?: Pick<typeof nodeHttp, "Server">;
  /** `node:https` to patch (tests). Defaults to the real module. */
  httpsImpl?: Pick<typeof nodeHttps, "Server">;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Per-install ceiling on captured requests. A busy server would otherwise turn
   * one process into unbounded egress; the first N correlated requests are what
   * a diagnosis reads.
   */
  maxRequests?: number;
  /** Response body/header capture policy, identical to the Express middleware's. */
  response?: BackendResponseCaptureOptions;
}

export interface HttpRequestCaptureHandle {
  /** Restore the patched `emit`s. Idempotent, and ref-counted across installs. */
  stop(): void;
}

/**
 * Correlated requests kept per install. Chosen to bound a runaway process, not
 * to bound a session: a user session that issues more than this many backend
 * calls is already past the point where reading them one by one helps.
 */
const DEFAULT_MAX_REQUESTS = 2000;

type RequestSink = (req: ServerRequestLike, res: BackendResponseLike) => void;

/**
 * One hub per patched prototype, so N concurrent captures share ONE patched
 * `emit` — the same reasoning as the structured-log hub, and the same failure it
 * avoids: a second wrapper would record every request twice and grow the call
 * stack of the host's own request dispatch on each install.
 */
interface ServerHub {
  sinks: Set<RequestSink>;
  restore: (() => void)[];
}

const hubs = new WeakMap<object, ServerHub>();

function hubFor(prototypes: readonly object[]): ServerHub | undefined {
  const anchor = prototypes[0];
  if (!anchor) return undefined;
  const existing = hubs.get(anchor);
  if (existing) return existing;

  const hub: ServerHub = { sinks: new Set(), restore: [] };

  const patchedProtos = new Set<object>();
  for (const proto of prototypes) {
    if (patchedProtos.has(proto)) continue;
    patchedProtos.add(proto);
    const holder = proto as { emit?: unknown };
    const original = holder.emit;
    if (typeof original !== "function") continue;
    const patched = function (this: unknown, ...args: unknown[]): unknown {
      if (args[0] === "request") {
        try {
          const req = args[1] as ServerRequestLike | undefined;
          const res = args[2] as BackendResponseLike | undefined;
          if (req && res) for (const sink of [...hub.sinks]) sink(req, res);
        } catch {
          // Capture must never throw back into the host's request dispatch.
        }
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    // An own property on the prototype: `http.Server.prototype` inherits `emit`
    // from EventEmitter, so this shadows it for servers of this kind only and is
    // removed again by deleting the property.
    Object.defineProperty(proto, "emit", {
      value: patched,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    hub.restore.push(() => {
      if ((proto as { emit?: unknown }).emit !== patched) return;
      delete (proto as { emit?: unknown }).emit;
    });
  }

  hubs.set(anchor, hub);
  return hub;
}

/**
 * Install inbound request capture. Returns a handle whose `stop()` releases this
 * installation's claim on the shared patch.
 */
export function installHttpRequestCapture(
  options: HttpRequestCaptureOptions,
): HttpRequestCaptureHandle {
  const http = options.httpImpl ?? nodeHttp;
  const https = options.httpsImpl ?? nodeHttps;
  const now = options.now ?? Date.now;
  const budget = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const responseOptions = options.response ?? {};

  const prototypes: object[] = [];
  // `https.Server` does NOT inherit from `http.Server` (it descends from
  // `tls.Server`), so patching only the http prototype would leave every TLS
  // terminating Node server uninstrumented.
  for (const ctor of [http?.Server, https?.Server]) {
    const proto = (ctor as { prototype?: object } | undefined)?.prototype;
    if (proto && !prototypes.includes(proto)) prototypes.push(proto);
  }

  let captured = 0;
  let stopped = false;

  const sink: RequestSink = (req, res) => {
    if (stopped || captured >= budget) return;
    const startedAtMs = readNow(now);

    // The start event is BUILT here, from the headers as they arrived, so a
    // handler that mutates `req.headers` cannot change what was correlated. It
    // is only SENT once the response settles, which is what leaves room for a
    // framework-aware recorder to claim the request.
    // Read per request: `autoCapture` establishes the process session
    // asynchronously, so a server that started first still picks it up.
    const processSessionId = getProcessSessionId();
    const startEvent = buildBackendRequestStartEvent({
      method: req.method,
      url: req.url,
      headers: req.headers,
      processSessionId,
      now: startedAtMs,
    });

    // No session at all — neither correlated nor process-owned — means the
    // intake has nowhere to put this. Skip before wrapping the response, so
    // such a request costs the host nothing.
    if (typeof startEvent.sessionId !== "string" || !startEvent.sessionId)
      return;
    // The end event has to resolve to the same session the start event did, and
    // to say so the same way: handing it the process id as `sessionId` would
    // record it as an explicit option and hide that nothing correlated it.
    const usedProcessSession = sessionIdSourceOf(startEvent) === "process";

    captured += 1;
    const recorder = attachResponseRecorder(res, responseOptions);
    if (typeof res.once !== "function") return;

    let settled = false;
    const settle = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      // The Express middleware (or any future framework recorder) already owns
      // this request and has recorded it with its matched route: emitting here
      // would duplicate the whole request.
      if (isBackendRequestClaimed(req)) return;
      if (completed) {
        emitPair(req, res, recorder);
        return;
      }
      // The peer cut the response short, so there is no status to report. The
      // request still happened, and a session that simply omits it reads as
      // "nothing was called here" — the one reading a capture must never
      // produce.
      safeEmit(options.emit, startEvent);
      safeEmit(
        options.emit,
        buildCaptureGapEvent({
          surface: "backend_request",
          reason: "request_unterminated",
          requestId:
            typeof startEvent.d.requestId === "string"
              ? startEvent.d.requestId
              : undefined,
          sessionId: startEvent.sessionId,
          t: readNow(now),
        }),
      );
    };

    const emitPair = (
      request: ServerRequestLike,
      response: BackendResponseLike,
      responseRecorder: ResponseRecorder | undefined,
    ): void => {
      const endedAtMs = readNow(now);
      const endEvent = buildBackendRequestEndEvent({
        method: request.method,
        url: request.url,
        headers: request.headers,
        ...(usedProcessSession
          ? { processSessionId }
          : { sessionId: startEvent.sessionId }),
        requestId:
          typeof startEvent.d.requestId === "string"
            ? startEvent.d.requestId
            : undefined,
        now: endedAtMs,
        statusCode: safeStatusCode(response.statusCode),
        durationMs: endedAtMs - startedAtMs,
        ...readResponseEvidence(response, responseRecorder, responseOptions),
      });
      safeEmit(options.emit, startEvent);
      safeEmit(options.emit, endEvent);
    };

    res.once("finish", () => settle(true));
    res.once("close", () => {
      // `close` fires for every response, including one the peer aborted before
      // it finished writing. `writableEnded` is what tells the two apart.
      settle(res.writableEnded === true);
    });
  };

  const hub = hubFor(prototypes);
  if (!hub) return { stop() {} };
  hub.sinks.add(sink);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const anchor = prototypes[0];
      const live = anchor ? hubs.get(anchor) : undefined;
      if (!live || !anchor) return;
      live.sinks.delete(sink);
      if (live.sinks.size > 0) return;
      for (const undo of live.restore) {
        try {
          undo();
        } catch {
          // Restoring must never throw either.
        }
      }
      hubs.delete(anchor);
    },
  };
}

/** Where a built event's session id came from, per its own correlation record. */
function sessionIdSourceOf(event: BugEvent): string | undefined {
  const correlation = event.d.correlation;
  if (correlation === null || typeof correlation !== "object") return undefined;
  const source = (correlation as { sessionIdSource?: unknown }).sessionIdSource;
  return typeof source === "string" ? source : undefined;
}

function safeEmit(emit: (event: BugEvent) => void, event: BugEvent): void {
  try {
    emit(event);
  } catch {
    // A throwing sink must never reach the host's response path.
  }
}

function readNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? Math.round(value) : Date.now();
  } catch {
    return Date.now();
  }
}
