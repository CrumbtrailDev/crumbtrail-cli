import path from "node:path";
import { readEnvVar } from "../env-file";
import { RECIPE_REGISTRY } from "../recipe-registry";
import type { Recipe } from "../detect";
import type { InjectIO } from "./io";

/** The evidence a complete integration must leave in the target package. */
export type IntegrationRequirement =
  | "sdk"
  | "entry"
  | "endpoint"
  | "ingest-key"
  | "service-name"
  | "remote-config";

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
}

export const SOURCE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
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

function sourceModulePath(
  io: InjectIO,
  importingFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importingFile), specifier);
  const candidates = [
    base,
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

/** Read the entry and the local modules it imports, bounded to avoid surprises. */
function reachableSource(input: IntegrationCheckInput): string[] {
  const entries = input.entryFile
    ? [path.resolve(input.entryFile)]
    : defaultEntryFiles(input).filter(
        (file) => input.io.readFile(file) !== null,
      );
  if (entries.length === 0) return [];
  const files: string[] = [];
  const pending = [...entries];
  const visited = new Set<string>();

  while (pending.length > 0 && files.length < 64) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = input.io.readFile(file);
    if (text === null) continue;
    files.push(text);
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
  const source = reachableSource(input).join("\n");
  const found = CRUMBTRAIL_REFERENCE.test(source);
  const missing: IntegrationRequirement[] = [];

  if (!sdkComplete(input)) missing.push("sdk");
  if (source.length === 0 || !found) missing.push("entry");
  if (!endpointConfigured(input, source)) missing.push("endpoint");
  if (!keyConfigured(input, source)) missing.push("ingest-key");
  if (!serviceConfigured(source, input.serviceName))
    missing.push("service-name");
  if (
    remoteConfigRequired(input.recipe) &&
    !/\bremoteConfig\s*:\s*true\b/.test(source)
  ) {
    missing.push("remote-config");
  }

  return { complete: missing.length === 0, found, missing };
}
