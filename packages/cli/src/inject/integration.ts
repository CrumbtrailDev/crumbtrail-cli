import path from "node:path";
import { readEnvVar } from "../env-file";
import { RECIPE_REGISTRY } from "../recipe-registry";
import type { Recipe } from "../detect";
import type { InjectIO } from "./io";
import { findCallSites, maskLiterals } from "./amend";

/** The evidence a complete integration must leave in the target package. */
export type IntegrationRequirement =
  | "sdk"
  | "entry"
  | "endpoint"
  | "ingest-key"
  | "service-name"
  | "remote-config";

export type IntegrationHazard =
  | "guarded-init"
  | "transport-instance"
  | "other-key-channel"
  | "unsupported-option";

export interface IntegrationCheckInput {
  cwd: string;
  recipe: Recipe;
  endpoint: string;
  entryFile?: string | null;
  serviceName?: string | null;
  io: InjectIO;
}

export interface IntegrationStatus {
  /** True when this exact endpoint and service are fully configured. */
  complete: boolean;
  /** True when reachable source already contains a Crumbtrail integration. */
  found: boolean;
  /** The concrete pieces that keep an existing integration from being complete. */
  missing: IntegrationRequirement[];
  /** Reasons an existing integration cannot be safely amended automatically. */
  hazards: IntegrationHazard[];
  /** Environment names found in source or project configuration. */
  existingEnvVars: string[];
  /** Crumbtrail environment names that look like key channels. */
  keyEnvVarsSeen: string[];
  /** Crumbtrail environment names that look like endpoint channels. */
  endpointEnvVarsSeen: string[];
  /**
   * The app name the reachable source ALREADY declares, when it declares one
   * that is not the name this run targets.
   *
   * `service-name` in `missing` means "this run's name is not in the source",
   * which covers two very different situations: an integration that names no app
   * at all (a field the installer can add), and one that names a different app
   * (a value only the user may change). Without this the caller cannot tell them
   * apart, and it reported "missing an app or service name" over a file whose
   * next line said `service: "asiniq-admin"`.
   */
  existingServiceName?: string;
}

export const SOURCE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
] as const;

const SERVER_RECIPES = new Set<Recipe>([
  "express",
  "hono",
  "fastify",
  "nestjs",
  "node",
]);

const CRUMBTRAIL_REFERENCE =
  /crumbtrail-core|crumbtrail-node|crumbtrail-react-native|crumbtrail-capacitor|crumbtrail_flutter/;
export const LOCAL_IMPORT =
  /(?:from\s+|import\s*\(|import\s+|require\s*\()\s*["']([^"']+)["']/g;
const ENDPOINT_ENV =
  /\b[A-Z][A-Z0-9_]*CRUMBTRAIL[A-Z0-9_]*ENDPOINT[A-Z0-9_]*\b/g;
const ENV_NAME =
  /\b(?:[A-Z][A-Z0-9_]*CRUMBTRAIL[A-Z0-9_]*|CRUMBTRAIL[A-Z0-9_]*)\b/g;

const ENV_CONFIG_FILE =
  /^(?:\.env(?:\.[^/]+)*|docker-compose[^/]*\.ya?ml|Dockerfile[^/]*|fly\.toml|render\.ya?ml|vercel\.json|netlify\.toml|README\.md)$/;

function isKeyEnvName(name: string): boolean {
  const crumbtrail = name.indexOf("CRUMBTRAIL");
  return (
    crumbtrail >= 0 && /(?:API_KEY|KEY|TOKEN)/.test(name.slice(crumbtrail))
  );
}

function isEndpointEnvName(name: string): boolean {
  const crumbtrail = name.indexOf("CRUMBTRAIL");
  return crumbtrail >= 0 && /ENDPOINT/.test(name.slice(crumbtrail));
}

function namesIn(text: string): string[] {
  const names: string[] = [];
  ENV_NAME.lastIndex = 0;
  for (const match of text.matchAll(ENV_NAME)) names.push(match[0]);
  return names;
}

/**
 * Source and configuration files that can explain a customer's existing
 * environment names. Configuration is inspected for names only, never values.
 */
function inspectionFiles(
  input: IntegrationCheckInput,
): Array<{ file: string; text: string }> {
  const sourceFiles = reachableSourceFiles(input);
  const files = [...sourceFiles];
  const seen = new Set(files.map((entry) => entry.file));
  const maxFiles = 256;
  let dir = path.resolve(input.cwd);

  while (files.length < maxFiles) {
    const names = input.io.listFiles?.(dir) ?? [];
    for (const name of [...names].sort()) {
      if (!ENV_CONFIG_FILE.test(name)) continue;
      const file = path.join(dir, name);
      if (seen.has(file)) continue;
      const text = input.io.readFile(file);
      if (text === null) continue;
      seen.add(file);
      files.push({ file, text });
      if (files.length >= maxFiles) break;
    }
    // The repository is the boundary. Without it the walk reaches the user's
    // home directory and the filesystem root, and names harvested from an
    // unrelated project above the checkout become hazards in this one.
    if (input.io.exists(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

export function harvestEnvNames(input: IntegrationCheckInput): string[] {
  const names = new Set<string>();
  for (const entry of inspectionFiles(input)) {
    for (const name of namesIn(entry.text)) names.add(name);
  }
  return [...names];
}

export function sourceModulePath(
  io: InjectIO,
  importingFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importingFile), specifier);
  const ext = path.extname(base);
  const sourceBase = ext ? base.slice(0, -ext.length) : base;
  const importingExt = path.extname(importingFile);
  const emittedSourceExtensions =
    ext === ".mjs"
      ? [".mts"]
      : ext === ".cjs"
        ? [".cts"]
        : ext === ".js"
          ? [".ts", ".tsx"]
          : [];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(importingExt)) {
    const sourceMatches = emittedSourceExtensions
      .map((sourceExt) => `${sourceBase}${sourceExt}`)
      .filter((candidate) => io.readFile(candidate) !== null);
    if (sourceMatches.length === 1) return sourceMatches[0];
    if (sourceMatches.length > 1) return null;
  }
  const candidates = [
    base,
    // TypeScript ESM source imports its eventual `.js` output. Following only
    // the literal path made every such local edge disappear during setup.
    ...(ext === ".js" || ext === ".mjs" || ext === ".cjs"
      ? SOURCE_EXTENSIONS.map((sourceExt) => `${sourceBase}${sourceExt}`)
      : []),
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  return (
    candidates.find((candidate) => io.readFile(candidate) !== null) ?? null
  );
}

function defaultEntryFiles(input: IntegrationCheckInput): string[] {
  const roots = [input.cwd, path.join(input.cwd, "src")];
  if (input.recipe === "next") {
    return roots.flatMap((root) =>
      SOURCE_EXTENSIONS.map((ext) =>
        path.join(root, `instrumentation-client${ext}`),
      ),
    );
  }
  if (input.recipe === "sveltekit") {
    return SOURCE_EXTENSIONS.map((ext) =>
      path.join(input.cwd, "src", `hooks.client${ext}`),
    );
  }
  if (input.recipe === "nuxt") {
    return [
      ...SOURCE_EXTENSIONS.map((ext) =>
        path.join(input.cwd, "plugins", `crumbtrail.client${ext}`),
      ),
      ...SOURCE_EXTENSIONS.map((ext) =>
        path.join(input.cwd, "app", "plugins", `crumbtrail.client${ext}`),
      ),
    ];
  }
  return [];
}

/**
 * Read the entry and the local modules it imports, bounded to avoid surprises.
 *
 * Paths are carried alongside the text because "which file holds the init call"
 * is the first thing an in-place amend has to know, and joining the sources
 * threw it away.
 */
export function reachableSourceFiles(
  input: IntegrationCheckInput,
): Array<{ file: string; text: string }> {
  const entries = input.entryFile
    ? [path.resolve(input.entryFile)]
    : defaultEntryFiles(input).filter(
        (file) => input.io.readFile(file) !== null,
      );
  if (entries.length === 0) return [];
  const files: Array<{ file: string; text: string }> = [];
  const pending = [...entries];
  const visited = new Set<string>();

  while (pending.length > 0 && files.length < 256) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = input.io.readFile(file);
    if (text === null) continue;
    files.push({ file, text });
    LOCAL_IMPORT.lastIndex = 0;
    for (const match of text.matchAll(LOCAL_IMPORT)) {
      const imported = sourceModulePath(input.io, file, match[1]);
      if (imported && !visited.has(imported)) pending.push(imported);
    }
  }
  return files;
}

function packageJson(input: IntegrationCheckInput): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} | null {
  const text = input.io.readFile(path.join(input.cwd, "package.json"));
  if (text === null) return null;
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    };
  } catch {
    return null;
  }
}

function sdkPackageInstalled(cwd: string, io: InjectIO, name: string): boolean {
  let dir = path.resolve(cwd);
  for (;;) {
    if (
      io.readFile(path.join(dir, "node_modules", name, "package.json")) !== null
    ) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function sdkComplete(input: IntegrationCheckInput): boolean {
  if (input.recipe === "flutter") {
    const pubspec = input.io.readFile(path.join(input.cwd, "pubspec.yaml"));
    return pubspec != null && /^\s*crumbtrail_flutter\s*:/m.test(pubspec);
  }
  // A recipe with no packages to add (otlp guidance, and a static page that
  // loads the SDK from a CDN) is complete on this requirement by construction.
  // Checked BEFORE package.json, because those are exactly the projects that may
  // not have one — and demanding a manifest they never needed made every re-run
  // report the wiring as incomplete.
  if (RECIPE_REGISTRY[input.recipe].sdkPackages.length === 0) return true;
  const pkg = packageJson(input);
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return RECIPE_REGISTRY[input.recipe].sdkPackages.every(
    (name) => name in deps && sdkPackageInstalled(input.cwd, input.io, name),
  );
}

function normalizedEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function envValue(cwd: string, io: InjectIO, name: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const file of [
      ".env.local",
      ".env",
      ".env.development.local",
      ".env.development",
    ]) {
      const text = io.readFile(path.join(dir, file));
      const value = text == null ? undefined : readEnvVar(text, name);
      if (value !== undefined) return value;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function endpointConfigured(
  input: IntegrationCheckInput,
  source: string,
): boolean {
  const expected = normalizedEndpoint(input.endpoint);
  if (
    source
      .match(/https?:\/\/[^\s"'`]+/g)
      ?.some((value) => normalizedEndpoint(value) === expected)
  ) {
    return true;
  }
  ENDPOINT_ENV.lastIndex = 0;
  for (const match of source.matchAll(ENDPOINT_ENV)) {
    if (
      normalizedEndpoint(envValue(input.cwd, input.io, match[0]) ?? "") ===
      expected
    ) {
      return true;
    }
  }
  return false;
}

function serviceConfigured(
  source: string,
  serviceName: string | null | undefined,
): boolean {
  if (!serviceName?.trim()) return false;
  const escaped = serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bservice\\s*:\\s*["']${escaped}["']`).test(source);
}

/** The app name a `service:` option already carries, if it carries a literal one. */
function declaredServiceName(source: string): string | undefined {
  const match = /\bservice\s*:\s*["']([^"']+)["']/.exec(source);
  return match?.[1];
}

/** Offsets of the `{` of every block still open at `offset`, outermost first. */
function openBlocksAt(mask: string, offset: number): number[] {
  const stack: number[] = [];
  for (let i = 0; i < offset; i += 1) {
    if (mask[i] === "{") stack.push(i);
    else if (mask[i] === "}") stack.pop();
  }
  return stack;
}

/** Index just past the `)` closing the `(` at `from`, or -1. */
function closingParen(mask: string, from: number): number {
  let depth = 0;
  for (let i = from; i < mask.length; i += 1) {
    if (mask[i] === "(") depth += 1;
    else if (mask[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The condition of an `if` whose body starts at `at`, or undefined when `at` is
 * not the head of an `if` body. `at` is the `{` of a block or the first token of
 * a single-statement body.
 */
function ifConditionBefore(
  mask: string,
  source: string,
  at: number,
): string | undefined {
  const lineStart = mask.lastIndexOf("\n", at - 1) + 1;
  const prefix = mask.slice(lineStart, at);
  let found: string | undefined;
  for (const match of prefix.matchAll(/\bif\s*\(/g)) {
    const openParen = lineStart + match.index + match[0].length - 1;
    const close = closingParen(mask, openParen);
    if (close === -1 || close >= at) continue;
    // Anything statement-ending between the condition and `at` means this `if`
    // finished before the call site: `if (a) f(); g({…})` does not guard `g`.
    if (/[;{}]/.test(mask.slice(close + 1, at))) continue;
    found = source.slice(openParen + 1, close).trim();
  }
  return found;
}

/**
 * A block the CLI itself emits around its own wiring, which always runs when
 * the key is present and is therefore not an unknown guard. The node snippet
 * writes `if (<keyExpr>) { … }` and the Express one `if (<keyExpr>) app.use(…)`;
 * a Nuxt plugin body is unconditional startup code that Nuxt always invokes.
 */
function isKnownWrapper(
  condition: string | undefined,
  before: string,
  keyExpr?: string,
): boolean {
  if (condition !== undefined)
    return keyExpr !== undefined && condition === keyExpr;
  return /\bdefineNuxtPlugin\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*$/.test(
    before,
  );
}

/**
 * Whether reaching this call site depends on something this planner cannot see:
 * an enclosing block, or an `if` on the same statement. The CLI's own key guard
 * and a Nuxt plugin body are the exceptions, so a project the CLI wired is not
 * refused on its next run.
 */
function isGuardedCallSite(
  source: string,
  open: number,
  keyExpr?: string,
): boolean {
  const mask = maskLiterals(source);
  if (mask === null) return true;
  for (const brace of openBlocksAt(mask, open)) {
    const condition = ifConditionBefore(mask, source, brace);
    const before = mask.slice(mask.lastIndexOf("\n", brace - 1) + 1, brace);
    if (!isKnownWrapper(condition, before, keyExpr)) return true;
  }
  // The call's own statement. `open` is the options object's `{`, so the guard
  // sits behind the callee expression rather than immediately before it.
  const condition = ifConditionBefore(mask, source, open);
  return condition !== undefined && condition !== keyExpr;
}

function hazardsFor(
  input: IntegrationCheckInput,
  sourceFiles: Array<{ file: string; text: string }>,
  envNames: readonly string[],
): IntegrationHazard[] {
  const hazards = new Set<IntegrationHazard>();
  const keyRef = RECIPE_REGISTRY[input.recipe].keyRef;

  for (const entry of sourceFiles) {
    for (const site of findCallSites(entry.text)) {
      const generatedNodeInit =
        site.callee === "autoCapture" &&
        site.keys.get("authToken") === "__crumbtrailKey" &&
        /const\s+__crumbtrailKey\s*=\s*process\.env\./.test(entry.text) &&
        entry.text.includes('import("crumbtrail-node")');
      if (isGuardedCallSite(entry.text, site.open, keyRef?.expr)) {
        hazards.add("guarded-init");
      }
      if (
        site.callee === "Crumbtrail.init" &&
        site.keys.has("transportInstance")
      ) {
        hazards.add("transport-instance");
      }
      if (
        (site.callee === "createCrumbtrailExpressMiddleware" ||
          site.callee === "createCrumbtrailExpressErrorMiddleware") &&
        site.keys.has("service")
      ) {
        hazards.add("unsupported-option");
      }
      for (const keyName of ["authToken", "httpAuthToken"]) {
        const value = site.keys.get(keyName);
        if (
          !generatedNodeInit &&
          value !== undefined &&
          value.trim() !== keyRef?.expr
        ) {
          hazards.add("other-key-channel");
        }
      }
    }
  }

  if (envNames.some((name) => isKeyEnvName(name) && name !== keyRef?.envVar)) {
    hazards.add("other-key-channel");
  }
  return [...hazards];
}

/** The literal a recipe with no env mechanism leaves in place of a real key. */
const KEY_PLACEHOLDER_IN_SOURCE = /httpAuthToken\s*:\s*["'`]<[^"'`]*>["'`]/;

function keyConfigured(input: IntegrationCheckInput, source: string): boolean {
  const keyRef = RECIPE_REGISTRY[input.recipe].keyRef;
  // No keyRef means this recipe has no env var to read (angular, static): the
  // key lives in the source itself. Configured, then, is "someone replaced the
  // placeholder" — anything else would report a page that is fully wired as
  // incomplete forever, since there is no variable to go looking for.
  if (!keyRef) {
    return (
      /\bhttpAuthToken\s*:/.test(source) &&
      !KEY_PLACEHOLDER_IN_SOURCE.test(source)
    );
  }
  if (!source.includes(keyRef.expr)) return false;
  if (keyRef.compileTime) return true;
  return envValue(input.cwd, input.io, keyRef.envVar) !== undefined;
}

function remoteConfigRequired(recipe: Recipe): boolean {
  return (
    !SERVER_RECIPES.has(recipe) && recipe !== "flutter" && recipe !== "tauri"
  );
}

/**
 * Inspect one integration for the endpoint and service this run targets.
 * Dependency presence is only one input. A complete result requires reachable
 * code, an exact endpoint, a configured key, a service name, and remote config
 * where that SDK supports it.
 */
export function inspectIntegration(
  input: IntegrationCheckInput,
): IntegrationStatus {
  const sourceFiles = reachableSourceFiles(input);
  const source = sourceFiles.map((entry) => entry.text).join("\n");
  const existingEnvVars = harvestEnvNames(input);
  const keyEnvVarsSeen = existingEnvVars.filter(isKeyEnvName);
  const endpointEnvVarsSeen = existingEnvVars.filter(isEndpointEnvName);
  const found = CRUMBTRAIL_REFERENCE.test(source);
  const missing: IntegrationRequirement[] = [];

  if (!sdkComplete(input)) missing.push("sdk");
  if (source.length === 0 || !found) missing.push("entry");
  if (!endpointConfigured(input, source)) missing.push("endpoint");
  if (!keyConfigured(input, source)) missing.push("ingest-key");
  let existingServiceName: string | undefined;
  if (!serviceConfigured(source, input.serviceName)) {
    missing.push("service-name");
    existingServiceName = declaredServiceName(source);
  }
  // Absent is fine: `remoteConfig` defaults to on, so an init that never
  // mentions it already takes its capture settings from the project. Only an
  // explicit opt out cuts the dashboard off from this app.
  if (
    remoteConfigRequired(input.recipe) &&
    /\bremoteConfig\s*:\s*false\b/.test(source)
  ) {
    missing.push("remote-config");
  }

  const hazards = hazardsFor(input, sourceFiles, existingEnvVars);
  return {
    complete: missing.length === 0 && hazards.length === 0,
    found,
    missing,
    hazards,
    existingEnvVars,
    keyEnvVarsSeen,
    endpointEnvVarsSeen,
    ...(existingServiceName ? { existingServiceName } : {}),
  };
}
