// Pure, framework-agnostic install-instruction routing for the /welcome wizard.
//
// This module holds NO React and NO I/O. It maps every one of the 18 supported
// stacks to exactly one install *variant* and builds the copyable snippet text
// each variant needs. Keeping it pure makes the routing table unit-testable and
// keeps the wizard component presentational.
//
// Variants:
//   • "js"    — a JavaScript/TypeScript runtime that runs crumbtrail-core's SDK
//               directly (rendered via <InstallSteps/>). Backend-JS stacks
//               (express/hono/node) additionally get a crumbtrail-node
//               middleware / OTLP note.
//   • "otlp"  — a non-JS backend that already speaks OpenTelemetry; instead of a
//               native SDK it points its existing OTLP/HTTP exporter at
//               Crumbtrail's receiver.
//   • "infra" — an evidence source (Postgres/Grafana/Loki/Docker). Not yet a
//               first-class ingest target; flagged coming-soon.

import { STACK_IDS, type Stack } from "crumbtrail-core";
import { envPreloadSnippet, nodeInitSnippet } from "../inject/snippets.js";

export type InstallVariantKind = "js" | "otlp" | "infra";

/** JS/TS stacks that install crumbtrail-core directly. */
export const JS_STACKS: readonly Stack[] = [
  "nextjs",
  "react",
  "vue",
  "svelte",
  "vite",
  "express",
  "hono",
  "node",
];

/** JS backends that additionally wire the crumbtrail-node middleware. */
export const BACKEND_JS_STACKS: readonly Stack[] = ["express", "hono", "node"];

/** Non-JS backends wired via their existing OpenTelemetry exporter. */
export const OTLP_STACKS: readonly Stack[] = [
  "django",
  "flask",
  "fastapi",
  "dotnet",
  "go",
  "rails",
];

/** Evidence sources that are not yet a first-class ingest target. */
export const INFRA_STACKS: readonly Stack[] = [
  "postgres",
  "grafana",
  "loki",
  "docker",
];

export interface StackInstall {
  stack: Stack;
  kind: InstallVariantKind;
  /** True for express/hono/node — they also need the backend middleware note. */
  backendJs: boolean;
  /** True for infra evidence sources — surfaced as "coming soon". */
  comingSoon: boolean;
}

/** Classify a single stack into its install variant. Total over all 18 stacks. */
export function getInstallVariant(stack: Stack): StackInstall {
  const backendJs = BACKEND_JS_STACKS.includes(stack);
  if (JS_STACKS.includes(stack)) {
    return { stack, kind: "js", backendJs, comingSoon: false };
  }
  if (OTLP_STACKS.includes(stack)) {
    return { stack, kind: "otlp", backendJs: false, comingSoon: false };
  }
  // Remaining stacks are the infra evidence sources.
  return { stack, kind: "infra", backendJs: false, comingSoon: true };
}

/** The classification table for every supported stack (handy for tests/UI). */
export function allStackInstalls(): StackInstall[] {
  return STACK_IDS.map(getInstallVariant);
}

export interface EndpointKey {
  /** Live ingest endpoint (the cloud origin / dashboard origin). */
  endpoint: string;
  /**
   * Live ingest key. Used only by the OTLP path (an env-var header, not source)
   * and left available for callers. The JS agent prompt is hands-off — it reads
   * the key from an env var and never bakes this literal into source.
   */
  apiKey: string;
}

export interface KeyEnvRef {
  /** The env var the user sets to their ingest key. */
  envVar: string;
  /** The code expression the SDK init reads it from. */
  expr: string;
}

const VITE_KEY_ENV: KeyEnvRef = {
  envVar: "VITE_CRUMBTRAIL_KEY",
  expr: "import.meta.env.VITE_CRUMBTRAIL_KEY",
};
const NEXT_KEY_ENV: KeyEnvRef = {
  envVar: "NEXT_PUBLIC_CRUMBTRAIL_KEY",
  expr: "process.env.NEXT_PUBLIC_CRUMBTRAIL_KEY",
};
const SERVER_KEY_ENV: KeyEnvRef = {
  envVar: "CRUMBTRAIL_KEY",
  expr: "process.env.CRUMBTRAIL_KEY",
};

/**
 * The env-var reference the SDK reads its ingest key from, per stack. Client
 * bundlers only expose a var under a framework-specific PUBLIC prefix (Next →
 * NEXT_PUBLIC_, Vite-based React/Vue/Svelte/Vite → VITE_); backends read a plain
 * server var. This is the single source of truth for the hands-off key posture —
 * the key lives in the user's env, never inlined into committed source.
 */
export function keyEnvRef(stack: Stack): KeyEnvRef {
  switch (stack) {
    case "nextjs":
      return NEXT_KEY_ENV;
    case "react":
    case "vue":
    case "svelte":
    case "vite":
      return VITE_KEY_ENV;
    default:
      return SERVER_KEY_ENV;
  }
}

/**
 * The crumbtrail-node backend note shown under <InstallSteps/> for the backend-JS
 * stacks. Uses ONLY the real crumbtrail-node exports — no invented names:
 *   • Express is the only stack with framework middleware
 *     (createCrumbtrailExpressMiddleware / createCrumbtrailExpressErrorMiddleware).
 *   • Hono / Node ship no framework middleware, so they open a headless session
 *     with autoCapture and record server-side errors against it.
 */
export function buildBackendJsNote(stack: Stack): string {
  const { expr: keyExpr } = keyEnvRef(stack);
  const configLines = [
    "const crumbtrailEndpoint = process.env.CRUMBTRAIL_BASE_URL;",
    `const crumbtrailKey = ${keyExpr};`,
    "if (!crumbtrailEndpoint || !crumbtrailKey) {",
    '  throw new Error("Set CRUMBTRAIL_BASE_URL and CRUMBTRAIL_KEY before starting the app.");',
    "}",
  ];

  if (stack === "express") {
    return [
      "// Backend (Express) — also capture server-side errors and requests.",
      "// Set CRUMBTRAIL_BASE_URL and CRUMBTRAIL_KEY in the server environment.",
      "import {",
      "  createCrumbtrailExpressMiddleware,",
      "  createCrumbtrailExpressErrorMiddleware,",
      '} from "crumbtrail-node";',
      "",
      ...configLines,
      "const crumbtrailOptions = { endpoint: crumbtrailEndpoint, authToken: crumbtrailKey };",
      "app.use(createCrumbtrailExpressMiddleware(crumbtrailOptions));      // before your routes",
      "app.use(createCrumbtrailExpressErrorMiddleware(crumbtrailOptions)); // after your routes",
      "",
      "// Prefer OpenTelemetry? Point your OTLP exporter at the receiver instead.",
    ].join("\n");
  }
  return [
    "// Backend (Hono / Node) — autoCapture is the whole wiring: it hooks",
    "// http.Server, so inbound requests carrying the browser's correlation",
    "// headers are recorded whichever framework serves them. Prepend it at the",
    "// top of the server entry file: it opens a headless session and records",
    "// those requests, uncaught exceptions, unhandled rejections, console.error,",
    "// and the warnings and errors your logger writes (pino, winston, bunyan),",
    "// with no per-event code.",
    "// Set CRUMBTRAIL_BASE_URL and CRUMBTRAIL_KEY in the server environment.",
    ...configLines,
    'import("crumbtrail-node")',
    "  .then(({ autoCapture }) =>",
    "    autoCapture({ endpoint: crumbtrailEndpoint, authToken: crumbtrailKey }),",
    "  )",
    "  .catch(() => {});",
    "",
    "// Prefer OpenTelemetry? Point your OTLP exporter at the receiver instead.",
  ].join("\n");
}

/**
 * Single source of truth for what Crumbtrail's OTLP/HTTP receiver accepts. Both
 * `buildOtlpSnippets` (the wizard guidance) and the collector recipes in
 * `packages/node/src/provider-recipes.json` must agree with these facts — a
 * consistency test asserts the two never drift (compression, endpoint path
 * suffix, auth header names).
 *
 * Nothing here is invented: the paths, protocols, auth headers, and session
 * attribute all match the live ingest routes served by packages/node/src/server.ts
 * and by the hosted Crumbtrail cloud.
 */
export interface OtlpCapabilityFacts {
  /** Signal paths the receiver serves; exporters append these to the endpoint. */
  readonly paths: readonly ["/v1/traces", "/v1/logs"];
  /** OTLP/HTTP wire protocols accepted (both, as of the protobuf+gzip parity CP). */
  readonly protocols: readonly ["http/protobuf", "http/json"];
  /** Auth header names honored equivalently by the receiver. */
  readonly authHeaders: readonly ["X-Crumbtrail-Auth", "Authorization: Bearer"];
  /** Content-Encoding posture: "none" recommended for collectors; gzip accepted. */
  readonly compression: {
    readonly recommended: "none";
    readonly accepted: readonly ["none", "gzip"];
  };
  /** Resource/span attribute that files spans/logs into a Crumbtrail session. */
  readonly sessionAttribute: "crumbtrail.session.id";
}

export const OTLP_CAPABILITY_FACTS: OtlpCapabilityFacts = {
  paths: ["/v1/traces", "/v1/logs"],
  protocols: ["http/protobuf", "http/json"],
  authHeaders: ["X-Crumbtrail-Auth", "Authorization: Bearer"],
  compression: { recommended: "none", accepted: ["none", "gzip"] },
  sessionAttribute: "crumbtrail.session.id",
};

/**
 * The `X-Crumbtrail-Auth=<key>` value for `OTEL_EXPORTER_OTLP_HEADERS`.
 * OTEL parses that env var as comma-separated `name=value` pairs; the value is
 * used verbatim, so a plain key needs no escaping here.
 */
export function otlpAuthHeaderValue(apiKey: string): string {
  return `X-Crumbtrail-Auth=${apiKey}`;
}

/**
 * The Bearer form for `OTEL_EXPORTER_OTLP_HEADERS`. The space between `Bearer`
 * and the token MUST be percent-encoded (`%20`) — an unescaped space breaks
 * OTEL's `name=value` header parsing and silently drops auth. This is the fix
 * for the previously wrong `Authorization=Bearer <key>` guidance.
 */
export function otlpBearerHeaderValue(apiKey: string): string {
  return `Authorization=Bearer%20${apiKey}`;
}

export interface OtlpSnippets {
  /** OTLP endpoint + protocol + compression env vars pointed at the cloud origin. */
  env: string;
  /** Auth header carried by the exporter (X-Crumbtrail-Auth or Bearer). */
  authHeader: string;
  /** Optional resource attribute that joins spans/logs to a known session. */
  sessionAttr: string;
  /** The app this telemetry belongs to. One ingest key covers a whole project,
   *  so under a project key the key names no app and this is the only thing
   *  that can. The receiver reads the standard `service.name` resource
   *  attribute, which every OTLP SDK sets from this variable. */
  serviceName: string;
  /** Human note about the appended /v1/traces + /v1/logs paths. */
  note: string;
}

/**
 * Build the OTLP setup snippets for a non-JS backend. Uses ONLY the real,
 * documented names — no invented env vars or headers, and everything is derived
 * from OTLP_CAPABILITY_FACTS so it can never drift from the collector recipes:
 *   • OTEL_EXPORTER_OTLP_ENDPOINT   → the cloud origin (exporter appends paths)
 *   • OTEL_EXPORTER_OTLP_PROTOCOL   → http/protobuf or http/json
 *   • OTEL_EXPORTER_OTLP_HEADERS    → X-Crumbtrail-Auth=<key> (or Bearer%20<key>)
 *   • OTEL_EXPORTER_OTLP_COMPRESSION→ none (recommended) — gzip is accepted too
 *   • OTEL_RESOURCE_ATTRIBUTES      → optionally crumbtrail.session.id=<id>
 *   • OTEL_SERVICE_NAME             → the app this telemetry belongs to
 * Verified against docs/integrations/* and the ingest routes.
 */
export function buildOtlpSnippets({
  endpoint,
  apiKey,
  serviceName,
}: EndpointKey & { serviceName?: string | null }): OtlpSnippets {
  const [protobuf, jsonProtocol] = OTLP_CAPABILITY_FACTS.protocols;
  return {
    env: [
      `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
      `OTEL_EXPORTER_OTLP_PROTOCOL=${protobuf}   # or ${jsonProtocol}`,
      `OTEL_EXPORTER_OTLP_COMPRESSION=${OTLP_CAPABILITY_FACTS.compression.recommended}   # recommended; gzip is also accepted`,
    ].join("\n"),
    authHeader: [
      `OTEL_EXPORTER_OTLP_HEADERS=${otlpAuthHeaderValue(apiKey)}`,
      `# Or, if your exporter sends a Bearer token (note the %20-escaped space):`,
      `# OTEL_EXPORTER_OTLP_HEADERS=${otlpBearerHeaderValue(apiKey)}`,
    ].join("\n"),
    sessionAttr: [
      `# Optional: set this when you have a frontend session id to join backend telemetry to it:`,
      `# OTEL_RESOURCE_ATTRIBUTES=${OTLP_CAPABILITY_FACTS.sessionAttribute}=<your-session-id>`,
    ].join("\n"),
    serviceName: `OTEL_SERVICE_NAME=${serviceName ?? "<your-app-name>"}`,
    note: `Crumbtrail's OTLP receiver appends ${OTLP_CAPABILITY_FACTS.paths.join(" and ")} to the endpoint above — don't include those paths yourself. Session joining is optional: set ${OTLP_CAPABILITY_FACTS.sessionAttribute} when you have a frontend session id and want backend spans/logs in that session; otherwise Crumbtrail creates a session from the telemetry. Set OTEL_SERVICE_NAME to say which app in the project this is.`,
  };
}

/**
 * Build the "Install via AI" agent prompt — a copyable block that instructs a
 * coding agent to run the correct setup for the stack, initialize with
 * PRESET_PASSIVE (JS), wire backend middleware when applicable, change nothing
 * else, and verify the build. Hands-off with the key: the JS prompt tells the
 * agent to read the key from a framework-correct env var (which the user sets)
 * and NEVER to hard-code it, so a live credential can't land in committed source.
 * The prompt never carries the key value. It tells the reader to set the
 * framework/server environment variable and has the coding agent read it there.
 *
 * `keyEnv` overrides how the JS prompt names the key var. `keyEnvRef(stack)` only
 * knows the coarse stack (nextjs/react/vue/svelte/vite/server), so callers with a
 * finer notion of the framework — e.g. the CLI, which distinguishes Astro's
 * `PUBLIC_` prefix and Expo/React Native's `EXPO_PUBLIC_` (`process.env`, not
 * `import.meta.env`) — pass the exact ref so the prompt matches the injected code.
 */
export interface AgentPromptOptions {
  /**
   * Override the env var / expression pair the prompt names. The CLI passes the
   * recipe's exact ref so the prompt names the same variable the injected
   * snippet reads (Astro's PUBLIC_, Expo's EXPO_PUBLIC_), which the coarse
   * Stack alone cannot distinguish.
   */
  keyEnv?: KeyEnvRef;
  /**
   * Which app in the project this install is, as it was provisioned.
   *
   * One ingest key covers a whole project, so the key cannot say which app a
   * session came from; the init call does. Every path that writes the init
   * block itself already passes this (see `serviceLines` in inject/snippets.ts,
   * and the dashboard's own copyable snippet). The agent prompt was the one
   * that did not, so an install done by handing this text to a coding agent
   * produced sessions filed against the project and no app, which is a state
   * the product renders as unattributed and the wizard's confirm step, which
   * matches arriving sessions by service, can never see.
   *
   * Absent means the prompt uses `<your-app-name>` and tells the reader to
   * replace it with a stable name before running the app.
   */
  serviceName?: string | null;
  /**
   * Backend origins this app calls, as the caller already resolved them.
   *
   * The prompt used to hardcode `networkCorrelationAllowedOrigins: []` and then
   * ask the agent to go and find the origins — while the CLI, in the same run,
   * had already read them out of the repo and put them in every snippet it
   * writes itself. The hand-off path was the one that threw that work away, so
   * an install done by pasting this prompt produced a frontend and a backend
   * whose evidence never joined.
   *
   * Empty or absent keeps the empty list plus the instruction to fill it in:
   * an origin is never guessed here, because listing one the app does not call
   * sends trace context to a third party.
   */
  backendOrigins?: readonly string[] | null;
}

export function buildAgentPrompt(
  stack: Stack,
  keys: EndpointKey,
  opts: AgentPromptOptions = {},
): string {
  const { kind, backendJs } = getInstallVariant(stack);
  const { endpoint } = keys;

  const explicitServiceName = opts.serviceName?.trim() || null;
  const serviceName = explicitServiceName ?? "<your-app-name>";
  const hasExplicitServiceName = explicitServiceName !== null;

  if (kind === "otlp") {
    const otlpKeyEnv = opts.keyEnv?.envVar ?? keyEnvRef(stack).envVar;
    return [
      "You are setting up Crumbtrail in this project. Make ONLY the changes below,",
      "do not refactor or touch anything else, then verify the build still passes.",
      "",
      `Ingest endpoint: ${endpoint}`,
      "",
      "This is a non-JS backend that already uses OpenTelemetry. Do NOT install a",
      "second SDK. Instead, add Crumbtrail as an additional OTLP/HTTP exporter:",
      `  1. Set OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} (the exporter appends`,
      "     /v1/traces and /v1/logs — do not add those paths).",
      `  2. Set ${otlpKeyEnv} in the runtime environment to your Crumbtrail ingest key.`,
      `     Configure the exporter to read ${otlpKeyEnv} when sending`,
      "     X-Crumbtrail-Auth (or Authorization: Bearer <key> if it prefers that).",
      "     Never put the key value in committed source.",
      `  3. Optional: set ${OTLP_CAPABILITY_FACTS.sessionAttribute} when you have a`,
      "     frontend session id and want backend spans/logs joined to that session.",
      "     Do not block setup on this: sessionless OTLP is accepted and Crumbtrail",
      "     creates a session from the telemetry.",
      // One ingest key covers a whole project, so the key names no app. The
      // receiver reads service.name instead, and every OTLP SDK sets it from
      // OTEL_SERVICE_NAME.
      `  4. Set OTEL_SERVICE_NAME=${serviceName} so this app's`,
      "     telemetry is filed under it rather than under no app at all.",
      ...(hasExplicitServiceName
        ? []
        : [
            "     Replace <your-app-name> with a stable name for this app before running it.",
          ]),
      "  5. Keep your existing exporter — add Crumbtrail alongside it.",
      "  6. Verify the app still builds and starts.",
    ].join("\n");
  }

  const { envVar, expr } = opts.keyEnv ?? keyEnvRef(stack);
  // Never guessed, only passed through: an origin the app does not call costs a
  // CORS preflight on a request that had none and sends trace context somewhere
  // it was not wanted.
  const knownOrigins = (opts.backendOrigins ?? []).filter(
    (origin) => origin.trim().length > 0,
  );

  if (backendJs)
    return backendJsPrompt(
      stack,
      endpoint,
      envVar,
      expr,
      serviceName,
      hasExplicitServiceName,
    );

  const jsLines = [
    "You are setting up Crumbtrail in this project. Make ONLY the changes below,",
    "do not refactor or touch anything else, then verify the build still passes.",
    "",
    `Ingest endpoint: ${endpoint}`,
    // Phrased for both callers. The CLI writes this variable into the app's env
    // file itself; the dashboard's copy-the-snippet path leaves it to a person.
    // Naming the file rather than who fills it is true either way, and the one
    // instruction that matters — never inline the key — is the same for both.
    `Ingest key:      read it from the ${envVar} environment variable, which is`,
    "                 set in the app's env file. Do NOT hard-code it in source.",
    "",
    "This is a JavaScript/TypeScript project. Do the following:",
    "  1. Install the SDK:  npm install crumbtrail-core",
    '  2. Import the SDK:  import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    "  3. Initialize once at the app entry point with PRESET_PASSIVE:",
    "       Crumbtrail.init({",
    "         ...PRESET_PASSIVE,",
    // Named first, on purpose: it is the field an agent is most likely to drop
    // as decoration, and it is the one that decides whether the session can be
    // found again.
    `         service: ${JSON.stringify(serviceName)},`,
    `         httpEndpoint: "${endpoint}",`,
    `         httpAuthToken: ${expr},`,
    // Without this the SDK never polls Crumbtrail for the project's capture
    // settings, so the kill switch, the auto flag triggers, sampling, masking,
    // consent mode, session replay and live probes all stay at whatever this
    // call happens to say and the project's own settings never reach the app.
    "         remoteConfig: true,",
    // Empty means only same origin calls carry the session, request and
    // traceparent headers. A browser app calling an API on another host is the
    // normal multi service shape, so without this field named here the hand-off
    // produces an install whose frontend and backend evidence never joins,
    // silently. Pre-filled when the caller already read the origins out of the
    // repo — asking an agent to rediscover what the CLI just resolved is how
    // the list came back empty.
    `         networkCorrelationAllowedOrigins: [${knownOrigins.map((o) => JSON.stringify(o)).join(", ")}],`,
    "       });",
    ...(knownOrigins.length > 0
      ? [
          "     Those origins were read from this app's own configuration. Keep them,",
          "     and add any backend origin this app calls that is missing. Cross origin",
          "     requests are joined to the session only when their origin is listed.",
          "     Do not add origins the app does not call. Each origin listed must allow",
          "     x-crumbtrail-session-id, x-crumbtrail-request-id and traceparent in its",
          "     CORS allowed headers, or the browser blocks the preflight.",
        ]
      : [
          "     Fill networkCorrelationAllowedOrigins with every backend origin this app",
          '     calls, for example "https://api.example.com", taking them from the app\'s',
          "     own API base URL configuration. Cross origin requests are joined to the",
          "     session only when their origin is listed. Do not add origins the app does",
          "     not call. Each origin listed must allow x-crumbtrail-session-id,",
          "     x-crumbtrail-request-id and traceparent in its CORS allowed headers, or",
          "     the browser blocks the preflight.",
        ]),
    ...(hasExplicitServiceName
      ? [
          "     Keep the service field exactly as written. It is how this app is",
          "     identified in Crumbtrail, and a session without it is filed under",
          "     no app at all.",
        ]
      : [
          "     Replace <your-app-name> with a stable name for this app before running it.",
        ]),
  ];
  jsLines.push("  4. Change nothing else, then verify the build still passes.");
  return jsLines.join("\n");
}

/**
 * The backend-JS hand-off prompt.
 *
 * Deliberately NOT the browser prompt with a middleware paragraph bolted on.
 * `Crumbtrail.init` is the browser entry point: in a Node process `window` is
 * undefined, so it returns an inert instance with no collectors, no event loop
 * and no network — an agent that follows such a prompt produces a build that
 * passes and an app that captures nothing, with every printed step reading as
 * success. `autoCapture` is what every backend recipe actually injects, so it is
 * what this says, in the exact shape the injector writes (see `nodeInitSnippet`).
 */
function backendJsPrompt(
  stack: Stack,
  endpoint: string,
  envVar: string,
  expr: string,
  serviceName: string,
  hasExplicitServiceName: boolean,
): string {
  const lines = [
    "You are setting up Crumbtrail in this project. Make ONLY the changes below,",
    "do not refactor or touch anything else, then verify the build still passes.",
    "",
    `Ingest endpoint: ${endpoint}`,
    `Ingest key:      read it from the ${envVar} environment variable, which is`,
    "                 set in the app's env file. Do NOT hard-code it in source.",
    "",
    "This is a JavaScript/TypeScript BACKEND. Do NOT call Crumbtrail.init here:",
    "that is the browser entry point and it returns an inert instance in Node —",
    "no collectors, no network, no session. Do the following:",
    "  1. Install the SDK:  npm install crumbtrail-node",
    "  2. Prepend this block at the VERY TOP of the server entry file, above the",
    "     other imports, so capture is installed before anything can throw:",
    ...nodeInitSnippet(endpoint, expr, serviceName)
      .split("\n")
      .map((line) => `       ${line}`),
    "     autoCapture hooks http.Server, so it records inbound HTTP requests.",
    "     Requests carrying the browser's correlation headers land in the",
    "     browser's own session; the rest land in this app's own session, so a",
    "     backend-only service still reports. It also captures uncaught",
    "     exceptions, unhandled rejections,",
    "     console.error, and the warnings and errors your logger writes (pino,",
    "     winston, bunyan). It loads the app's .env itself, so the key above is",
    "     set by the time it starts.",
  ];
  if (hasExplicitServiceName) {
    lines.push(
      "     Keep the service field exactly as written. It is how this app is",
      "     identified in Crumbtrail, and a session without it is filed under",
      "     no app at all.",
    );
  } else {
    lines.push(
      "     Replace <your-app-name> with a stable name for this app before running it.",
    );
  }
  if (stack === "express") {
    lines.push(
      "  3. This is an Express app — also register the request and error",
      "     middleware. The block above already records the request and joins it",
      "     to the browser's session; the middleware adds the matched route and",
      "     the errors your handlers throw. The options object is built while this",
      "     file is evaluated, so load .env first or the middleware posts with no",
      "     key:",
      ...envPreloadSnippet(envVar)
        .split("\n")
        .map((line) => `       ${line}`),
      "       import {",
      "         createCrumbtrailExpressMiddleware,",
      "         createCrumbtrailExpressErrorMiddleware,",
      '       } from "crumbtrail-node";',
      `       const crumbtrailOptions = { endpoint: "${endpoint}", authToken: ${expr} };`,
      "       app.use(createCrumbtrailExpressMiddleware(crumbtrailOptions));      // before your routes",
      "       app.use(createCrumbtrailExpressErrorMiddleware(crumbtrailOptions)); // after your routes",
      "  4. Change nothing else, then verify the build still passes.",
    );
  } else {
    lines.push(
      "  3. The block above is the whole wiring for this stack — add nothing",
      "     else. autoCapture hooks http.Server, so requests are recorded",
      "     whichever framework serves them: joined to the browser's session",
      "     when its correlation headers arrive, filed under this app's own",
      "     session when they do not.",
      "  4. Change nothing else, then verify the build still passes.",
    );
  }
  return lines.join("\n");
}
