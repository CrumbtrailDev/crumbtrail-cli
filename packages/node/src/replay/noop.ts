import { describeRefusal } from "./policy";
import type {
  ReplayDecision,
  ReplayFlow,
  Reproducer,
  ReproductionOutcome,
} from "./types";

/**
 * The observation-only arm of the `Reproducer` seam, and the production
 * default. It never drives a browser and never mutates anything.
 *
 * It is not a silent no-op: it forwards the {@link ReplayDecision}'s structured
 * refusal so the caller always learns *why* the replay did not run. A decision
 * in `observe` mode always carries one (see `policy.ts`); the fallback below
 * only guards a hand-rolled factory that returned this adapter for an
 * `execute` decision.
 */
export class NoopReproducer implements Reproducer {
  readonly adapter = "noop" as const;

  async reproduce(
    flow: ReplayFlow,
    decision: ReplayDecision,
  ): Promise<ReproductionOutcome> {
    const refusal = decision.refusal ?? {
      code: "execution_not_enabled" as const,
      reason:
        "No replay driver was selected for this flow, so it was observed rather than run.",
    };

    return {
      attempted: false,
      mode: "observe",
      adapter: this.adapter,
      refusal,
      note: `Observed ${flow.steps.length} step(s) of ${flow.sourceSessionId} without running them. ${describeRefusal(
        refusal,
      )}`,
    };
  }
}
