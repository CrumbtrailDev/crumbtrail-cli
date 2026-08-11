/**
 * Client-side source provenance: which module in the app issued this call.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * A browser session records what the page DID — a request went out, a row was
 * written, a value changed — and, when the defect is silent, nothing at all
 * about WHERE in the app it was done. No throw means no `error.stack`, so a
 * bundle assembled from such a session can name backend files (a `db.diff`
 * carries a server callsite) and never a single line of the client that drove
 * them. A reader handed only server locations for a browser defect is being
 * argued, confidently, toward the wrong tier.
 *
 * The runtime already knows the answer at the moment the call is made: the
 * stack above the wrapper IS the app code that called `fetch`. This module
 * takes that stack, once, at the points where it is decisive, and returns the
 * app frames as `url:line:col` strings — the same shape the rest of the
 * pipeline already parses.
 *
 * ============================================================================
 * WHAT IT REFUSES TO DO
 * ============================================================================
 *
 * GUESS, and COST. Nothing here is inferred from a name, a module graph or a
 * resource-timing entry: a location is a frame the engine reported or it is
 * absent. And a stack is not free — `Error.prototype.stack` is materialized
 * lazily but the capture forces it — so this is called at request initiation
 * only, not on every event. A session with 187 performance samples and 26
 * requests pays for 26.
 *
 * Vendor frames (`node_modules`, a Vite dep chunk) are dropped rather than
 * reported: they name a file the reader cannot fix, and the same filtering
 * discipline already governs backend error frames. When nothing but vendor
 * frames survive, the answer is "no location", not a library's line.
 *
 * Never throws. Every failure mode — no `Error.stack`, an exotic format, a
 * frozen engine — returns `undefined`, which is exactly today's behaviour.
 */

/** App frames kept per capture: the innermost, plus enough callers to escape a helper. */
export const MAX_ORIGIN_FRAMES = 4;

/** Per-frame character ceiling, matching the code-frame cap used downstream. */
export const MAX_ORIGIN_FRAME_LENGTH = 300;

/**
 * The `file:line:col` tail of a stack frame, in either the V8 (`at fn (URL:1:2)`)
 * or SpiderMonkey (`fn@URL:1:2`) shape. Anchored on the trailing digits so a
 * bare URL with no position never matches — a file without a line is a label,
 * not a location.
 */
const FRAME_LOCATION = /((?:https?:\/\/|file:\/\/|\/|[A-Za-z]:\\|\w)[^\s()]*?:\d+:\d+)/;

/**
 * Frames a reader cannot act on: dependencies, pre-bundled dep chunks,
 * extensions, and engine internals.
 */
const VENDOR_FRAME =
  /(?:^|[/\\])node_modules[/\\]|[/\\]\.vite[/\\]deps[/\\]|(?:^|[/\\])\.pnpm[/\\]|^(?:chrome|moz|safari)-extension:|^node:|\[native code\]/;

function isVendorFrame(location: string): boolean {
  return VENDOR_FRAME.test(location);
}

/**
 * The app frames above the caller, innermost first, or `undefined` when the
 * engine gave nothing usable.
 *
 * `skip` is how many of its OWN frames the caller knows sit between it and the
 * app — the wrapper that called this. It is a count rather than a name match
 * because a minifier renames functions but does not change how many frames a
 * call goes through.
 */
export function captureCodeOrigin(skip = 0): string[] | undefined {
  try {
    const stack = new Error().stack;
    if (typeof stack !== "string" || stack.length === 0) return undefined;

    const frames: string[] = [];
    // Frame 0 is this function; `skip` more belong to the caller's wrapper.
    let remaining = 1 + Math.max(0, skip);

    // The header line ("Error") can itself contain no location, but a custom
    // engine may format one; the skip budget absorbs it either way.
    for (const line of stack.split("\n")) {
      const match = FRAME_LOCATION.exec(line);
      if (!match) continue;
      if (remaining > 0) {
        remaining -= 1;
        continue;
      }
      const location = match[1];
      if (location.length > MAX_ORIGIN_FRAME_LENGTH) continue;
      if (isVendorFrame(location)) continue;
      if (frames.includes(location)) continue;
      frames.push(location);
      if (frames.length >= MAX_ORIGIN_FRAMES) break;
    }

    return frames.length > 0 ? frames : undefined;
  } catch {
    // Provenance is never worth an exception in the page.
    return undefined;
  }
}
