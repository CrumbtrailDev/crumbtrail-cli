import type { BugEvent, FlagBugOptions } from "./types";
import { errorDetector, type Signal, type SignalDetector } from "./signals";

export interface AutoFlagOptions {
  /** Quiet period after the last new signal before the flag fires, so a cascade coalesces into one report. */
  debounceMs: number;
  /** Hard cap on auto-captured reports per session (shared across all detectors). */
  maxPerSession: number;
  flag: (options: FlagBugOptions) => Promise<unknown>;
  /**
   * Signal detectors that decide when to auto-flag. Defaults to error-only (`errorDetector`),
   * preserving the original reactive-on-error behavior. Pass behavioral detectors
   * (rage-click, retry-storm, …) to capture silent failures before an error throws.
   */
  detectors?: SignalDetector[];
}

export interface AutoFlagController {
  handleEvent(event: BugEvent): void;
  dispose(): void;
}

/**
 * Turns raised {@link Signal}s into automatic `flagBug` snapshots. Each signal key is flagged
 * once per session, and a burst of signals settles into a single report (the debounce doubles
 * as post-roll so the ring buffer snapshot includes the cascade's aftermath). The first signal
 * to open a debounce window owns the report's tag and note; the total report count is capped by
 * `maxPerSession` across every detector.
 */
export function createAutoFlagController(
  options: AutoFlagOptions,
): AutoFlagController {
  const detectors = options.detectors ?? [errorDetector()];
  const seen = new Set<string>();
  let flaggedCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Signal | undefined;
  let disposed = false;

  const fire = () => {
    timer = null;
    const signal = pending;
    pending = undefined;
    if (!signal) return;
    flaggedCount++;
    options.flag({ tags: [signal.tag], note: signal.note }).catch(() => {});
  };

  return {
    handleEvent(event: BugEvent): void {
      if (disposed) return;
      if (flaggedCount >= options.maxPerSession) return;

      for (const detector of detectors) {
        const signal = detector.inspect(event);
        if (!signal) continue;
        if (seen.has(signal.key)) continue;
        seen.add(signal.key);

        if (pending === undefined) pending = signal;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(fire, options.debounceMs);
      }
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
