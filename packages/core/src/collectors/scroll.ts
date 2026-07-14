import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { now } from "../utils";

export function scrollCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const throttleMs = config.scrollThrottleMs;
  const lastEmit = new Map<string, number>();
  const lastPos = new Map<string, [number, number]>();

  function getDirection(
    prev: [number, number],
    curr: [number, number],
  ): string {
    const dx = curr[0] - prev[0];
    const dy = curr[1] - prev[1];
    if (Math.abs(dy) >= Math.abs(dx)) {
      return dy > 0 ? "dn" : "up";
    }
    return dx > 0 ? "rt" : "lt";
  }

  const handler = (event: Event) => {
    const target = event.target;
    let el: string;
    let pos: [number, number];

    if (target === document || target === document.documentElement) {
      el = "document";
      pos = [window.scrollX, window.scrollY];
    } else if (target instanceof Element) {
      el = target.id ? `#${target.id}` : target.tagName.toLowerCase();
      pos = [target.scrollLeft, target.scrollTop];
    } else {
      return;
    }

    const t = now();
    const lastTime = lastEmit.get(el) ?? 0;
    if (t - lastTime < throttleMs) return;

    const prev = lastPos.get(el);
    const dir = prev ? getDirection(prev, pos) : "dn";

    lastEmit.set(el, t);
    lastPos.set(el, pos);

    bus.emit({ t, k: "scr", d: { el, pos, dir } });
  };

  document.addEventListener("scroll", handler, true);

  return () => {
    document.removeEventListener("scroll", handler, true);
  };
}
