import * as sqlParserModule from "node-sql-parser";
import type { DbDiffOp } from "crumbtrail-core";

/**
 * SQL statement classification shared by every database adapter. `node-sql-parser` performs the
 * dialect-aware AST parsing; the small helpers below only project AST fields into Crumbtrail's
 * stable public shape and retain the original WHERE text for best-effort pre-image queries.
 */

export interface ParsedMutation {
  op: DbDiffOp;
  table: string;
  whereClause?: string;
}

export interface ParsedRead {
  table: string;
}

export type StatementClassification =
  | { kind: "mutation"; mutation: ParsedMutation }
  | { kind: "read"; read: ParsedRead }
  | { kind: "other" }
  | { kind: "unparsable"; detail: string; mayMutate: boolean };

type SqlAst = Record<string, unknown>;
type ParserInstance = {
  astify(sql: string, options: { database: string }): unknown;
};
type ParserConstructor = new () => ParserInstance;

const DIALECTS = ["Postgresql", "MySQL", "transactsql", "sqlite"] as const;
const MUTATION_TYPES = new Set(["insert", "replace", "update", "delete"]);
const WRITE_KEYWORDS = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "replace",
  "upsert",
  "with",
  "prepare",
]);

let parser: ParserInstance | undefined;

/**
 * Classifies one SQL statement without exposing parser errors to a host driver. `unparsable`
 * distinguishes a parser miss from a confidently non-mutating statement, and `mayMutate` tells
 * adapters when the miss must become a `capture_gap` rather than silently disappearing.
 */
export function classifyStatement(sql: string): StatementClassification {
  const keyword = leadingSqlKeyword(sql);
  if (!keyword) return { kind: "other" };

  let ast: unknown;
  try {
    ast = parseAst(sql);
  } catch {
    return {
      kind: "unparsable",
      detail: keyword,
      mayMutate: looksLikePotentialWrite(sql),
    };
  }

  if (Array.isArray(ast)) {
    if (ast.length !== 1) {
      return {
        kind: "unparsable",
        detail: keyword,
        mayMutate:
          ast.some((statement) => astContainsMutation(statement)) ||
          looksLikePotentialWrite(sql),
      };
    }
    ast = ast[0];
  }

  if (!isRecord(ast)) {
    return {
      kind: "unparsable",
      detail: keyword,
      mayMutate: looksLikePotentialWrite(sql),
    };
  }

  const mutation = findMutation(ast);
  if (mutation) {
    const parsed = projectMutation(mutation, sql, ast === mutation);
    return parsed
      ? { kind: "mutation", mutation: parsed }
      : { kind: "unparsable", detail: keyword, mayMutate: true };
  }

  const read = projectRead(ast);
  if (read) return { kind: "read", read };

  if (looksLikePotentialWrite(sql)) {
    return { kind: "unparsable", detail: keyword, mayMutate: true };
  }
  return { kind: "other" };
}

/** Parses op + table (+ WHERE clause) from one confidently classified mutation. */
export function parseMutation(sql: string): ParsedMutation | undefined {
  const classification = classifyStatement(sql);
  return classification.kind === "mutation"
    ? classification.mutation
    : undefined;
}

/** Parses the first table from one confidently classified read. */
export function parseRead(sql: string): ParsedRead | undefined {
  const classification = classifyStatement(sql);
  return classification.kind === "read" ? classification.read : undefined;
}

/** The window shape (LIMIT/OFFSET) one read statement ran with, values resolved. */
export interface ReadQueryShape {
  limit?: number;
  offset?: number;
}

/**
 * Extracts the resolved LIMIT/OFFSET window from one read statement.
 *
 * Pagination arithmetic lives exactly here — a first-page request whose SELECT
 * runs `OFFSET 1` silently drops the first row of the table's order from every
 * page, and nothing errors. Capturing the window on the read event is what lets
 * a detector compare it against the request's own paging parameters.
 *
 * Literal numbers and Postgres `$n` placeholders (resolved against `params`)
 * are supported, plus MySQL's `LIMIT offset, count` form with literals. A
 * placeholder that cannot be resolved yields no value rather than a guess.
 */
export function parseLimitOffset(
  sql: string,
  params?: unknown,
): ReadQueryShape {
  const text = stripSqlComments(sql);
  const paramArray = Array.isArray(params) ? params : undefined;
  const resolve = (token: string): number | undefined => {
    if (/^\d+$/.test(token)) return Number(token);
    const placeholder = token.match(/^\$(\d+)$/);
    if (placeholder && paramArray) {
      const value = Number(paramArray[Number(placeholder[1]) - 1]);
      return Number.isInteger(value) && value >= 0 ? value : undefined;
    }
    return undefined;
  };

  const shape: ReadQueryShape = {};
  const mysqlForm = text.match(/\blimit\s+(\d+)\s*,\s*(\d+)/i);
  if (mysqlForm) {
    shape.offset = Number(mysqlForm[1]);
    shape.limit = Number(mysqlForm[2]);
    return shape;
  }
  const limit = text.match(/\blimit\s+(\d+|\$\d+)/i);
  if (limit) {
    const value = resolve(limit[1]);
    if (value !== undefined) shape.limit = value;
  }
  const offset = text.match(/\boffset\s+(\d+|\$\d+)/i);
  if (offset) {
    const value = resolve(offset[1]);
    if (value !== undefined) shape.offset = value;
  }
  return shape;
}

/**
 * The bounded, literal-free descriptor adapters attach to an `unparsed_sql` capture gap. It is
 * intentionally only the leading SQL keyword, never any query text or bind value.
 */
export function leadingSqlKeyword(sql: string): string {
  const match = stripSqlComments(sql).match(/^\s*([A-Za-z]+)/);
  return match?.[1]?.toUpperCase() ?? "UNKNOWN";
}

/** True for syntax that can hide or directly perform a database mutation. */
export function looksLikePotentialWrite(sql: string): boolean {
  const withoutComments = stripSqlComments(sql);
  const first = leadingSqlKeyword(withoutComments).toLowerCase();
  if (WRITE_KEYWORDS.has(first)) return true;
  return /\b(?:insert|update|delete|merge|replace|upsert)\b/i.test(
    withoutComments,
  );
}

/** Removes SQL comments while preserving quoted text so comment contents cannot mask a write. */
function stripSqlComments(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      output += " ";
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      output += " ";
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    const skipped = skipSqlRegion(sql, index);
    if (skipped !== undefined) {
      output += sql.slice(index, skipped);
      index = skipped;
      continue;
    }
    output += sql[index];
    index += 1;
  }
  return output;
}

function parseAst(sql: string): unknown {
  let lastError: unknown;
  for (const database of dialectsFor(sql)) {
    try {
      return getParser().astify(normalizeForParser(sql), { database });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("SQL parser failed");
}

function dialectsFor(sql: string): readonly string[] {
  const lower = sql.toLowerCase();
  if (/\[|\btop\s*(?:\(|\d)/i.test(sql)) {
    return ["transactsql", "Postgresql", "MySQL", "sqlite"];
  }
  if (sql.includes("`") || lower.includes("on duplicate key update")) {
    return ["MySQL", "Postgresql", "transactsql", "sqlite"];
  }
  return DIALECTS;
}

/** node-sql-parser accepts T SQL TOP (n), but not the equivalent TOP n spelling. */
function normalizeForParser(sql: string): string {
  const topNormalized = sql
    .replace(/\btop\s+(\d+)\b/gi, "TOP ($1)")
    .replace(/\boutput\s+(?:inserted|deleted)\s*\.\s*\*/gi, "");
  if (/\binsert\b[\s\S]*\bdefault\s+values\s*;?\s*$/i.test(topNormalized)) {
    return topNormalized.replace(
      /\bdefault\s+values\s*;?\s*$/i,
      "(__crumbtrail_default) VALUES (DEFAULT)",
    );
  }
  if (/^\s*insert\b[\s\S]*\bexec\b/i.test(topNormalized)) {
    return topNormalized.replace(/\bexec\b[\s\S]*$/i, "VALUES (DEFAULT)");
  }
  return topNormalized;
}

function getParser(): ParserInstance {
  if (parser) return parser;
  const moduleValue = sqlParserModule as unknown as {
    Parser?: ParserConstructor;
    default?: { Parser?: ParserConstructor };
  };
  const Parser = moduleValue.Parser ?? moduleValue.default?.Parser;
  if (!Parser) throw new Error("SQL parser is unavailable");
  parser = new Parser();
  return parser;
}

function findMutation(ast: SqlAst): SqlAst | undefined {
  if (MUTATION_TYPES.has(String(ast.type))) return ast;
  const withClauses = ast.with;
  if (!Array.isArray(withClauses)) return undefined;
  for (const clause of withClauses) {
    if (!isRecord(clause) || !isRecord(clause.stmt)) continue;
    const nested = unwrapAst(clause.stmt.ast) ?? clause.stmt;
    if (!isRecord(nested)) continue;
    const mutation = findMutation(nested);
    if (mutation) return mutation;
  }
  return undefined;
}

function astContainsMutation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (MUTATION_TYPES.has(String(value.type))) return true;
  const withClauses = value.with;
  return Array.isArray(withClauses)
    ? withClauses.some(
        (clause) =>
          isRecord(clause) &&
          isRecord(clause.stmt) &&
          astContainsMutation(unwrapAst(clause.stmt.ast) ?? clause.stmt),
      )
    : false;
}

function unwrapAst(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function projectMutation(
  ast: SqlAst,
  sql: string,
  rootMutation: boolean,
): ParsedMutation | undefined {
  const op = mutationOp(ast.type);
  const table = projectTable(ast);
  if (!op || !table) return undefined;
  return {
    op,
    table,
    ...(op === "update" || op === "delete"
      ? { whereClause: rootMutation ? extractTopLevelWhere(sql) : undefined }
      : {}),
  };
}

function mutationOp(type: unknown): DbDiffOp | undefined {
  switch (type) {
    case "insert":
    case "replace":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    default:
      return undefined;
  }
}

function projectRead(ast: SqlAst): ParsedRead | undefined {
  if (ast.type !== "select") return undefined;
  const table = projectTable(ast);
  return table ? { table } : undefined;
}

function projectTable(ast: SqlAst): string | undefined {
  for (const candidates of [ast.table, ast.from]) {
    const sources = Array.isArray(candidates) ? candidates : [candidates];
    for (const source of sources) {
      if (!isRecord(source)) continue;
      const table =
        typeof source.table === "string" &&
        source.table.toUpperCase() !== "ONLY"
          ? source.table
          : typeof source.as === "string"
            ? source.as
            : undefined;
      if (!table) continue;
      const parts = [source.db, source.schema, table]
        .filter(
          (part): part is string => typeof part === "string" && part.length > 0,
        )
        .map(normalizeIdentifier);
      if (parts.length > 0) return parts.join(".");
    }
  }
  return undefined;
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractTopLevelWhere(sql: string): string | undefined {
  const where = findTopLevelKeyword(sql, ["where"]);
  if (where === undefined) return undefined;
  const end =
    findTopLevelKeyword(
      sql,
      ["returning", "output", "order", "limit"],
      where + 5,
    ) ?? sql.length;
  const clause = sql.slice(where, end).trim().replace(/;\s*$/, "");
  return clause || undefined;
}

function findTopLevelKeyword(
  sql: string,
  keywords: readonly string[],
  start = 0,
): number | undefined {
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const skipped = skipSqlRegion(sql, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const character = sql[index];
    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (
      index >= start &&
      depth === 0 &&
      (index === 0 || !/[A-Za-z0-9_$]/.test(sql[index - 1]))
    ) {
      for (const keyword of keywords) {
        const candidate = sql.slice(index, index + keyword.length);
        if (
          candidate.toLowerCase() === keyword &&
          !/[A-Za-z0-9_$]/.test(sql[index + keyword.length] ?? "")
        ) {
          return index;
        }
      }
    }
    index += 1;
  }
  return undefined;
}

function skipSqlRegion(sql: string, index: number): number | undefined {
  const character = sql[index];
  if (character === "-" && sql[index + 1] === "-") {
    const newline = sql.indexOf("\n", index + 2);
    return newline === -1 ? sql.length : newline + 1;
  }
  if (character === "/" && sql[index + 1] === "*") {
    const end = sql.indexOf("*/", index + 2);
    return end === -1 ? sql.length : end + 2;
  }
  if (character === "'" || character === '"' || character === "`") {
    let cursor = index + 1;
    while (cursor < sql.length) {
      if (sql[cursor] === character) {
        if (sql[cursor + 1] === character) {
          cursor += 2;
          continue;
        }
        return cursor + 1;
      }
      cursor += 1;
    }
    return sql.length;
  }
  if (character === "[") {
    const end = sql.indexOf("]", index + 1);
    return end === -1 ? sql.length : end + 1;
  }
  return undefined;
}

function isRecord(value: unknown): value is SqlAst {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ReturningPlan {
  /** The statement to execute. */
  text: string;
  /**
   * The columns the host asked for, when the statement's own `RETURNING` list was widened to `*`.
   * Rows are projected back to these before the host sees them, so widening buys a complete
   * after-image without changing what the caller receives. `undefined` means hand the result back
   * untouched.
   */
  projectTo?: readonly string[];
}

/**
 * How to run a mutation so the after-image is the whole row.
 *
 * Three cases, and the middle one is the reason this is not a one-liner. A statement with no
 * `RETURNING` gets `RETURNING *` appended — invisible, because the caller was not reading rows.
 * A statement that already says `RETURNING *` is left alone. A statement with its OWN narrow list
 * (`RETURNING id`) used to be left alone too, and that is how an `INSERT INTO jobs (type, payload,
 * status, ...) RETURNING id` reached the bundle as `{"id":1}` — every column that said what the
 * write actually did, dropped, because the application happened to only need the key back.
 *
 * So the list is widened to `*` and the rows are projected back down to what the caller asked for.
 * Only for a plain, unaliased identifier list: an alias or an expression cannot be reconstructed
 * from `*`, so those keep their narrow after-image rather than risk handing the host a row that is
 * missing a column it named.
 */
export function planReturning(sql: string): ReturningPlan {
  const at = findTopLevelKeyword(sql, ["returning"]);
  if (at === undefined) {
    return { text: `${sql.replace(/;\s*$/, "")} RETURNING *` };
  }
  const clause = sql
    .slice(at + "returning".length)
    .replace(/;\s*$/, "")
    .trim();
  const items = splitTopLevelCommas(clause).map((item) => item.trim());
  if (items.length === 0 || items.some((item) => !isPlainColumnRef(item))) {
    return { text: sql };
  }
  if (items.includes("*")) return { text: sql };
  return {
    text: `${sql.slice(0, at)}RETURNING *`,
    projectTo: items.map(returnedColumnName),
  };
}

/**
 * Postgres folds an unquoted identifier to lower case in the result keys; a quoted one keeps the
 * case it was written with. The projection reads result keys, so it has to match that.
 */
function returnedColumnName(identifier: string): string {
  const trimmed = identifier.trim();
  return trimmed.startsWith('"')
    ? normalizeIdentifier(trimmed)
    : trimmed.toLowerCase();
}

function isPlainColumnRef(item: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(item) || /^"[^"]+"$/.test(item);
}

/** Splits on commas that are not inside parentheses, quotes, or comments. */
export function splitTopLevelCommas(fragment: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < fragment.length) {
    const skipped = skipSqlRegion(fragment, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const character = fragment[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(fragment.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  const tail = fragment.slice(start);
  if (tail.trim() || parts.length > 0) parts.push(tail);
  return parts.filter((part) => part.trim().length > 0);
}

/**
 * Quote-aware count of positional `?` placeholders in a SQL fragment: `?` inside single/double
 * quoted string literals and backtick/`[bracket]` quoted identifiers are ignored. Best-effort —
 * used by positional-param engines for the trailing-`?`-params heuristic, never for host-query
 * correctness.
 */
export function countPlaceholders(sqlFragment: string): number {
  let count = 0;
  let closing: string | null = null;
  for (let index = 0; index < sqlFragment.length; index += 1) {
    const character = sqlFragment[index];
    if (closing !== null) {
      if (character === closing) {
        if (
          (closing === "'" || closing === '"') &&
          sqlFragment[index + 1] === closing
        ) {
          index += 1;
          continue;
        }
        closing = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      closing = character;
      continue;
    }
    if (character === "[") {
      closing = "]";
      continue;
    }
    if (character === "?") count += 1;
  }
  return count;
}
