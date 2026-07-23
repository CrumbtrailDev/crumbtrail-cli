import { NoopReproducer } from "./noop";
import {
  evaluateReplayPolicy,
  resolveReplayPolicy,
  type ReplayPolicy,
} from "./policy";
import { PlaywrightReproducer, type PlaywrightLoader } from "./playwright";
import type {
  ReplayDecision,
  ReplayFlow,
  Reproducer,
  ReproductionOutcome,
} from "./types";

/**
 * The one canonical reproduction path.
 *
 * CRUMB-41's complaint was that `reproducerFactory` was never set in
 * production, so the `allowReproduction` argument short-circuited and the seam
 * was decorative. Here the factory has a real default
 * ({@link defaultReproducerFactory}) that selects between the two adapters from
 * a {@link ReplayDecision}, so `allowReproduction: true` against an allowlisted
 * isolated origin genuinely yields {@link PlaywrightReproducer}. The
 * `reproducerFactory` option remains as an override seam for tests and
 * alternative drivers; it is no longer the switch that decides whether
 * anything happens at all.
 */

export interface ReproducerContext {
  decision: ReplayDecision;
  policy: ReplayPolicy;
  loadDriver?: PlaywrightLoader;
}

export type ReproducerFactory = (context: ReproducerContext) => Reproducer;

/**
 * Yields the actuating adapter when — and only when — policy resolved to
 * `execute`; otherwise the observation-only adapter, which reports the
 * decision's structured refusal.
 */
export const defaultReproducerFactory: ReproducerFactory = (context) => {
  if (context.decision.mode !== "execute") return new NoopReproducer();
  return new PlaywrightReproducer({
    loadDriver: context.loadDriver,
    stepTimeoutMs: context.policy.stepTimeoutMs,
  });
};

export interface ReproductionRequest {
  flow: ReplayFlow;
  /**
   * Opt in to actuating the flow. Anything other than `true` keeps the run in
   * observation mode and returns an explained refusal.
   */
  allowReproduction?: boolean;
  /** Per-environment policy. Defaults to observation only, nothing allowlisted. */
  policy?: Partial<ReplayPolicy>;
  /** Override the adapter selection. Defaults to {@link defaultReproducerFactory}. */
  reproducerFactory?: ReproducerFactory;
  /** Override how Playwright is loaded. Defaults to the lazy optional peer import. */
  loadDriver?: PlaywrightLoader;
}

export async function runReproduction(
  request: ReproductionRequest,
): Promise<ReproductionOutcome> {
  const policy = resolveReplayPolicy(request.policy);
  const decision = evaluateReplayPolicy(request.flow, policy, {
    allowReproduction: request.allowReproduction,
  });
  const factory = request.reproducerFactory ?? defaultReproducerFactory;
  const reproducer = factory({
    decision,
    policy,
    loadDriver: request.loadDriver,
  });
  return reproducer.reproduce(request.flow, decision);
}
