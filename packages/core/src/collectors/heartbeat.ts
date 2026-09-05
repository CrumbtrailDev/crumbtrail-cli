import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { now } from "../utils";

/** Cadence while the session has seen application activity. */
const BASE_INTERVAL_MS = 30_000;

/**
 * Ceiling on the backed-off interval for a quiet session.
 *
 * The server side idle sweeper that finalizes a session with no new event on
 * disk (`DEFAULT_SWEEP_IDLE_MS` in `packages/analysis/src/session-sweeper.ts`
 * of the main product, wired unchanged into the hosted cloud) fires after
 * 5 minutes. A heartbeat is itself an event that refreshes that clock, so the
 * cap here must stay well under half that budget or a quiet-but-alive session
 * could cross the sweeper's threshold between two heartbeats. 120s doubles
 * cleanly from the base (30s -> 60s -> 120s) and leaves 150s of slack under
 * the 300s idle limit.
 */
const MAX_INTERVAL_MS = 120_000;

export function heartbeatCollector(
  bus: EventBus,
  _config: CrumbtrailConfig,
): CollectorCleanup {
  let interval = BASE_INTERVAL_MS;
  let sawActivity = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Any admitted event other than the heartbeat's own counts as the session
  // being alive; the heartbeat's own emit below must not count as its own
  // activity, which is why it is excluded by kind rather than by ordering.
  const untap = bus.tap((event) => {
    if (event.k !== "hb") sawActivity = true;
  });

  function fire(): void {
    // intervalMs is the cadence that produced this heartbeat. No cloud path
    // reads it today (ingest-routes.ts and evidence-index.ts in the main
    // product only check the `hb` event kind); it is emitted for a future
    // reader that wants to tell "quiet but alive" from "gone".
    const d: Record<string, unknown> = { intervalMs: interval };

    const heap = (performance as any).memory?.usedJSHeapSize;
    if (heap !== undefined) {
      d.heap = heap;
    }

    if (typeof document !== "undefined") {
      d.dom = document.querySelectorAll("*").length;
    }

    bus.emit({ t: now(), k: "hb", d });

    // bus.emit runs its subscribers synchronously, and one of them may call
    // this collector's own cleanup (e.g. a tap that stops the logger on the
    // event it just saw). Re-arming below would otherwise leave one more
    // heartbeat scheduled past teardown.
    if (stopped) return;

    interval = sawActivity
      ? BASE_INTERVAL_MS
      : Math.min(interval * 2, MAX_INTERVAL_MS);
    sawActivity = false;

    timer = setTimeout(fire, interval);
  }

  timer = setTimeout(fire, interval);

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    untap();
  };
}
