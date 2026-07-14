// Single source of truth for per-recipe static metadata.
//
// Adding a recipe should mean: one entry here + one matcher in detect.ts + one
// plan-builder in inject/recipes.ts. This module holds only static data — it
// must NOT import detect (or any fs/network module) at runtime, so it stays a
// leaf that both detect.ts and the network/inject layers can depend on without
// forming an import cycle. `Recipe` is pulled in type-only for exactly that
// reason.

import type { Stack } from "crumbtrail-core";
import type { Recipe } from "./detect";

/**
 * Discriminator for how a recipe is applied. Every JS recipe injects a snippet;
 * `otlp` is the guidance-only path (CP5) — it mutates nothing and emits OTLP
 * setup instructions + an agent prompt instead of editing files.
 */
export type RecipeKind = "inject" | "otlp";

export interface RecipeMeta {
  /**
   * design-system Stack id passed to buildAgentPrompt() (attribution) and the
   * services route. SvelteKit/Nuxt have no dedicated Stack id, so they map onto
   * their underlying view layer: sveltekit → "svelte", nuxt → "vue".
   */
  stack: Stack;
  /** SDK packages the installer adds for this recipe. */
  sdkPackages: string[];
  /** Default service label when no workspace name overrides it. */
  serviceName: string;
  /** How the recipe is applied. */
  kind: RecipeKind;
}

/**
 * Exhaustive registry keyed by `Recipe`. Typed `Record<Recipe, RecipeMeta>` so a
 * future recipe missing an entry fails typecheck — preserve that safety net.
 */
export const RECIPE_REGISTRY: Record<Recipe, RecipeMeta> = {
  tauri: {
    stack: "vite", // no "tauri" Stack id — Tauri frontends are typically vite
    sdkPackages: ["crumbtrail-core", "crumbtrail-tauri"],
    serviceName: "app",
    kind: "inject",
  },
  next: {
    stack: "nextjs",
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
  },
  sveltekit: {
    stack: "svelte", // no "sveltekit" Stack id — svelte is the closest js stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
  },
  nuxt: {
    stack: "vue", // no "nuxt" Stack id — vue is the closest js stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
  },
  remix: {
    stack: "react", // no "remix" Stack id — react is the closest js stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
  },
  astro: {
    stack: "vite", // no "astro" Stack id — vite is the closest generic frontend stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
  },
  angular: {
    stack: "vite", // no "angular" Stack id — vite is the closest generic frontend stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
  },
  "vite-spa": {
    stack: "vite",
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
  },
  nestjs: {
    stack: "node", // no "nestjs" Stack id — node is the backend-JS stack
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
  },
  express: {
    stack: "express",
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
  },
  hono: {
    stack: "hono",
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
  },
  fastify: {
    stack: "node", // no dedicated "fastify" Stack id — node is the backend-JS stack
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
  },
  "react-native": {
    stack: "react", // no "react-native" Stack id — react is the closest js stack
    sdkPackages: ["crumbtrail-core", "crumbtrail-react-native"],
    serviceName: "app",
    kind: "inject",
  },
  node: {
    stack: "node",
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
  },
  otlp: {
    // PLACEHOLDER ONLY. `otlp` is the single recipe that carries a VARIABLE
    // detected Stack (django/flask/fastapi/go/rails/dotnet). This static value is
    // NOT authoritative — every call site (provision.ts createService,
    // recipes.ts buildAgentPrompt) must prefer `DetectResult.otlpStack` and only
    // fall back to this when a detected stack is somehow absent.
    stack: "django",
    // Empty: this backend already speaks OpenTelemetry, so there is no SDK to
    // install. installSdk() must guard the empty list and skip spawning entirely.
    sdkPackages: [],
    serviceName: "backend",
    kind: "otlp",
  },
};
