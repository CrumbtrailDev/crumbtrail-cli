import type { BugEvent } from "crumbtrail-core";

export const DEFAULT_BACKEND_INTAKE_ENDPOINT = "http://localhost:9898";

const MAX_SAFE_STRING_LENGTH = 200;
const MAX_WARNING_MESSAGE_LENGTH = 300;

export type BackendIntakeWarningKind =
  | "missing-session"
  | "missing-fetch"
  | "fetch-rejected"
  | "http-error"
  | "malformed-response"
  | "queue-overflow";

export interface BackendIntakeWarning {
  kind: BackendIntakeWarningKind;
  message: string;
  status?: number;
  sessionId?: string;
  requestId?: string;
  eventKind?: string;
  /** Delivery attempts made before giving up. Absent when the first try settled it. */
  attempts?: number;
  /** Running total of events discarded because the queue was full. */
  dropped?: number;
  /** Transport-level cause when the runtime reports one, e.g. `ECONNRESET`. */
  cause?: string;
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
 * Simultaneous POSTs to the intake. The transport, not the intake, is the limit:
 * a burst of application requests each spawning an unpooled POST exhausts
 * sockets and the runtime rejects the surplus with a bare `TypeError`. Retrying
 * alone does not prevent that, because each retry competes for the same
 * exhausted transport; capping concurrency is what stops the burst forming.
 * Measured on a 1,100-request run against a healthy local intake: 51 events
 * lost, roughly 5%, taking the deciding value of one defect with them.
 */
const MAX_CONCURRENT_INTAKE_REQUESTS = 4;

/**
 * Events held while the in-flight slots are busy. Bounded because an intake that
 * is down or wedged must cost the host application a fixed amount of memory, not
 * an unbounded one — capture may never be the reason a process dies.
 */
const MAX_QUEUED_EVENTS = 1_000;

/** Events coalesced into one POST. The intake route already accepts an array. */
const MAX_EVENTS_PER_BATCH = 64;

/** Overflow warnings are coalesced to this cadence so a drop storm is one line. */
const OVERFLOW_WARNING_EVERY = 256;

interface IntakeTarget {
  url: string;
  headers: HeadersInitLike;
  sessionId: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
  attempts: number;
  retryDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

interface QueuedEvent {
  event: BugEvent;
  warningContext: {
    sessionId?: string;
    requestId?: string;
    eventKind?: string;
  };
  onWarning: SendBackendEventOptions["onWarning"];
  settle: (delivered: boolean) => void;
}

interface Queue {
  target: IntakeTarget;
  entries: QueuedEvent[];
}

const queues = new Map<string, Queue>();
let inFlight = 0;
let queuedCount = 0;
let droppedCount = 0;
let idleWaiters: Array<() => void> = [];

/**
 * Hands an event to the intake, coalescing and retrying only when it has to.
 *
 * With capacity free and nothing queued this posts the single event immediately,
 * exactly as it always did — the returned promise still resolves once the intake
 * has answered, so a caller that awaits one send sees one request and learns
 * whether it landed. The queue only engages when a burst has already saturated
 * {@link MAX_CONCURRENT_INTAKE_REQUESTS}, at which point events coalesce into
 * batches rather than each opening a socket.
 *
 * Nothing is discarded silently: a transient failure is retried, a permanent one
 * is reported, and an overflow is reported with a running count.
 *
 * Resolves to whether the event actually reached the capture endpoint, so a
 * caller that owns a request lifecycle can record a gap when it did not.
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
      // Names both halves of the cause, because either one alone is fixable:
      // the request carried no correlation, AND the process has no session of
      // its own to fall back to. The old sentence said only that an id was
      // missing, which left the reader with nothing to act on.
      message:
        "Backend event was not sent because no session ID was available. " +
        "Nothing correlated it (no x-crumbtrail-session-id header) and this " +
        "process has no capture session of its own. Install autoCapture, or " +
        "check that its session handshake succeeded.",
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

  const target: IntakeTarget = {
    url: `${endpoint}/api/events`,
    headers,
    sessionId,
    fetchImpl,
    signal: options.signal,
    attempts: Math.max(0, normalizeRetries(options.retries)) + 1,
    retryDelayMs: normalizeRetryDelay(options.retryDelayMs),
    sleep: options.sleep ?? defaultSleep,
  };

  if (queuedCount >= MAX_QUEUED_EVENTS) {
    droppedCount += 1;
    if (droppedCount === 1 || droppedCount % OVERFLOW_WARNING_EVERY === 0) {
      reportWarning(options.onWarning, {
        kind: "queue-overflow",
        message: `Backend intake queue is full at ${MAX_QUEUED_EVENTS} events; newest events are being discarded.`,
        dropped: droppedCount,
        ...warningContext,
      });
    }
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const key = queueKey(target, authToken);
    const queue = queues.get(key) ?? { target, entries: [] };
    if (!queues.has(key)) queues.set(key, queue);
    queue.entries.push({
      event,
      warningContext,
      onWarning: options.onWarning,
      settle: resolve,
    });
    queuedCount += 1;
    pump();
  });
}

export const postBackendEvent = sendBackendEvent;

/**
 * Resolves once every queued and in-flight event has been delivered or reported.
 *
 * A job, a CLI or a test that finishes immediately after its last capture would
 * otherwise exit with the tail still buffered.
 */
export async function flushBackendEvents(): Promise<void> {
  if (queuedCount === 0 && inFlight === 0) return;
  await new Promise<void>((resolve) => idleWaiters.push(resolve));
}

/** Queue depth, in-flight requests and lifetime drops. For tests and diagnostics. */
export function backendIntakeQueueStats(): {
  queued: number;
  inFlight: number;
  dropped: number;
} {
  return { queued: queuedCount, inFlight, dropped: droppedCount };
}

/** Clears shared queue state. Tests only — never call this from a live process. */
export function resetBackendIntakeQueueForTest(): void {
  queues.clear();
  inFlight = 0;
  queuedCount = 0;
  droppedCount = 0;
  idleWaiters = [];
  defaultConsoleLines.clear();
}

/**
 * Batched events share one envelope, so only same-session, same-credential,
 * same-endpoint events may travel together. JSON encoding keeps the three parts
 * unambiguous no matter what characters a URL, session ID or token contains.
 */
function queueKey(target: IntakeTarget, authToken: string | undefined): string {
  return JSON.stringify([target.url, target.sessionId, authToken ?? ""]);
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
    (timer as { unref?: () => void }).unref?.();
  });
}

function pump(): void {
  while (inFlight < MAX_CONCURRENT_INTAKE_REQUESTS) {
    const batch = takeBatch();
    if (!batch) break;
    inFlight += 1;
    // deliver() reports its own failures; this catch only guarantees that a
    // defect inside the queue itself can never surface as an unhandled rejection
    // in the host application, and that its entries still settle.
    void deliver(batch.queue.target, batch.entries)
      .catch(() => false)
      .then((delivered) => {
        inFlight -= 1;
        for (const entry of batch.entries) entry.settle(delivered);
        if (queuedCount > 0) pump();
        else if (inFlight === 0) releaseIdleWaiters();
      });
  }
}

function takeBatch(): { queue: Queue; entries: QueuedEvent[] } | undefined {
  for (const [key, queue] of queues) {
    if (queue.entries.length === 0) {
      queues.delete(key);
      continue;
    }
    const entries = queue.entries.splice(0, MAX_EVENTS_PER_BATCH);
    queuedCount -= entries.length;
    if (queue.entries.length === 0) queues.delete(key);
    return { queue, entries };
  }
  return undefined;
}

function releaseIdleWaiters(): void {
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const waiter of waiters) waiter();
}

async function deliver(
  target: IntakeTarget,
  entries: QueuedEvent[],
): Promise<boolean> {
  const body = JSON.stringify({
    sessionId: target.sessionId,
    events: entries.map((entry) => entry.event),
  });

  for (let attempt = 1; attempt <= target.attempts; attempt += 1) {
    const outcome = await attemptDelivery(target, body);
    if (outcome.ok) return true;
    if (!outcome.retryable || attempt === target.attempts) {
      // Only worth saying when it took more than one try; a single attempt is
      // the unremarkable case and the field would be noise on every warning.
      reportBatchWarning(entries, {
        ...outcome.warning,
        ...(attempt > 1 ? { attempts: attempt } : {}),
      });
      return false;
    }
    await target.sleep(target.retryDelayMs * attempt);
  }

  return false;
}

interface DeliveryOutcome {
  ok: boolean;
  retryable: boolean;
  warning: Omit<BackendIntakeWarning, "attempts">;
}

const DELIVERED: DeliveryOutcome = {
  ok: true,
  retryable: false,
  warning: { kind: "http-error", message: "" },
};

async function attemptDelivery(
  target: IntakeTarget,
  body: string,
): Promise<DeliveryOutcome> {
  try {
    const response = await target.fetchImpl(target.url, {
      method: "POST",
      headers: target.headers,
      body,
      signal: target.signal,
    });

    if (!response.ok) {
      const status = safeStatus(response.status);
      // The server wrote the sentence that explains this refusal (a revoked
      // key, a payload over the cap, a paused project). A bare status left an
      // operator guessing at a cause the response body was holding, and the
      // browser SDK had already taught the console line to carry it.
      const reason = await readRefusalReason(response);
      return {
        ok: false,
        // A status is the endpoint's own answer about this payload, so sending
        // the identical body again cannot change the verdict.
        retryable: false,
        warning: {
          kind: "http-error",
          message:
            `The capture endpoint refused backend events with HTTP ${status ?? "error"}` +
            `${reason ? `: ${reason}` : ""}; nothing from this session will be captured`,
          ...(status !== undefined ? { status } : {}),
        },
      };
    }

    await readAndValidateResponse(response);
    return DELIVERED;
  } catch (error) {
    const kind = classifyCaughtError(error);
    const cause = safeErrorCause(error);
    const abort = isAbortError(error);
    return {
      ok: false,
      // A malformed response still arrived, and an abort was asked for; neither
      // gets better by asking again. A transport rejection usually does.
      retryable: kind === "fetch-rejected" && !abort,
      warning: {
        kind,
        message:
          kind === "fetch-rejected" && !abort
            ? `Backend events could not reach the capture endpoint` +
              `${cause ? ` (${cause})` : ""}; nothing was captured`
            : safeErrorMessage(error),
        ...(cause ? { cause } : {}),
      },
    };
  }
}

/**
 * The server's own explanation of a refusal.
 *
 * Ingest read the `error`/`message`/`detail` fields off the JSON body, exactly
 * like the browser transport's `readRefusalMessage`; a body that is not JSON
 * (or has none of those fields) contributes no reason. The raw text is
 * deliberately NOT read: a refusal body can carry a secret, and echoing it
 * whole would leak what the refusal was protecting.
 */
async function readRefusalReason(
  response: ResponseLike,
): Promise<string | undefined> {
  if (typeof response.json !== "function") return undefined;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  for (const key of ["error", "message", "detail"]) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function reportBatchWarning(
  entries: QueuedEvent[],
  warning: BackendIntakeWarning,
): void {
  for (const entry of entries) {
    reportWarning(entry.onWarning, { ...warning, ...entry.warningContext });
  }
}

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

/**
 * One default console line per distinct refusal condition, process lifetime.
 *
 * A revoked key makes every event 401; without this a ``[crumbtrail]`` line
 * would narrate each one of them. Keyed by condition so one refusal is said
 * once, and a different refusal (a new status, a recovery failure) still gets
 * its own line.
 */
const defaultConsoleLines = new Set<string>();

function reportWarning(
  onWarning: SendBackendEventOptions["onWarning"],
  warning: BackendIntakeWarning,
): void {
  const surfaced = removeUndefined({
    kind: warning.kind,
    message:
      boundString(warning.message, MAX_WARNING_MESSAGE_LENGTH) ??
      "Backend intake warning.",
    status: warning.status,
    sessionId: safeString(warning.sessionId),
    requestId: safeString(warning.requestId),
    eventKind: safeString(warning.eventKind),
    attempts: warning.attempts,
    dropped: warning.dropped,
    cause: safeString(warning.cause),
  });

  // A wired callback owns surfacing: skipping it would silence a sink the
  // integrator chose, and printing the default line on top would duplicate it.
  if (onWarning) {
    try {
      onWarning(surfaced);
    } catch {
      // Warning callbacks must never affect the host application response path.
    }
    return;
  }

  // No callback wired. A refusal the server explained must still reach the
  // operator, the way the browser SDK's default console line does. The
  // queue-overflow warning is exempt from the once-per-condition dedup because
  // it already reports at its own drop-storm cadence; a dedup key would silence
  // its later counts.
  if (warning.kind === "queue-overflow") {
    emitDefaultConsole(surfaced.message);
    return;
  }
  const key = defaultConsoleKey(surfaced);
  if (defaultConsoleLines.has(key)) return;
  defaultConsoleLines.add(key);
  emitDefaultConsole(surfaced.message);
}

/** Once-per-condition key for the default console line. */
function defaultConsoleKey(warning: BackendIntakeWarning): string {
  if (warning.kind === "http-error") {
    return `http:${warning.status ?? "unknown"}`;
  }
  return warning.kind;
}

function emitDefaultConsole(message: string): void {
  try {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(`[crumbtrail] ${message}`);
    }
  } catch {
    // A replaced console must not take the host application down with it.
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

/**
 * The transport's own reason, when the runtime attaches one.
 *
 * Node's fetch reports every transport failure as `TypeError` and hangs the real
 * reason off `cause` — `ECONNRESET`, `UND_ERR_SOCKET`, `ECONNREFUSED`,
 * `ENOTFOUND`. Without it an operator reading a warning log sees the same word
 * for "intake is down", "DNS is wrong" and "we opened too many sockets". Only
 * the short code is taken: a cause `message` can carry a URL, so it is not.
 */
function safeErrorCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (!isRecord(cause)) return undefined;
  const code = cause.code ?? (cause as { name?: unknown }).name;
  if (typeof code !== "string") return undefined;
  return boundString(code.trim(), 64);
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
