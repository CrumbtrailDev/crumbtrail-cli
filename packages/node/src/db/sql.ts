import type { DbDiffOp } from "crumbtrail-core";

/**
 * Dialect-aware SQL statement parsing shared by every DB adapter. The parsers are deliberately
 * conservative: they recognize single-table INSERT/UPDATE/DELETE and simple SELECT-FROM shapes
 * across Postgres, MySQL, MSSQL, and SQLite quoting/keyword variants, and return `undefined` for
 * anything they do not understand so callers degrade to "no diff" rather than mis-instrument.
 */

export interface ParsedMutation {
  op: DbDiffOp;
  table: string;
  whereClause?: string;
}

export interface ParsedRead {
  table: string;
}

// A single identifier: bare, double-quoted, backtick-quoted, or [bracket]-quoted.
const IDENT_PART = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)`;
// A (possibly schema-qualified) table identifier, e.g. `[dbo].[orders]`, `` `db`.`t` ``, `"s"."t"`.
const TABLE_IDENT = String.raw`(${IDENT_PART}(?:\s*\.\s*${IDENT_PART})*)`;
// MSSQL row limiter tolerated after DELETE / UPDATE, e.g. `TOP (10)` or `TOP 5`.
const TOP_CLAUSE = String.raw`(?:top\s*(?:\(\s*\d+\s*\)|\d+)\s+)?`;

const INSERT_RE = new RegExp(
  String.raw`^\s*insert\s+into\s+${TABLE_IDENT}`,
  "i",
);
const UPDATE_RE = new RegExp(
  String.raw`^\s*update\s+${TOP_CLAUSE}(?:only\s+)?${TABLE_IDENT}\s+set\b`,
  "i",
);
const DELETE_RE = new RegExp(
  String.raw`^\s*delete\s+${TOP_CLAUSE}from\s+(?:only\s+)?${TABLE_IDENT}`,
  "i",
);
const SELECT_FROM_RE = new RegExp(
  String.raw`^\s*select\b[\s\S]*?\bfrom\s+${TABLE_IDENT}`,
  "i",
);
const WHERE_RE = /\bwhere\b[\s\S]*?(?=\breturning\b|$)/i;
const RETURNING_RE = /\breturning\b/i;

/** Parses op + table (+ WHERE clause) from a SQL statement. Returns undefined for non-mutations. */
export function parseMutation(sql: string): ParsedMutation | undefined {
  const insert = INSERT_RE.exec(sql);
  if (insert) return { op: "insert", table: normalizeTable(insert[1]) };

  const update = UPDATE_RE.exec(sql);
  if (update)
    return {
      op: "update",
      table: normalizeTable(update[1]),
      whereClause: extractWhere(sql),
    };

  const del = DELETE_RE.exec(sql);
  if (del)
    return {
      op: "delete",
      table: normalizeTable(del[1]),
      whereClause: extractWhere(sql),
    };

  return undefined;
}

/** Parses the first table from a simple SELECT statement. Returns undefined for non-reads. */
export function parseRead(sql: string): ParsedRead | undefined {
  const select = SELECT_FROM_RE.exec(sql);
  if (!select) return undefined;
  return { table: normalizeTable(select[1]) };
}

/** Strips one layer of `"…"`, `` `…` ``, or `[…]` quoting from a single identifier component. */
function stripIdentifierQuotes(part: string): string {
  const trimmed = part.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Normalizes a captured table identifier to a dot-joined bare name across dialect quote styles. */
function normalizeTable(raw: string): string {
  return raw
    .trim()
    .split(".")
    .map((part) => stripIdentifierQuotes(part))
    .join(".");
}

function extractWhere(sql: string): string | undefined {
  const match = WHERE_RE.exec(sql);
  return match ? match[0].trim() : undefined;
}

/** Appends `RETURNING *` (Postgres after-image strategy) when the statement lacks one. */
export function ensureReturning(sql: string): string {
  return RETURNING_RE.test(sql)
    ? sql
    : `${sql.replace(/;\s*$/, "")} RETURNING *`;
}

/**
 * Quote-aware count of positional `?` placeholders in a SQL fragment: `?` inside single/double
 * quoted string literals and backtick/`[bracket]`-quoted identifiers are ignored. Best-effort —
 * used by positional-param engines for the trailing-`?`-params heuristic, never for host-query
 * correctness.
 */
export function countPlaceholders(sqlFragment: string): number {
  let count = 0;
  // The active quote's closing delimiter, or null when scanning outside any quote.
  let closing: string | null = null;
  for (let index = 0; index < sqlFragment.length; index += 1) {
    const ch = sqlFragment[index];
    if (closing !== null) {
      if (ch === closing) {
        // Doubled delimiter (`''`, `""`) is an escaped quote inside the literal, not a close.
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
    if (ch === "'" || ch === '"' || ch === "`") {
      closing = ch;
      continue;
    }
    if (ch === "[") {
      closing = "]";
      continue;
    }
    if (ch === "?") count += 1;
  }
  return count;
}
