import type { EventBus } from "../event-bus";
import { buildCaptureGapEvent } from "../capture-gap";
import { attachRedactionMetadata, redactUrl } from "../redaction";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { now } from "../utils";

/**
 * Which emission budget an entry type answers to.
 *
 * `bulk` is for the per-occurrence types the page can produce without bound —
 * one per resource fetched, one per long task. `vitals` is the reserved
 * allowance for the raw score-class entries. Keeping them apart is what stops a
 * resource storm from shedding the one layout-shift or largest-contentful-paint
 * entry that carries the answer.
 *
 * `vitalsFinal` is a third, tiny reserve that only the finalized scores spend —
 * `cls.score`, `lcp.final`, `inp`. Those three are the whole point of the
 * collector: they are what the issue page, the evidence brief and the agent
 * context read, while the raw entries are an optional complement to them. They
 * are also emitted last, from the finalize hooks, so sharing a counter with the
 * raw stream made them the first thing a janky page starved — and a janky page
 * is exactly the session whose score matters.
 */
type PerfBudgetName = "bulk" | "vitals" | "vitalsFinal";

interface EntryTypeConfig {
  type: string;
  metric: string;
  budget: PerfBudgetName;
  /**
   * Optional per-entry filter, for the entry types that carry more than one
   * metric. An entry this rejects is skipped before any budget is spent, so a
   * type we only partly care about cannot eat another type's allowance.
   */
  accepts?: (entry: any) => boolean;
  extract: (entry: any) => Record<string, unknown>;
}

const ENTRY_TYPES: EntryTypeConfig[] = [
  {
    type: "resource",
    metric: "res",
    budget: "bulk",
    extract: (entry) => {
      const name = redactUrl(String(entry.name ?? ""), "name");
      const data: Record<string, unknown> = {
        name: name.value,
        duration: entry.duration,
        transferSize: entry.transferSize,
        initiatorType: entry.initiatorType,
      };
      attachRedactionMetadata(data, name.metadata);
      return data;
    },
  },
  {
    type: "longtask",
    metric: "longtask",
    budget: "bulk",
    extract: (entry) => ({
      duration: entry.duration,
      name: entry.name,
    }),
  },
  {
    type: "layout-shift",
    metric: "cls",
    budget: "vitals",
    extract: (entry) => ({
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
    }),
  },
  {
    type: "largest-contentful-paint",
    metric: "lcp",
    budget: "vitals",
    extract: (entry) => {
      const data: Record<string, unknown> = {
        startTime: entry.startTime,
        size: entry.size,
      };
      if (entry.element?.tagName) {
        data.element = entry.element.tagName;
      }
      return data;
    },
  },
  {
    type: "first-input",
    metric: "fid",
    budget: "vitals",
    extract: (entry) => ({
      delay: entry.processingStart - entry.startTime,
      name: entry.name,
    }),
  },
  {
    // Time to first byte: how long the server took to start answering, which is
    // what separates a slow backend from a slow render when a page feels stuck.
    type: "navigation",
    metric: "ttfb",
    budget: "vitals",
    extract: (entry) => ({
      value: entry.responseStart - entry.startTime,
      domContentLoadedEventEnd: entry.domContentLoadedEventEnd,
      loadEventEnd: entry.loadEventEnd,
    }),
  },
  {
    // First contentful paint. The `paint` entry type also carries `first-paint`,
    // which fires for a background fill and says nothing about content being
    // visible, so only the contentful entry is a vital.
    type: "paint",
    metric: "fcp",
    budget: "vitals",
    accepts: (entry) => entry.name === "first-contentful-paint",
    extract: (entry) => ({ value: entry.startTime }),
  },
];

/**
 * Per-session ceiling on the bulk `perf` events — `resource` and `longtask`.
 *
 * This collector observes every resource the page ever loads, so on a page that
 * polls, retries, or falls into a render loop it emits without bound. Observed
 * for real: a stalled checkout page produced 10,299 `perf` events in one
 * session, which buried the two network requests and the one rendered total
 * that were the actual evidence, and the session never finalized.
 *
 * A normal session here runs 50-110 perf entries, so the ceiling is far above
 * ordinary use and only bites the runaway case. Hitting it is recorded as a
 * capture gap rather than dropped quietly: a reader has to be able to tell a
 * quiet page from a shed one.
 */
const MAX_PERF_EVENTS_PER_SESSION = 1_000;

/**
 * Reserved allowance for the raw score-class entries.
 *
 * Before this reserve existed, every entry type answered to one shared counter,
 * so the runaway resource case above did not just shed resource entries: it shed
 * the layout-shift and largest-contentful-paint entries too, and then
 * disconnected their observers. The metric went silently absent in exactly the
 * sessions where a stalled or thrashing page made it the evidence that mattered.
 *
 * A session produces a handful of these, not hundreds, so this ceiling is far
 * above ordinary use and exists only so a pathological animation loop cannot
 * turn the reserve into a second unbounded channel. Exhausting it is reported as
 * its own capture gap.
 */
const MAX_VITALS_EVENTS_PER_SESSION = 250;

/**
 * Reserved allowance for the finalized scores, which nothing else may spend.
 *
 * A session emits at most three of these — `cls.score`, `lcp.final`, `inp` — and
 * emits them last, from the finalize hooks. While they answered to the raw
 * `vitals` budget above, a page with more than 250 layout shifts spent that
 * budget on the raw stream and left the finalizers nothing, so the score went
 * absent on precisely the janky page that the raw stream exists to describe.
 * Absent vitals is the documented ordinary state downstream, so the failure was
 * invisible there too.
 *
 * A separate name rather than "cap the raw stream at limit minus five" because a
 * shared counter is what caused this: with one counter the two channels stay
 * coupled and any later change to either limit silently re-creates the
 * starvation. Five leaves headroom for a fourth finalized score without
 * revisiting this.
 */
const MAX_FINALIZED_VITALS_EVENTS_PER_SESSION = 5;

interface PerfBudget {
  limit: number;
  /** Capture-gap detail written once, when this budget is exhausted. */
  detail: string;
}

/**
 * Interaction to next paint (INP).
 *
 * INP is not an entry the platform hands over finished: it is a score derived
 * from every interaction in the session, so it can only be reported once the
 * session stops accumulating. That is why it lives outside `ENTRY_TYPES` — the
 * table there is one-entry-in, one-event-out — and emits from a finalize hook.
 *
 * Only interactions at or above this many milliseconds are observed at all.
 * Below it the interaction is not perceptible as slow, and observing every
 * keystroke and pointer event on a busy page is the kind of unbounded work this
 * collector is elsewhere careful to avoid.
 */
const INP_DURATION_THRESHOLD = 40;

/**
 * The estimator drops one candidate per this many interactions.
 *
 * Reporting the plain maximum makes the score hostage to a single unlucky
 * interaction, which on a long session is close to guaranteed. The standard
 * estimator instead ranks interactions by duration and reads the
 * `floor(count / 50)`-th worst: the maximum below 50 interactions, the second
 * worst from 50, the third worst from 100, and so on.
 */
const INP_CANDIDATE_INTERVAL = 50;

/**
 * Ceiling on the interaction records kept for the estimator.
 *
 * A long-lived single-page app can produce interactions indefinitely, and one
 * record per interaction held for the life of the session is a leak. What is
 * kept is the *worst* interactions seen, not the first ones seen: the estimator
 * only ever reads into the slow end of the ranking, so the fast interactions
 * carry no information the score can use.
 *
 * Keeping the first N instead made the clamp actively wrong rather than merely
 * approximate. At 50,000 interactions the rank asked for the 999th worst of the
 * whole session but indexed into a prefix of a thousand early ones, so a
 * genuinely unresponsive app reported an INP near the `durationThreshold` floor
 * and read as `good`. Keeping the worst N makes the clamp conservative in the
 * safe direction: a clamped score over-reports latency rather than hiding it.
 */
const MAX_TRACKED_INTERACTIONS = 1_000;

/**
 * How far past the ceiling the record set is allowed to grow before it is
 * pruned back down to it.
 *
 * Pruning sorts, so doing it on every insert past the ceiling would be a sort
 * per interaction. This amortizes it to one sort per `INTERACTION_PRUNE_SLACK`
 * new interactions.
 *
 * The slack also makes eviction of a live interaction effectively impossible: a
 * pruned id would have to receive a further entry, and the entries of one
 * interaction (pointerdown, pointerup, click) all arrive within that
 * interaction, not 250 distinct interactions later.
 */
const INTERACTION_PRUNE_SLACK = 250;

/** The worst observed duration for one `interactionId`, and what caused it. */
interface InteractionRecord {
  duration: number;
  eventType: string;
}

/**
 * Cumulative layout shift is a windowed score, not a running total.
 *
 * A raw sum over the whole session punishes a long-lived page for existing: an
 * hour of small, unrelated reflows eventually outscores a single catastrophic
 * jump, and the number stops meaning "how badly did the page move under the
 * user". The standard score instead groups shifts into sessions and reports the
 * worst group, so the answer is the worst thing that happened rather than the
 * sum of everything that ever happened.
 *
 * A window ends when either boundary is crossed: more than
 * `CLS_WINDOW_GAP_MS` of quiet since the previous shift, or more than
 * `CLS_WINDOW_SPAN_MS` since the window's first shift. Both are needed. The gap
 * alone lets a continuously thrashing animation accumulate forever; the span
 * alone merges two unrelated bursts that happen to sit inside the same five
 * seconds.
 */
const CLS_WINDOW_GAP_MS = 1_000;
const CLS_WINDOW_SPAN_MS = 5_000;

const PERF_BUDGETS: Record<PerfBudgetName, PerfBudget> = {
  bulk: {
    limit: MAX_PERF_EVENTS_PER_SESSION,
    detail: `perf events capped at ${MAX_PERF_EVENTS_PER_SESSION} for this session`,
  },
  vitals: {
    limit: MAX_VITALS_EVENTS_PER_SESSION,
    detail: `vitals perf events capped at ${MAX_VITALS_EVENTS_PER_SESSION} for this session`,
  },
  vitalsFinal: {
    limit: MAX_FINALIZED_VITALS_EVENTS_PER_SESSION,
    detail: `finalized vitals perf events capped at ${MAX_FINALIZED_VITALS_EVENTS_PER_SESSION} for this session`,
  },
};

export function performanceCollector(
  bus: EventBus,
  _config: CrumbtrailConfig,
): CollectorCleanup {
  if (typeof globalThis.PerformanceObserver === "undefined") {
    return () => {};
  }

  const observers: PerformanceObserver[] = [];
  /**
   * Which observers to stop when a budget is exhausted.
   *
   * Only observers whose entries do nothing but emit are listed. An observer
   * that also feeds a finalized score keeps running past its budget, because
   * the score answers to `vitalsFinal` and stopping the observation would
   * starve it of input instead of of allowance. `vitalsFinal` therefore has no
   * observers of its own: nothing observes on its behalf.
   */
  const observersByBudget: Record<PerfBudgetName, PerformanceObserver[]> = {
    bulk: [],
    vitals: [],
    vitalsFinal: [],
  };
  const spent: Record<PerfBudgetName, number> = {
    bulk: 0,
    vitals: 0,
    vitalsFinal: 0,
  };
  const gapReported: Record<PerfBudgetName, boolean> = {
    bulk: false,
    vitals: false,
    vitalsFinal: false,
  };

  const disconnectAll = (): void => {
    for (const observer of observers) observer.disconnect();
  };

  /**
   * Spend one unit of `budget` and emit a `perf` event, or report the budget's
   * exhaustion once and stop observing the entry types that answer to it.
   *
   * `data` is a thunk so a shed entry never pays for extraction, which for
   * resource entries means URL redaction.
   *
   * Returns whether the event was emitted, so a caller that emits outside an
   * observer callback (a finalize hook, say) can tell shed from delivered.
   */
  const emitPerf = (
    budget: PerfBudgetName,
    metric: string,
    data: () => Record<string, unknown>,
  ): boolean => {
    const { limit, detail } = PERF_BUDGETS[budget];
    if (spent[budget] >= limit) {
      if (!gapReported[budget]) {
        gapReported[budget] = true;
        bus.emit(
          buildCaptureGapEvent({
            surface: "browser",
            reason: "scan_budget_exceeded",
            detail,
          }),
        );
        // Nothing further will be emitted for this budget, so stop paying for
        // the observation of the entry types that do nothing but emit. Other
        // budgets keep observing, and so do the observers that feed a score.
        for (const observer of observersByBudget[budget]) observer.disconnect();
      }
      return false;
    }
    spent[budget] += 1;
    bus.emit({ t: now(), k: "perf", d: { metric, ...data() } });
    return true;
  };

  /**
   * Scores that are only knowable when the session stops accumulating.
   *
   * Each hook is run on cleanup and whenever the page is hidden, so a session
   * that is closed rather than finalized still reports. A hook therefore owns
   * its own once-guard; being called more than once is the normal case.
   */
  const finalizers: Array<() => void> = [];
  const runFinalizers = (): void => {
    for (const finalize of finalizers) finalize();
  };

  // --- Interaction to next paint --------------------------------------------
  const interactions = new Map<number, InteractionRecord>();
  /**
   * Distinct interactions seen, including any past `MAX_TRACKED_INTERACTIONS`
   * that are no longer individually held. The estimator's rank comes from this,
   * so shedding records makes the score more conservative, never wrong about
   * how much the user did.
   */
  let interactionCount = 0;
  let inpEmitted = false;

  /** Drop all but the worst `MAX_TRACKED_INTERACTIONS` records. */
  const pruneInteractions = (): void => {
    const kept = [...interactions.entries()]
      .sort((a, b) => b[1].duration - a[1].duration)
      .slice(0, MAX_TRACKED_INTERACTIONS);
    interactions.clear();
    for (const [id, record] of kept) interactions.set(id, record);
  };

  const recordInteraction = (entry: any): void => {
    // `interactionId` 0 means the platform did not attribute the event to a
    // user interaction at all, so it is not a candidate for an interaction
    // score. Non-numeric ids are equally not interactions.
    const id = entry?.interactionId;
    if (typeof id !== "number" || id === 0) return;

    const duration = Number(entry.duration);
    if (!Number.isFinite(duration)) return;
    const eventType = String(entry.name ?? "");

    const existing = interactions.get(id);
    if (existing) {
      // One interaction fans out into several event entries — pointerdown,
      // pointerup, click. The interaction's latency is the worst of them, not
      // their sum and not whichever arrived last.
      if (duration > existing.duration) {
        existing.duration = duration;
        existing.eventType = eventType;
      }
      return;
    }

    interactionCount += 1;
    interactions.set(id, { duration, eventType });
    if (
      interactions.size >
      MAX_TRACKED_INTERACTIONS + INTERACTION_PRUNE_SLACK
    ) {
      pruneInteractions();
    }
  };

  const emitInp = (): void => {
    if (inpEmitted || interactions.size === 0) return;

    const ranked = [...interactions.values()].sort(
      (a, b) => b.duration - a.duration,
    );
    const rank = Math.min(
      Math.floor(interactionCount / INP_CANDIDATE_INTERVAL),
      ranked.length - 1,
    );
    const candidate = ranked[rank];

    // Spends `vitalsFinal`, the reserve no raw entry can touch, so no volume of
    // observed interactions can shed the score they exist to produce.
    // `emitPerf` still returns false if that reserve is somehow spent, in which
    // case nothing was reported and the guard stays open: claiming an emission
    // that never happened would be a lie the reader cannot see.
    inpEmitted = emitPerf("vitalsFinal", "inp", () => ({
      value: candidate.duration,
      eventType: candidate.eventType,
      interactionCount,
    }));
  };

  finalizers.push(emitInp);

  // --- Cumulative layout shift ----------------------------------------------
  /** The worst window seen so far, which is the reported score. */
  let clsMaxWindow = 0;
  /** Running sum of the window currently open. */
  let clsWindowSum = 0;
  /** Start time of the open window, for the span boundary. */
  let clsWindowStart = 0;
  /** Start time of the last shift in the open window, for the gap boundary. */
  let clsWindowLast = 0;
  let clsWindowOpen = false;
  /** Scoring shifts observed, so an absent score reads as "no shifts". */
  let clsShiftCount = 0;
  let clsEmitted = false;

  const recordLayoutShift = (entry: any): void => {
    // A shift within 500ms of a user interaction is the page responding to that
    // interaction, not moving under the user, and the score excludes it.
    if (entry?.hadRecentInput) return;

    const value = Number(entry?.value);
    if (!Number.isFinite(value)) return;

    // An entry without a usable timestamp still has to be scored — dropping it
    // would understate a real shift — so it lands at the origin, which keeps it
    // inside the first window rather than opening a spurious one.
    const rawStart = Number(entry?.startTime);
    const startTime = Number.isFinite(rawStart) ? rawStart : 0;

    if (
      !clsWindowOpen ||
      startTime - clsWindowLast > CLS_WINDOW_GAP_MS ||
      startTime - clsWindowStart > CLS_WINDOW_SPAN_MS
    ) {
      clsWindowOpen = true;
      clsWindowSum = 0;
      clsWindowStart = startTime;
    }

    clsWindowSum += value;
    clsWindowLast = startTime;
    clsShiftCount += 1;
    if (clsWindowSum > clsMaxWindow) clsMaxWindow = clsWindowSum;
  };

  const emitCls = (): void => {
    if (clsEmitted || clsShiftCount === 0) return;
    // As with INP: the reserved `vitalsFinal` budget, and a guard that takes the
    // emission's own answer rather than assuming it landed.
    clsEmitted = emitPerf("vitalsFinal", "cls.score", () => ({
      value: clsMaxWindow,
      shiftCount: clsShiftCount,
    }));
  };

  finalizers.push(emitCls);

  // --- Largest contentful paint ---------------------------------------------
  /**
   * The most recent candidate, which is the answer only once nothing can
   * replace it.
   *
   * The platform reports LCP as a stream of ever-larger candidates, so any one
   * of them is a guess that a later entry may overturn. Emitting per candidate
   * leaves a reader to work out which one was final; this keeps the last and
   * reports it once.
   */
  let lcpCandidate: Record<string, unknown> | undefined;
  /**
   * Set at the first user interaction. The specification stops LCP there
   * because content that appears after the user has acted is a consequence of
   * that action rather than part of the load the user waited through.
   */
  let lcpFrozen = false;
  let lcpEmitted = false;

  const recordLcpCandidate = (entry: any): void => {
    if (lcpFrozen) return;
    const startTime = Number(entry?.startTime);
    if (!Number.isFinite(startTime)) return;

    const data: Record<string, unknown> = {
      value: startTime,
      size: entry.size,
    };
    if (entry.element?.tagName) {
      data.element = entry.element.tagName;
    }
    lcpCandidate = data;
  };

  const freezeLcp = (): void => {
    lcpFrozen = true;
  };

  const emitLcpFinal = (): void => {
    if (lcpEmitted || !lcpCandidate) return;
    // Nothing observed after finalization can be part of the load either.
    lcpFrozen = true;
    const candidate = lcpCandidate;
    lcpEmitted = emitPerf("vitalsFinal", "lcp.final", () => ({ ...candidate }));
  };

  finalizers.push(emitLcpFinal);

  /** Per-entry-type recorders for the metrics that are scored, not reported. */
  const recorders: Record<string, (entry: any) => void> = {
    "layout-shift": recordLayoutShift,
    "largest-contentful-paint": recordLcpCandidate,
  };

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordInteraction(entry);
    });
    // `durationThreshold` is the whole reason this observer is affordable: the
    // platform filters out the fast interactions before the callback runs.
    observer.observe({
      type: "event",
      buffered: true,
      durationThreshold: INP_DURATION_THRESHOLD,
    } as PerformanceObserverInit);
    observers.push(observer);
    // Deliberately registered against no budget. This observer emits nothing:
    // it only feeds the estimator, whose one emission spends `vitalsFinal`.
    // Stopping it when the raw `vitals` budget runs out would have thrown away
    // interaction data the score still had allowance to report.
  } catch {
    // `event` timing unsupported — INP is simply absent, and every other
    // observer is unaffected.
  }

  const doc: Document | undefined = globalThis.document;
  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === "hidden") runFinalizers();
  };
  doc?.addEventListener("visibilitychange", onVisibilityChange);

  // The two events the specification treats as the user having acted. `click`
  // is deliberately absent: it fires after `pointerdown` for the same act, so
  // listening for it would only ever freeze later than the act itself.
  doc?.addEventListener("keydown", freezeLcp, true);
  doc?.addEventListener("pointerdown", freezeLcp, true);

  for (const cfg of ENTRY_TYPES) {
    const record = recorders[cfg.type];
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // Scoring runs before the budget question, and keeps running after
          // it: a shed entry still moved the page, and the score it feeds
          // spends the separate `vitalsFinal` reserve. So a spent raw budget
          // stops the raw stream and nothing else — `continue`, not `return`,
          // because the rest of this batch still has to be scored.
          record?.(entry);
          if (cfg.accepts && !cfg.accepts(entry)) continue;
          emitPerf(cfg.budget, cfg.metric, () => cfg.extract(entry));
        }
      });
      // `buffered: true` is load bearing, not decoration: navigation and paint
      // timing both happen before any SDK could plausibly have loaded, so a late
      // `init()` misses them permanently without the buffer replay.
      observer.observe({ type: cfg.type, buffered: true });
      observers.push(observer);
      // An observer that also feeds a finalized score stays connected past its
      // budget; only a pure emitter is worth stopping. Scoring is an O(1)
      // numeric update per entry and holds no growing state, so the cost of
      // staying connected is bounded even on a thrashing page, while the score
      // it produces is the collector's actual output.
      if (!record) observersByBudget[cfg.budget].push(observer);
    } catch {
      // Entry type not supported — skip
    }
  }

  return () => {
    // Finalize before disconnecting: the derived scores are only reported here,
    // and a disconnected observer cannot contribute anything more to them.
    runFinalizers();
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
    doc?.removeEventListener("keydown", freezeLcp, true);
    doc?.removeEventListener("pointerdown", freezeLcp, true);
    disconnectAll();
    // The INP ranking is bounded at MAX_TRACKED_INTERACTIONS, so holding it was
    // retained garbage rather than a leak — but the finalizers above have
    // already read everything they will ever read out of it, and the map would
    // otherwise outlive the collector for the whole lifetime of the instance
    // that owned it.
    interactions.clear();
  };
}
