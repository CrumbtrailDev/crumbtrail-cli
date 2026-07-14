import type { Symptom } from "crumbtrail-core";
import type { Reproducer, ReproductionResult } from "./types";

/**
 * Safe default `Reproducer`: the inert implementation a `reproducerFactory`
 * may return to explicitly opt out of driving an app. It never drives an app
 * and always reports `attempted:false`.
 *
 * Note: on the default production path `solveContext` does NOT construct this.
 * When `reproducerFactory` is unset the reproduction gate short-circuits
 * (`allowReproduction && this.reproducerFactory && evidence.length === 0`), so
 * no reproducer is built at all. `NoopReproducer` is used only when a factory
 * is wired to return it (e.g. tests, or a future opt-out config).
 */
export class NoopReproducer implements Reproducer {
  async reproduce(_symptom: Symptom): Promise<ReproductionResult> {
    return {
      attempted: false,
      evidence: [],
      intent: [],
      note: "reproduction not configured",
    };
  }
}
