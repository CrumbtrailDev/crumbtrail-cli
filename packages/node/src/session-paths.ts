import { defaultSessionStore } from "./session-store";

/**
 * Pure resolver shared by `inspect` and `fix-context`. Resolves `sessionDirOrId` to a session
 * directory on disk without any side effects (no mkdir, no writes):
 *
 *   1. If `sessionDirOrId` is itself a session directory (contains a marker file), return it.
 *   2. Otherwise, if `outputDir` is given, treat `sessionDirOrId` as a bare session id and:
 *      a. return the flat `outputDir/id` if it is a session directory; else
 *      b. walk the finalized partition tree ({tenant}/{app}/{YYYY-MM-DD}/{id}) for a directory
 *         whose basename === id and which contains a meta.json; else
 *      c. fall back to the flat `outputDir/id` path (so a missing session surfaces a stable path).
 *   3. Otherwise, return `sessionDirOrId` unchanged.
 *
 * The resolution (marker detection, partition walk, and symlink / path-traversal containment
 * guards) lives behind `SessionStore.resolveSessionDir` so the same seam backs both the
 * filesystem today and an alternate backend later.
 */
export function resolveSessionDirById(
  sessionDirOrId: string,
  outputDir?: string,
): string {
  return defaultSessionStore.resolveSessionDir(sessionDirOrId, outputDir);
}
