import { BoundedBodyRecorder } from "./bounded-body-recorder";
import {
  isTextualContentType,
  type BackendResponseLike,
} from "./backend-response";

/**
 * Request evidence capture, the operand half of a backend request.
 *
 * `backend-response.ts` records what the handler answered. Until this existed
 * nothing recorded what it was asked, so a session investigating "the API
 * returned the wrong total" held the wrong total and not one of the numbers it
 * was computed from. A customer on ASP.NET wrote their own middleware to get
 * these operands back, which is the clearest statement that the gap was real.
 *
 * ============================================================================
 * WHY THIS IS NOT THE RESPONSE RECORDER WITH THE NOUNS SWAPPED
 * ============================================================================
 *
 * The response is the recorder's to observe: nothing else writes it, so
 * wrapping `res.write`/`res.end` sees every byte and changes nothing. The
 * request stream is the APPLICATION'S to consume. Reading it here — piping it,
 * adding a `data` listener, awaiting it — would take bytes the application is
 * owed, resume a paused stream before the application is ready for it, or
 * change when backpressure is applied. A capture library that corrupts request
 * handling is worse than one that captures nothing.
 *
 * So nothing here reads the stream. Two strategies, one per shape of caller:
 *
 * - **The raw stream (`http-server.ts`, and Express when the middleware is
 *   mounted before the body parser).** The instance's own `push` is shadowed.
 *   `push` is the single choke point where Node's HTTP parser hands inbound
 *   bytes INTO the readable — `parserOnBody` calls `stream.push(slice)` and
 *   pauses the socket when it returns `false`. Shadowing it observes every byte
 *   whatever the application later does with them (`on("data")`, `pipe`,
 *   `for await`, `read()`, or nothing at all), consumes nothing, adds no
 *   listener, never resumes a paused stream, and returns the original's return
 *   value unchanged so the parser's pause decision is exactly what it was.
 *
 * - **Express with a body parser already run.** A middleware mounted after
 *   `express.json()` sees a stream that is already at its end, and nothing is
 *   pushed after that point. `req.body` holds the parser's own view of the same
 *   bytes, and reading a property the application put there touches no stream at
 *   all. Used only when the stream yielded nothing.
 *
 * Whatever is captured goes through the same redaction policy as the response
 * body, under the backend plane, in `backend-events.ts`.
 */

/** The request members a recorder reads. Structurally satisfied by `http.IncomingMessage`. */
export interface BackendRequestBodyLike {
  headers?: Record<string, string | number | readonly string[] | undefined>;
  /**
   * A body parser's output, when one ran before the recorder was attached.
   * Express puts it here; the raw `node:http` path never has it.
   */
  body?: unknown;
}

/**
 * The request members the recorder mutates, kept off the public interface for
 * the same reason as {@link BackendResponseLike}'s: widening the interface with
 * `push` would make it structurally incompatible with Express's own `Request`.
 */
interface RequestInternals {
  push?: (...args: never[]) => unknown;
}

export interface BackendRequestBodyCaptureOptions {
  /**
   * Whether to record the request body on `backend.req.end`.
   *
   * **Defaults to `"off"`, unlike the response body's `"error"`.** A response
   * body is written by the application; a request body is written by whoever
   * called it, and on exactly the endpoints most worth debugging — sign-in,
   * password reset, checkout, token exchange — it carries the credential
   * itself. The redaction engine catches those by name and by shape, but a
   * default that streams user-submitted secrets into an evidence pipeline
   * should be the operator's decision, taken once, in their own configuration.
   *
   * `"error"` captures the body for 4xx and 5xx only, which is where the
   * operands that explain a failure are. `"all"` also captures successful
   * requests, for the handler that answers 200 and computes the wrong number.
   */
  captureRequestBody?: "off" | "error" | "all";
  /** Cap on captured request bytes. Beyond it the body is truncated and marked. */
  requestBodyMaxBytes?: number;
  /** Field names exempted from the name-based redaction rules. */
  keepFields?: readonly string[];
}

/**
 * Matches the response cap. A request body worth reading as an operand is a
 * form post or a JSON document; the payloads that exceed this are uploads and
 * bulk imports, which answer a different question than the one this exists for.
 */
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 4096;

export interface RequestBodyRecorder extends BoundedBodyRecorder {
  /**
   * True when the inbound bytes are content-encoded. The stream carries the
   * compressed form, which is noise to a reader, so it is never used; a body
   * parser's decoded output still is.
   */
  encoded: boolean;
}

/**
 * Shadow the request's own `push` and buffer what the parser delivers, up to
 * the cap.
 *
 * Returns a recorder even when `push` cannot be shadowed, so the Express
 * `req.body` fallback still has somewhere to report from.
 */
export function attachRequestBodyRecorder(
  req: BackendRequestBodyLike,
  options: BackendRequestBodyCaptureOptions,
): RequestBodyRecorder | undefined {
  const mode = options.captureRequestBody ?? "off";
  if (mode === "off") return undefined;

  const cap = requestBodyCap(options);
  if (cap <= 0) return undefined;

  const contentType = requestHeaderValue(req, "content-type");
  // A binary payload contributes nothing a reader can use. Checked before the
  // stream is touched at all, so an upload costs the host nothing.
  if (contentType && !isTextualContentType(contentType)) return undefined;

  const encoding = requestHeaderValue(req, "content-encoding");
  const recorder: RequestBodyRecorder = Object.assign(
    new BoundedBodyRecorder(cap),
    {
      encoded:
        Boolean(encoding) && encoding?.trim().toLowerCase() !== "identity",
    },
  );

  const source = req as RequestInternals;
  const originalPush = source.push;
  if (typeof originalPush !== "function" || recorder.encoded) return recorder;

  const bound = originalPush.bind(req) as (...args: never[]) => unknown;

  source.push = (...args: never[]) => {
    try {
      // `push(null)` ends the stream and carries no data.
      if (args[0] !== null && args[0] !== undefined)
        recorder.record(args[0], args[1]);
    } catch {
      // Recording evidence can never be the reason a request fails to parse.
    }
    // The original's return value IS the backpressure signal the HTTP parser
    // reads to decide whether to pause the socket. It is passed back untouched.
    return bound(...args);
  };

  return recorder;
}

export interface RequestBodyEvidence {
  requestBody?: string;
  requestBodyTruncated?: boolean;
  keepFields?: readonly string[];
}

/**
 * What to report about the request, once the response's status is known.
 *
 * Read at the terminal event rather than at the start event, because at the
 * start the body has not arrived: nothing has been pushed, and no parser has
 * run. `backend.req.start` is where the request semantically belongs, and it is
 * also the moment at which nobody can say what the request contained.
 */
export function readRequestBodyEvidence(
  req: BackendRequestBodyLike,
  res: BackendResponseLike,
  recorder: RequestBodyRecorder | undefined,
  options: BackendRequestBodyCaptureOptions,
): RequestBodyEvidence {
  const mode = options.captureRequestBody ?? "off";
  if (mode === "off" || !recorder) return {};

  const status = Number.isFinite(res.statusCode)
    ? (res.statusCode as number)
    : undefined;
  if (mode === "error" && (status === undefined || status < 400)) return {};

  const cap = requestBodyCap(options);
  const streamed = recorder.read();
  const parsed =
    recorder.bytes === 0 ? parsedBodyText(req.body, cap) : undefined;
  const text = streamed !== "" ? streamed : parsed?.text;
  if (text === undefined || text === "")
    return recorder.truncated || parsed?.truncated
      ? { requestBodyTruncated: true }
      : {};

  const truncated = streamed !== "" ? recorder.truncated : parsed?.truncated;

  return {
    requestBody: text,
    ...(truncated ? { requestBodyTruncated: true } : {}),
    ...(options.keepFields && options.keepFields.length > 0
      ? { keepFields: options.keepFields }
      : {}),
  };
}

/**
 * A body parser's output rendered back to text, bounded.
 *
 * Only the shapes a parser actually produces are read. An arbitrary object with
 * a throwing getter or a cycle would make `JSON.stringify` throw, so the whole
 * conversion is guarded and contributes nothing on failure.
 */
function parsedBodyText(
  body: unknown,
  cap: number,
): { text: string; truncated: boolean } | undefined {
  let raw: string | undefined;
  try {
    if (typeof body === "string") raw = body;
    else if (body instanceof Uint8Array)
      raw = Buffer.from(body).toString("utf8");
    else if (body !== null && typeof body === "object")
      raw = JSON.stringify(body);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw === "" || raw === "{}") return undefined;
  const recorder = new BoundedBodyRecorder(cap);
  recorder.record(raw);
  const text = recorder.read();
  return { text, truncated: recorder.truncated };
}

function requestHeaderValue(
  req: BackendRequestBodyLike,
  name: string,
): string | undefined {
  const headers = req.headers;
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined ? undefined : String(first);
  }
  return undefined;
}

function requestBodyCap(options: BackendRequestBodyCaptureOptions): number {
  const configured = options.requestBodyMaxBytes;
  if (typeof configured !== "number" || !Number.isFinite(configured))
    return DEFAULT_REQUEST_BODY_MAX_BYTES;
  return Math.max(0, Math.floor(configured));
}
