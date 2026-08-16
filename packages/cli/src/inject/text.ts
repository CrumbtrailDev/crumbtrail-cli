// Pure text transforms for the injection recipes. Zero filesystem I/O — every
// function takes source text and returns source text, so the bulk of the recipe
// tests can assert behavior without touching disk.

const BOM = "﻿";

/** A source-directive prologue line, e.g. `"use client";` or `'use strict'`. */
const DIRECTIVE_RE = /^\s*(['"])use (?:client|strict|server)\1\s*;?\s*$/;

export interface SourceShape {
  /** "" or the UTF-8 BOM if the source started with one. */
  bom: string;
  /** The line terminator the source uses (defaults to LF for empty input). */
  eol: "\n" | "\r\n";
  /** Body lines with the BOM stripped and split on either EOL. */
  lines: string[];
}

/** Split source into BOM + EOL style + lines, preserving what we detect. */
export function analyzeSource(text: string): SourceShape {
  let bom = "";
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) {
    bom = BOM;
    body = body.slice(1);
  }
  const eol: "\n" | "\r\n" = /\r\n/.test(body) ? "\r\n" : "\n";
  return { bom, eol, lines: body.split(/\r?\n/) };
}

/**
 * Number of leading lines that form the un-touchable prologue: an optional
 * shebang followed by any directive-prologue lines ("use client"/"use strict"/
 * "use server"), including blank lines interleaved between them. Injection is
 * inserted immediately after this prologue.
 */
export function prologueEnd(lines: string[]): number {
  let end = 0;
  let idx = 0;
  if (lines[0]?.startsWith("#!")) {
    end = 1;
    idx = 1;
  }
  for (; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim() === "") continue; // blank — keep scanning, don't extend yet
    if (DIRECTIVE_RE.test(line)) {
      end = idx + 1;
      continue;
    }
    break;
  }
  return end;
}

/**
 * True when the source already references a Crumbtrail SDK package.
 *
 * `crumbtrail_flutter` is included because Dart is the one ecosystem whose
 * package name is not spelled with a hyphen, and an underscore name would not
 * match the JS pattern — leaving a wired Flutter app to be wired a second time.
 */
export function referencesCrumbtrail(text: string): boolean {
  return /crumbtrail-core|crumbtrail-node|crumbtrail_flutter/.test(text);
}

/**
 * Strictly prepend `block` into `existing`, after any shebang / directive
 * prologue, preserving the source's BOM and CRLF/LF style. `block` is authored
 * with LF newlines and is re-terminated to match the source.
 */
export function prependIntoSource(existing: string, block: string): string {
  const { bom, eol, lines } = analyzeSource(existing);
  const end = prologueEnd(lines);
  const blockLines = block.replace(/\n+$/, "").split("\n");

  const pre = lines.slice(0, end);
  const post = lines.slice(end);

  const out: string[] = [...pre];
  // Blank line between prologue and injected block.
  if (pre.length && pre[pre.length - 1].trim() !== "") out.push("");
  out.push(...blockLines);
  // Blank line between injected block and the original body (when there is one).
  const postHasContent = post.some((l) => l.trim() !== "");
  if (postHasContent && post[0].trim() !== "") out.push("");
  out.push(...post);

  return bom + out.join(eol);
}

// --- Express middleware wiring ----------------------------------------------

/** `const app = express()` (also let/var), capturing the app variable name. */
const EXPRESS_APP_RE = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*express\s*\(\s*\)/;

/**
 * Detect the entry's module style from how `express` itself is imported.
 * Returns null when neither an ESM import nor a require of express is present —
 * the caller then falls back to guidance instead of guessing.
 */
export function detectExpressModuleStyle(text: string): "esm" | "cjs" | null {
  if (/(^|\n)\s*import\s[^\n]*from\s*(['"])express\2/.test(text)) return "esm";
  if (/require\(\s*(['"])express\1\s*\)/.test(text)) return "cjs";
  return null;
}

/**
 * Count the parameters of the first callback passed to an `app.use(` call,
 * given everything on the line after `.use(`. Returns null when the argument is
 * not an inline function (a string route, a bare identifier, an options object).
 *
 * Express decides a middleware is an ERROR handler purely by arity: four
 * declared parameters. That is the only signal available in source text, so it
 * is the one used here.
 */
function inlineCallbackArity(rest: string): number | null {
  // Strip an `async` keyword and a `function` keyword with an optional name, so
  // both `(a, b, c, d) =>` and `function handler(a, b, c, d)` reduce to `(`.
  const head = rest
    .replace(/^\s*async\s+/, "")
    .replace(/^\s*function\s*[A-Za-z_$][\w$]*\s*/, "")
    .replace(/^\s*function\s*/, "")
    .replace(/^\s*/, "");
  if (!head.startsWith("(")) return null;

  let depth = 0;
  let commas = 0;
  let sawContent = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      depth--;
      if (depth === 0) return sawContent ? commas + 1 : 0;
    } else if (ch === "," && depth === 1) commas++;
    else if (depth === 1 && ch.trim() !== "") sawContent = true;
  }
  // Unbalanced: the parameter list runs past the text we were given.
  return null;
}

/**
 * Index of the first existing Express error handler registered on `appVar`, or
 * -1 when there is none.
 *
 * Express runs error handlers in registration order and stops at the first one
 * that ends the response. A real install (Alertbase PR #544) put Crumbtrail's
 * handler just above `app.listen`, which in `job-server` and
 * `user-billing-service` placed it BELOW a handler that always responds, so it
 * never ran and those services captured no errors at all.
 */
function findExistingErrorHandler(
  lines: string[],
  appVar: string,
  fromIdx: number,
): number {
  const useRe = new RegExp(`^\\s*${appVar}\\.use\\(`);
  for (let i = fromIdx; i < lines.length; i++) {
    if (!useRe.test(lines[i])) continue;
    // Join a few lines so a parameter list broken across lines still parses.
    const joined = lines.slice(i, i + 6).join(" ");
    const rest = joined.slice(joined.indexOf(`${appVar}.use(`) + `${appVar}.use(`.length);
    if (inlineCallbackArity(rest) === 4) return i;
  }
  return -1;
}

export interface ExpressWiring {
  text: string;
  /** Which anchor the error middleware was placed above. */
  errorAnchor: "existing-error-handler" | "listen";
}

/**
 * Wire the Express request + error middleware into `existing` when the entry
 * matches the common shape: a `const app = express()` line followed later by an
 * `app.listen(...)` line.
 *
 * The request middleware line is inserted immediately after the app creation, so
 * it sees every route. The error middleware goes above the FIRST existing error
 * handler when there is one, because a handler that already ended the response
 * means nothing below it ever runs; with no existing handler it goes just above
 * the listen call as before, which is still after the routes.
 *
 * Preserves BOM and EOL style. Returns null when either anchor is missing so the
 * caller can fall back to guidance instead of mis-wiring.
 */
export function wireExpressMiddleware(
  existing: string,
  makeRequestLine: (appVar: string) => string,
  makeErrorLine: (appVar: string) => string,
): ExpressWiring | null {
  const { bom, eol, lines } = analyzeSource(existing);

  let appIdx = -1;
  let appVar = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(EXPRESS_APP_RE);
    if (m) {
      appIdx = i;
      appVar = m[1];
      break;
    }
  }
  if (appIdx < 0) return null;

  let listenIdx = -1;
  for (let i = appIdx + 1; i < lines.length; i++) {
    if (lines[i].includes(`${appVar}.listen(`)) {
      listenIdx = i;
      break;
    }
  }
  if (listenIdx < 0) return null;

  const existingErrIdx = findExistingErrorHandler(lines, appVar, appIdx + 1);
  const errorIdx = existingErrIdx >= 0 ? existingErrIdx : listenIdx;

  const indentOf = (line: string) => line.match(/^\s*/)?.[0] ?? "";
  const out = [...lines];
  // Insert bottom-up so earlier indices stay valid.
  out.splice(errorIdx, 0, indentOf(lines[errorIdx]) + makeErrorLine(appVar));
  out.splice(appIdx + 1, 0, indentOf(lines[appIdx]) + makeRequestLine(appVar));
  return {
    text: bom + out.join(eol),
    errorAnchor: existingErrIdx >= 0 ? "existing-error-handler" : "listen",
  };
}

// --- Flutter main() wiring ---------------------------------------------------

/** `void main() {`, `Future<void> main() async {`, and the shapes between. */
const DART_MAIN_RE =
  /^(\s*)(?:Future<void>|void)\s+main\s*\(\s*\)\s*(async\s+)?\{\s*$/;

/** A Dart import/export directive at the top of a file. */
const DART_IMPORT_RE = /^\s*(?:import|export)\s+['"]/;

/**
 * Wire Crumbtrail into a Flutter `lib/main.dart`.
 *
 * Prepending cannot work here, unlike every JS recipe. Capture has to start
 * *inside* `main`, before `runApp`, and it has to be awaited — the session id
 * from the previous launch is read from disk, and not awaiting it means every
 * cold start opens a new session. So this transforms the function: it inserts
 * the import after the existing directives, makes `main` async when it is not
 * already, and inserts the awaited start call as the first statement.
 *
 * Returns null unless the file has exactly one `main` in a shape it recognises.
 * The caller then falls back to guidance. A near-miss guess here would either
 * fail to compile or, worse, compile while capturing nothing.
 */
export function wireFlutterMain(
  existing: string,
  importLine: string,
  initLines: string[],
): string | null {
  const { bom, eol, lines } = analyzeSource(existing);

  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (DART_MAIN_RE.test(lines[i])) matches.push(i);
  }
  // Zero matches means an arrow-bodied `void main() => runApp(...)`, a main with
  // arguments, or something else entirely. More than one means we cannot tell
  // which is the entry point. Either way, guessing is worse than guidance.
  if (matches.length !== 1) return null;

  const mainIdx = matches[0];
  const match = lines[mainIdx].match(DART_MAIN_RE)!;
  const indent = match[1];
  const isAsync = Boolean(match[2]);

  const out = [...lines];
  // Rewrite the signature when main is synchronous. `Future<void>` rather than
  // `void`: an async function returning void cannot be awaited by anything, and
  // Dart's own lints flag it.
  if (!isAsync) {
    out[mainIdx] = `${indent}Future<void> main() async {`;
  }
  const body = initLines.map((line) => (line ? `${indent}  ${line}` : ""));
  out.splice(mainIdx + 1, 0, ...body, "");

  // Imports must precede declarations in Dart, so the import goes after the last
  // existing directive rather than at the very top — inserting above a
  // `library`/`part of` line would not compile.
  let importIdx = 0;
  for (let i = 0; i < mainIdx; i++) {
    if (DART_IMPORT_RE.test(lines[i])) importIdx = i + 1;
  }
  out.splice(importIdx, 0, importLine);

  return bom + out.join(eol);
}

/** Ensure a create-file body ends in exactly one trailing newline. */
export function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}
