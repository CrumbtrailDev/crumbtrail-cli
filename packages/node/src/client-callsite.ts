/**
 * @stability experimental
 * The application frames behind a browser-captured stack, in the same shape the
 * server side already publishes for a database write.
 *
 * ============================================================================
 * WHY THIS SHARES `LlmBundleDbCallsite`
 * ============================================================================
 *
 * `code-locations` already knows how to turn that shape into a location with a
 * caller chain, and its reason for keeping the chain applies here more strongly
 * than it does on the server: a client request is almost always issued through a
 * shared helper — `api-addresses.js`, `request` — while the line a fix has to
 * change sits one or two frames out, in the component. A second callsite type
 * would mean a second consumer that has to learn the same lesson.
 *
 * ============================================================================
 * WHAT THIS DOES NOT DO
 * ============================================================================
 *
 * Map a URL onto a repository path. The browser reports where the SCRIPT was
 * served from; only the build knows which file that was, and inventing
 * `client/` in front of `/src/pages/Account.jsx` because the layout usually
 * looks like that is the guess `code-locations` refuses by name. The URL is
 * carried through as reported, which its `CodeFrame.path` already documents as
 * the honest fallback ("repo-relative when the runtime could derive it,
 * absolute otherwise"), and `CRUMBTRAIL_SOURCEMAP_DIR` remains the supported way
 * to resolve it.
 *
 * The query string IS dropped, because a dev server's `?v=4f2a1c` is a cache key
 * for the same file and would otherwise make one file look like several.
 */

import type { LlmBundleDbCallsite } from "./llm-bundle";
import {
  directorySourceMapLookup,
  resolveFrame,
  type SourceMap,
  type SourceMapLookup,
} from "./source-map";

/** How many frames of a client stack are kept, innermost first. */
export const MAX_CLIENT_FRAMES = 5;

/**
 * One rendered stack frame, in either engine shape:
 *   V8              `    at saveAddress (http://host/src/pages/Account.jsx:88:13)`
 *   V8, no function `    at http://host/src/pages/Account.jsx:88:13`
 *
 * The position is required. A frame with no line is a provenance label rather
 * than a location, and admitting one would put a bare bundle URL in front of a
 * reader as though it were a place to look.
 */
const V8_FRAME =
  /^\s*at\s+(?:(?<fn>[^\s(][^(]*?)\s+\()?(?<file>[^\s()]+?):(?<line>\d+):(?<column>\d+)\)?\s*$/;

/**
 * Frames with no script behind them.
 *
 * V8 renders a frame with no source as `<anonymous>:1:1`, and the position makes
 * it match the frame grammar exactly. Measured on a real capture: an SDK frame
 * emitted from a `<anonymous>` context produced the code location
 * `<anonymous>:305`, which is a path a reader cannot open and a line that means
 * nothing — the confidently-wrong location this module refuses by name. A file
 * with no `/` and no `.` is not a script.
 */
/**
 * Schemes that parse as a location and are not the application's code.
 *
 * A browser extension patches `fetch` on the page, so its frames appear in an
 * application stack looking exactly like application frames — a URL, a path, a
 * line and a column, all well formed. Publishing one names a file in SOMEBODY
 * ELSE'S extension as the place to fix the defect, and it is not a file the
 * reader can open, edit, or even obtain.
 *
 * This is not hypothetical for this product: one of the captured scenarios is an
 * ad blocker interfering with checkout, which is precisely a session where an
 * extension's frames are on the stack and the defect is not in them.
 *
 * `blob:` and `data:` go too. Both are real script sources and neither is a file
 * that survives the page, so a reader sent to one has nothing to open.
 */
const FOREIGN_SCHEMES = [
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
  "safari-extension:",
  "ms-browser-extension:",
  "blob:",
  "data:",
  "about:",
];

function isOpenableScript(file: string): boolean {
  if (file.startsWith("<") || file.startsWith("eval at ")) return false;
  if (file === "native" || file === "unknown location") return false;
  const lower = file.toLowerCase();
  if (FOREIGN_SCHEMES.some((scheme) => lower.startsWith(scheme))) return false;
  return file.includes("/") || file.includes("\\");
}

function normalizeScriptUrl(raw: string): string {
  const query = raw.indexOf("?");
  const withoutQuery = query === -1 ? raw : raw.slice(0, query);
  return withoutQuery.length > 0 ? withoutQuery : raw;
}

/** One frame, or undefined when the line is not a located frame at all. */
export function parseClientFrame(
  line: string,
): LlmBundleDbCallsite | undefined {
  const match = V8_FRAME.exec(line);
  const groups = match?.groups;
  if (!groups?.file) return undefined;
  const file = normalizeScriptUrl(groups.file);
  if (file.length === 0 || !isOpenableScript(file)) return undefined;
  const frame: LlmBundleDbCallsite = {
    file,
    line: Number(groups.line),
    column: Number(groups.column),
  };
  const fn = groups.fn?.trim();
  if (fn) frame.fn = fn;
  return frame;
}

/**
 * The innermost application frame of `stk`, with the frames above it as
 * `stack`, or undefined when the stack held no located frame.
 *
 * No frame is filtered out here. The SDK's own frames were removed at capture
 * time by construction (`core/src/call-stack.ts`), which is the only place that
 * can do it without matching on file names — so a stack arriving here with an
 * SDK frame in it is a capture that predates that fix, and dropping it by name
 * would hide exactly that.
 */
export function clientCallsiteFromStack(
  stk: unknown,
): LlmBundleDbCallsite | undefined {
  if (typeof stk !== "string" || stk.length === 0) return undefined;
  const frames: LlmBundleDbCallsite[] = [];
  // The header line ("Error") is skipped: it can itself contain a URL, and it
  // is never a frame.
  for (const line of stk.split("\n").slice(1)) {
    const frame = parseClientFrame(line);
    if (frame) frames.push(frame);
    if (frames.length >= MAX_CLIENT_FRAMES) break;
  }
  const innermost = frames[0];
  if (!innermost) return undefined;
  const callers = frames.slice(1);
  return callers.length > 0 ? { ...innermost, stack: callers } : innermost;
}

/* ------------------------------------------------------------------ */
/* Source maps                                                         */
/* ------------------------------------------------------------------ */

/**
 * A client callsite resolved back to the file a person edits.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Without it this whole feature only works on a dev server. `evidence-index`
 * resolves source maps, but it resolves `candidate.anchor.frame` and nothing
 * else — a client callsite travels a different road (`net.req.stk` →
 * `clientCallsiteFromStack` → `code_locations`) and never passed through it.
 *
 * On a Vite dev server the browser reports `/src/pages/Account.jsx:88:13`, which
 * is already the file a person edits, so the gap is invisible. On a production
 * build it reports `/assets/index-a3f2c1.js:1:48213` — a file nobody wrote and a
 * line that does not exist in the repository, which is the exact outcome
 * `source-map.ts` opens by naming as "technically true and practically useless".
 *
 * ============================================================================
 * FAILURE IS ALWAYS "LEAVE IT ALONE"
 * ============================================================================
 *
 * Unparseable frame, no map, corrupt map, uncovered position: every one of them
 * returns the callsite untouched, matching `resolveCandidateFrames`. A frame a
 * reader knows is minified is better than a frame silently pointed at the wrong
 * file, and `minifiedFile` keeps the generated path so the resolution is
 * checkable rather than merely asserted.
 */
export function resolveClientCallsite(
  callsite: LlmBundleDbCallsite,
  lookup: SourceMapLookup,
  cache?: Map<string, SourceMap | undefined>,
): LlmBundleDbCallsite {
  const resolveOne = (frame: LlmBundleDbCallsite): LlmBundleDbCallsite => {
    // A frame with no position cannot be resolved: a source map is looked up BY
    // generated line and column, so there is nothing to ask it.
    if (frame.line === undefined || frame.column === undefined) return frame;
    const resolved = resolveFrame(
      `${frame.file}:${frame.line}:${frame.column}`,
      lookup,
      cache,
    );
    if (!resolved) return frame;
    const parsed = /^(.*):(\d+):(\d+)$/.exec(resolved);
    if (!parsed) return frame;
    return {
      ...frame,
      file: parsed[1],
      line: Number(parsed[2]),
      column: Number(parsed[3]),
      minifiedFile: frame.file,
    };
  };

  const head = resolveOne(callsite);
  if (!callsite.stack || callsite.stack.length === 0) return head;
  return { ...head, stack: callsite.stack.map(resolveOne) };
}

/**
 * The resolver configured by `CRUMBTRAIL_SOURCEMAP_DIR`, or undefined when it is
 * unset.
 *
 * Off by default and gated on exactly the same variable as the candidate-frame
 * resolution, because two source-map switches that can disagree is a support
 * question nobody can answer from the artifact.
 *
 * The map cache is per call rather than per process: a session's frames sit in a
 * handful of chunks, parsing a production map is the expensive part, and a cache
 * outliving the call would serve a stale map after a rebuild.
 */
export function clientCallsiteResolver():
  | ((callsite: LlmBundleDbCallsite) => LlmBundleDbCallsite)
  | undefined {
  const dir = process.env.CRUMBTRAIL_SOURCEMAP_DIR?.trim();
  if (!dir) return undefined;
  const lookup = directorySourceMapLookup(dir);
  const cache = new Map<string, SourceMap | undefined>();
  return (callsite) => resolveClientCallsite(callsite, lookup, cache);
}
