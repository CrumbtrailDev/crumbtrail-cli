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
 * Every SDK package is listed, not just the two the web and node recipes
 * install: a React Native entry imports `crumbtrail-react-native` and a
 * Capacitor entry imports `crumbtrail-capacitor`, and neither mentions
 * `crumbtrail-core`, so a narrower pattern let an already-wired mobile app be
 * wired a second time. `crumbtrail_flutter` is included because Dart is the one
 * ecosystem whose package name is not spelled with a hyphen, and an underscore
 * name would not match the JS pattern.
 */
export function referencesCrumbtrail(text: string): boolean {
  return /crumbtrail-core|crumbtrail-node|crumbtrail-react-native|crumbtrail-capacitor|crumbtrail_flutter/.test(
    text,
  );
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
const EXPRESS_APP_RE =
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*express\s*\(\s*\)/;

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
    const rest = joined.slice(
      joined.indexOf(`${appVar}.use(`) + `${appVar}.use(`.length,
    );
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

// --- CORS allowedHeaders widening --------------------------------------------

/**
 * The three headers the browser SDK stamps on a cross-origin request once its
 * origin is listed in `networkCorrelationAllowedOrigins`.
 */
export const CORRELATION_REQUEST_HEADERS = [
  "x-crumbtrail-session-id",
  "x-crumbtrail-request-id",
  "traceparent",
] as const;

export interface CorsWidening {
  /** The rewritten source. Equal to the input when `changed` is false. */
  text: string;
  /** True when an `allowedHeaders` / `allowHeaders` list was actually widened. */
  changed: boolean;
  /**
   * Set when a CORS config was found but its header list is not a literal we
   * can safely rewrite (a variable, a spread, a computed value). The caller
   * prints the exact change instead of guessing at it.
   */
  needsManual: boolean;
  /**
   * True when this file pulls in a CORS middleware at all. False means either
   * the service is same-origin — nothing to do — or its CORS lives in another
   * file, which is the case that used to fail silently.
   */
  found: boolean;
  /**
   * Set when `found` is false but this file imports something whose module path
   * or binding is named after CORS — `import { cors } from "./middleware/cors"`.
   * The file almost certainly does have CORS, one hop away, so the wizard must
   * not assert there is none. This is a name check on this file's own import
   * lines, deliberately not an import graph walk.
   */
  importsCorsElsewhere: boolean;
}

/**
 * Only files that actually pull in a CORS middleware are considered. All the
 * middlewares the wizard's own backend recipes can be wired alongside are
 * listed: Express (`cors`), Hono (`hono/cors`), Fastify (`@fastify/cors`) and
 * Koa (`@koa/cors`). A middleware missing from this list means its app is
 * wired for correlation and left with a header allowlist that blocks it.
 */
const CORS_IMPORT_RE = new RegExp(
  [
    String.raw`from\s*["'](?:cors|hono/cors|@fastify/cors|fastify-cors|@koa/cors|koa2-cors|koa-cors)["']`,
    String.raw`require\(\s*["'](?:cors|hono/cors|@fastify/cors|fastify-cors|@koa/cors|koa2-cors|koa-cors)["']\s*\)`,
    String.raw`import\(\s*["'](?:@fastify/cors|fastify-cors)["']\s*\)`,
  ].join("|"),
);

/**
 * Any import or require line in THIS file that is named after CORS — a local
 * module path (`./middleware/cors`), or a binding (`cors`, `corsMiddleware`,
 * `applyCors`). It exists to stop the wizard asserting "no CORS middleware in
 * this file" about a Hono entry whose first line is
 * `import { cors } from "./middleware/cors"`. A false positive only softens a
 * note, so the check is deliberately loose and deliberately local.
 */
const CORS_REFERENCE_RE = new RegExp(
  [
    String.raw`^\s*import\s[^;\n]*cors[^;\n]*$`,
    String.raw`^\s*import\s[^;\n]*from\s*["'][^"'\n]*cors[^"'\n]*["']`,
    String.raw`(?:require|import)\(\s*["'][^"'\n]*cors[^"'\n]*["']\s*\)`,
    String.raw`^\s*(?:const|let|var)\s[^=\n]*cors[^=\n]*=\s*(?:await\s+)?(?:require|import)\(`,
  ].join("|"),
  "im",
);

/** True when this file mentions CORS on an import line but configures none. */
export function referencesCorsElsewhere(text: string): boolean {
  return CORS_REFERENCE_RE.test(text);
}

/** Server frameworks and runtimes whose presence means this process answers HTTP. */
const HTTP_FRAMEWORKS = [
  "express",
  "fastify",
  "hono",
  "koa",
  "restify",
  "polka",
  "connect",
  "@hapi/hapi",
  "@nestjs/core",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "apollo-server",
  "@apollo/server",
  "next",
  "nuxt",
] as const;

const HTTP_MODULE_RE = new RegExp(
  String.raw`(?:from\s*|require\s*\(\s*)["'](?:node:)?(?:http|https|http2|${HTTP_FRAMEWORKS.map(
    (name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
  ).join("|")})(?:/[\w./@-]*)?["']`,
  "m",
);

/** `app.listen(...)`, `server.listen(...)`, `createServer(`, `Bun.serve(`, `Deno.serve(`. */
const HTTP_LISTEN_RE =
  /\.listen\s*\(|createServer\s*\(|\b(?:Bun|Deno)\.serve\s*\(|\bserve\s*\(\s*\{/;

/**
 * Whether this process answers HTTP at all.
 *
 * The CORS guidance below is fifteen lines with three framework snippets, and it
 * is only ever actionable for a process that serves browser requests. A package
 * that is a bare `setInterval` worker got the whole lecture, which reads as the
 * wizard not having looked at the code.
 *
 * Two sources, because the entry alone is not always enough: the scanned entry's
 * own imports and listen calls, and — for an entry that only calls a `bootstrap()`
 * living in another file — the package's declared dependencies. Either one is
 * enough; a worker package has neither.
 */
export function servesHttp(
  entrySource: string | null | undefined,
  packageJson?: string | null,
): boolean {
  if (entrySource) {
    if (HTTP_MODULE_RE.test(entrySource)) return true;
    if (HTTP_LISTEN_RE.test(entrySource)) return true;
  }
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as Record<string, unknown>;
      const deps = new Set<string>();
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ]) {
        const value = parsed[field];
        if (value && typeof value === "object") {
          for (const name of Object.keys(value)) deps.add(name);
        }
      }
      if (HTTP_FRAMEWORKS.some((name) => deps.has(name))) return true;
    } catch {
      // Unparseable package.json: fall through to the entry's own evidence.
    }
  }
  return false;
}

/** `allowedHeaders:` (Express `cors`) or `allowHeaders:` (Hono `cors`). */
const ALLOW_HEADERS_KEY = String.raw`\ballow(?:ed)?Headers\s*:\s*`;

const ARRAY_FORM = new RegExp(`(${ALLOW_HEADERS_KEY})\\[([^\\[\\]]*)\\]`, "g");
const STRING_FORM = new RegExp(
  `(${ALLOW_HEADERS_KEY})(["'])([^"'\\n]*)\\2`,
  "g",
);
const ANY_FORM = new RegExp(ALLOW_HEADERS_KEY, "g");

/** An array body made only of string literals, commas and whitespace. */
const LITERAL_ARRAY_BODY_RE =
  /^\s*(?:(["'])[^"'\n]*\1\s*,\s*)*(?:(["'])[^"'\n]*\2\s*,?\s*)?$/;

function quoteStyleOf(body: string): '"' | "'" {
  return body.includes("'") && !body.includes('"') ? "'" : '"';
}

/**
 * Widens an explicit CORS header allowlist to admit Crumbtrail's correlation
 * headers.
 *
 * Turning on correlation makes every cross-origin request preflighted. A
 * backend pinning `allowedHeaders: ["Content-Type", "Authorization"]` answers
 * that preflight without the three names the browser is now sending, and the
 * browser then blocks the application's own request. Wiring a backend and
 * leaving its CORS config alone is therefore wiring a broken app, so the
 * widening is part of the wiring rather than a note the user may or may not act
 * on.
 *
 * Deliberately narrow. Only a literal list is rewritten: an array of string
 * literals, or a single comma separated string. A config with no header list at
 * all is left alone and is already correct — both middlewares then echo the
 * browser's requested headers. Anything computed sets `needsManual` and is not
 * touched, because a wrong guess here breaks CORS in a second, different way.
 */
export function widenCorsAllowedHeaders(text: string): CorsWidening {
  if (!CORS_IMPORT_RE.test(text)) {
    return {
      text,
      changed: false,
      needsManual: false,
      found: false,
      importsCorsElsewhere: referencesCorsElsewhere(text),
    };
  }

  let changed = false;
  let handled = 0;

  let out = text.replace(ARRAY_FORM, (match, key: string, body: string) => {
    if (!LITERAL_ARRAY_BODY_RE.test(body)) return match;
    handled++;
    const present = new Set(
      (body.match(/(["'])([^"'\n]*)\1/g) ?? []).map((literal) =>
        literal.slice(1, -1).toLowerCase(),
      ),
    );
    const missing = CORRELATION_REQUEST_HEADERS.filter(
      (name) => !present.has(name),
    );
    if (missing.length === 0) return match;
    changed = true;
    const quote = quoteStyleOf(body);
    const additions = missing
      .map((name) => `${quote}${name}${quote}`)
      .join(", ");
    const trimmed = body.trim();
    if (trimmed.length === 0) return `${key}[${additions}]`;
    const separator = trimmed.endsWith(",") ? " " : ", ";
    return `${key}[${body.replace(/\s+$/, "")}${separator}${additions}]`;
  });

  out = out.replace(
    STRING_FORM,
    (match, key: string, quote: string, body: string) => {
      handled++;
      const present = new Set(
        body
          .split(",")
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean),
      );
      const missing = CORRELATION_REQUEST_HEADERS.filter(
        (name) => !present.has(name),
      );
      if (missing.length === 0) return match;
      changed = true;
      const joined = [body.trim().replace(/,$/, ""), ...missing]
        .filter(Boolean)
        .join(",");
      return `${key}${quote}${joined}${quote}`;
    },
  );

  const total = (text.match(ANY_FORM) ?? []).length;
  return {
    text: out,
    changed,
    needsManual: handled < total,
    found: true,
    importsCorsElsewhere: false,
  };
}

/** A literal header array in a hand-written CORS middleware module. */
const CUSTOM_HEADER_ARRAY_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*HEADERS[\w$]*)\s*=\s*\[([^\]]*)\]/gi;

/**
 * Widen a hand-written CORS middleware after the import resolver has proved
 * that this is the module the server installs.
 *
 * This intentionally does not run on arbitrary source. The module must emit
 * `Access-Control-Allow-Headers`, and the chosen literal must be an allowlist
 * owned by the application. Standard safelists are excluded because changing
 * their meaning would make the code lie about the protocol definition.
 */
export function widenCustomCorsAllowedHeaders(
  text: string,
  installedBinding?: string,
): CorsWidening {
  const regular = installedBinding ? null : widenCorsAllowedHeaders(text);
  if (regular?.found) return regular;
  if (!installedBinding && !/Access-Control-Allow-Headers/i.test(text)) {
    return regular!;
  }

  const braceDepth: number[] = [];
  let depth = 0;
  let stringQuote: string | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    braceDepth[i] = depth;
    const char = text[i];
    if (stringQuote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === stringQuote) stringQuote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      stringQuote = char;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
  }

  let policyStart = 0;
  let policyEnd = text.length;
  if (installedBinding) {
    const escapedBinding = installedBinding.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const declaration = new RegExp(
      `\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escapedBinding}\\s*\\([^)]*\\)\\s*\\{`,
    ).exec(text);
    if (declaration?.index == null) {
      return {
        text,
        changed: false,
        needsManual: true,
        found: true,
        importsCorsElsewhere: false,
      };
    }
    const open = declaration.index + declaration[0].lastIndexOf("{");
    const functionDepth = braceDepth[open] + 1;
    let close = open + 1;
    while (close < text.length && braceDepth[close] >= functionDepth) close++;
    policyStart = open + 1;
    policyEnd = close;
    const scoped = widenCorsAllowedHeaders(text.slice(policyStart, policyEnd));
    if (scoped.found) {
      return {
        ...scoped,
        text: `${text.slice(0, policyStart)}${scoped.text}${text.slice(policyEnd)}`,
      };
    }
    if (
      !/Access-Control-Allow-Headers/i.test(text.slice(policyStart, policyEnd))
    ) {
      return {
        text,
        changed: false,
        needsManual: true,
        found: true,
        importsCorsElsewhere: false,
      };
    }
  }

  const declarations = new Map<string, string>();
  for (const match of text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g,
  )) {
    if (match.index == null || braceDepth[match.index] !== 0) continue;
    declarations.set(match[1], match[2]);
  }
  const referenced = new Set<string>();
  for (const match of text.matchAll(/Access-Control-Allow-Headers/gi)) {
    if (
      match.index == null ||
      match.index < policyStart ||
      match.index >= policyEnd
    )
      continue;
    const context = text.slice(
      match.index,
      Math.min(match.index + 240, policyEnd),
    );
    for (const identifier of context.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (declarations.has(identifier)) referenced.add(identifier);
    }
  }
  for (let pass = 0; pass < declarations.size; pass++) {
    let changed = false;
    for (const name of [...referenced]) {
      const expression = declarations.get(name);
      if (!expression) continue;
      for (const identifier of expression.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (!declarations.has(identifier) || referenced.has(identifier))
          continue;
        referenced.add(identifier);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const candidates: Array<{
    start: number;
    end: number;
    full: string;
    name: string;
    body: string;
    score: number;
  }> = [];
  for (const match of text.matchAll(CUSTOM_HEADER_ARRAY_RE)) {
    const name = match[1] ?? "";
    if (/SAFE(?:LIST|LISTED)/i.test(name)) continue;
    const body = match[2] ?? "";
    const score = /CONFIGUR/i.test(name)
      ? 3
      : /ALLOW(?:ED)?/i.test(name)
        ? 2
        : /CORS/i.test(name)
          ? 1
          : 0;
    if (
      score === 0 ||
      match.index == null ||
      braceDepth[match.index] !== 0 ||
      !referenced.has(name) ||
      !LITERAL_ARRAY_BODY_RE.test(body)
    )
      continue;
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      full: match[0],
      name,
      body,
      score,
    });
  }
  if (candidates.length > 1) {
    return {
      text,
      changed: false,
      needsManual: true,
      found: true,
      importsCorsElsewhere: false,
    };
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const selected = candidates[0];
  if (!selected) {
    return {
      text,
      changed: false,
      needsManual: true,
      found: true,
      importsCorsElsewhere: false,
    };
  }

  const present = new Set(
    (selected.body.match(/(["'])([^"'\n]*)\1/g) ?? []).map((literal) =>
      literal.slice(1, -1).toLowerCase(),
    ),
  );
  const missing = CORRELATION_REQUEST_HEADERS.filter(
    (name) => !present.has(name),
  );
  if (missing.length === 0) {
    return {
      text,
      changed: false,
      needsManual: false,
      found: true,
      importsCorsElsewhere: false,
    };
  }

  const quote = quoteStyleOf(selected.body);
  const additions = missing.map((name) => `${quote}${name}${quote}`).join(", ");
  const trimmed = selected.body.trim();
  const separator =
    trimmed.length === 0 ? "" : trimmed.endsWith(",") ? " " : ", ";
  const replacement = selected.full.replace(
    `[${selected.body}]`,
    `[${selected.body.replace(/\s+$/, "")}${separator}${additions}]`,
  );
  return {
    text: `${text.slice(0, selected.start)}${replacement}${text.slice(selected.end)}`,
    changed: true,
    needsManual: false,
    found: true,
    importsCorsElsewhere: false,
  };
}

const HEADER_LIST = CORRELATION_REQUEST_HEADERS.map((n) => `"${n}"`).join(", ");

/** The exact lines a user must add when the config cannot be rewritten safely. */
export function corsWideningGuidance(): string {
  return [
    "Add Crumbtrail's correlation headers to your CORS allowed headers, or cross origin requests from the browser will be blocked by the preflight:",
    `  Express (cors): cors({ allowedHeaders: ["Content-Type", "Authorization", ${HEADER_LIST}] })`,
    `  Hono: cors({ allowHeaders: [${HEADER_LIST}] })`,
    `  Fastify (@fastify/cors): app.register(cors, { allowedHeaders: ["Content-Type", "Authorization", ${HEADER_LIST}] })`,
  ].join("\n");
}

/**
 * Said when a backend is wired and no CORS middleware was found in the file we
 * edited. The wizard cannot see a CORS config that lives in another file, and
 * saying nothing was the failure: the browser SDK starts stamping three headers
 * on every cross origin call, and an allowlist that predates them answers the
 * preflight without them, so the app's own requests get blocked. Naming the
 * headers is what makes that recoverable in seconds instead of a bisect.
 */
export function corsElsewhereGuidance(): string {
  return [
    `No CORS middleware in this file. If this service answers browser requests from another origin, whichever file configures its CORS must allow ${CORRELATION_REQUEST_HEADERS.join(", ")}, or the preflight blocks every cross origin request once correlation is on.`,
    corsWideningGuidance(),
  ].join("\n");
}

/**
 * Said instead of the above when the file imports something named after CORS.
 * The wizard could not read that other file, so it has no business claiming
 * there is no CORS middleware, and no business printing three framework
 * snippets for a config it has not seen. It names the headers and stops there.
 */
export function corsImportedElsewhereNote(): string {
  return `This file configures no CORS itself but imports CORS from another module, which Crumbtrail did not read. If that config pins an allowed headers list, it needs ${CORRELATION_REQUEST_HEADERS.join(", ")} added, or the preflight blocks every cross origin request once correlation is on.`;
}

// ── Static frontends ─────────────────────────────────────────────────────────

/** Whether this HTML already carries a Crumbtrail script tag. */
export function htmlReferencesCrumbtrail(html: string): boolean {
  return /crumbtrail/i.test(html);
}

/**
 * Put a block into an HTML document, as late in `<head>` as possible.
 *
 * Order matters more here than in a module graph: capture has to be installed
 * before the page's own scripts run, or the errors it exists to record happen
 * first and are gone. `</head>` is therefore the target, with `<body>` and then
 * `</body>` as fallbacks for the many real pages that have neither a head nor a
 * closing tag. A file with no HTML structure at all returns null rather than
 * having a script tag guessed into it.
 */
export function insertIntoHtmlHead(html: string, block: string): string | null {
  // Indent the block to match the tag it lands above, and insert at the START
  // of that tag's line so the tag keeps its own indentation. Splicing at the tag
  // itself left the first emitted line wearing the closing tag's whitespace and
  // every later line wearing a different amount — a diff that reads as damage.
  const spliceBefore = (at: number): string => {
    const lineStart = html.lastIndexOf("\n", at - 1) + 1;
    const lead = html.slice(lineStart, at);
    const indent = /^[ \t]*$/.exec(lead)?.[0] ?? lead.match(/^[ \t]*/)![0];
    const indented = block
      .split("\n")
      .map((line) => (line ? `${indent}${line}` : line))
      .join("\n");
    // A tag alone on its line takes the block on the lines above it. A tag with
    // code before it on the same line — `<head><title>x</title></head>`, which is
    // most hand-written pages — must be split instead, or the block lands
    // OUTSIDE the element it was supposed to go inside.
    if (/^[ \t]*$/.test(lead)) {
      return `${html.slice(0, lineStart)}${indented}\n${html.slice(lineStart)}`;
    }
    return `${html.slice(0, at)}\n${indented}\n${indent}${html.slice(at)}`;
  };
  const closeHead = /<\/head\s*>/i.exec(html);
  if (closeHead) return spliceBefore(closeHead.index);
  const openBody = /<body\b[^>]*>/i.exec(html);
  if (openBody) {
    const at = openBody.index + openBody[0].length;
    const indented = block
      .split("\n")
      .map((line) => (line ? `  ${line}` : line))
      .join("\n");
    return `${html.slice(0, at)}\n${indented}${html.slice(at)}`;
  }
  const closeBody = /<\/body\s*>/i.exec(html);
  if (closeBody) return spliceBefore(closeBody.index);
  return null;
}

/**
 * Directories an Express app serves as static files.
 *
 * `express.static(...)` is how a Node service ships a frontend, and that
 * frontend is half the app's evidence — it was the half the wizard was blind to,
 * because detection stops at the backend dependency and never looks at what the
 * backend serves.
 *
 * Deliberately literal-only. The argument is usually
 * `path.join(__dirname, "public")` or `"public"`, and the LAST string literal in
 * the call is the directory in both shapes. A call built from a variable yields
 * nothing rather than a guess, and the caller says so instead of editing a file
 * it inferred.
 */
export function findStaticMountDirs(source: string): string[] {
  const dirs: string[] = [];
  const callRes = [
    /\bexpress\s*\.\s*static\s*\(([^)]*)\)/gi,
    /\bserveStatic\s*\(([^)]*)\)/gi,
  ];
  for (const callRe of callRes) {
    for (const match of source.matchAll(callRe)) {
      const literals = [...match[1].matchAll(/["'`]([^"'`]*)["'`]/g)].map(
        (m) => m[1],
      );
      const dir = literals[literals.length - 1];
      if (!dir || /^https?:/i.test(dir)) continue;
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}
