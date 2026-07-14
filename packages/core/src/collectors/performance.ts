import type { EventBus } from "../event-bus";
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

export function performanceCollector(
  bus: EventBus,
  _config: CrumbtrailConfig,
): CollectorCleanup {
  if (typeof globalThis.PerformanceObserver === "undefined") {
    return () => {};
  }

  const observers: PerformanceObserver[] = [];

  for (const cfg of ENTRY_TYPES) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
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

  return () => {
    for (const observer of observers) {
      observer.disconnect();
    }
  };
}
