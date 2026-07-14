// Pure snippet builders. These produce the exact code Crumbtrail injects, with
// the live endpoint + key threaded through (no hardcoding). Client stacks use
// the README's canonical init shape; the Node recipe uses crumbtrail-node's
// documented headless-session API and reads the key from the environment.

/**
 * Client init block (Next / SvelteKit / Vite). Matches the README exactly:
 *   import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";
 *   Crumbtrail.init({ ...PRESET_PASSIVE, httpEndpoint, httpAuthToken });
 * The ingest key is inlined — it ships in the client bundle anyway (ingest-only,
 * same posture as a Sentry DSN).
 */
export function clientInitSnippet(endpoint: string, apiKey: string): string {
  return [
    'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    "",
    "Crumbtrail.init({",
    "  ...PRESET_PASSIVE,",
    `  httpEndpoint: ${JSON.stringify(endpoint)},`,
    `  httpAuthToken: ${JSON.stringify(apiKey)},`,
    "});",
  ].join("\n");
}

/**
 * Nuxt client plugin. Wraps the same init in `defineNuxtPlugin` (auto-imported
 * by Nuxt) so it runs client-side on startup.
 */
export function nuxtPluginSnippet(endpoint: string, apiKey: string): string {
  return [
    'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    "",
    "export default defineNuxtPlugin(() => {",
    "  Crumbtrail.init({",
    "    ...PRESET_PASSIVE,",
    `    httpEndpoint: ${JSON.stringify(endpoint)},`,
    `    httpAuthToken: ${JSON.stringify(apiKey)},`,
    "  });",
    "});",
  ].join("\n");
}

/**
 * Node server init. Uses crumbtrail-node's `autoCapture`, which installs
 * best-effort backend crash + console.error capture (uncaught exceptions,
 * unhandled rejections, console.error) around a headless ingest session. It is
 * dynamically imported so the block is valid whether the entry file is ESM,
 * CommonJS, or TypeScript, and it is a plain expression (no top-level await) so
 * it is safe to prepend at the very top of an entry file. The ingest key is read
 * from process.env.CRUMBTRAIL_KEY, which autoCapture loads from `.env` (written by
 * the CLI) itself — never inlined server-side. Express apps can additionally add
 * `createCrumbtrailExpressMiddleware` for per-request capture (see
 * crumbtrail-node's README).
 */
export function nodeInitSnippet(endpoint: string): string {
  return [
    "// Crumbtrail — auto-captures uncaught exceptions, unhandled rejections, and",
    "// console.error. Key is read from process.env.CRUMBTRAIL_KEY, which autoCapture",
    "// loads from your .env (written by the CLI). Express apps can also add",
    "// createCrumbtrailExpressMiddleware for per-request capture.",
    'import("crumbtrail-node")',
    `  .then(({ autoCapture }) => autoCapture({ endpoint: ${JSON.stringify(endpoint)} }))`,
    "  .catch(() => {});",
  ].join("\n");
}

/**
 * Single-quoted string literal in Prettier's `singleQuote: true` style: wraps the
 * value in single quotes, escaping backslashes and single quotes. Kept local to
 * the Nest snippet, whose scaffold ships that Prettier default — everything else
 * uses `JSON.stringify` (double quotes, Prettier's own default).
 */
function singleQuoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * NestJS server init. Byte-for-byte the same wiring as `nodeInitSnippet` — a
 * dynamically-imported `autoCapture` prepended into `src/main.ts` — but emitted
 * with SINGLE quotes to match Nest scaffolds' Prettier default
 * (`singleQuote: true`). Nest is the only backend-JS recipe that gets its own
 * snippet: its generator ships a `.prettierrc` with single quotes, so the
 * double-quoted `nodeInitSnippet` produces cosmetic diff/lint noise on the very
 * first commit. Every other backend-JS recipe (express/hono/fastify/node) keeps
 * the double-quoted snippet, which matches Prettier's own default.
 */
export function nestInitSnippet(endpoint: string): string {
  return [
    "// Crumbtrail — auto-captures uncaught exceptions, unhandled rejections, and",
    "// console.error. Key is read from process.env.CRUMBTRAIL_KEY, which autoCapture",
    "// loads from your .env (written by the CLI). Express apps can also add",
    "// createCrumbtrailExpressMiddleware for per-request capture.",
    "import('crumbtrail-node')",
    `  .then(({ autoCapture }) => autoCapture({ endpoint: ${singleQuoted(endpoint)} }))`,
    "  .catch(() => {});",
  ].join("\n");
}

/**
 * React Native / Expo init block. Imperative + prepend-safe: it calls
 * `createReactNativeCrumbtrail` (which runs `Crumbtrail.init` and installs the
 * global ErrorUtils crash handler) — the same posture as the node recipe. We do
 * NOT wrap a `<CrumbtrailReactNativeProvider>`, because the injection engine only
 * prepends a block or creates a file; it cannot transform JSX. The ingest key is
 * inlined — it ships in the app bundle anyway (ingest-only, same posture as a
 * Sentry DSN).
 */
export function reactNativeInitSnippet(
  endpoint: string,
  apiKey: string,
): string {
  return [
    'import { createReactNativeCrumbtrail } from "crumbtrail-react-native";',
    "",
    "createReactNativeCrumbtrail({",
    "  config: {",
    `    httpEndpoint: ${JSON.stringify(endpoint)},`,
    `    httpAuthToken: ${JSON.stringify(apiKey)},`,
    "  },",
    "});",
  ].join("\n");
}

/**
 * Tauri init block. Prepended into the frontend entry. Uses the core
 * `transportInstance` override (NOT the `transport` string-mode field) with a
 * `TauriTransport`, which routes bug reports to the local Rust store via the
 * Tauri plugin — so no httpEndpoint / apiKey is needed in the block.
 */
export function tauriInitSnippet(): string {
  return [
    'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    'import { TauriTransport } from "crumbtrail-tauri";',
    "",
    "Crumbtrail.init({ ...PRESET_PASSIVE, transportInstance: new TauriTransport() });",
  ].join("\n");
}

/** The single line the CLI writes into `.env` for the Node recipe. */
export function envKeyLine(apiKey: string): string {
  return `CRUMBTRAIL_KEY=${apiKey}`;
}
