import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { now } from "../utils";

const INTERVAL_MS = 30_000;

export function heartbeatCollector(
  bus: EventBus,
  _config: CrumbtrailConfig,
): CollectorCleanup {
  const id = setInterval(() => {
    const d: Record<string, unknown> = {};

    const heap = (performance as any).memory?.usedJSHeapSize;
    if (heap !== undefined) {
      d.heap = heap;
    }

    if (typeof document !== "undefined") {
      d.dom = document.querySelectorAll("*").length;
    }

    bus.emit({ t: now(), k: "hb", d });
  }, INTERVAL_MS);

  return () => {
    clearInterval(id);
  };
}
