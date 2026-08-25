import type { BugEvent } from "crumbtrail-core";

export interface HeadlessSessionOptions {
  endpoint: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
  authToken?: string;
  fetchImpl?: typeof fetch;
  /**
   * Ceiling on a single ingest POST. Defaults to
   * {@link DEFAULT_HEADLESS_TIMEOUT_MS}; pass 0 to disable.
   *
   * Without one, a capture endpoint that accepts the connection and then stalls
   * (a wedged load balancer, a black holed route, a TLS handshake that never
   * completes) leaves `record()` pending forever. The caller then believes the
   * session is live, keeps handing it events, and every one of them joins the
   * same stuck queue. Nothing is delivered and nothing is reported, which is the
   * exact shape of a silent capture outage. A bounded request turns that into a
   * rejection the caller can count and record as a gap.
   */
  timeoutMs?: number;
}

/**
 * Ten seconds is far longer than a healthy ingest POST (tens of milliseconds)
 * and far shorter than the tens of minutes a stalled socket would otherwise
 * hang for. It is a liveness bound, not a latency budget.
 */
export const DEFAULT_HEADLESS_TIMEOUT_MS = 10_000;

/**
 * Thrown when an ingest request was abandoned because it exceeded its deadline.
 * Distinct from {@link HeadlessRequestError} (which means the server answered
 * and refused) and from a raw transport rejection (which means the connection
 * failed): this one means the endpoint accepted the request and never answered.
 */
export class HeadlessTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      `Crumbtrail headless session request timed out after ${timeoutMs}ms; ` +
        "the capture endpoint accepted the connection and did not answer",
    );
    this.name = "HeadlessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface HeadlessSession {
  sessionId: string;
  record(events: BugEvent | BugEvent[]): Promise<void>;
  end(): Promise<Record<string, unknown>>;
}

/**
 * Thrown when an ingest request returns a non-2xx. Carries the HTTP `status` and,
 * when the response supplied a `Retry-After` header, a parsed `retryAfterMs` so a
 * caller can respect the server's backoff floor before retrying. (A transport
 * failure — TLS/DNS/connection refused — surfaces as the raw fetch rejection, not
 * this error, since there is no response to read a header from.)
 */
export class HeadlessRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  /** The server's own refusal sentence, when the response body carried one. */
  readonly serverMessage?: string;
  constructor(
    message: string,
    status: number,
    retryAfterMs?: number,
    serverMessage?: string,
  ) {
    super(message);
    this.name = "HeadlessRequestError";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (serverMessage !== undefined) this.serverMessage = serverMessage;
  }
}

export async function startHeadlessSession(
  options: HeadlessSessionOptions,
): Promise<HeadlessSession> {
  const fetcher = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const headers = buildHeaders(options.authToken);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  await postJson(
    fetcher,
    `${endpoint}/api/session/start`,
    headers,
    {
      sessionId: options.sessionId,
      metadata: {
        ...options.metadata,
        source: "headless",
      },
    },
    timeoutMs,
  );

  return {
    sessionId: options.sessionId,
    async record(events) {
      const batch = Array.isArray(events) ? events : [events];
      await postJson(
        fetcher,
        `${endpoint}/api/events`,
        headers,
        {
          sessionId: options.sessionId,
          events: batch,
        },
        timeoutMs,
      );
    },
    async end() {
      return postJson(
        fetcher,
        `${endpoint}/api/session/end`,
        headers,
        { sessionId: options.sessionId },
        timeoutMs,
      );
    },
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HEADLESS_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

interface Deadline {
  signal: AbortSignal;
  /** True once the timer fired, so a rejection can be attributed to the deadline. */
  readonly expired: boolean;
  cancel(): void;
}

/**
 * An abort signal that fires after `ms`. The timer is unref'd so a pending
 * capture request can never be the reason a host process stays alive, and
 * `cancel()` clears it on the settled path so a healthy send leaves nothing
 * behind.
 */
function startDeadline(ms: number): Deadline | undefined {
  const Controller = globalThis.AbortController;
  if (typeof Controller !== "function") return undefined;
  const controller = new Controller();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    try {
      controller.abort();
    } catch {
      // An environment that refuses the abort still gets the untimed behaviour.
    }
  }, ms) as unknown as { unref?: () => void };
  timer.unref?.();
  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    cancel() {
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    },
  };
}

function buildHeaders(authToken: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(authToken ? { "x-crumbtrail-auth": authToken } : {}),
  };
}

async function postJson(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = DEFAULT_HEADLESS_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  // The deadline covers reading the body as well as the response headers: a
  // server that answers 200 and then never finishes the body would otherwise
  // stall on `response.text()` with the abort already disarmed.
  const deadline = timeoutMs > 0 ? startDeadline(timeoutMs) : undefined;
  let response: Response;
  let text: string;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(deadline ? { signal: deadline.signal } : {}),
    });
    text = await response.text();
  } catch (error) {
    if (deadline?.expired) throw new HeadlessTimeoutError(timeoutMs);
    throw error;
  } finally {
    deadline?.cancel();
  }
  let parsed: unknown = {};
  try {
    parsed = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    parsed = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const serverMessage =
      isRecord(parsed) && typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error.trim()
        : undefined;
    const message = serverMessage ?? `HTTP ${response.status}`;
    throw new HeadlessRequestError(
      `Crumbtrail headless session request failed: ${message}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
      serverMessage,
    );
  }
  return isRecord(parsed) ? parsed : {};
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds. Supports both forms:
 * delta-seconds (`"120"`) and an HTTP date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns undefined when absent or unparseable, and clamps negatives to 0.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
