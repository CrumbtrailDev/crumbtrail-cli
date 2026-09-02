import {
  buildBackendJobEndEvent,
  buildBackendJobErrorEvent,
  buildBackendJobStartEvent,
} from "./backend-events";
import {
  getActiveBackendEventSink,
  type BackendEventSink,
} from "./backend-event-sink";
import {
  captureToken,
  CRUMBTRAIL_CONTEXT_TOKEN_VERSION,
  DEFAULT_CONTEXT_TOKEN_TTL_MS,
  validateCrumbtrailContextToken,
  withCausalContext,
  type CrumbtrailContextToken,
} from "./distributed-context";
import { startHeadlessSession, type HeadlessSession } from "./headless-session";
import type { BugEvent } from "crumbtrail-core";

export const DEFAULT_JOB_CLEANUP_TIMEOUT_MS = 500;
export const DEFAULT_JOB_LINK_TIMEOUT_MS = 500;

export interface CrumbtrailJobOptions {
  /** Stable job name, such as `record-payment`. */
  name: string;
  /** Queue or scheduler identity. */
  queue?: string;
  /** Host supplied run id. */
  jobId?: string;
  /** First execution is one. Retries keep the same logical identity. */
  attempt?: number;
  /** Parent context captured when the work was enqueued. */
  context?: CrumbtrailContextToken;
  /** Explicit sink, primarily for hosts and tests. Defaults to autoCapture. */
  sink?: BackendEventSink;
  /** Used when no active sink can create a child session. */
  endpoint?: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  metadata?: Record<string, unknown>;
  now?: () => number;
  cleanupTimeoutMs?: number;
  linkTimeoutMs?: number;
  /** Capture diagnostics are best effort and never reject the job. */
  onCaptureLoss?: (error: unknown, phase: JobCaptureLossPhase) => void;
}

export type JobCaptureLossPhase =
  | "context"
  | "session-start"
  | "session-link"
  | "start"
  | "terminal"
  | "flush"
  | "session-end";

export interface CrumbtrailJobContext {
  readonly name: string;
  readonly queue?: string;
  readonly jobId?: string;
  readonly attempt: number;
  readonly sessionId: string;
  readonly requestId?: string;
  readonly traceparent: string;
  readonly token: CrumbtrailContextToken;
}

/**
 * Run one queue or scheduler attempt inside a child capture session.
 *
 * Setup, event delivery, linking, flushing, and session cleanup are all
 * contained. The wrapped function's return value and original thrown error
 * always win over capture failures.
 */
export async function withCrumbtrailJob<T>(
  options: CrumbtrailJobOptions,
  fn: (context: CrumbtrailJobContext) => T | Promise<T>,
): Promise<T> {
  const now = safeNow(options.now);
  const parentToken = options.context ?? captureToken({ now });
  const validatedParent = parentToken
    ? validateCrumbtrailContextToken(parentToken, now)
    : undefined;
  if (parentToken && !validatedParent) {
    reportLoss(
      options,
      new TypeError("Invalid or expired Crumbtrail context token"),
      "context",
    );
  }

  const name = options.name;
  const attempt = normalizeAttempt(options.attempt);
  const childSessionId = generateJobSessionId(
    name,
    options.queue,
    options.jobId,
    now,
  );
  const parentSessionId = validatedParent?.sessionId;
  const parentRequestId = validatedParent?.requestId;
  const sink = options.sink ?? getActiveBackendEventSink();

  let child: BackendEventSink | undefined;
  let childHeadless: HeadlessSession | undefined;
  let started = false;
  try {
    if (sink?.startChildSession) {
      child = await bounded(
        sink.startChildSession({
          sessionId: childSessionId,
          metadata: {
            ...(options.metadata ?? {}),
            job: name,
            ...(options.queue ? { queue: options.queue } : {}),
            ...(options.jobId ? { jobId: options.jobId } : {}),
            attempt,
          },
        }),
        options.cleanupTimeoutMs ?? DEFAULT_JOB_CLEANUP_TIMEOUT_MS,
      );
    } else if (options.endpoint) {
      childHeadless = await bounded(
        startHeadlessSession({
          endpoint: options.endpoint,
          sessionId: childSessionId,
          authToken: options.authToken,
          fetchImpl: options.fetchImpl,
          metadata: {
            ...(options.metadata ?? {}),
            job: name,
            ...(options.queue ? { queue: options.queue } : {}),
            ...(options.jobId ? { jobId: options.jobId } : {}),
            attempt,
          },
        }),
        options.cleanupTimeoutMs ?? DEFAULT_JOB_CLEANUP_TIMEOUT_MS,
      );
      child = headlessSink(childHeadless);
    } else if (sink) {
      // A host supplied sink may intentionally only expose record/flush (for
      // example an in-memory test sink). Preserve that seam and keep the job
      // event payload addressed to its child session.
      child = {
        sessionId: childSessionId,
        record: async (events) => sink.record(events),
        flush: sink.flush,
      };
    }
  } catch (error) {
    reportLoss(options, error, "session-start");
  }

  const effectiveChildSessionId = child?.sessionId ?? childSessionId;

  if (parentSessionId && child) {
    const linkInput = {
      fromSessionId: parentSessionId,
      toSessionId: effectiveChildSessionId,
      relation: "caused" as const,
      method: "trace_context" as const,
      confidence: 1,
      matchedOn: {
        ...(parentRequestId ? { requestId: parentRequestId } : {}),
        traceparent: validatedParent?.traceparent,
        ...(options.queue ? { queue: options.queue } : {}),
        name,
        ...(options.jobId ? { jobId: options.jobId } : {}),
      },
      anchorHint: `job:${name}`,
    };
    try {
      if (sink?.linkSessions) {
        await bounded(
          sink.linkSessions(linkInput),
          options.linkTimeoutMs ?? DEFAULT_JOB_LINK_TIMEOUT_MS,
        );
      } else if (options.endpoint) {
        await postSessionLink({
          endpoint: options.endpoint,
          authToken: options.authToken,
          fetchImpl: options.fetchImpl,
          input: linkInput,
          timeoutMs: options.linkTimeoutMs ?? DEFAULT_JOB_LINK_TIMEOUT_MS,
        });
      }
    } catch (error) {
      reportLoss(options, error, "session-link");
    }
  }

  const childToken = childTokenFor(
    validatedParent,
    effectiveChildSessionId,
    parentRequestId,
    now,
  );
  const jobContext: CrumbtrailJobContext = {
    name,
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.jobId ? { jobId: options.jobId } : {}),
    attempt,
    sessionId: effectiveChildSessionId,
    ...(childToken.requestId ? { requestId: childToken.requestId } : {}),
    traceparent: childToken.traceparent,
    token: childToken,
  };

  const record = async (
    event: BugEvent,
    phase: JobCaptureLossPhase,
  ): Promise<void> => {
    if (!child) return;
    try {
      await bounded(
        child.record(event),
        options.cleanupTimeoutMs ?? DEFAULT_JOB_CLEANUP_TIMEOUT_MS,
      );
    } catch (error) {
      reportLoss(options, error, phase);
    }
  };

  if (child) {
    started = true;
    await record(
      buildBackendJobStartEvent({
        name,
        ...(options.queue ? { queue: options.queue } : {}),
        ...(options.jobId ? { jobId: options.jobId } : {}),
        attempt,
        sessionId: effectiveChildSessionId,
        ...(childToken.requestId ? { requestId: childToken.requestId } : {}),
        now,
      }),
      "start",
    );
  }

  let businessResult: T | undefined;
  let businessError: unknown;
  let succeeded = false;
  try {
    businessResult = await withCausalContext(childToken, () => fn(jobContext), {
      now,
    });
    succeeded = true;
  } catch (error) {
    businessError = error;
  }

  if (child && started) {
    const terminal = succeeded
      ? buildBackendJobEndEvent({
          name,
          ...(options.queue ? { queue: options.queue } : {}),
          ...(options.jobId ? { jobId: options.jobId } : {}),
          attempt,
          sessionId: effectiveChildSessionId,
          ...(childToken.requestId ? { requestId: childToken.requestId } : {}),
          outcome: "success",
          now: safeNow(options.now),
        })
      : buildBackendJobErrorEvent({
          name,
          ...(options.queue ? { queue: options.queue } : {}),
          ...(options.jobId ? { jobId: options.jobId } : {}),
          attempt,
          sessionId: effectiveChildSessionId,
          ...(childToken.requestId ? { requestId: childToken.requestId } : {}),
          error: businessError,
          now: safeNow(options.now),
        });
    await record(terminal, "terminal");
  }

  await boundedCleanup(
    child,
    options.cleanupTimeoutMs ?? DEFAULT_JOB_CLEANUP_TIMEOUT_MS,
    options,
  );

  if (!succeeded) throw businessError;
  return businessResult as T;
}

function childTokenFor(
  parent: CrumbtrailContextToken | undefined,
  sessionId: string,
  requestId: string | undefined,
  now: number,
): CrumbtrailContextToken {
  if (parent) {
    const parentTrace = parent.traceparent;
    const parsed = parentTrace.match(
      /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/,
    );
    if (parsed) {
      const next = `00-${parsed[1]}-${randomSpanId()}-${parsed[3]}`;
      return Object.freeze({
        v: CRUMBTRAIL_CONTEXT_TOKEN_VERSION,
        sessionId,
        ...(requestId ? { requestId } : {}),
        traceparent: next,
        ...(parent.tracestate ? { tracestate: parent.tracestate } : {}),
        enqueuedAt: now,
        expiresAt: Math.min(
          parent.expiresAt ?? now + DEFAULT_CONTEXT_TOKEN_TTL_MS,
          now + DEFAULT_CONTEXT_TOKEN_TTL_MS,
        ),
      });
    }
  }
  // withCausalContext validates this token. A fresh trace is only used for an
  // unlinked job, where there is no parent carrier to continue.
  const traceId = randomHex(16);
  return Object.freeze({
    v: CRUMBTRAIL_CONTEXT_TOKEN_VERSION,
    sessionId,
    ...(requestId ? { requestId } : {}),
    traceparent: `00-${traceId}-${randomSpanId()}-01`,
    enqueuedAt: now,
    expiresAt: now + DEFAULT_CONTEXT_TOKEN_TTL_MS,
  });
}

function headlessSink(session: HeadlessSession): BackendEventSink {
  return {
    sessionId: session.sessionId,
    record: async (events) =>
      session.record(
        Array.isArray(events)
          ? ([...events] as BugEvent[])
          : (events as BugEvent),
      ),
    end: async () => {
      await session.end();
    },
  };
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = normalizeTimeout(timeoutMs);
  if (timeout === 0) return await promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Crumbtrail job capture operation timed out")),
          timeout,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedCleanup(
  child: BackendEventSink | undefined,
  timeoutMs: number,
  options: CrumbtrailJobOptions,
): Promise<void> {
  if (!child) return;
  let phase: "flush" | "session-end" = "flush";
  try {
    await bounded(
      (async () => {
        await child.flush?.();
        phase = "session-end";
        await child.end?.();
      })(),
      timeoutMs,
    );
  } catch (error) {
    reportLoss(options, error, phase);
  }
}

export async function postSessionLink(input: {
  endpoint: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  input: Parameters<NonNullable<BackendEventSink["linkSessions"]>>[0];
  timeoutMs: number;
}): Promise<void> {
  const fetcher = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== "function")
    throw new Error("No fetch implementation for session link");
  const controller = new AbortController();
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  timer?.unref?.();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (input.authToken) headers["X-Crumbtrail-Auth"] = input.authToken;
    const response = await fetcher(
      `${input.endpoint.replace(/\/+$/, "")}/api/session/link`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(input.input),
        ...(timer ? { signal: controller.signal } : {}),
      },
    );
    if (!response.ok)
      throw new Error(
        `Crumbtrail session link failed with HTTP ${response.status}`,
      );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reportLoss(
  options: CrumbtrailJobOptions,
  error: unknown,
  phase: JobCaptureLossPhase,
): void {
  try {
    options.onCaptureLoss?.(error, phase);
  } catch {
    // Capture diagnostics cannot replace the host's job semantics either.
  }
}

function normalizeAttempt(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value as number)) : 1;
}

function normalizeTimeout(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : DEFAULT_JOB_CLEANUP_TIMEOUT_MS;
}

function safeNow(now: (() => number) | undefined): number {
  try {
    const value = now?.() ?? Date.now();
    return Number.isFinite(value) ? Math.round(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function generateJobSessionId(
  name: string,
  queue: string | undefined,
  jobId: string | undefined,
  now: number,
): string {
  const identity = [queue ?? "", name, jobId ?? ""].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `job_${now.toString(36)}_${(hash >>> 0).toString(36)}_${randomHex(4)}`;
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(values);
  else
    for (let index = 0; index < bytes; index += 1)
      values[index] = Math.floor(Math.random() * 256);
  return [...values]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function randomSpanId(): string {
  let span = randomHex(8);
  if (span === "0".repeat(16)) span = `${span.slice(0, 15)}1`;
  return span;
}
