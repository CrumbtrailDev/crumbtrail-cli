import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { now } from "../utils";

export function visibilityCollector(
  bus: EventBus,
  _config: CrumbtrailConfig,
): CollectorCleanup {
  const handler = () => {
    bus.emit({
      t: now(),
      k: "vis",
      d: { state: document.visibilityState },
    });
  };

  document.addEventListener("visibilitychange", handler);

  return () => {
    document.removeEventListener("visibilitychange", handler);
  };
}
