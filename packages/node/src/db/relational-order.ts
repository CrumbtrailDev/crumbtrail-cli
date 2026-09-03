import { createHmac } from "node:crypto";
import {
  DB_RELATIONAL_ORDER_EVENT_KIND,
  type BugEvent,
  type DbDiffOp,
  type DbEngine,
  type DbRelationalConstraintTiming,
  type DbRelationalOrderContract,
  type DbRelationalOrderEventData,
  type DbRelationalOrderOp,
  type DbRelationalOrderRole,
} from "crumbtrail-core";

export const RELATIONAL_ORDER_CONTRACT_VERSION = 1 as const;
export const DEFAULT_MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST = 64;
export const MAX_RELATIONAL_ORDER_DECLARATIONS = 32;
export const MAX_RELATIONAL_ORDER_COLUMNS = 8;
export const MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST = 128;

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_TRANSACTION_ID_LENGTH = 256;
const MAX_RELATIONAL_ORDER_SEQUENCE = 0x7fffffff;
const MAX_RELATIONAL_ORDER_STATEMENT_LENGTH = 64 * 1024;
const MAX_RELATIONAL_ORDER_INSERT_ROWS = 16;
const MAX_CANONICAL_DEPTH = 4;
const MAX_CANONICAL_ENTRIES = 32;
const MAX_CANONICAL_BYTES = 16 * 1024;
const RELATION_DOMAIN = "crumbtrail/relational-order/relation/v1";
const VALUE_DOMAIN = "crumbtrail/relational-order/value/v1";

export interface DbRelationalOrderDeclaration {
  /** Stable application-owned identity for this declaration, never emitted. */
  relationId: string;
  parent: {
    table: string;
    columns: readonly string[];
  };
  child: {
    table: string;
    columns: readonly string[];
  };
  childNullable: readonly boolean[];
  constraintTiming: DbRelationalConstraintTiming;
  deferrable: boolean;
}

export interface RelationalOrderCaptureOptions {
  /** Application secret used only as the HMAC key. It is never placed in an event. */
  key: string | Uint8Array;
  /** Explicit relation declarations. No schema is inferred from captured rows. */
  declarations: readonly DbRelationalOrderDeclaration[];
  /** Per-request event bound. Defaults to 64 and is capped at 128. */
  maxEventsPerRequest?: number;
}

interface NormalizedDeclaration {
  relationIdentity: string;
  parentTable: string;
  parentColumns: string[];
  childTable: string;
  childColumns: string[];
  contract: DbRelationalOrderContract;
}

interface RelationalState {
  key: Buffer;
  declarations: NormalizedDeclaration[];
  maxEventsPerRequest: number;
  countsByRequest: Map<string, number>;
  sequence: number;
}

const stateByOptions = new WeakMap<object, RelationalState | null>();

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return undefined;
  return value;
}

function boundedId(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function boundedColumns(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_RELATIONAL_ORDER_COLUMNS
  )
    return undefined;
  const columns = value.map(boundedIdentifier);
  return columns.every((column): column is string => column !== undefined)
    ? columns
    : undefined;
}

function boundedBooleanVector(
  value: unknown,
  length: number,
): boolean[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  return value.every((entry) => typeof entry === "boolean")
    ? [...value]
    : undefined;
}

function canonicalString(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  return `s${bytes}:${JSON.stringify(value)}`;
}

function canonicalValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { entries: MAX_CANONICAL_ENTRIES, bytes: MAX_CANONICAL_BYTES },
): string | undefined {
  if (--budget.entries < 0) return undefined;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    budget.bytes -= Buffer.byteLength(value, "utf8");
    return budget.bytes >= 0 ? canonicalString(value) : undefined;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:nan";
    if (value === Infinity) return "number:+infinity";
    if (value === -Infinity) return "number:-infinity";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${value}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString(10)}`;
  if (typeof value === "function" || typeof value === "symbol")
    return undefined;
  if (depth > MAX_CANONICAL_DEPTH || typeof value !== "object")
    return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? `date:${value.toISOString()}` : undefined;
    }
    if (value instanceof Uint8Array) {
      budget.bytes -= value.byteLength;
      if (budget.bytes < 0) return undefined;
      return `bytes:${Buffer.from(value).toString("hex")}`;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_CANONICAL_ENTRIES) return undefined;
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) return undefined;
        const encoded = canonicalValue(
          descriptor.value,
          depth + 1,
          seen,
          budget,
        );
        if (encoded === undefined) return undefined;
        entries.push(encoded);
      }
      return `array:${entries.length}[${entries.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Object.keys(value).sort((left, right) =>
      Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")),
    );
    if (keys.length > MAX_CANONICAL_ENTRIES) return undefined;
    const entries: string[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      budget.bytes -= Buffer.byteLength(key, "utf8");
      if (budget.bytes < 0) return undefined;
      const encoded = canonicalValue(descriptor.value, depth + 1, seen, budget);
      if (encoded === undefined) return undefined;
      entries.push(`${canonicalString(key)}=${encoded}`);
    }
    return `object:${entries.length}{${entries.join(",")}}`;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function digest(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function declarationCanonical(input: {
  relationId: string;
  parentTable: string;
  parentColumns: string[];
  childTable: string;
  childColumns: string[];
  childNullable: boolean[];
  constraintTiming: DbRelationalConstraintTiming;
  deferrable: boolean;
}): string {
  return [
    canonicalString(input.relationId),
    canonicalString(input.parentTable),
    input.parentColumns.map(canonicalString).join(","),
    canonicalString(input.childTable),
    input.childColumns.map(canonicalString).join(","),
    input.childNullable.map((value) => (value ? "true" : "false")).join(","),
    input.constraintTiming,
    input.deferrable ? "true" : "false",
  ].join("|");
}

function normalizedState(options: {
  relationalOrder?: RelationalOrderCaptureOptions;
}): RelationalState | null {
  try {
    return readNormalizedState(options);
  } catch {
    return null;
  }
}

function readNormalizedState(options: {
  relationalOrder?: RelationalOrderCaptureOptions;
}): RelationalState | null {
  const config = options.relationalOrder;
  if (!config || typeof config !== "object") return null;
  const cached = stateByOptions.get(config);
  if (cached !== undefined) return cached;
  let state: RelationalState | null = null;
  try {
    if (
      !config ||
      !Array.isArray(config.declarations) ||
      config.declarations.length === 0
    )
      throw new Error("relational order is not configured");
    if (config.declarations.length > MAX_RELATIONAL_ORDER_DECLARATIONS)
      throw new Error("too many relational declarations");
    const key = Buffer.from(
      typeof config.key === "string" ? config.key : new Uint8Array(config.key),
    );
    if (key.length < 32 || key.length > 1024)
      throw new Error("invalid relational key");
    const declarations: NormalizedDeclaration[] = [];
    for (const declaration of config.declarations) {
      const relationId = boundedIdentifier(declaration?.relationId);
      const parentTable = boundedIdentifier(declaration?.parent?.table);
      const parentColumns = boundedColumns(declaration?.parent?.columns);
      const childTable = boundedIdentifier(declaration?.child?.table);
      const childColumns = boundedColumns(declaration?.child?.columns);
      if (
        !relationId ||
        !parentTable ||
        !parentColumns ||
        !childTable ||
        !childColumns
      )
        throw new Error("invalid relational declaration");
      if (parentColumns.length !== childColumns.length)
        throw new Error("relation column counts differ");
      const childNullable = boundedBooleanVector(
        declaration?.childNullable,
        childColumns.length,
      );
      if (!childNullable) throw new Error("invalid relational nullability");
      if (
        declaration?.constraintTiming !== "immediate" &&
        declaration?.constraintTiming !== "deferred"
      )
        throw new Error("invalid relational constraint timing");
      if (typeof declaration.deferrable !== "boolean")
        throw new Error("invalid relational deferrability");
      if (
        declaration.constraintTiming === "deferred" &&
        !declaration.deferrable
      )
        throw new Error("deferred relation must be deferrable");
      const canonical = declarationCanonical({
        relationId,
        parentTable,
        parentColumns,
        childTable,
        childColumns,
        childNullable,
        constraintTiming: declaration.constraintTiming,
        deferrable: declaration.deferrable,
      });
      declarations.push({
        relationIdentity: digest(key, RELATION_DOMAIN, canonical),
        parentTable,
        parentColumns,
        childTable,
        childColumns,
        contract: {
          version: RELATIONAL_ORDER_CONTRACT_VERSION,
          columnCount: childColumns.length,
          childNullable,
          constraintTiming: declaration.constraintTiming,
          deferrable: declaration.deferrable,
        },
      });
    }
    if (
      new Set(declarations.map((declaration) => declaration.relationIdentity))
        .size !== declarations.length
    )
      throw new Error("duplicate relational declaration");
    const requested = config.maxEventsPerRequest;
    const maxEventsPerRequest =
      requested === undefined || !Number.isFinite(requested)
        ? DEFAULT_MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST
        : Math.max(
            1,
            Math.min(
              MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST,
              Math.floor(requested),
            ),
          );
    state = {
      key,
      declarations,
      maxEventsPerRequest,
      countsByRequest: new Map(),
      sequence: 0,
    };
  } catch {
    state = null;
  }
  stateByOptions.set(config, state);
  return state;
}

/** One observation order across successful and failed statements sharing a declaration config. */
export function nextRelationalOrderSequence(
  options: { relationalOrder?: RelationalOrderCaptureOptions },
  requestId: string,
): number | undefined {
  const state = normalizedState(options);
  if (!state || !boundedId(requestId, MAX_REQUEST_ID_LENGTH)) return undefined;
  // A configuration-wide ordinal cannot collide when a request budget is evicted.
  const sequence = state.sequence + 1;
  if (sequence > MAX_RELATIONAL_ORDER_SEQUENCE) return undefined;
  state.sequence = sequence;
  return sequence;
}

function readOwn(row: Record<string, unknown>, column: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(row, column);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index + 1] === quote) {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function keywordIndex(value: string, keyword: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index <= value.length - keyword.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index + 1] === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    if (
      depth === 0 &&
      value.slice(index, index + keyword.length).toLowerCase() === keyword &&
      !/[A-Za-z0-9_$]/u.test(value[index - 1] ?? "") &&
      !/[A-Za-z0-9_$]/u.test(value[index + keyword.length] ?? "")
    )
      return index;
  }
  return -1;
}

function unwrapIdentifier(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

function stripLeadingSqlComments(value: string): string {
  return value.replace(
    /^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/u,
    "",
  );
}

function ownParam(
  params: unknown,
  key: string,
): { found: boolean; value?: unknown } {
  if (Array.isArray(params)) return { found: false };
  if (params === null || typeof params !== "object") return { found: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(params, key);
    return descriptor && "value" in descriptor
      ? { found: true, value: descriptor.value }
      : { found: false };
  } catch {
    return { found: false };
  }
}

function tokenValue(
  token: string,
  params: unknown,
  positionalIndex: { value: number },
): { found: boolean; value?: unknown } {
  const trimmed = token.trim();
  const postgres = trimmed.match(/^\$(\d+)$/u);
  if (postgres && Array.isArray(params)) {
    const index = Number(postgres[1]) - 1;
    return index >= 0 && index < params.length
      ? { found: true, value: params[index] }
      : { found: false };
  }
  if (trimmed === "?") {
    const index = positionalIndex.value++;
    return Array.isArray(params) && index < params.length
      ? { found: true, value: params[index] }
      : { found: false };
  }
  const named = trimmed.match(/^[:@]([A-Za-z_][A-Za-z0-9_]*)$/u);
  if (named) return ownParam(params, named[1]);
  if (/^null$/iu.test(trimmed)) return { found: true, value: null };
  if (/^(?:true|false)$/iu.test(trimmed))
    return { found: true, value: trimmed.toLowerCase() === "true" };
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed))
    return { found: true, value: Number(trimmed) };
  if (/^'(?:[^'\\\\]|'')*'$/u.test(trimmed))
    return { found: true, value: trimmed.slice(1, -1).replace(/''/gu, "'") };
  return { found: false };
}

function insertRows(
  statement: string,
  params: unknown,
): { target: string; rows: Array<Record<string, unknown>> } | undefined {
  if (
    typeof statement !== "string" ||
    statement.length === 0 ||
    statement.length > MAX_RELATIONAL_ORDER_STATEMENT_LENGTH
  )
    return undefined;
  const valuesAt = keywordIndex(statement, "values");
  if (valuesAt < 0) return undefined;
  const prefix = statement.slice(0, valuesAt);
  const open = prefix.lastIndexOf("(");
  const close = prefix.lastIndexOf(")");
  if (open < 0 || close <= open || close !== prefix.trimEnd().length - 1)
    return undefined;
  const targetMatch = stripLeadingSqlComments(prefix).match(
    /^\s*(?:insert\s+)(?:ignore\s+)?into\s+([^\s(]+)\s*/iu,
  );
  if (!targetMatch) return undefined;
  const target = unwrapIdentifier(targetMatch[1]);
  if (!boundedIdentifier(target)) return undefined;
  const columns = splitTopLevel(prefix.slice(open + 1, close)).map(
    unwrapIdentifier,
  );
  if (
    columns.length === 0 ||
    columns.length > MAX_RELATIONAL_ORDER_COLUMNS ||
    columns.some((column) => !boundedIdentifier(column))
  )
    return undefined;
  const valueText = statement.slice(valuesAt + "values".length);
  const rows: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const positionalIndex = { value: 0 };
  while (
    cursor < valueText.length &&
    rows.length < MAX_RELATIONAL_ORDER_INSERT_ROWS
  ) {
    while (/[\s,]/u.test(valueText[cursor] ?? "")) cursor += 1;
    if (valueText[cursor] !== "(") break;
    let depth = 0;
    let quote: string | undefined;
    let close = -1;
    for (let index = cursor; index < valueText.length; index += 1) {
      const character = valueText[index];
      if (quote) {
        if (character === quote && valueText[index + 1] === quote) index += 1;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close < 0) return undefined;
    const tokens = splitTopLevel(valueText.slice(cursor + 1, close));
    if (tokens.length !== columns.length) return undefined;
    const row: Record<string, unknown> = {};
    for (let index = 0; index < columns.length; index += 1) {
      const result = tokenValue(tokens[index], params, positionalIndex);
      if (!result.found) return undefined;
      row[columns[index]] = result.value;
    }
    rows.push(row);
    cursor = close + 1;
  }
  let remainder = valueText.slice(cursor).trim();
  if (remainder.endsWith(";")) remainder = remainder.slice(0, -1).trim();
  if (rows.length === MAX_RELATIONAL_ORDER_INSERT_ROWS && remainder.length > 0)
    return undefined;
  if (
    rows.length === 0 ||
    (remainder.length > 0 &&
      !/^returning\s+(?:\*|[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)$/iu.test(
        remainder,
      ))
  )
    return undefined;
  return { target, rows };
}

function valueIdentity(
  state: RelationalState,
  declaration: NormalizedDeclaration,
  values: unknown[],
): string | undefined {
  const encoded = canonicalValue(values);
  if (encoded === undefined) return undefined;
  return digest(
    state.key,
    VALUE_DOMAIN,
    `${declaration.relationIdentity}|${encoded}`,
  );
}

function takeBudget(state: RelationalState, requestId: string): boolean {
  if (
    state.countsByRequest.size >= 256 &&
    !state.countsByRequest.has(requestId)
  ) {
    const oldest = state.countsByRequest.keys().next().value;
    if (typeof oldest === "string") {
      state.countsByRequest.delete(oldest);
    }
  }
  const count = state.countsByRequest.get(requestId) ?? 0;
  if (count >= state.maxEventsPerRequest) return false;
  state.countsByRequest.set(requestId, count + 1);
  return true;
}

function buildEvent(input: {
  engine: DbEngine;
  relationIdentity: string;
  valueIdentity: string;
  role: DbRelationalOrderRole;
  op: DbRelationalOrderOp;
  sequence: number;
  requestId: string;
  transactionId?: string;
  contract: DbRelationalOrderContract;
  sessionId?: string;
  now?: number;
  sessionStartedAt?: number | Date;
}): BugEvent {
  const now = Number.isFinite(input.now)
    ? Math.round(input.now as number)
    : Date.now();
  const data: DbRelationalOrderEventData = {
    engine: input.engine,
    relationIdentity: input.relationIdentity,
    valueIdentity: input.valueIdentity,
    role: input.role,
    op: input.op,
    sequence: input.sequence,
    requestId: input.requestId,
    ...(input.transactionId ? { transactionId: input.transactionId } : {}),
    contract: {
      version: 1,
      columnCount: input.contract.columnCount,
      childNullable: [...input.contract.childNullable],
      constraintTiming: input.contract.constraintTiming,
      deferrable: input.contract.deferrable,
    },
  };
  const event: BugEvent = {
    t: now,
    k: DB_RELATIONAL_ORDER_EVENT_KIND,
    d: data as unknown as Record<string, unknown>,
  };
  if (input.sessionId) event.sessionId = input.sessionId;
  const startedAt =
    input.sessionStartedAt instanceof Date
      ? input.sessionStartedAt.getTime()
      : input.sessionStartedAt;
  if (Number.isFinite(startedAt))
    event.offsetMs = Math.max(0, now - Number(startedAt));
  return event;
}

/** Emits sealed relation observations for rows from one successful, image-bearing mutation. */
export function emitRelationalOrderEvents(input: {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  requestId: string;
  rows: Array<Record<string, unknown>>;
  options: {
    relationalOrder?: RelationalOrderCaptureOptions;
    sessionId?: string;
    now?: () => number;
    sessionStartedAt?: number | Date;
    emit: (event: BugEvent) => void;
  };
  sequence?: number;
  transactionId?: string;
}): void {
  try {
    if (
      input.op === "delete" ||
      !boundedId(input.requestId, MAX_REQUEST_ID_LENGTH) ||
      !boundedIdentifier(input.table) ||
      typeof input.sequence !== "number" ||
      !Number.isSafeInteger(input.sequence) ||
      (input.sequence as number) < 1 ||
      (input.sequence as number) > MAX_RELATIONAL_ORDER_SEQUENCE ||
      (input.transactionId !== undefined &&
        !boundedId(input.transactionId, MAX_TRANSACTION_ID_LENGTH))
    )
      return;
    const state = normalizedState(input.options);
    if (!state) return;
    emitForRows({
      engine: input.engine,
      op: input.op,
      table: input.table,
      requestId: input.requestId,
      rows: input.rows,
      options: input.options,
      sequence: input.sequence,
      transactionId: input.transactionId,
      state,
    });
  } catch {
    // Relation capture is advisory and must never affect the host statement.
  }
}

function emitForRows(input: {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  requestId: string;
  rows: Array<Record<string, unknown>>;
  options: {
    relationalOrder?: RelationalOrderCaptureOptions;
    sessionId?: string;
    now?: () => number;
    sessionStartedAt?: number | Date;
    emit: (event: BugEvent) => void;
  };
  sequence: number;
  transactionId?: string;
  state: RelationalState;
}): void {
  for (const row of input.rows.slice(
    0,
    MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST,
  )) {
    for (const declaration of input.state.declarations) {
      const roles: Array<{
        role: DbRelationalOrderRole;
        columns: string[];
      }> = [];
      if (input.table === declaration.parentTable)
        roles.push({ role: "parent", columns: declaration.parentColumns });
      if (input.table === declaration.childTable)
        roles.push({ role: "child", columns: declaration.childColumns });
      for (const { role, columns } of roles) {
        const values = columns.map((column) => readOwn(row, column));
        if (values.some((value) => value === null || value === undefined))
          continue;
        const identity = valueIdentity(input.state, declaration, values);
        if (!identity) continue;
        if (!takeBudget(input.state, input.requestId)) return;
        const event = buildEvent({
          engine: input.engine,
          relationIdentity: declaration.relationIdentity,
          valueIdentity: identity,
          role,
          op: input.op as DbRelationalOrderOp,
          sequence: input.sequence,
          requestId: input.requestId,
          transactionId: input.transactionId,
          contract: declaration.contract,
          sessionId: input.options.sessionId,
          now: input.options.now?.(),
          sessionStartedAt: input.options.sessionStartedAt,
        });
        try {
          input.options.emit(event);
        } catch {
          return;
        }
      }
    }
  }
}

/** Emits a sealed observation for a simple parameterized INSERT that the database refused. */
export function emitRelationalOrderAttempt(input: {
  engine: DbEngine;
  op: DbDiffOp | "select" | "other";
  table: string;
  statement: string;
  params?: unknown;
  requestId: string;
  sequence: number;
  transactionId?: string;
  options: {
    relationalOrder?: RelationalOrderCaptureOptions;
    sessionId?: string;
    now?: () => number;
    sessionStartedAt?: number | Date;
    emit: (event: BugEvent) => void;
  };
}): void {
  try {
    if (input.op !== "insert") return;
    if (
      !boundedId(input.requestId, MAX_REQUEST_ID_LENGTH) ||
      !boundedIdentifier(input.table) ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 1 ||
      input.sequence > MAX_RELATIONAL_ORDER_SEQUENCE ||
      (input.transactionId !== undefined &&
        !boundedId(input.transactionId, MAX_TRANSACTION_ID_LENGTH))
    )
      return;
    const parsed = insertRows(input.statement, input.params);
    if (!parsed || parsed.target !== input.table) return;
    const state = normalizedState(input.options);
    if (!state) return;
    emitForRows({
      engine: input.engine,
      op: input.op as DbDiffOp,
      table: input.table,
      requestId: input.requestId,
      rows: parsed.rows,
      options: input.options,
      sequence: input.sequence,
      transactionId: input.transactionId,
      state,
    });
  } catch {
    // Failed-attempt capture is advisory and must never affect the database error path.
  }
}
