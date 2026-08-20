// --- Live probe plane + shadow back test cloud client -----------------------
//
// Two agent-plane calls the MCP server makes against a configured Crumbtrail
// cloud deployment:
//
//   requestProbeViaCloud    -> POST /api/agent/probe            (agent-token auth)
//   shadowBacktestViaCloud  -> GET  /api/agent/shadow-backtest  (agent-token auth)
//
// They authenticate exactly like the learning-loop and fix-verification calls in
// `learning-loop.ts`, through the shared seam in `cloud-auth.ts`: an agent token
// supplied per call by a hosted dispatcher, or `CRUMBTRAIL_CLOUD_TOKEN` against
// `CRUMBTRAIL_CLOUD_URL` when none was. The project API key (`ctkey_`) is
// ingest-only and the cloud refuses it on both of these routes.
//
// Using the shared resolver also brings these two calls under the https rule the
// learning-loop calls already had: their own copy of the env read did not check
// the base, so an agent token could be put on the wire in cleartext by pointing
// CRUMBTRAIL_CLOUD_URL at a plain http host.
//
// Neither call has a local analogue — there is no offline way to ask a running
// application a question, and no offline copy of a project's history to replay —
// so each returns the same discriminated `LearningLoopResult` the verification
// calls return, and the MCP tool tells the agent WHY nothing came back rather
// than flattening a refusal into an empty answer.

import { PROBE_NAMES, isProbeName, type ProbeName } from "crumbtrail-core";
import { cloudAuthGap, resolveCloudAuth } from "./cloud-auth";
import type { CloudCredentials } from "./cloud-auth";
import type { LearningLoopResult } from "./learning-loop";

export { PROBE_NAMES, isProbeName, type ProbeName };

/** Deliberately generic so a thrown error cannot leak the cloud URL or token. */
const TRANSPORT_MESSAGE =
  "The request to the Crumbtrail cloud failed to complete.";

/** Parse a cloud response. On a non-2xx the cloud answers `{ error, code, ... }`
 *  (http.ts `jsonError`); both are surfaced so the tool can name the refusal.
 *  Never echoes the request URL or headers. */
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

const PROBE_UNCONFIGURED = "Live probes require";
const BACKTEST_UNCONFIGURED = "The shadow back test requires";

/**
 * One queued probe row, exactly the `queued` object
 * `packages/cloud/src/routes/agent-probe-routes.ts` answers 202 with (shape from
 * `QueuedProbeRequest` in `packages/cloud/src/probe-queue.ts`).
 *
 * `expiresAt` is load bearing: a request that is not collected by a config poll
 * before then is never delivered, so a queued probe is a request on record and
 * not a promise of a reading.
 */
export interface QueuedProbe {
  probeName: ProbeName;
  requestedAt: string;
  expiresAt: string;
}

export interface RequestProbeResponse {
  queued: QueuedProbe;
}

/**
 * Queue one named probe for a project's running SDK to run on its next config
 * poll.
 *
 * The route is idempotent by `(tenant, project, probe)`: asking twice re-arms
 * one row rather than queueing two. It answers 202, never 200, because nothing
 * has run at the moment it returns.
 */
export async function requestProbeViaCloud(
  input: {
    projectId: string;
    probeName: ProbeName;
  },
  credentials?: CloudCredentials,
): Promise<LearningLoopResult<RequestProbeResponse>> {
  const auth = resolveCloudAuth(credentials);
  if (!auth) {
    return {
      ok: false,
      reason: "unconfigured",
      message: cloudAuthGap(PROBE_UNCONFIGURED, credentials),
    };
  }
  try {
    const res = await fetch(`${auth.base}/api/agent/probe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project: input.projectId,
        probe: input.probeName,
      }),
    });
    return await parseResponse<RequestProbeResponse>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}

/** Bounds the cloud's `parseBacktestDays` enforces (shadow-backtest.ts). An out
 *  of bounds value is REFUSED there, never clamped, so it is refused here too. */
export const BACKTEST_MIN_DAYS = 1;
export const BACKTEST_MAX_DAYS = 90;
/** Window the cloud uses when the caller names none. */
export const DEFAULT_BACKTEST_DAYS = 14;

/** Rule names from the project's current code fix thresholds. */
export type BacktestRuleName =
  | "min_confidence"
  | "real_issue"
  | "severity_at_least"
  | "max_diff_lines"
  | "max_open_prs";

export interface BacktestRuleUndecidable {
  rule: BacktestRuleName;
  reason: string;
}

/**
 * Whether one replayed detection would clear the project's thresholds.
 *
 * `clears` covers only the rules a historical detection carries the evidence to
 * decide. A rule in `undecidable` is neither a pass nor a failure, and the MCP
 * tool passes both lists through verbatim so the distinction survives.
 */
export interface BacktestThresholdVerdict {
  clears: boolean;
  failedRules: BacktestRuleName[];
  undecidable: BacktestRuleUndecidable[];
}

export interface ShadowBacktestCandidate {
  detector: string;
  stableSignature: string;
  title: string;
  confidence: number;
  explanation: string;
  evidence: Record<string, unknown>;
  /** The canonical issue the detection resolves to, or null if it is gone. */
  canonicalIssueId: string | null;
  /** True when the forward runtime already recorded this candidate. */
  alreadyProposed: boolean;
  thresholds: BacktestThresholdVerdict;
}

/** The 200 body of `GET /api/agent/shadow-backtest`, from
 *  `ShadowBacktestReport` in `packages/cloud/src/shadow-backtest.ts`. */
export interface ShadowBacktestReport {
  projectId: string;
  days: number;
  windowStart: string;
  windowEnd: string;
  autonomy: {
    level: string;
    requested: string;
    source: string;
    clamped: boolean;
    /** True when the level already clears `alert`, so a live tick would propose. */
    wouldPropose: boolean;
  };
  rules: Record<string, unknown>;
  totalDetections: number;
  truncated: boolean;
  candidates: ShadowBacktestCandidate[];
}

/**
 * Replay the shadow detectors over a bounded window of one project's history and
 * report what they WOULD have proposed. The route writes no detection state.
 */
export async function shadowBacktestViaCloud(
  input: {
    projectId: string;
    days?: number;
  },
  credentials?: CloudCredentials,
): Promise<LearningLoopResult<ShadowBacktestReport>> {
  const auth = resolveCloudAuth(credentials);
  if (!auth) {
    return {
      ok: false,
      reason: "unconfigured",
      message: cloudAuthGap(BACKTEST_UNCONFIGURED, credentials),
    };
  }
  const params = new URLSearchParams({ project: input.projectId });
  if (input.days !== undefined) params.set("days", String(input.days));
  try {
    const res = await fetch(
      `${auth.base}/api/agent/shadow-backtest?${params.toString()}`,
      { headers: { Authorization: `Bearer ${auth.token}` } },
    );
    return await parseResponse<ShadowBacktestReport>(res);
  } catch {
    return { ok: false, reason: "transport", message: TRANSPORT_MESSAGE };
  }
}
