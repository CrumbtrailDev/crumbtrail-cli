import {
  captureToken,
  DEFAULT_CONTEXT_TOKEN_TTL_MS,
  extractCrumbtrailContext,
  validateCrumbtrailContextToken,
  type CrumbtrailContextToken,
} from "../distributed-context";
import {
  withCrumbtrailJob,
  type CrumbtrailJobContext,
  type CrumbtrailJobOptions,
} from "../jobs";

/**
 * The adapter deliberately describes the small part of BullMQ that it uses.
 * Importing BullMQ types or values here would make it a required dependency of
 * crumbtrail-node. Hosts keep the normal BullMQ package in their own app.
 */
export interface BullMqQueueLike {
  readonly name?: string;
  add?: (...args: any[]) => unknown;
  addBulk?: (...args: any[]) => unknown;
}

export interface BullMqBulkJobInput {
  readonly name: string;
  readonly data: unknown;
  readonly opts?: unknown;
  readonly [key: string]: unknown;
}

export interface BullMqJobLike<TData = unknown> {
  readonly data: TData;
  readonly name: string;
  readonly id?: string | number;
  readonly queueName?: string;
  readonly attemptsMade?: number;
  readonly opts?: {
    readonly jobId?: string | number;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface BullMqContextOptions {
  /** Explicit token wins over ambient context. Invalid tokens fail closed. */
  readonly context?: CrumbtrailContextToken;
  /** Alias for hosts that call their carrier a token. */
  readonly token?: CrumbtrailContextToken;
  /** Clock seam used for token validation and capture. */
  readonly now?: number | (() => number);
  /** Capture failures are reported without changing queue or worker semantics. */
  readonly onCaptureLoss?: (
    error: unknown,
    phase: "context" | "collision",
  ) => void;
}

export interface BullMqProducerOptions extends BullMqContextOptions {
  /** Queue identity used when a Queue instance does not expose `name`. */
  readonly queue?: string;
}

export interface BullMqProcessorOptions extends BullMqContextOptions {
  /** Queue identity used when the job does not expose `queueName`. */
  readonly queue?: string;
  /** Additional options passed to the generic job session. */
  readonly job?: Omit<CrumbtrailJobOptions, "name" | "queue" | "jobId" | "attempt" | "context">;
}

/** Marker that lets the processor distinguish its carrier from user data. */
export const BULLMQ_CONTEXT_ENVELOPE_FIELD = "__crumbtrailEnvelope";

export type BullMqProcessorHandler<
  TJob extends BullMqJobLike = BullMqJobLike,
  TResult = unknown,
> = (job: TJob, context: CrumbtrailJobContext) => TResult | Promise<TResult>;

export type BullMqProcessor<TJob extends BullMqJobLike = BullMqJobLike, TResult = unknown> =
  (job: TJob) => Promise<TResult>;

const PRODUCER_WRAPPERS = new WeakMap<object, BullMqQueueLike>();
const PROCESSOR_WRAPPERS = new WeakMap<object, object>();

/**
 * Add a validated token to a BullMQ data object without mutating the caller's
 * value. BullMQ has no portable message metadata channel, so the token lives
 * under the namespaced `__crumbtrail` field. Non-record payloads are cloned
 * unchanged because changing their JSON shape would change an unwrapped
 * consumer's contract.
 */
export function injectBullMqContext<TData>(
  data: TData,
  token: CrumbtrailContextToken | undefined,
  now: number | (() => number) = Date.now,
  onCaptureLoss?: BullMqContextOptions["onCaptureLoss"],
): TData {
  try {
    const cloned = clonePayload(data);
    if (!token) return cloned;
    const validated = validateCrumbtrailContextToken(token, now);
    if (!validated) {
      reportCaptureLoss(
        { onCaptureLoss },
        "context",
        "BullMQ context token was invalid or expired",
      );
      return cloned;
    }
    if (!isPlainRecord(cloned)) {
      reportCaptureLoss(
        { onCaptureLoss },
        "context",
        "BullMQ context requires a record payload",
      );
      return cloned;
    }
    if (
      Object.prototype.hasOwnProperty.call(cloned, "__crumbtrail") ||
      Object.prototype.hasOwnProperty.call(cloned, "__crumbtrailPayload") ||
      Object.prototype.hasOwnProperty.call(cloned, BULLMQ_CONTEXT_ENVELOPE_FIELD)
    ) {
      reportCaptureLoss(
        { onCaptureLoss },
        "collision",
        "BullMQ data already contains a reserved Crumbtrail field",
      );
      return cloned;
    }
    const carrier: Record<string, unknown> = cloned;
    // `validated` was checked with the adapter's clock above. Revalidating here
    // with Date.now() would make deterministic hosts reject an otherwise valid
    // carrier before it reaches BullMQ.
    carrier.__crumbtrail = validated;
    carrier[BULLMQ_CONTEXT_ENVELOPE_FIELD] = 1;
    return carrier as TData;
  } catch (error) {
    reportCaptureLoss(
      { onCaptureLoss },
      "context",
      `BullMQ context inspection failed: ${String(error)}`,
    );
    return data;
  }
}

/** Read the namespaced token from a BullMQ data payload, failing closed. */
export function extractBullMqContext(
  data: unknown,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  try {
    if (!isBullMqEnvelope(data)) return undefined;
    return extractCrumbtrailContext(data, now);
  } catch {
    return undefined;
  }
}

/** Clone a job payload and remove the adapter field before user code runs. */
export function stripBullMqContext<TData>(
  data: TData,
  now: number | (() => number) = Date.now,
): TData {
  try {
    const cloned = clonePayload(data);
    if (!isPlainRecord(cloned)) return cloned;
    if (!hasBullMqEnvelopeMarker(cloned)) return cloned;
    delete cloned.__crumbtrail;
    delete cloned.__crumbtrailPayload;
    delete cloned[BULLMQ_CONTEXT_ENVELOPE_FIELD];
    return cloned as TData;
  } catch {
    return data;
  }
}

/**
 * Wrap a BullMQ Queue-like object explicitly. The returned proxy preserves the
 * Queue instance and all methods except `add` and `addBulk`, which receive a
 * cloned data object carrying the current causal token.
 */
export function withCrumbtrailBullMqProducer<TQueue extends BullMqQueueLike>(
  queue: TQueue,
  options: BullMqProducerOptions = {},
): TQueue {
  if (!isObject(queue))
    throw new TypeError("withCrumbtrailBullMqProducer requires a BullMQ Queue");
  if (typeof safeGet(queue, "add") !== "function")
    throw new TypeError(
      "withCrumbtrailBullMqProducer requires Queue.add; install BullMQ in the host application",
    );

  const existing = PRODUCER_WRAPPERS.get(queue);
  if (existing) return existing as TQueue;

  const wrapped = new Proxy(queue, {
    get(target, property) {
      if (property === "add") {
        const add = safeGet(target, property);
        if (typeof add !== "function") return add;
        return function crumbtrailBullMqAdd(
          this: unknown,
          ...args: readonly unknown[]
        ): unknown {
          const [name, data, jobOptions] = args;
          let nextData = data;
          try {
            const now = safeGet(options, "now") as
              | number
              | (() => number)
              | undefined;
            const token = resolveToken(options, now);
            nextData = injectBullMqContext(
              data,
              token,
              now,
              safeGet(options, "onCaptureLoss") as BullMqContextOptions["onCaptureLoss"],
            );
          } catch {
            // Queue calls remain authoritative when payload inspection fails.
          }
          return Reflect.apply(add, target, [
            name,
            nextData,
            jobOptions,
          ]);
        };
      }
      if (property === "addBulk") {
        const addBulk = safeGet(target, property);
        if (typeof addBulk !== "function") return addBulk;
        return function crumbtrailBullMqAddBulk(
          this: unknown,
          ...args: readonly unknown[]
        ): unknown {
          const [jobs, ...rest] = args;
          let nextJobs = jobs;
          try {
            const now = safeGet(options, "now") as
              | number
              | (() => number)
              | undefined;
            const token = resolveToken(options, now);
            nextJobs = Array.isArray(jobs)
              ? jobs.map((job) =>
                  cloneBullMqBulkJob(
                    job,
                    token,
                    now,
                    safeGet(options, "onCaptureLoss") as BullMqContextOptions["onCaptureLoss"],
                  ),
                )
              : jobs;
          } catch {
            // Queue calls remain authoritative when batch inspection fails.
          }
          return Reflect.apply(addBulk, target, [nextJobs, ...rest]);
        };
      }
      const value = safeGet(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  PRODUCER_WRAPPERS.set(queue, wrapped);
  PRODUCER_WRAPPERS.set(wrapped, wrapped);
  return wrapped as TQueue;
}

/** Alias that reads naturally at call sites that use `wrap` terminology. */
export const wrapBullMqProducer = withCrumbtrailBullMqProducer;

/**
 * Wrap the processor callback passed to a BullMQ Worker. The adapter strips
 * its carrier, derives queue identity, job id, and attempt from the host job,
 * and delegates all capture setup and cleanup to `withCrumbtrailJob`.
 */
export function withCrumbtrailBullMqProcessor<
  TJob extends BullMqJobLike,
  TResult = unknown,
>(
  handler: BullMqProcessorHandler<TJob, TResult>,
  options: BullMqProcessorOptions = {},
): BullMqProcessor<TJob, TResult> {
  if (typeof handler !== "function")
    throw new TypeError(
      "withCrumbtrailBullMqProcessor requires a BullMQ processor function",
    );
  const existing = PROCESSOR_WRAPPERS.get(handler);
  if (existing) return existing as BullMqProcessor<TJob, TResult>;

  const wrapped = async (job: TJob): Promise<TResult> => {
    if (!job || typeof job !== "object")
      throw new TypeError("BullMQ processor received an invalid job");
    const now = readNow(options.now);
    const jobData = safeGet(job, "data");
    const hasCarrier = isBullMqEnvelope(jobData);
    const extractedToken = hasCarrier
      ? extractBullMqContext(jobData, now)
      : undefined;
    const token = hasCarrier ? extractedToken : resolveToken(options, now);
    const safeJob = cloneJobWithoutContext(job, jobData, now) as TJob;
    const queue =
      safeText(safeGet(options, "queue")) ??
      safeText(safeGet(job, "queueName")) ??
      safeTextFromObject(safeGet(job, "queue")) ??
      undefined;
    const jobId =
      safeText(safeGet(job, "id")) ??
      safeText(safeGet(safeGet(job, "opts"), "jobId")) ??
      undefined;
    const attemptsValue = safeGet(job, "attemptsMade");
    const attemptsMade =
      typeof attemptsValue === "number" && Number.isFinite(attemptsValue)
        ? Math.max(0, Math.round(attemptsValue))
        : 0;

    return await withCrumbtrailJob(
      {
        ...(options.job ?? {}),
        now: options.job?.now ?? (() => now),
        name: safeText(safeGet(job, "name")) ?? "unnamed",
        ...(queue ? { queue } : {}),
        ...(jobId ? { jobId } : {}),
        attempt: attemptsMade + 1,
        context: processorContext(options, hasCarrier, token),
      },
      (context) => handler(safeJob, context),
    );
  };
  PROCESSOR_WRAPPERS.set(handler, wrapped);
  PROCESSOR_WRAPPERS.set(wrapped, wrapped);
  return wrapped;
}

/** Alias that reads naturally at call sites that use `wrap` terminology. */
export const wrapBullMqProcessor = withCrumbtrailBullMqProcessor;

function cloneBullMqBulkJob(
  job: unknown,
  token: CrumbtrailContextToken | undefined,
  now: number | (() => number) | undefined,
  onCaptureLoss?: BullMqContextOptions["onCaptureLoss"],
): unknown {
  try {
    if (!isObject(job) || Array.isArray(job)) return clonePayload(job);
    const cloned = clonePayload(job) as Record<string, unknown>;
    if ("data" in cloned)
      cloned.data = injectBullMqContext(
        safeGet(cloned, "data"),
        token,
        now,
        onCaptureLoss,
      );
    return cloned;
  } catch {
    return job;
  }
}

function cloneJobWithoutContext(
  job: BullMqJobLike,
  sourceData: unknown,
  now: number,
): unknown {
  const data = stripBullMqContext(sourceData, now);
  if (isPlainRecord(job)) {
    try {
      return { ...job, data };
    } catch {
      return job;
    }
  }

  // BullMQ Job is a class with useful methods (retry, progress, and so on).
  // Keep those methods bound to the original instance while shadowing only
  // `data`; cloning the whole instance would remove its prototype and can
  // change retry behavior.
  return new Proxy(job, {
    get(target, property) {
      if (property === "data") return data;
      const value = safeGet(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function resolveToken(
  options: BullMqContextOptions,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  try {
    const candidate =
      (safeGet(options, "context") as CrumbtrailContextToken | undefined) ??
      (safeGet(options, "token") as CrumbtrailContextToken | undefined);
    const at = readNow(now);
    const validated = candidate
      ? validateCrumbtrailContextToken(candidate, at)
      : captureToken({ now: at });
    if (candidate && !validated) {
      reportCaptureLoss(
        options,
        "context",
        "BullMQ context token was invalid or expired",
      );
    }
    if (!validated) return undefined;
    return Object.freeze({
      ...validated,
      enqueuedAt: validated.enqueuedAt ?? at,
      expiresAt: Math.min(
        validated.expiresAt ?? at + DEFAULT_CONTEXT_TOKEN_TTL_MS,
        at + DEFAULT_CONTEXT_TOKEN_TTL_MS,
      ),
    });
  } catch {
    return undefined;
  }
}

function isBullMqEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    hasBullMqEnvelopeMarker(value) &&
    safeHasOwn(value, "__crumbtrail")
  );
}

function hasBullMqEnvelopeMarker(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && safeGet(value, BULLMQ_CONTEXT_ENVELOPE_FIELD) === 1;
}

function processorContext(
  options: BullMqProcessorOptions,
  hasCarrier: boolean,
  token: CrumbtrailContextToken | undefined,
): CrumbtrailContextToken | null | undefined {
  if (hasCarrier || (!token && hasExplicitContext(options))) return token ?? null;
  return token;
}

function hasExplicitContext(options: BullMqContextOptions): boolean {
  return safeGet(options, "context") !== undefined || safeGet(options, "token") !== undefined;
}

function reportCaptureLoss(
  options: Pick<BullMqContextOptions, "onCaptureLoss">,
  phase: "context" | "collision",
  message: string,
): void {
  try {
    options.onCaptureLoss?.(new Error(message), phase);
  } catch {
    // Capture diagnostics must not replace queue semantics.
  }
}

function safeText(value: unknown): string | undefined {
  try {
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      return text ? text.slice(0, 256) : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function safeTextFromObject(value: unknown): string | undefined {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function"))
      return undefined;
    const toString = safeGet(value, "toString");
    return typeof toString === "function"
      ? safeText(Reflect.apply(toString, value, []))
      : undefined;
  } catch {
    return undefined;
  }
}

function readNow(now: number | (() => number) | undefined): number {
  try {
    const value = typeof now === "function" ? now() : (now ?? Date.now());
    return Number.isFinite(value) ? Math.round(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (!isObject(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function clonePayload<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return cloneFallback(value, new WeakMap<object, unknown>()) as T;
  } catch {
    // Some BullMQ payloads contain host functions or hostile accessors. The
    // queue operation remains authoritative when a defensive copy is unsafe.
    return value;
  }
}

function cloneFallback(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior) return prior;
  if (Array.isArray(value)) {
    const array: unknown[] = [];
    seen.set(value, array);
    for (const item of value) array.push(cloneFallback(item, seen));
    return array;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value))
    output[key] = cloneFallback(item, seen);
  return output;
}

function safeGet(target: unknown, property: PropertyKey): unknown {
  if (target === null || (typeof target !== "object" && typeof target !== "function"))
    return undefined;
  try {
    return Reflect.get(target, property, target);
  } catch {
    return undefined;
  }
}

function safeHasOwn(target: unknown, property: PropertyKey): boolean {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function")
  )
    return false;
  try {
    return Object.prototype.hasOwnProperty.call(target, property);
  } catch {
    return false;
  }
}
