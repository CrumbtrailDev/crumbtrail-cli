// Pure snippet builders. These produce the exact code Crumbtrail injects. The
// key is NEVER inlined: the installer is hands-off, so the emitted code reads the
// ingest key from a framework-appropriate environment variable (keyExpr, e.g.
// `import.meta.env.VITE_CRUMBTRAIL_KEY`) and the wizard tells the user to set it
// from the dashboard. This keeps the live credential out of committed source.

import { SDK_VERSION_FLOORS } from "../recipe-registry";

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
 * The three browser collectors that record the PERSON rather than the app.
 *
 * `DEFAULT_CONFIG` has all three on, and `PRESET_PASSIVE` turns nothing off (it
 * sets two auto flag booleans and nothing else), so an init that names none of
 * them ships cookie values, every keystroke and every clipboard read on the
 * first deploy. That is the shape a customer discovers in production and rips
 * the SDK out over, and it is not what the reader of the emitted init thinks
 * they agreed to.
 *
 * So they are emitted, off, where the person who ran the installer can see
 * them. The rest of the browser plane stays on: console, network, clicks,
 * storage, errors and performance are the evidence a bug is actually read
 * from, and turning those off would leave an install that captures nothing.
 * Consent mode is deliberately left alone for the same reason: `"required"`
 * captures nothing at all until the app calls `Crumbtrail.consent(true)`, and
 * an install that silently records nothing is the worse failure.
 */
function privateCollectorLines(indent: string): string[] {
  return [
    `${indent}// Off by default: these record the person rather than the app. Cookies`,
    `${indent}// carry session tokens, the clipboard carries whatever was copied from`,
    `${indent}// another app, and keystrokes are every key a visitor types. Set one to`,
    `${indent}// true when your privacy notice covers it. Console, network, clicks,`,
    `${indent}// storage and errors stay on, which is what a bug is read from.`,
    `${indent}cookies: false,`,
    `${indent}keystrokes: false,`,
    `${indent}clipboard: false,`,
  ];
}

/**
 * The lines that decide whether a frontend session ever joins its backend.
 *
 * `networkCorrelationAllowedOrigins` defaults to empty, and an empty list means
 * the SDK stamps its session, request and traceparent headers on same origin
 * calls only. Every multi service app is cross origin — a browser app on one
 * host calling an API on another — so the default outcome there is a session
 * whose frontend and backend evidence never joins, with nothing in the wizard,
 * the app or the dashboard saying why. Emitting the field in the init the
 * installer writes is what makes the setting visible at the moment someone can
 * act on it.
 *
 * Origins the installer already knows are filled in. Where it knows none, the
 * field is still emitted, empty, with the one comment that says what goes in it
 * and what it costs to leave it empty. It is never guessed: stamping an origin
 * the app did not name would send trace context to a third party and trigger
 * CORS preflights on calls that had none.
 */
function correlationOriginsLines(
  backendOrigins: readonly string[] | null | undefined,
  indent: string,
  quote: (value: string) => string,
): string[] {
  const origins = (backendOrigins ?? []).filter(
    (origin) => origin.trim().length > 0,
  );
  const list = origins.map(quote).join(", ");
  const comment =
    origins.length > 0
      ? [
          `${indent}// Backend origins this app calls. Cross origin calls are joined to the`,
          `${indent}// session only when their origin is listed here. Add any this misses.`,
          `${indent}// Each origin listed must allow x-crumbtrail-session-id,`,
          `${indent}// x-crumbtrail-request-id and traceparent in Access-Control-Allow-Headers.`,
        ]
      : [
          `${indent}// Backend origins this app calls. Cross origin calls are joined to the`,
          `${indent}// session only when their origin is listed here, so leaving this empty`,
          `${indent}// means frontend and backend evidence stay separate. Same origin calls`,
          `${indent}// are always joined. Example: ${quote("https://api.example.com")}`,
          `${indent}// Each origin listed must allow x-crumbtrail-session-id,`,
          `${indent}// x-crumbtrail-request-id and traceparent in Access-Control-Allow-Headers.`,
        ];
  return [...comment, `${indent}networkCorrelationAllowedOrigins: [${list}],`];
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

/**
 * The opening of the "only with a key" guard around a backend init.
 *
 * `autoCapture` installs its `uncaughtException` and `unhandledRejection`
 * hooks, patches `node:http`, and wraps whichever SQL driver the app uses
 * BEFORE its first handshake, and it does all of that whether or not a key was
 * ever set. So a service that has not been given one still pays the
 * instrumentation and still changes its own crash path, in exchange for
 * capturing nothing. Guarding on the key is what makes an unconfigured service
 * genuinely untouched.
 */
function keyGuardOpen(keyExpr: string, indent: string): string[] {
  return [
    `${indent}// Only with a key: autoCapture hooks uncaught exceptions and patches your`,
    `${indent}// SQL driver as soon as it runs, so an unconfigured service should not`,
    `${indent}// reach it at all.`,
    `${indent}if (${keyExpr}) {`,
  ];
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
  backendOrigins?: readonly string[] | null,
): string {
  return [
    'import "crumbtrail-core/early";',
    'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    "",
    "Crumbtrail.init({",
    "  ...PRESET_PASSIVE,",
    `  httpEndpoint: ${JSON.stringify(endpoint)},`,
    `  httpAuthToken: ${keyExpr},`,
    remoteConfigLine("  "),
    ...privateCollectorLines("  "),
    ...correlationOriginsLines(backendOrigins, "  ", JSON.stringify),
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
  backendOrigins?: readonly string[] | null,
): string {
  return [
    'import "crumbtrail-core/early";',
    'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    "",
    "export default defineNuxtPlugin(() => {",
    "  Crumbtrail.init({",
    "    ...PRESET_PASSIVE,",
    `    httpEndpoint: ${JSON.stringify(endpoint)},`,
    `    httpAuthToken: ${keyExpr},`,
    remoteConfigLine("    "),
    ...privateCollectorLines("    "),
    ...correlationOriginsLines(backendOrigins, "    ", JSON.stringify),
    ...serviceLines(serviceName, "    ", JSON.stringify),
    "  });",
    "});",
  ].join("\n");
}

/**
 * Node server init. Uses crumbtrail-node's `autoCapture`, which installs
 * best-effort backend crash, console and structured log capture (uncaught
 * exceptions, unhandled rejections, console.error, and pino/winston/bunyan
 * lines at warn and above) around a headless ingest session — AND inbound
 * request capture, which hooks `http.Server` rather than any one framework, so
 * hono, fastify, nest and a hand-written server all record the requests the
 * browser correlated without another line of app code. It is dynamically
 * imported so the block is valid whether the entry file is ESM, CommonJS, or
 * TypeScript, and it is a plain expression (no top-level await) so it is safe to
 * prepend at the very top of an entry file. The ingest key is read from
 * `keyExpr` (never inlined server-side) — one variable for the whole project,
 * with `service` naming which app in it this is. Express apps additionally get
 * `createCrumbtrailExpressMiddleware`, which claims the request so it is
 * recorded once, with its matched route.
 */
export function nodeInitSnippet(
  endpoint: string,
  keyExpr: string,
  serviceName?: string | null,
): string {
  return [
    "// Crumbtrail — records every inbound HTTP request that arrives carrying the",
    "// browser's correlation headers, so frontend sessions join the backend calls",
    "// they made. Also auto-captures uncaught exceptions, unhandled rejections,",
    "// console.error and the warnings and errors your logger writes (pino,",
    "// winston, bunyan), and instruments whichever SQL driver this app already uses",
    "// (pg, postgres.js, Neon HTTP, PlanetScale, mysql2, better-sqlite3, mssql)",
    "// so row level changes are captured too.",
    "// Pass { captureHttpRequests: false } to leave node:http untouched, or",
    "// { instrumentDatabases: false } to leave drivers untouched. Key is read",
    `// from ${keyExpr} — set it in your .env (get your key from the`,
    "// Crumbtrail dashboard).",
    ...keyGuardOpen(keyExpr, ""),
    `  const __crumbtrailKey = ${keyExpr};`,
    '  import("crumbtrail-node")',
    // The token is passed rather than left to the SDK's own default so the
    // snippet reads the framework's variable rather than whatever the SDK
    // happens to fall back to.
    `    .then(({ autoCapture }) => autoCapture({ endpoint: ${JSON.stringify(endpoint)}, authToken: __crumbtrailKey${serviceArg(serviceName, JSON.stringify)} }))`,
    "    .catch(() => {});",
    "}",
  ].join("\n");
}

/**
 * Guarded `.env` load, emitted at the very top of every backend-JS entry, above
 * the capture init.
 *
 * Nothing has loaded the project's `.env` when an entry module starts
 * evaluating. On a hosted platform the key is a real environment variable so
 * every read works, which is exactly why this stays invisible until someone
 * reproduces a bug on their laptop — where the key lives in `.env` and every
 * read sees nothing. Capture is then silently off in the one place a person is
 * actually looking for it.
 *
 * Two distinct reads depend on this. The Express middleware options object
 * (`{ endpoint, authToken: process.env.<VAR> }`) is built while the entry module
 * evaluates, so without this the middleware carries no token and every
 * `backend.req.*` event is rejected. `autoCapture` loads `.env` itself, but only
 * from the directory it is reached in and only after its dynamic import
 * resolves — an app that loads its own env file later in the entry, or from a
 * path of its own, still starts capture against an unset variable.
 *
 * Only fills the key in when it is absent, and Node's own loader never
 * overwrites a variable that is already set, so a real environment still wins.
 * `Reflect.get` rather than `process.loadEnvFile?.()` so the emitted line also
 * type checks in a TypeScript entry whose `@types/node` predates Node 20.12.
 *
 * `quote` matches the surrounding scaffold's Prettier config — Nest ships
 * `singleQuote: true`, everything else takes Prettier's double-quote default.
 *
 * `packageRelPath` is this package's directory relative to the repository root,
 * resolved when the block is written. A bare `.env` is read relative to the
 * working directory, so in a monorepo it only ever finds the file when the
 * process was started from inside the package. Starting it from the root —
 * `node services/gateway/src/boot/main.js`, which is also what a root Dockerfile
 * does — found nothing, and the user was told their key was missing when they
 * had set it. Listing `services/gateway/.env` alongside `.env` makes both ways
 * of starting the same process load the same file.
 */
export function envPreloadSnippet(
  keyEnvVar: string,
  quote: (value: string) => string = JSON.stringify,
  packageRelPath?: string | null,
): string {
  const scoped = normalizeEnvPackageRelPath(packageRelPath);
  const candidates = [".env", ".env.local"];
  if (scoped) candidates.push(`${scoped}/.env`, `${scoped}/.env.local`);
  return [
    `// Crumbtrail — load the env file so ${keyEnvVar} is set before anything`,
    "// below reads it (capture init and, on Express, the middleware options are",
    "// both built as this file is evaluated). Try .env first because that is",
    "// where the installer puts a server key; .env.local remains a fallback for",
    "// an existing setup.",
    ...(scoped
      ? [
          `// The ${scoped}/ entries are the same two files addressed from the`,
          "// repository root, so starting this process from the root loads them",
          "// too.",
        ]
      : []),
    `if (!process.env.${keyEnvVar}) {`,
    `  for (const envFile of [${candidates.map((c) => quote(c)).join(", ")}]) {`,
    "    try {",
    `      const loadEnvFile = Reflect.get(process, ${quote("loadEnvFile")});`,
    `      if (typeof loadEnvFile === ${quote("function")}) loadEnvFile.call(process, envFile);`,
    "    } catch {",
    "      // Missing file, or Node < 20.12: try the next one, then keep",
    "      // whatever the real environment already has.",
    "    }",
    `    if (process.env.${keyEnvVar}) break;`,
    "  }",
    "}",
  ].join("\n");
}

/**
 * The package directory as it is addressed from the repository root: forward
 * slashes, no leading or trailing separator, and nothing that escapes the root.
 *
 * Returns null for the single package case (the package IS the root), where the
 * bare `.env` already is the right and only path.
 */
function normalizeEnvPackageRelPath(
  packageRelPath: string | null | undefined,
): string | null {
  if (!packageRelPath) return null;
  const slashed = packageRelPath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (!slashed || slashed === ".") return null;
  // An entry above the root is not something this snippet can address from the
  // root, and a path with a quote or newline in it has no business being
  // emitted into source at all.
  if (slashed.startsWith("..") || /["'\n\r]/.test(slashed)) return null;
  return slashed;
}

/**
 * The options that keep the Express middleware from capturing more than the
 * install asked for.
 *
 * `createCrumbtrailExpressMiddleware` is a SEPARATE installer from
 * `autoCapture`, with its own defaults, and the express recipe injects both
 * into the same process. Left unnamed it records 4xx and 5xx response bodies
 * (`captureResponseBody` defaults to `"error"`), and it patches stdout, stderr
 * and `fs.write` a second time for log and runtime warning capture that
 * `autoCapture` is already doing in the same process.
 *
 * So the bodies are off, because a 4xx body is an auth or validation payload
 * belonging to the customer's own user, and the duplicate log patching is off,
 * which costs nothing: the same lines still arrive through `autoCapture`. Set
 * `captureResponseBody` to `"error"` or `"all"` to get the response text back.
 *
 * The error middleware installs no log capture of its own, so it is given the
 * body setting only rather than two options that would do nothing.
 */
const EXPRESS_REQUEST_OPTIONS =
  'captureResponseBody: "off", captureLogs: false, captureRuntimeWarnings: false';

const EXPRESS_ERROR_OPTIONS = 'captureResponseBody: "off"';

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
  return `if (${keyExpr}) ${appVar}.use(createCrumbtrailExpressMiddleware({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr}, ${EXPRESS_REQUEST_OPTIONS} }));`;
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
  return `if (${keyExpr}) ${appVar}.use(createCrumbtrailExpressErrorMiddleware({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr}, ${EXPRESS_ERROR_OPTIONS} }));`;
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
    `//   if (${keyExpr}) app.use(createCrumbtrailExpressMiddleware({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr}, ${EXPRESS_REQUEST_OPTIONS} }));`,
    "//",
    "//   // after your routes, right before `app.listen(...)`:",
    `//   if (${keyExpr}) app.use(createCrumbtrailExpressErrorMiddleware({ endpoint: ${JSON.stringify(endpoint)}, authToken: ${keyExpr}, ${EXPRESS_ERROR_OPTIONS} }));`,
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
    "// Crumbtrail — records every inbound HTTP request that arrives carrying the",
    "// browser's correlation headers, so frontend sessions join the backend calls",
    "// they made. Also auto-captures uncaught exceptions, unhandled rejections,",
    "// console.error and the warnings and errors your logger writes (pino,",
    "// winston, bunyan), and instruments whichever SQL driver this app already uses",
    "// (pg, postgres.js, Neon HTTP, PlanetScale, mysql2, better-sqlite3, mssql)",
    "// so row level changes are captured too.",
    "// Pass { captureHttpRequests: false } to leave node:http untouched, or",
    "// { instrumentDatabases: false } to leave drivers untouched. Key is read",
    `// from ${keyExpr} — set it in your .env (get your key from the`,
    "// Crumbtrail dashboard).",
    ...keyGuardOpen(keyExpr, ""),
    `  const __crumbtrailKey = ${keyExpr};`,
    "  import('crumbtrail-node')",
    `    .then(({ autoCapture }) => autoCapture({ endpoint: ${singleQuoted(endpoint)}, authToken: __crumbtrailKey${serviceArg(serviceName, singleQuoted)} }))`,
    "    .catch(() => {});",
    "}",
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
  backendOrigins?: readonly string[] | null,
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
    ...correlationOriginsLines(backendOrigins, "    ", JSON.stringify),
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
  backendOrigins?: readonly string[] | null,
): string {
  return [
    'import "crumbtrail-core/early";',
    'import { createCapacitorCrumbtrailAsync } from "crumbtrail-capacitor";',
    "",
    "createCapacitorCrumbtrailAsync({",
    "  config: {",
    `    httpEndpoint: ${JSON.stringify(endpoint)},`,
    `    httpAuthToken: ${keyExpr},`,
    remoteConfigLine("    "),
    ...privateCollectorLines("    "),
    ...correlationOriginsLines(backendOrigins, "    ", JSON.stringify),
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
    'import "crumbtrail-core/early";',
    'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    'import { TauriTransport } from "crumbtrail-core/tauri";',
    "",
    "Crumbtrail.init({",
    "  ...PRESET_PASSIVE,",
    ...privateCollectorLines("  "),
    "  transportInstance: new TauriTransport(),",
    "});",
  ].join("\n");
}

/**
 * Where a page with no bundler gets the SDK from.
 *
 * A bare `import "crumbtrail-core"` does not resolve in a browser, and a static
 * page has no build step to rewrite it, so the one honest answer is a URL. The
 * version is pinned rather than floating: an unpinned CDN URL hands every page
 * whatever ships next, and nothing in the page says which SDK it is running.
 *
 * `version` is this CLI's own release, which moves in lockstep with the SDKs.
 * A prerelease (or anything that is not an exact release) falls back to the
 * published capability floor, so the emitted URL is always a version that exists
 * on the registry.
 */
export function browserModuleUrl(version?: string | null): string {
  // `0.0.0` is what an unreadable package.json yields, not a release anyone can
  // fetch — treating it as one would emit a URL that 404s in the user's browser.
  const trimmed = version?.trim();
  const pinned =
    trimmed && trimmed !== "0.0.0" && /^\d+\.\d+\.\d+$/.test(trimmed)
      ? trimmed
      : SDK_VERSION_FLOORS["crumbtrail-core"];
  return `https://esm.sh/crumbtrail-core@${pinned}`;
}

/**
 * The published classic bootstrap that must run before every application
 * script. It is a package file rather than generated page code, so it has no
 * customer configuration, secrets, or module/network work of its own.
 */
export function browserEarlyBootstrapUrl(version?: string | null): string {
  const moduleUrl = browserModuleUrl(version);
  const pinned = moduleUrl.slice(moduleUrl.lastIndexOf("@") + 1);
  return `https://unpkg.com/crumbtrail-core@${pinned}/dist/early-bootstrap.global.js`;
}

/**
 * Browser capture for a page with no framework and no bundler: one
 * classic bootstrap plus a `<script type="module">` block, dropped into the
 * HTML itself.
 *
 * The first tag is an exact-version, published package artifact loaded as a
 * parser-blocking classic script. It installs only the bounded pre-init hooks.
 * The second tag remains the configurable module that initializes and drains
 * those hooks. The value emitted for its key is a placeholder, never a live
 * key — the wizard mints nothing for this recipe and points at the dashboard
 * instead, so what lands in the file is a TODO rather than a credential.
 *
 * The generated page does not claim a CDN is always available. The comments
 * tell strict-CSP and offline deployments to self-host the exact published
 * package files, and to add SRI for those exact bytes when their policy needs
 * it. The URL is pinned to an exact release so a later package cannot silently
 * change the bootstrap contract.
 */
export function staticScriptTagSnippet(options: {
  endpoint: string;
  keyLiteral: string;
  serviceName?: string | null;
  backendOrigins?: readonly string[] | null;
  sdkVersion?: string | null;
  mintUrl?: string | null;
}): string {
  const { endpoint, keyLiteral, serviceName, backendOrigins } = options;
  const mint = options.mintUrl
    ? ` Get one at ${options.mintUrl}.`
    : " Get one from your Crumbtrail dashboard.";
  return [
    "<!-- Crumbtrail — browser capture (console, network, DOM, errors). -->",
    `<!-- httpAuthToken must contain this project's ingest key.${mint} -->`,
    "<!-- The classic bootstrap is parser-blocking and pinned to this SDK release. CSP: script-src must allow unpkg.com and esm.sh, the inline module needs a matching nonce or hash, and connect-src must allow the ingest endpoint. SRI: add integrity and crossorigin=anonymous to the external tags for the exact bytes you serve. Offline or strict-CSP: self-host the exact published package files, replace both URLs, and move the inline module to a nonce/hash-approved or external file. -->",
    `<script src=${JSON.stringify(browserEarlyBootstrapUrl(options.sdkVersion))}></script>`,
    '<script type="module">',
    `  import { Crumbtrail, PRESET_PASSIVE } from ${JSON.stringify(browserModuleUrl(options.sdkVersion))};`,
    "",
    "  Crumbtrail.init({",
    "    ...PRESET_PASSIVE,",
    `    httpEndpoint: ${JSON.stringify(endpoint)},`,
    `    httpAuthToken: ${JSON.stringify(keyLiteral)},`,
    remoteConfigLine("    "),
    ...privateCollectorLines("    "),
    ...correlationOriginsLines(backendOrigins, "    ", JSON.stringify),
    ...serviceLines(serviceName, "    ", JSON.stringify),
    "  });",
    "</script>",
  ].join("\n");
}
