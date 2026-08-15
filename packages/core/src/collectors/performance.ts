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
 * allowance for the score-class metrics, of which a session produces a handful.
 * Keeping them apart is what stops a resource storm from shedding the one
 * layout-shift or largest-contentful-paint entry that carries the answer.
 */
type PerfBudgetName = "bulk" | "vitals";

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
 * Reserved allowance for the score-class metrics.
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
 * its own capture gap and disconnects only the vitals observers.
 */
const MAX_VITALS_EVENTS_PER_SESSION = 250;

interface PerfBudget {
  limit: number;
  /** Capture-gap detail written once, when this budget is exhausted. */
  detail: string;
}

const PERF_BUDGETS: Record<PerfBudgetName, PerfBudget> = {
  bulk: {
    limit: MAX_PERF_EVENTS_PER_SESSION,
    detail: `perf events capped at ${MAX_PERF_EVENTS_PER_SESSION} for this session`,
  },
  vitals: {
    limit: MAX_VITALS_EVENTS_PER_SESSION,
    detail: `vitals perf events capped at ${MAX_VITALS_EVENTS_PER_SESSION} for this session`,
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
  const observersByBudget: Record<PerfBudgetName, PerformanceObserver[]> = {
    bulk: [],
    vitals: [],
  };
  const spent: Record<PerfBudgetName, number> = { bulk: 0, vitals: 0 };
  const gapReported: Record<PerfBudgetName, boolean> = {
    bulk: false,
    vitals: false,
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
        // the observation of its entry types. Other budgets keep observing.
        for (const observer of observersByBudget[budget]) observer.disconnect();
      }
      return false;
    }
    spent[budget] += 1;
    bus.emit({ t: now(), k: "perf", d: { metric, ...data() } });
    return true;
  };

  for (const cfg of ENTRY_TYPES) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (cfg.accepts && !cfg.accepts(entry)) continue;
          if (!emitPerf(cfg.budget, cfg.metric, () => cfg.extract(entry)))
            return;
        }
      });
      // `buffered: true` is load bearing, not decoration: navigation and paint
      // timing both happen before any SDK could plausibly have loaded, so a late
      // `init()` misses them permanently without the buffer replay.
      observer.observe({ type: cfg.type, buffered: true });
      observers.push(observer);
      observersByBudget[cfg.budget].push(observer);
    } catch {
      // Entry type not supported — skip
    }
  }

  return disconnectAll;
}
