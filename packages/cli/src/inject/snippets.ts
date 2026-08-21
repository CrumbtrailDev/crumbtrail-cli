// Pure snippet builders. These produce the exact code Crumbtrail injects. The
// key is NEVER inlined: the installer is hands-off, so the emitted code reads the
// ingest key from a framework-appropriate environment variable (keyExpr, e.g.
// `import.meta.env.VITE_CRUMBTRAIL_KEY`) and the wizard tells the user to set it
// from the dashboard. This keeps the live credential out of committed source.

/**
 * Single-quoted string literal in Prettier's `singleQuote: true` style: wraps the
 * value in single quotes, escaping backslashes and single quotes. Used by the
 * Nest snippet, whose scaffold ships that Prettier default — everything else
 * uses `JSON.stringify` (double quotes, Prettier's own default).
 */
function singleQuoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The line that makes the project's capture settings reach the running app.
 *
 * Without it the SDK never polls `/api/capture-config`, and every setting that
 * only exists on that poll — the auto flag triggers and their tail, baseline
 * sampling, consent mode, client side masking, switching session replay on,
 * and live probe delivery — saves in the dashboard and changes nothing in the
 * app. The kill switch, the budgets, row value redaction and the replay write
 * refusal are not in that set: ingest enforces those whatever a client sends. It
 * is emitted rather than defaulted on in the SDK because the poll is fail
 * closed, so it is only correct for a client pointed at Crumbtrail, which is
 * exactly what the installer is wiring. No endpoint and no second copy of the
 * key: the SDK derives both from `httpEndpoint` and `httpAuthToken` above.
 */
function remoteConfigLine(indent: string): string {
  return `${indent}remoteConfig: true,`;
}

/**
 * Which app in the project the injected code says it is.
 *
 * One ingest key covers the whole project, so the key no longer carries the
 * app. The init call does, and it is the installer that knows the name — an app
 * wired by hand and left without one simply records no app label, which is why
 * an absent name emits nothing rather than a placeholder.
 */
function serviceLines(
  serviceName: string | null | undefined,
  indent: string,
  quote: (value: string) => string,
): string[] {
  return serviceName ? [`${indent}service: ${quote(serviceName)},`] : [];
}

/** The same name as a trailing argument in a single-line options object. */
function serviceArg(
  serviceName: string | null | undefined,
  quote: (value: string) => string,
): string {
  return serviceName ? `, service: ${quote(serviceName)}` : "";
}

/**
 * Client init block (Next / SvelteKit / Vite / …). Matches the README's init
 * shape, but reads the key from the environment via `keyExpr` (a code expression
 * such as `import.meta.env.VITE_CRUMBTRAIL_KEY` or
 * `process.env.NEXT_PUBLIC_CRUMBTRAIL_KEY`) rather than baking in the literal —
 * so nothing sensitive lands in version control.
 */
export function clientInitSnippet(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
): string {
  return [
    'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    "",
    "Crumbtrail.init({",
    "  ...PRESET_PASSIVE,",
    `  httpEndpoint: ${JSON.stringify(endpoint)},`,
    `  httpAuthToken: ${keyExpr},`,
    remoteConfigLine("  "),
    ...serviceLines(serviceName, "  ", JSON.stringify),
    "});",
  ].join("\n");
}

/**
 * Nuxt client plugin. Wraps the same init in `defineNuxtPlugin` (auto-imported
 * by Nuxt) so it runs client-side on startup. Reads the key from `keyExpr`
 * (Nuxt is Vite-based, so `import.meta.env.VITE_CRUMBTRAIL_KEY`).
 */
export function nuxtPluginSnippet(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
): string {
  return [
    'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    "",
    "export default defineNuxtPlugin(() => {",
    "  Crumbtrail.init({",
    "    ...PRESET_PASSIVE,",
    `    httpEndpoint: ${JSON.stringify(endpoint)},`,
    `    httpAuthToken: ${keyExpr},`,
    remoteConfigLine("    "),
    ...serviceLines(serviceName, "    ", JSON.stringify),
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
 * from `keyExpr` (never inlined server-side) — one variable for the whole
 * project, with `service` naming which app in it this is. Express apps can
 * additionally add
 * `createCrumbtrailExpressMiddleware` for per-request capture (see
 * crumbtrail-node's README).
 */
export function nodeInitSnippet(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
): string {
  return [
    "// Crumbtrail — auto-captures uncaught exceptions, unhandled rejections, and",
    "// console.error, and instruments whichever SQL driver this app already uses",
    "// (pg, mysql2, better-sqlite3, mssql) so row level changes are captured too.",
    "// Pass { instrumentDatabases: false } to leave drivers untouched. Key is read",
    `// from ${keyExpr} — set it in your .env (get your key from the`,
    "// Crumbtrail dashboard).",
    'import("crumbtrail-node")',
    // The token is passed rather than left to the SDK's own default so the
    // snippet reads the framework's variable rather than whatever the SDK
    // happens to fall back to.
    `  .then(({ autoCapture }) => autoCapture({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr}${serviceArg(serviceName, JSON.stringify)} }))`,
    "  .catch(() => {});",
  ].join("\n");
}

/**
 * Guarded `.env` load, emitted with the Express middleware wiring.
 *
 * The middleware options object (`{ endpoint, authToken: process.env.<VAR> }`)
 * is built while the entry module is evaluated. Nothing has loaded the project's
 * `.env` by then: `autoCapture` loads it itself, but it is reached through a
 * dynamic import that resolves in a later microtask, after every `app.use(...)`
 * line has already run. Without this the middleware carries no token,
 * `sendBackendEvent` omits the `X-Crumbtrail-Auth` header, and every
 * `backend.req.*` event is rejected — so crash capture works, the wizard reports
 * success, and frontend to backend linkage stays empty forever.
 *
 * Only fills the key in when it is absent, and Node's own loader never
 * overwrites a variable that is already set, so a real environment still wins.
 * `Reflect.get` rather than `process.loadEnvFile?.()` so the emitted line also
 * type checks in a TypeScript entry whose `@types/node` predates Node 20.12.
 */
export function expressEnvPreloadSnippet(keyEnvVar: string): string {
  return [
    `// Crumbtrail — load .env so ${keyEnvVar} is set before the middleware below`,
    "// reads it (the middleware options are built as this file is evaluated).",
    `if (!process.env.${keyEnvVar}) {`,
    "  try {",
    '    const loadEnvFile = Reflect.get(process, "loadEnvFile");',
    '    if (typeof loadEnvFile === "function") loadEnvFile.call(process);',
    "  } catch {",
    "    // No .env, or Node < 20.12: keep whatever the environment already has.",
    "  }",
    "}",
  ].join("\n");
}

/**
 * Import line for the Express middleware pair, matched to the entry file's
 * module style (detected from how `express` itself is imported). ESM entries get
 * a static `import`; CommonJS entries get a `require` destructure.
 */
export function expressMiddlewareImportSnippet(style: "esm" | "cjs"): string {
  return style === "esm"
    ? 'import { createCrumbtrailExpressMiddleware, createCrumbtrailExpressErrorMiddleware } from "crumbtrail-node";'
    : 'const { createCrumbtrailExpressMiddleware, createCrumbtrailExpressErrorMiddleware } = require("crumbtrail-node");';
}

/**
 * Request middleware registration, inserted immediately after
 * `const <appVar> = express()`. Emits backend.req.* start/finish spans so
 * frontend sessions link to backend requests. Reads the same key expression the
 * autoCapture block uses.
 */
export function expressRequestMiddlewareSnippet(
  appVar: string,
  endpoint: string,
  keyExpr: string,
): string {
  return `${appVar}.use(createCrumbtrailExpressMiddleware({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr} }));`;
}

/**
 * Error middleware registration, inserted just above `<appVar>.listen(...)` so
 * it lands after the routes (Express error middleware must be registered last).
 */
export function expressErrorMiddlewareSnippet(
  appVar: string,
  endpoint: string,
  keyExpr: string,
): string {
  return `${appVar}.use(createCrumbtrailExpressErrorMiddleware({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr} }));`;
}

/**
 * Manual wiring TODO block, prepended when the entry file does not match the
 * common `const app = express()` / `app.listen(...)` shape. Carries exact copy
 * and paste lines so the user (or their coding agent) can finish the wiring.
 * Comment-only: safe to prepend anywhere.
 */
export function expressManualWiringSnippet(
  endpoint: string,
  keyExpr: string,
): string {
  return [
    "// TODO(crumbtrail): finish Express request capture. Crumbtrail could not find",
    "// your express() app and app.listen anchors, so add these lines yourself:",
    "//",
    '//   import { createCrumbtrailExpressMiddleware, createCrumbtrailExpressErrorMiddleware } from "crumbtrail-node";',
    "//",
    "//   // right after `const app = express()`, before your routes:",
    `//   app.use(createCrumbtrailExpressMiddleware({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr} }));`,
    "//",
    "//   // after your routes, right before `app.listen(...)`:",
    `//   app.use(createCrumbtrailExpressErrorMiddleware({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr} }));`,
  ].join("\n");
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
export function nestInitSnippet(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
): string {
  return [
    "// Crumbtrail — auto-captures uncaught exceptions, unhandled rejections, and",
    "// console.error, and instruments whichever SQL driver this app already uses",
    "// (pg, mysql2, better-sqlite3, mssql) so row level changes are captured too.",
    "// Pass { instrumentDatabases: false } to leave drivers untouched. Key is read",
    `// from ${keyExpr} — set it in your .env (get your key from the`,
    "// Crumbtrail dashboard).",
    "import('crumbtrail-node')",
    `  .then(({ autoCapture }) => autoCapture({ endpoint: ${singleQuoted(endpoint)}, authToken: ${keyExpr}${serviceArg(serviceName, singleQuoted)} }))`,
    "  .catch(() => {});",
  ].join("\n");
}

/**
 * React Native / Expo init block. Imperative + prepend-safe: it calls
 * `createReactNativeCrumbtrailAsync` (which runs `Crumbtrail.init` and installs
 * the global ErrorUtils crash handler) — the same posture as the node recipe. We
 * do NOT wrap a `<CrumbtrailReactNativeProvider>`, because the injection engine
 * only prepends a block or creates a file; it cannot transform JSX. The key is
 * read from `keyExpr` (Expo exposes `process.env.EXPO_PUBLIC_CRUMBTRAIL_KEY` to
 * the app bundle) rather than inlined, keeping it out of committed source.
 *
 * The AWAITED factory is the injected one on purpose, for the reason the
 * Capacitor and Flutter recipes give: with a store it restores the session id
 * persisted by the previous launch before init. The sync factory builds no
 * session store, and React Native has no backing store for the core default
 * `sessionPersistence: "session"`, so every cold start would open a fresh
 * session — on the one platform where cold starts are the norm — and a
 * once-a-day intermittent bug would never accumulate into one signature.
 *
 * `asyncStorage` says the app already depends on
 * `@react-native-async-storage/async-storage`. The import is emitted ONLY then:
 * Metro resolves every import at bundle time, even one inside a try, so
 * emitting it unconditionally would turn a missing optional peer into an app
 * that no longer builds. Without it the caller warns, and continuity waits for
 * the peer.
 *
 * `.catch(() => {})` because this is prepended at the very top of an entry file
 * — a rejected floating promise there would surface as an unhandled rejection
 * in the app's own error reporting, and telemetry setup must never do that.
 */
export function reactNativeInitSnippet(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
  asyncStorage = false,
): string {
  return [
    ...(asyncStorage
      ? [
          'import AsyncStorage from "@react-native-async-storage/async-storage";',
        ]
      : []),
    'import { createReactNativeCrumbtrailAsync } from "crumbtrail-react-native";',
    "",
    "createReactNativeCrumbtrailAsync({",
    ...(asyncStorage ? ["  asyncStorage: AsyncStorage,"] : []),
    "  config: {",
    `    httpEndpoint: ${JSON.stringify(endpoint)},`,
    `    httpAuthToken: ${keyExpr},`,
    remoteConfigLine("    "),
    ...serviceLines(serviceName, "    ", JSON.stringify),
    "  },",
    "})",
    "  .catch(() => {});",
  ].join("\n");
}

/**
 * Capacitor / Ionic init block. Prepended into the web entry.
 *
 * Calls `createCapacitorCrumbtrailAsync`, which runs `Crumbtrail.init` for the
 * normal web capture and then attaches the native collectors. The async form is
 * the injected one on purpose: it restores a session id persisted by a previous
 * launch before init, and without that every cold start opens a fresh session,
 * so a once-a-day intermittent bug never accumulates into one signature.
 *
 * `.catch(() => {})` because this is prepended at the very top of an entry file
 * — a rejected floating promise there would surface as an unhandled rejection
 * in the app's own error reporting, and telemetry setup must never do that.
 */
export function capacitorInitSnippet(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
): string {
  return [
    'import { createCapacitorCrumbtrailAsync } from "crumbtrail-capacitor";',
    "",
    "createCapacitorCrumbtrailAsync({",
    "  config: {",
    `    httpEndpoint: ${JSON.stringify(endpoint)},`,
    `    httpAuthToken: ${keyExpr},`,
    remoteConfigLine("    "),
    ...serviceLines(serviceName, "    ", JSON.stringify),
    "  },",
    "})",
    "  .catch(() => {});",
  ].join("\n");
}

/** The Dart import the Flutter recipe adds to `lib/main.dart`. */
export const FLUTTER_IMPORT_LINE =
  "import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';";

/**
 * The Flutter start call, as the lines that go inside `main`.
 *
 * Returned as lines rather than a block because this is the one recipe whose
 * code is inserted INSIDE a function, so the caller indents it to match the
 * `main` it found.
 *
 * Awaited on purpose: `Crumbtrail.start` reads the persisted session id before
 * it resolves, and a fire-and-forget call would let `runApp` race it, so every
 * cold start would open a fresh session and a once-a-day intermittent bug would
 * never accumulate into one signature.
 *
 * `const` is what makes the compile-time key work: `String.fromEnvironment` is
 * a const constructor, substituted from `--dart-define` at build time. Dart
 * apps have no runtime environment to read on iOS or Android.
 */
export function flutterInitLines(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
): string[] {
  return [
    "await Crumbtrail.start(const CrumbtrailConfig(",
    `  endpoint: ${singleQuoted(endpoint)},`,
    `  ingestKey: ${keyExpr},`,
    ...serviceLines(serviceName, "  ", singleQuoted),
    "));",
  ];
}

/** The same wiring as a whole-file example, for guidance when the transform bails. */
export function flutterInitSnippet(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
): string {
  return [
    FLUTTER_IMPORT_LINE,
    "",
    "Future<void> main() async {",
    ...flutterInitLines(endpoint, keyExpr, serviceName).map(
      (line) => `  ${line}`,
    ),
    "",
    "  runApp(const MyApp());",
    "}",
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
    'import { TauriTransport } from "crumbtrail-core/tauri";',
    "",
    "Crumbtrail.init({ ...PRESET_PASSIVE, transportInstance: new TauriTransport() });",
  ].join("\n");
}
