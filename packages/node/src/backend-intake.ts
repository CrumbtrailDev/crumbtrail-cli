import type { BugEvent } from "crumbtrail-core";

export const DEFAULT_BACKEND_INTAKE_ENDPOINT = "http://localhost:9898";

const MAX_SAFE_STRING_LENGTH = 200;
const MAX_WARNING_MESSAGE_LENGTH = 300;

export type BackendIntakeWarningKind =
  | "missing-session"
  | "missing-fetch"
  | "fetch-rejected"
  | "http-error"
  | "malformed-response";

export interface BackendIntakeWarning {
  kind: BackendIntakeWarningKind;
  message: string;
  status?: number;
  sessionId?: string;
  requestId?: string;
  eventKind?: string;
}

type FetchLike = (
  input: string | URL,
  init?: FetchInitLike,
) => Promise<ResponseLike>;

type HeadersInitLike = Record<string, string>;

interface FetchInitLike {
  method?: string;
  headers?: HeadersInitLike;
  body?: string;
  signal?: AbortSignal;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

export interface SendBackendEventOptions {
  event: BugEvent;
  sessionId?: string;
  endpoint?: string;
  authToken?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  onWarning?: (warning: BackendIntakeWarning) => void;
  /**
   * Extra attempts after a transport level rejection. A capture server under a
   * burst of event posts fills its accept backlog and the kernel resets the next
   * connection, which surfaces as `TypeError: fetch failed`. Without a retry the
   * event is gone and the session shows a hole. Defaults to
   * {@link DEFAULT_BACKEND_INTAKE_RETRIES}; set to 0 to disable.
   */
  retries?: number;
  /** Delay between attempts, in milliseconds. Defaults to {@link DEFAULT_BACKEND_INTAKE_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Injection seam for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Two extra attempts clear the backlog resets observed in practice without
 * turning a genuinely unreachable endpoint into a long stall on every event.
 */
export const DEFAULT_BACKEND_INTAKE_RETRIES = 2;
export const DEFAULT_BACKEND_INTAKE_RETRY_DELAY_MS = 25;

/**
 * Resolves once the event has been accepted, or once every attempt has failed.
 * Returns whether the event actually reached the capture endpoint so a caller
 * that owns a request lifecycle can record a gap when it did not.
 */
export async function sendBackendEvent(
  options: SendBackendEventOptions,
): Promise<boolean> {
  const event = options.event;
  const sessionId =
    safeString(options.sessionId) ?? safeString(event.sessionId);
  const requestId = safeString(event.d.requestId);
  const eventKind = safeString(event.k);

  const warningContext = { sessionId, requestId, eventKind };

  if (!sessionId) {
    reportWarning(options.onWarning, {
      kind: "missing-session",
      message:
        "Backend event was not sent because no usable session ID was available.",
      requestId,
      eventKind,
    });
    return false;
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    reportWarning(options.onWarning, {
      kind: "missing-fetch",
      message:
        "Backend event was not sent because no fetch implementation is available.",
      ...warningContext,
    });
    return false;
  }

  const endpoint = normalizeEndpoint(options.endpoint);
  const headers: HeadersInitLike = { "Content-Type": "application/json" };
  const authToken = options.authToken?.trim();
  if (authToken) headers["X-Crumbtrail-Auth"] = authToken;
  const body = JSON.stringify({ sessionId, events: [event] });

  const attempts = Math.max(0, normalizeRetries(options.retries)) + 1;
  const delayMs = normalizeRetryDelay(options.retryDelayMs);
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${endpoint}/api/events`, {
        method: "POST",
        headers,
        body,
        signal: options.signal,
      });

      if (!response.ok) {
        reportWarning(options.onWarning, {
          kind: "http-error",
          message: `Backend intake returned HTTP ${safeStatus(response.status) ?? "error"}.`,
          status: safeStatus(response.status),
          ...warningContext,
        });
        return false;
      }

      await readAndValidateResponse(response);
      return true;
    } catch (error) {
      const kind = classifyCaughtError(error);
      // Only a transport rejection is worth repeating. A malformed response
      // means the endpoint answered, and an aborted send means the caller
      // withdrew, so neither improves by being sent again.
      const retryable =
        kind === "fetch-rejected" && !isAbort(error) && attempt < attempts;
      if (!retryable) {
        reportWarning(options.onWarning, {
          kind,
          message: safeErrorMessage(error),
          ...warningContext,
        });
        return false;
      }
      await sleep(delayMs * attempt);
    }
  }

  return false;
}

function normalizeRetries(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.min(5, Math.round(value as number))
    : DEFAULT_BACKEND_INTAKE_RETRIES;
}

function normalizeRetryDelay(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 0
    ? Math.round(value as number)
    : DEFAULT_BACKEND_INTAKE_RETRY_DELAY_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // The host application must never be held open by a capture retry.
    if (typeof timer === "object" && typeof timer.unref === "function")
      timer.unref();
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export const postBackendEvent = sendBackendEvent;

async function readAndValidateResponse(response: ResponseLike): Promise<void> {
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text.trim()) return;
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.ok !== true) {
      throw new MalformedBackendResponseError(
        "Backend intake response did not contain ok: true.",
      );
    }
    return;
  }

  if (typeof response.json === "function") {
    const parsed = await response.json();
    if (!isRecord(parsed) || parsed.ok !== true) {
      throw new MalformedBackendResponseError(
        "Backend intake response did not contain ok: true.",
      );
    }
  }
}

function normalizeEndpoint(endpoint: string | undefined): string {
  const trimmed = endpoint?.trim() || DEFAULT_BACKEND_INTAKE_ENDPOINT;
  return trimmed.replace(/\/+$/, "");
}

function reportWarning(
  onWarning: SendBackendEventOptions["onWarning"],
  warning: BackendIntakeWarning,
): void {
  if (!onWarning) return;
  try {
    onWarning(
      removeUndefined({
        kind: warning.kind,
        message:
          boundString(warning.message, MAX_WARNING_MESSAGE_LENGTH) ??
          "Backend intake warning.",
        status: warning.status,
        sessionId: safeString(warning.sessionId),
        requestId: safeString(warning.requestId),
        eventKind: safeString(warning.eventKind),
      }),
    );
  } catch {
    // Warning callbacks must never affect the host application response path.
  }
}

function classifyCaughtError(error: unknown): BackendIntakeWarningKind {
  return error instanceof SyntaxError ||
    error instanceof MalformedBackendResponseError
    ? "malformed-response"
    : "fetch-rejected";
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof SyntaxError ||
    error instanceof MalformedBackendResponseError
  ) {
    return "Backend intake response was malformed.";
  }

  if (error instanceof Error) {
    if (error.name === "AbortError")
      return "Backend intake request was aborted.";
    return (
      boundString(error.name, MAX_WARNING_MESSAGE_LENGTH) ??
      "Backend intake request failed."
    );
  }

  return "Backend intake request failed.";
}

function safeStatus(status: number): number | undefined {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return boundString(text, MAX_SAFE_STRING_LENGTH);
}

function boundString(value: string, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class MalformedBackendResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedBackendResponseError";
  }
}
