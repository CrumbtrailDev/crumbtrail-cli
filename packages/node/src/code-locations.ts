/**
 * @stability experimental
 * Where in the repository each ranked signal physically came from.
 *
 * ============================================================================
 * WHY THIS IS NOT `code_pointers`
 * ============================================================================
 *
 * `code-pointers.ts` projects what the CLOUD resolved: a GitHub permalink pinned
 * to a commit, produced by a connector that knows the repo and the deploy sha.
 * Its doctrine is that it never fabricates a pointer, and `buildCallsitePointer`
 * enforces that by returning undefined without a repo binding — which is correct,
 * and which is also why a self-hosted or file-store bundle has carried no code
 * evidence at all. There is no connector on that path and there never will be.
 *
 * A reader does not need a clickable URL. It needs a path, a line, and the
 * function it sits in. That is available on every path, from the runtime itself,
 * with no connector and no inference — the SDK is already standing in the call
 * path when the event is recorded, so it can simply ask who called it.
 *
 * So: two fields, two provenances, named apart. `code_pointers` stays cloud and
 * clickable. `code_locations` is runtime-derived and always available. Merging
 * them would mean either inventing permalinks that do not resolve, or dropping
 * the fields that make the cloud's version worth having.
 *
 * ============================================================================
 * WHAT THIS IS NOT ALLOWED TO DO
 * ============================================================================
 *
 * GUESS. Every location here is a frame the runtime reported while the evidence
 * was being captured, carried through unchanged. Nothing is matched by name,
 * inferred from a stack-free error message, or searched for in the tree. A wrong
 * location is worse than none: it sends a reader confidently to a file that has
 * nothing to do with the defect, and — unlike a missing location — it does not
 * announce itself.
 *
 * The ORDER is the ranking that already exists. These come out in candidate
 * order, so the first location belongs to the highest-ranked signal. Re-sorting
 * them by anything else would be a second, silent opinion about what matters,
 * competing with the one the product already publishes.
 */

import type { EvidenceCandidate } from "./evidence-index";
import type { LlmBundle, LlmBundleDbCallsite } from "./llm-bundle";

/** How many locations a bundle carries. Beyond this a reader is searching again. */
export const MAX_CODE_LOCATIONS = 12;

/** How many callers to keep above a location. */
export const MAX_CALLER_FRAMES = 4;

/** What kind of evidence put us at this line. */
export type CodeLocationVia =
  | "db.write"
  | "signal";

/** One frame: a path a person can open, and the line they should look at. */
export interface CodeFrame {
  /** Repo-relative when the runtime could derive it, absolute otherwise. */
  path: string;
  line?: number;
  column?: number;
  /** The enclosing function, when the runtime reported one. */
  fn?: string;
}

/**
 * A place in the source that a piece of ranked evidence came from.
 *
 * `signalId` is not decoration. It is what makes the location checkable: a reader
 * can go back to that signal and see what it claimed, rather than taking the
 * path on faith. A location with no signal behind it would be exactly the kind of
 * free-floating assertion this module exists to avoid.
 */
export interface CodeLocation extends CodeFrame {
  via: CodeLocationVia;
  /** The ranked signal this location was taken from. */
  signalId: string;
  /** What that signal was, in one line, so the path has a reason attached. */
  signalTitle?: string;
  /**
   * App frames above this one, innermost first.
   *
   * The innermost frame is often a shared helper — `updateOrder`, `request` —
   * that is named identically for every defect touching it, while the line a fix
   * has to change sits one or two frames out in the caller. Both ends are useful
   * and only a reader can tell which is which, so the walk is reported rather
   * than chosen between.
   */
  callers?: CodeFrame[];
  /**
   * True when the runtime reported a bundler chunk and a source map resolved it
   * back to a repository file.
   *
   * Recorded because the two are not equally trustworthy. A direct frame is a
   * fact; a mapped frame is a fact plus a build artifact that may be stale, and a
   * reader who opens the wrong line deserves to know which of those they were
   * given.
   */
  sourceMapped?: boolean;
}

/**
 * `path/to/file.js:12:34` -> its parts.
 *
 * Written to REFUSE rather than to cope. A frame that does not end in a line
 * number is a provenance label ("backend", a transport name), not a location, and
 * `anchor.source` exists for those. Accepting them here would fill the field with
 * strings that look like paths and open nothing.
 */
export function parseFrame(frame: unknown): CodeFrame | undefined {
  if (typeof frame !== "string") return undefined;
  const trimmed = frame.trim();
  if (trimmed.length === 0) return undefined;
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(trimmed);
  if (!match) return undefined;
  const [, rawPath, line, column] = match;
  if (!rawPath || rawPath.length === 0) return undefined;
  const location: CodeFrame = { path: rawPath, line: Number(line) };
  if (column !== undefined) location.column = Number(column);
  return location;
}

function frameFromCallsite(callsite: LlmBundleDbCallsite): CodeFrame {
  const frame: CodeFrame = { path: callsite.file };
  if (typeof callsite.line === "number") frame.line = callsite.line;
  if (typeof callsite.column === "number") frame.column = callsite.column;
  if (typeof callsite.fn === "string" && callsite.fn.length > 0) frame.fn = callsite.fn;
  return frame;
}

/** Same file, same line — the same place, however it was reported. */
function keyOf(frame: CodeFrame): string {
  return `${frame.path}:${frame.line ?? ""}`;
}

/**
 * The code locations behind the ranked signals, in ranked order.
 *
 * Two sources, and the structured one wins where they overlap. A `db.diff`
 * callsite carries a function name and a caller chain; a candidate's `anchor.frame`
 * is a formatted string that has already lost both. Where a candidate names a
 * request that also produced a write, the write's structured frame is the better
 * record of the same fact.
 *
 * Returns undefined rather than an empty array when nothing was captured, so a
 * consumer can tell "the SDK was not capturing callsites" from "it was, and there
 * were none" — an empty list reads as the second and is usually the first.
 */
export function buildCodeLocations(
  bundle: LlmBundle | undefined,
  ranked: EvidenceCandidate[],
): CodeLocation[] | undefined {
  const locations: CodeLocation[] = [];
  const seen = new Set<string>();

  const push = (location: CodeLocation) => {
    const key = keyOf(location);
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(location);
  };

  // Structured callsites, indexed by the request that produced them, so a
  // candidate anchored on a request can claim the richer frame instead of its
  // own flattened one.
  const byRequest = new Map<string, LlmBundleDbCallsite>();
  for (const diff of bundle?.databaseDiffs ?? []) {
    if (diff.callsite && diff.requestId && !byRequest.has(diff.requestId)) {
      byRequest.set(diff.requestId, diff.callsite);
    }
  }

  for (const candidate of ranked) {
    if (locations.length >= MAX_CODE_LOCATIONS) break;

    const requestId = candidate.anchor?.requestId;
    const structured = requestId ? byRequest.get(requestId) : undefined;
    if (structured) {
      push({
        ...frameFromCallsite(structured),
        via: "db.write",
        signalId: candidate.id,
        signalTitle: candidate.title,
        ...(structured.stack && structured.stack.length > 0
          ? { callers: structured.stack.slice(0, MAX_CALLER_FRAMES).map(frameFromCallsite) }
          : {}),
      });
      continue;
    }

    const frame = parseFrame(candidate.anchor?.frame);
    if (!frame) continue;
    push({
      ...frame,
      via: "signal",
      signalId: candidate.id,
      signalTitle: candidate.title,
      // `minifiedFrame` is set by `evidence-index` only when a source map moved
      // the frame, so its presence IS the record that resolution happened.
      ...(candidate.anchor?.minifiedFrame ? { sourceMapped: true } : {}),
    });
  }

  // Writes whose request never produced a ranked candidate. Last, because
  // nothing ranked them — but present, because "which line wrote this row" is
  // the question a db.diff most often provokes.
  for (const diff of bundle?.databaseDiffs ?? []) {
    if (locations.length >= MAX_CODE_LOCATIONS) break;
    if (!diff.callsite) continue;
    push({
      ...frameFromCallsite(diff.callsite),
      via: "db.write",
      signalId: diff.requestId ?? "unranked",
      ...(diff.callsite.stack && diff.callsite.stack.length > 0
        ? { callers: diff.callsite.stack.slice(0, MAX_CALLER_FRAMES).map(frameFromCallsite) }
        : {}),
    });
  }

  return locations.length > 0 ? locations : undefined;
}
