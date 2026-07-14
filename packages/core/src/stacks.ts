/**
 * The stack vocabulary — the set of frameworks and runtimes Crumbtrail knows how
 * to instrument.
 *
 * This lives in core because it is shared domain language, not presentation: the
 * CLI uses it to pick an install recipe, install-shared uses it to build agent
 * prompts, and the design system uses it to pick a brand mark. Core is the only
 * package all three can depend on without dragging React into a Node CLI.
 */

/** The exact set of stacks with first-class support. */
export type Stack =
  | "nextjs"
  | "react"
  | "vue"
  | "svelte"
  | "vite"
  | "express"
  | "hono"
  | "node"
  | "django"
  | "flask"
  | "fastapi"
  | "dotnet"
  | "go"
  | "rails"
  | "postgres"
  | "grafana"
  | "loki"
  | "docker";

/** Stable ordered id list, handy for iterating or building pickers. */
export const STACK_IDS: readonly Stack[] = [
  "nextjs",
  "react",
  "vue",
  "svelte",
  "vite",
  "express",
  "hono",
  "node",
  "django",
  "flask",
  "fastapi",
  "dotnet",
  "go",
  "rails",
  "postgres",
  "grafana",
  "loki",
  "docker",
];
