import type { BugEvent } from "crumbtrail-core";
import {
  buildCacheEvent,
  type BuildCacheEventInput,
  type CacheDriver,
} from "./event";

export interface DuckTypedCacheClient {
  [method: string]: unknown;
}

export interface InstrumentCacheClientOptions {
  requestId?: string;
  getRequestId?: () => string | undefined;
  sessionId?: string;
  emit: (event: BugEvent) => void;
  now?: () => number;
  sessionStartedAt?: number | Date;
}

const INSTRUMENTED = Symbol.for("crumbtrail.cache.instrumented");

interface OperationCapture {
  op: string;
  keys: unknown[];
  value?: unknown;
  ttlMs?: number;
  hit?: (result: unknown) => boolean;
  resultValue?: boolean;
}

export function instrumentIoredisClient<T extends DuckTypedCacheClient>(
  client: T,
  options: InstrumentCacheClientOptions,
): T {
  return instrumentCacheClient(client, "ioredis", options);
}

export function instrumentNodeRedisClient<T extends DuckTypedCacheClient>(
  client: T,
  options: InstrumentCacheClientOptions,
): T {
  return instrumentCacheClient(client, "redis", options);
}

function instrumentCacheClient<T extends DuckTypedCacheClient>(
  client: T,
  driver: CacheDriver,
  options: InstrumentCacheClientOptions,
): T {
  if (!client || typeof client !== "object" || isInstrumented(client)) {
    return client;
  }
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === INSTRUMENTED) return true;
      const original = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof original !== "function") {
        return original;
      }
      if (wrappers.has(property)) return wrappers.get(property);
      const operationName = normalizeMethod(property);
      if (!SUPPORTED_OPERATIONS.has(operationName)) {
        const bound = original.bind(target);
        wrappers.set(property, bound);
        return bound;
      }
      const wrapped = (...args: unknown[]) => {
        const result = Reflect.apply(original, target, args);
        let requestId: string | undefined;
        let capture: OperationCapture | undefined;
        try {
          requestId = options.requestId ?? options.getRequestId?.();
          capture = describeOperation(operationName, args);
        } catch {
          return result;
        }
        if (!requestId || !capture || !isThenable(result)) return result;
        return result.then((value: unknown) => {
          emitSafely(options, {
            driver,
            op: capture.op,
            keys: capture.keys,
            requestId,
            ...(capture.hit ? { hit: capture.hit(value) } : {}),
            ...(capture.ttlMs !== undefined ? { ttlMs: capture.ttlMs } : {}),
            ...(capture.resultValue ? { value } : capture.value !== undefined ? { value: capture.value } : {}),
          });
          return value;
        });
      };
      wrappers.set(property, wrapped);
      return wrapped;
    },
  });
}

const SUPPORTED_OPERATIONS = new Set([
  "get",
  "getbuffer",
  "getex",
  "mget",
  "set",
  "setex",
  "psetex",
  "del",
  "unlink",
]);

function normalizeMethod(method: string): string {
  return method.replace(/_/g, "").toLowerCase();
}

function describeOperation(
  op: string,
  args: readonly unknown[],
): OperationCapture | undefined {
  if (op === "get" || op === "getbuffer" || op === "getex") {
    const ttlMs = op === "getex" ? ttlFromOptions(args[1]) : undefined;
    return {
      op,
      keys: [args[0]],
      hit: (result) => result !== null && result !== undefined,
      resultValue: true,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    };
  }
  if (op === "mget") {
    const keys = Array.isArray(args[0]) ? [...args[0]] : [...args];
    return {
      op,
      keys,
      hit: (result) =>
        Array.isArray(result) &&
        result.some((entry) => entry !== null && entry !== undefined),
      resultValue: true,
    };
  }
  if (op === "set") {
    const ttlMs = ttlFromSetArgs(args);
    return {
      op,
      keys: [args[0]],
      value: args[1],
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    };
  }
  if (op === "setex" || op === "psetex") {
    const amount = finiteNonNegative(args[1]);
    return {
      op,
      keys: [args[0]],
      value: args[2],
      ...(amount !== undefined
        ? { ttlMs: op === "setex" ? amount * 1_000 : amount }
        : {}),
    };
  }
  if (op === "del" || op === "unlink") {
    const keys = Array.isArray(args[0]) ? [...args[0]] : [...args];
    return {
      op,
      keys,
      hit: (result) => typeof result === "number" && result > 0,
    };
  }
  return undefined;
}

function ttlFromSetArgs(args: readonly unknown[]): number | undefined {
  const objectTtl = ttlFromOptions(args[2]);
  if (objectTtl !== undefined) return objectTtl;
  for (let index = 2; index < args.length - 1; index += 1) {
    const token = String(args[index]).toUpperCase();
    const amount = finiteNonNegative(args[index + 1]);
    if (amount === undefined) continue;
    if (token === "EX") return amount * 1_000;
    if (token === "PX") return amount;
  }
  return undefined;
}

function ttlFromOptions(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const options = value as Record<string, unknown>;
  const seconds = finiteNonNegative(options.EX ?? options.ex);
  if (seconds !== undefined) return seconds * 1_000;
  return finiteNonNegative(options.PX ?? options.px);
}

function finiteNonNegative(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function emitSafely(
  options: InstrumentCacheClientOptions,
  input: Omit<BuildCacheEventInput, "sessionId" | "now" | "sessionStartedAt">,
): void {
  try {
    options.emit(
      buildCacheEvent({
        ...input,
        sessionId: options.sessionId,
        now: options.now?.(),
        sessionStartedAt: options.sessionStartedAt,
      }),
    );
  } catch {
    // Instrumentation cannot fail a host cache operation.
  }
}

function isInstrumented(client: DuckTypedCacheClient): boolean {
  try {
    return client[INSTRUMENTED as unknown as string] === true;
  } catch {
    return false;
  }
}
