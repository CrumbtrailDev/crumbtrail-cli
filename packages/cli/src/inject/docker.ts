// Declaring a bundler-inlined key as a Docker build argument.
//
// Vite, Next, Astro and Expo do not read their public env vars when the app
// runs — the bundler substitutes the literal value into the bundle at BUILD
// time. Inside a Docker build the build has its own environment, and a variable
// set on the running service reaches it only if the Dockerfile declares it as an
// `ARG`. A Dockerfile that declares every other `VITE_*` and not this one
// produces an image that can never carry a key, no matter what the platform's
// service variables say — and nothing about the build fails.
//
// Pure text transforms: no filesystem access.

import path from "node:path";

/**
 * Where a Dockerfile is looked for, relative to the app directory. Not a
 * filesystem walk: an app with its Dockerfile somewhere else gets the warning
 * rather than a wrong edit.
 */
export const DOCKERFILE_CANDIDATES = [
  "Dockerfile",
  "dockerfile",
  path.join("docker", "Dockerfile"),
] as const;

/**
 * The framework's public prefix, e.g. `VITE_CRUMBTRAIL_KEY` -> `VITE_`. Every
 * bundler-inlined key ref ends in `CRUMBTRAIL_KEY`, so what precedes it is
 * exactly the prefix its siblings share.
 */
export function publicPrefixOf(envVar: string): string {
  return envVar.endsWith("CRUMBTRAIL_KEY")
    ? envVar.slice(0, envVar.length - "CRUMBTRAIL_KEY".length)
    : "";
}

export interface DockerBuildArgEdit {
  /** The Dockerfile body with the ARG (and any mirrored ENV) added. */
  text: string;
  /** False when nothing was changed — see `reason`. */
  changed: boolean;
  /**
   * Why no change was made: `already-declared` (the ARG is there),
   * `no-sibling-args` (this Dockerfile does not pass build args of this prefix
   * at all, so where the line belongs is a guess, and guessing edits somebody
   * else's build).
   */
  reason?: "already-declared" | "no-sibling-args";
  /** True when a matching `ENV` mirror line was added alongside the ARG. */
  mirroredEnv: boolean;
}

const ARG_LINE = /^(\s*)ARG\s+([A-Za-z_][A-Za-z0-9_]*)/;
const ENV_LINE =
  /^(\s*)ENV\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\s*$/;

/**
 * Add `ARG <envVar>` to a Dockerfile, next to the sibling build args of the
 * same public prefix, mirroring their `ENV <X>=$<X>` form when they use one.
 *
 * Anchoring on the siblings rather than on a stage header is deliberate: a
 * multi-stage Dockerfile builds in one stage and serves from another, and an
 * `ARG` in the wrong stage is as invisible as no `ARG` at all. The siblings
 * are already in the stage that runs the bundler.
 */
export function addDockerBuildArg(
  text: string,
  envVar: string,
): DockerBuildArgEdit {
  const prefix = publicPrefixOf(envVar);
  const lines = text.split("\n");

  let lastSiblingArg = -1;
  let lastSiblingEnv = -1;
  let indent = "";
  for (const [index, line] of lines.entries()) {
    const arg = ARG_LINE.exec(line);
    if (arg) {
      if (arg[2] === envVar) {
        return {
          text,
          changed: false,
          reason: "already-declared",
          mirroredEnv: false,
        };
      }
      if (prefix && arg[2].startsWith(prefix)) {
        lastSiblingArg = index;
        indent = arg[1] ?? "";
      }
      continue;
    }
    const env = ENV_LINE.exec(line);
    if (env && prefix && env[2].startsWith(prefix) && env[2] === env[3]) {
      lastSiblingEnv = index;
    }
  }

  if (lastSiblingArg === -1) {
    return {
      text,
      changed: false,
      reason: "no-sibling-args",
      mirroredEnv: false,
    };
  }

  const out = [...lines];
  const mirroredEnv = lastSiblingEnv !== -1;
  // Insert the ENV first so the ARG insertion above it does not shift the index.
  if (mirroredEnv && lastSiblingEnv > lastSiblingArg) {
    out.splice(lastSiblingEnv + 1, 0, `${indent}ENV ${envVar}=$${envVar}`);
    out.splice(lastSiblingArg + 1, 0, `${indent}ARG ${envVar}`);
  } else {
    out.splice(lastSiblingArg + 1, 0, `${indent}ARG ${envVar}`);
    if (mirroredEnv) {
      out.splice(lastSiblingEnv + 1, 0, `${indent}ENV ${envVar}=$${envVar}`);
    }
  }
  return { text: out.join("\n"), changed: true, mirroredEnv };
}
