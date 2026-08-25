import type { Recipe } from "../detect";

/** The shape of a plan the executor knows how to (or refuses to) apply. */
export type PlanKind =
  | "create" // write a brand-new file
  | "prepend" // strictly prepend into an existing file
  | "rewrite" // replace an existing file with fully transformed content (Express middleware wiring)
  | "skip-already-wired" // project already references Crumbtrail; no-op
  | "needs-confirm-dirty" // target has uncommitted changes; needs --force / confirm
  | "fallback-ai" // detection/safety ambiguous; hand off to the AI-prompt path
  | "otlp-guidance"; // non-JS backend: emit OTLP setup guidance, write nothing

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
   * For `create`/`rewrite`: the full file body. For `prepend` (and
   * `needs-confirm-dirty` in prepend mode): the block to prepend. null for
   * skip/fallback plans.
   */
  content: string | null;
  /**
   * How a confirmed `needs-confirm-dirty` plan is applied: "rewrite" writes
   * `content` as the whole file (Express middleware wiring); default/absent
   * prepends `content` as a block.
   */
  applyMode?: "prepend" | "rewrite";
  /**
   * Files this plan touches BESIDES `targetPath`, already resolved to their
   * final bytes.
   *
   * The single-target shape assumes one app is one file, which stops being true
   * as soon as a package starts a second process (a worker) or bakes its key in
   * at build time (a Dockerfile ARG). Those edits are computed by the
   * plan-builders, like every other edit, and carried here so the executor still
   * applies the whole plan all-or-nothing.
   *
   * Deliberately full content rather than a prepend block: an extra target is
   * read, gated and transformed while the plan is built, so the executor never
   * has to re-derive what a second file should look like.
   */
  extraEdits?: Array<{
    path: string;
    mode: "create" | "update";
    content: string;
    /** One line for the wizard summary, e.g. "wired the queue worker". */
    label: string;
  }>;
  /** Non-fatal notes to surface to the user. */
  warnings: string[];
  /** fallback-ai: the ready-to-paste code snippet (reads the key from env). */
  snippet?: string;
  /** fallback-ai: the `buildAgentPrompt` output for a coding agent. */
  agentPrompt?: string;
  /**
   * The env var the injected code reads the ingest key from (e.g.
   * `VITE_CRUMBTRAIL_KEY`). The installer is hands-off — it never writes the key —
   * so the wizard prints this name and points the user at the dashboard to set
   * it. Undefined for recipes that inject no key (tauri / otlp / angular).
   */
  keyEnvVar?: string;
  /**
   * `keyEnvVar` is supplied at BUILD time rather than read from the environment
   * at run time (Flutter's `--dart-define`). The wizard must not write the key
   * into an env file for these: the app would never read it, and every printed
   * step would report success for an app that captures nothing.
   */
  keyIsCompileTime?: boolean;
  /**
   * The injected code carries the key as a LITERAL placeholder, because this
   * target has no env mechanism at all (a page with no bundler). There is
   * nothing for the wizard to write and nothing for it to verify, so the run is
   * not finished when the edit lands — someone still has to paste the key.
   * Without this the summary printed "Setup complete" over a page that captures
   * nothing.
   */
  keyIsSourceLiteral?: true;
}
