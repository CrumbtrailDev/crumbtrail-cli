// Which backend origins a browser app in this repo actually calls.
//
// `networkCorrelationAllowedOrigins` is the single setting that decides whether
// a frontend session ever joins its backend: the SDK stamps its session,
// request and traceparent headers on same origin calls plus the origins listed
// there, and nowhere else. Left empty — which is what every wizard install
// emitted before this module existed — the browser half and the server half of
// the same click land as two unrelated piles of evidence, and the
// shared_request_id join never happens.
//
// Nothing here guesses. Every origin returned is something the repository
// states in a file: a port a service declares, a dev proxy target, or an API
// base URL the app reads from its own environment. A framework default port is
// NOT evidence — an origin the app never calls costs a CORS preflight on a
// request that had none and sends trace context somewhere it was not wanted.

import path from "node:path";
import { parse } from "@babel/parser";
import type { DetectResult, Recipe } from "./detect";
import type { FileReader } from "./readers/types";

/**
 * Recipes that run a server a browser app can call. Used to decide which of the
 * services being wired in one run can contribute an origin to its siblings'
 * correlation list; a browser app never contributes one.
 */
const BACKEND_RECIPES = new Set<Recipe>([
  "express",
  "fastify",
  "hono",
  "nestjs",
  "node",
  "otlp",
]);

export function isBackendRecipe(recipe: Recipe | null | undefined): boolean {
  return recipe != null && BACKEND_RECIPES.has(recipe);
}

/** Env files that may declare an app's local port. */
const ENV_FILES = [
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
];

/** Dev-server / proxy configs that name a backend target outright. */
const PROXY_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "nuxt.config.ts",
  "nuxt.config.js",
  "svelte.config.js",
  "proxy.conf.json",
  "proxy.conf.js",
  "angular.json",
];

/**
 * `target:` (Vite / Angular proxy) and `destination:` (Next rewrites) carrying
 * an absolute URL. A relative destination is a same origin rewrite and needs no
 * entry, so the `https?://` is part of the match rather than filtered after.
 */
const PROXY_TARGET_RE =
  /["']?(?:target|destination)["']?\s*:\s*["'`](https?:\/\/[^"'`\s]+)["'`]/gi;

/** `VITE_API_ORIGIN`, `NEXT_PUBLIC_API_URL`, `PUBLIC_BACKEND_BASE_URL`, … */
const API_BASE_VAR_RE = /^[A-Z0-9_]*(?:API|BACKEND|SERVER)[A-Z0-9_]*$/;

function parseProgram(source: string): any | null {
  for (const jsx of [false, true]) {
    try {
      return parse(source, {
        sourceType: "unambiguous",
        plugins: [
          "typescript",
          ...(jsx ? (["jsx"] as const) : []),
          "decorators-legacy",
        ],
      }).program;
    } catch {
      continue;
    }
  }
  return null;
}

function directServerPort(source: string): number | null {
  const program = parseProgram(source);
  if (!program) return null;
  const found = new Set<number>();
  const literalFallback = (expression: any): number | null => {
    if (expression?.type === "NumericLiteral") return Number(expression.value);
    if (
      expression?.type === "LogicalExpression" &&
      (expression.operator === "??" || expression.operator === "||") &&
      /(?:process\.)?env\.PORT/.test(
        source.slice(expression.left.start, expression.left.end),
      ) &&
      expression.right.type === "NumericLiteral"
    )
      return Number(expression.right.value);
    return null;
  };
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression") {
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "listen" &&
        node.arguments[0]
      ) {
        const value = literalFallback(node.arguments[0]);
        if (value != null) found.add(value);
      }
      if (node.callee.type === "Identifier" && node.callee.name === "serve") {
        const object = node.arguments.find(
          (argument: any) => argument.type === "ObjectExpression",
        );
        const port = object?.properties.find(
          (property: any) =>
            property.type === "ObjectProperty" &&
            (property.key.name ?? property.key.value) === "port",
        );
        if (port?.value) {
          const value = literalFallback(port.value);
          if (value != null) found.add(value);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && "type" in value)
        visit(value);
    }
  };
  visit(program);
  return found.size === 1 ? [...found][0] : found.size > 1 ? Number.NaN : null;
}

function directLiteralServerPort(source: string): number | null {
  const program = parseProgram(source);
  if (!program) return null;
  const found = new Set<number>();
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression") {
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "listen" &&
        node.arguments[0]?.type === "NumericLiteral"
      )
        found.add(Number(node.arguments[0].value));
      if (node.callee.type === "Identifier" && node.callee.name === "serve") {
        const object = node.arguments.find(
          (argument: any) => argument.type === "ObjectExpression",
        );
        const port = object?.properties.find(
          (property: any) =>
            property.type === "ObjectProperty" &&
            (property.key.name ?? property.key.value) === "port",
        );
        if (port?.value?.type === "NumericLiteral")
          found.add(Number(port.value.value));
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && "type" in value)
        visit(value);
    }
  };
  visit(program);
  return found.size === 1 ? [...found][0] : found.size > 1 ? Number.NaN : null;
}

/**
 * Resolve a validated ternary fallback whose value is derived from PORT.
 * Taint is deliberately local and declaration based: a cache port ternary in
 * the same entry cannot become the HTTP origin merely because it is nearby.
 */
function validatedPortFallback(source: string): number | null {
  const program = parseProgram(source);
  if (!program) return null;
  const resolvers = new Map<string, any>();
  for (const statement of program.body as any[])
    if (statement.type === "FunctionDeclaration" && statement.id)
      resolvers.set(statement.id.name, statement);
  const selected = new Set<any>();
  const visit = (
    node: any,
    declarations: ReadonlyMap<string, any> = new Map(),
  ): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Program" || node.type === "BlockStatement") {
      const blockDeclarations = new Map(declarations);
      for (const statement of node.body as any[]) {
        if (statement.type === "VariableDeclaration")
          for (const declaration of statement.declarations)
            if (declaration.id?.type === "Identifier" && declaration.init)
              blockDeclarations.set(declaration.id.name, declaration.init);
        if (statement.type !== "FunctionDeclaration")
          visit(statement, blockDeclarations);
      }
      return;
    }
    if (/^(?:Function|ArrowFunction|ObjectMethod|ClassMethod)/.test(node.type))
      return;
    if (node.type === "CallExpression") {
      const linked: any[] = [];
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "listen" &&
        node.arguments[0]
      )
        linked.push(node.arguments[0]);
      if (node.callee.type === "Identifier" && node.callee.name === "serve") {
        const object = node.arguments.find(
          (argument: any) => argument.type === "ObjectExpression",
        );
        const port = object?.properties.find(
          (property: any) =>
            property.type === "ObjectProperty" &&
            (property.key.name ?? property.key.value) === "port",
        );
        if (port) linked.push(port.value);
      }
      for (const expression of linked) {
        let resolved = expression;
        const seen = new Set<string>();
        while (
          resolved?.type === "Identifier" &&
          declarations.has(resolved.name) &&
          !seen.has(resolved.name)
        ) {
          seen.add(resolved.name);
          resolved = declarations.get(resolved.name);
        }
        if (
          resolved?.type === "CallExpression" &&
          resolved.callee.type === "Identifier"
        ) {
          const resolver = resolvers.get(resolved.callee.name);
          if (resolver) selected.add(resolver);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        value.forEach((item) => visit(item, declarations));
      else if (value && typeof value === "object" && "type" in value)
        visit(value, declarations);
    }
  };
  visit(program);
  const values = new Set<number>();
  for (const resolver of selected) {
    const declarations = new Map<string, any>();
    let decision: any;
    for (const statement of resolver.body.body) {
      if (statement.type === "VariableDeclaration") {
        for (const declaration of statement.declarations)
          if (declaration.id.type === "Identifier" && declaration.init)
            declarations.set(declaration.id.name, declaration.init);
      } else if (
        statement.type === "ReturnStatement" &&
        statement.argument?.type === "ConditionalExpression"
      )
        decision = statement.argument;
    }
    if (!decision || decision.alternate.type !== "NumericLiteral") continue;
    const tainted = new Set<string>();
    const mentionsPort = (node: any): boolean => {
      if (
        /^(?:process\.)?env(?:\.PORT|\[.*PORT.*\])$/.test(
          source.slice(node.start, node.end),
        )
      )
        return true;
      if (node.type === "Identifier" && tainted.has(node.name)) return true;
      return Object.values(node).some((value) =>
        Array.isArray(value)
          ? value.some(mentionsPort)
          : Boolean(
              value &&
              typeof value === "object" &&
              "type" in value &&
              mentionsPort(value),
            ),
      );
    };
    for (let pass = 0; pass < declarations.size; pass++) {
      let changed = false;
      for (const [name, expression] of declarations) {
        if (!tainted.has(name) && mentionsPort(expression)) {
          tainted.add(name);
          changed = true;
        }
      }
      if (!changed) break;
    }
    if (mentionsPort(decision.test) || mentionsPort(decision.consequent))
      values.add(Number(decision.alternate.value));
  }
  return values.size === 1
    ? [...values][0]
    : values.size > 1
      ? Number.NaN
      : null;
}

function safeRead(file: string, reader: FileReader): string | null {
  if (!reader.isFile(file)) return null;
  try {
    return reader.readFile(file);
  } catch {
    return null;
  }
}

/** `https://api.example.com/v1?x=1` → `https://api.example.com`; junk → null. */
function toOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Insertion-ordered dedupe, so the strongest evidence stays first. */
function unique(origins: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const origin of origins) {
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

/** Every `KEY=value` pair in an env file body, comments and blanks skipped. */
function envPairs(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["'`]|["'`]$/g, "");
    if (key) pairs.push([key, value]);
  }
  return pairs;
}

/**
 * The port a backend service declares for itself: an explicit `PORT` in one of
 * its env files first, then a literal in the entry file detection resolved.
 * Null when the repository never says — a framework default is not evidence.
 */
export function resolveServicePort(
  dir: string,
  entryFile: string | null | undefined,
  reader: FileReader,
): number | null {
  const portsIn = (text: string): Set<number> =>
    new Set(
      [...text.matchAll(/^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})["']?\s*$/gm)].map(
        (match) => Number(match[1]),
      ),
    );
  let activeEnvPort: number | null = null;
  for (const file of ENV_FILES) {
    const text = safeRead(path.join(dir, file), reader);
    if (!text) continue;
    const ports = portsIn(text);
    if (ports.size === 1) {
      activeEnvPort = [...ports][0];
      break;
    }
    if (ports.size > 1) return null;
  }
  const entry = entryFile ? safeRead(entryFile, reader) : null;
  if (entry) {
    const literal = directLiteralServerPort(entry);
    const direct = directServerPort(entry);
    const fallback = validatedPortFallback(entry);
    if (
      Number.isNaN(literal) ||
      Number.isNaN(direct) ||
      Number.isNaN(fallback)
    )
      return null;
    if (literal != null) {
      if (activeEnvPort != null && activeEnvPort !== literal) return null;
      const sourceValues = new Set(
        [direct, fallback].filter((value): value is number => value != null),
      );
      return sourceValues.size === 1 ? literal : null;
    }
    if (activeEnvPort != null) return activeEnvPort;
    const values = new Set(
      [direct, fallback].filter((value): value is number => value != null),
    );
    if (values.size === 1) return [...values][0];
    if (values.size > 1) return null;
  }
  if (activeEnvPort != null) return activeEnvPort;
  const example = safeRead(path.join(dir, ".env.example"), reader);
  if (example) {
    const ports = portsIn(example);
    if (ports.size === 1) return [...ports][0];
    if (ports.size > 1) return null;
  }
  return null;
}

/**
 * The dev origins of one backend service being wired in this same run.
 *
 * Both spellings of the loopback address are returned because they are distinct
 * browser origins for one server, and which of the two a frontend's API base
 * uses is a coin flip — listing only the other one is precisely the silent
 * half-wiring this module exists to end.
 */
export function backendServiceOrigins(
  dir: string,
  detected: Pick<DetectResult, "entryFile">,
  reader: FileReader,
): string[] {
  const port = resolveServicePort(dir, detected.entryFile, reader);
  if (port == null) return [];
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * The backend origins THIS app names for itself: dev server proxy targets, and
 * absolute API base URLs in its own env files. These are the app's own
 * statement about where its data comes from, so they cover the deployed origin
 * a sibling scan can never see.
 */
export function declaredBackendOrigins(
  dir: string,
  reader: FileReader,
): string[] {
  const found: (string | null)[] = [];

  for (const file of PROXY_CONFIG_FILES) {
    const text = safeRead(path.join(dir, file), reader);
    if (!text) continue;
    for (const match of text.matchAll(PROXY_TARGET_RE)) {
      found.push(toOrigin(match[1]));
    }
  }

  for (const file of ENV_FILES) {
    const text = safeRead(path.join(dir, file), reader);
    if (!text) continue;
    for (const [key, value] of envPairs(text)) {
      if (!API_BASE_VAR_RE.test(key)) continue;
      if (!/^https?:\/\//i.test(value)) continue;
      found.push(toOrigin(value));
    }
  }

  return unique(found);
}

export interface SiblingService {
  dir: string;
  detected: Pick<DetectResult, "entryFile">;
}

/**
 * Everything the wizard can honestly put in `networkCorrelationAllowedOrigins`
 * for one browser app: what the app itself declares, then the dev origins of
 * the backend services being wired beside it in the same run.
 *
 * The app's own directory is never one of `siblings` — a service listing its
 * own origin would be a same origin call, already joined.
 */
export function resolveBackendOrigins(
  appDir: string,
  reader: FileReader,
  siblings: readonly SiblingService[] = [],
): string[] {
  const declared = declaredBackendOrigins(appDir, reader);
  const fromSiblings = siblings
    .filter((s) => path.resolve(s.dir) !== path.resolve(appDir))
    .flatMap((s) => backendServiceOrigins(s.dir, s.detected, reader));
  return unique([...declared, ...fromSiblings]);
}
