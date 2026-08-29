import {
  classifyStatement,
  ensureReturning,
  leadingSqlKeyword,
  looksLikePotentialWrite,
  parseLimitOffset,
  type ParsedMutation,
  type ParsedRead,
} from "./sql";
import {
  emitGap,
  emitDbDiffEvents,
  emitDbErrorEvent,
  emitDbReadEvents,
  emitDbStatementEvent,
  emitImagelessDbDiff,
  isRecord,
  nextStatementSeq,
  type InstrumentDbClientOptions,
  type ReadCallsitesByRequest,
} from "./instrument-shared";

export type DuckTypedNeonHttpQuery = ((...args: unknown[]) => unknown) & {
  query?: (sql: string, params?: unknown[], options?: unknown) => unknown;
  transaction?: unknown;
};

interface RequestCounters {
  emittedReadRowsByRequest: Map<string, number>;
  readCallsitesByRequest: ReadCallsitesByRequest;
  readStatementsByRequest: Map<string, number>;
  statementsByRequest: Map<string, number>;
}

const ENGINE = "postgres" as const;
const INSTRUMENTED = Symbol.for("crumbtrail.db.neonHttpInstrumented");

function newCounters(): RequestCounters {
  return {
    emittedReadRowsByRequest: new Map(),
    readCallsitesByRequest: new Map(),
    readStatementsByRequest: new Map(),
    statementsByRequest: new Map(),
  };
}

function isInstrumented(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[INSTRUMENTED] === true
  );
}

function isTaggedTemplateCall(args: readonly unknown[]): boolean {
  const first = args[0] as { raw?: unknown } | undefined;
  return Array.isArray(first) && Array.isArray(first.raw);
}

function isPlainBindValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const type = typeof value;
  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "bigint"
  ) {
    return true;
  }
  if (value instanceof Date || value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return value.every(isPlainBindValue);
  return false;
}

function plannedTextFor(args: readonly unknown[]): string | undefined {
  if (!isTaggedTemplateCall(args)) return undefined;
  const strings = args[0] as readonly string[];
  const values = args.slice(1);
  if (!values.every(isPlainBindValue)) return undefined;
  let text = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    text += `$${index + 1}${strings[index + 1] ?? ""}`;
  }
  return text;
}

function rewrittenTemplateArgs(
  args: readonly unknown[],
  rewrittenText: string,
  originalText: string,
): unknown[] {
  const strings = [...(args[0] as readonly string[])] as string[] & {
    raw?: string[];
  };
  const suffix = rewrittenText.slice(originalText.length);
  strings[strings.length - 1] = `${strings[strings.length - 1] ?? ""}${suffix}`;
  strings.raw = [...strings];
  return [strings, ...args.slice(1)];
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
  const rows =
    isRecord(result) && Array.isArray(result.rows) ? result.rows : result;
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

function resultRowCount(result: unknown): number | null {
  if (
    isRecord(result) &&
    typeof result.rowCount === "number" &&
    Number.isFinite(result.rowCount)
  ) {
    return result.rowCount;
  }
  return Array.isArray(result) ? result.length : null;
}

function preserveQueryMetadata(
  source: unknown,
  target: Promise<unknown>,
): void {
  if (!source || (typeof source !== "object" && typeof source !== "function")) {
    return;
  }
  for (const key of Reflect.ownKeys(source)) {
    if (key in target) continue;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor) Object.defineProperty(target, key, descriptor);
    } catch {
      // Query metadata is an optimization for Neon transaction composition.
    }
  }
}

function runCaptured(
  text: string,
  invoke: (statement: string) => unknown,
  options: InstrumentDbClientOptions,
  counters: RequestCounters,
): unknown {
  let parsed: ParsedMutation | undefined;
  let parsedRead: ParsedRead | undefined;
  let requestId: string | undefined;
  try {
    const classification = classifyStatement(text);
    if (classification.kind === "unparsable" && classification.mayMutate) {
      emitGap(options, {
        reason: "unparsed_sql",
        detail: leadingSqlKeyword(text),
      });
    }
    parsed =
      classification.kind === "mutation" ? classification.mutation : undefined;
    parsedRead =
      classification.kind === "read" ? classification.read : undefined;
    requestId = options.requestId ?? options.getRequestId?.();
  } catch (error) {
    emitGap(options, { reason: "capture_exception", error });
    return invoke(text);
  }
  if (!requestId) return invoke(text);

  let executedText = text;
  if (parsed) {
    try {
      executedText = ensureReturning(text);
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
    }
  }

  let hostResult: unknown;
  try {
    hostResult = invoke(executedText);
  } catch (error) {
    emitDbErrorEvent({
      engine: ENGINE,
      op: parsed?.op ?? (parsedRead ? "select" : "other"),
      table: parsed?.table ?? parsedRead?.table ?? null,
      statement: text,
      requestId,
      error,
      options,
    });
    throw error;
  }

  const observed = Promise.resolve(hostResult).then(
    (result) => {
      emitDbStatementEvent({
        engine: ENGINE,
        op: parsed?.op ?? (parsedRead ? "select" : "other"),
        table: parsed?.table ?? parsedRead?.table ?? null,
        statement: text,
        rowCount: resultRowCount(result),
        seq: nextStatementSeq(counters.statementsByRequest, requestId),
        requestId,
        options,
      });
      try {
        const rows = resultRows(result);
        const rowCount = resultRowCount(result) ?? rows.length;
        if (parsed && rowCount > 0) {
          if (rows.length > 0) {
            emitDbDiffEvents({
              engine: ENGINE,
              op: parsed.op,
              table: parsed.table,
              requestId,
              rows,
              rowCount,
              options,
            });
          } else {
            emitImagelessDbDiff({
              engine: ENGINE,
              op: parsed.op,
              table: parsed.table,
              requestId,
              rowCount,
              options,
            });
          }
        } else if (options.captureReads && parsedRead) {
          emitDbReadEvents({
            engine: ENGINE,
            table: parsedRead.table,
            requestId,
            rows,
            rowCount,
            options,
            emittedReadRowsByRequest: counters.emittedReadRowsByRequest,
            readCallsitesByRequest: counters.readCallsitesByRequest,
            readStatementsByRequest: counters.readStatementsByRequest,
            queryShape: parseLimitOffset(text),
            statement: text,
          });
        }
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
      }
      return result;
    },
    (error) => {
      emitDbErrorEvent({
        engine: ENGINE,
        op: parsed?.op ?? (parsedRead ? "select" : "other"),
        table: parsed?.table ?? parsedRead?.table ?? null,
        statement: text,
        requestId,
        error,
        options,
      });
      throw error;
    },
  );
  preserveQueryMetadata(hostResult, observed);
  return observed;
}

/** Wraps the callable returned by Neon's HTTP `neon()` factory. */
export function instrumentNeonHttpQuery<T>(
  query: T,
  options: InstrumentDbClientOptions,
): T {
  if (typeof query !== "function" || isInstrumented(query)) return query;
  const sql = query as unknown as DuckTypedNeonHttpQuery;
  const counters = newCounters();

  return new Proxy(sql, {
    apply(target, thisArg, args) {
      const text = plannedTextFor(args);
      if (!text) {
        try {
          const staticText = isTaggedTemplateCall(args)
            ? (args[0] as readonly string[]).join(" ")
            : "";
          if (
            looksLikePotentialWrite(staticText) &&
            (options.requestId ?? options.getRequestId?.())
          ) {
            emitGap(options, {
              reason: "unparsed_sql",
              detail: leadingSqlKeyword(staticText),
            });
          }
        } catch {
          // Capture cannot decide whether Neon constructs the host query.
        }
        return Reflect.apply(target, thisArg, args);
      }
      return runCaptured(
        text,
        (statement) =>
          Reflect.apply(
            target,
            thisArg,
            statement === text
              ? args
              : rewrittenTemplateArgs(args, statement, text),
          ),
        options,
        counters,
      );
    },
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true;
      if (prop === "query" && typeof target.query === "function") {
        return (text: string, params?: unknown[], queryOptions?: unknown) =>
          typeof text === "string"
            ? runCaptured(
                text,
                (statement) => target.query!(statement, params, queryOptions),
                options,
                counters,
              )
            : target.query!(text, params, queryOptions);
      }
      if (prop === "transaction" && typeof target.transaction === "function") {
        return (...args: unknown[]) => {
          const next = [...args];
          if (typeof next[0] === "function") {
            const fn = next[0] as (tx: DuckTypedNeonHttpQuery) => unknown;
            next[0] = (tx: DuckTypedNeonHttpQuery) =>
              fn(instrumentNeonHttpQuery(tx, options));
          }
          return (
            target.transaction as (...values: unknown[]) => unknown
          ).apply(target, next);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as T;
}
