import type { BugEvent } from "../types";
import type {
  ServerlessInvocationEvent,
  ServerlessInvocationSession,
  ServerlessInvocationTransport,
} from "./invocation";

export const DEFAULT_SERVERLESS_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_HEADLESS_TIMEOUT_MS =
  DEFAULT_SERVERLESS_REQUEST_TIMEOUT_MS;

export interface ServerlessHttpTransportOptions {
  endpoint: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class ServerlessConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerlessConfigurationError";
  }
}

export class HeadlessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Crumbtrail serverless request timed out after ${timeoutMs}ms; ` +
        "the capture endpoint accepted the connection and did not answer",
    );
    this.name = "HeadlessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class HeadlessRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
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

export { HeadlessRequestError as ServerlessHttpRequestError };
export { HeadlessTimeoutError as ServerlessHttpTimeoutError };

export class ServerlessHttpTransport implements ServerlessInvocationTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ServerlessHttpTransportOptions) {
    const endpoint = options.endpoint?.trim().replace(/\/+$/, "");
    if (!endpoint) {
      throw new ServerlessConfigurationError(
        "Crumbtrail serverless capture requires a nonempty endpoint",
      );
    }
    this.endpoint = endpoint;
    this.headers = buildHeaders(options.authToken);
    this.fetcher = options.fetchImpl ?? fetch;
    this.timeoutMs = normalizeTimeout(options.requestTimeoutMs);
  }

  async startSession(session: ServerlessInvocationSession): Promise<void> {
    await this.post("/api/session/start", {
      sessionId: session.sessionId,
      ...(session.metadata ? { metadata: session.metadata } : {}),
    });
  }

  async capture(event: ServerlessInvocationEvent): Promise<void> {
    await this.captureBatch([event]);
  }

  async captureBatch(
    events: readonly BugEvent[],
    sessionId = events[0]?.sessionId,
  ): Promise<void> {
    if (!sessionId) {
      throw new ServerlessConfigurationError(
        "Crumbtrail serverless events require a session ID",
      );
    }
    await this.post("/api/events", { sessionId, events });
  }

  async endSession(sessionId: string): Promise<void> {
    await this.endSessionWithResult(sessionId);
  }

  async endSessionWithResult(
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    return this.post("/api/session/end", { sessionId });
  }

  flush(): void {}

  private post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return postJson(
      this.fetcher,
      `${this.endpoint}${path}`,
      this.headers,
      body,
      this.timeoutMs,
    );
  }
}

export function createServerlessHttpTransport(
  options: ServerlessHttpTransportOptions,
): ServerlessHttpTransport {
  return new ServerlessHttpTransport(options);
}

export interface HeadlessSessionOptions {
  endpoint: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
  authToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HeadlessSession {
  sessionId: string;
  record(events: BugEvent | BugEvent[]): Promise<void>;
  end(): Promise<Record<string, unknown>>;
}

export async function startHeadlessSession(
  options: HeadlessSessionOptions,
): Promise<HeadlessSession> {
  const transport = createServerlessHttpTransport({
    endpoint: options.endpoint,
    ...(options.authToken ? { authToken: options.authToken } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined
      ? { requestTimeoutMs: options.timeoutMs }
      : {}),
  });
  await transport.startSession({
    sessionId: options.sessionId,
    metadata: { ...options.metadata, source: "headless" },
  });

  return {
    sessionId: options.sessionId,
    async record(events) {
      await transport.captureBatch(
        Array.isArray(events) ? events : [events],
        options.sessionId,
      );
    },
    end() {
      return transport.endSessionWithResult(options.sessionId);
    },
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SERVERLESS_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

interface Deadline {
  signal: AbortSignal;
  readonly expired: boolean;
  cancel(): void;
}

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
      // A runtime that refuses abort still gets the underlying Fetch behavior.
    }
  }, ms);
  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    cancel() {
      clearTimeout(timer);
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
  timeoutMs: number,
): Promise<Record<string, unknown>> {
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

  const parsed = parseResponseBody(text, response.status);
  if (!response.ok) {
    const serverMessage =
      typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error.trim()
        : undefined;
    const message = serverMessage ?? `HTTP ${response.status}`;
    throw new HeadlessRequestError(
      `Crumbtrail serverless request failed: ${message}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
      serverMessage,
    );
  }
  return parsed;
}

function parseResponseBody(
  text: string,
  status: number,
): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return { error: text || `HTTP ${status}` };
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
