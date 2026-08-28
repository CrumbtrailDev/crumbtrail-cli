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

/**
 * Strips SQL comments so a value hidden in a comment cannot ride along as "structure".
 *
 * Three spellings, not two. `--` and block comments are the portable pair; `#` to end of line is
 * MySQL and MariaDB, and omitting it let a whole comment through verbatim — `SELECT x FROM t #
 * alice@example.com` normalized to itself, address included, in a value that this file's contract
 * says holds keywords, identifiers and placeholders and nothing else.
 *
 * `#` is also a Postgres operator, so the rule excludes the two-character forms `#>`, `#>>` and
 * `#-` that appear in jsonb path expressions. A BARE `#` is genuinely ambiguous — MySQL comment or
 * Postgres bitwise XOR — and it is resolved the way the rest of this file resolves ambiguity: by
 * discarding. The cost of reading an XOR as a comment is a shorter shape; the cost of reading a
 * comment as an operator is a customer's data in evidence.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/#(?![>-])[^\n]*/g, " ");
}

/**
 * Any token still carrying a quote character after the literal passes above.
 *
 * The literal passes assume the statement's quoting is balanced. A statement built by string
 * interpolation need not be: `LIKE '%o'brien%'` tokenizes as the literal `'%o'` followed by the
 * bare word `brien%'`, so the pass replaces the first and leaves a fragment of the customer's
 * value standing in what is documented as a value-free shape. The fragment is exactly the input
 * that broke the statement, which is exactly the input most worth not retaining.
 *
 * So a residual quote is treated as proof that tokenization failed, and the whole token it sits in
 * is discarded — the same "the safe reading of an ambiguous token is the one that discards it"
 * stance the doc comment above already takes. Statements whose quoting balances are untouched by
 * this pass, because they have no quote left for it to match.
 */
const RESIDUAL_QUOTED_TOKEN = /[^\s(),;]*['"`\[\]][^\s(),;]*/g;

/**
 * @param sql raw statement text. Never stored, never returned.
 * @param label redaction-metadata attribution for the belt-and-braces token pass. Defaults to the
 *   failing-statement surface this file was written for; the succeeding-statement surface passes
 *   its own so the two are told apart in redaction metadata.
 */
export function normalizeStatementShape(
  sql: string,
  label = "db.error.shape",
): string {
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
    // Unbalanced quoting means the passes above mis-tokenized: discard what is left of it.
    .replace(RESIDUAL_QUOTED_TOKEN, PLACEHOLDER)
    .replace(/\s+/g, " ")
    .trim();

  // Belt and braces: the same credential-shaped-token pass `capture_gap.detail` already applies.
  const redacted = redactTokenLikeString(withoutLiterals, label).value;
  return redacted.slice(0, MAX_STATEMENT_SHAPE_LENGTH);
}
