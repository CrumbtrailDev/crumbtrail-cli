import type { EvidenceItem, IntentSignal, Symptom } from "crumbtrail-core";

/**
 * Outcome of an on-demand reproduction attempt against a symptom. Reserved
 * for the injected `Reproducer` seam consumed by `solveContext` when
 * historical evidence is thin — see `docs/integrations/reproduction.md`.
 */
export interface ReproductionResult {
  attempted: boolean;
  /** Where a fresh session was recorded, if any. */
  sessionDir?: string;
  /** Fresh evidence gathered (empty if none). */
  evidence: EvidenceItem[];
  /** Usually empty; reserved. */
  intent: IntentSignal[];
  /** Human/agent-readable outcome. */
  note: string;
}

export interface Reproducer {
  reproduce(symptom: Symptom): Promise<ReproductionResult>;
}
