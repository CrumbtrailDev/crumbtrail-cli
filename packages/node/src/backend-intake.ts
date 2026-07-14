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
}

export async function sendBackendEvent(
  options: SendBackendEventOptions,
): Promise<void> {
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
    return;
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    reportWarning(options.onWarning, {
      kind: "missing-fetch",
      message:
        "Backend event was not sent because no fetch implementation is available.",
      ...warningContext,
    });
    return;
  }

  const endpoint = normalizeEndpoint(options.endpoint);
  const headers: HeadersInitLike = { "Content-Type": "application/json" };
  const authToken = options.authToken?.trim();
  if (authToken) headers["X-Crumbtrail-Auth"] = authToken;

  try {
    const response = await fetchImpl(`${endpoint}/api/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId, events: [event] }),
      signal: options.signal,
    });

    if (!response.ok) {
      reportWarning(options.onWarning, {
        kind: "http-error",
        message: `Backend intake returned HTTP ${safeStatus(response.status) ?? "error"}.`,
        status: safeStatus(response.status),
        ...warningContext,
      });
      return;
    }

    await readAndValidateResponse(response);
  } catch (error) {
    reportWarning(options.onWarning, {
      kind: classifyCaughtError(error),
      message: safeErrorMessage(error),
      ...warningContext,
    });
  }
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
