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

/** Env files an app's own configuration is read from, most specific first. */
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.example"];

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

/** A port a service declares for itself, in an env file or its entry source. */
const ENV_PORT_RE = /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m;

const ENTRY_PORT_RES = [
  // `port: 3000`, `PORT = 3000`
  /\bport\s*[:=]\s*(\d{2,5})\b/i,
  // `app.listen(3000`, `serve({ ... }, 3000`
  /\.listen\(\s*(\d{2,5})\b/,
  // `process.env.PORT ?? 3000`, `env.PORT || 3000`
  /\bPORT\b[^\n]{0,80}?(?:\?\?|\|\|)\s*(\d{2,5})\b/,
];

/**
 * Resolve a validated ternary fallback whose value is derived from PORT.
 * Taint is deliberately local and declaration based: a cache port ternary in
 * the same entry cannot become the HTTP origin merely because it is nearby.
 */
function validatedPortFallback(source: string): number | null {
  const tainted = new Set<string>();
  const declarations: Array<{ name: string; expression: string }> = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/,
    );
    if (!match) continue;
    declarations.push({ name: match[1], expression: match[2] });
  }
  for (let pass = 0; pass < declarations.length; pass++) {
    let changed = false;
    for (const declaration of declarations) {
      if (tainted.has(declaration.name)) continue;
      const fromPort = /(?:process\.)?env(?:\[["']PORT["']\]|\.PORT)\b/.test(
        declaration.expression,
      );
      const fromTainted = [...tainted].some((name) =>
        new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
          declaration.expression,
        ),
      );
      if (!fromPort && !fromTainted) continue;
      tainted.add(declaration.name);
      changed = true;
    }
    if (!changed) break;
  }
  for (const declaration of declarations) {
    if (declaration.name.toLowerCase() !== "port") continue;
    const match = declaration.expression.match(/\?\s*([^:\n]+):\s*(\d{2,5})\b/);
    if (!match) continue;
    if (
      [...tainted].some((name) =>
        new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
          `${declaration.expression.slice(0, match.index)} ${match[1]}`,
        ),
      )
    ) {
      return Number(match[2]);
    }
  }
  return null;
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
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
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
  for (const file of ENV_FILES) {
    const text = safeRead(path.join(dir, file), reader);
    const match = text?.match(ENV_PORT_RE);
    if (match) return Number(match[1]);
  }
  const entry = entryFile ? safeRead(entryFile, reader) : null;
  if (entry) {
    for (const re of ENTRY_PORT_RES) {
      const match = entry.match(re);
      if (match) return Number(match[1]);
    }
    const fallback = validatedPortFallback(entry);
    if (fallback != null) return fallback;
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
