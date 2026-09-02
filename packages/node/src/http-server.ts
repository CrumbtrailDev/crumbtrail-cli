import nodeHttp from "node:http";
import nodeHttps from "node:https";
import { buildCaptureGapEvent, redactUrl, type BugEvent } from "crumbtrail-core";
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
import {
  readRequestCorrelation,
  runInBackendRequestContext,
  extractBackendTraceContext,
  updateBackendRequestContext,
  type BackendRequestContext,
} from "./request-context";

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
      if (args[0] !== "request") {
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      }
      // The whole downstream dispatch runs inside one request context, so
      // anything the handler produces — a log line written through a file
      // descriptor, a database diff, a warning — can name the request it
      // happened in. The store is established EMPTY and filled by the sinks
      // below, because a request the recorders skip must still leave the
      // handler running in a context (an Express middleware claiming it later
      // upgrades this same store rather than opening a competing one).
      const context: BackendRequestContext = {};
      return runInBackendRequestContext(context, () => {
        try {
          const req = args[1] as ServerRequestLike | undefined;
          const res = args[2] as BackendResponseLike | undefined;
          if (req && res) for (const sink of [...hub.sinks]) sink(req, res);
        } catch {
          // Capture must never throw back into the host's request dispatch.
        }
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      });
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

    // Publish the correlation to the ambient context before anything else runs
    // in this request. Done even when the request is about to be skipped for
    // want of a session, because the id is what a `db.diff` or a log line joins
    // on and `readRequestCorrelation` decides on its own what is safe to use.
    updateBackendRequestContext({
      requestId:
        typeof startEvent.d.requestId === "string"
          ? startEvent.d.requestId
          : undefined,
      sessionId:
        typeof startEvent.sessionId === "string"
          ? startEvent.sessionId
          : undefined,
      sessionIdSource: sessionIdSourceOf(startEvent),
      ...extractBackendTraceContext(req.headers),
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

/**
 * Outbound HTTP capture: the calls this process makes to everything else.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Everything above records requests that ARRIVE. Nothing recorded the requests
 * this process SENDS, and that is where an infrastructure failure actually
 * lives. When a checkout 500s because the pricing service timed out, because
 * DNS stopped resolving the cache, or because a dependency answered 502, the
 * inbound request is captured in full and the call that caused it is not
 * captured at all. The session then shows a failing endpoint with no reason
 * inside it, and a diagnosis has to guess.
 *
 * `backend.http` was already the kind for this — evidence-index reads it for the
 * pricing, declined-payment and downstream-timeout detectors, and llm-bundle
 * renders it as "calls the server made outward" — and nothing in any SDK had
 * ever emitted one. This is the producer.
 *
 * Three deliberate choices, all about not paying for capture with correctness:
 *
 * - **Observation, never interception.** Each `ClientRequest` has its own `emit`
 *   shadowed, exactly like the server hub above. No listener is added, so a
 *   request whose `error` the host does not handle still crashes the process the
 *   way it always did. Capture must not convert an unhandled error into silence.
 * - **Headers and bodies are never read.** Only the method, the redacted URL,
 *   the status, the duration and the transport error class. An outbound call
 *   carries this process's own credentials to a third party; reading its headers
 *   would move a secret into the evidence stream.
 * - **The capture endpoint is excluded.** Ingest posts events over the same
 *   transports this patches. Without the exclusion, one captured event produces
 *   an outbound call that produces an event, forever.
 *
 * One known limit, stated rather than hidden: the patch replaces `request` and
 * `get` on the module object, which is what `require("http")` and
 * `import http from "node:http"` both hand out. A caller that took a NAMED ESM
 * import (`import { request } from "node:http"`) holds a binding snapshotted at
 * load time and is not covered. `fetch` is patched separately because Node's
 * fetch does not travel through `http.request` at all.
 */

/** Event kind for one call this process made outward. */
export const BACKEND_OUTBOUND_EVENT = "backend.http";

/** How an outbound call failed, when it failed before a status existed. */
export type OutboundErrorKind =
  | "timeout"
  | "dns"
  | "connection"
  | "tls"
  | "abort"
  | "error";

export interface OutboundHttpCaptureOptions {
  /** Sink for the `backend.http` events. Its own throws are swallowed. */
  emit: (event: BugEvent) => void;
  /**
   * Origins never captured, lower-cased and without a trailing slash (for
   * example `https://ingest.crumbtrail.dev`). The capture endpoint belongs here
   * or ingest observes itself. A bare host is matched too, so a value with no
   * scheme still excludes.
   */
  ignoreOrigins?: readonly string[];
  /** `node:http` to patch (tests). Defaults to the real module. */
  httpImpl?: Record<string, unknown>;
  /** `node:https` to patch (tests). Defaults to the real module. */
  httpsImpl?: Record<string, unknown>;
  /** Object carrying `fetch` to patch (tests). Defaults to `globalThis`. */
  fetchHost?: { fetch?: unknown };
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Per-install ceiling on captured calls, bounding a runaway process. */
  maxCalls?: number;
}

export interface OutboundHttpCaptureHandle {
  stop(): void;
}

/**
 * Matches the inbound ceiling. A process that makes more outbound calls than
 * this inside one capture is past the point where reading them one by one is
 * how anybody finds the defect.
 */
const DEFAULT_MAX_OUTBOUND_CALLS = 2000;

/** Longest URL recorded, after redaction. */
const MAX_OUTBOUND_URL = 500;

/**
 * Hostname labels that name a gateway rather than the thing behind it, so the
 * service name falls through to the next label: `api.stripe.com` is the stripe
 * service, not the api service.
 */
const GENERIC_HOST_LABELS = new Set(["api", "www", "app", "svc", "service"]);

interface OutboundObservation {
  method: string;
  url: string;
  host?: string;
  startedAt: number;
}

/** Install outbound call capture. `stop()` restores every patched function. */
export function installOutboundHttpCapture(
  options: OutboundHttpCaptureOptions,
): OutboundHttpCaptureHandle {
  const now = options.now ?? Date.now;
  const budget = options.maxCalls ?? DEFAULT_MAX_OUTBOUND_CALLS;
  const ignored = normalizeIgnoredOrigins(options.ignoreOrigins);
  const restore: (() => void)[] = [];
  let captured = 0;
  let stopped = false;

  const settle = (
    observation: OutboundObservation,
    outcome: { status?: number; errorKind?: OutboundErrorKind; error?: string },
  ): void => {
    if (stopped) return;
    const target = readRequestCorrelation();
    const sessionId = target?.sessionId ?? getProcessSessionId();
    // Same rule as the inbound recorder: an event with no session has nowhere
    // to land, so it is never built.
    if (!sessionId) return;
    const endedAt = readNow(now);
    const d: Record<string, unknown> = {
      method: observation.method,
      url: observation.url,
      durationMs: Math.max(0, endedAt - observation.startedAt),
      status: outcome.status ?? 0,
    };
    if (observation.host) {
      d.host = observation.host;
      const service = serviceNameFor(observation.host);
      if (service) d.service = service;
    }
    if (outcome.errorKind) d.errorKind = outcome.errorKind;
    if (outcome.error) d.error = outcome.error;
    if (target?.requestId) d.requestId = target.requestId;
    safeEmit(options.emit, { t: endedAt, k: BACKEND_OUTBOUND_EVENT, d, sessionId });
  };

  /**
   * Decide whether this call is captured, and open an observation if so. Cheap
   * on purpose: an ignored origin costs a URL build and a set lookup, and a
   * process with no session costs the same, because both are the hot path on a
   * server that is not being captured right now.
   */
  const open = (
    method: string,
    rawUrl: string | undefined,
  ): OutboundObservation | undefined => {
    if (stopped || captured >= budget || !rawUrl) return undefined;
    let parsed: URL | undefined;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = undefined;
    }
    if (parsed && isIgnoredOrigin(parsed, ignored)) return undefined;
    const redacted = safeRedactUrl(rawUrl);
    if (!redacted) return undefined;
    captured += 1;
    return {
      method: method.toUpperCase().slice(0, 12),
      url: redacted,
      ...(parsed ? { host: parsed.hostname.toLowerCase() } : {}),
      startedAt: readNow(now),
    };
  };

  for (const [mod, protocol] of [
    [options.httpImpl ?? (nodeHttp as unknown as Record<string, unknown>), "http:"],
    [options.httpsImpl ?? (nodeHttps as unknown as Record<string, unknown>), "https:"],
  ] as const) {
    for (const key of ["request", "get"]) {
      patchClientFactory(mod, key, protocol, open, settle, restore);
    }
  }

  patchFetch(options.fetchHost ?? (globalThis as { fetch?: unknown }), open, settle, restore);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const undo of restore) {
        try {
          undo();
        } catch {
          // Restoring must never throw either.
        }
      }
      restore.length = 0;
    },
  };
}

/**
 * Shadow `http.request` / `http.get` (and the https pair) so the returned
 * `ClientRequest` is observed. The original is always called with the original
 * arguments and its return value is always returned unchanged.
 */
function patchClientFactory(
  mod: Record<string, unknown>,
  key: string,
  protocol: string,
  open: (method: string, url: string | undefined) => OutboundObservation | undefined,
  settle: (
    observation: OutboundObservation,
    outcome: { status?: number; errorKind?: OutboundErrorKind; error?: string },
  ) => void,
  restore: (() => void)[],
): void {
  const original = mod?.[key];
  if (typeof original !== "function") return;
  const originalFn = original as (...args: unknown[]) => unknown;

  const patched = function (this: unknown, ...args: unknown[]): unknown {
    const request = originalFn.apply(this, args);
    try {
      const described = describeClientRequest(args, protocol);
      const observation = described
        ? open(described.method, described.url)
        : undefined;
      if (observation) observeClientRequest(request, observation, settle);
    } catch {
      // Capture must never decide whether the host's call is made.
    }
    return request;
  };

  try {
    Object.defineProperty(mod, key, {
      value: patched,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // A frozen module export stays uninstrumented rather than fatal.
    return;
  }
  restore.push(() => {
    if (mod[key] !== patched) return;
    mod[key] = originalFn;
  });
}

/**
 * Observe one `ClientRequest` by shadowing its own `emit`.
 *
 * Deliberately not `request.on("error", …)`: a ClientRequest whose `error` has
 * no listener terminates the process, and adding one here would silently keep a
 * process alive that Node was going to kill. Shadowing `emit` sees the same
 * event without becoming a listener, so the host's crash semantics are exactly
 * what they were.
 */
function observeClientRequest(
  request: unknown,
  observation: OutboundObservation,
  settle: (
    observation: OutboundObservation,
    outcome: { status?: number; errorKind?: OutboundErrorKind; error?: string },
  ) => void,
): void {
  const holder = request as { emit?: unknown };
  if (!holder || typeof holder.emit !== "function") return;
  const originalEmit = holder.emit as (...args: unknown[]) => unknown;
  let settled = false;

  const patched = function (this: unknown, ...args: unknown[]): unknown {
    try {
      if (!settled) {
        if (args[0] === "response") {
          settled = true;
          const status = numericStatus(
            (args[1] as { statusCode?: unknown } | undefined)?.statusCode,
          );
          settle(observation, status !== undefined ? { status } : {});
        } else if (args[0] === "error") {
          settled = true;
          settle(observation, classifyOutboundError(args[1]));
        } else if (args[0] === "timeout") {
          settled = true;
          settle(observation, { errorKind: "timeout", error: "TimeoutError" });
        }
      }
    } catch {
      // Observation must never reach the host's own request handling.
    }
    return originalEmit.apply(this, args);
  };

  try {
    Object.defineProperty(holder, "emit", {
      value: patched,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // A frozen request object simply goes unobserved.
  }
}

/** Shadow `fetch`, which on Node does not travel through `http.request`. */
function patchFetch(
  host: { fetch?: unknown },
  open: (method: string, url: string | undefined) => OutboundObservation | undefined,
  settle: (
    observation: OutboundObservation,
    outcome: { status?: number; errorKind?: OutboundErrorKind; error?: string },
  ) => void,
  restore: (() => void)[],
): void {
  const original = host?.fetch;
  if (typeof original !== "function") return;
  const originalFn = original as (...args: unknown[]) => Promise<unknown>;

  const patched = function (this: unknown, ...args: unknown[]): Promise<unknown> {
    let observation: OutboundObservation | undefined;
    try {
      observation = open(describeFetchMethod(args), describeFetchUrl(args));
    } catch {
      observation = undefined;
    }
    const result = originalFn.apply(this, args);
    if (!observation) return result;
    const active = observation;
    return result.then(
      (response) => {
        try {
          const status = numericStatus(
            (response as { status?: unknown } | undefined)?.status,
          );
          settle(active, status !== undefined ? { status } : {});
        } catch {
          // Never let observation change what the caller receives.
        }
        return response;
      },
      (error: unknown) => {
        try {
          settle(active, classifyOutboundError(error));
        } catch {
          // Same: the caller's rejection is rethrown untouched below.
        }
        throw error;
      },
    );
  };

  try {
    Object.defineProperty(host, "fetch", {
      value: patched,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    return;
  }
  restore.push(() => {
    if (host.fetch !== patched) return;
    host.fetch = originalFn;
  });
}

/** Method and absolute URL for an `http.request`/`http.get` argument list. */
function describeClientRequest(
  args: readonly unknown[],
  protocol: string,
): { method: string; url: string } | undefined {
  const first = args[0];
  const optionsArg = isPlainObject(args[1])
    ? (args[1] as Record<string, unknown>)
    : isPlainObject(first)
      ? (first as Record<string, unknown>)
      : undefined;
  const method =
    typeof optionsArg?.method === "string" ? optionsArg.method : "GET";

  if (typeof first === "string") return { method, url: first };
  if (first instanceof URL) return { method, url: first.toString() };
  if (!optionsArg) return undefined;

  const host =
    stringOf(optionsArg.hostname) ?? stringOf(optionsArg.host) ?? "localhost";
  const scheme = stringOf(optionsArg.protocol) ?? protocol;
  const port = optionsArg.port === undefined ? "" : `:${String(optionsArg.port)}`;
  const path = stringOf(optionsArg.path) ?? "/";
  // `host` may already carry the port; do not append a second one.
  const authority = host.includes(":") ? host : `${host}${port}`;
  return { method, url: `${scheme}//${authority}${path}` };
}

function describeFetchUrl(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first instanceof URL) return first.toString();
  const url = (first as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : undefined;
}

function describeFetchMethod(args: readonly unknown[]): string {
  const init = args[1] as { method?: unknown } | undefined;
  if (typeof init?.method === "string") return init.method;
  const request = args[0] as { method?: unknown } | undefined;
  if (typeof request?.method === "string") return request.method;
  return "GET";
}

/**
 * The transport's own verdict, mapped to a small vocabulary a reader can act
 * on. Only the error's code and class name are used; a transport error message
 * can carry a full URL with credentials in it, so it is never recorded.
 */
function classifyOutboundError(error: unknown): {
  status: number;
  errorKind: OutboundErrorKind;
  error: string;
} {
  const codes = collectErrorCodes(error);
  const kind: OutboundErrorKind = codes.some((code) =>
    /^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|TimeoutError)$/.test(
      code,
    ),
  )
    ? "timeout"
    : codes.some((code) => /^(ENOTFOUND|EAI_AGAIN)$/.test(code))
      ? "dns"
      : codes.some((code) => code.startsWith("ERR_TLS") || code.includes("CERT"))
        ? "tls"
        : codes.some((code) => /^(ABORT_ERR|AbortError)$/.test(code))
          ? "abort"
          : codes.some((code) =>
                /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|EADDRNOTAVAIL|UND_ERR_SOCKET|ERR_SOCKET_CONNECTION_TIMEOUT)$/.test(
                  code,
                ),
              )
            ? "connection"
            : "error";
  return { status: 0, errorKind: kind, error: codes[0] ?? "Error" };
}

/** Codes and class names from an error and its `cause` chain, outermost first. */
function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    // The cause's code is the specific one (`ECONNREFUSED` under a bare
    // `TypeError`), so it must be able to outrank the wrapper's class name.
    if (typeof record.code === "string" && record.code.trim())
      codes.push(record.code.trim().slice(0, 64));
    if (typeof record.name === "string" && record.name.trim())
      codes.push(record.name.trim().slice(0, 64));
    current = record.cause;
  }
  // A bare wrapper class ranks below anything specific underneath it.
  return codes.sort((a, b) =>
    Number(GENERIC_ERROR_NAMES.has(a)) - Number(GENERIC_ERROR_NAMES.has(b)),
  );
}

const GENERIC_ERROR_NAMES = new Set(["Error", "TypeError", "FetchError"]);

function normalizeIgnoredOrigins(
  origins: readonly string[] | undefined,
): { origins: Set<string>; hosts: Set<string> } {
  const result = { origins: new Set<string>(), hosts: new Set<string>() };
  for (const entry of origins ?? []) {
    const trimmed = entry?.trim().replace(/\/+$/, "").toLowerCase();
    if (!trimmed) continue;
    try {
      const parsed = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`,
      );
      result.origins.add(`${parsed.protocol}//${parsed.host}`);
      result.hosts.add(parsed.hostname);
    } catch {
      result.hosts.add(trimmed);
    }
  }
  return result;
}

function isIgnoredOrigin(
  parsed: URL,
  ignored: { origins: Set<string>; hosts: Set<string> },
): boolean {
  if (ignored.origins.has(`${parsed.protocol}//${parsed.host}`.toLowerCase()))
    return true;
  return ignored.hosts.has(parsed.hostname.toLowerCase());
}

/** The dependency this host names, for the service-aware detectors. */
function serviceNameFor(host: string): string | undefined {
  if (!host || /^\d+(\.\d+)*$/.test(host) || host.includes(":")) return undefined;
  const labels = host.split(".").filter(Boolean);
  if (labels.length === 0) return undefined;
  const first = labels[0].toLowerCase();
  if (GENERIC_HOST_LABELS.has(first) && labels.length > 1)
    return labels[1].toLowerCase().slice(0, 80);
  return first.slice(0, 80);
}

function safeRedactUrl(url: string): string | undefined {
  try {
    const value = redactUrl(url, "backend.http.url").value;
    return value ? value.slice(0, MAX_OUTBOUND_URL) : undefined;
  } catch {
    return undefined;
  }
}

/** A status code only when the runtime really produced one. */
function numericStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isPlainObject(value: unknown): boolean {
  return (
    value !== null && typeof value === "object" && !(value instanceof URL)
  );
}
