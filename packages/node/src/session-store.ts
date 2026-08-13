import fs from "node:fs";
import path from "node:path";
import type { BugEvent } from "crumbtrail-core";
import {
  CAPTURE_TRUNCATED_ARTIFACT,
  sanitizeEventForStorage,
  type CaptureTruncationSummary,
} from "./storage-plane";

export const DEFAULT_MAX_SESSION_EVENT_BYTES = 50 * 1024 * 1024;

const PRIVATE_DIR_MODE = 0o700;

export interface AppendEventsOptions {
  maxEventBytes?: number;
}

export interface AppendEventsResult {
  accepted: number;
  dropped: number;
  truncated: boolean;
  bytesWritten: number;
}

export interface ArtifactStat {
  bytes: number;
  isDir: boolean;
}

export interface SessionPartition {
  tenant: string;
  app: string;
  date: string;
  sessionId: string;
}

export interface ResolveSessionScope {
  tenant?: string;
  app?: string;
  date?: string;
}

/**
 * How a caller asks the store for LESS than the whole store.
 *
 * The seam exists because a listing that cannot see the caller's bound has to enumerate — and
 * containment-check — every session that exists before the caller is allowed to throw all but the
 * first few away. The bound has to travel INTO the listing for the work to be skipped rather than
 * discarded, and a bound without an order is not a selection: "the first N" over a filesystem walk
 * differs between two runs over one store. So the two arrive together, or neither is admissible.
 */
export interface ListSessionsOptions {
  /**
   * The most sessions this listing may return. Omit for the whole store, which is the historical
   * behaviour and the behaviour every existing caller gets.
   *
   * When present, the returned sessions are the `limit` MOST RECENT by
   * {@link compareSessionDirsByRecencyDescending}, and the listing performs its containment and
   * recognition checks only on the entries it actually returns.
   */
  limit?: number;
}

/**
 * The order a bounded listing selects in: MOST RECENT FIRST, by the `{YYYY-MM-DD}` date partition
 * the session is stored under, then by session id, then by the full directory path.
 *
 * A bound without a defined order is not a measurement. The walk below enumerates the tree with a
 * stack and would otherwise hand back whatever order the filesystem gave it, so "the first N" would
 * differ between two runs over the same store and between two machines holding the same sessions — a
 * selection nobody can reproduce and nobody can check. Recency is the only order that makes a bounded
 * view of a store mean anything: a store's OLDEST sessions describe an application that may no longer
 * exist.
 *
 * Both keys are read from the PATH, not from `meta.json`, so ordering costs no I/O at all — which is
 * precisely what makes stopping early possible: the newest partitions can be recognised before any
 * session inside them has been opened. Session ids are time-ordered strings, so they break ties within
 * a day in the same direction. The final compare on the full path makes the order TOTAL rather than
 * merely sorted: a session is accepted at any depth, so a store shaped differently can yield sessions
 * with no date partition at all (they sort last, together), and ids are only unique within a
 * tenant/app. Without that last key a sort over an unordered input stays unordered wherever the first
 * two keys tie.
 */
export function compareSessionDirsByRecencyDescending(
  a: string,
  b: string,
): number {
  const aDate = path.basename(path.dirname(a));
  const bDate = path.basename(path.dirname(b));
  const aKey = DATE_PATTERN.test(aDate) ? aDate : "";
  const bKey = DATE_PATTERN.test(bDate) ? bDate : "";
  if (aKey !== bKey) return aKey < bKey ? 1 : -1;
  const aId = path.basename(a);
  const bId = path.basename(b);
  if (aId !== bId) return aId < bId ? 1 : -1;
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/**
 * Storage boundary for a single session's on-disk artifacts. Every filesystem
 * write/read primitive that the node package performs against a session
 * directory flows through this seam so the layout can later move behind an
 * alternate backend (e.g. R2) without touching call sites.
 */
export interface SessionStore {
  createSessionDir(sessionId: string): Promise<string>;
  appendEvents(
    sessionDir: string,
    events: BugEvent[],
    opts?: AppendEventsOptions,
  ): Promise<AppendEventsResult>;
  /**
   * Append pre-serialized NDJSON records verbatim, bypassing event
   * sanitization. Exists so a sealing decorator can append ciphertext without
   * it being redacted; see the implementation note in FilesystemSessionStore.
   */
  appendRecordLines(
    sessionDir: string,
    records: string[],
    opts?: AppendEventsOptions,
  ): Promise<AppendEventsResult>;
  writeArtifact(
    sessionDir: string,
    name: string,
    data: string | Buffer,
  ): Promise<void>;
  writeBlob(sessionDir: string, name: string, data: Buffer): Promise<void>;
  writeSessionArtifact(
    sessionDir: string,
    name: string,
    data: string | Buffer,
  ): Promise<void>;
  readArtifact(sessionDir: string, name: string): Promise<Buffer | undefined>;
  statArtifact(
    sessionDir: string,
    name: string,
  ): Promise<ArtifactStat | undefined>;
  listSessions(
    outputDir: string,
    options?: ListSessionsOptions,
  ): Promise<Array<{ id: string; dir: string }>>;
  listArtifacts(sessionDir: string): Promise<string[]>;
  /**
   * Atomically relocate `sessionDir` to `targetDir` (staging -> finalized partition).
   * This is the load-bearing FS-only "atomic rename" semantic the R2 adapter will have
   * to emulate. Path/containment/symlink policy is enforced by the caller before and
   * after the move (see SessionManager.moveSessionToV2Partition); this primitive owns
   * only the atomic move itself.
   */
  moveToPartition(sessionDir: string, targetDir: string): Promise<string>;
  resolveSessionDir(
    idOrDir: string,
    outputDir?: string,
    scope?: ResolveSessionScope,
  ): string;
  /**
   * Tenant-scoped lookup with the cloud isolation contract: returns the session dir only
   * when it exists inside {sessionsDir}/{tenant}/{app}/{YYYY-MM-DD}/{sessionId}, else
   * undefined (never a fallback path, never a cross-tenant hit). Backs cloud's findSessionDir.
   */
  resolveScopedSessionDir(
    sessionsDir: string,
    tenant: string,
    app: string,
    sessionId: string,
  ): string | undefined;
  deleteSessionDir(sessionDir: string): Promise<void>;
}

export class FilesystemSessionStore implements SessionStore {
  // eslint-disable-next-line @typescript-eslint/require-await
  async createSessionDir(sessionId: string): Promise<string> {
    fs.mkdirSync(sessionId, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (process.platform !== "win32") {
      fs.chmodSync(sessionId, PRIVATE_DIR_MODE);
    }
    return sessionId;
  }

  // The append sequence stays fully synchronous inside this async method: an
  // async function with no internal `await` runs its body to completion on the
  // calling tick, so the single-writer marker/byte-cap check and the appendFile
  // can never interleave with another append. The `async` keyword only satisfies
  // the async SessionStore contract (whose real async work lives in the cloud
  // EncryptedSessionStore decorator, not here).
  // eslint-disable-next-line @typescript-eslint/require-await
  async appendEvents(
    sessionDir: string,
    events: BugEvent[],
    opts: AppendEventsOptions = {},
  ): Promise<AppendEventsResult> {
    // Returned, not awaited: appendRecordLines has no internal await either, so
    // the whole serialize -> guard -> appendFile sequence still completes on the
    // calling tick and keeps the single-writer property described above.
    return this.appendRecordLines(
      sessionDir,
      events.map((event) => JSON.stringify(sanitizeEventForStorage(event))),
      opts,
    );
  }

  /**
   * Append already-serialized NDJSON records verbatim.
   *
   * The seam a sealing decorator needs: ciphertext cannot travel through
   * `appendEvents`, because `sanitizeEventForStorage` runs
   * `redactTokenLikeString` over every string and a base64 envelope looks
   * exactly like a credential to it, so the sealed bytes come back rewritten
   * and unopenable. A decorator therefore sanitizes the PLAINTEXT event (so
   * redaction still applies to real user data), seals the serialized line, and
   * appends it here.
   *
   * Records must be single-line JSON with no trailing newline — this method
   * writes the line terminator and never inspects the content.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async appendRecordLines(
    sessionDir: string,
    records: string[],
    opts: AppendEventsOptions = {},
  ): Promise<AppendEventsResult> {
    const filePath = path.join(sessionDir, "events.ndjson");
    const maxEventBytes = opts.maxEventBytes ?? DEFAULT_MAX_SESSION_EVENT_BYTES;
    const markerPath = path.join(sessionDir, CAPTURE_TRUNCATED_ARTIFACT);
    assertNotSymlink(filePath);
    assertNotSymlink(markerPath);
    const existingBytes = existingFileBytes(filePath);
    const existingEvents = existingEventCount(filePath);
    if (fs.existsSync(markerPath)) {
      return {
        accepted: 0,
        dropped: records.length,
        truncated: true,
        bytesWritten: existingBytes,
      };
    }

    let bytesWritten = existingBytes;
    const acceptedLines: string[] = [];
    let dropped = 0;

    for (let index = 0; index < records.length; index += 1) {
      const line = `${records[index]}\n`;
      const lineBytes = Buffer.byteLength(line, "utf-8");
      if (bytesWritten + lineBytes > maxEventBytes) {
        dropped += records.length - index;
        break;
      }
      acceptedLines.push(line);
      bytesWritten += lineBytes;
    }

    if (acceptedLines.length > 0) {
      fs.appendFileSync(filePath, acceptedLines.join(""), "utf-8");
    }

    const truncated = dropped > 0;
    if (truncated) {
      writeTruncationMarker(markerPath, {
        truncated: true,
        reason: "session_event_bytes_cap",
        maxEventBytes,
        eventsAccepted: existingEvents + acceptedLines.length,
        eventsDropped: dropped,
        bytesWritten,
        truncatedAt: Date.now(),
      });
    }

    return { accepted: acceptedLines.length, dropped, truncated, bytesWritten };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async writeArtifact(
    sessionDir: string,
    name: string,
    data: string | Buffer,
  ): Promise<void> {
    // One optional subdirectory level is allowed (`windows/cand_0001.md` is a
    // real finalize artifact); each segment still has to be a plain safe name,
    // and the realpath containment check below is what actually enforces the
    // boundary.
    const segments = name.split("/");
    if (
      name.includes("..") ||
      segments.length > 2 ||
      segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))
    ) {
      throw new Error(`Invalid generated artifact name: ${name}`);
    }
    const root = fs.realpathSync(sessionDir);
    const target = path.resolve(root, name);
    const expectedParent =
      segments.length === 2 ? path.join(root, segments[0] as string) : root;
    const parent = fs.realpathSync(path.dirname(target));
    if (parent !== expectedParent)
      throw new Error(
        `Generated artifact parent escaped session directory: ${name}`,
      );
    try {
      if (fs.lstatSync(target).isSymbolicLink())
        throw new Error(
          `Refusing to overwrite symlinked generated artifact: ${name}`,
        );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // Staged inside the SAME directory as the target so the rename stays a
    // single-filesystem atomic operation.
    const tmp = path.join(
      parent,
      `.${path.basename(name)}.${process.pid}.${Date.now()}.tmp`,
    );
    fs.writeFileSync(tmp, data, { flag: "wx" });
    fs.renameSync(tmp, target);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async writeBlob(
    sessionDir: string,
    name: string,
    data: Buffer,
  ): Promise<void> {
    const filePath = path.join(sessionDir, name);
    assertNotSymlink(filePath);
    fs.writeFileSync(filePath, data);
  }

  // Non-atomic guarded write used for meta.json and other SessionManager-authored
  // artifacts. Relocated verbatim from SessionManager.writeSessionArtifact so the
  // realpath/symlink containment (assertWritableSessionArtifactPath) lives behind the seam.
  // eslint-disable-next-line @typescript-eslint/require-await
  async writeSessionArtifact(
    sessionDir: string,
    name: string,
    data: string | Buffer,
  ): Promise<void> {
    const filePath = path.join(sessionDir, name);
    assertWritableSessionArtifactPath(sessionDir, filePath);
    fs.writeFileSync(filePath, data);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async readArtifact(
    sessionDir: string,
    name: string,
  ): Promise<Buffer | undefined> {
    const filePath = path.join(sessionDir, name);
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        throw new Error("Refusing to read through symlinked artifact path");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return fs.readFileSync(filePath);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async statArtifact(
    sessionDir: string,
    name: string,
  ): Promise<ArtifactStat | undefined> {
    const filePath = path.join(sessionDir, name);
    try {
      const stat = fs.statSync(filePath);
      return { bytes: stat.size, isDir: stat.isDirectory() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /**
   * Whole-tree enumeration (self-host / single-tenant isolation model), optionally BOUNDED.
   *
   * Two phases, and the split is the whole point:
   *
   * PHASE 1 nominates candidates using nothing but `readdirSync` and the `Dirent` type bits the
   * kernel already returned — no `realpathSync`, no `lstatSync`, no file opened. It skips symlinked
   * and non-directory entries exactly as before, and it declines to descend into a directory that
   * carries a plain `meta.json`, mirroring the recognition rule without paying for it.
   *
   * PHASE 2 is the expensive half — realpath containment on the candidate AND on every directory
   * between it and the output root, then the authoritative `safeRegularFilePath` recognition check —
   * and it runs ONLY on the candidates that will actually be returned. With `options.limit` set, the
   * candidates are visited in {@link compareSessionDirsByRecencyDescending} order and the loop stops
   * the moment the bound is filled, so a store of ten thousand sessions pays containment on the two
   * hundred it was asked for rather than on all ten thousand.
   *
   * Phase 1 is a cheap classifier and is NEVER the acceptance decision: it can only cause a directory
   * to be nominated, never returned. Phase 2 alone decides, so no bound can smuggle a symlinked entry,
   * an escaping realpath, or a directory without a valid `meta.json` into the result.
   *
   * WITHOUT `options.limit` the observable behaviour is what it has always been: every session in the
   * tree, in the same traversal order, having passed the same checks. Relocated originally from
   * SessionManager.eachSessionDir.
   *
   * STILL TRUE AND NOT CLOSED BY THIS BOUND: the phase-1 nomination is one `readdirSync` per
   * directory, so enumeration remains linear in the size of the store, and the whole method remains
   * synchronous and therefore still blocks the event loop for its duration. The bound removes the
   * containment and recognition cost, not the enumeration cost.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listSessions(
    outputDir: string,
    options: ListSessionsOptions = {},
  ): Promise<Array<{ id: string; dir: string }>> {
    const found: Array<{ id: string; dir: string }> = [];
    const limit = options.limit;
    if (limit !== undefined && limit <= 0) return found;
    if (!fs.existsSync(outputDir)) return found;
    // Resolve the output root through any symlinks too (macOS, for example, exposes
    // /var as a symlink to /private/var). Without this, the boundary check below would
    // reject every entry on platforms with symlinked tmp/home paths.
    let outputRoot: string;
    try {
      outputRoot = fs.realpathSync(path.resolve(outputDir));
    } catch {
      return found;
    }
    const outputRootPrefix = outputRoot + path.sep;

    // Defense-in-depth: resolve any symlink chain and require the realpath to live inside
    // outputDir. A symlink in outputDir pointing at /etc (or a relative symlink that escapes via
    // ../) would otherwise let a caller smuggle arbitrary meta.json files through list().
    // Memoized because phase 1 and phase 2 ask about the same directories.
    const containment = new Map<string, boolean>();
    const isContained = (dir: string): boolean => {
      const cached = containment.get(dir);
      if (cached !== undefined) return cached;
      let ok: boolean;
      try {
        const realPath = fs.realpathSync(dir);
        ok = realPath === outputRoot || realPath.startsWith(outputRootPrefix);
      } catch {
        ok = false;
      }
      containment.set(dir, ok);
      return ok;
    };

    // --- Phase 1: nominate, using only dirent type bits -----------------------
    const candidates: string[] = [];
    let rootEntries: fs.Dirent[];
    try {
      rootEntries = fs.readdirSync(outputDir, { withFileTypes: true });
    } catch {
      return found;
    }
    // Each directory's entries travel WITH it on the stack so no directory is read twice: the
    // classification of a child and the expansion of that child are the same readdir.
    const stack: Array<{ dir: string; entries: fs.Dirent[] }> = [
      { dir: outputDir, entries: rootEntries },
    ];
    while (stack.length > 0) {
      const current = stack.pop() as { dir: string; entries: fs.Dirent[] };
      for (const entry of current.entries) {
        // Skip non-directory entries up front. `isDirectory()` returns false for
        // symlinks-to-directories on most filesystems, but on some Node may return
        // UV_DIRENT_UNKNOWN and stat-follow the symlink, so we also explicitly reject
        // `isSymbolicLink()`.
        if (entry.isSymbolicLink()) continue;
        if (!entry.isDirectory()) continue;
        const candidatePath = path.join(current.dir, entry.name);
        let childEntries: fs.Dirent[];
        try {
          childEntries = fs.readdirSync(candidatePath, { withFileTypes: true });
        } catch {
          // Unreadable as a directory listing but possibly still recognisable as a session
          // (recognition needs execute permission, not read permission). Nominate it and let
          // phase 2 decide; descending was never possible here anyway.
          //
          // Containment is applied HERE, not left to phase 2, so that the ancestor guarantee is
          // locally evident on the branch that cannot be reasoned about from the descent check
          // below: every OTHER candidate's parent was gated on the way down, and a candidate's own
          // realpath landing inside the root does not by itself vouch for the directory it was
          // reached through — an ancestor that resolves outside can still have a child that
          // resolves back onto the root. Cheap: one resolve, and only for unreadable directories.
          if (isContained(candidatePath)) candidates.push(candidatePath);
          continue;
        }
        if (hasPlainMetaJsonEntry(candidatePath, childEntries)) {
          candidates.push(candidatePath);
          continue;
        }
        // Containment is checked before DESCENDING, exactly as the walk always did, and for the
        // same two reasons: a directory that resolves outside the store must not contribute the
        // sessions below it, and a link that resolves to one of its own ancestors must not be
        // followed forever. Only the descent pays for it here — there is one such directory per
        // partition layer, not one per session, so this is not the cost the bound exists to remove.
        if (!isContained(candidatePath)) continue;
        stack.push({ dir: candidatePath, entries: childEntries });
      }
    }

    // --- Phase 2: verify, only as far as the bound requires -------------------
    // This is the work the bound exists to skip: one containment resolve and one recognition check
    // per candidate, paid only on the candidates that will actually be returned. Every directory
    // ABOVE a candidate was already checked on the way down in phase 1, so a session reached
    // through an escaping ancestor is unreachable here rather than merely unreturned.
    const isSession = (candidatePath: string): boolean =>
      isContained(candidatePath) &&
      safeRegularFilePath(
        candidatePath,
        path.join(candidatePath, "meta.json"),
      ) !== undefined;

    if (limit === undefined) {
      for (const candidatePath of candidates) {
        if (isSession(candidatePath))
          found.push({ id: path.basename(candidatePath), dir: candidatePath });
      }
      return found;
    }
    for (const candidatePath of [...candidates].sort(
      compareSessionDirsByRecencyDescending,
    )) {
      if (found.length >= limit) break;
      if (isSession(candidatePath))
        found.push({ id: path.basename(candidatePath), dir: candidatePath });
    }
    return found;
  }

  // Immediate, non-symlink file entries of a session directory. Symlinked entries are
  // skipped defensively so a crafted session dir cannot surface artifacts outside itself.
  // eslint-disable-next-line @typescript-eslint/require-await
  async listArtifacts(sessionDir: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      names.push(entry.name);
    }
    return names;
  }

  // Kept synchronous inside the async wrapper: renameSync IS the atomic move,
  // and interposing an await before it would widen the window in which the
  // caller's pre-move containment checks could go stale.
  // eslint-disable-next-line @typescript-eslint/require-await
  async moveToPartition(
    sessionDir: string,
    targetDir: string,
  ): Promise<string> {
    fs.renameSync(sessionDir, targetDir);
    return targetDir;
  }

  resolveSessionDir(
    idOrDir: string,
    outputDir?: string,
    scope?: ResolveSessionScope,
  ): string {
    if (scope) {
      // Scoped resolution must NEVER fall through to the whole-tree walk below, or one
      // tenant could resolve into another's partition. Return the scoped hit, or a stable
      // flat fallback path, and stop.
      const scoped = findScopedSessionDir(idOrDir, outputDir, scope);
      if (scoped) return scoped;
      return outputDir ? path.join(outputDir, idOrDir) : idOrDir;
    }
    if (isSessionDir(idOrDir)) return idOrDir;
    if (!outputDir) return idOrDir;

    const flat = path.join(outputDir, idOrDir);
    if (isSessionDir(flat)) return flat;

    const partitioned = findInPartitionTree(outputDir, idOrDir);
    if (partitioned) return partitioned;

    return flat;
  }

  resolveScopedSessionDir(
    sessionsDir: string,
    tenant: string,
    app: string,
    sessionId: string,
  ): string | undefined {
    return findScopedSessionDir(sessionId, sessionsDir, { tenant, app });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteSessionDir(sessionDir: string): Promise<void> {
    try {
      if (fs.lstatSync(sessionDir).isSymbolicLink()) {
        throw new Error("Refusing to delete through symlinked session path");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

// Marker files that identify a directory as a session directory.
const SESSION_MARKERS = ["manifest.json", "index.json", "meta.json"] as const;

function isSessionDir(dir: string): boolean {
  return SESSION_MARKERS.some((marker) =>
    fs.existsSync(path.join(dir, marker)),
  );
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * The cheap half of session recognition: does this directory's own entry listing already show a
 * plain, non-symlinked `meta.json`?
 *
 * Answered from the dirent type bits `readdirSync` already returned, so it costs nothing beyond the
 * listing itself. It exists to decide whether to DESCEND, never whether to RETURN — the authoritative
 * `safeRegularFilePath` check still runs on every candidate that is actually returned.
 *
 * It mirrors that check's file test exactly rather than approximately. Dirent type bits are absent on
 * filesystems that report DT_UNKNOWN, and a "close enough" reading of them would drop a real session
 * from the listing on those filesystems — so when the bits do not answer, one `lstat` does.
 */
function hasPlainMetaJsonEntry(dir: string, entries: fs.Dirent[]): boolean {
  for (const entry of entries) {
    if (entry.name !== "meta.json") continue;
    if (entry.isSymbolicLink()) return false;
    if (entry.isFile()) return true;
    if (entry.isDirectory()) return false;
    try {
      return fs.lstatSync(path.join(dir, "meta.json")).isFile();
    } catch {
      return false;
    }
  }
  return false;
}

function safeSegment(value: string): boolean {
  return SEGMENT_PATTERN.test(value) && value !== "." && value !== "..";
}

// Tenant-scoped lookup that deliberately never enumerates outside
// {outputDir}/{tenant}/{app}/{YYYY-MM-DD}/{sessionId}. Preserves the cloud isolation
// model (one tenant can never discover another's sessions) behind the same seam.
function findScopedSessionDir(
  sessionId: string,
  outputDir: string | undefined,
  scope: ResolveSessionScope,
): string | undefined {
  const { tenant, app, date } = scope;
  if (!outputDir || !tenant || !app) return undefined;
  if (!safeSegment(tenant) || !safeSegment(app) || !safeSegment(sessionId)) {
    return undefined;
  }

  const projectRoot = path.join(outputDir, tenant, app);
  let dates: string[];
  if (date) {
    if (!DATE_PATTERN.test(date)) return undefined;
    dates = [date];
  } else {
    try {
      dates = fs
        .readdirSync(projectRoot)
        .filter((name) => DATE_PATTERN.test(name))
        .sort()
        .reverse();
    } catch {
      return undefined;
    }
  }

  for (const day of dates) {
    const candidate = path.join(projectRoot, day, sessionId);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (fs.existsSync(path.join(candidate, "meta.json"))) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

// Whole-tree partition walk (self-host / single-tenant). Applies the same symlink /
// realpath containment guards as SessionManager.eachSessionDir so a crafted id cannot
// escape outputDir. Relocated verbatim from session-paths.ts.
function findInPartitionTree(
  outputDir: string,
  sessionId: string,
): string | undefined {
  if (!fs.existsSync(outputDir)) return undefined;

  let outputRoot: string;
  try {
    outputRoot = fs.realpathSync(path.resolve(outputDir));
  } catch {
    return undefined;
  }
  const outputRootPrefix = outputRoot + path.sep;

  const stack = [outputDir];
  while (stack.length > 0) {
    const currentDir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      const candidatePath = path.join(currentDir, entry.name);

      let realPath: string;
      try {
        realPath = fs.realpathSync(candidatePath);
      } catch {
        continue;
      }
      if (realPath !== outputRoot && !realPath.startsWith(outputRootPrefix))
        continue;

      if (
        entry.name === sessionId &&
        fs.existsSync(path.join(candidatePath, "meta.json"))
      ) {
        return candidatePath;
      }
      // Only descend into non-session directories (partition layers), mirroring eachSessionDir.
      if (!fs.existsSync(path.join(candidatePath, "meta.json"))) {
        stack.push(candidatePath);
      }
    }
  }
  return undefined;
}

// --- Active store seam ------------------------------------------------------
//
// Every module in this package reaches storage through `defaultSessionStore`.
// That used to be a hard-bound FilesystemSessionStore instance, which left an
// embedder (notably the hosted cloud) with no way to interpose a decorator —
// so an at-rest encryption wrapper would have been unreachable dead code.
//
// `defaultSessionStore` is therefore a thin forwarding facade over a swappable
// `activeStore`. Call sites are unchanged; an embedder calls setSessionStore()
// once at boot (before any session IO) to install a decorator such as the
// cloud's EncryptedSessionStore. Path resolvers forward too, so a backend that
// later needs to reinterpret layout is covered by the same seam.

let activeStore: SessionStore = new FilesystemSessionStore();

/**
 * Install a SessionStore for this process. Intended to be called ONCE at boot,
 * before any session IO, by an embedder that needs to decorate storage (for
 * example envelope encryption at rest). Not a per-request switch.
 *
 * Rejects `defaultSessionStore` itself. That export is a forwarding facade over
 * `activeStore`, so installing it would make it its own delegate and every call
 * would recurse until the stack overflows. An embedder that wants "no decorator"
 * must simply not call this (or call resetSessionStore); a decorator must wrap a
 * concrete store such as `new FilesystemSessionStore()`, never the facade.
 */
export function setSessionStore(store: SessionStore): void {
  if (store === defaultSessionStore) {
    throw new Error(
      "setSessionStore: refusing to install defaultSessionStore (the forwarding facade) as the active store; wrap a concrete FilesystemSessionStore instead",
    );
  }
  activeStore = store;
}

/** Restore the plain filesystem store. Primarily a test seam. */
export function resetSessionStore(): void {
  activeStore = new FilesystemSessionStore();
}

/** The store currently installed for this process. */
export function getSessionStore(): SessionStore {
  return activeStore;
}

export const defaultSessionStore: SessionStore = {
  createSessionDir: (sessionId) => activeStore.createSessionDir(sessionId),
  appendEvents: (sessionDir, events, opts) =>
    activeStore.appendEvents(sessionDir, events, opts),
  appendRecordLines: (sessionDir, records, opts) =>
    activeStore.appendRecordLines(sessionDir, records, opts),
  writeArtifact: (sessionDir, name, data) =>
    activeStore.writeArtifact(sessionDir, name, data),
  writeBlob: (sessionDir, name, data) =>
    activeStore.writeBlob(sessionDir, name, data),
  writeSessionArtifact: (sessionDir, name, data) =>
    activeStore.writeSessionArtifact(sessionDir, name, data),
  readArtifact: (sessionDir, name) =>
    activeStore.readArtifact(sessionDir, name),
  statArtifact: (sessionDir, name) =>
    activeStore.statArtifact(sessionDir, name),
  listSessions: (outputDir, options) =>
    activeStore.listSessions(outputDir, options),
  listArtifacts: (sessionDir) => activeStore.listArtifacts(sessionDir),
  moveToPartition: (sessionDir, targetDir) =>
    activeStore.moveToPartition(sessionDir, targetDir),
  resolveSessionDir: (idOrDir, outputDir, scope) =>
    activeStore.resolveSessionDir(idOrDir, outputDir, scope),
  resolveScopedSessionDir: (sessionsDir, tenant, app, sessionId) =>
    activeStore.resolveScopedSessionDir(sessionsDir, tenant, app, sessionId),
  deleteSessionDir: (sessionDir) => activeStore.deleteSessionDir(sessionDir),
};

function existingFileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function existingEventCount(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function writeTruncationMarker(
  filePath: string,
  marker: CaptureTruncationSummary,
): void {
  assertNotSymlink(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(marker, null, 2)}\n`);
}

function assertNotSymlink(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("Refusing to write through symlinked artifact path");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

// Realpath/symlink containment for SessionManager-authored artifact writes. Relocated
// verbatim from session.ts so containment lives behind the storage seam; still consumed
// by SessionManager's remaining symlink-tree guards, hence exported.
export function assertWritableSessionArtifactPath(
  rootDir: string,
  filePath: string,
): void {
  try {
    const root = fs.realpathSync(rootDir);
    const parent = fs.realpathSync(path.dirname(filePath));
    if (parent !== root && !parent.startsWith(root + path.sep))
      throw new Error("Invalid sessionId");
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("Invalid sessionId");
    }
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;
    if (err instanceof Error && err.message.includes("Invalid sessionId"))
      throw err;
    throw new Error("Invalid sessionId");
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

// Returns the realpath of `filePath` iff it is a regular, non-symlink file contained within
// `rootDir` (else undefined). Relocated verbatim from session.ts; still used by SessionManager's
// isSessionDir / partition guards, hence exported.
export function safeRegularFilePath(
  rootDir: string,
  filePath: string,
): string | undefined {
  try {
    const root = fs.realpathSync(rootDir);
    const parent = fs.realpathSync(path.dirname(filePath));
    if (parent !== root && !parent.startsWith(root + path.sep))
      return undefined;
    const entry = fs.lstatSync(filePath);
    if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
    const realPath = fs.realpathSync(filePath);
    if (realPath !== root && !realPath.startsWith(root + path.sep))
      return undefined;
    return realPath;
  } catch {
    return undefined;
  }
}
