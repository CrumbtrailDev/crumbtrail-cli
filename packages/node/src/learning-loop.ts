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

/** Who produced a resolution, on POST /api/memory/resolve. Mirrors the server's
 *  `OUTCOME_PROVENANCES` in packages/cloud/src/ticket-outcomes.ts.
 *
 *  - `inferred`          — read out of a tracker's own close data; nobody was asked.
 *  - `agent`             — a model's claim. Useful signal, never ground truth.
 *  - `human-confirmed`   — a person decided it through an authenticated session.
 *
 *  The cloud requires it and rejects a request that omits it with 400
 *  `invalid_provenance`. It is NOT defaulted here either, and specifically never
 *  defaulted to `human-confirmed`: the route used to hard code
 *  `source: "human", confirmed: true` on every write, so an agent's guess was
 *  stored as a person's confirmation in the one dataset the learning loop
 *  weights. A default anywhere on the path — client or caller — restores that
 *  laundering quietly, so every caller states its own provenance. */
export const ISSUE_RESOLUTION_PROVENANCES = [
  "inferred",
  "agent",
  "human-confirmed",
] as const;
export type IssueResolutionProvenance =
  (typeof ISSUE_RESOLUTION_PROVENANCES)[number];

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

/**
 * Bases the agent token may be sent to. The token is a tenant wide secret carried in an
 * `Authorization` header, so a plain `http:` base would put it on the wire in cleartext for
 * anyone on the path. Loopback is exempt because it never leaves the machine and is how the
 * cloud is run locally.
 */
function isTransportSecureBase(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  );
}

function cloudBase(): string | undefined {
  return process.env.CRUMBTRAIL_CLOUD_URL?.replace(/\/+$/, "") || undefined;
}

function agentAuth(): { base: string; token: string } | undefined {
  const base = cloudBase();
  const token = process.env.CRUMBTRAIL_CLOUD_TOKEN;
  if (!base || !token) return undefined;
  if (!isTransportSecureBase(base)) return undefined;
  return { base, token };
}

const INSECURE_BASE_MESSAGE =
  "CRUMBTRAIL_CLOUD_URL must use https (localhost is the only exception). The agent token is not sent over plain http.";

/**
 * The gap a call reports when it has no usable cloud. A base that is set but refused is reported
 * as its own reason rather than as a missing variable, so an operator is not sent looking for a
 * value that is already there.
 */
function unconfigured<T>(message: string): LearningLoopResult<T> {
  const base = cloudBase();
  return {
    ok: false,
    reason: "unconfigured",
    message:
      base && !isTransportSecureBase(base) ? INSECURE_BASE_MESSAGE : message,
  };
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
  /** Required, and deliberately not optional: see ISSUE_RESOLUTION_PROVENANCES.
   *  A caller that cannot honestly claim a person confirmed the resolution
   *  sends `agent`. */
  provenance: IssueResolutionProvenance;
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
 * reporting which recall matches the agent adopted. Agent-token auth.
 *
 * `provenance` is always sent; the cloud answers 400 `invalid_provenance` when
 * it is missing or unrecognised.
 */
export async function resolveIssueViaCloud(
  input: ResolveIssueInput,
): Promise<LearningLoopResult<ResolveIssueResponse>> {
  const auth = agentAuth();
  if (!auth) {
    return unconfigured(
      "Cloud issue resolution requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    );
  }
  const body: Record<string, unknown> = {
    memoryId: input.memoryId,
    disposition: input.disposition,
    provenance: input.provenance,
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
    return unconfigured(
      "Recording agent feedback requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    );
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
    return unconfigured(
      "Reading the tenant playbook requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    );
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
    return unconfigured(VERIFICATION_UNCONFIGURED);
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
    return unconfigured(VERIFICATION_UNCONFIGURED);
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

// --- Client ticket memory: three-section recall + the notes write path ------
//
//   recallIssueContextViaCloud  -> POST /api/memory/recall            (agent-token auth)
//   recordClientNoteViaCloud    -> POST /api/memory/notes             (agent-token auth)
//   amendClientNoteViaCloud     -> POST /api/memory/notes/:id/amend   (agent-token auth)
//
// These replace the old `GET /api/memory/recall` single-list read. The cloud
// keeps that route alive for the deployment window only; nothing in this
// package calls it any more.

/**
 * The three sections of a recall answer, and the one a caller cannot drop.
 *
 * Mirrors `RECALL_SECTIONS` / `MANDATORY_RECALL_SECTION` in the cloud's
 * `routes/memory-routes.ts`. The rule is enforced on BOTH sides on purpose: the
 * cloud adds `cautions` back to whatever `include` it receives, and this client
 * adds it back before the request is even sent, so a local (non-cloud) run and
 * an older cloud both behave the same way.
 */
export const RECALL_SECTIONS = [
  "duplicates",
  "precedents",
  "cautions",
] as const;
export type RecallSection = (typeof RECALL_SECTIONS)[number];

/** `cautions` carries what we already know will bite on this client. An agent
 *  narrowing its way out of the warnings is the one narrowing we refuse. */
export const MANDATORY_RECALL_SECTION: RecallSection = "cautions";

/**
 * Normalise an `include` list. Returns `undefined` for "all three" and never
 * returns a list without {@link MANDATORY_RECALL_SECTION} in it.
 *
 * An unknown entry is an error rather than a silent drop: a typo that quietly
 * removes a section is the same failure as omitting the section.
 */
export function withMandatoryCautions(
  raw: unknown,
): RecallSection[] | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return "invalid";
  const requested = new Set<RecallSection>();
  for (const entry of raw) {
    if (typeof entry !== "string") return "invalid";
    if (!(RECALL_SECTIONS as readonly string[]).includes(entry)) {
      return "invalid";
    }
    requested.add(entry as RecallSection);
  }
  requested.add(MANDATORY_RECALL_SECTION);
  return RECALL_SECTIONS.filter((section) => requested.has(section));
}

/** Note kinds the cloud accepts. Mirrors `CLIENT_NOTE_KINDS`. */
export const CLIENT_NOTE_KINDS = [
  "gotcha",
  "constraint",
  "environment",
  "preference",
  "rejected_solution",
] as const;
export type ClientNoteKind = (typeof CLIENT_NOTE_KINDS)[number];

/** The scope ladder. Mirrors `NOTE_SCOPE_LEVELS`. */
export const NOTE_SCOPE_LEVELS = ["general", "client", "end_customer"] as const;
export type NoteScopeLevel = (typeof NOTE_SCOPE_LEVELS)[number];

/** Where a note stands now. Mirrors `CLIENT_NOTE_OUTCOMES`. */
export const CLIENT_NOTE_OUTCOMES = [
  "open",
  "held",
  "resolved",
  "obsolete",
] as const;
export type ClientNoteOutcome = (typeof CLIENT_NOTE_OUTCOMES)[number];

/** Mirrors `AXIS_CAUSE_VALUES` in the cloud's `ticket/axes.ts`. */
export const AXIS_CAUSE_VALUES = [
  "code",
  "data",
  "infrastructure",
  "configuration",
  "client-environment",
  "intentional-change",
  "third-party",
  "unknown",
] as const;
export type AxisCause = (typeof AXIS_CAUSE_VALUES)[number];

/** Mirrors `AXIS_SYMPTOM_VALUES` in the cloud's `ticket/axes.ts`. */
export const AXIS_SYMPTOM_VALUES = [
  "crash",
  "wrong-data",
  "slow",
  "blocked-access",
  "missing-ui",
  "unknown",
] as const;
export type AxisSymptom = (typeof AXIS_SYMPTOM_VALUES)[number];

/** The kind whose write also flips the referenced memory row out of the
 *  precedents WHERE clause. */
export const NOTE_KIND_REJECTED_SOLUTION: ClientNoteKind = "rejected_solution";

export interface RecallIssueContextInput {
  projectId?: string;
  sessionId?: string;
  text?: string;
  source?: string;
  sourceRef?: string;
  bugSignatures?: string[];
  limit?: number;
  cautionsLimit?: number;
  endCustomer?: string;
  accountId?: string;
  axisLocation?: string;
  axisCause?: AxisCause;
  kinds?: ClientNoteKind[];
  /** Already normalised by {@link withMandatoryCautions}. */
  include?: RecallSection[];
}

/**
 * Ask the cloud all three questions in one call: is this a duplicate, has a
 * lookalike been fixed before, and what do we already know that will bite.
 *
 * Unlike the old recall helper this does NOT collapse a failure to `undefined`.
 * `cautions` has no offline analogue, so a failure that silently degraded to
 * the local path would hand the agent an answer with the warnings quietly
 * missing. The caller decides what to do with the reason.
 */
export async function recallIssueContextViaCloud(
  input: RecallIssueContextInput,
): Promise<LearningLoopResult<Record<string, unknown>>> {
  const auth = agentAuth();
  if (!auth) {
    return unconfigured(
      "Cloud issue context recall requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    );
  }
  const body: Record<string, unknown> = {};
  const copy = <K extends keyof RecallIssueContextInput>(key: K): void => {
    const value = input[key];
    if (value !== undefined) body[key as string] = value;
  };
  copy("projectId");
  copy("sessionId");
  copy("text");
  copy("source");
  copy("sourceRef");
  copy("bugSignatures");
  copy("limit");
  copy("cautionsLimit");
  copy("endCustomer");
  copy("accountId");
  copy("axisLocation");
  copy("axisCause");
  copy("kinds");
  // Belt and braces: whatever reached this function, cautions is in the ask.
  if (input.include !== undefined) {
    const sections = new Set<RecallSection>(input.include);
    sections.add(MANDATORY_RECALL_SECTION);
    body.include = RECALL_SECTIONS.filter((section) => sections.has(section));
  }
  try {
    const res = await fetch(`${auth.base}/api/memory/recall`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return await parseResponse<Record<string, unknown>>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}

export interface RecordClientNoteInput {
  projectId?: string;
  scopeLevel: NoteScopeLevel;
  endCustomer?: string;
  subjectKey: string;
  slug: string;
  kind: ClientNoteKind;
  body: string;
  outcome?: ClientNoteOutcome;
  axisLocation?: string;
  axisCause?: AxisCause;
  axisSymptom?: AxisSymptom;
  accountIds?: string[];
  /** Required for a `rejected_solution` note: the memory row being rejected. */
  subjectMemoryId?: string;
  /** Override for the near-match guard. Refused without `distinctBecause`. */
  confirmDistinct?: boolean;
  distinctBecause?: string;
}

/**
 * Record a client note, or amend one on an exact id collision.
 *
 * The interesting outcomes are NOT transport failures and must not be rendered
 * as such: `409 near_match` is the guard asking the caller to choose one of the
 * candidates it found, `409 cap_reached` means the active cap is full and a
 * note must be archived first, and `503 guard_unavailable` means the guard
 * could not run so the create was refused rather than let through unguarded.
 * Each arrives as `reason: "rejected"` with the cloud's own `code`, which the
 * MCP tool surfaces verbatim.
 */
export async function recordClientNoteViaCloud(
  input: RecordClientNoteInput,
): Promise<LearningLoopResult<Record<string, unknown>>> {
  const auth = agentAuth();
  if (!auth) {
    return unconfigured(
      "Recording a client note requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    );
  }
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) body[key] = value;
  }
  try {
    const res = await fetch(`${auth.base}/api/memory/notes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return await parseResponse<Record<string, unknown>>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}

export interface AmendClientNoteInput {
  id: string;
  amendment: string;
  outcome?: ClientNoteOutcome;
}

/**
 * Append an amendment to an existing note's sealed history, optionally flipping
 * its outcome. `body` is deliberately not amendable: replacing a note's text is
 * a separate act that archives the old text first, and it is not exposed here.
 */
export async function amendClientNoteViaCloud(
  input: AmendClientNoteInput,
): Promise<LearningLoopResult<Record<string, unknown>>> {
  const auth = agentAuth();
  if (!auth) {
    return unconfigured(
      "Amending a client note requires CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.",
    );
  }
  const body: Record<string, unknown> = { amendment: input.amendment };
  if (input.outcome !== undefined) body.outcome = input.outcome;
  try {
    const res = await fetch(
      `${auth.base}/api/memory/notes/${encodeURIComponent(input.id)}/amend`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    return await parseResponse<Record<string, unknown>>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}

/** One rejected fix, and why the agent rejected it. */
export interface RejectedMemory {
  memoryId: string;
  reason: string;
}

/** What happened to one rejection. `landed: false` is always accompanied by a
 *  machine `code` and a message, never by silence. */
export interface RejectedMemoryOutcome {
  memoryId: string;
  landed: boolean;
  noteId?: string;
  status?: string;
  code?: string;
  message?: string;
}

export const MAX_REJECTED_MEMORY_IDS = 20;

/**
 * Record each rejected fix as a `rejected_solution` note.
 *
 * There is no `rejectedMemoryIds` field on `POST /api/memory/resolve`, and
 * inventing one on the wire would have been the wrong shape: the rejection has
 * to flip `issue_memory.outcome_state` to `'rejected'` so the row leaves the
 * precedents WHERE clause, and the only endpoint that performs that flip — in
 * the same transaction as the note that explains it — is the notes route with
 * `kind: "rejected_solution"`. So a rejection is a note write, and this is
 * where the composition lives.
 *
 * `slug` and `subjectKey` are both derived from the rejected memory id, which
 * makes the note id deterministic per rejected fix: rejecting the same fix
 * twice AMENDS the first note rather than creating a second one.
 *
 * Every outcome is reported per id. A guard refusal on one rejection must not
 * hide the others, and must not be mistaken for the rejection having landed.
 */
export async function recordRejectedSolutionsViaCloud(
  rejected: readonly RejectedMemory[],
  context: { projectId?: string; endCustomer?: string },
): Promise<RejectedMemoryOutcome[]> {
  const outcomes: RejectedMemoryOutcome[] = [];
  for (const entry of rejected) {
    const result = await recordClientNoteViaCloud({
      projectId: context.projectId,
      // Client scope: the rejection is a fact about this client's codebase, not
      // a rule that spans every tenant we serve.
      scopeLevel: "client",
      endCustomer: context.endCustomer,
      subjectKey: `issue_memory:${entry.memoryId}`,
      slug: `rejected-fix-${entry.memoryId}`,
      kind: NOTE_KIND_REJECTED_SOLUTION,
      body: entry.reason,
      subjectMemoryId: entry.memoryId,
    });
    if (result.ok) {
      const id = result.data.id;
      const status = result.data.status;
      outcomes.push({
        memoryId: entry.memoryId,
        landed: true,
        noteId: typeof id === "string" ? id : undefined,
        status: typeof status === "string" ? status : undefined,
      });
      continue;
    }
    outcomes.push({
      memoryId: entry.memoryId,
      landed: false,
      code: result.reason === "rejected" ? result.code : result.reason,
      message: result.message,
    });
  }
  return outcomes;
}
