// Pure injection plan-builders. Each recipe reads (never writes) via InjectIO and
// returns a Plan describing exactly what should happen. The executor (executor.ts)
// is the only module that mutates the filesystem.
//
// Pre-flight order, before ANY write is planned:
//   1. completeness — the reachable integration matches this endpoint, key,
//      service and remote config -> skip
//   2. cleanliness  — git status on the target; dirty -> needs-confirm (unless force)
//   3. sanity       — target is a readable module (prepend) or safe-to-create
// Any failure or ambiguity -> fallback-ai plan carrying the filled snippet +
// buildAgentPrompt(...) from ../install.

import path from "node:path";
import { buildAgentPrompt, buildOtlpSnippets } from "../install/index.js";
import {
  patternMatches,
  workspacePatterns,
} from "../install/workspace-package-manager.js";
import type { Stack } from "crumbtrail-core";
import { isBackendRecipe } from "../backend-origins";
import { isBuildOutputPath, type Recipe } from "../detect";
import type { FileReader } from "../readers/types";
import {
  pythonOtelPackages,
  RECIPE_REGISTRY,
  type KeyRef,
} from "../recipe-registry";
import {
  inspectIntegration,
  reachableSourceFiles,
  type IntegrationRequirement,
  type IntegrationStatus,
} from "./integration";
import { amendSource, type AmendField } from "./amend";
import { addDockerBuildArg, DOCKERFILE_CANDIDATES } from "./docker";
import {
  deployManifestNaming,
  findExtraBackendEntries,
  MAX_EXTRA_ENTRIES,
  type ExtraEntry,
} from "./entrypoints";
import { defaultInjectIO, type InjectIO } from "./io";
import type { Plan } from "./types";
import {
  corsElsewhereGuidance,
  corsImportedElsewhereNote,
  corsWideningGuidance,
  detectExpressModuleStyle,
  findStaticMountDirs,
  htmlReferencesCrumbtrail,
  insertIntoHtmlHead,
  prependIntoSource,
  referencesCrumbtrail,
  servesHttp,
  widenCorsAllowedHeaders,
  wireExpressMiddleware,
  wireFlutterMain,
  withTrailingNewline,
} from "./text";
import {
  capacitorInitSnippet,
  clientInitSnippet,
  envPreloadSnippet,
  expressErrorMiddlewareSnippet,
  expressManualWiringSnippet,
  expressMiddlewareImportSnippet,
  expressRequestMiddlewareSnippet,
  FLUTTER_IMPORT_LINE,
  flutterInitLines,
  flutterInitSnippet,
  nestInitSnippet,
  nodeInitSnippet,
  nuxtPluginSnippet,
  reactNativeInitSnippet,
  staticScriptTagSnippet,
  tauriInitSnippet,
} from "./snippets";

/**
 * Placeholder used in printed guidance (fallback-ai + OTLP) now that the
 * installer never mints a key. The user replaces it with the key they mint in
 * the dashboard. Never written to a file — only shown in copyable instructions.
 */
const KEY_PLACEHOLDER = "<your-ingest-key>";

/**
 * How this app reads its key: the recipe's own reference, unchanged. One ingest
 * key covers the whole project, so every app in a repository reads the same
 * variable for its framework and the init call carries the app's name instead.
 *
 * `capacitor` is the one recipe whose key mechanism is not fixed by the recipe
 * alone, because Ionic ships both a Vite flavour and an Angular one. An Angular
 * browser build exposes no env var at all, so it gets NO key ref — the same
 * answer the `angular` recipe gives, reached the same way. This is the single
 * decision point: `buildPlan` reads `envVar` from here and the snippet reads
 * `expr` from here, so the two can never disagree.
 */
function keyRefFor(input: BuildPlanInput): KeyRef | undefined {
  if (
    input.recipe === "capacitor" &&
    input.entryFile &&
    isAngularHostedCapacitor(input.entryFile)
  ) {
    return undefined;
  }
  return RECIPE_REGISTRY[input.recipe].keyRef;
}

/** The code expression an injected snippet uses to read the key. */
function keyExprFor(input: BuildPlanInput): string | undefined {
  return keyRefFor(input)?.expr;
}

/** How far up the tree the workspace root search walks before giving up. */
const WORKSPACE_ROOT_MAX_DEPTH = 8;

/**
 * This package's directory as a workspace root addresses it, or null when the
 * package is not a declared member of one.
 *
 * The injected env preload reads `.env` relative to the working directory, and
 * in a monorepo the working directory is usually the root — `node
 * services/gateway/src/boot/main.js` is the normal way to start one, and the
 * only way a root Dockerfile can. Without this, that run found no env file and
 * the SDK reported a missing key the user had already set.
 *
 * Membership is read from the root's own declaration (pnpm-workspace.yaml,
 * package.json `workspaces`, lerna.json), never from a `.git` directory
 * somewhere above: a standalone project that happens to sit inside another
 * checkout is not a member of it, and giving it a path relative to that
 * checkout's root would be wrong in exactly the way this fixes.
 */
export function packageDirFromRepoRoot(
  cwd: string,
  io: InjectIO,
): string | null {
  const target = path.resolve(cwd);
  let dir = target;
  for (let depth = 0; depth < WORKSPACE_ROOT_MAX_DEPTH; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    const patterns = workspacePatterns(parent, { readFile: io.readFile });
    if (patterns && patterns.length > 0) {
      const rel = path.relative(parent, target).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..")) {
        if (patterns.some((pattern) => patternMatches(pattern, rel)))
          return rel;
      }
    }
    dir = parent;
  }
  return null;
}

export interface BuildPlanOptions {
  /** Prepend into a dirty (uncommitted) target instead of asking to confirm. */
  force?: boolean;
}

export interface BuildPlanInput {
  cwd: string;
  recipe: Recipe;
  endpoint: string;
  /** Absolute entry path for vite-spa / node (from detection). */
  entryFile?: string | null;
  /** Raw `next` version range from detection (drives new-file vs legacy-prepend). */
  nextVersion?: string | null;
  /**
   * The detected non-JS backend Stack for the `otlp` recipe (from
   * `DetectResult.otlpStack`). Drives the guidance agent prompt; ignored for
   * every other recipe.
   */
  stack?: Stack;
  /**
   * Which app in the project this is, baked into the injected init call so a
   * session says where it came from. One key covers the whole project, so
   * without this a repository of six apps is six anonymous senders. Callers
   * that wire a repository pass the app's name; a single app run from its own
   * root can pass nothing and stay unlabelled.
   */
  serviceName?: string | null;
  /**
   * Backend origins this app calls, emitted as
   * `networkCorrelationAllowedOrigins` in the browser init.
   *
   * The SDK stamps its correlation headers on same origin calls plus these, and
   * nowhere else, so an empty list is a frontend whose evidence never joins its
   * backend. The caller resolves them from the repository (see
   * ../backend-origins) rather than the recipe guessing a framework default:
   * an origin the app does not call costs a CORS preflight on a request that
   * had none. Absent or empty keeps the honest empty field and its comment.
   */
  backendOrigins?: readonly string[] | null;
  /**
   * This CLI's own release, used to pin the CDN module URL the `static` recipe
   * emits (SDK and CLI versions move in lockstep). Only that recipe reads it;
   * every other one imports a bare specifier its bundler resolves.
   */
  sdkVersion?: string | null;
  /**
   * Where the user mints an ingest key, named inside the emitted static script
   * tag. The `static` recipe is the only one whose key is a literal in the file,
   * so it is the only one that has to say where the real value comes from.
   */
  mintUrl?: string | null;
  options?: BuildPlanOptions;
}

// --- shared plan constructors ------------------------------------------------

function skipPlan(
  input: BuildPlanInput,
  warnings: string[] = [],
  // A caller with something more specific to say replaces the generic line
  // rather than printing both: "one step is left" directly under "the
  // integration is complete" leaves the reader working out which is true.
  options: { replaceDefaultWarning?: boolean } = {},
): Plan {
  return {
    recipe: input.recipe,
    kind: "skip-already-wired",
    targetPath: null,
    content: null,
    warnings: options.replaceDefaultWarning
      ? warnings
      : [
          ...warnings,
          "The Crumbtrail integration is complete for this endpoint and service. Nothing to inject.",
        ],
  };
}

function fallbackPlan(
  input: BuildPlanInput,
  snippet: string,
  warnings: string[],
): Plan {
  // No agent prompt for a page with no bundler: buildAgentPrompt's JS output
  // says `npm install crumbtrail-core` and reads a bundler env var, neither of
  // which exists here. The script tag above IS the whole instruction, and a
  // second set of steps that contradicts it is worse than none.
  if (input.recipe === "static") {
    return {
      recipe: input.recipe,
      kind: "fallback-ai",
      targetPath: null,
      content: null,
      snippet,
      warnings,
      keyIsSourceLiteral: true,
    };
  }
  return {
    recipe: input.recipe,
    kind: "fallback-ai",
    targetPath: null,
    content: null,
    snippet,
    // Hands-off: the prompt reads the key from env / the dashboard, never a
    // baked-in literal (KEY_PLACEHOLDER stands in for the user's own key). Pass
    // the recipe's exact keyRef so the prompt names the same env var the injected
    // snippet reads (e.g. Astro's PUBLIC_, Expo's EXPO_PUBLIC_) — the coarse Stack
    // alone can't distinguish those.
    agentPrompt: buildAgentPrompt(
      RECIPE_REGISTRY[input.recipe].stack,
      {
        endpoint: input.endpoint,
        apiKey: KEY_PLACEHOLDER,
      },
      {
        keyEnv: keyRefFor(input),
        serviceName: input.serviceName,
        backendOrigins: input.backendOrigins,
      },
    ),
    warnings,
  };
}

function incompleteSnippet(input: BuildPlanInput): string {
  const keyExpr = keyExprFor(input) ?? "environment.crumbtrailKey";
  switch (input.recipe) {
    case "capacitor":
      return capacitorInitSnippet(
        input.endpoint,
        keyExpr,
        input.serviceName,
        input.backendOrigins,
      );
    case "flutter":
      return [
        FLUTTER_IMPORT_LINE,
        "",
        ...flutterInitLines(input.endpoint, keyExpr, input.serviceName),
      ].join("\n");
    case "nestjs":
      return nestInitSnippet(input.endpoint, keyExpr, input.serviceName);
    case "react-native":
      return reactNativeInitSnippet(
        input.endpoint,
        keyExpr,
        input.serviceName,
        false,
        input.backendOrigins,
      );
    case "tauri":
      return tauriInitSnippet();
    case "static":
      return staticBlockFor(input);
    case "express":
    case "fastify":
    case "hono":
    case "node":
      return nodeInitSnippet(input.endpoint, keyExpr, input.serviceName);
    case "nuxt":
      return nuxtPluginSnippet(
        input.endpoint,
        keyExpr,
        input.serviceName,
        input.backendOrigins,
      );
    default:
      return clientInitSnippet(
        input.endpoint,
        keyExpr,
        input.serviceName,
        input.backendOrigins,
      );
  }
}

const INTEGRATION_REQUIREMENT_COPY: Record<
  IntegrationStatus["missing"][number],
  string
> = {
  sdk: "one or more required Crumbtrail SDK packages",
  entry: "a reachable Crumbtrail entry point",
  endpoint: "the install endpoint",
  "ingest-key": "an ingest key in the configured environment variable",
  "service-name": "an app or service name",
  "remote-config": "remote configuration",
};

/**
 * The concrete next action for a requirement the installer could not satisfy.
 *
 * Every branch here names a thing the reader can go and do. "Missing an app or
 * service name" was true and useless: it did not say the file already declared
 * one, did not say which variable the endpoint comes from, and left the run with
 * no next step at all.
 */
function nextActionFor(
  input: BuildPlanInput,
  requirement: IntegrationRequirement,
  status: IntegrationStatus,
  amend: AmendReport | null,
): string {
  const blocked = amend?.blocked.find((b) => b.requirement === requirement);
  const where = amend?.file
    ? path.relative(input.cwd, amend.file) || amend.file
    : "your entry file";
  switch (requirement) {
    case "sdk": {
      const pkgs = RECIPE_REGISTRY[input.recipe].sdkPackages.join(", ");
      return `Install ${pkgs} (the installer adds it for you on the next run once the entry is resolved).`;
    }
    case "entry":
      return "No Crumbtrail entry point is reachable from this app's entry file — paste the snippet above into it.";
    case "endpoint":
      return blocked?.existingKey
        ? `${where} already sets \`${blocked.existingKey}\`${blocked.existingValue ? ` to \`${blocked.existingValue}\`` : ""}, so it was left alone. Point that at ${input.endpoint} — if it reads an environment variable, set that variable to ${input.endpoint}.`
        : `Set the init endpoint to ${input.endpoint} in ${where}.`;
    case "ingest-key": {
      const keyRef = keyRefFor(input);
      if (!keyRef) {
        return `${where} carries its ingest key as a literal — paste your key from the dashboard in place of ${KEY_PLACEHOLDER}.`;
      }
      return blocked?.existingKey
        ? `${where} already sets \`${blocked.existingKey}\`${blocked.existingValue ? ` from \`${blocked.existingValue}\`` : ""}, so it was left alone. Make sure that resolves to your ingest key${keyRef.compileTime ? ` (supplied at build time)` : ` — normally ${keyRef.envVar} in your env file`}.`
        : `Set ${keyRef.envVar} in your env file to the key from the dashboard.`;
    }
    case "service-name": {
      // The literal at the init call itself, never a `service:` matched anywhere
      // in the reachable graph — a backend that names a downstream `payments`
      // service elsewhere in the same file is not the app's own name.
      const atCallSite = /^["']([^"']+)["']$/.exec(
        blocked?.existingValue ?? "",
      );
      const target = input.serviceName
        ? `\`${input.serviceName}\``
        : "an unnamed app";
      if (atCallSite) {
        return `This app already reports as \`${atCallSite[1]}\` (set in ${where}); this run targeted ${target}. Leaving your name in place — re-run and name the service \`${atCallSite[1]}\` so the dashboard and the code agree, or change \`service\` in ${where} yourself.`;
      }
      if (blocked?.existingKey) {
        return `${where} already sets \`service\`${blocked.existingValue ? ` from \`${blocked.existingValue}\`` : ""}, so it was left alone. Make that resolve to ${target} — the dashboard lists this app under the name it sends.`;
      }
      if (status.existingServiceName) {
        return `This app already reports as \`${status.existingServiceName}\`; this run targeted ${target}. Re-run and name the service \`${status.existingServiceName}\` so the dashboard and the code agree.`;
      }
      return input.serviceName
        ? `Add \`service: ${JSON.stringify(input.serviceName)}\` to the init call in ${where}.`
        : "Name this app in the init call so its sessions say where they came from.";
    }
    case "remote-config":
      return blocked?.existingKey
        ? `${where} sets \`${blocked.existingKey}\` to false — remove it or set it to true so dashboard capture settings reach this app.`
        : `${where} sets \`remoteConfig: false\`, so dashboard capture settings never reach this app. Remove that line to take them.`;
  }
}

function incompletePlan(
  input: BuildPlanInput,
  status: IntegrationStatus,
  amend: AmendReport | null = null,
): Plan {
  const unresolved = status.missing.filter(
    (requirement) => !(amend?.added ?? []).includes(requirement),
  );
  const missing = unresolved
    .map((requirement) => INTEGRATION_REQUIREMENT_COPY[requirement])
    .join(", ");
  return fallbackPlan(input, incompleteSnippet(input), [
    `Found an existing Crumbtrail integration, but it is incomplete for ${input.endpoint}. Missing ${missing}. The installer will not add a second initialization beside your own.`,
    ...unresolved.map(
      (requirement) =>
        `Next: ${nextActionFor(input, requirement, status, amend)}`,
    ),
  ]);
}

function existingIntegrationPlan(
  input: BuildPlanInput,
  io: InjectIO,
  source: string,
): Plan | null {
  if (!referencesCrumbtrail(source)) return null;
  const status = inspectIntegration({
    cwd: input.cwd,
    recipe: input.recipe,
    endpoint: input.endpoint,
    entryFile: input.entryFile,
    serviceName: input.serviceName,
    io,
  });
  if (status.complete) return skipPlan(input);
  return amendPlan(input, io, status) ?? incompletePlan(input, status);
}

/** What one attempted amend actually managed to do to one file. */
interface AmendReport {
  file: string;
  added: IntegrationRequirement[];
  /** The option names written, e.g. ["remoteConfig", "service"]. */
  addedFields: string[];
  blocked: NonNullable<ReturnType<typeof amendSource>>["blocked"];
}

/** Requirements an in-place source edit can never be the answer to. */
const NOT_A_SOURCE_EDIT = new Set<IntegrationRequirement>(["sdk", "entry"]);

/**
 * Turn an incomplete existing integration into an edit of the customer's OWN
 * init call, rather than a refusal.
 *
 * Returns null when no reachable file holds an options object this can reason
 * about — the caller then prints the guidance it always did. When the object IS
 * understood but every missing option is already set to something else, this
 * returns the guidance plan too, except now each line names the exact next
 * action instead of restating the gap.
 *
 * The ingest key is a value, never a literal: what gets added is the ENV
 * EXPRESSION the recipe reads, and the key itself still goes to the env file
 * through the normal path. A recipe with no env mechanism (angular, static)
 * therefore has no key field to add at all.
 */
function amendPlan(
  input: BuildPlanInput,
  io: InjectIO,
  status: IntegrationStatus,
): Plan | null {
  // Written in the same order the fresh snippets use, so an amended init and an
  // injected one read identically in review.
  const ORDER: IntegrationRequirement[] = [
    "endpoint",
    "ingest-key",
    "remote-config",
    "service-name",
  ];
  const wanted = ORDER.filter(
    (r) => status.missing.includes(r) && !NOT_A_SOURCE_EDIT.has(r),
  );
  if (wanted.length === 0) return null;

  const keyExpr = keyExprFor(input);
  const fields: AmendField[] = [];
  for (const requirement of wanted) {
    if (requirement === "endpoint") {
      fields.push({ requirement, value: JSON.stringify(input.endpoint) });
    } else if (requirement === "ingest-key" && keyExpr) {
      fields.push({ requirement, value: keyExpr });
    } else if (requirement === "service-name" && input.serviceName?.trim()) {
      const name = input.serviceName.trim();
      fields.push({ requirement, value: (_callee, quote) => quote(name) });
    } else if (requirement === "remote-config") {
      fields.push({ requirement, value: "true" });
    }
  }
  if (fields.length === 0) return null;

  let report: AmendReport | null = null;
  let amended: { file: string; text: string } | null = null;
  for (const entry of reachableSourceFiles({
    cwd: input.cwd,
    recipe: input.recipe,
    endpoint: input.endpoint,
    entryFile: input.entryFile,
    serviceName: input.serviceName,
    io,
  })) {
    const outcome = amendSource(entry.text, fields);
    if (!outcome) continue;
    const candidate: AmendReport = {
      file: entry.file,
      added: outcome.added,
      addedFields: outcome.addedFields,
      blocked: outcome.blocked,
    };
    // The first file that can actually take an option wins. A file that only
    // reports what is already set is kept as the explanation of last resort.
    if (outcome.added.length > 0 && outcome.text) {
      report = candidate;
      amended = { file: entry.file, text: outcome.text };
      break;
    }
    report ??= candidate;
  }
  if (!report) return null;
  if (!amended) return incompletePlan(input, status, report);

  // The fresh-injection path prepends a guarded env file load above the init it
  // writes, so the key it just put in `.env` is set before that init reads it.
  // The amend path used to skip it, which made the amended service the one case
  // where the wizard wrote a key the service never read, and every line after
  // it reported a finished setup. Same snippet, same quoting, same workspace
  // relative paths as the fresh path, so the two files read alike in review.
  const keyRef = keyRefFor(input);
  const preloadEnvVar =
    keyRef &&
    !keyRef.compileTime &&
    // A bundler-inlined variable is substituted at build time by a build that
    // reads `.env` itself, so there is no runtime read to get ahead of.
    !keyRef.bundlerInlined &&
    amended.text.includes(`process.env.${keyRef.envVar}`) &&
    // Already loads one, by its own hand or by an earlier run of this.
    !/loadEnvFile|dotenv/.test(amended.text)
      ? keyRef.envVar
      : undefined;
  if (preloadEnvVar) {
    const quote =
      input.recipe === "nestjs"
        ? (value: string) => `'${value}'`
        : JSON.stringify;
    amended.text = prependIntoSource(
      amended.text,
      envPreloadSnippet(
        preloadEnvVar,
        quote,
        packageDirFromRepoRoot(input.cwd, io),
      ),
    );
  }

  const stillMissing = status.missing.filter((r) => !report.added.includes(r));
  const rel = path.relative(input.cwd, amended.file) || amended.file;
  const added = report.added
    .map((r) => INTEGRATION_REQUIREMENT_COPY[r])
    .join(", ");
  const fieldList = report.addedFields.map((f) => `\`${f}\``).join(", ");
  const warnings = [
    // Both edits, named. The old line said "nothing else in that file changed"
    // beside a single edit, and stayed put once a second one was prepended
    // above the init, so it described a file the wizard no longer produced.
    preloadEnvVar
      ? `Your own Crumbtrail initialization in ${rel} was missing ${added}. Crumbtrail added ${fieldList} to it instead of starting a second one, and prepended a guarded env file load above it so ${preloadEnvVar} is set before that init reads it. Nothing else in that file changed.`
      : `Your own Crumbtrail initialization in ${rel} was missing ${added}. Crumbtrail added ${fieldList} to it instead of starting a second one. Nothing else in that file changed.`,
    ...stillMissing
      .filter((r) => !NOT_A_SOURCE_EDIT.has(r))
      .map((r) => `Next: ${nextActionFor(input, r, status, report)}`),
  ];
  const amendedFields = report.addedFields;
  const preload = preloadEnvVar ? ({ envPreloadAdded: true } as const) : {};

  const git = io.gitStatus(input.cwd, amended.file);
  if (git.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: amended.file,
      content: amended.text,
      applyMode: "rewrite",
      amendedFields,
      ...preload,
      warnings,
    };
  }
  return {
    recipe: input.recipe,
    kind: "amend-init",
    targetPath: amended.file,
    content: amended.text,
    amendedFields,
    ...preload,
    warnings,
  };
}

function createPlan(
  input: BuildPlanInput,
  target: string,
  block: string,
  warnings: string[] = [],
): Plan {
  return {
    recipe: input.recipe,
    kind: "create",
    targetPath: target,
    content: withTrailingNewline(block),
    warnings,
  };
}

/**
 * Pre-flight an existing-file prepend: idempotency -> cleanliness -> sanity.
 * Falls back to the AI plan when the file cannot be read; asks to confirm when
 * dirty (unless force). Returns null when the caller should skip (already wired).
 */
function prependWithPreflight(
  input: BuildPlanInput,
  io: InjectIO,
  target: string,
  block: string,
  warnings: string[] = [],
): Plan {
  const existing = io.readFile(target);
  if (existing == null) {
    // Sanity: we thought this file existed but can't read it — hand off.
    return fallbackPlan(input, block, [
      ...warnings,
      `Could not read ${target}; use the snippet or AI prompt to wire it manually.`,
    ]);
  }
  const existingPlan = existingIntegrationPlan(input, io, existing);
  if (existingPlan) return existingPlan;

  // Wiring a backend whose CORS config pins an explicit header list, without
  // widening that list, wires an app the browser will refuse to talk to the
  // moment correlation is on. So the widening rides along with this edit.
  const cors = widenCorsAllowedHeaders(existing);
  const allWarnings = [
    ...warnings,
    ...corsWarnings(cors, input.recipe, {
      entrySource: existing,
      packageJson: io.readFile(path.join(input.cwd, "package.json")),
    }),
  ];

  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content: cors.changed ? prependIntoSource(cors.text, block) : block,
      ...(cors.changed ? { applyMode: "rewrite" as const } : {}),
      warnings: [
        ...allWarnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before prepending.`,
      ],
    };
  }
  if (cors.changed) {
    return {
      recipe: input.recipe,
      kind: "rewrite",
      targetPath: target,
      content: prependIntoSource(cors.text, block),
      warnings: allWarnings,
    };
  }
  return {
    recipe: input.recipe,
    kind: "prepend",
    targetPath: target,
    content: block,
    warnings: allWarnings,
  };
}

/**
 * Listed as its own change in the wizard summary, because it edits code the
 * user did not ask us to touch and they must be able to see that in the diff.
 */
const CORS_WIDENED_WARNING =
  "Widened the CORS allowed headers to admit x-crumbtrail-session-id, x-crumbtrail-request-id and traceparent. Without this the browser blocks every cross origin request once correlation is on.";

/**
 * What this edit did — or could not do — about the file's CORS allowlist.
 *
 * The "could not do" cases matter as much as the rewrite: a computed header
 * list, or a CORS config that lives in a different file, both end with the
 * browser blocking the app's own requests, and the wizard is the only thing in
 * the room that knows correlation was just switched on. Backend recipes only:
 * a frontend entry has no CORS config to speak of, and the note would be noise.
 *
 * And backend processes that answer HTTP only. A queue consumer or a bare
 * `setInterval` worker has no preflight to block, so the guidance is fifteen
 * lines about a thing that cannot happen to it.
 */
function corsWarnings(
  cors: {
    changed: boolean;
    needsManual: boolean;
    found: boolean;
    importsCorsElsewhere?: boolean;
  },
  recipe: Recipe,
  served?: { entrySource?: string | null; packageJson?: string | null },
): string[] {
  if (!cors.found) {
    if (!isBackendRecipe(recipe)) return [];
    // Only withhold when we actually looked: a caller that passes no source
    // keeps the previous behaviour rather than going silent on evidence it
    // never had.
    if (served && !servesHttp(served.entrySource, served.packageJson))
      return [];
    // "No CORS middleware in this file" is a claim about code the wizard read.
    // When the file imports one from a module it did not read, that claim is
    // false and the framework snippets under it are noise.
    return cors.importsCorsElsewhere
      ? [corsImportedElsewhereNote()]
      : [corsElsewhereGuidance()];
  }
  return [
    ...(cors.changed ? [CORS_WIDENED_WARNING] : []),
    ...(cors.needsManual ? [corsWideningGuidance()] : []),
  ];
}

// --- idempotency (project-level) --------------------------------------------

/**
 * The EXACT installed `next` version from `node_modules/next/package.json`, or
 * null when next is not installed / unreadable. Preferred over the declared
 * range because a range like `^15` can resolve to either a legacy 15.2 install
 * or a modern 15.4 one — and the instrumentation-client gate must reflect what
 * will actually run, not what was requested.
 */
function installedNextVersion(cwd: string, io: InjectIO): string | null {
  const text = io.readFile(
    path.join(cwd, "node_modules", "next", "package.json"),
  );
  if (text == null) return null;
  try {
    const pkg = JSON.parse(text) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** True when this package.json declares `name` as a dependency of any kind. */
function dependsOn(cwd: string, io: InjectIO, name: string): boolean {
  const text = io.readFile(path.join(cwd, "package.json"));
  if (text == null) return false;
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return (
      name in
      { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
    );
  } catch {
    return false;
  }
}

/**
 * The installed `nuxt` MAJOR from `node_modules/nuxt/package.json`, or null when
 * nuxt is not installed / unreadable. Read from what will actually run rather
 * than the declared range, for the same reason `installedNextVersion` is: a
 * range like `^3` says nothing about which srcDir layout the resolved install
 * scans.
 */
function installedNuxtMajor(cwd: string, io: InjectIO): number | null {
  const text = io.readFile(
    path.join(cwd, "node_modules", "nuxt", "package.json"),
  );
  if (text == null) return null;
  try {
    const pkg = JSON.parse(text) as { version?: string };
    const major = Number.parseInt(String(pkg.version ?? "").trim(), 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

// --- next version handling ---------------------------------------------------

/**
 * `instrumentation-client.ts` is auto-loaded from Next 15.3+. Parse the leading
 * numeric range; treat non-numeric ranges ("latest", "canary", workspace:) as
 * new-enough.
 */
export function supportsInstrumentationClient(
  version: string | null | undefined,
): boolean {
  if (!version) return true;
  const m = version.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return true; // "latest" / "canary" / "workspace:*" -> assume current
  const major = Number(m[1]);
  const minor = m[2] ? Number(m[2]) : 0;
  if (major > 15) return true;
  if (major < 15) return false;
  return minor >= 3;
}

// --- per-recipe builders -----------------------------------------------------

function firstExistingDir(io: InjectIO, ...dirs: string[]): string | null {
  return dirs.find((d) => io.exists(d)) ?? null;
}

/**
 * Every extension Next will auto-load an instrumentation-client under. Checking
 * only `.ts` is how a real install (Alertbase PR #544) created
 * `website/src/instrumentation-client.ts` next to an existing root
 * `instrumentation-client.js` carrying Sentry and PostHog. That app keeps its
 * pages in `src/`, so Next resolves from `src/` and the NEW file wins: the
 * customer would have silently lost two vendors to gain one.
 */
const INSTRUMENTATION_CLIENT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
] as const;

export interface InstrumentationClientLookup {
  /** The file Next will actually load, or null when there is none. */
  loaded: string | null;
  /**
   * Every other instrumentation-client on disk. Next ignores these, so we must
   * not edit them and the caller reports them as untouched.
   */
  shadowed: string[];
}

/**
 * Find the instrumentation-client Next will load.
 *
 * Next accepts the file at the project root or under `src/`, and resolves it
 * from whichever directory holds `app/` or `pages/`. `baseDir` is that
 * directory, so a file there wins over one in the other candidate directory.
 * Callers must wire into `loaded` rather than creating a sibling: a second file
 * does not merge with the first, it replaces it.
 */
export function findInstrumentationClient(
  io: InjectIO,
  cwd: string,
  baseDir: string,
): InstrumentationClientLookup {
  const otherDir = baseDir === cwd ? path.join(cwd, "src") : cwd;
  const found: string[] = [];
  for (const dir of [baseDir, otherDir]) {
    for (const ext of INSTRUMENTATION_CLIENT_EXTENSIONS) {
      const candidate = path.join(dir, `instrumentation-client${ext}`);
      if (io.exists(candidate)) found.push(candidate);
    }
  }
  return { loaded: found[0] ?? null, shadowed: found.slice(1) };
}

function planNext(input: BuildPlanInput, io: InjectIO): Plan {
  const { cwd } = input;
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    input.backendOrigins,
  );
  // Prefer `src/` when the app uses a src directory.
  const usesSrc =
    io.exists(path.join(cwd, "src", "app")) ||
    io.exists(path.join(cwd, "src", "pages"));
  const baseDir = usesSrc ? path.join(cwd, "src") : cwd;

  // Gate on the INSTALLED next version when available (a declared range like
  // `^15` can resolve to a legacy or a modern install); fall back to the
  // declared range from detection.
  const effectiveVersion = installedNextVersion(cwd, io) ?? input.nextVersion;

  if (supportsInstrumentationClient(effectiveVersion)) {
    const { loaded, shadowed } = findInstrumentationClient(io, cwd, baseDir);
    if (loaded) {
      const existing = io.readFile(loaded);
      if (existing) {
        const existingPlan = existingIntegrationPlan(input, io, existing);
        if (existingPlan) return existingPlan;
      }
      // A user-owned instrumentation-client already exists — prepend into it,
      // whatever its extension and whichever of the two directories it sits in.
      // Creating a sibling would replace it rather than join it.
      return prependWithPreflight(
        input,
        io,
        loaded,
        block,
        shadowed.length
          ? [
              `Wired into ${path.relative(cwd, loaded)}, the instrumentation client Next loads. Left untouched because Next ignores them: ${shadowed
                .map((p) => path.relative(cwd, p))
                .join(", ")}.`,
            ]
          : undefined,
      );
    }
    return createPlan(
      input,
      path.join(baseDir, "instrumentation-client.ts"),
      block,
    );
  }

  // Older Next (<15.3): instrumentation-client.ts is NOT auto-loaded, so the
  // client init must land in a module that actually executes in the browser.
  const pagesApp =
    firstExistingDir(
      io,
      path.join(baseDir, "pages", "_app.tsx"),
      path.join(baseDir, "pages", "_app.jsx"),
    ) ?? null;
  if (pagesApp) {
    // (a) Pages Router: _app is a client-executed root — safe to prepend.
    return prependWithPreflight(input, io, pagesApp, block, [
      "Older Next.js — prepending into pages/_app; move to instrumentation-client.ts after upgrading to 15.3+.",
    ]);
  }

  const appLayout =
    firstExistingDir(
      io,
      path.join(baseDir, "app", "layout.tsx"),
      path.join(baseDir, "app", "layout.jsx"),
    ) ?? null;
  if (appLayout) {
    // (b) App Router only, legacy Next: the root layout is a Server Component
    // that never ships to the browser, so prepending client init there captures
    // nothing. Hand off with a concrete path forward instead.
    return fallbackPlan(input, block, [
      'Next <15.3 with only an app-router root layout: client init can\'t be prepended into app/layout (a Server Component that never ships to the browser). Add the snippet to a "use client" module imported by the root layout, or upgrade to Next 15.3+ for the auto-loaded instrumentation-client.ts.',
    ]);
  }

  // (c) Neither a pages/_app nor an app/layout was found.
  return fallbackPlan(input, block, [
    "Older Next.js detected but no app/layout or pages/_app file was found.",
  ]);
}

function planSvelteKit(input: BuildPlanInput, io: InjectIO): Plan {
  const target = path.join(input.cwd, "src", "hooks.client.ts");
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    input.backendOrigins,
  );
  if (io.exists(target)) {
    return prependWithPreflight(input, io, target, block);
  }
  return createPlan(input, target, block);
}

function planNuxt(input: BuildPlanInput, io: InjectIO): Plan {
  const { cwd } = input;
  // Nuxt 4's default srcDir is app/, so plugins are scanned from app/plugins/;
  // Nuxt 3 scans plugins/ from the project root. Getting this wrong is a silent
  // zero-capture in either direction — neither version loads the other's path.
  //
  // The installed major decides it. A bare `app/` existence probe does not: Nuxt
  // 3 also recognises a root-level app/ directory (app/router.options.ts), so
  // such a project was misread as Nuxt 4 and got a plugin Nuxt 3 never scans.
  // The probe stays as the fallback for when the version cannot be read (nuxt
  // not installed yet), where an app/ directory is still the best signal there
  // is.
  const major = installedNuxtMajor(cwd, io);
  const usesAppDir =
    major != null ? major >= 4 : io.exists(path.join(cwd, "app"));
  const baseDir = usesAppDir ? path.join(cwd, "app") : cwd;
  const target = path.join(baseDir, "plugins", "crumbtrail.client.ts");
  const block = nuxtPluginSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    input.backendOrigins,
  );
  if (io.exists(target)) {
    const existing = io.readFile(target);
    if (existing) {
      const existingPlan = existingIntegrationPlan(input, io, existing);
      if (existingPlan) return existingPlan;
    }
    // Don't clobber an existing user plugin of the same name — hand off.
    return fallbackPlan(input, block, [
      `${target} already exists and isn't Crumbtrail's — wire it manually.`,
    ]);
  }
  return createPlan(input, target, block);
}

function planVite(input: BuildPlanInput, io: InjectIO): Plan {
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    input.backendOrigins,
  );
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Vite entry from index.html — wire it manually.",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Create React App, including craco / react-app-rewired. Byte-identical to the
 * Vite plan apart from the entry it prepends into and the key expression the
 * registry supplies (`process.env.REACT_APP_*` rather than `import.meta.env`):
 * both are client bundles whose module graph starts at one file.
 */
function planCra(input: BuildPlanInput, io: InjectIO): Plan {
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    input.backendOrigins,
  );
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve src/index.{tsx,jsx,ts,js} — wire it manually.",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Shared backend-JS plan builder. Hono, Fastify, Nest, and the generic Node
 * recipe inject (Express has its own builder, planExpress, which also wires the
 * request/error middleware pair) the same self-contained `autoCapture` block (the only
 * prepend-safe server snippet — no `app` handle is available at the top of a
 * file). The block reads the key from process.env.CRUMBTRAIL_KEY, which the user
 * sets themselves (hands-off — the installer writes no key).
 *
 * This one block is enough for frontend to backend correlation on all four:
 * `autoCapture` hooks `http.Server`, which is what every Node framework's
 * listener ends up being, so a request carrying the browser's session and
 * request ids is recorded whichever of them served it. That is deliberate —
 * these recipes are byte-identical because there is nothing framework-specific
 * left to wire, not because a middleware is missing.
 *
 * The one snippet divergence is Nest: its scaffold ships a `.prettierrc` with
 * `singleQuote: true`, so it gets the single-quoted `nestInitSnippet` to avoid
 * cosmetic diff/lint noise. Every other backend-JS recipe keeps the
 * double-quoted `nodeInitSnippet` (Prettier's own default).
 */
function planNode(input: BuildPlanInput, io: InjectIO): Plan {
  const keyRef = keyRefFor(input)!;
  const keyExpr = keyRef.expr;
  // Nest's scaffold ships `singleQuote: true`; every other backend-JS recipe
  // takes Prettier's double-quote default. Both halves of the block have to
  // agree with the file they land in, so the quote choice is made once here.
  const quote =
    input.recipe === "nestjs"
      ? (value: string) => `'${value}'`
      : JSON.stringify;
  const init =
    input.recipe === "nestjs"
      ? nestInitSnippet(input.endpoint, keyExpr, input.serviceName)
      : nodeInitSnippet(input.endpoint, keyExpr, input.serviceName);
  // Preload first: the init below reads the key, and on a laptop the key is in
  // .env and nothing has loaded it yet.
  const block = `${envPreloadSnippet(keyRef.envVar, quote, packageDirFromRepoRoot(input.cwd, io))}\n\n${init}`;

  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Node server entry — wire it manually.",
    ]);
  }
  const manifest = deployManifestNaming(input.cwd, io, input.entryFile);
  return prependWithPreflight(
    input,
    io,
    input.entryFile,
    block,
    manifest
      ? [
          `${path.relative(input.cwd, input.entryFile)} is the entry ${manifest} starts, so that is the process this wiring covers.`,
        ]
      : [],
  );
}

/**
 * Express. Injects the same autoCapture block as the other backend-JS recipes,
 * AND wires the request + error middleware. autoCapture's `node:http` hook
 * already records inbound requests on every framework, so linkage no longer
 * depends on this wiring; the middleware is what adds the matched route and the
 * error the handler threw, and it claims the request so the http hook stays
 * silent rather than reporting it twice.
 *
 * When the entry matches the common shape (an `express` import, a
 * `const app = express()` line, an `app.listen(...)` line), the file is
 * rewritten with the middleware registered in the right positions: request
 * middleware right after app creation (before routes), error middleware just
 * above listen (after routes). When any anchor is missing we fall back to the
 * prepend path with a TODO block carrying exact copy and paste lines, and the
 * wizard prints the same instructions.
 */
function planExpress(input: BuildPlanInput, io: InjectIO): Plan {
  const { endpoint } = input;
  const keyRef = keyRefFor(input)!;
  const keyExpr = keyRef.expr;
  const keyEnvVar = keyRef.envVar;
  const packageRel = packageDirFromRepoRoot(input.cwd, io);
  const block = nodeInitSnippet(endpoint, keyExpr, input.serviceName);
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Node server entry — wire it manually.",
    ]);
  }
  const target = input.entryFile;
  const existing = io.readFile(target);
  if (existing == null) {
    return fallbackPlan(input, block, [
      `Could not read ${target}; use the snippet or AI prompt to wire it manually.`,
    ]);
  }
  const existingPlan = existingIntegrationPlan(input, io, existing);
  if (existingPlan) return existingPlan;

  const style = detectExpressModuleStyle(existing);
  const wired = style
    ? wireExpressMiddleware(
        existing,
        (appVar) => expressRequestMiddlewareSnippet(appVar, endpoint, keyExpr),
        (appVar) => expressErrorMiddlewareSnippet(appVar, endpoint, keyExpr),
      )
    : null;

  if (wired == null) {
    // Anchors not found: prepend autoCapture plus a TODO block with exact copy
    // and paste instructions, and surface the same guidance in wizard output.
    const combined = `${envPreloadSnippet(keyEnvVar, JSON.stringify, packageRel)}\n\n${block}\n\n${expressManualWiringSnippet(endpoint, keyExpr)}`;
    return prependWithPreflight(input, io, target, combined, [
      "Express request middleware was NOT wired automatically (no `const app = express()` / `app.listen(...)` anchors found). Follow the TODO block added at the top of the entry: register createCrumbtrailExpressMiddleware before your routes and createCrumbtrailExpressErrorMiddleware after them, or backend request spans stay empty.",
    ]);
  }

  // Full rewrite: middleware wired around the routes, plus the autoCapture block
  // and the middleware import prepended after any shebang/directive prologue.
  const cors = widenCorsAllowedHeaders(wired.text);
  const content = prependIntoSource(
    cors.text,
    `${envPreloadSnippet(keyEnvVar, JSON.stringify, packageRel)}\n\n${block}\n\n${expressMiddlewareImportSnippet(style!)}`,
  );
  const warnings = [
    ...corsWarnings(cors, input.recipe),
    wired.errorAnchor === "existing-error-handler"
      ? "Wired Express request middleware (before routes) and error middleware above the app's existing error handler, so it is reached before that handler ends the response."
      : "Wired Express request middleware (before routes) and error middleware (after routes) for backend request capture.",
  ];
  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content,
      applyMode: "rewrite",
      warnings: [
        ...warnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before editing.`,
      ],
    };
  }
  return {
    recipe: input.recipe,
    kind: "rewrite",
    targetPath: target,
    content,
    warnings,
  };
}

/**
 * Remix / React Router v7. Prepends the client init into the resolved
 * `app/entry.client.*`. When that entry is absent we FALL BACK rather than
 * create one — a bare init-only entry.client would omit hydrateRoot /
 * <RemixBrowser> and break hydration (a deliberate divergence from planNext).
 */
function planRemix(input: BuildPlanInput, io: InjectIO): Plan {
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    input.backendOrigins,
  );
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve app/entry.client.* — on a React Router 7 default template the client entry is hidden, so run `npx react-router reveal` to unhide app/entry.client.tsx (and entry.server.tsx), then re-run the wizard. Otherwise add the snippet to your Remix client entry manually (do not let the CLI create it; it would omit hydrateRoot).",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Astro. There is no single deterministic client entry, so this recipe always
 * hands off the filled snippet + agent prompt as a guided path — the user drops
 * it into a client-side `<script>` in a shared layout (`.astro`). Honest
 * guidance, not an apology.
 */
function planAstro(input: BuildPlanInput, _io: InjectIO): Plan {
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    input.backendOrigins,
  );
  return fallbackPlan(input, block, [
    "Astro has no single client entry — add this snippet inside a client-side <script> in a shared layout (e.g. src/layouts/*.astro) so it runs on every page.",
  ]);
}

/**
 * Angular. Mirrors planVite: prepend the client init above Angular's
 * `bootstrapApplication`/`platformBrowserDynamic` call in the resolved
 * `src/main.ts`; fall back when the entry is unresolved.
 */
function planAngular(input: BuildPlanInput, _io: InjectIO): Plan {
  // A standard Angular browser build exposes neither import.meta.env nor
  // process.env, so there is no hands-off env var to read (hence no keyRef in the
  // registry). Emit guidance to add the key to environment.ts and wire it by hand
  // rather than injecting code that would reference an undefined variable.
  const block = clientInitSnippet(
    input.endpoint,
    "environment.crumbtrailKey",
    input.serviceName,
    input.backendOrigins,
  );
  return fallbackPlan(input, block, [
    "Angular has no browser-safe env-var mechanism — add `crumbtrailKey: '<your-ingest-key>'` to src/environments/environment.ts (get your key from the dashboard), import `environment`, and prepend the snippet above bootstrapApplication in src/main.ts.",
  ]);
}

/**
 * The script block a page with no bundler gets, filled for this run.
 * Shared by the `static` recipe and by the Express pass that wires the frontend
 * an API serves out of `express.static`, so both pages get identical wiring.
 */
function staticBlockFor(input: BuildPlanInput): string {
  return staticScriptTagSnippet({
    endpoint: input.endpoint,
    keyLiteral: KEY_PLACEHOLDER,
    serviceName: input.serviceName,
    backendOrigins: input.backendOrigins,
    sdkVersion: input.sdkVersion,
    mintUrl: input.mintUrl,
  });
}

/**
 * A frontend with no framework and no bundler: a hand-written index.html, or a
 * page served as files.
 *
 * The whole point of this recipe is that it ends somewhere. Before it existed
 * this project matched nothing, and the wizard exited 1 on "No supported
 * framework" — which is how a user with half an app in the browser concluded
 * Crumbtrail had no browser capture at all. There IS a correct wiring for this
 * page; it is a script tag, so that is what gets written.
 *
 * The key is a placeholder in the file rather than a live credential: a page
 * served as files has no env mechanism, and minting a real key into a file the
 * user is about to commit is the one outcome worse than an unfinished TODO.
 */
function planStatic(input: BuildPlanInput, io: InjectIO): Plan {
  const block = staticBlockFor(input);
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "No HTML file to wire here (the page found was build output, or there is none). Paste the script tag below into the <head> of the page's SOURCE, so the next build keeps it.",
    ]);
  }
  const target = input.entryFile;
  const html = io.readFile(target);
  if (html == null) {
    return fallbackPlan(input, block, [
      `Could not read ${target}; paste the script tag below into its <head>.`,
    ]);
  }
  if (htmlReferencesCrumbtrail(html)) {
    return skipPlan(input, [
      `${path.relative(input.cwd, target) || target} already references Crumbtrail — left as it is.`,
    ]);
  }
  const wired = insertIntoHtmlHead(html, block);
  if (wired == null) {
    return fallbackPlan(input, block, [
      `${path.relative(input.cwd, target) || target} has no <head> or <body> to insert into; paste the script tag below into the page yourself.`,
    ]);
  }
  const warnings = [
    `The ingest key goes in the tag as a literal: a page with no bundler has no env var to read. Replace ${KEY_PLACEHOLDER} in ${path.relative(input.cwd, target) || target} before deploying.`,
  ];
  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content: wired,
      applyMode: "rewrite",
      keyIsSourceLiteral: true,
      warnings: [
        ...warnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before editing it.`,
      ],
    };
  }
  return {
    recipe: input.recipe,
    kind: "rewrite",
    targetPath: target,
    content: wired,
    warnings,
    keyIsSourceLiteral: true,
  };
}

/**
 * The frontend an Express app serves out of `express.static`.
 *
 * Detection stops at the backend dependency, so this app used to be wired for
 * its API and left completely dark in the browser — with nothing printed saying
 * a frontend had been seen and skipped. The served directory is read off the
 * entry itself, and the page in it is wired with the same script tag a
 * standalone static site gets.
 *
 * A page under build output is NOT edited: the next build erases it. That case
 * gets a named next action instead — wire the source app that produces it.
 */
function planServedStaticFrontend(
  input: BuildPlanInput,
  io: InjectIO,
  entrySource: string,
): { edits: NonNullable<Plan["extraEdits"]>; warnings: string[] } {
  const edits: NonNullable<Plan["extraEdits"]> = [];
  const warnings: string[] = [];
  const entryDir = path.dirname(input.entryFile ?? path.join(input.cwd, "x"));
  const reader: FileReader = {
    readFile: (p) => io.readFile(p),
    isFile: (p) => io.exists(p),
    isDir: (p) => io.exists(p),
    readDir: () => [],
    root: input.cwd,
  };
  for (const dir of findStaticMountDirs(entrySource)) {
    const candidates = [
      path.resolve(entryDir, dir),
      path.resolve(input.cwd, dir),
    ];
    const indexPath = candidates
      .map((base) => path.join(base, "index.html"))
      .find((file) => io.readFile(file) !== null);
    const shown = dir.replace(/^\.\//, "");
    if (!indexPath) {
      warnings.push(
        `This server serves static files from ${shown}, but there is no index.html in it to wire, so the browser half of this app is not captured yet. Wire the app that produces those files (\`cd <that app> && npx crumbtrail\`).`,
      );
      continue;
    }
    if (isBuildOutputPath(input.cwd, indexPath, reader)) {
      warnings.push(
        `This server serves a built frontend from ${shown}. Crumbtrail did not edit it — the next build would erase the change. Wire that frontend's SOURCE instead (\`cd <frontend app> && npx crumbtrail\`), and it will be captured from the next build on.`,
      );
      continue;
    }
    const html = io.readFile(indexPath)!;
    if (htmlReferencesCrumbtrail(html)) continue;
    const wired = insertIntoHtmlHead(
      html,
      staticScriptTagSnippet({
        endpoint: input.endpoint,
        keyLiteral: KEY_PLACEHOLDER,
        // The SAME service as the server, deliberately. This page is served by
        // that process, from that origin — it is the browser half of one
        // deployed app, not a second one. Inventing a `-web` name here would
        // file every browser session under a service the wizard never
        // provisioned, which is a label nothing in the dashboard can show.
        serviceName: input.serviceName,
        backendOrigins: input.backendOrigins,
        sdkVersion: input.sdkVersion,
        mintUrl: input.mintUrl,
      }),
    );
    if (wired == null) {
      warnings.push(
        `${path.relative(input.cwd, indexPath) || indexPath} is served to browsers but has no <head> or <body> to insert into, so it was left alone.`,
      );
      continue;
    }
    const rel = path.relative(input.cwd, indexPath) || indexPath;
    edits.push({
      path: indexPath,
      mode: "update",
      content: wired,
      label: `wired the static frontend served from ${shown}`,
    });
    warnings.push(
      `Wired browser capture into ${rel}, the page this server serves. Replace ${KEY_PLACEHOLDER} in it with your ingest key — a page with no bundler has no env var to read.`,
    );
  }
  return { edits, warnings };
}

/**
 * The two web hosts a Capacitor app can be wired through, and the only thing
 * that differs between them: how browser code is allowed to read an env var.
 */
const CAPACITOR_ANGULAR_KEY_EXPR = "environment.crumbtrailKey";

/**
 * Ionic ships both a Vite flavour (React/Vue/vanilla) and an Angular one, and
 * they disagree on exactly one point. A Vite build substitutes
 * `import.meta.env.VITE_*` at bundle time; a standard Angular browser build
 * exposes neither `import.meta.env` nor `process.env`, so injecting the Vite
 * expression there would emit code that references an undefined value and fail
 * at runtime with no useful error.
 *
 * The entry file is the discriminator, and it is unambiguous: `resolveViteEntry`
 * only resolves through a root `index.html`, while `resolveAngularEntry` only
 * ever returns `src/main.ts`.
 */
function isAngularHostedCapacitor(entryFile: string): boolean {
  return path.basename(entryFile) === "main.ts";
}

/**
 * Capacitor / Ionic.
 *
 * Injects into the web entry, exactly like the Vite and Angular recipes — the
 * app IS a web build. The difference is which init it calls:
 * `createCapacitorCrumbtrailAsync` runs the same `Crumbtrail.init` underneath
 * and then attaches the native collectors, so the wired app gets both halves
 * rather than web capture with a phone-shaped blind spot.
 */
function planCapacitor(input: BuildPlanInput, io: InjectIO): Plan {
  const entryFile = input.entryFile;
  const angularHosted = entryFile ? isAngularHostedCapacitor(entryFile) : false;
  const keyExpr = angularHosted
    ? CAPACITOR_ANGULAR_KEY_EXPR
    : keyExprFor(input)!;
  const block = capacitorInitSnippet(
    input.endpoint,
    keyExpr,
    input.serviceName,
    input.backendOrigins,
  );

  // Native plugins are optional peers, so the SDK degrades rather than failing
  // without them — but a user who installs none gets web capture and no phone
  // context at all, which is the outcome they came here to avoid. Say so.
  const warnings = [
    "Capacitor context comes from optional plugins — install the ones you want captured: @capacitor/app (foreground/background, deep links), @capacitor/device (model, OS, WebView version), @capacitor/network (connectivity), @capacitor/preferences (session continuity across cold starts).",
    "Run `npx cap sync` after installing, or the native projects will not pick the plugins up.",
  ];
  if (angularHosted) {
    warnings.push(
      "Angular has no browser-safe env-var mechanism — add `crumbtrailKey: '<your-ingest-key>'` to src/environments/environment.ts (get your key from the dashboard) and import `environment` in src/main.ts.",
    );
  }

  if (!entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Capacitor web entry — wire it manually.",
      ...warnings,
    ]);
  }

  return prependWithPreflight(input, io, entryFile, block, warnings);
}

/**
 * Flutter.
 *
 * The only recipe that edits inside a function rather than prepending. Capture
 * has to start before `runApp` and has to be awaited, so `wireFlutterMain`
 * transforms `main`: import added, `main` made async, the start call inserted as
 * its first statement. When the file is not in a shape that can be transformed
 * with certainty, this hands back Dart guidance rather than a near-miss edit —
 * a wrong guess here either fails to compile or, worse, compiles and captures
 * nothing.
 *
 * It does NOT use `fallbackPlan`. That builds a JavaScript agent prompt from the
 * registry stack, which for a Dart app would instruct an agent to install npm
 * packages into a project that has no package.json.
 */
function planFlutter(input: BuildPlanInput, io: InjectIO): Plan {
  const keyExpr = keyExprFor(input)!;
  const snippet = flutterInitSnippet(
    input.endpoint,
    keyExpr,
    input.serviceName,
  );
  // The key is compile-time in Dart, so it is supplied at build rather than
  // read from a .env the app can see at runtime. Say so once, everywhere.
  const buildNote =
    "Flutter reads the key at build time — pass it with `--dart-define=CRUMBTRAIL_KEY=<your-ingest-key>` on `flutter run` and `flutter build` (get your key from the dashboard).";

  const flutterFallback = (warnings: string[]): Plan => ({
    recipe: input.recipe,
    kind: "fallback-ai",
    targetPath: null,
    content: null,
    snippet,
    agentPrompt: [
      "Wire the Crumbtrail Flutter SDK into this app.",
      "",
      "1. Run `flutter pub add crumbtrail_flutter`.",
      "2. In lib/main.dart, make `main` async and await `Crumbtrail.start` before `runApp`:",
      "",
      snippet,
      "",
      "3. Add `CrumbtrailNavigatorObserver()` to the app's navigatorObservers (or the router's observers) so screen changes are captured.",
      `4. ${buildNote}`,
    ].join("\n"),
    warnings,
  });

  const target = input.entryFile;
  if (!target) {
    return flutterFallback([
      "Could not resolve lib/main.dart — wire it manually.",
      buildNote,
    ]);
  }

  const existing = io.readFile(target);
  if (existing == null) {
    return flutterFallback([
      `Could not read ${target}; wire it manually.`,
      buildNote,
    ]);
  }
  const existingPlan = existingIntegrationPlan(input, io, existing);
  if (existingPlan) return existingPlan;

  const wired = wireFlutterMain(
    existing,
    FLUTTER_IMPORT_LINE,
    flutterInitLines(input.endpoint, keyExpr, input.serviceName),
  );
  if (wired == null) {
    return flutterFallback([
      `Could not find a single \`main()\` to wire in ${target} (an arrow-bodied main, or more than one, is not transformed automatically).`,
      buildNote,
    ]);
  }

  const warnings = [
    buildNote,
    // Errors and lifecycle are installed by start(); navigation is not, because
    // the observer has to be handed to the app's navigator and the injector
    // cannot edit a widget tree. Without it a timeline has no screen context.
    "Add `CrumbtrailNavigatorObserver()` to your MaterialApp's `navigatorObservers` (or your router's `observers`) to capture screen changes.",
  ];

  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content: wired,
      applyMode: "rewrite",
      warnings: [
        ...warnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before editing.`,
      ],
    };
  }

  return {
    recipe: input.recipe,
    kind: "rewrite",
    targetPath: target,
    content: wired,
    warnings,
  };
}

function planReactNative(input: BuildPlanInput, io: InjectIO): Plan {
  // Session continuity needs a store, and on React Native that is AsyncStorage.
  // Only wire it when the app already has it: Metro resolves every import at
  // bundle time, so emitting the import for a package that is not installed
  // would trade a lost session id for an app that does not build.
  const hasAsyncStorage = dependsOn(
    input.cwd,
    io,
    "@react-native-async-storage/async-storage",
  );
  const block = reactNativeInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    hasAsyncStorage,
    input.backendOrigins,
  );
  const warnings = hasAsyncStorage
    ? []
    : [
        "No @react-native-async-storage/async-storage in this app, so Crumbtrail wired capture without session continuity: every cold start opens a new session, and an intermittent bug never accumulates into one signature. Install it (`npx expo install @react-native-async-storage/async-storage`) and re-run `npx crumbtrail` to wire the store in.",
      ];
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the React Native entry (App/_layout/index) — wire it manually.",
      ...warnings,
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block, warnings);
}

/**
 * Two Rust-side steps the CLI can't perform (JS injection only): without them
 * the wired JS transport invokes a plugin that isn't registered, so capture
 * silently does nothing. Sourced from packages/tauri/README.md steps 1-2 —
 * kept short, pointing at the README for the exact snippets.
 */
const TAURI_RUST_WARNINGS = [
  "Tauri also needs a Rust step the CLI can't do: register the plugin in src-tauri — add `tauri-plugin-crumbtrail` to Cargo.toml and `.plugin(tauri_plugin_crumbtrail::init())` in lib.rs (packages/tauri/README.md, step 1).",
  "Grant the plugin permission: add `crumbtrail:default` to src-tauri/capabilities/default.json, or every Crumbtrail invoke fails (packages/tauri/README.md, step 2).",
];

function planTauri(input: BuildPlanInput, io: InjectIO): Plan {
  // The Tauri transport routes to the local Rust store, so the block needs no
  // endpoint/apiKey — but they still thread through fallbackPlan's agent prompt.
  const block = tauriInitSnippet();
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Tauri frontend entry from index.html — wire it manually.",
      ...TAURI_RUST_WARNINGS,
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block, [
    ...TAURI_RUST_WARNINGS,
  ]);
}

function appendPythonRequirements(
  source: string,
  stack: Stack,
): { content: string; packages: string[] } | null {
  const packages = pythonOtelPackages(
    stack,
    /(^|\n)\s*celery(?:\s|[=<>!~])/i.test(`\n${source}`),
  );
  if (packages.length === 0) return null;
  const declared = new Set(
    source
      .split(/\r?\n/)
      .map((line) =>
        line
          .trim()
          .match(/^([A-Za-z0-9_.-]+)/)?.[1]
          ?.toLowerCase(),
      )
      .filter((name): name is string => Boolean(name)),
  );
  const missing = packages.filter((pkg) => !declared.has(pkg));
  return {
    content:
      missing.length === 0
        ? source
        : `${source.replace(/\s*$/, "")}\n${missing.join("\n")}\n`,
    packages,
  };
}

function planPythonOtlp(input: BuildPlanInput, io: InjectIO): Plan | null {
  const stack = input.stack;
  if (!stack || pythonOtelPackages(stack).length === 0) return null;
  const requirementsPath = path.join(input.cwd, "requirements.txt");
  const procfilePath = path.join(input.cwd, "Procfile");
  const helperPath = path.join(input.cwd, "crumbtrail_otel.py");
  const requirements = io.readFile(requirementsPath);
  const procfile = io.readFile(procfilePath);
  const existingHelper = io.readFile(helperPath);
  if (requirements == null || procfile == null) return null;
  if (
    existingHelper != null &&
    !existingHelper.startsWith("# Generated by Crumbtrail.\n")
  ) {
    return null;
  }

  const dependencyEdit = appendPythonRequirements(requirements, stack);
  if (!dependencyEdit) return null;
  const serviceName = input.serviceName?.trim() || "backend";
  const endpoint = input.endpoint.replace(/\/$/, "");
  const helperContent = [
    "# Generated by Crumbtrail.",
    "import os",
    "import sys",
    "",
    "from dotenv import load_dotenv",
    "",
    "load_dotenv(override=False)",
    `os.environ.setdefault("OTEL_SERVICE_NAME", ${JSON.stringify(serviceName)})`,
    `os.environ.setdefault("OTEL_EXPORTER_OTLP_ENDPOINT", ${JSON.stringify(endpoint)})`,
    'os.environ.setdefault("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")',
    'os.environ.setdefault("OTEL_TRACES_EXPORTER", "otlp")',
    'os.environ.setdefault("OTEL_METRICS_EXPORTER", "none")',
    'os.environ.setdefault("OTEL_LOGS_EXPORTER", "none")',
    'key = os.environ.get("CRUMBTRAIL_KEY")',
    'if key and "OTEL_EXPORTER_OTLP_HEADERS" not in os.environ:',
    '    os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = f"X-Crumbtrail-Auth={key}"',
    "",
    'os.execvp("opentelemetry-instrument", ["opentelemetry-instrument", *sys.argv[1:]])',
    "",
  ].join("\n");
  let processes = 0;
  let configured = 0;
  let wrapped = 0;
  const procfileContent = procfile.replace(
    /^(web|worker):\s+(.+)$/gm,
    (line, process: string, command: string) => {
      processes += 1;
      if (
        command.includes("python crumbtrail_otel.py") &&
        existingHelper === helperContent
      ) {
        configured += 1;
        return line;
      }
      if (/OTEL_EXPORTER_OTLP_|CRUMBTRAIL_KEY/.test(command)) return line;
      wrapped += 1;
      const launch = command.replace(/^opentelemetry-instrument\s+/, "");
      return `${process}: python crumbtrail_otel.py ${launch}`;
    },
  );
  if (
    processes > 0 &&
    configured === processes &&
    dependencyEdit.content === requirements
  ) {
    const plan = skipPlan(input);
    plan.keyEnvVar = "CRUMBTRAIL_KEY";
    return plan;
  }
  if (wrapped === 0) return null;

  const dirty = [procfilePath, requirementsPath, helperPath].some(
    (target) => io.gitStatus(input.cwd, target).dirty,
  );
  return {
    recipe: input.recipe,
    kind: dirty ? "needs-confirm-dirty" : "rewrite",
    targetPath: procfilePath,
    content: procfileContent,
    ...(dirty ? { applyMode: "rewrite" as const } : {}),
    extraEdits: [
      {
        path: requirementsPath,
        mode: "update",
        content: dependencyEdit.content,
        label: `added ${dependencyEdit.packages.join(", ")} to requirements.txt`,
      },
      {
        path: helperPath,
        mode: existingHelper == null ? "create" : "update",
        content: helperContent,
        label: "added the Python OpenTelemetry launch helper",
      },
    ],
    sdkPackages: dependencyEdit.packages,
    keyEnvVar: "CRUMBTRAIL_KEY",
    warnings: [
      "Crumbtrail will add Python OpenTelemetry dependencies and wrap the Procfile web and worker commands with zero code instrumentation.",
      "Python automatic instrumentation currently exports traces. Metrics and logs remain off.",
    ],
  };
}

/**
 * OTLP setup for non-JS backends. Python requirements plus Procfile projects
 * get a deterministic zero-code edit; every other shape keeps the guidance
 * path because its dependency and launch configuration cannot be inferred.
 */
function planOtlp(input: BuildPlanInput, io: InjectIO): Plan {
  const automaticPython = planPythonOtlp(input, io);
  if (automaticPython) return automaticPython;
  const stack: Stack = input.stack ?? RECIPE_REGISTRY[input.recipe].stack;
  // Hands-off: the guidance carries a placeholder the user replaces with the key
  // they mint in the dashboard, never a live minted key.
  const otlp = buildOtlpSnippets({
    endpoint: input.endpoint,
    apiKey: KEY_PLACEHOLDER,
    serviceName: input.serviceName,
  });
  const snippet = [
    otlp.env,
    "",
    otlp.authHeader,
    "",
    otlp.serviceName,
    "",
    otlp.sessionAttr,
    "",
    `# ${otlp.note}`,
  ].join("\n");
  return {
    recipe: input.recipe,
    kind: "otlp-guidance",
    targetPath: null,
    content: null,
    snippet,
    // The receiver resolves an app from the standard `service.name` resource
    // attribute when the ingest key names none, so the OTLP path can declare
    // which app it is: the snippet sets OTEL_SERVICE_NAME and the prompt says
    // to keep it.
    agentPrompt: buildAgentPrompt(
      stack,
      { endpoint: input.endpoint, apiKey: KEY_PLACEHOLDER },
      { serviceName: input.serviceName },
    ),
    warnings: [],
  };
}

function planCloudflareWorkers(input: BuildPlanInput, io: InjectIO): Plan {
  const endpoint = input.endpoint.replace(/\/$/, "");
  const usesToml = io.exists(path.join(input.cwd, "wrangler.toml"));
  const config = usesToml
    ? [
        "Then add this to wrangler.toml and redeploy:",
        "[observability.traces]",
        "enabled = true",
        'destinations = ["crumbtrail-traces"]',
        "persist = false",
        "",
        "[observability.logs]",
        "enabled = true",
        'destinations = ["crumbtrail-logs"]',
        "persist = false",
      ]
    : [
        "Then add this to wrangler.jsonc and redeploy:",
        "{",
        '  "observability": {',
        '    "traces": {',
        '      "enabled": true,',
        '      "destinations": ["crumbtrail-traces"],',
        '      "persist": false',
        "    },",
        '    "logs": {',
        '      "enabled": true,',
        '      "destinations": ["crumbtrail-logs"],',
        '      "persist": false',
        "    }",
        "  }",
        "}",
      ];
  const snippet = [
    "Cloudflare dashboard > Workers Observability > Destinations:",
    `1. Add a traces destination named crumbtrail-traces with endpoint ${endpoint}/v1/traces.`,
    `2. Add a logs destination named crumbtrail-logs with endpoint ${endpoint}/v1/logs.`,
    `3. Add the custom header X-Crumbtrail-Auth: ${KEY_PLACEHOLDER} to both destinations.`,
    "",
    ...config,
    "",
    `Keep the Worker name stable${input.serviceName ? ` and use ${input.serviceName} as the Crumbtrail application name` : " so Cloudflare's service.name stays attributable"}.`,
  ].join("\n");

  return {
    recipe: input.recipe,
    kind: "otlp-guidance",
    targetPath: null,
    content: null,
    snippet,
    agentPrompt: [
      "Configure this Cloudflare Worker to export its native OpenTelemetry traces and logs to Crumbtrail.",
      "Do not install crumbtrail-node. The Workers runtime does not use node:http.",
      "Follow this exact setup:",
      snippet,
      "Verify the Worker deploys, then send a request and confirm the destination reports a successful delivery.",
    ].join("\n"),
    warnings: [
      "Cloudflare OpenTelemetry export requires a Workers Paid plan or contract.",
      "Cloudflare Workers does not export metrics through OpenTelemetry yet. This setup covers traces and logs.",
    ],
  };
}

// --- dispatcher --------------------------------------------------------------

/**
 * Build the injection Plan for a detected recipe. Reads only (via `io`); the
 * returned Plan is plain data the executor applies all-or-nothing.
 */
/**
 * A build artifact is never a legal injection target, whatever the caller says.
 *
 * Detection already refuses them, but buildPlan is also called directly (the
 * dashboard wizard, the batch installer, tests), and an edit written into
 * `dist/` is the worst possible failure: the run reports success, `tsc` erases
 * the edit on the next build, and the dev command that runs the source never
 * loaded it — silent zero capture with a green checkmark. Dropping the entry to
 * null here routes the recipe to its manual-snippet fallback, with the reason
 * stated.
 */
function refuseBuildOutputEntry(
  input: BuildPlanInput,
  io: InjectIO,
): { input: BuildPlanInput; warning: string | null } {
  const entry = input.entryFile;
  if (!entry) return { input, warning: null };
  const reader: FileReader = {
    readFile: (p) => io.readFile(p),
    isFile: (p) => io.exists(p),
    isDir: (p) => io.exists(p),
    readDir: () => [],
    root: input.cwd,
  };
  if (!isBuildOutputPath(input.cwd, entry, reader)) {
    return { input, warning: null };
  }
  return {
    input: { ...input, entryFile: null },
    warning: `${path.relative(input.cwd, entry) || entry} is build output, not source. Injecting there would be erased by the next build and never loaded by the dev command, so it was refused — wire the source entry manually with the snippet below.`,
  };
}

/**
 * The recipes whose apps run as Node processes, and so can start more than one
 * of them from the same package.
 */
const BACKEND_JS_RECIPES = new Set<Recipe>([
  "express",
  "fastify",
  "hono",
  "nestjs",
  "node",
]);

/**
 * Wire every OTHER process this package starts — the worker, the consumer, the
 * scheduler.
 *
 * Detection resolves the entry that serves HTTP, and stops there. The processes
 * beside it run unattended, which is precisely why their failures are the ones
 * worth capturing, and leaving them unwired means the wizard reports success
 * over a service that reports nothing at all.
 *
 * Each one is gated on its own: already wired is left alone, dirty is left alone
 * with a warning, and each reports under its own service name so a session says
 * which process it came from rather than being filed under the API.
 */
function planExtraBackendEntries(
  input: BuildPlanInput,
  io: InjectIO,
): {
  edits: NonNullable<Plan["extraEdits"]>;
  warnings: string[];
} {
  const edits: NonNullable<Plan["extraEdits"]> = [];
  const warnings: string[] = [];
  const keyRef = keyRefFor(input);
  if (!keyRef) return { edits, warnings };
  const packageRel = packageDirFromRepoRoot(input.cwd, io);

  const { entries, unwired } = findExtraBackendEntries(
    input.cwd,
    io,
    input.entryFile,
  );
  for (const entry of entries) {
    const existing = io.readFile(entry.path);
    if (existing == null) continue;
    const rel = path.relative(input.cwd, entry.path);
    if (referencesCrumbtrail(existing)) continue;

    const status = io.gitStatus(input.cwd, entry.path);
    if (status.dirty && !input.options?.force) {
      warnings.push(
        `${rel} is a second process this package starts (npm run ${entry.script}) and has uncommitted changes, so it was left unwired. Commit it and re-run, or re-run with force, or that process reports nothing.`,
      );
      continue;
    }

    const service = serviceNameForExtra(input.serviceName, entry);
    const block = `${envPreloadSnippet(keyRef.envVar, JSON.stringify, packageRel)}\n\n${nodeInitSnippet(input.endpoint, keyRef.expr, service)}`;
    edits.push({
      path: entry.path,
      mode: "update",
      content: prependIntoSource(existing, block),
      // Not "as service X": this pass edits code, it does not create the
      // application. Until the caller registers the name, or the process itself
      // first reports and ingest registers it, the dashboard's Applications
      // table has no such row, and the reader who goes looking for the name
      // this line just gave them finds nothing there.
      label: `wired ${rel} (npm run ${entry.script}) to report as ${service}, a new application that appears once that process first runs`,
      // What the same line may say once the caller HAS registered the name: the
      // row exists, so a reader sent looking for it finds it. Swapped in by the
      // caller and only after the registration returns, never here — this pass
      // cannot know whether one happened.
      registeredLabel: `wired ${rel} (npm run ${entry.script}) as application ${service}`,
      // Carried so the caller can register the name up front instead. Wiring
      // alone only decides what the sessions are labelled; the Applications
      // table is what the project has declared.
      serviceName: service,
    });
  }

  if (unwired.length > 0) {
    // Named, not counted. A count tells the user a hole exists without telling
    // them where it is, so the only way to close it was to re-derive the whole
    // scan by hand.
    const named = unwired
      .map(
        (entry) =>
          `${path.relative(input.cwd, entry.path)} (npm run ${entry.script})`,
      )
      .join(", ");
    warnings.push(
      `This package starts more than ${MAX_EXTRA_ENTRIES} other processes, so ${unwired.length === 1 ? "this one was" : "these were"} left unwired: ${named}. Wire ${unwired.length === 1 ? "it" : "them"} by copying the block from one that was.`,
    );
  }
  return { edits, warnings };
}

/**
 * `marginary` + `worker.ts` -> `marginary-worker`. Without a service name for
 * the app there is nothing to qualify, so the suffix stands alone.
 */
function serviceNameForExtra(
  serviceName: string | null | undefined,
  entry: ExtraEntry,
): string {
  return serviceName
    ? `${serviceName}-${entry.serviceSuffix}`
    : entry.serviceSuffix;
}

/**
 * Declare a bundler-inlined key as a Docker build arg.
 *
 * The frontend recipes bake their key into the bundle at build time, and a
 * Docker build cannot see a variable the Dockerfile has not declared. A
 * Dockerfile that lists every other `VITE_*` as an `ARG` and not this one builds
 * an image that can never carry a key, with nothing failing to say so.
 *
 * Only edited when the file already passes build args of the same prefix: that
 * is the project stating where such a line goes. Without them the shape is a
 * guess, and the user gets a warning naming the file instead of an edit.
 */
function planDockerBuildArg(
  input: BuildPlanInput,
  io: InjectIO,
): {
  edits: NonNullable<Plan["extraEdits"]>;
  warnings: string[];
} {
  const edits: NonNullable<Plan["extraEdits"]> = [];
  const warnings: string[] = [];
  const keyRef = keyRefFor(input);
  if (!keyRef?.bundlerInlined) return { edits, warnings };

  for (const candidate of DOCKERFILE_CANDIDATES) {
    const target = path.join(input.cwd, candidate);
    const existing = io.readFile(target);
    if (existing == null) continue;

    const result = addDockerBuildArg(existing, keyRef.envVar);
    if (!result.changed) {
      if (result.reason === "no-sibling-args") {
        warnings.push(
          `${candidate} builds this app in Docker but declares no build args, so ${keyRef.envVar} was not added to it. A bundler reads its key at build time, so add \`ARG ${keyRef.envVar}\` to the stage that runs the build (and pass it with --build-arg) or the image ships without a key.`,
        );
      }
      return { edits, warnings };
    }

    const status = io.gitStatus(input.cwd, target);
    if (status.dirty && !input.options?.force) {
      warnings.push(
        `${candidate} needs \`ARG ${keyRef.envVar}\` but has uncommitted changes, so it was left alone. Commit it and re-run, or re-run with force, or the built image carries no key.`,
      );
      return { edits, warnings };
    }

    edits.push({
      path: target,
      mode: "update",
      content: result.text,
      label: result.mirroredEnv
        ? `declared ${keyRef.envVar} as a build arg in ${candidate} (with its ENV mirror)`
        : `declared ${keyRef.envVar} as a build arg in ${candidate}`,
    });
    return { edits, warnings };
  }
  return { edits, warnings };
}

export function buildPlan(
  input: BuildPlanInput,
  io: InjectIO = defaultInjectIO,
): Plan {
  const refused = refuseBuildOutputEntry(input, io);
  input = refused.input;
  const plan = dispatchPlan(input, io);
  if (refused.warning) plan.warnings = [refused.warning, ...plan.warnings];
  // Stamp the env var the injected code reads its key from, so the wizard can
  // print "set <VAR> in .env — get your key from the dashboard". Undefined only
  // for recipes that inject no key (tauri / otlp / angular).
  //
  // An already-wired project needs this MORE, not less: the code on disk still
  // reads that variable. Withholding it made a re-run report the key as
  // missing and unnamed ("Set your ingest key"), even though the env file next
  // to the wiring already held it under a name the wizard knew.
  const keyRef = keyRefFor(input);
  if (keyRef) {
    plan.keyEnvVar = keyRef.envVar;
    if (keyRef.compileTime) plan.keyIsCompileTime = true;
  }

  // Everything above wires ONE file. These two passes cover what a deployed app
  // needs beyond it: the other processes it starts, and the build that bakes in
  // its key. Both run even when the entry itself was skipped or handed off,
  // because neither is answered by whatever happened to the entry.
  if (plan.kind !== "otlp-guidance") {
    const extra = BACKEND_JS_RECIPES.has(input.recipe)
      ? planExtraBackendEntries(input, io)
      : planDockerBuildArg(input, io);
    if (extra.edits.length > 0) {
      plan.extraEdits = [...(plan.extraEdits ?? []), ...extra.edits];
    }
    plan.warnings = [...plan.warnings, ...extra.warnings];
  }

  // A backend that serves its own frontend is TWO halves of one app, and only
  // one of them is answered by the recipe. This pass wires the other half — the
  // page served out of `express.static` — or says why it could not, so the
  // browser side is never silently dark.
  if (
    isBackendRecipe(input.recipe) &&
    plan.kind !== "otlp-guidance" &&
    input.entryFile
  ) {
    const entrySource = io.readFile(input.entryFile);
    if (entrySource) {
      const served = planServedStaticFrontend(input, io, entrySource);
      if (served.edits.length > 0) {
        plan.extraEdits = [...(plan.extraEdits ?? []), ...served.edits];
        // The page this server serves now carries a placeholder key, so the run
        // is not finished even when the server's own env key was written.
        plan.keyIsSourceLiteral = true;
      }
      plan.warnings = [...plan.warnings, ...served.warnings];
    }
  }
  return plan;
}

function dispatchPlan(input: BuildPlanInput, io: InjectIO): Plan {
  // Dependency presence is not enough. Only a complete integration for this
  // endpoint and service may skip the write. An incomplete reachable setup is
  // handed back as guidance so the existing initializer is repaired in place.
  const integration = inspectIntegration({
    cwd: input.cwd,
    recipe: input.recipe,
    endpoint: input.endpoint,
    entryFile: input.entryFile,
    serviceName: input.serviceName,
    io,
  });
  if (integration.complete) return skipPlan(input);
  // A wired static page whose ONLY gap is the key placeholder is not a broken
  // integration — it is a finished edit with one step left that only the user
  // can do. Handing back the whole snippet again told them to paste code their
  // page already carries, and named an env var this recipe does not use.
  if (
    integration.found &&
    input.recipe === "static" &&
    integration.missing.every((piece) => piece === "ingest-key")
  ) {
    const plan = skipPlan(
      input,
      [
        `This page is already wired. One step is left, and only you can do it: replace ${KEY_PLACEHOLDER} in ${input.entryFile ? path.relative(input.cwd, input.entryFile) || input.entryFile : "the page"} with your ingest key${input.mintUrl ? ` from ${input.mintUrl}` : ""}.`,
      ],
      { replaceDefaultWarning: true },
    );
    plan.keyIsSourceLiteral = true;
    return plan;
  }
  // An incomplete integration the customer already wrote is a thing to FINISH,
  // not a thing to refuse. Only when its init call cannot be parsed and extended
  // with confidence does this fall back to the printed guidance.
  if (integration.found) {
    return (
      amendPlan(input, io, integration) ?? incompletePlan(input, integration)
    );
  }
  switch (input.recipe) {
    case "cloudflare-workers":
      return planCloudflareWorkers(input, io);
    case "tauri":
      return planTauri(input, io);
    case "capacitor":
      return planCapacitor(input, io);
    case "flutter":
      return planFlutter(input, io);
    case "react-native":
      return planReactNative(input, io);
    case "next":
      return planNext(input, io);
    case "sveltekit":
      return planSvelteKit(input, io);
    case "nuxt":
      return planNuxt(input, io);
    case "remix":
      return planRemix(input, io);
    case "astro":
      return planAstro(input, io);
    case "angular":
      return planAngular(input, io);
    case "vite-spa":
      return planVite(input, io);
    case "cra":
      return planCra(input, io);
    case "static":
      // A page with no bundler: the HTML itself is the entry, wired with a
      // script tag rather than an import.
      return planStatic(input, io);
    case "express":
      // Express additionally wires the request/error middleware pair so the
      // backend emits backend.req.* spans, not just crash capture.
      return planExpress(input, io);
    case "nestjs":
    case "hono":
    case "fastify":
    case "node":
      // All backend-JS recipes share the headless-session injection; the agent
      // prompt differentiates framework middleware via the registry stack.
      return planNode(input, io);
    case "otlp":
      return planOtlp(input, io);
    default: {
      const exhaustive: never = input.recipe;
      throw new Error(`Unknown recipe: ${String(exhaustive)}`);
    }
  }
}
