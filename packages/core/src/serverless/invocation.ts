import {
  CRUMBTRAIL_REQUEST_HEADER_LOWER,
  CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  CRUMBTRAIL_SESSION_HEADER_LOWER,
  W3C_TRACEPARENT_HEADER,
  generateTraceId,
  parseTraceparent,
  type W3CTraceContext,
} from "../correlation";
import type { BugEvent } from "../types";
import { generateSessionId } from "../utils";
import {
  ServerlessConfigurationError,
  ServerlessHttpFlushError,
  ServerlessHttpTransport,
  createServerlessHttpTransport,
  type ServerlessHttpTransportOptions,
} from "./http-transport";

export const SERVERLESS_INVOCATION_START_EVENT =
  "serverless.invocation.start" as const;
export const SERVERLESS_INVOCATION_SUCCESS_EVENT =
  "serverless.invocation.success" as const;
export const SERVERLESS_INVOCATION_ERROR_EVENT =
  "serverless.invocation.error" as const;

export const SERVERLESS_LIMITS = {
  sessionIdLength: 128,
  requestIdLength: CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  methodLength: 24,
  routeLength: 256,
  metadataEntries: 16,
  metadataKeyLength: 64,
  metadataValueLength: 256,
  errorNameLength: 120,
  errorMessageLength: 500,
  errorCodeLength: 120,
  durationMs: 86_400_000,
} as const;

type HeaderValue = string | number | readonly string[] | null | undefined;

export type ServerlessInvocationHeaders =
  { get(name: string): string | null } | Readonly<Record<string, HeaderValue>>;

export type ServerlessInvocationEventKind =
  | typeof SERVERLESS_INVOCATION_START_EVENT
  | typeof SERVERLESS_INVOCATION_SUCCESS_EVENT
  | typeof SERVERLESS_INVOCATION_ERROR_EVENT;

export type ServerlessInvocationStatus = "started" | "success" | "error";

export type ServerlessMetadataValue = string | number | boolean | null;

export interface ServerlessInvocationCorrelation {
  status:
    | "linked"
    | "missing-session"
    | "generated-request-id"
    | "missing-session-and-request-id";
  sessionIdSource: "header" | "generated";
  requestIdSource: "header" | "traceparent" | "generated";
  traceId?: string;
  spanId?: string;
  flags?: number;
}

export interface ServerlessInvocationPayload extends Record<string, unknown> {
  requestId: string;
  sessionId: string;
  correlation: ServerlessInvocationCorrelation;
  status: ServerlessInvocationStatus;
  durationMs: number;
  method?: string;
  route?: string;
  statusCode?: number;
  metadata?: Record<string, ServerlessMetadataValue>;
  error?: {
    name: string;
    message: string;
    code?: string;
  };
}

export interface ServerlessInvocationEvent extends BugEvent {
  k: ServerlessInvocationEventKind;
  d: ServerlessInvocationPayload;
}

export interface ServerlessInvocationTransport {
  startSession(session: ServerlessInvocationSession): void | Promise<unknown>;
  capture(event: ServerlessInvocationEvent): void | Promise<void>;
  endSession(sessionId: string): void | Promise<unknown>;
  flush?(): void | Promise<unknown>;
}

export interface ServerlessInvocationSession {
  sessionId: string;
  metadata?: Readonly<Record<string, ServerlessMetadataValue>>;
}

export type ServerlessTransportConfig =
  | {
      transport: ServerlessInvocationTransport;
      endpoint?: never;
      authToken?: never;
      fetchImpl?: never;
      requestTimeoutMs?: never;
    }
  | ({ transport?: never } & ServerlessHttpTransportOptions);

export type ServerlessDeliveryErrorPhase =
  | "configuration"
  | "session-start"
  | "capture"
  | "flush"
  | "session-end"
  | "cleanup-schedule";

export interface ServerlessDeliveryErrorContext {
  phase: ServerlessDeliveryErrorPhase;
  sessionId: string;
}

interface ServerlessInvocationBaseOptions {
  headers?: ServerlessInvocationHeaders;
  method?: string;
  route?: string;
  metadata?: Readonly<Record<string, unknown>>;
  service?: string;
  onError?: (error: unknown, context: ServerlessDeliveryErrorContext) => void;
  deferCleanup?: (promise: Promise<void>) => void;
  now?: () => number;
}

export type ServerlessInvocationOptions = ServerlessInvocationBaseOptions &
  ServerlessTransportConfig;

export interface ServerlessInvocationContext {
  readonly correlation: Readonly<{
    requestId: string;
    sessionId: string;
    traceId?: string;
    spanId?: string;
    flags?: number;
  }>;
  setRoute(route: string | undefined): void;
  setStatusCode(statusCode: number | undefined): void;
}

export type ServerlessInvocationHandler<T> = (
  context: ServerlessInvocationContext,
) => T | Promise<T>;

interface ResolvedCorrelation {
  requestId: string;
  sessionId: string;
  ownsSession: boolean;
  details: ServerlessInvocationCorrelation;
}

interface InvocationState {
  route?: string;
  statusCode?: number;
}

export async function runServerlessInvocation<T>(
  options: ServerlessInvocationOptions,
  handler: ServerlessInvocationHandler<T>,
): Promise<T> {
  const startedAt = readNow(options.now);
  const correlation = resolveIncomingCorrelation(options.headers);
  const method = sanitizeMethod(options.method);
  const metadata = sanitizeMetadata(options.metadata);
  const service = sanitizeMetadataValue(options.service);
  const state: InvocationState = {
    route: sanitizeRoute(options.route),
  };
  const context = createContext(correlation, state);
  const resolvedTransport = resolveTransport(options);
  let deliveryReady = resolvedTransport.transport !== undefined;

  if (resolvedTransport.error) {
    reportDeliveryError(
      options,
      resolvedTransport.error,
      "configuration",
      correlation.sessionId,
    );
  }

  if (deliveryReady && correlation.ownsSession) {
    deliveryReady = await safeStartSession(
      resolvedTransport.transport as ServerlessInvocationTransport,
      {
        sessionId: correlation.sessionId,
        metadata: {
          ...metadata,
          ...(typeof service === "string" ? { service } : {}),
          source: "serverless",
        },
      },
      options,
    );
  }

  if (deliveryReady) {
    await safeCapture(
      resolvedTransport.transport as ServerlessInvocationTransport,
      buildEvent({
        kind: SERVERLESS_INVOCATION_START_EVENT,
        lifecycleStatus: "started",
        at: startedAt,
        durationMs: 0,
        correlation,
        method,
        state,
        metadata,
      }),
      options,
      correlation.sessionId,
    );
  }

  try {
    const result = await handler(context);
    const endedAt = readNow(options.now);
    if (deliveryReady) {
      await safeCapture(
        resolvedTransport.transport as ServerlessInvocationTransport,
        buildEvent({
          kind: SERVERLESS_INVOCATION_SUCCESS_EVENT,
          lifecycleStatus: "success",
          at: endedAt,
          durationMs: boundedDuration(endedAt - startedAt),
          correlation,
          method,
          state,
          metadata,
        }),
        options,
        correlation.sessionId,
      );
      await finishDelivery(
        resolvedTransport.transport as ServerlessInvocationTransport,
        correlation,
        options,
      );
    }
    return result;
  } catch (error) {
    const endedAt = readNow(options.now);
    if (deliveryReady) {
      await safeCapture(
        resolvedTransport.transport as ServerlessInvocationTransport,
        buildEvent({
          kind: SERVERLESS_INVOCATION_ERROR_EVENT,
          lifecycleStatus: "error",
          at: endedAt,
          durationMs: boundedDuration(endedAt - startedAt),
          correlation,
          method,
          state,
          metadata,
          error: sanitizeError(error),
        }),
        options,
        correlation.sessionId,
      );
      await finishDelivery(
        resolvedTransport.transport as ServerlessInvocationTransport,
        correlation,
        options,
      );
    }
    throw error;
  }
}

function createContext(
  correlation: ResolvedCorrelation,
  state: InvocationState,
): ServerlessInvocationContext {
  const publicCorrelation = Object.freeze({
    requestId: correlation.requestId,
    sessionId: correlation.sessionId,
    ...(correlation.details.traceId
      ? { traceId: correlation.details.traceId }
      : {}),
    ...(correlation.details.spanId
      ? { spanId: correlation.details.spanId }
      : {}),
    ...(correlation.details.flags !== undefined
      ? { flags: correlation.details.flags }
      : {}),
  });

  return {
    correlation: publicCorrelation,
    setRoute(route) {
      state.route = sanitizeRoute(route);
    },
    setStatusCode(statusCode) {
      state.statusCode = sanitizeStatusCode(statusCode);
    },
  };
}

function buildEvent(input: {
  kind: ServerlessInvocationEventKind;
  lifecycleStatus: ServerlessInvocationStatus;
  at: number;
  durationMs: number;
  correlation: ResolvedCorrelation;
  method?: string;
  state: InvocationState;
  metadata?: Record<string, ServerlessMetadataValue>;
  error?: ServerlessInvocationPayload["error"];
}): ServerlessInvocationEvent {
  const payload: ServerlessInvocationPayload = {
    requestId: input.correlation.requestId,
    sessionId: input.correlation.sessionId,
    correlation: { ...input.correlation.details },
    status: input.lifecycleStatus,
    durationMs: input.durationMs,
    ...(input.method ? { method: input.method } : {}),
    ...(input.state.route ? { route: input.state.route } : {}),
    ...(input.state.statusCode !== undefined
      ? { statusCode: input.state.statusCode }
      : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
    ...(input.error ? { error: { ...input.error } } : {}),
  };

  return {
    t: input.at,
    k: input.kind,
    d: payload,
    sessionId: input.correlation.sessionId,
  };
}

function resolveIncomingCorrelation(
  headers: ServerlessInvocationHeaders | undefined,
): ResolvedCorrelation {
  const incomingSessionId = normalizeId(
    readHeader(headers, CRUMBTRAIL_SESSION_HEADER_LOWER),
    SERVERLESS_LIMITS.sessionIdLength,
  );
  const headerRequestId = normalizeId(
    readHeader(headers, CRUMBTRAIL_REQUEST_HEADER_LOWER),
    SERVERLESS_LIMITS.requestIdLength,
  );
  const trace = parseTraceparent(readHeader(headers, W3C_TRACEPARENT_HEADER));
  const incomingRequestId = headerRequestId ?? trace?.traceId;
  const requestId = incomingRequestId ?? generateTraceId();
  const sessionId = incomingSessionId ?? generateSessionId();

  return {
    requestId,
    sessionId,
    ownsSession: incomingSessionId === undefined,
    details: {
      status: correlationStatus(incomingSessionId, incomingRequestId),
      sessionIdSource: incomingSessionId ? "header" : "generated",
      requestIdSource: headerRequestId
        ? "header"
        : trace
          ? "traceparent"
          : "generated",
      ...traceFields(trace),
    },
  };
}

function correlationStatus(
  sessionId: string | undefined,
  incomingRequestId: string | undefined,
): ServerlessInvocationCorrelation["status"] {
  if (sessionId && incomingRequestId) return "linked";
  if (sessionId) return "generated-request-id";
  if (incomingRequestId) return "missing-session";
  return "missing-session-and-request-id";
}

function traceFields(
  trace: W3CTraceContext | undefined,
): Pick<ServerlessInvocationCorrelation, "traceId" | "spanId" | "flags"> {
  if (!trace) return {};
  return {
    traceId: trace.traceId,
    spanId: trace.spanId,
    flags: trace.flags,
  };
}

function readHeader(
  headers: ServerlessInvocationHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if ("get" in headers && typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }

  for (const [key, rawValue] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    return value === null || value === undefined ? undefined : String(value);
  }
  return undefined;
}

function normalizeId(value: string | undefined, maxLength: number) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  if (containsControlCharacters(trimmed)) return undefined;
  return trimmed;
}

function sanitizeMethod(method: string | undefined): string | undefined {
  const normalized = method?.trim().toUpperCase();
  if (!normalized) return undefined;
  const safe = normalized.replace(/[^A-Z0-9_-]/g, "");
  return safe ? safe.slice(0, SERVERLESS_LIMITS.methodLength) : undefined;
}

function sanitizeRoute(route: string | undefined): string | undefined {
  const trimmed = route?.trim();
  if (!trimmed) return undefined;
  const safe = stripControlCharacters(trimmed);
  return safe ? safe.slice(0, SERVERLESS_LIMITS.routeLength) : undefined;
}

function sanitizeStatusCode(statusCode: number | undefined) {
  if (!Number.isInteger(statusCode)) return undefined;
  if ((statusCode as number) < 100 || (statusCode as number) > 599)
    return undefined;
  return statusCode;
}

function sanitizeMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, ServerlessMetadataValue> | undefined {
  if (!metadata) return undefined;
  const result: Record<string, ServerlessMetadataValue> = {};

  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = sanitizeMetadataKey(rawKey);
    if (!key || isBodyMetadataKey(key)) continue;
    const value = sanitizeMetadataValue(rawValue);
    if (value === undefined) continue;
    result[key] = value;
    if (Object.keys(result).length >= SERVERLESS_LIMITS.metadataEntries) break;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeMetadataKey(key: string): string | undefined {
  const safe = stripControlCharacters(key.trim());
  return safe ? safe.slice(0, SERVERLESS_LIMITS.metadataKeyLength) : undefined;
}

function isBodyMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return (
    normalized === "body" ||
    normalized.startsWith("requestbody") ||
    normalized.startsWith("responsebody")
  );
}

function sanitizeMetadataValue(
  value: unknown,
): ServerlessMetadataValue | undefined {
  if (typeof value === "string")
    return value.slice(0, SERVERLESS_LIMITS.metadataValueLength);
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function sanitizeError(
  error: unknown,
): NonNullable<ServerlessInvocationPayload["error"]> {
  try {
    return sanitizeErrorFields(error);
  } catch {
    return { name: "Error", message: "Non-Error thrown" };
  }
}

function sanitizeErrorFields(
  error: unknown,
): NonNullable<ServerlessInvocationPayload["error"]> {
  const record = isRecord(error) ? error : undefined;
  const name =
    typeof record?.name === "string"
      ? record.name
      : error instanceof Error
        ? error.name
        : typeof error;
  const message =
    typeof record?.message === "string"
      ? record.message
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Non-Error thrown";
  const code =
    typeof record?.code === "string" || typeof record?.code === "number"
      ? String(record.code)
      : undefined;

  return {
    name: boundedText(name || "Error", SERVERLESS_LIMITS.errorNameLength),
    message: boundedText(
      message || "Error",
      SERVERLESS_LIMITS.errorMessageLength,
    ),
    ...(code
      ? { code: boundedText(code, SERVERLESS_LIMITS.errorCodeLength) }
      : {}),
  };
}

function boundedText(value: string, maxLength: number): string {
  return stripControlCharacters(value).slice(0, maxLength);
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code > 31 && code !== 127) result += character;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readNow(now: (() => number) | undefined): number {
  try {
    const value = now?.() ?? Date.now();
    return Number.isFinite(value) ? Math.round(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function boundedDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 0;
  return Math.min(
    SERVERLESS_LIMITS.durationMs,
    Math.max(0, Math.round(durationMs)),
  );
}

async function safeCapture(
  transport: ServerlessInvocationTransport,
  event: ServerlessInvocationEvent,
  options: ServerlessInvocationOptions,
  sessionId: string,
): Promise<void> {
  try {
    await transport.capture(event);
  } catch (error) {
    reportDeliveryError(options, error, "capture", sessionId);
  }
}

async function safeFlush(
  transport: ServerlessInvocationTransport,
  options: ServerlessInvocationOptions,
  sessionId: string,
): Promise<void> {
  try {
    await transport.flush?.();
  } catch (error) {
    if (error instanceof ServerlessHttpFlushError) {
      for (const failure of error.failures) {
        reportDeliveryError(
          options,
          failure.error,
          failure.phase,
          sessionId,
        );
      }
      return;
    }
    reportDeliveryError(options, error, "flush", sessionId);
  }
}

async function safeStartSession(
  transport: ServerlessInvocationTransport,
  session: ServerlessInvocationSession,
  options: ServerlessInvocationOptions,
): Promise<boolean> {
  try {
    await transport.startSession(session);
    return true;
  } catch (error) {
    reportDeliveryError(options, error, "session-start", session.sessionId);
    return false;
  }
}

async function safeEndSession(
  transport: ServerlessInvocationTransport,
  sessionId: string,
  options: ServerlessInvocationOptions,
): Promise<void> {
  try {
    await transport.endSession(sessionId);
  } catch (error) {
    reportDeliveryError(options, error, "session-end", sessionId);
  }
}

async function finishDelivery(
  transport: ServerlessInvocationTransport,
  correlation: ResolvedCorrelation,
  options: ServerlessInvocationOptions,
): Promise<void> {
  const cleanup = async (): Promise<void> => {
    if (transport instanceof ServerlessHttpTransport) {
      if (correlation.ownsSession) {
        await safeEndSession(transport, correlation.sessionId, options);
      }
      await safeFlush(transport, options, correlation.sessionId);
      return;
    }

    await safeFlush(transport, options, correlation.sessionId);
    if (correlation.ownsSession) {
      await safeEndSession(transport, correlation.sessionId, options);
    }
  };

  if (!options.deferCleanup) {
    await cleanup();
    return;
  }

  const cleanupPromise = deferCleanup(cleanup);
  try {
    options.deferCleanup(cleanupPromise);
  } catch (error) {
    reportDeliveryError(
      options,
      error,
      "cleanup-schedule",
      correlation.sessionId,
    );
    await cleanupPromise;
  }
}

function deferCleanup(cleanup: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  }).then(cleanup);
}

function resolveTransport(options: ServerlessInvocationOptions): {
  transport?: ServerlessInvocationTransport;
  error?: ServerlessConfigurationError;
} {
  try {
    if (options.transport !== undefined && options.endpoint !== undefined) {
      return {
        error: new ServerlessConfigurationError(
          "Crumbtrail serverless setup accepts transport or endpoint, not both",
        ),
      };
    }
    if (isTransport(options.transport)) return { transport: options.transport };
    if (options.transport !== undefined) {
      return {
        error: new ServerlessConfigurationError(
          "Crumbtrail serverless transport must implement startSession, capture, and endSession",
        ),
      };
    }
    if (typeof options.endpoint !== "string" || !options.endpoint.trim()) {
      return {
        error: new ServerlessConfigurationError(
          "Crumbtrail serverless setup requires either transport or endpoint",
        ),
      };
    }
    return {
      transport: createServerlessHttpTransport({
        endpoint: options.endpoint,
        ...(options.authToken ? { authToken: options.authToken } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : {}),
      }),
    };
  } catch (error) {
    return {
      error:
        error instanceof ServerlessConfigurationError
          ? error
          : new ServerlessConfigurationError(
              "Crumbtrail serverless delivery configuration could not be initialized",
            ),
    };
  }
}

function isTransport(value: unknown): value is ServerlessInvocationTransport {
  if (!isRecord(value)) return false;
  return (
    typeof value.startSession === "function" &&
    typeof value.capture === "function" &&
    typeof value.endSession === "function"
  );
}

function reportDeliveryError(
  options: ServerlessInvocationOptions,
  error: unknown,
  phase: ServerlessDeliveryErrorPhase,
  sessionId: string,
): void {
  try {
    if (options.onError) {
      options.onError(error, { phase, sessionId });
      return;
    }
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error(`[crumbtrail] serverless ${phase} failed`, error);
    }
  } catch {
    // Delivery diagnostics cannot change the host invocation.
  }
}
