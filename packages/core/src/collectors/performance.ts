import type { EventBus } from "../event-bus";
import { buildCaptureGapEvent } from "../capture-gap";
import { attachRedactionMetadata, redactUrl } from "../redaction";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { now } from "../utils";

interface EntryTypeConfig {
  type: string;
  metric: string;
  extract: (entry: any) => Record<string, unknown>;
}

const ENTRY_TYPES: EntryTypeConfig[] = [
  {
    type: "resource",
    metric: "res",
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
    extract: (entry) => ({
      duration: entry.duration,
      name: entry.name,
    }),
  },
  {
    type: "layout-shift",
    metric: "cls",
    extract: (entry) => ({
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
    }),
  },
  {
    type: "largest-contentful-paint",
    metric: "lcp",
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
    extract: (entry) => ({
      delay: entry.processingStart - entry.startTime,
      name: entry.name,
    }),
  },
];

/**
 * Per-session ceiling on `perf` events.
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

export function performanceCollector(
  bus: EventBus,
  _config: CrumbtrailConfig,
): CollectorCleanup {
  if (typeof globalThis.PerformanceObserver === "undefined") {
    return () => {};
  }

  const observers: PerformanceObserver[] = [];
  let emitted = 0;
  let budgetReported = false;

  const disconnectAll = (): void => {
    for (const observer of observers) observer.disconnect();
  };

  for (const cfg of ENTRY_TYPES) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (emitted >= MAX_PERF_EVENTS_PER_SESSION) {
            if (!budgetReported) {
              budgetReported = true;
              bus.emit(
                buildCaptureGapEvent({
                  surface: "browser",
                  reason: "scan_budget_exceeded",
                  detail: `perf events capped at ${MAX_PERF_EVENTS_PER_SESSION} for this session`,
                }),
              );
              // Nothing further will be emitted, so stop paying for the
              // observation too.
              disconnectAll();
            }
            return;
          }
          emitted += 1;
          bus.emit({
            t: now(),
            k: "perf",
            d: { metric: cfg.metric, ...cfg.extract(entry) },
          });
        }
      });
      observer.observe({ type: cfg.type, buffered: true });
      observers.push(observer);
    } catch {
      // Entry type not supported — skip
    }
  }

  return disconnectAll;
}
