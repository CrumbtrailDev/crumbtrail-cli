/**
 * @stability experimental
 * Application callsite capture for database writes.
 *
 * A `db.diff` says a row changed. It does not say which line of the host's code
 * changed it, so an agent handed the bundle still has to go looking — and on a
 * defect like "the total is written from the client's value" the whole answer is
 * one line in one file. The cloud's code pointers solve the same problem from
 * the other end, but they need a GitHub connector and a deploy binding; this is
 * derived from the runtime itself, so it works on the self-host and file-store
 * paths too, and it is the only source that is right by construction rather than
 * by inference.
 *
 * Off by default: capturing a stack per query is not free.
 */

import path from "node:path";

export interface DbCallsite {
  /** Repo-relative when it can be derived, absolute otherwise. */
  file: string;
  line?: number;
  column?: number;
  /** The enclosing function, when V8 reported one. */
  fn?: string;
  /**
   * App frames above this one, innermost first. Present only on the outermost
   * result, so a frame inside `stack` never carries its own `stack`.
   */
  stack?: DbCallsite[];
}

/**
 * Frames that can never be the answer: the instrumentation itself, its
 * dependencies, and the runtime. Matching on path rather than package name
 * keeps a linked checkout (where the SDK is not under node_modules) from
 * reporting its own internals as the host's code.
 */
function isLibraryFrame(file: string, selfDir: string): boolean {
  if (file.startsWith("node:") || file.startsWith("internal/")) return true;
  if (file.includes(`${path.sep}node_modules${path.sep}`)) return true;
  return selfDir.length > 0 && file.startsWith(selfDir);
}

/**
 * V8 frame formats this has to survive:
 *
 *   at insertReview (/app/repo.js:5:20)
 *   at /app/repo.js:5:20
 *   at async createOrder (/app/service.js:22:3)
 *   at async file:///app/routes/checkout.js:41:20     ← no function name at all
 *
 * The last one is why `async` is matched explicitly rather than swept into the
 * function group. Without it the location reads as `async file:///app/...`,
 * which is not a path, does not start with `file://`, and survives
 * `path.relative` as the nonsense `server/async file:/app/...`. That was
 * captured for real and it silently mislocated every write issued from a bare
 * `await` in a route handler.
 */
const FRAME_RE =
  /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/** `file:///a/b.js` → `/a/b.js`; anything else is already a path. */
function normalizeFramePath(file: string): string {
  return file.startsWith("file://") ? new URL(file).pathname : file;
}

/** One V8 frame as an absolute location, or undefined when it is not a frame. */
export function parseStackFrame(raw: string): DbCallsite | undefined {
  const match = FRAME_RE.exec(raw);
  if (!match) return undefined;
  const [, fn, rawFile, line, column] = match;
  return {
    file: normalizeFramePath(rawFile),
    line: Number(line),
    column: Number(column),
    ...(fn ? { fn } : {}),
  };
}

function frameFile(raw: string): string | undefined {
  return parseStackFrame(raw)?.file;
}

/**
 * This module's own directory, read from a stack frame rather than
 * `import.meta.url`.
 *
 * The package ships ESM and CJS from one source. `import.meta.url` is undefined
 * in the CJS build, so reading it there throws `ERR_INVALID_URL` on the first
 * captured write — a failure that only appears against the packed tarball, never
 * against the linked source. A stack frame is the one identifier both module
 * systems agree on.
 */
const SELF_DIR = (() => {
  const stack = new Error().stack?.split("\n") ?? [];
  for (const raw of stack.slice(1)) {
    const file = frameFile(raw);
    if (file && !file.startsWith("node:") && !file.startsWith("internal/")) {
      return path.dirname(file);
    }
  }
  return "";
})();

/** How many app frames above the innermost one to keep. */
const DEFAULT_CHAIN_DEPTH = 4;

/**
 * Stack frames that belong to the host application, innermost first.
 *
 * `stackTraceLimit` is raised only for the capture and restored immediately:
 * the app frame can sit well below V8's default of 10 once a pool, a driver and
 * a repository layer are in between, and leaving the limit raised would tax
 * every unrelated throw in the process.
 */
function appFrames(root: string, limit: number, want: number): DbCallsite[] {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = limit;
  const { stack } = new Error();
  Error.stackTraceLimit = previousLimit;
  if (!stack) return [];
  return appFramesFromStack(stack, root, want);
}

/**
 * The host application's frames within an ALREADY CAPTURED stack string,
 * innermost first — the same walk {@link appFrames} does over a live stack.
 *
 * Split out because a thrown error carries the frames of where it was thrown,
 * which is what a reader needs, while the live stack at the point it is finally
 * handled names the middleware that caught it and nothing about the fault.
 */
export function appFramesFromStack(
  stack: string,
  root: string = process.cwd(),
  want: number = DEFAULT_CHAIN_DEPTH,
): DbCallsite[] {
  const frames: DbCallsite[] = [];
  for (const raw of stack.split("\n").slice(1)) {
    const parsed = parseStackFrame(raw);
    if (!parsed) continue;
    if (isLibraryFrame(parsed.file, SELF_DIR)) continue;
    const relative = path.relative(root, parsed.file);
    frames.push({
      ...parsed,
      // A path that climbs out of the root is not repo-relative; keep it
      // absolute rather than emit a misleading `../../` pointer.
      file:
        relative && !relative.startsWith("..") ? relative : parsed.file,
    });
    if (frames.length >= want) break;
  }
  return frames;
}

/**
 * Where the host application issued this write, plus the app frames above it.
 *
 * The innermost frame alone is rarely the answer. In any app with a repository
 * layer it names the same `insertReview`/`updateOrder` helper for every defect
 * that touches that table, while the line a fix has to change sits one or two
 * frames up in the route handler or the service. Both ends are useful and only
 * the caller can tell which is which, so the chain is reported rather than
 * guessed at: `file`/`line` stay the innermost frame for compatibility and for
 * anything that wants a single pointer, and `stack` carries the walk outward.
 */
export function captureDbCallsite(
  root: string = process.cwd(),
  limit = 30,
  depth = DEFAULT_CHAIN_DEPTH,
): DbCallsite | undefined {
  const frames = appFrames(root, limit, Math.max(1, depth));
  const [innermost, ...callers] = frames;
  if (!innermost) return undefined;
  return {
    ...innermost,
    ...(callers.length > 0 ? { stack: callers } : {}),
  };
}
