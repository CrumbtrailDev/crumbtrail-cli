import type { BugEvent } from "./types";
import { UI_ERROR_EVENT_KIND, UI_NUM_EVENT_KIND } from "./types";
import { hashString } from "./signature";

/**
 * A leading indicator that a session is going wrong, raised by a {@link SignalDetector}.
 * The controller turns a raised signal into an auto-flagged report.
 */
export interface Signal {
  /** Tag applied to the auto-flagged report, e.g. `"auto:rage-click"`. */
  tag: string;
  /** Dedup key — a given key auto-flags at most once per session. */
  key: string;
  /**
   * SDK-authored sentence naming why the detector fired ("Auto captured after request
   * returned 500"). It is NOT a note: a note is text a person typed, and putting this
   * sentence in the report's note field made every automatic capture look like a user
   * filed a bug report — with the sentence masked to asterisks on the way out, so the
   * phantom report also claimed the person's words had been redacted.
   */
  reason: string;
}

/**
 * Inspects the live event stream and raises a {@link Signal} the moment a leading
 * indicator trips. Detectors are stateful (they track rolling windows) and pure of
 * side effects — they never flag directly; the controller owns coalescing and caps.
 */
export interface SignalDetector {
  inspect(event: BugEvent): Signal | null;
}

/** Stack traces vary below the top frames (async chains, minified chunks); the top 3 identify the throw site. */
const SIGNATURE_STACK_LINES = 3;

/** Stable signature for an `err`/`rej` event, from its kind, message, and top stack frames. */
export function errorSignature(event: BugEvent): string {
  const msg = typeof event.d.msg === "string" ? event.d.msg : "";
  const stk = typeof event.d.stk === "string" ? event.d.stk : "";
  const frames = stk.split("\n").slice(0, SIGNATURE_STACK_LINES).join("\n");
  return hashString(`${event.k}|${msg}|${frames}`);
}

/**
 * Reactive baseline detector: an uncaught error or unhandled rejection. Each distinct error
 * signature flags once per session (dedup is enforced by the controller via {@link Signal.key}).
 */
export interface ErrorDetectorOptions {
  uncaughtError?: boolean;
  unhandledRejection?: boolean;
}

export function errorDetector(
  options: ErrorDetectorOptions = {},
): SignalDetector {
  return {
    inspect(event) {
      if (
        (event.k !== "err" && event.k !== "rej") ||
        // `recordError()` is the explicit handled-error API. Its event is still
        // useful evidence, but it must not be mistaken for an uncaught error and
        // auto-flagged a second time by the baseline detector.
        (event.k === "err" && event.d.handled === true) ||
        (event.k === "err" && options.uncaughtError === false) ||
        (event.k === "rej" && options.unhandledRejection === false)
      )
        return null;
      const msg = typeof event.d.msg === "string" ? event.d.msg : undefined;
      return {
        tag: "auto:error",
        key: `err:${errorSignature(event)}`,
        reason: msg
          ? `Auto-captured after error: ${msg}`
          : "Auto-captured after error",
      };
    },
  };
}

export interface RequestFailureOptions {
  /**
   * Lowest response status treated as a failure. 500 in ordinary capture, where a 4xx is
   * usually the application saying no rather than breaking. The flight recorder lowers it to
   * 400: it is already holding the buffer, so a single rejected request is worth closing a
   * window on, and waiting for a pattern only loses the first one.
   */
  minStatus: number;
}

/** React immediately to an instrumented failing response. */
export function requestFailureDetector(
  opts: RequestFailureOptions,
): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== "net.res" || typeof event.d.st !== "number")
        return null;
      if (event.d.st < opts.minStatus) return null;
      const status = event.d.st;
      const requestId = typeof event.d.id === "number" ? event.d.id : "unknown";
      return {
        tag: "auto:request-5xx",
        key: `request-5xx:${requestId}:${status}`,
        reason: `Auto captured after request returned ${status}`,
      };
    },
  };
}

/** React to a browser-standard validation failure rendered into the document. */
export function renderedErrorDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== UI_ERROR_EVENT_KIND) return null;
      const id = typeof event.d.id === "number" ? event.d.id : "unknown";
      return {
        tag: "auto:rendered-error",
        key: `rendered-error:${id}`,
        reason: "Auto captured after rendered error state appeared",
      };
    },
  };
}

/** Drop timestamps that have aged out of the rolling window, append the new one. */
function slide(
  bucket: number[] | undefined,
  ts: number,
  windowMs: number,
): number[] {
  const arr = (bucket ?? []).filter((t) => ts - t < windowMs);
  arr.push(ts);
  return arr;
}

/** Derive a stable identity key for an interaction target descriptor. */
function targetKey(el: unknown): string {
  if (el && typeof el === "object") {
    const r = el as Record<string, unknown>;
    for (const field of [
      "sig",
      "ancestryHash",
      "testID",
      "testId",
      "id",
      "path",
    ]) {
      const v = r[field];
      if (typeof v === "string" && v) return `${field}:${v}`;
    }
    const tag = typeof r.tag === "string" ? r.tag : "?";
    const txt =
      typeof r.txt === "string"
        ? r.txt
        : typeof r.label === "string"
          ? r.label
          : "";
    return `el:${tag}:${txt}`;
  }
  return "el:unknown";
}

export interface RageClickOptions {
  /** Clicks on the same target within `windowMs` required to trip. */
  threshold: number;
  windowMs: number;
}

/**
 * Precognitive detector: the user hammering the same control (a dead button, a stuck submit)
 * is a silent failure that throws no error. Trips after `threshold` clicks on one target
 * inside `windowMs`, then resets that target's window.
 */
export function rageClickDetector(opts: RageClickOptions): SignalDetector {
  const hits = new Map<string, number[]>();
  return {
    inspect(event) {
      if (event.k !== "clk") return null;
      const key = targetKey(event.d.el ?? event.target);
      const arr = slide(hits.get(key), event.t, opts.windowMs);
      if (arr.length >= opts.threshold) {
        hits.set(key, []);
        const label = key.replace(/^[a-zA-Z]+:/, "") || "an element";
        return {
          tag: "auto:rage-click",
          key: `rage:${key}`,
          reason: `Auto-captured after ${arr.length} rapid clicks on ${label}`,
        };
      }
      hits.set(key, arr);
      return null;
    },
  };
}

export interface RetryStormOptions {
  /** Requests to the same endpoint within `windowMs` required to trip. */
  threshold: number;
  windowMs: number;
  /** Failed responses (status >= 400) to the same endpoint within `windowMs` required to trip. Defaults to 2. */
  failThreshold?: number;
}

/** `METHOD path` key with the query string stripped, so `/x?t=1` and `/x?t=2` share a bucket. */
function endpointKey(method: unknown, url: unknown): string {
  const m = typeof method === "string" ? method.toUpperCase() : "GET";
  let u = typeof url === "string" ? url : "";
  const q = u.indexOf("?");
  if (q >= 0) u = u.slice(0, q);
  return `${m} ${u}`;
}

/**
 * Precognitive detector: an end user (or the app) retrying a failing action hammers one
 * endpoint. Trips on either raw request volume to an endpoint, or a cluster of failed
 * responses to it — both silent-ish signals that surface before a thrown error (if one comes).
 */
/**
 * Cap on in-flight request ids tracked for response correlation. A request whose response never
 * arrives (aborted, page torn down) would otherwise leak an entry forever; the oldest is evicted
 * past this bound. Well above any realistic in-flight count, so it never drops a live correlation.
 */
const MAX_TRACKED_REQUESTS = 1024;

export function retryStormDetector(opts: RetryStormOptions): SignalDetector {
  const failThreshold = opts.failThreshold ?? 2;
  const endpointOf = new Map<number, string>(); // in-flight request id -> endpoint key
  const reqHits = new Map<string, number[]>();
  const failHits = new Map<string, number[]>();

  const tripped = (key: string, count: number): Signal => ({
    tag: "auto:retry-storm",
    key: `retry:${key}`,
    reason: `Auto-captured after ${count} rapid requests to ${key}`,
  });

  return {
    inspect(event) {
      if (event.k === "net.req") {
        const key = endpointKey(event.d.method, event.d.url);
        if (typeof event.d.id === "number") {
          endpointOf.set(event.d.id, key);
          if (endpointOf.size > MAX_TRACKED_REQUESTS) {
            const oldest = endpointOf.keys().next().value;
            if (oldest !== undefined) endpointOf.delete(oldest);
          }
        }
        const arr = slide(reqHits.get(key), event.t, opts.windowMs);
        if (arr.length >= opts.threshold) {
          reqHits.set(key, []);
          return tripped(key, arr.length);
        }
        reqHits.set(key, arr);
        return null;
      }

      if (event.k === "net.res" || event.k === "net.err") {
        // Correlate the response to its endpoint, then release the id — the request is no longer
        // in flight, so retaining it would grow the map by one entry per request over the session.
        const id = typeof event.d.id === "number" ? event.d.id : undefined;
        let key = id !== undefined ? endpointOf.get(id) : undefined;
        if (id !== undefined) endpointOf.delete(id);

        if (event.k === "net.res") {
          const st = typeof event.d.st === "number" ? event.d.st : 0;
          if (st < 400) return null;
        } else {
          // Aborts are routine (typeahead cancels, navigation) — not a failing endpoint.
          if (event.d.name === "AbortError") return null;
          // net.err carries its own method/url, so it can key an endpoint even when
          // the request event was never seen (e.g. it aged out of the id map).
          if (!key && typeof event.d.url === "string")
            key = endpointKey(event.d.method, event.d.url);
        }

        if (!key) return null;
        const arr = slide(failHits.get(key), event.t, opts.windowMs);
        if (arr.length >= failThreshold) {
          failHits.set(key, []);
          return tripped(key, arr.length);
        }
        failHits.set(key, arr);
        return null;
      }

      return null;
    },
  };
}

export interface SlowResponseOptions {
  /** A response is "slow" at or above this duration in ms. */
  thresholdMs: number;
  /** Slow responses within `windowMs` required to trip. */
  count: number;
  windowMs: number;
}

/**
 * Precognitive detector: a session where responses are piling up slow is degrading before any
 * timeout throws. Trips after `count` responses at or above `thresholdMs` inside `windowMs`.
 * Session-scoped (not per-endpoint) so it stays allocation-light — the captured events carry the
 * per-request detail. Flags once per session (dedup key is stable); the per-session cap bounds it.
 */
export function slowResponseDetector(
  opts: SlowResponseOptions,
): SignalDetector {
  let hits: number[] = [];
  return {
    inspect(event) {
      if (event.k !== "net.res") return null;
      const dur = typeof event.d.dur === "number" ? event.d.dur : 0;
      if (dur < opts.thresholdMs) return null;
      hits = slide(hits, event.t, opts.windowMs);
      if (hits.length >= opts.count) {
        hits = [];
        return {
          tag: "auto:slow-responses",
          key: "slow:session",
          reason: `Auto-captured after ${opts.count}+ responses slower than ${opts.thresholdMs}ms`,
        };
      }
      return null;
    },
  };
}

export interface AbandonedFlowOptions {
  /** Max ms from the last input to a page-hide that still counts as abandonment. */
  windowMs: number;
  /** Minimum input events before an interaction is treated as a "flow" worth flagging. */
  minInputs: number;
}

/** Mutating HTTP methods — a `net.req` with one of these is treated as a form submit. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Precognitive detector: the user filled a form, then left (hid/closed the tab) without submitting
 * — a silent abandonment that throws nothing and never reaches support. Trips when the page is
 * hidden within `windowMs` of the last of at least `minInputs` inputs, with no mutating request
 * (submit) in between. A mutating `net.req` clears the pending flow. Flags once per session.
 */
export function abandonedFlowDetector(
  opts: AbandonedFlowOptions,
): SignalDetector {
  let inputCount = 0;
  let lastInputAt = -Infinity;

  const reset = () => {
    inputCount = 0;
    lastInputAt = -Infinity;
  };

  return {
    inspect(event) {
      if (event.k === "inp") {
        inputCount += 1;
        lastInputAt = event.t;
        return null;
      }
      if (event.k === "net.req") {
        const method =
          typeof event.d.method === "string"
            ? event.d.method.toUpperCase()
            : "GET";
        if (MUTATING_METHODS.has(method)) reset();
        return null;
      }
      if (event.k === "vis" && event.d.state === "hidden") {
        if (
          inputCount >= opts.minInputs &&
          event.t - lastInputAt <= opts.windowMs
        ) {
          const count = inputCount;
          reset();
          return {
            tag: "auto:abandoned-flow",
            key: "abandoned:flow",
            reason: `Auto-captured after the page was hidden with ${count} unsubmitted input(s)`,
          };
        }
        return null;
      }
      return null;
    },
  };
}

/**
 * Frames that belong to somebody else. A caught error is only worth a report when the throw site
 * is the application's own code: a library logging at error level for a condition it has already
 * handled is not a defect in the page, and the SDK's own output is not a defect at all.
 */
const FOREIGN_FRAME_RE =
  /(?:\/|^)(?:node_modules|bower_components)\/|(?:^|[/\\])crumbtrail[^/\\]*\.(?:js|mjs|cjs)|\bchrome-extension:|\bmoz-extension:|\bsafari-extension:/i;

/** A frame with no location at all — `at <anonymous>`, `at Object.<anonymous>`, a bare native line. */
const LOCATIONLESS_FRAME_RE = /\((?:<anonymous>|native)\)|^\s*at\s*<anonymous>/i;

/**
 * The first stack frame that names a file, or `undefined` when the stack names none.
 *
 * The console collector captures the stack relative to the application's own `console.error` call
 * rather than to the collector standing in front of it, so frame one is genuinely the caller.
 */
function firstLocatedFrame(stack: string): string | undefined {
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("at ")) continue;
    if (LOCATIONLESS_FRAME_RE.test(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

/** Reactive detector for a failure the application handled itself. */
export function caughtErrorDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== "con" || event.d.lv !== "err") return null;
      const stack = typeof event.d.stk === "string" ? event.d.stk : "";
      if (!stack) return null;
      const frame = firstLocatedFrame(stack);
      if (!frame || FOREIGN_FRAME_RE.test(frame)) return null;

      const args = Array.isArray(event.d.args) ? event.d.args : [];
      const msg = args.find((a): a is string => typeof a === "string" && !!a);
      return {
        tag: "auto:caught-error",
        key: `caught:${hashString(`${msg ?? ""}|${frame}`)}`,
        reason: msg
          ? `Auto-captured after the application logged a caught error: ${msg}`
          : "Auto-captured after the application logged a caught error",
      };
    },
  };
}

/** The only three keys `readBodyFailure` can match on. */
const FAILURE_KEY_RE = /"(?:errors|ok|success)"\s*:/;

/** Reactive detector for a failing response that arrived with a success status. */
export function responseBodyErrorDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== "net.res") return null;
      // A 4xx or 5xx already belongs to requestFailureDetector. Raising a
      // second signal for one response spends a second dedup entry.
      const status = typeof event.d.st === "number" ? event.d.st : 0;
      if (status >= 400) return null;
      const body = typeof event.d.body === "string" ? event.d.body : "";
      if (!body || !FAILURE_KEY_RE.test(body)) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return null;
      }
      const failure = readBodyFailure(parsed);
      if (!failure) return null;

      const requestId = typeof event.d.id === "number" ? event.d.id : "unknown";
      return {
        tag: "auto:response-body-error",
        key: `body-error:${requestId}:${failure}`,
        reason: `Auto-captured after a ${status} response carried ${failure}`,
      };
    },
  };
}

/** Batched GraphQL responses are an array of results; a failure in any one counts. */
function readBodyFailure(parsed: unknown): string | undefined {
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const found = readBodyFailure(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0)
    return errors.length === 1 ? "1 error" : `${errors.length} errors`;
  if (record.ok === false) return "ok: false";
  if (record.success === false) return "success: false";
  return undefined;
}

/** Close codes that end a socket the way it was meant to end. */
const CLEAN_CLOSE_CODES = new Set([1000, 1001, 1005]);

/** Reactive detector for a socket or server-sent stream that failed. */
export function streamFailureDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== "net.ws" && event.k !== "net.sse") return null;
      const op = typeof event.d.op === "string" ? event.d.op : "";
      const url = typeof event.d.url === "string" ? event.d.url : "unknown";
      const kind = event.k === "net.ws" ? "socket" : "stream";

      if (op === "error") {
        return {
          tag: "auto:stream-failure",
          key: `stream:${event.k}:error:${url}`,
          reason: `Auto-captured after the ${kind} to ${url} errored`,
        };
      }
      // SSE close carries no close code, so it is indistinguishable from an
      // ordinary teardown. Only a socket can say that it ended early.
      if (event.k !== "net.ws" || op !== "close") return null;
      const code = typeof event.d.code === "number" ? event.d.code : undefined;
      const clean = typeof event.d.clean === "boolean" ? event.d.clean : undefined;
      const early =
        clean === false || (code !== undefined && !CLEAN_CLOSE_CODES.has(code));
      if (!early) return null;
      return {
        tag: "auto:stream-failure",
        key: `stream:close:${url}:${code ?? "unknown"}`,
        reason: `Auto-captured after the socket to ${url} closed early${
          code !== undefined ? ` with code ${code}` : ""
        }`,
      };
    },
  };
}

/** Reactive detector for a Web Worker that threw. */
export function workerErrorDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== "worker.msg" || event.d.op !== "error") return null;
      const script = typeof event.d.script === "string" ? event.d.script : "a worker";
      const msg = typeof event.d.msg === "string" ? event.d.msg : undefined;
      const id = typeof event.d.id === "number" ? event.d.id : "unknown";
      return {
        tag: "auto:worker-error",
        key: `worker:${id}:${hashString(`${script}|${msg ?? ""}`)}`,
        reason: msg
          ? `Auto-captured after ${script} threw: ${msg}`
          : `Auto-captured after ${script} threw`,
      };
    },
  };
}

/** Reactive detector for a rendered value that is missing or non-finite. */
export function wrongNumberDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== UI_NUM_EVENT_KIND) return null;
      const region =
        typeof event.d.region === "string" ? event.d.region : "unknown region";
      const items = Array.isArray(event.d.items) ? event.d.items : [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (typeof record.value === "number" && Number.isFinite(record.value))
          continue;
        const label =
          typeof record.label === "string" ? record.label : "unlabeled value";
        return {
          tag: "auto:wrong-number",
          key: `wrong-number:${hashString(`${region}|${label}`)}`,
          reason: `Auto-captured after ${label} in ${region} rendered an invalid number`,
        };
      }
      return null;
    },
  };
}

/** Reactive detector for a script or stylesheet resource that loaded no data. */
export function resourceLoadFailureDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== "perf" || event.d.metric !== "res") return null;
      const initiator =
        typeof event.d.initiatorType === "string" ? event.d.initiatorType : "";
      if (initiator !== "script" && initiator !== "link") return null;
      if (event.d.transferSize !== 0 || event.d.duration !== 0) return null;
      const name =
        typeof event.d.name === "string" ? event.d.name : "unknown resource";
      const kind = initiator === "script" ? "script" : "stylesheet";
      return {
        tag: "auto:resource-load-failure",
        key: `resource-load:${hashString(`${initiator}|${name}`)}`,
        reason: `Auto-captured after the ${kind} ${name} loaded no data`,
      };
    },
  };
}

/** Reactive detector for a storage mutation that the browser rejected. */
export function storageFailureDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== "stor" || event.d.outcome !== "failure") return null;
      const type = event.d.type === "session" ? "sessionStorage" : "localStorage";
      const op = typeof event.d.op === "string" ? event.d.op : "mutation";
      const errorName =
        typeof event.d.errorName === "string" ? event.d.errorName : "Error";
      const key = typeof event.d.key === "string" ? event.d.key : "storage";
      return {
        tag: "auto:storage-failure",
        key: `storage-failure:${type}:${op}:${key}:${errorName}`,
        reason: `Auto-captured after ${type} ${op} failed with ${errorName}`,
      };
    },
  };
}
