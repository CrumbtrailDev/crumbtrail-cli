import type { Recipe } from "../detect";

/** The shape of a plan the executor knows how to (or refuses to) apply. */
export type PlanKind =
  | "create" // write a brand-new file
  | "prepend" // strictly prepend into an existing file
  | "skip-already-wired" // project already references Crumbtrail; no-op
  | "needs-confirm-dirty" // target has uncommitted changes; needs --force / confirm
  | "fallback-ai" // detection/safety ambiguous; hand off to the AI-prompt path
  | "otlp-guidance"; // non-JS backend: emit OTLP setup guidance, write nothing

/** A create/append to `.env` carried alongside the Node recipe's plan. */
export interface EnvAction {
  /** Absolute path to the `.env` file. */
  targetPath: string;
  /** The `CRUMBTRAIL_KEY=...` line to ensure is present. */
  line: string;
  /** Set when `.env` is not covered by `.gitignore` (key could get committed). */
  gitignoreWarning?: string;
}

/**
 * A fully-resolved, side-effect-free description of what injection would do.
 * The executor turns this into filesystem writes; nothing here performs I/O.
 */
export interface Plan {
  recipe: Recipe;
  kind: PlanKind;
  /** Absolute path of the file to create/edit. null for skip/fallback plans. */
  targetPath: string | null;
  /**
   * For `create`: the full file body. For `prepend`/`needs-confirm-dirty`: the
   * block to prepend. null for skip/fallback plans.
   */
  content: string | null;
  /** Non-fatal notes to surface to the user. */
  warnings: string[];
  /** fallback-ai: the ready-to-paste code snippet, key already filled in. */
  snippet?: string;
  /** fallback-ai: the `buildAgentPrompt` output for a coding agent. */
  agentPrompt?: string;
  /** Node recipe: the `.env` write to perform alongside the entry edit. */
  envAction?: EnvAction;
}
