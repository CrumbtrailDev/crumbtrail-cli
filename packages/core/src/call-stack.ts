/**
 * @stability experimental
 * Where in the APPLICATION a collector was called from.
 *
 * ============================================================================
 * WHY THIS EXISTS SEPARATELY FROM `new Error().stack`
 * ============================================================================
 *
 * A collector that synthesizes a stack is standing inside its own patched
 * wrapper when it does so, which means the innermost frame belongs to
 * Crumbtrail and not to the application. Downstream that is not a cosmetic
 * problem: `evidence-index` takes the FIRST frame after the header line as the
 * code location, so an unstripped stack publishes the SDK's own bundle as the
 * place a reader should open.
 *
 * That is the one outcome `code-locations` says it exists to prevent — "a wrong
 * location is worse than none: it sends a reader confidently to a file that has
 * nothing to do with the defect, and, unlike a missing location, it does not
 * announce itself."
 *
 * ============================================================================
 * WHY THIS REFUSES RATHER THAN COPES
 * ============================================================================
 *
 * The stripping is done by `Error.captureStackTrace`, which removes every frame
 * at and above a named function BY CONSTRUCTION. It is not name matching: no
 * frame is dropped because its path contains "crumbtrail", so an application
 * that happens to vendor the SDK into its own chunk is never mistaken for the
 * SDK, and a rename never silently stops the stripping.
 *
 * `Error.captureStackTrace` is V8-only (Chrome, Edge, Electron, Node). Where it
 * is absent — Firefox, Safari — this returns undefined and the caller attaches
 * nothing. Guessing a frame depth to strip instead would produce exactly the
 * confidently-wrong location above, on the engines we can least test. No stack
 * is the status quo on those engines; a wrong one would be a regression.
 */

interface V8ErrorConstructor {
  captureStackTrace?: (target: object, constructorOpt?: unknown) => void;
}

/**
 * True when the runtime can strip frames by construction.
 *
 * Exported so a caller can record WHY a callsite is absent — "this engine
 * cannot" reads differently from "nothing called us", and a capture-gap that
 * cannot name its reason is the kind of silent absence this codebase treats as
 * a defect in its own right.
 */
export function canCaptureCallStack(): boolean {
  return typeof (Error as V8ErrorConstructor).captureStackTrace === "function";
}

/**
 * The application call stack above `boundary`, or undefined when the runtime
 * cannot produce one without guessing.
 *
 * `boundary` MUST be the SDK function the application called — the patched
 * `fetch`, the patched `console.error`. Every frame at and above it is removed,
 * so the first frame of the result is application code.
 *
 * The returned string keeps the familiar `Error\n    at ...` shape, because
 * every consumer downstream — the frame parser, the source-map resolver, the
 * redactor — already reads that shape, and a second stack format would be a
 * second thing to keep in step.
 */
export function captureCallStack(boundary: unknown): string | undefined {
  const capture = (Error as V8ErrorConstructor).captureStackTrace;
  if (typeof capture !== "function") return undefined;
  const holder: { stack?: string } = {};
  capture(holder, boundary);
  const stack = holder.stack;
  if (typeof stack !== "string" || stack.length === 0) return undefined;
  // A stack with a header and no frames is not a location. Returning it would
  // hand the consumer a string that parses to nothing, which is indistinguishable
  // downstream from a capture that failed for an interesting reason.
  return stack.includes("\n") ? stack : undefined;
}
