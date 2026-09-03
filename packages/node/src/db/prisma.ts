import type { DbBeforeImageStatus, DbDiffOp, DbErrorOp } from "crumbtrail-core";
import {
  classifyStatement,
  leadingSqlKeyword,
  type StatementClassification,
} from "./sql";
import {
  emitDbDiffEvents,
  emitDbErrorEvent,
  emitDbReadEvents,
  emitDbStatementEvent,
  emitGap,
  emitImagelessDbDiff,
  isRecord,
  nextStatementSeq,
  suppressRaceEvidence,
  type InstrumentDbClientOptions,
  type ReadCallsitesByRequest,
} from "./instrument-shared";
import { captureGenerationFor } from "../capture-generation";

const ENGINE = "prisma" as const;
const instrumentedClients = new WeakMap<object, object>();

export interface DuckTypedPrismaQueryInput {
  model?: unknown;
  operation?: unknown;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

export interface DuckTypedPrismaExtension {
  name: string;
  query: {
    $allOperations(input: DuckTypedPrismaQueryInput): Promise<unknown>;
  };
}

/** Minimal supported Prisma Client surface. The host supplies Prisma, so it remains optional. */
export interface DuckTypedPrismaClient {
  $extends(extension: DuckTypedPrismaExtension): unknown;
}

interface RequestCounters {
  emittedReadRowsByRequest: Map<string, number>;
  readCallsitesByRequest: ReadCallsitesByRequest;
  readStatementsByRequest: Map<string, number>;
  statementsByRequest: Map<string, number>;
}

const MODEL_READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findRaw",
]);

const MODEL_MUTATION_OPERATIONS: Readonly<
  Record<string, { op: DbDiffOp; bulk: boolean }>
> = {
  create: { op: "insert", bulk: false },
  createMany: { op: "insert", bulk: true },
  createManyAndReturn: { op: "insert", bulk: true },
  update: { op: "update", bulk: false },
  updateMany: { op: "update", bulk: true },
  updateManyAndReturn: { op: "update", bulk: true },
  upsert: { op: "upsert", bulk: false },
  delete: { op: "delete", bulk: false },
  deleteMany: { op: "delete", bulk: true },
};

/**
 * Adds the supported Prisma Client query extension and returns Prisma's extended client.
 * Extension setup and every capture path are contained so instrumentation never changes whether
 * the host query runs, what it returns, or which error object it throws.
 */
export function instrumentPrismaClient<T extends DuckTypedPrismaClient>(
  client: T,
  options: InstrumentDbClientOptions,
): T {
  if (!isObjectLike(client)) return client;
  const existing = instrumentedClients.get(client);
  if (existing) return existing as T;
  // Prisma query extensions do not expose transaction commit or rollback outcome.
  // Keep diffs useful, but never present them as committed race evidence.
  const captureOptions = suppressRaceEvidence(options);

  const counters: RequestCounters = {
    emittedReadRowsByRequest: new Map(),
    readCallsitesByRequest: new Map(),
    readStatementsByRequest: new Map(),
    statementsByRequest: new Map(),
  };

  try {
    const extended = client.$extends({
      name: "crumbtrail-database-capture",
      query: {
        $allOperations: (input) =>
          observePrismaOperation(input, captureOptions, counters),
      },
    });
    if (!isObjectLike(extended)) return client;
    instrumentedClients.set(client, extended);
    instrumentedClients.set(extended, extended);
    return extended as T;
  } catch (error) {
    emitGap(options, { reason: "uninstrumented_client", error });
    return client;
  }
}

async function observePrismaOperation(
  input: DuckTypedPrismaQueryInput,
  options: InstrumentDbClientOptions,
  counters: RequestCounters,
): Promise<unknown> {
  const operationOptions = captureGenerationFor(options);
  let requestId: string | undefined;
  try {
    requestId = operationOptions.requestId ?? operationOptions.getRequestId?.();
  } catch (error) {
    emitGap(operationOptions, { reason: "capture_exception", error });
    return input.query(input.args);
  }
  if (!requestId) return input.query(input.args);

  const operation =
    typeof input.operation === "string" ? input.operation : "unknown";
  const model = typeof input.model === "string" ? input.model : undefined;
  const rawStatement = model ? undefined : rawStatementFrom(input.args);
  let classification: StatementClassification | undefined;
  if (rawStatement) {
    try {
      classification = classifyStatement(rawStatement);
      if (classification.kind === "unparsable" && classification.mayMutate) {
        emitGap(operationOptions, {
          reason: "unparsed_sql",
          detail: leadingSqlKeyword(rawStatement),
        });
      }
    } catch (error) {
      emitGap(operationOptions, { reason: "capture_exception", error });
    }
  }

  let result: unknown;
  try {
    result = await input.query(input.args);
  } catch (error) {
    if (rawStatement) {
      const raw = rawOperation(classification);
      emitDbErrorEvent({
        engine: ENGINE,
        op: raw.op,
        table: raw.table,
        statement: rawStatement,
        statementParams: rawParamsFrom(input.args),
        requestId,
        error,
        options: operationOptions,
      });
    }
    throw error;
  }

  try {
    if (model) {
      captureModelResult({
        model,
        operation,
        args: input.args,
        result,
        requestId,
        options: operationOptions,
        counters,
      });
    } else if (rawStatement) {
      captureRawResult({
        statement: rawStatement,
        classification,
        result,
        requestId,
        options: operationOptions,
        counters,
      });
    }
  } catch (error) {
    emitGap(operationOptions, { reason: "capture_exception", error });
  }
  return result;
}

function captureModelResult(input: {
  model: string;
  operation: string;
  args: unknown;
  result: unknown;
  requestId: string;
  options: InstrumentDbClientOptions;
  counters: RequestCounters;
}): void {
  const mutation = MODEL_MUTATION_OPERATIONS[input.operation];
  if (!mutation) {
    if (
      !MODEL_READ_OPERATIONS.has(input.operation) ||
      !input.options.captureReads
    )
      return;
    const rows = rowsFromResult(input.result);
    emitDbReadEvents({
      engine: ENGINE,
      table: input.model,
      requestId: input.requestId,
      rows,
      rowCount: rows.length,
      options: input.options,
      emittedReadRowsByRequest: input.counters.emittedReadRowsByRequest,
      readCallsitesByRequest: input.counters.readCallsitesByRequest,
      readStatementsByRequest: input.counters.readStatementsByRequest,
    });
    return;
  }

  const rows = modelRowsFromResult(input.result, mutation.bulk);
  const rowCount =
    rows.length > 0 ? rows.length : resultRowCount(input.result, rows);
  if (rows.length > 0) {
    emitDbDiffEvents({
      engine: ENGINE,
      op: mutation.op,
      table: input.model,
      requestId: input.requestId,
      rows,
      rowCount,
      bulk: mutation.bulk,
      beforeImageStatus: modelBeforeImageStatus(
        input.operation,
        input.args,
        false,
      ),
      options: input.options,
    });
    return;
  }

  if (rowCount > 0) {
    emitImagelessDbDiff({
      engine: ENGINE,
      op: mutation.op,
      table: input.model,
      requestId: input.requestId,
      rowCount,
      beforeImageStatus: modelBeforeImageStatus(
        input.operation,
        input.args,
        mutation.bulk,
      ),
      options: input.options,
    });
  }
}

function captureRawResult(input: {
  statement: string;
  classification?: StatementClassification;
  result: unknown;
  requestId: string;
  options: InstrumentDbClientOptions;
  counters: RequestCounters;
}): void {
  const rows = rowsFromResult(input.result);
  const rowCount = resultRowCount(input.result, rows);
  const raw = rawOperation(input.classification);
  emitDbStatementEvent({
    engine: ENGINE,
    op: raw.op,
    table: raw.table,
    statement: input.statement,
    rowCount,
    seq: nextStatementSeq(input.counters.statementsByRequest, input.requestId),
    requestId: input.requestId,
    options: input.options,
  });

  if (input.classification?.kind === "mutation") {
    const mutation = input.classification.mutation;
    if (rows.length > 0) {
      emitDbDiffEvents({
        engine: ENGINE,
        op: mutation.op,
        table: mutation.table,
        requestId: input.requestId,
        rows,
        rowCount,
        beforeImageStatus:
          mutation.op === "update"
            ? unavailable("prisma_extension_no_transaction_context")
            : mutation.op === "delete" && !returnsAllColumns(input.statement)
              ? { status: "partial", reason: "prisma_raw_result_selection" }
              : undefined,
        options: input.options,
      });
    } else if (rowCount > 0) {
      emitImagelessDbDiff({
        engine: ENGINE,
        op: mutation.op,
        table: mutation.table,
        requestId: input.requestId,
        rowCount,
        beforeImageStatus:
          mutation.op === "insert"
            ? undefined
            : unavailable("prisma_raw_result_no_row_images"),
        options: input.options,
      });
    }
    return;
  }

  if (
    input.options.captureReads &&
    input.classification?.kind === "read" &&
    rows.length > 0
  ) {
    emitDbReadEvents({
      engine: ENGINE,
      table: input.classification.read.table,
      requestId: input.requestId,
      rows,
      rowCount,
      options: input.options,
      emittedReadRowsByRequest: input.counters.emittedReadRowsByRequest,
      readCallsitesByRequest: input.counters.readCallsitesByRequest,
      readStatementsByRequest: input.counters.readStatementsByRequest,
      statement: input.statement,
    });
  }
}

function modelBeforeImageStatus(
  operation: string,
  args: unknown,
  bulkWithoutRows: boolean,
): DbBeforeImageStatus | undefined {
  if (operation === "delete" && hasSelection(args)) {
    return { status: "partial", reason: "prisma_result_selection" };
  }
  if (operation === "update" || operation === "updateManyAndReturn") {
    return unavailable("prisma_extension_no_transaction_context");
  }
  if (operation === "upsert") {
    return unavailable("prisma_upsert_branch_unknown");
  }
  if (
    bulkWithoutRows &&
    (operation === "updateMany" || operation === "deleteMany")
  ) {
    return unavailable("prisma_bulk_result_no_row_images");
  }
  return undefined;
}

function unavailable(
  reason: Extract<DbBeforeImageStatus, { status: "unavailable" }>["reason"],
): DbBeforeImageStatus {
  return { status: "unavailable", reason };
}

function rawOperation(classification?: StatementClassification): {
  op: DbErrorOp;
  table: string | null;
} {
  if (classification?.kind === "mutation") {
    return {
      op: classification.mutation.op,
      table: classification.mutation.table,
    };
  }
  if (classification?.kind === "read") {
    return { op: "select", table: classification.read.table };
  }
  return { op: "other", table: null };
}

function rawStatementFrom(args: unknown): string | undefined {
  if (!Array.isArray(args) || args.length === 0) return undefined;
  const first = args[0];
  if (typeof first === "string") return first;
  if (!isRecord(first)) return undefined;
  if (typeof first.sql === "string") return first.sql;
  if (typeof first.text === "string") return first.text;
  const strings = first.strings;
  if (
    Array.isArray(strings) &&
    strings.every((value) => typeof value === "string")
  ) {
    return strings.join("?");
  }
  return undefined;
}

function rawParamsFrom(args: unknown): unknown {
  try {
    if (!Array.isArray(args) || args.length === 0) return undefined;
    const first = args[0];
    if (typeof first === "string") return args.slice(1);
    if (!isRecord(first)) return args.slice(1);
    if (Array.isArray(first.values)) return first.values;
    if (Array.isArray(first.params)) return first.params;
    if (
      Array.isArray(first.strings) &&
      first.strings.every((value) => typeof value === "string")
    )
      return args.slice(1);
  } catch {
    return undefined;
  }
  return undefined;
}

function rowsFromResult(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result.filter(isRecord);
  return isRecord(result) ? [result] : [];
}

function modelRowsFromResult(
  result: unknown,
  bulk: boolean,
): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result.filter(isRecord);
  return !bulk && isRecord(result) ? [result] : [];
}

function resultRowCount(
  result: unknown,
  rows: Array<Record<string, unknown>>,
): number {
  if (typeof result === "number" && Number.isFinite(result)) {
    return Math.max(0, Math.round(result));
  }
  if (
    isRecord(result) &&
    typeof result.count === "number" &&
    Number.isFinite(result.count)
  ) {
    return Math.max(0, Math.round(result.count));
  }
  return rows.length;
}

function hasSelection(args: unknown): boolean {
  return isRecord(args) && (isRecord(args.select) || isRecord(args.omit));
}

function returnsAllColumns(statement: string): boolean {
  return /\breturning\s+(?:[A-Za-z_$][\w$]*\.)?\*/i.test(statement);
}

function isObjectLike(value: unknown): value is object {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}
