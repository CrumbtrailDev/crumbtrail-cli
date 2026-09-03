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
}

/** Read the namespaced token from a BullMQ data payload, failing closed. */
export function extractBullMqContext(
  data: unknown,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  if (!isBullMqEnvelope(data)) return undefined;
  return extractCrumbtrailContext(data, now);
}

/** Clone a job payload and remove the adapter field before user code runs. */
export function stripBullMqContext<TData>(
  data: TData,
  now: number | (() => number) = Date.now,
): TData {
  const cloned = clonePayload(data);
  if (!isPlainRecord(cloned)) return cloned;
  const token = extractBullMqContext(cloned, now);
  if (!token) return cloned;
  delete cloned.__crumbtrail;
  delete cloned[BULLMQ_CONTEXT_ENVELOPE_FIELD];
  return cloned as TData;
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
  if (typeof queue.add !== "function")
    throw new TypeError(
      "withCrumbtrailBullMqProducer requires Queue.add; install BullMQ in the host application",
    );

  const existing = PRODUCER_WRAPPERS.get(queue);
  if (existing) return existing as TQueue;

  const wrapped = new Proxy(queue, {
    get(target, property, receiver) {
      if (property === "add") {
        const add = Reflect.get(target, property, receiver);
        if (typeof add !== "function") return add;
        return function crumbtrailBullMqAdd(
          this: unknown,
          ...args: readonly unknown[]
        ): unknown {
          const [name, data, jobOptions] = args;
          const token = resolveToken(options);
          const nextData = injectBullMqContext(
            data,
            token,
            options.now,
            options.onCaptureLoss,
          );
          return Reflect.apply(add, this === undefined ? target : this, [
            name,
            nextData,
            jobOptions,
          ]);
        };
      }
      if (property === "addBulk") {
        const addBulk = Reflect.get(target, property, receiver);
        if (typeof addBulk !== "function") return addBulk;
        return function crumbtrailBullMqAddBulk(
          this: unknown,
          ...args: readonly unknown[]
        ): unknown {
          const [jobs, ...rest] = args;
          const token = resolveToken(options);
          const nextJobs = Array.isArray(jobs)
            ? jobs.map((job) =>
                cloneBullMqBulkJob(
                  job,
                  token,
                  options.now,
                  options.onCaptureLoss,
                ),
              )
            : jobs;
          return Reflect.apply(
            addBulk,
            this === undefined ? target : this,
            [nextJobs, ...rest],
          );
        };
      }
      return Reflect.get(target, property, receiver);
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
    const token =
      extractBullMqContext(job.data, now) ?? resolveToken(options, now);
    const safeJob = cloneJobWithoutContext(job, now) as TJob;
    const queue =
      options.queue ??
      safeText(job.queueName) ??
      safeText((job as Record<string, unknown>).queue?.toString?.()) ??
      undefined;
    const jobId =
      safeText(job.id) ?? safeText(job.opts?.jobId) ?? undefined;
    const attemptsMade =
      typeof job.attemptsMade === "number" && Number.isFinite(job.attemptsMade)
        ? Math.max(0, Math.round(job.attemptsMade))
        : 0;

    return await withCrumbtrailJob(
      {
        ...(options.job ?? {}),
        now: options.job?.now ?? (() => now),
        name: safeText(job.name) ?? "unnamed",
        ...(queue ? { queue } : {}),
        ...(jobId ? { jobId } : {}),
        attempt: attemptsMade + 1,
        ...(token ? { context: token } : {}),
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
  if (!isObject(job) || Array.isArray(job)) return clonePayload(job);
  const cloned = clonePayload(job) as Record<string, unknown>;
  if ("data" in cloned)
    cloned.data = injectBullMqContext(cloned.data, token, now, onCaptureLoss);
  return cloned;
}

function cloneJobWithoutContext(job: BullMqJobLike, now: number): unknown {
  const data = stripBullMqContext(job.data, now);
  if (isPlainRecord(job)) return { ...job, data };

  // BullMQ Job is a class with useful methods (retry, progress, and so on).
  // Keep those methods bound to the original instance while shadowing only
  // `data`; cloning the whole instance would remove its prototype and can
  // change retry behavior.
  return new Proxy(job, {
    get(target, property) {
      if (property === "data") return data;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function resolveToken(
  options: BullMqContextOptions,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  const candidate = options.context ?? options.token;
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
}

function isBullMqEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    value[BULLMQ_CONTEXT_ENVELOPE_FIELD] === 1 &&
    Object.prototype.hasOwnProperty.call(value, "__crumbtrail")
  );
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
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text ? text.slice(0, 256) : undefined;
  }
  return undefined;
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
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePayload<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Some BullMQ payloads contain host functions. Fall through to a
      // bounded structural copy instead of making instrumentation reject add.
    }
  }
  return cloneFallback(value, new WeakMap<object, unknown>()) as T;
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
