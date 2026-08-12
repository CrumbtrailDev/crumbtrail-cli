import path from "node:path";
import { readSessionDistinctBugs } from "./recall";
import { defaultSessionStore } from "./session-store";

/**
 * A detector's CROSS-SESSION base rate: how many of the other sessions already in this store the
 * same detector fired in.
 *
 * The observable exists because every per-session grade answers a different question than the
 * reader is actually asking. Severity is a per-detector constant chosen when the detector was
 * written. Support says how well THIS instance connected to the rest of THIS session. Neither can
 * tell a reader whether the finding at the top of their page is this incident's evidence or the
 * application's wallpaper — and a permanent background condition is, by construction, the
 * best-connected thing in every session it appears in, so the reassuring grade lands on it every
 * time. A reader is then handed a confident headline for a condition that was there yesterday and
 * will be there tomorrow.
 *
 * The only way to tell those apart is to look OUTSIDE the session, at how often the same detector
 * has fired before. That is a fact about the store, not about the session, and nothing in the
 * per-session analysis could ever have computed it.
 *
 * It is disclosure and nothing else. No value here reaches any comparator, score, severity or
 * candidate ordering — see the note beside {@link MIN_PRIOR_SESSIONS_FOR_PREVALENCE}.
 */
export interface DetectorPrevalence {
  /** The store root that was scanned, resolved. */
  corpusRoot: string;
  /**
   * How many sessions OTHER than this one the scan ACTUALLY READ. This is the denominator, and it
   * travels with every count so a reader is never shown a proportion whose base they cannot see.
   *
   * When {@link DetectorPrevalence.truncated} is true this is the cap, not the store's size: the
   * denominator names the scanned set and never the set that exists. A count over a silently
   * truncated corpus is worse than no count, because it is indistinguishable from a complete one.
   */
  priorSessions: number;
  /**
   * True when the store held more prior sessions than {@link MAX_SCANNED_PRIOR_SESSIONS} and only
   * the most recent were read. Every consumer that renders {@link DetectorPrevalence.priorSessions}
   * must say so, in the number AND in any prose that explains what the number means — a truthful
   * count under a sentence claiming it covers the whole store is still a fabricated measurement.
   *
   * Optional because this interface is part of the published SDK surface and an embedder that
   * builds one — {@link WriteLlmBundleInput.prevalence} takes a caller-supplied measurement —
   * would otherwise stop compiling on an upgrade. Absent means the same as false: a scan that did
   * not truncate. Read it as `=== true`, never as truthiness on a field that may not be there.
   */
  truncated?: boolean;
  /** detector -> how many of those prior sessions it fired in AT LEAST ONCE. */
  firedIn: Record<string, number>;
}

/**
 * How many prior sessions a store must hold before any base rate is shown at all.
 *
 * Below this the measurement exists but cannot support the only distinction it is for. The 95%
 * upper bound on a detector seen 0 times in n prior sessions is about 3/n (the rule of three), so
 * at n = 12 that bound is 0.25 and below 12 it exceeds a quarter: a detector that had never been
 * seen would still be consistent with one firing in a quarter of all sessions, and "rare here" and
 * "common here" would not be separable by the number printed. Twelve is where the interval first
 * becomes narrower than the high-versus-low separation the column exists to draw.
 *
 * Under the floor the value is ABSENT, and absent renders as an empty cell — never as `0`, never
 * as a percentage, never as "first occurrence" and never as "unique to this incident". A fresh
 * customer's very first session has no priors at all, so unknown is this observable's DEFAULT
 * state, and a default state that renders as an assertion is a number that cannot tell "we looked
 * and found nothing" from "we never looked".
 *
 * The floor is a rendering threshold and nothing more: it gates whether a fact is DISCLOSED. It is
 * not consulted by any ranking, score, severity or candidate-ordering input, here or downstream.
 */
export const MIN_PRIOR_SESSIONS_FOR_PREVALENCE = 12;

/**
 * How many prior sessions one measurement is allowed to READ.
 *
 * This scan runs on the finalize path, where a user is waiting for their bundle, and it costs one
 * JSON read and parse per prior session. Measured on a real-sized `llm.json` the uncapped scan is
 * linear at about 1.5 ms per prior session: unnoticeable at the 60 sessions it was first measured
 * on, about 1.8 s at a thousand, and about 15 s at ten thousand — and a customer's store only ever
 * grows. An observable that gets slower forever is a defect however useful the number is.
 *
 * A cap is only admissible because the count it produces still travels with an HONEST denominator:
 * above the cap the reader is told the scanned set — `3 of 200 most recent prior sessions` — and
 * never the store's size, which the scan did not look at. See {@link DetectorPrevalence.truncated}.
 *
 * It must stay at or above {@link MIN_PRIOR_SESSIONS_FOR_PREVALENCE}: the floor is applied to the
 * SCANNED count, so a cap below the floor would make every measurement fall under it and silently
 * remove the column from every store in the world.
 *
 * KNOWN AND NOT CLOSED BY THIS CAP: enumerating the store to find the most recent sessions is still
 * a whole-tree synchronous walk inside `SessionStore.listSessions`, measured at about 0.3 ms per
 * session in the store. The cap removes the JSON read and parse, which is about 80% of the cost;
 * the remaining walk is a bound on a different seam (a store listing that can stop early without
 * losing the symlink-containment checks that walk performs) and belongs with that seam, not here.
 */
export const MAX_SCANNED_PRIOR_SESSIONS = 200;

/** `{tenant}/{app}/{YYYY-MM-DD}/{sessionId}` — the depth of a finalized session below its store. */
const PARTITION_DEPTH = 4;

const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The store root a finalized session belongs to, or `undefined` when the directory is not a
 * finalized session inside one.
 *
 * Recognition is structural — the grandparent must be a `YYYY-MM-DD` date partition — rather than
 * "walk up four levels and hope". A session dir handed in by a test, a replay or a repair tool is
 * frequently a bare temp directory, and walking up four levels from one of those would nominate an
 * unrelated ancestor as a corpus and measure a base rate over whatever happened to live under it.
 * A number computed over the wrong corpus is worse than no number, because it is indistinguishable
 * from a real one.
 */
export function deriveCorpusRoot(sessionDir: string): string | undefined {
  const resolved = path.resolve(sessionDir);
  const datePartition = path.basename(path.dirname(resolved));
  if (!DATE_PARTITION.test(datePartition)) return undefined;
  let root = resolved;
  for (let i = 0; i < PARTITION_DEPTH; i += 1) {
    const parent = path.dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
  return root;
}

export interface MeasureDetectorPrevalenceOptions {
  /** The session being rendered. Excluded from its own base rate. */
  sessionDir: string;
  /**
   * The store to measure ACROSS. Defaults to the store root derived from `sessionDir`, which is
   * the right corpus in a deployment, where every session of an app accumulates in one tree.
   *
   * It is explicit rather than always derived because a corpus is not always the session's own
   * parent. Replayed, relocated or imported sessions can each sit alone under their own root, and
   * an observable that silently inferred its corpus from the session's parent would answer
   * "1 of 1" for every detector in that situation — a fabricated number that looks exactly like a
   * measurement. A caller that knows where the corpus really is must be able to say so.
   */
  corpusRoot?: string;
  /** Override the disclosure floor. Defaults to {@link MIN_PRIOR_SESSIONS_FOR_PREVALENCE}. */
  minPriorSessions?: number;
  /**
   * Override how many prior sessions may be read. Defaults to {@link MAX_SCANNED_PRIOR_SESSIONS}.
   *
   * Lowering it below the effective floor yields no measurement at all, since the floor is applied
   * to the scanned count; a caller that lowers this for a test must lower `minPriorSessions` too.
   */
  maxScannedSessions?: number;
}

/**
 * The order the cap selects in: MOST RECENT FIRST, by the `{YYYY-MM-DD}` date partition the session
 * is stored under, then by session id, then by resolved path.
 *
 * A cap without a defined order is not a measurement. `listSessions` walks the tree with a stack
 * and returns whatever order the filesystem handed it, so "the first 200" would differ between two
 * runs over the same store and between two machines holding the same sessions — a number nobody can
 * reproduce and nobody can check. Recency is the order the reader is already being told about
 * ("most recent prior sessions") and the only one that makes a base rate mean anything: a store's
 * OLDEST sessions describe an application that may no longer exist.
 *
 * Both keys are read from the path, not from `meta.json`, so ordering costs no extra I/O — the
 * point of the cap is to stop reading files. Session ids are time-ordered strings, so they break
 * ties within a day in the same direction. The final compare on the full resolved path makes the
 * order TOTAL rather than merely sorted: `listSessions` accepts a session at any depth, so a store
 * shaped differently can yield sessions with no date partition at all (they sort last, together),
 * and ids are only unique within a tenant/app. Without that last key a sort over an unordered input
 * stays unordered wherever the first two keys tie.
 */
function compareByRecencyDescending(a: string, b: string): number {
  const aDate = path.basename(path.dirname(a));
  const bDate = path.basename(path.dirname(b));
  const aKey = DATE_PARTITION.test(aDate) ? aDate : "";
  const bKey = DATE_PARTITION.test(bDate) ? bDate : "";
  if (aKey !== bKey) return aKey < bKey ? 1 : -1;
  const aId = path.basename(a);
  const bId = path.basename(b);
  if (aId !== bId) return aId < bId ? 1 : -1;
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/**
 * Count, over every other session in the corpus, how many of them each detector fired in.
 *
 * Returns `undefined` — never a partial or a zero-filled record — when there is no corpus to
 * measure, when the corpus holds fewer than the floor's worth of prior sessions, or when the scan
 * fails for any reason at all. This runs on the finalize path, where a bundle is being written for
 * a user who is waiting: an unreadable directory or a permission error must cost a disclosure, not
 * a capture.
 *
 * Presence is counted ONCE PER SESSION, not once per firing. The question is "in how many sessions
 * does this appear", and a detector that fires forty times in one session is not thereby common.
 *
 * At most {@link MAX_SCANNED_PRIOR_SESSIONS} sessions are read, most recent first, so the finalize
 * path costs a bounded amount of work in a store of any size. When that bound bites, the result
 * says so through {@link DetectorPrevalence.truncated} and every renderer must pass it on: the
 * denominator this returns is always the number of sessions actually read.
 */
export async function measureDetectorPrevalence(
  options: MeasureDetectorPrevalenceOptions,
): Promise<DetectorPrevalence | undefined> {
  try {
    const corpusRoot =
      options.corpusRoot === undefined
        ? deriveCorpusRoot(options.sessionDir)
        : path.resolve(options.corpusRoot);
    if (corpusRoot === undefined) return undefined;
    const floor = options.minPriorSessions ?? MIN_PRIOR_SESSIONS_FOR_PREVALENCE;
    // Identity by resolved path, not by directory name: a replayed session's directory name and
    // the session id inside its meta.json are not guaranteed to agree, and excluding the current
    // session by the wrong one of those would let it count itself as its own prior.
    const self = path.resolve(options.sessionDir);
    const cap = options.maxScannedSessions ?? MAX_SCANNED_PRIOR_SESSIONS;
    const priors = (await defaultSessionStore.listSessions(corpusRoot))
      .map(({ dir }) => path.resolve(dir))
      .filter((dir) => dir !== self)
      .sort(compareByRecencyDescending);
    // Truncation is decided BEFORE any file is read, and recorded, because it changes what the
    // denominator is allowed to say. The scan reads only what it will count, and counts only what
    // it read: `priorSessions` below is the size of the scanned slice, never the store's size.
    const truncated = priors.length > cap;
    const scanned = truncated ? priors.slice(0, cap) : priors;
    const firedIn: Record<string, number> = {};
    let priorSessions = 0;
    for (const dir of scanned) {
      priorSessions += 1;
      const detectors = new Set<string>();
      for (const bug of await readSessionDistinctBugs(dir)) {
        const representative = bug.representative;
        if (typeof representative !== "object" || representative === null)
          continue;
        const detector = (representative as { detector?: unknown }).detector;
        if (typeof detector === "string" && detector.length > 0)
          detectors.add(detector);
      }
      for (const detector of detectors)
        firedIn[detector] = (firedIn[detector] ?? 0) + 1;
    }
    if (priorSessions < floor) return undefined;
    return { corpusRoot, priorSessions, truncated, firedIn };
  } catch {
    return undefined;
  }
}
