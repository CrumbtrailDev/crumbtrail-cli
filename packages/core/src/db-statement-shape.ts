import { redactTokenLikeString } from "./redaction";

/**
 * Normalizes one SQL statement into a shape safe to carry as evidence.
 *
 * The contract is subtractive and it is the whole point of the file: a shape may contain SQL
 * keywords, identifiers and placeholders, and it may contain NOTHING ELSE. Every literal — quoted
 * text, quoted identifier, number — is replaced by `?` before anything else happens, so a value
 * cannot survive by being spelled unusually. Bind values passed separately never enter here at
 * all; they live in the driver's parameter array, which this function is never given.
 *
 * Quoted identifiers (`"user_id"`, `` `user_id` ``, `[user_id]`) are collapsed to `?` alongside
 * string literals rather than kept. Whether a double-quoted token is an identifier or a string is
 * dialect-dependent, and the safe reading of an ambiguous token is the one that discards it.
 * Unquoted identifiers — which is how table and column names are written in practice — survive,
 * and the table is carried separately on the event regardless.
 */

const MAX_STATEMENT_SHAPE_LENGTH = 400;
const PLACEHOLDER = "?";

/** Strips SQL comments so a value hidden in a comment cannot ride along as "structure". */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function normalizeStatementShape(sql: string): string {
  if (typeof sql !== "string" || sql.length === 0) return "";
  const withoutLiterals = stripComments(sql)
    // Single-quoted strings, including doubled-quote escapes.
    .replace(/'(?:''|[^'])*'/g, PLACEHOLDER)
    // Dollar-quoted bodies (Postgres) before the `$n` placeholder rule below.
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, PLACEHOLDER)
    // Double-quoted, backtick-quoted and bracket-quoted tokens: ambiguous, so discarded.
    .replace(/"(?:""|[^"])*"/g, PLACEHOLDER)
    .replace(/`(?:``|[^`])*`/g, PLACEHOLDER)
    .replace(/\[[^\]]*\]/g, PLACEHOLDER)
    // Bind placeholders in every supported spelling collapse to one spelling.
    .replace(/[$:@]\d+/g, PLACEHOLDER)
    // Numeric literals, including hex, exponent and decimal forms.
    .replace(/\b0x[0-9a-f]+\b/gi, PLACEHOLDER)
    .replace(/(?<![\w.])\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, PLACEHOLDER)
    .replace(/\s+/g, " ")
    .trim();

  // Belt and braces: the same credential-shaped-token pass `capture_gap.detail` already applies.
  const redacted = redactTokenLikeString(
    withoutLiterals,
    "db.error.shape",
  ).value;
  return redacted.slice(0, MAX_STATEMENT_SHAPE_LENGTH);
}
