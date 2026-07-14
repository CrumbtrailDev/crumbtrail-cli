// Pure "waiting for first event" backoff state machine for the CLI's verify
// step. This is a deliberate, self-contained COPY of the dashboard wizard's
// packages/dashboard/src/lib/ingest-poll.ts — the CLI must not import from the
// dashboard package (different build target, no runtime dependency). Keeping the
// timing policy as pure functions lets verify.ts drive it with real timers while
// tests fold attempts synchronously.

export interface IngestPollConfig {
  /** Delay before the first poll, and the backoff step size. */
  initialDelayMs: number;
  /** Upper bound on the per-attempt delay. */
  maxDelayMs: number;
  /** Give up (→ "timedout") once cumulative waiting reaches this. */
  timeoutMs: number;
}

export const DEFAULT_INGEST_POLL_CONFIG: IngestPollConfig = {
  initialDelayMs: 3000,
  maxDelayMs: 10000,
  timeoutMs: 5 * 60 * 1000,
};

export type IngestPollStatus = "waiting" | "found" | "timedout";

export interface IngestPollState {
  status: IngestPollStatus;
  attempts: number;
  elapsedMs: number;
}

export function initialIngestPollState(): IngestPollState {
  return { status: "waiting", attempts: 0, elapsedMs: 0 };
}

/**
 * Delay before the NEXT poll attempt: ramps linearly from the initial delay
 * (3s → 6s → 9s …) capped at maxDelayMs. Terminal states return 0.
 */
export function nextPollDelayMs(
  state: IngestPollState,
  config: IngestPollConfig = DEFAULT_INGEST_POLL_CONFIG,
): number {
  if (state.status !== "waiting") return 0;
  const grown = config.initialDelayMs * (state.attempts + 1);
  return Math.min(grown, config.maxDelayMs);
}

/**
 * Fold one completed poll attempt into the state. Once terminal the state is
 * frozen so a late in-flight poll can't resurrect polling.
 */
export function recordPollAttempt(
  state: IngestPollState,
  found: boolean,
  waitedMs: number,
  config: IngestPollConfig = DEFAULT_INGEST_POLL_CONFIG,
): IngestPollState {
  if (state.status !== "waiting") return state;
  const attempts = state.attempts + 1;
  const elapsedMs = state.elapsedMs + Math.max(0, waitedMs);
  if (found) return { status: "found", attempts, elapsedMs };
  if (elapsedMs >= config.timeoutMs)
    return { status: "timedout", attempts, elapsedMs };
  return { status: "waiting", attempts, elapsedMs };
}
