// --- Per-tenant learning loop cloud client (CRUMB-113) ---------------------
//
// The calls the MCP server makes to close the recall/adoption loop against a
// configured Crumbtrail cloud deployment:
//
//   resolveIssueViaCloud        -> POST /api/memory/resolve      (agent-token auth)
//   recordAgentFeedbackViaCloud -> POST /api/agent/feedback       (agent-token auth)
//   getAgentPlaybookViaCloud    -> GET  /api/agent/playbook       (agent-token auth)
//   startFixVerificationViaCloud-> POST /api/agent/verification   (agent-token auth)
//   getFixVerificationViaCloud  -> GET  /api/agent/verification   (agent-token auth)
//
// All of them authenticate with an agent token (`Authorization: Bearer
// CRUMBTRAIL_CLOUD_TOKEN`, the same secret the remote artifact store uses) and
// reuse `CRUMBTRAIL_CLOUD_URL` for the base.
//
// The project API key (`ctkey_`) is deliberately NOT used here. It is an
// ingest-only credential that the browser SDK ships to every visitor, so the
// cloud refuses it on every read and on the memory plane.
//
// Unlike the recall/pull helpers — which collapse every failure to `undefined`
// because they always have a local fallback — these calls have no local analogue:
// there is no offline way to record a resolution disposition, log adopted recall
// signals, or read a tenant playbook. So each returns a discriminated result so
// the MCP tool can tell the agent *why* a write did not land (unconfigured vs.
// rejected vs. transport) instead of silently swallowing it.

/** Dispositions the cloud accepts on POST /api/memory/resolve. Mirrors the
 *  server's `DISPOSITIONS` allowlist in packages/cloud/src/routes/memory-routes.ts. */
export const ISSUE_DISPOSITIONS = [
  "real-bug",
  "works-as-designed",
  "config",
  "duplicate-of",
  "cannot-reproduce",
  "withdrawn",
] as const;
export type IssueDisposition = (typeof ISSUE_DISPOSITIONS)[number];

/** Feedback subject kinds the cloud accepts on POST /api/agent/feedback. Mirrors
 *  the server's `LEARNING_FEEDBACK_SUBJECT_KINDS` in packages/cloud/src/learning-feedback.ts. */
export const FEEDBACK_SUBJECT_KINDS = [
  "recall_match",
  "opinion",
  "playbook_rule",
] as const;
export type FeedbackSubjectKind = (typeof FEEDBACK_SUBJECT_KINDS)[number];

/** Feedback signals the cloud accepts on POST /api/agent/feedback. Mirrors the
 *  server's `LEARNING_FEEDBACK_SIGNALS`. */
export const FEEDBACK_SIGNALS = [
  "helpful",
  "not_helpful",
  "incorrect",
  "adopted",
  "not_relevant",
] as const;
export type FeedbackSignal = (typeof FEEDBACK_SIGNALS)[number];

/** The cloud rejects `usedMemoryIds` arrays longer than this (memory-routes.ts). */
export const MAX_USED_MEMORY_IDS = 100;

/** Outcome of a learning-loop cloud call. `ok:false` carries the reason so the
 *  MCP tool can render a precise, non-leaking message rather than a bare miss. */
export type LearningLoopResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "unconfigured"; message: string }
  | {
      ok: false;
      reason: "rejected";
      status: number;
      code?: string;
      message: string;
    }
  | { ok: false; reason: "transport"; message: string };

function agentAuth(): { base: string; token: string } | undefined {
  const base = process.env.CRUMBTRAIL_CLOUD_URL?.replace(/\/+$/, "");
  const token = process.env.CRUMBTRAIL_CLOUD_TOKEN;
  return base && token ? { base, token } : undefined;
}

/** Parse a cloud response into a LearningLoopResult. On a non-2xx the cloud
 *  answers `{ error, code, ... }` (http.ts `jsonError`); surface both. The
 *  transport/error branch never echoes the request URL or headers. */
async function parseResponse<T>(res: Response): Promise<LearningLoopResult<T>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.ok) return { ok: true, data: (body ?? {}) as T };
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message =
    typeof record.error === "string" && record.error.trim()
      ? record.error
      : `The cloud rejected the request (HTTP ${res.status}).`;
  const code = typeof record.code === "string" ? record.code : undefined;
  return { ok: false, reason: "rejected", status: res.status, code, message };
}

/** Deliberately generic so a thrown error cannot leak the cloud URL or token. */
const TRANSPORT_MESSAGE =
  "The request to the Crumbtrail cloud failed to complete.";

export interface ResolveIssueInput {
  memoryId: string;
  disposition: IssueDisposition;
  duplicateOf?: string;
  rootCause?: string;
  fixRef?: string;
  note?: string;
  /** Ids of recall matches the agent actually reused to resolve this issue.
   *  The cloud records one `adopted` learning signal per id so the recall index
   *  learns which suggestions closed real bugs. */
  usedMemoryIds?: string[];
}

export interface ResolveIssueResponse {
  ok: boolean;
  memoryId: string;
  resolution: unknown;
  /** Count of `usedMemoryIds` the cloud logged as adopted (omitted when the
   *  caller sent no `usedMemoryIds`). */
  adopted?: number;
}

/**
 * Record a resolution disposition for an indexed issue memory, optionally
 * reporting which recall matches the agent adopted. Project-key auth.
 */
export async function resolveIssueViaCloud(
  input: ResolveIssueInput,
): Promise<LearningLoopResult<ResolveIssueResponse>> {
  const auth = agentAuth();
  if (!auth) {
    return {
      ok: false,
      reason: "unconfigured",
      message:
        "Cloud issue resolution requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    };
  }
  const body: Record<string, unknown> = {
    memoryId: input.memoryId,
    disposition: input.disposition,
  };
  if (input.duplicateOf !== undefined) body.duplicateOf = input.duplicateOf;
  if (input.rootCause !== undefined) body.rootCause = input.rootCause;
  if (input.fixRef !== undefined) body.fixRef = input.fixRef;
  if (input.note !== undefined) body.note = input.note;
  if (input.usedMemoryIds !== undefined)
    body.usedMemoryIds = input.usedMemoryIds;
  try {
    const res = await fetch(`${auth.base}/api/memory/resolve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return await parseResponse<ResolveIssueResponse>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}

export interface RecordFeedbackInput {
  projectId: string;
  subjectKind: FeedbackSubjectKind;
  subjectRef: string;
  signal: FeedbackSignal;
  note?: string;
}

/**
 * Append an agent learning-feedback signal (helpful / adopted / incorrect …)
 * about a recall match, AI opinion, or playbook rule. Agent-token auth; the
 * cloud stamps `source: "agent"`.
 */
export async function recordAgentFeedbackViaCloud(
  input: RecordFeedbackInput,
): Promise<LearningLoopResult<{ feedback: unknown }>> {
  const auth = agentAuth();
  if (!auth) {
    return {
      ok: false,
      reason: "unconfigured",
      message:
        "Recording agent feedback requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    };
  }
  const body: Record<string, unknown> = {
    projectId: input.projectId,
    subjectKind: input.subjectKind,
    subjectRef: input.subjectRef,
    signal: input.signal,
    source: "agent",
  };
  if (input.note !== undefined) body.note = input.note;
  try {
    const res = await fetch(`${auth.base}/api/agent/feedback`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return await parseResponse<{ feedback: unknown }>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}

/**
 * Read the active tenant playbook rules for a project — the distilled, human
 * confirmed guidance the cloud has learned. Agent-token auth.
 */
export async function getAgentPlaybookViaCloud(
  projectId: string,
): Promise<LearningLoopResult<{ rules: unknown[] }>> {
  const auth = agentAuth();
  if (!auth) {
    return {
      ok: false,
      reason: "unconfigured",
      message:
        "Reading the tenant playbook requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    };
  }
  const params = new URLSearchParams({ project: projectId });
  try {
    const res = await fetch(
      `${auth.base}/api/agent/playbook?${params.toString()}`,
      { headers: { Authorization: `Bearer ${auth.token}` } },
    );
    return await parseResponse<{ rules: unknown[] }>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}

// --- Fix verification -------------------------------------------------------
//
// The cloud watches a canonical issue's signature for a bounded observation
// window after a fix and reaches ONE terminal verdict. The trust-critical thesis
// lives in the cloud's verification-engine.ts and is repeated here because this
// client is what an agent actually reads: an absence of evidence is never a
// verified fix. Two of the three verdicts, and every one of the inconclusive
// reasons, mean "we could not tell" rather than "it held".

/** Terminal verdicts the cloud verification engine can reach. Mirrors
 *  `VerificationResult` in packages/cloud/src/canonical-verifications.ts. */
export type VerificationResultValue = "verified" | "recurred" | "inconclusive";

/** The CLOSED reason vocabulary every terminal verdict carries. Mirrors
 *  `VerificationReason` in packages/cloud/src/verification-engine.ts. */
export const VERIFICATION_REASONS = [
  "recurrence_detected",
  "clean_observation_window",
  "window_incomplete",
  "window_too_short",
  "no_telemetry",
  "insufficient_traffic",
  "no_recurrence_low_traffic",
] as const;

/**
 * The reasons that accompany an `inconclusive` verdict — the engine could not
 * tell, so the fix is NOT established. Listed for the tool description, never
 * used to override the `result` the cloud sent: `result` is authoritative and
 * this array is documentation the agent can read.
 */
export const INCONCLUSIVE_VERIFICATION_REASONS = [
  "window_incomplete",
  "window_too_short",
  "no_telemetry",
  "insufficient_traffic",
] as const;

/**
 * One issue's verification state, exactly the shape
 * `packages/cloud/src/routes/agent-verification-routes.ts` returns.
 *
 * `state` is three-valued on purpose: `none` means nothing was ever opened,
 * `open` means a window is in flight and NOTHING has been concluded, and
 * `terminal` means the runtime reached a verdict. An open window never carries
 * a result, so "we do not know yet" stays distinguishable from "we checked".
 */
export interface FixVerificationView {
  state: "open" | "terminal" | "none";
  observationStart: string | null;
  observationEnd: string | null;
  result: VerificationResultValue | null;
  reason: string | null;
  strategy: string | null;
  confidence: number | null;
}

export interface StartFixVerificationResponse extends FixVerificationView {
  /** False when the issue already had a live window: the POST is idempotent and
   *  hands back the existing window rather than opening a second one. */
  opened: boolean;
}

const VERIFICATION_UNCONFIGURED =
  "Fix verification requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.";

/**
 * Open an observation window for one canonical issue after applying a fix.
 * Idempotent server side: an issue with a live window gets that window back with
 * `opened: false` and no second `verification_started` event.
 */
export async function startFixVerificationViaCloud(input: {
  projectId: string;
  canonicalIssueId: string;
}): Promise<LearningLoopResult<StartFixVerificationResponse>> {
  const auth = agentAuth();
  if (!auth) {
    return {
      ok: false,
      reason: "unconfigured",
      message: VERIFICATION_UNCONFIGURED,
    };
  }
  try {
    const res = await fetch(`${auth.base}/api/agent/verification`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project: input.projectId,
        issue: input.canonicalIssueId,
      }),
    });
    return await parseResponse<StartFixVerificationResponse>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}

/**
 * Read the current verification state for one canonical issue. Read-only; it
 * never opens a window, so polling it is free of side effects.
 */
export async function getFixVerificationViaCloud(input: {
  projectId: string;
  canonicalIssueId: string;
}): Promise<LearningLoopResult<FixVerificationView>> {
  const auth = agentAuth();
  if (!auth) {
    return {
      ok: false,
      reason: "unconfigured",
      message: VERIFICATION_UNCONFIGURED,
    };
  }
  const params = new URLSearchParams({
    project: input.projectId,
    issue: input.canonicalIssueId,
  });
  try {
    const res = await fetch(
      `${auth.base}/api/agent/verification?${params.toString()}`,
      { headers: { Authorization: `Bearer ${auth.token}` } },
    );
    return await parseResponse<FixVerificationView>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}
