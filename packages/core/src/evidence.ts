/**
 * Shared evidence contract. Both crumbtrail-node (compare engine) and
 * crumbtrail-cloud (fusion/ranking) speak this. Evidence is neutral and
 * complete — no ranking or opinion lives here.
 */
export const EVIDENCE_SCHEMA_VERSION = "evidence.v1" as const;

export type EvidenceLane =
  | "flow"
  | "network"
  | "db"
  | "env"
  | "browser"
  | "logs"
  | "memory"
  | "code";

export interface EvidenceRef {
  sessionId?: string;
  requestId?: string;
  table?: string;
  pk?: Record<string, unknown>;
  sig?: string;
  /**
   * Provider deep-link back to the source system (Sentry issue URL, CloudWatch
   * Logs Insights link, etc.) so a human can verify provenance. Shared by every
   * evidence adapter. A URL carrying an embedded token/credential is scrubbed at
   * the redaction boundary (see node `redact.ts`); a plain issue URL survives as
   * provenance. Optional and additive — session-derived evidence omits it.
   */
  url?: string;
  /** Source provider id for a deep-linked item, e.g. "sentry" | "cloudwatch". */
  provider?: string;
  /** Provider-native record id for the deep-linked item (issue id, event id). */
  id?: string;
}

export interface EvidenceItem {
  /** Stable id used by IntentSignal.evidenceId to correlate. */
  id: string;
  lane: EvidenceLane;
  /** Discriminating kind, e.g. "net.status", "db.row-value", "flow.step-missing". */
  kind: string;
  brief: string;
  ref: EvidenceRef;
  before: unknown;
  after: unknown;
  /** ms epoch when observed, if known. */
  whenObserved?: number;
}

export interface IntentSignal {
  /** Foreign key to EvidenceItem.id. */
  evidenceId: string;
  explainedByCommit?: { sha: string; pr?: string; message: string };
  prIntent?: string;
}
