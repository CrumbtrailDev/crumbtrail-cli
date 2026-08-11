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
  | "client.request"
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
 * Three sources, and the structured ones win over the flattened one. A `db.diff`
 * callsite and a browser request callsite each carry a function name and a caller
 * chain; a candidate's `anchor.frame` is a formatted string that has already lost
 * both. Where a candidate names a request that produced either, the structured
 * frame is the better record of the same fact.
 *
 * The two structured sources do NOT compete with each other. A write callsite is
 * the server line that changed the row; a request callsite is the client line
 * that asked for it. For a defect where the server did exactly as it was told —
 * and a bundle that names only the server argues actively for the wrong fix —
 * those are the two ends a reader has to hold at once, so both are emitted.
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
    // The cap is enforced HERE, not only at each loop top. A candidate can now
    // yield two locations — the server line and the client line — so a top-of-
    // loop check alone lets the array finish one over.
    if (locations.length >= MAX_CODE_LOCATIONS) return;
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

  // The same join, on the other side of the wire. The full-stack link table
  // already establishes that a browser request and a server request are one
  // request; where the browser recorded which line issued it, that line is a
  // location for the same ranked signal.
  const clientByRequest = new Map<string, LlmBundleDbCallsite>();
  for (const entry of bundle?.fullStackEvidence?.linked ?? []) {
    const callsite = entry.frontend?.requestCallsite;
    if (callsite && !clientByRequest.has(entry.requestId)) {
      clientByRequest.set(entry.requestId, callsite);
    }
  }
  for (const gap of bundle?.fullStackEvidence?.gaps ?? []) {
    // A gap is a request the two planes could NOT be linked across — the
    // frontend fired and no backend request answered to it. That is not a
    // reason to drop its callsite: a request the server never saw is a
    // client-side story by construction, and one of the cases where the client
    // line is the ONLY line there is.
    const callsite = gap.frontend?.requestCallsite;
    const requestId = gap.requestId ?? gap.frontend?.requestId;
    if (callsite && requestId && !clientByRequest.has(requestId)) {
      clientByRequest.set(requestId, callsite);
    }
  }

  const pushCallsite = (
    callsite: LlmBundleDbCallsite,
    via: CodeLocationVia,
    signalId: string,
    signalTitle?: string,
  ) => {
    push({
      ...frameFromCallsite(callsite),
      via,
      signalId,
      ...(signalTitle ? { signalTitle } : {}),
      // The same flag the candidate-frame path sets from `anchor.minifiedFrame`.
      // A structured callsite that was source-mapped is exactly as much a build
      // artifact as a flattened one, and a reader told nothing would take it for
      // a direct frame.
      ...(callsite.minifiedFile ? { sourceMapped: true } : {}),
      ...(callsite.stack && callsite.stack.length > 0
        ? { callers: callsite.stack.slice(0, MAX_CALLER_FRAMES).map(frameFromCallsite) }
        : {}),
    });
  };

  for (const candidate of ranked) {
    if (locations.length >= MAX_CODE_LOCATIONS) break;

    const requestId = candidate.anchor?.requestId;
    const structured = requestId ? byRequest.get(requestId) : undefined;
    if (structured) {
      pushCallsite(structured, "db.write", candidate.id, candidate.title);
    }

    // Not an alternative to the write above, and not a duplicate of it. A write
    // callsite says which server line changed the row; a request callsite says
    // which client line asked for it. They are two planes of one request, and
    // for a defect where the server did exactly as it was told they are the two
    // ends a reader has to compare. `push` still dedupes by file and line, so a
    // single-process app that somehow reports both at one place stays one entry.
    const client = requestId ? clientByRequest.get(requestId) : undefined;
    if (client) {
      pushCallsite(client, "client.request", candidate.id, candidate.title);
    }

    // The signal's own flattened frame is the fallback for a candidate that had
    // no structured callsite on either side — where one exists, it is the same
    // fact with the function name and caller chain already lost.
    if (structured || client) continue;

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

  // Client requests nothing ranked either. Last, for the same reason the
  // unranked writes are last — and present because a session whose defect never
  // produced a server signal at all is precisely the session that has no other
  // code evidence, and is the case this field was added for.
  for (const callsite of clientByRequest.values()) {
    if (locations.length >= MAX_CODE_LOCATIONS) break;
    // `unranked`, matching the database tail. `signalId` is documented as the
    // ranked signal a location came from, and nothing ranked this one; a real
    // request id here would send a reader looking for a signal that is not
    // there. Requests a candidate DID rank are already in `locations` and are
    // turned away by the file:line dedupe above, keeping their checkable id.
    pushCallsite(callsite, "client.request", "unranked");
  }

  return locations.length > 0 ? locations : undefined;
}
