import { captureDbCallsite } from "./db/callsite";
import type { DbCallsite } from "./db/callsite";

/**
 * Response evidence capture, shared by every backend request recorder.
 *
 * The Express middleware owned this logic first. It is here because the
 * `node:http` recorder (`http-server.ts`) has to record exactly the same
 * evidence under exactly the same redaction policy — a hono request and an
 * express request must not answer to two different allowlists — and a second
 * copy of a response recorder is the kind of thing that drifts silently until a
 * body is captured on one framework and dropped on another.
 */

/** The response members a recorder reads. Structurally satisfied by `http.ServerResponse`. */
export interface BackendResponseLike {
  statusCode?: number;
  /**
   * True once the response body has been fully handed to the socket. Read on
   * `close` to tell a completed response from one the peer cut short.
   */
  writableEnded?: boolean;
  once?: (event: "finish" | "close", listener: () => void) => unknown;
}

/**
 * The response members the recorder mutates, kept off the public interface.
 *
 * Widening {@link BackendResponseLike} with `write`/`end`/`getHeader` would make
 * it structurally incompatible with Express's own `Response`, so a caller could
 * no longer hand the middleware to `app.use`. These are read through a narrow
 * local view instead, each one checked at runtime before use.
 */
interface ResponseInternals {
  write?: (...args: never[]) => unknown;
  end?: (...args: never[]) => unknown;
  getHeader?: (name: string) => unknown;
}

export interface BackendResponseCaptureOptions {
  /**
   * Whether to record the response body on the terminal event.
   *
   * `"error"` (default) captures it for 4xx and 5xx only, `"all"` also captures
   * successful responses, `"off"` records no body at all. Whatever is captured
   * goes through the same redaction policy as the browser plane before it is
   * sent.
   */
  captureResponseBody?: "off" | "error" | "all";
  /** Cap on captured response bytes. Beyond it the body is truncated and marked. */
  responseBodyMaxBytes?: number;
  /**
   * Response headers to record, lowercase. Replaces the default allowlist rather
   * than extending it, so a caller can never widen it by accident.
   */
  responseHeaderAllowlist?: readonly string[];
  /** Field names exempted from the name-based redaction rules. */
  keepFields?: readonly string[];
  /** Repo root used to make the 5xx response callsite repo-relative. */
  callsiteRoot?: string;
}

/**
 * Headers that describe the response rather than authorize it.
 *
 * Allowlisted, never denylisted: a denylist is one forgotten vendor header away
 * from writing a credential to disk. `set-cookie` and `authorization` are absent
 * by construction, not by exclusion. Application headers that carry diagnostic
 * counters are the reason a caller can supply its own list.
 */
export const DEFAULT_RESPONSE_HEADER_ALLOWLIST = [
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "retry-after",
  "location",
  "x-request-id",
] as const;

export const DEFAULT_RESPONSE_BODY_MAX_BYTES = 4096;

/**
 * Content types worth reading as text. Anything else is bytes to a reader.
 *
 * Matched by family rather than by exact type: `+json` and `+xml` cover the
 * suffixed vocabularies (`application/problem+json` carries the sentence that
 * explains a 4xx, `application/ld+json`, `application/vnd.api+json`), and the
 * remaining names are the textual payloads a service actually answers with. A
 * type missing here is not redacted, it is dropped, so the cost of being too
 * narrow is a bundle holding a status code and nothing else.
 */
const TEXTUAL_CONTENT_TYPE =
  /^(application\/(json|.*\+json|xml|.*\+xml|x-www-form-urlencoded|x-ndjson|graphql|csv|yaml|x-yaml)|text\/)/i;

/** Test seam for the content-type gate. Not part of any recorder's contract. */
export function isCapturableContentTypeForTest(contentType: string): boolean {
  return TEXTUAL_CONTENT_TYPE.test(contentType);
}

export interface ResponseRecorder {
  chunks: string[];
  bytes: number;
  truncated: boolean;
  /**
   * Where the application decided to fail, captured at the moment a 5xx body is
   * first written.
   *
   * Callsites otherwise ride on `db.diff`, so a handler that catches its own
   * error and returns a constant leaves no pointer anywhere: the bundle can only
   * repeat the uninformative body the user already saw. The response write is
   * the one place every failure passes through, whether or not it touched a
   * database.
   */
  callsite?: DbCallsite;
}

/**
 * Buffers what the handler writes, up to the cap.
 *
 * `res.write`/`res.end` are wrapped rather than the stream piped, because a pipe
 * changes the response's own backpressure and a capture layer must not alter
 * what the user receives. Both wrappers return the original's return value
 * unchanged, and every failure inside them is swallowed: recording evidence can
 * never be the reason a response fails to send.
 */
export function attachResponseRecorder(
  res: BackendResponseLike,
  options: BackendResponseCaptureOptions,
): ResponseRecorder | undefined {
  const mode = options.captureResponseBody ?? "error";
  if (mode === "off") return undefined;
  const sink = res as ResponseInternals;
  if (typeof sink.write !== "function" || typeof sink.end !== "function")
    return undefined;

  const cap = responseBodyCap(options);
  if (cap <= 0) return undefined;

  const recorder: ResponseRecorder = { chunks: [], bytes: 0, truncated: false };
  const captureFailureCallsite = (): void => {
    if (recorder.callsite) return;
    const status = safeStatusCode(res.statusCode);
    if (status === undefined || status < 500) return;
    recorder.callsite = captureDbCallsite(options.callsiteRoot);
  };
  const record = (chunk: unknown): void => {
    captureFailureCallsite();
    if (recorder.bytes >= cap) return;
    let text: string | undefined;
    if (typeof chunk === "string") text = chunk;
    else if (chunk instanceof Uint8Array)
      text = Buffer.from(chunk).toString("utf8");
    if (text === undefined || text === "") return;
    const remaining = cap - recorder.bytes;
    if (text.length > remaining) {
      recorder.chunks.push(text.slice(0, remaining));
      recorder.bytes = cap;
      recorder.truncated = true;
      return;
    }
    recorder.chunks.push(text);
    recorder.bytes += text.length;
  };

  const originalWrite = sink.write.bind(res) as (...args: never[]) => unknown;
  const originalEnd = sink.end.bind(res) as (...args: never[]) => unknown;
  sink.write = (...args: never[]) => {
    try {
      record(args[0]);
    } catch {
      /* never break the response */
    }
    return originalWrite(...args);
  };
  sink.end = (...args: never[]) => {
    try {
      // A function first argument is the callback overload, not a body.
      if (typeof args[0] !== "function") record(args[0]);
    } catch {
      /* never break the response */
    }
    return originalEnd(...args);
  };

  return recorder;
}

export interface ResponseEvidence {
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  responseBodyTruncated?: boolean;
  responseCallsite?: DbCallsite;
  keepFields?: readonly string[];
}

export function readResponseEvidence(
  res: BackendResponseLike,
  recorder: ResponseRecorder | undefined,
  options: BackendResponseCaptureOptions,
): ResponseEvidence {
  const mode = options.captureResponseBody ?? "error";
  if (mode === "off") return {};

  const headers = readAllowlistedHeaders(res, options);
  const status = safeStatusCode(res.statusCode);
  // "error" mode still records headers on a success: a content type that
  // disagrees with what the caller parsed is itself the defect, and it costs
  // nothing to keep.
  if (mode === "error" && (status === undefined || status < 400))
    return Object.keys(headers).length > 0 ? { responseHeaders: headers } : {};
  if (!recorder || recorder.chunks.length === 0)
    return {
      ...(Object.keys(headers).length > 0 ? { responseHeaders: headers } : {}),
      ...(recorder?.callsite ? { responseCallsite: recorder.callsite } : {}),
    };

  const contentType = headers["content-type"];
  // A binary payload contributes nothing a reader can use and everything a
  // capture budget cannot afford.
  if (contentType && !TEXTUAL_CONTENT_TYPE.test(contentType))
    return { responseHeaders: headers };

  return {
    ...(recorder.callsite ? { responseCallsite: recorder.callsite } : {}),
    responseBody: recorder.chunks.join(""),
    ...(options.keepFields && options.keepFields.length > 0
      ? { keepFields: options.keepFields }
      : {}),
    ...(recorder.truncated ? { responseBodyTruncated: true } : {}),
    ...(Object.keys(headers).length > 0 ? { responseHeaders: headers } : {}),
  };
}

function readAllowlistedHeaders(
  res: BackendResponseLike,
  options: BackendResponseCaptureOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  const source = res as ResponseInternals;
  const getHeader = source.getHeader;
  if (typeof getHeader !== "function") return out;
  const allowlist =
    options.responseHeaderAllowlist ?? DEFAULT_RESPONSE_HEADER_ALLOWLIST;
  for (const name of allowlist) {
    let raw: unknown;
    try {
      raw = getHeader.call(res, name);
    } catch {
      continue;
    }
    if (raw === undefined || raw === null) continue;
    const value = Array.isArray(raw) ? raw.join(", ") : String(raw);
    if (value) out[name.toLowerCase()] = value.slice(0, 300);
  }
  return out;
}

function responseBodyCap(options: BackendResponseCaptureOptions): number {
  const configured = options.responseBodyMaxBytes;
  if (typeof configured !== "number" || !Number.isFinite(configured))
    return DEFAULT_RESPONSE_BODY_MAX_BYTES;
  return Math.max(0, Math.floor(configured));
}

export function safeStatusCode(
  statusCode: number | undefined,
): number | undefined {
  return Number.isFinite(statusCode) ? statusCode : undefined;
}
