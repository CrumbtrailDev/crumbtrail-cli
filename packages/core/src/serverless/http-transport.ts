import type { BugEvent } from "../types";
import {
  getCachedRuntimeBindingClient,
  resolveRuntimeBindingClient,
  type RuntimeBindingClient,
  type RuntimeBindingHandle,
} from "../runtime-binding";
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
  /** Internal clock shared with the invocation for deterministic rotation. */
  now?: () => number;
  /** Opaque SDK-owned runtime identity for targeted probe delivery. */
  runtimeBinding?: RuntimeBindingHandle;
}

export class ServerlessConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerlessConfigurationError";
  }
}

export class HeadlessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, requestSubject = "headless session") {
    super(
      `Crumbtrail ${requestSubject} request timed out after ${timeoutMs}ms; ` +
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

export type ServerlessHttpOperationPhase =
  "session-start" | "capture" | "session-end";

export interface ServerlessHttpOperationFailure {
  phase: ServerlessHttpOperationPhase;
  error: unknown;
}

export class ServerlessHttpFlushError extends Error {
  readonly failures: readonly ServerlessHttpOperationFailure[];

  constructor(failures: readonly ServerlessHttpOperationFailure[]) {
    super(
      `Crumbtrail serverless delivery failed during ${failures
        .map((failure) => failure.phase)
        .join(", ")}`,
      { cause: failures[0]?.error },
    );
    this.name = "ServerlessHttpFlushError";
    this.failures = failures;
  }
}

interface QueuedOperation {
  phase: ServerlessHttpOperationPhase;
  path: string;
  body: string;
}

export class ServerlessHttpTransport implements ServerlessInvocationTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly requestSubject: string;
  private readonly runtimeBinding: RuntimeBindingClient;
  private readonly operations: QueuedOperation[] = [];
  private flushTail: Promise<void> = Promise.resolve();

  constructor(
    options: ServerlessHttpTransportOptions,
    requestSubject = "serverless",
  ) {
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
    this.requestSubject = requestSubject;
    const suppliedBinding = options.runtimeBinding
      ? resolveRuntimeBindingClient(options.runtimeBinding)
      : undefined;
    if (options.runtimeBinding &&
        !suppliedBinding?.matchesScope(endpoint, options.authToken)) {
      throw new ServerlessConfigurationError(
        "Crumbtrail runtime binding does not match the capture endpoint and project",
      );
    }
    this.runtimeBinding =
      suppliedBinding ??
      getCachedRuntimeBindingClient({
        endpoint,
        projectKey: options.authToken,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
  }

  startSession(session: ServerlessInvocationSession): void {
    this.enqueue("session-start", "/api/session/start", {
      sessionId: session.sessionId,
      ...(session.metadata ? { metadata: session.metadata } : {}),
    });
  }

  capture(event: ServerlessInvocationEvent): void {
    this.captureBatch([event]);
  }

  captureBatch(
    events: readonly BugEvent[],
    sessionId = events[0]?.sessionId,
  ): void {
    if (!sessionId) {
      throw new ServerlessConfigurationError(
        "Crumbtrail serverless events require a session ID",
      );
    }
    this.enqueue("capture", "/api/events", {
      sessionId,
      events: [...events],
    });
  }

  endSession(sessionId: string): void {
    this.enqueue("session-end", "/api/session/end", { sessionId });
  }

  flush(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const operations = this.operations.splice(0);
    const run = this.flushTail.then(() =>
      this.flushOperations(operations, signal),
    );
    this.flushTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private enqueue(
    phase: ServerlessHttpOperationPhase,
    path: string,
    body: unknown,
  ): void {
    this.operations.push({ phase, path, body: JSON.stringify(body) });
  }

  private async flushOperations(
    operations: readonly QueuedOperation[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let lastResponse: Record<string, unknown> = {};
    const failures: ServerlessHttpOperationFailure[] = [];

    for (const operation of operations) {
      if (failures.some((failure) => failure.phase === "session-start")) break;
      const deadline = startDeadline(this.timeoutMs, signal);
      try {
        throwIfAborted(deadline?.signal ?? signal);
        const body =
          operation.phase === "session-start"
            ? await waitForSignal(this.sessionStartBody(operation.body), deadline?.signal ?? signal)
            : operation.body;
        throwIfAborted(deadline?.signal ?? signal);
        lastResponse = await waitForSignal(postJson(
          this.fetcher,
          `${this.endpoint}${operation.path}`,
          this.headers,
          body,
          this.timeoutMs,
          this.requestSubject,
          deadline?.signal ?? signal,
        ), deadline?.signal ?? signal);
      } catch (error) {
        failures.push({ phase: operation.phase, error: deadline?.expired
          ? new HeadlessTimeoutError(this.timeoutMs, this.requestSubject)
          : error });
      } finally {
        deadline?.cancel();
      }
    }

    if (failures.length > 0) throw new ServerlessHttpFlushError(failures);
    return lastResponse;
  }

  private async sessionStartBody(body: string): Promise<string> {
    const binding = await this.runtimeBinding.getBinding();
    if (!binding) return body;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return JSON.stringify({
      ...parsed,
      instanceId: binding.instanceId,
      instanceProof: binding.instanceProof,
    });
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");
}

async function waitForSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
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
  signal?: AbortSignal;
  now?: () => number;
  /** Reused by Node autoCapture across session re-establishes. */
  /** Opaque SDK-owned runtime identity for targeted probe delivery. */
  runtimeBinding?: RuntimeBindingHandle;
}

export interface HeadlessSession {
  sessionId: string;
  record(events: BugEvent | BugEvent[], signal?: AbortSignal): Promise<void>;
  end(signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export async function startHeadlessSession(
  options: HeadlessSessionOptions,
): Promise<HeadlessSession> {
  const transport = new ServerlessHttpTransport(
    {
      endpoint: options.endpoint,
      ...(options.authToken ? { authToken: options.authToken } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs !== undefined
        ? { requestTimeoutMs: options.timeoutMs }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.runtimeBinding
        ? { runtimeBinding: options.runtimeBinding }
        : {}),
    },
    "headless session",
  );
  transport.startSession({
    sessionId: options.sessionId,
    metadata: { ...options.metadata, source: "headless" },
  });
  await flushHeadlessTransport(transport, options.signal);

  return {
    sessionId: options.sessionId,
    async record(events, signal) {
      transport.captureBatch(
        Array.isArray(events) ? events : [events],
        options.sessionId,
      );
      await flushHeadlessTransport(transport, signal);
    },
    async end(signal) {
      transport.endSession(options.sessionId);
      return flushHeadlessTransport(transport, signal);
    },
  };
}

async function flushHeadlessTransport(
  transport: ServerlessHttpTransport,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    return await transport.flush(signal);
  } catch (error) {
    if (error instanceof ServerlessHttpFlushError && error.failures[0]) {
      throw error.failures[0].error;
    }
    throw error;
  }
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

function startDeadline(
  ms: number,
  parentSignal?: AbortSignal,
): Deadline | undefined {
  const Controller = globalThis.AbortController;
  if (typeof Controller !== "function") return undefined;
  const controller = new Controller();
  let expired = false;
  const abortFromParent = (): void => {
    try {
      controller.abort(parentSignal?.reason);
    } catch {
      controller.abort();
    }
  };
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer =
    ms > 0
      ? setTimeout(() => {
          expired = true;
          try {
            controller.abort();
          } catch {
            // A runtime that refuses abort still gets the underlying Fetch behavior.
          }
        }, ms)
      : undefined;
  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    cancel() {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
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
  body: string,
  timeoutMs: number,
  requestSubject: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const deadline =
    timeoutMs > 0 || signal ? startDeadline(timeoutMs, signal) : undefined;
  let response: Response;
  let text: string;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers,
      body,
      ...(deadline ? { signal: deadline.signal } : {}),
    });
    text = await response.text();
  } catch (error) {
    if (deadline?.expired)
      throw new HeadlessTimeoutError(timeoutMs, requestSubject);
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
      `Crumbtrail ${requestSubject} request failed: ${message}`,
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
