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
   * How many sessions OTHER than this one the scan read. This is the denominator, and it travels
   * with every count so a reader is never shown a proportion whose base they cannot see.
   */
  priorSessions: number;
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
    const firedIn: Record<string, number> = {};
    let priorSessions = 0;
    for (const { dir } of await defaultSessionStore.listSessions(corpusRoot)) {
      if (path.resolve(dir) === self) continue;
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
    return { corpusRoot, priorSessions, firedIn };
  } catch {
    return undefined;
  }
}
