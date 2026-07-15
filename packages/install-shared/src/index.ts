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
 *     (startHeadlessSession) and record server-side events against it.
 */
export function buildBackendJsNote(stack: Stack): string {
  if (stack === "express") {
    return [
      "// Backend (Express) — also capture server-side errors and requests.",
      "// Reuse the same ingest endpoint + key you set on the SDK above.",
      "import {",
      "  createCrumbtrailExpressMiddleware,",
      "  createCrumbtrailExpressErrorMiddleware,",
      '} from "crumbtrail-node";',
      "",
      "const crumbtrailOptions = { endpoint: CRUMBTRAIL_ENDPOINT, authToken: CRUMBTRAIL_KEY };",
      "app.use(createCrumbtrailExpressMiddleware(crumbtrailOptions));      // before your routes",
      "app.use(createCrumbtrailExpressErrorMiddleware(crumbtrailOptions)); // after your routes",
      "",
      "// Prefer OpenTelemetry? Point your OTLP exporter at the receiver instead.",
    ].join("\n");
  }
  return [
    "// Backend (Hono / Node) — crumbtrail-node ships no framework middleware here.",
    "// Open a headless session and record server-side events against it:",
    'import { startHeadlessSession } from "crumbtrail-node";',
    "",
    "const session = await startHeadlessSession({",
    "  endpoint: CRUMBTRAIL_ENDPOINT,",
    "  authToken: CRUMBTRAIL_KEY,",
    '  sessionId: "<your-session-id>",',
    "});",
    "// session.record(event) to attach server events; session.end() when done.",
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
  /** Resource attribute that files spans/logs into a Crumbtrail session. */
  sessionAttr: string;
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
 *   • OTEL_RESOURCE_ATTRIBUTES      → crumbtrail.session.id=<id>
 * Verified against docs/integrations/* and the ingest routes.
 */
export function buildOtlpSnippets({
  endpoint,
  apiKey,
}: EndpointKey): OtlpSnippets {
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
    sessionAttr: `OTEL_RESOURCE_ATTRIBUTES=${OTLP_CAPABILITY_FACTS.sessionAttribute}=<your-session-id>`,
    note: `Crumbtrail's OTLP receiver appends ${OTLP_CAPABILITY_FACTS.paths.join(" and ")} to the endpoint above — don't include those paths yourself. Set the ${OTLP_CAPABILITY_FACTS.sessionAttribute} resource attribute to join backend spans to the frontend session.`,
  };
}

/**
 * Build the "Install via AI" agent prompt — a copyable block that instructs a
 * coding agent to run the correct setup for the stack, initialize with
 * PRESET_PASSIVE (JS), wire backend middleware when applicable, change nothing
 * else, and verify the build. Hands-off with the key: the JS prompt tells the
 * agent to read the key from a framework-correct env var (which the user sets)
 * and NEVER to hard-code it, so a live credential can't land in committed source.
 * Only the OTLP path references the key value directly — there it's an env-var
 * header (OTEL_EXPORTER_OTLP_HEADERS), not source.
 *
 * `keyEnv` overrides how the JS prompt names the key var. `keyEnvRef(stack)` only
 * knows the coarse stack (nextjs/react/vue/svelte/vite/server), so callers with a
 * finer notion of the framework — e.g. the CLI, which distinguishes Astro's
 * `PUBLIC_` prefix and Expo/React Native's `EXPO_PUBLIC_` (`process.env`, not
 * `import.meta.env`) — pass the exact ref so the prompt matches the injected code.
 */
export function buildAgentPrompt(
  stack: Stack,
  keys: EndpointKey,
  keyEnv?: KeyEnvRef,
): string {
  const { kind, backendJs } = getInstallVariant(stack);
  const { endpoint, apiKey } = keys;

  if (kind === "otlp") {
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
      `  2. Send the auth header X-Crumbtrail-Auth: ${apiKey} on every export`,
      "     (or Authorization: Bearer <key> if your exporter prefers that). Keep",
      "     this key in your environment, not in committed source.",
      "  3. Stamp the resource attribute crumbtrail.session.id so spans/logs join",
      "     the right session.",
      "  4. Keep your existing exporter — add Crumbtrail alongside it.",
      "  5. Verify the app still builds and starts.",
    ].join("\n");
  }

  const { envVar, expr } = keyEnv ?? keyEnvRef(stack);
  const jsLines = [
    "You are setting up Crumbtrail in this project. Make ONLY the changes below,",
    "do not refactor or touch anything else, then verify the build still passes.",
    "",
    `Ingest endpoint: ${endpoint}`,
    `Ingest key:      read it from the ${envVar} environment variable — the user`,
    "                 sets it in their .env. Do NOT hard-code the key in source.",
    "",
    "This is a JavaScript/TypeScript project. Do the following:",
    "  1. Install the SDK:  npm install crumbtrail-core",
    '  2. Import the SDK:  import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
    "  3. Initialize once at the app entry point with PRESET_PASSIVE:",
    "       Crumbtrail.init({",
    "         ...PRESET_PASSIVE,",
    `         httpEndpoint: "${endpoint}",`,
    `         httpAuthToken: ${expr},`,
    "       });",
  ];
  if (backendJs && stack === "express") {
    jsLines.push(
      "  4. This is an Express backend — also install crumbtrail-node and capture",
      "     server errors and requests with its Express middleware:",
      "       import {",
      "         createCrumbtrailExpressMiddleware,",
      "         createCrumbtrailExpressErrorMiddleware,",
      '       } from "crumbtrail-node";',
      `       const opts = { endpoint: "${endpoint}", authToken: process.env.CRUMBTRAIL_KEY };`,
      "       app.use(createCrumbtrailExpressMiddleware(opts));      // before your routes",
      "       app.use(createCrumbtrailExpressErrorMiddleware(opts)); // after your routes",
      "  5. Change nothing else, then verify the build still passes.",
    );
  } else if (backendJs) {
    jsLines.push(
      "  4. This is also a backend. Install crumbtrail-node; it ships no framework",
      "     middleware for this stack, so open a headless session and record",
      "     server-side events against it:",
      '       import { startHeadlessSession } from "crumbtrail-node";',
      "       const session = await startHeadlessSession({",
      `         endpoint: "${endpoint}",`,
      "         authToken: process.env.CRUMBTRAIL_KEY,",
      '         sessionId: "<your-session-id>",',
      "       });",
      "       // session.record(event) for server events; session.end() when the request ends.",
      "  5. Change nothing else, then verify the build still passes.",
    );
  } else {
    jsLines.push(
      "  4. Change nothing else, then verify the build still passes.",
    );
  }
  return jsLines.join("\n");
}
