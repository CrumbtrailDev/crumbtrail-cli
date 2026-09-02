import type { BugEvent } from "crumbtrail-core";
import {
  buildCacheEvent,
  type BuildCacheEventInput,
  type CacheDriver,
  type CacheOperationSummary,
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
const BATCH_INSTRUMENTED = Symbol.for("crumbtrail.cache.batch.instrumented");

const MAX_BATCH_OPERATIONS = 100;
const MAX_BATCH_KEYS = 50;
const MAX_BATCH_FAILURES = 100;

interface OperationCapture {
  op: string;
  keys: unknown[];
  value?: unknown;
  ttlMs?: number;
  hit?: (result: unknown) => boolean;
  resultValue?: boolean;
  ttlMsFromResult?: (result: unknown) => number | undefined;
}

interface BatchCapture {
  mode: "pipeline" | "transaction";
  operationCount: number;
  operations: string[];
  keys: unknown[];
}

interface BatchCommand {
  operation: string;
  args: readonly unknown[];
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
      if (operationName === "multi" || operationName === "pipeline") {
        const wrapped = (...args: unknown[]) => {
          const result = Reflect.apply(original, target, args);
          return wrapBatchResult(
            result,
            driver,
            operationName === "multi" ? "transaction" : "pipeline",
            options,
            constructorBatchCommands(args),
          );
        };
        wrappers.set(property, wrapped);
        return wrapped;
      }
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
        return result.then(
          (value: unknown) => {
            emitSafely(options, {
              driver,
              op: capture.op,
              keys: capture.keys,
              requestId,
              ...(capture.hit ? { hit: capture.hit(value) } : {}),
              ...ttlInput(capture, value),
              ...(capture.resultValue
                ? { value }
                : capture.value !== undefined
                  ? { value: capture.value }
                  : {}),
            });
            return value;
          },
          (error: unknown) => {
            emitSafely(options, {
              driver,
              op: capture.op,
              keys: capture.keys,
              requestId,
              outcome: "failure",
              error,
            });
            throw error;
          },
        );
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
  "hget",
  "hmget",
  "hset",
  "hdel",
  "getdel",
  "incr",
  "decr",
  "expire",
  "persist",
  "ttl",
]);

const BATCH_EXECUTION_OPERATIONS = new Set([
  "exec",
  "execaspipeline",
  "execbuffer",
]);

function normalizeMethod(method: string): string {
  return method.replace(/_/g, "").toLowerCase();
}

function ttlInput(
  capture: OperationCapture,
  result: unknown,
): { ttlMs?: number } {
  const ttlMs = capture.ttlMsFromResult?.(result) ?? capture.ttlMs;
  return ttlMs !== undefined ? { ttlMs } : {};
}

function wrapBatchResult(
  result: unknown,
  driver: CacheDriver,
  mode: BatchCapture["mode"],
  options: InstrumentCacheClientOptions,
  initialCommands: readonly BatchCommand[] = [],
): unknown {
  if (isThenable(result)) {
    return result.then(
      (batch: unknown) =>
        wrapBatch(batch, driver, mode, options, initialCommands),
      (error: unknown) => {
        const requestId = resolveRequestId(options);
        if (requestId) {
          emitSafely(options, {
            driver,
            op: mode,
            keys: [],
            requestId,
            outcome: "failure",
            error,
            summary: emptyBatchSummary(),
          });
        }
        throw error;
      },
    );
  }
  return wrapBatch(result, driver, mode, options, initialCommands);
}

function wrapBatch(
  value: unknown,
  driver: CacheDriver,
  mode: BatchCapture["mode"],
  options: InstrumentCacheClientOptions,
  initialCommands: readonly BatchCommand[] = [],
): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  const target = value as DuckTypedCacheClient;
  if (isBatchInstrumented(target)) return target;
  const capture: BatchCapture = {
    mode,
    operationCount: 0,
    operations: [],
    keys: [],
  };
  for (const command of initialCommands) {
    recordBatchOperation(capture, command.operation, command.args);
  }
  const wrappers = new Map<PropertyKey, unknown>();
  let proxy: DuckTypedCacheClient;
  proxy = new Proxy(target, {
    get(batchTarget, property, receiver) {
      if (property === BATCH_INSTRUMENTED) return true;
      const original = Reflect.get(batchTarget, property, receiver);
      if (typeof property !== "string" || typeof original !== "function") {
        return original;
      }
      if (wrappers.has(property)) return wrappers.get(property);
      const operationName = normalizeMethod(property);
      if (BATCH_EXECUTION_OPERATIONS.has(operationName)) {
        const wrapped = (...args: unknown[]) => {
          const execution = Reflect.apply(original, batchTarget, args);
          const requestId = resolveRequestId(options);
          if (!requestId || !isThenable(execution)) return execution;
          return execution.then(
            (resolved: unknown) => {
              const inspection = inspectBatchResult(driver, resolved);
              emitSafely(options, {
                driver,
                op: capture.mode,
                keys: capture.keys,
                requestId,
                ...(inspection.aborted
                  ? { outcome: "aborted" as const }
                  : inspection.failureCount > 0
                    ? { outcome: "failure" as const }
                    : {}),
                summary: batchSummary(capture, inspection),
              });
              return resolved;
            },
            (error: unknown) => {
              emitSafely(options, {
                driver,
                op: capture.mode,
                keys: capture.keys,
                requestId,
                outcome: "failure",
                error,
                summary: batchSummary(capture),
              });
              throw error;
            },
          );
        };
        wrappers.set(property, wrapped);
        return wrapped;
      }
      const wrapped = (...args: unknown[]) => {
        const commandResult = Reflect.apply(original, batchTarget, args);
        recordBatchOperation(capture, operationName, args);
        return commandResult === batchTarget ? proxy : commandResult;
      };
      wrappers.set(property, wrapped);
      return wrapped;
    },
  });
  return proxy;
}

function recordBatchOperation(
  capture: BatchCapture,
  operation: string,
  args: readonly unknown[],
): void {
  capture.operationCount += 1;
  if (capture.operations.length < MAX_BATCH_OPERATIONS) {
    capture.operations.push(operation.slice(0, 64));
  }
  const shaped = batchKeysForOperation(operation, args);
  for (const key of shaped) {
    if (capture.keys.length >= MAX_BATCH_KEYS) break;
    capture.keys.push(key);
  }
}

function constructorBatchCommands(args: readonly unknown[]): BatchCommand[] {
  const supplied = args[0];
  if (!Array.isArray(supplied) || supplied.length === 0) return [];
  const commands =
    Array.isArray(supplied[0]) || isRecord(supplied[0]) ? supplied : [supplied];
  const parsed: BatchCommand[] = [];
  for (const command of commands) {
    if (Array.isArray(command)) {
      const [name, ...commandArgs] = command;
      if (typeof name === "string") {
        parsed.push({ operation: normalizeMethod(name), args: commandArgs });
      }
      continue;
    }
    if (!isRecord(command)) continue;
    const name = command.name ?? command.command;
    const commandArgs = command.args;
    if (typeof name === "string" && Array.isArray(commandArgs)) {
      parsed.push({
        operation: normalizeMethod(name),
        args: commandArgs,
      });
    }
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function batchKeysForOperation(
  operation: string,
  args: readonly unknown[],
): readonly unknown[] {
  // Generic methods such as addCommand/sendCommand carry command arguments in
  // objects or arrays. Only the same allowlisted shapes used by direct capture
  // may contribute keys, so generic batch commands remain operation-only.
  if (!SUPPORTED_OPERATIONS.has(operation)) return [];
  return describeOperation(operation, args)?.keys ?? [];
}

function inspectBatchResult(
  driver: CacheDriver,
  result: unknown,
): { failureCount: number; failureCountTruncated: boolean; aborted: boolean } {
  if (driver !== "ioredis") {
    return { failureCount: 0, failureCountTruncated: false, aborted: false };
  }
  if (result === null) {
    return { failureCount: 0, failureCountTruncated: false, aborted: true };
  }
  if (!Array.isArray(result)) {
    return { failureCount: 0, failureCountTruncated: false, aborted: false };
  }
  let failureCount = 0;
  let failureCountTruncated = false;
  // Scan every tuple to detect failures after the reporting cap. Only the
  // count is bounded, never the inspection needed to classify the batch.
  for (const tuple of result) {
    if (!Array.isArray(tuple) || tuple.length === 0 || tuple[0] == null) {
      continue;
    }
    if (failureCount < MAX_BATCH_FAILURES) failureCount += 1;
    else failureCountTruncated = true;
  }
  return { failureCount, failureCountTruncated, aborted: false };
}

function batchSummary(
  capture: BatchCapture,
  result: Pick<
    ReturnType<typeof inspectBatchResult>,
    "failureCount" | "failureCountTruncated"
  > = { failureCount: 0, failureCountTruncated: false },
): CacheOperationSummary {
  return {
    operationCount: capture.operationCount,
    operations: [...capture.operations],
    ...(result.failureCount > 0 ? { failureCount: result.failureCount } : {}),
    ...(result.failureCountTruncated ? { failureCountTruncated: true } : {}),
    ...(capture.operations.length < capture.operationCount
      ? { truncated: true }
      : {}),
  };
}

function emptyBatchSummary(): CacheOperationSummary {
  return { operationCount: 0, operations: [] };
}

function resolveRequestId(
  options: InstrumentCacheClientOptions,
): string | undefined {
  try {
    return options.requestId ?? options.getRequestId?.();
  } catch {
    return undefined;
  }
}

function isBatchInstrumented(value: DuckTypedCacheClient): boolean {
  try {
    return value[BATCH_INSTRUMENTED as unknown as string] === true;
  } catch {
    return false;
  }
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
  if (op === "hget") {
    return {
      op,
      keys: [args[0]],
      hit: (result) => result !== null && result !== undefined,
    };
  }
  if (op === "hmget") {
    return {
      op,
      keys: [args[0]],
      hit: (result) =>
        Array.isArray(result) &&
        result.some((entry) => entry !== null && entry !== undefined),
    };
  }
  if (op === "hset") {
    // Hash field names carry the redaction signal for their values. The cache
    // event has no field-aware value schema, so omit hash values entirely rather
    // than risk exposing a password field or serializing a Buffer as raw bytes.
    return {
      op,
      keys: [args[0]],
    };
  }
  if (op === "hdel") {
    return {
      op,
      keys: [args[0]],
      hit: (result) => typeof result === "number" && result > 0,
    };
  }
  if (op === "getdel") {
    return {
      op,
      keys: [args[0]],
      hit: (result) => result !== null && result !== undefined,
      resultValue: true,
    };
  }
  if (op === "incr" || op === "decr") {
    return {
      op,
      keys: [args[0]],
      resultValue: true,
    };
  }
  if (op === "expire") {
    const seconds = finiteNonNegative(args[1]);
    return {
      op,
      keys: [args[0]],
      hit: changedOutcome,
      ...(seconds !== undefined ? { ttlMs: seconds * 1_000 } : {}),
    };
  }
  if (op === "persist") {
    return {
      op,
      keys: [args[0]],
      hit: changedOutcome,
    };
  }
  if (op === "ttl") {
    return {
      op,
      keys: [args[0]],
      hit: (result) => typeof result === "number" && result >= -1,
      resultValue: true,
      ttlMsFromResult: (result) =>
        typeof result === "number" && Number.isFinite(result) && result >= 0
          ? result * 1_000
          : undefined,
    };
  }
  return undefined;
}

function changedOutcome(result: unknown): boolean {
  return result === true || (typeof result === "number" && result > 0);
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
