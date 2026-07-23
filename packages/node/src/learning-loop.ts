// --- Per-tenant learning loop cloud client (CRUMB-113) ---------------------
//
// Three calls the MCP server makes to close the recall/adoption loop against a
// configured Crumbtrail cloud deployment:
//
//   resolveIssueViaCloud       -> POST /api/memory/resolve   (project-key auth)
//   recordAgentFeedbackViaCloud -> POST /api/agent/feedback  (agent-token auth)
//   getAgentPlaybookViaCloud    -> GET  /api/agent/playbook   (agent-token auth)
//
// The auth split mirrors the cloud routes exactly. `/api/memory/*` authenticates
// with the project API key (`X-Crumbtrail-Auth: CRUMBTRAIL_API_KEY`, the same
// header `recallViaCloud` uses), while `/api/agent/*` authenticates with an agent
// token (`Authorization: Bearer CRUMBTRAIL_CLOUD_TOKEN`, the same secret the
// remote artifact store uses). All three reuse `CRUMBTRAIL_CLOUD_URL` for the base.
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

function projectAuth(): { base: string; apiKey: string } | undefined {
  const base = process.env.CRUMBTRAIL_CLOUD_URL?.replace(/\/+$/, "");
  const apiKey = process.env.CRUMBTRAIL_API_KEY;
  return base && apiKey ? { base, apiKey } : undefined;
}

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
const TRANSPORT_MESSAGE = "The request to the Crumbtrail cloud failed to complete.";

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
  const auth = projectAuth();
  if (!auth) {
    return {
      ok: false,
      reason: "unconfigured",
      message:
        "Cloud issue resolution requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_API_KEY.",
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
  if (input.usedMemoryIds !== undefined) body.usedMemoryIds = input.usedMemoryIds;
  try {
    const res = await fetch(`${auth.base}/api/memory/resolve`, {
      method: "POST",
      headers: {
        "X-Crumbtrail-Auth": auth.apiKey,
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
