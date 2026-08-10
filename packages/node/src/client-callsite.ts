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
  if (file.length === 0) return undefined;
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
