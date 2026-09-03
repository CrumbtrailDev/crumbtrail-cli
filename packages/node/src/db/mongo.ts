import type { DbDiffOp, DbStatementOp } from "crumbtrail-core";
import { boundColumnRow, buildDbDiffEvent } from "./diff-event";
import {
  emitDbDiffEvents,
  emitDbErrorEvent,
  emitDbEvent,
  emitDbReadEvents,
  emitDbStatementEvent,
  isRecord,
  nextStatementSeq,
  suppressRaceEvidence,
  type InstrumentDbClientOptions,
  type ReadCallsitesByRequest,
} from "./instrument-shared";
import { captureGenerationFor } from "../capture-generation";

const ENGINE = "mongodb" as const;
const INSTRUMENTED_CLIENTS = new WeakSet<object>();

export const MONGO_DOCUMENT_BOUNDS = {
  maxDepth: 8,
  maxContainerEntries: 100,
} as const;

export const MONGO_IMAGE_UNAVAILABLE = {
  updateBefore: "MongoDB update commands do not return a pre-image",
  updateAfter: "MongoDB update commands do not return a post-image",
  deleteBefore: "MongoDB delete commands do not return deleted documents",
  returnedBefore:
    "findAndModify returned the pre-image selected by returnDocument",
  returnedAfter:
    "findAndModify returned the post-image selected by returnDocument",
  projectedBefore:
    "findAndModify projection returned only part of the pre-image",
  projectedAfter:
    "findAndModify projection returned only part of the post-image",
} as const;

export interface DuckTypedMongoClient {
  on(event: string, listener: (event: unknown) => void): unknown;
}

interface PendingCommand {
  commandName: string;
  command: Record<string, unknown>;
  requestId: string;
  table: string | null;
  options: InstrumentDbClientOptions;
}

interface MongoCounters {
  emittedReadRowsByRequest: Map<string, number>;
  readCallsitesByRequest: ReadCallsitesByRequest;
  readStatementsByRequest: Map<string, number>;
  statementsByRequest: Map<string, number>;
}

/**
 * Returns MongoClient constructor arguments with command monitoring enabled, without mutating the
 * host's options object. The official driver only emits command events when this flag is true.
 */
export function enableMongoCommandMonitoring(
  args: readonly unknown[],
): unknown[] {
  const next = [...args];
  const existing = isRecord(next[1]) ? next[1] : {};
  next[1] = { ...existing, monitorCommands: true };
  return next;
}

/**
 * Observes the official MongoDB driver's command monitoring events. The client must have been
 * constructed with `monitorCommands: true`; auto-instrumentation does that before attaching these
 * listeners. Every listener is contained so capture can never throw into a driver call.
 */
export function instrumentMongoClient<T extends DuckTypedMongoClient>(
  client: T,
  options: InstrumentDbClientOptions,
): T {
  if (!client || typeof client !== "object" || INSTRUMENTED_CLIENTS.has(client))
    return client;
  // Command monitoring does not expose transaction commit or rollback outcome.
  // Keep database diffs, but never present them as committed race evidence.
  const captureOptions = suppressRaceEvidence(options);

  const pending = new Map<string, PendingCommand>();
  const counters: MongoCounters = {
    emittedReadRowsByRequest: new Map(),
    readCallsitesByRequest: new Map(),
    readStatementsByRequest: new Map(),
    statementsByRequest: new Map(),
  };

  try {
    client.on("commandStarted", (raw) => {
      try {
        const event = isRecord(raw) ? raw : undefined;
        const command =
          event && isRecord(event.command) ? event.command : undefined;
        const commandName = normalizedCommandName(event?.commandName);
        const key = commandKey(event?.requestId);
        const requestId =
          captureOptions.requestId ?? captureOptions.getRequestId?.();
        if (!command || !commandName || !key || !requestId) return;
        const operationOptions = captureGenerationFor(captureOptions);
        pending.set(key, {
          commandName,
          command,
          requestId,
          table: commandTable(commandName, command),
          options: operationOptions,
        });
      } catch {
        // Command observation must never affect the host operation.
      }
    });

    client.on("commandSucceeded", (raw) => {
      try {
        const event = isRecord(raw) ? raw : undefined;
        const key = commandKey(event?.requestId);
        const started = key ? pending.get(key) : undefined;
        if (key) pending.delete(key);
        if (!started) return;
        handleSucceeded(
          started,
          isRecord(event?.reply) ? event.reply : {},
          started.options,
          counters,
        );
      } catch {
        // Command observation must never affect the host operation.
      }
    });

    client.on("commandFailed", (raw) => {
      try {
        const event = isRecord(raw) ? raw : undefined;
        const key = commandKey(event?.requestId);
        const started = key ? pending.get(key) : undefined;
        if (key) pending.delete(key);
        if (!started) return;
        emitDbErrorEvent({
          engine: ENGINE,
          op: statementOp(started.commandName, started.command),
          table: started.table,
          statement: mongoStatement(started.commandName),
          requestId: started.requestId,
          error: event?.failure ?? event,
          options: started.options,
        });
      } catch {
        // Command observation must never affect the host operation.
      }
    });

    INSTRUMENTED_CLIENTS.add(client);
  } catch {
    // An unexpected or frozen EventEmitter shape is unsupported, not fatal.
  }
  return client;
}

function handleSucceeded(
  started: PendingCommand,
  reply: Record<string, unknown>,
  options: InstrumentDbClientOptions,
  counters: MongoCounters,
): void {
  const { commandName, command, requestId, table } = started;
  const rowCount = mongoRowCount(commandName, command, reply);
  emitDbStatementEvent({
    engine: ENGINE,
    op: statementOp(commandName, command),
    table,
    statement: mongoStatement(commandName),
    rowCount,
    seq: nextStatementSeq(counters.statementsByRequest, requestId),
    requestId,
    options,
  });

  if (!table) return;
  if (commandName === "insert") {
    const documents = arrayRecords(command.documents).map(boundMongoDocument);
    if (documents.length > 0) {
      emitDbDiffEvents({
        engine: ENGINE,
        op: "insert",
        table,
        requestId,
        rows: documents,
        rowCount: rowCount ?? documents.length,
        options: mongoPkOptions(options, table),
        valueBounds: MONGO_DOCUMENT_BOUNDS,
      });
    }
    return;
  }

  if (commandName === "update" || commandName === "delete") {
    if ((rowCount ?? 0) > 0) {
      emitPartialMutation(
        commandName,
        table,
        command,
        reply,
        rowCount as number,
        requestId,
        options,
      );
    }
    return;
  }

  if (commandName === "findandmodify") {
    emitFindAndModify(table, command, reply, requestId, options);
    return;
  }

  if (options.captureReads && isReadCommand(commandName)) {
    const rows = cursorBatch(reply).map(boundMongoDocument);
    if (rows.length === 0) return;
    emitDbReadEvents({
      engine: ENGINE,
      table,
      requestId,
      rows,
      rowCount: rows.length,
      options: mongoPkOptions(options, table),
      emittedReadRowsByRequest: counters.emittedReadRowsByRequest,
      readCallsitesByRequest: counters.readCallsitesByRequest,
      readStatementsByRequest: counters.readStatementsByRequest,
      statement: mongoStatement(commandName),
      valueBounds: MONGO_DOCUMENT_BOUNDS,
    });
  }
}

function emitPartialMutation(
  commandName: "update" | "delete",
  table: string,
  command: Record<string, unknown>,
  reply: Record<string, unknown>,
  rowCount: number,
  requestId: string,
  options: InstrumentDbClientOptions,
): void {
  const specs = arrayRecords(
    command[commandName === "update" ? "updates" : "deletes"],
  );
  const exactPk = specs.length === 1 ? pkFromFilter(specs[0]?.q) : null;
  const upsertPk =
    commandName === "update" ? pkFromUpsert(reply.upserted) : null;
  emitDbEvent(
    options,
    buildDbDiffEvent({
      engine: ENGINE,
      op: commandName,
      table,
      pk: upsertPk ?? exactPk,
      rowCount,
      requestId,
      primaryKeyColumns: ["_id"],
      imageUnavailable:
        commandName === "update"
          ? {
              before: MONGO_IMAGE_UNAVAILABLE.updateBefore,
              after: MONGO_IMAGE_UNAVAILABLE.updateAfter,
            }
          : { before: MONGO_IMAGE_UNAVAILABLE.deleteBefore },
      sessionId: options.sessionId,
      redactColumns: options.redactColumns,
      now: options.now?.(),
      sessionStartedAt: options.sessionStartedAt,
      valueBounds: MONGO_DOCUMENT_BOUNDS,
    }),
  );
}

function emitFindAndModify(
  table: string,
  command: Record<string, unknown>,
  reply: Record<string, unknown>,
  requestId: string,
  options: InstrumentDbClientOptions,
): void {
  const row = isRecord(reply.value)
    ? boundMongoDocument(reply.value)
    : undefined;
  const pk =
    row && "_id" in row ? { _id: row._id } : pkFromFilter(command.query);
  const isDelete = command.remove === true;
  const returnsAfter = command.new === true;
  const projected = isRecord(command.fields);
  const changed = numeric(reply.lastErrorObject, "n") ?? (row ? 1 : 0);
  if (changed <= 0) return;

  const op: DbDiffOp = isDelete ? "delete" : "update";
  emitDbEvent(
    options,
    buildDbDiffEvent({
      engine: ENGINE,
      op,
      table,
      pk,
      requestId,
      primaryKeyColumns: ["_id"],
      ...(row && (isDelete || !returnsAfter) ? { before: row } : {}),
      ...(row && !isDelete && returnsAfter ? { after: row } : {}),
      ...(!row
        ? {
            imageUnavailable: isDelete
              ? { before: MONGO_IMAGE_UNAVAILABLE.deleteBefore }
              : {
                  before: MONGO_IMAGE_UNAVAILABLE.updateBefore,
                  after: MONGO_IMAGE_UNAVAILABLE.updateAfter,
                },
          }
        : isDelete
          ? projected
            ? {
                imageUnavailable: {
                  before: MONGO_IMAGE_UNAVAILABLE.projectedBefore,
                },
              }
            : {}
          : {
              imageUnavailable: returnsAfter
                ? {
                    before: MONGO_IMAGE_UNAVAILABLE.returnedAfter,
                    ...(projected
                      ? { after: MONGO_IMAGE_UNAVAILABLE.projectedAfter }
                      : {}),
                  }
                : {
                    after: MONGO_IMAGE_UNAVAILABLE.returnedBefore,
                    ...(projected
                      ? { before: MONGO_IMAGE_UNAVAILABLE.projectedBefore }
                      : {}),
                  },
            }),
      sessionId: options.sessionId,
      redactColumns: options.redactColumns,
      now: options.now?.(),
      sessionStartedAt: options.sessionStartedAt,
      valueBounds: MONGO_DOCUMENT_BOUNDS,
    }),
  );
}

function mongoPkOptions(
  options: InstrumentDbClientOptions,
  table: string,
): InstrumentDbClientOptions {
  return {
    ...options,
    pkColumns: { ...options.pkColumns, [table]: ["_id"] },
  };
}

function pkFromFilter(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !("_id" in value)) return null;
  const id = value._id;
  if (isRecord(id) && Object.keys(id).some((key) => key.startsWith("$")))
    return null;
  return { _id: id };
}

function pkFromUpsert(value: unknown): Record<string, unknown> | null {
  const [first] = arrayRecords(value);
  return first && "_id" in first ? { _id: first._id } : null;
}

function cursorBatch(
  reply: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (!isRecord(reply.cursor)) return [];
  return arrayRecords(reply.cursor.firstBatch ?? reply.cursor.nextBatch);
}

function commandTable(
  commandName: string,
  command: Record<string, unknown>,
): string | null {
  const key =
    commandName === "findandmodify"
      ? "findAndModify"
      : commandName === "getmore"
        ? "collection"
        : commandName;
  const value = command[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isReadCommand(commandName: string): boolean {
  return (
    commandName === "find" ||
    commandName === "getmore" ||
    commandName === "aggregate"
  );
}

function statementOp(
  commandName: string,
  command?: Record<string, unknown>,
): DbStatementOp {
  if (commandName === "insert") return "insert";
  if (commandName === "findandmodify" && command?.remove === true)
    return "delete";
  if (commandName === "update" || commandName === "findandmodify")
    return "update";
  if (commandName === "delete") return "delete";
  if (isReadCommand(commandName)) return "select";
  return "other";
}

function mongoStatement(commandName: string): string {
  return `mongodb.${commandName}`;
}

function mongoRowCount(
  commandName: string,
  command: Record<string, unknown>,
  reply: Record<string, unknown>,
): number | null {
  if (isReadCommand(commandName)) return cursorBatch(reply).length;
  return (
    numeric(reply, "n") ??
    (commandName === "insert" ? arrayRecords(command.documents).length : null)
  );
}

function numeric(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const number = value[key];
  return typeof number === "number" && Number.isFinite(number)
    ? Math.max(0, Math.round(number))
    : undefined;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function boundMongoDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  return boundColumnRow(document, MONGO_DOCUMENT_BOUNDS) ?? {};
}

function normalizedCommandName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.toLowerCase()
    : undefined;
}

function commandKey(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string"
    ? String(value)
    : undefined;
}
