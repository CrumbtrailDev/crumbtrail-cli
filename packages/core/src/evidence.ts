/**
 * Shared evidence contract. Both crumbtrail-node (compare engine) and
 * crumbtrail-cloud (fusion/ranking) speak this. Evidence is neutral and
 * complete — no ranking or opinion lives here.
 */
export const EVIDENCE_SCHEMA_VERSION = "evidence.v1" as const;

/**
 * A lane is WHERE a piece of evidence came from, and it is the vendor neutral
 * vocabulary the whole product speaks: business logic asks for a lane over a
 * window with correlation keys, never for a provider. Adding a provider therefore
 * adds no lane, and adding a lane is a deliberate widening of what context means.
 *
 * The first eight are CAPTURED or read from an observability source: a session, a
 * request, a query, a log line. The last three are read from systems of record
 * that humans write into, and exist because two questions cannot be answered from
 * telemetry at all:
 *   • what did people already say about this (`tickets`, `conversations`), which
 *     is the only place an issue no end user reported to us ever surfaces
 *   • what changed immediately before it broke (`deploys`)
 */
export type EvidenceLane =
  | "flow"
  | "network"
  | "db"
  | "env"
  | "browser"
  | "logs"
  | "memory"
  | "code"
  /** Support and issue trackers: Jira, Zendesk, Intercom, Linear. Corroborating
   *  context for a failure someone has already described. */
  | "tickets"
  /** Human threads: Slack, email, support conversations. The discovery lane, for
   *  complaints that never became a ticket, which no telemetry source holds. */
  | "conversations"
  /** Releases and deployments: Railway, Vercel, Netlify. What changed inside the
   *  incident window, often the most discriminating single fact available. */
  | "deploys";

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
