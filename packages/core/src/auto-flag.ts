import type { BugEvent } from "./types";
import { errorDetector, type Signal, type SignalDetector } from "./signals";

/**
 * What the controller asks the capture path for. Deliberately NOT {@link FlagBugOptions}:
 * an automatic capture has no note, because nobody wrote one. It carries the detector's
 * own `reason` instead, and the capture path stamps the report `origin: "auto"`.
 */
export interface AutoFlagRequest {
  tags: string[];
  reason: string;
}

export interface AutoFlagOptions {
  /** Quiet period after the last new signal before the flag fires, so a cascade coalesces into one report. */
  debounceMs: number;
  /** Hard cap on auto-captured reports per session (shared across all detectors). */
  maxPerSession: number;
  /**
   * Produces the report. Resolves `true` when a report was actually captured and `false` when
   * the capture path declined it — consent withdrawn, sampled out, kill switch on, a flight
   * recorder window already finalizing. That distinction is what the cap counts.
   */
  flag: (request: AutoFlagRequest) => Promise<boolean>;
  /**
   * Signal detectors that decide when to auto-flag. Defaults to error-only (`errorDetector`),
   * preserving the original reactive-on-error behavior. Pass behavioral detectors
   * (rage-click, retry-storm, …) to capture silent failures before an error throws.
   */
  detectors?: SignalDetector[];
}

export interface AutoFlagController {
  handleEvent(event: BugEvent): void;
  /**
   * Ends the current capture window: every signal key becomes flaggable again.
   *
   * Dedup is per window, not per instance. Under the flight recorder a session is a series of
   * windows, each finalizing into its own report, and a `seen` set that outlived a window meant
   * a fixed-key signal fired at most once for the life of the SDK instance — the second slow
   * response episode, the second abandoned flow, the second appearance of one rendered error
   * could never open a window again, however long the session ran.
   */
  endWindow(): void;
  dispose(): void;
}

/**
 * Turns raised {@link Signal}s into automatic `flagBug` snapshots. Each signal key is flagged
 * once per capture window, and a burst of signals settles into a single report (the debounce
 * doubles as post-roll so the ring buffer snapshot includes the cascade's aftermath). The first
 * signal to open a debounce window owns the report's tag and reason; the total report count is
 * capped by `maxPerSession` across every detector.
 */
export function createAutoFlagController(
  options: AutoFlagOptions,
): AutoFlagController {
  const detectors = options.detectors ?? [errorDetector()];
  let seen = new Set<string>();
  /** Reports the capture path confirmed. */
  let flaggedCount = 0;
  /**
   * Fires awaiting their result. Held against the cap so a cascade cannot start more captures
   * than the cap allows while the first is still in flight, and released again when a fire
   * turns out to have captured nothing.
   */
  let inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Signal | undefined;
  let disposed = false;

  const atCap = () => flaggedCount + inFlight >= options.maxPerSession;

  const fire = () => {
    timer = null;
    const signal = pending;
    pending = undefined;
    if (!signal) return;
    // The cap counts CAPTURES, not attempts. Counting attempts meant a session that could not
    // capture at all — consent withdrawn, sampled out, kill switch on — silenced its own
    // controller after `maxPerSession` no-ops, so capture stayed off once those conditions
    // lifted and the session ended with nothing to show for the budget it had spent.
    inFlight++;
    options.flag({ tags: [signal.tag], reason: signal.reason }).then(
      (captured) => {
        inFlight--;
        if (captured) flaggedCount++;
      },
      () => {
        inFlight--;
      },
    );
  };

  return {
    handleEvent(event: BugEvent): void {
      if (disposed) return;
      if (atCap()) return;

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
    endWindow(): void {
      seen = new Set<string>();
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
