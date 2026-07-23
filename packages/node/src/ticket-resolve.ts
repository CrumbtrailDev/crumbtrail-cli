import {
  assembleBundle,
  inferIntent,
  type EvidenceGap,
  type EvidenceItem,
  type GitHostClient,
  type IntentSignal,
  type Located,
  type RankedBundle,
  type Symptom,
} from "crumbtrail-core";
import path from "node:path";
import { compareSessions } from "./compare";
import { defaultSessionStore } from "./session-store";
import type { EvidenceSource } from "./evidence-sources";
import { GitHubRestClient, GitHostError } from "./git-host/github-rest";
import {
  AMBIGUOUS_LOCATED_SESSION_GAP,
  gatherAdapterEvidence,
  locateEvidence,
  NO_LOCATED_SESSION_GAP,
} from "./locate-incident";
import { pullBundleByTicketViaCloud, type RecallStore } from "./recall";
import {
  ticketClientFromEnv,
  TicketError,
  type TicketConnector,
} from "./ticket/clients";
import type { TicketProvider } from "./ticket/normalize";
import { parseTicketUrl } from "./ticket/url";

// --- ticket-driven bundle production (one canonical pipeline) ---------------
//
// THE ticket → fusion.v1 RankedBundle producer for crumbtrail-node. It used to
// live inline inside McpServer.toolSolveContext; it is factored out here so the
// MCP `solveContext` tool, the MCP `resolveCapsule` tool and the CLI `capsule`
// command all drive the SAME pipeline (cloud pull short-circuit → ticket fetch
// and normalization → explicit baseline/current comparison → auto-locate +
// adapter phase → git-host intent inference → assembleBundle) instead of each
// re-deriving it.
//
// This module owns the pipeline only. Response shaping (token budgeting, MCP
// result envelopes, capsule compilation) stays with each surface, so moving the
// code here does not change any existing output: `solveContext` still emits the
// exact same fusion.v1 payload it emitted when the pipeline was inline.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Local session-artifact access. Absent when the caller reads sessions from a
 *  remote artifact store, which disables the local-disk comparison and
 *  auto-locate paths exactly as before. */
export interface LocalSessionAccess {
  resolveSessionDir(sessionId: string): Promise<string>;
  sessionExists(sessionDir: string): Promise<boolean>;
}

/** Session-id shape the local paths accept, mirroring the MCP read tools: no
 *  separators, so a resolved directory can never escape the sessions dir. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** Artifacts whose presence marks a directory as a real recorded session. */
const SESSION_MARKER_ARTIFACTS = [
  "manifest.json",
  "index.json",
  "meta.json",
  "candidates.jsonl",
  "events.ndjson",
  "events.ndjson.zst",
];

/**
 * Local session access over a sessions directory, for a surface with no MCP
 * read store of its own (the CLI). Resolution and existence go through the same
 * `defaultSessionStore` seam the filesystem MCP read store uses, so the CLI and
 * the MCP server see the same sessions.
 */
export function localSessionAccess(outputDir: string): LocalSessionAccess {
  return {
    resolveSessionDir: async (sessionId: string) =>
      SAFE_SESSION_ID.test(sessionId)
        ? defaultSessionStore.resolveSessionDir(sessionId, outputDir)
        : path.join(outputDir, "__invalid_session_id__"),
    sessionExists: async (sessionDir: string) =>
      SESSION_MARKER_ARTIFACTS.some(
        (name) => defaultSessionStore.statArtifact(sessionDir, name) !== undefined,
      ),
  };
}

/** Everything the pipeline needs from its host surface. Every seam the MCP
 *  server exposed for `solveContext` (ticket connector, git-host client,
 *  evidence sources) is preserved here so injected test doubles keep working. */
export interface TicketResolutionDeps {
  /** Recall store the auto-locate path ranks recorded sessions against. */
  recallStore: RecallStore;
  /** Evidence sources for the adapter phase. Omitted → built from env. */
  evidenceSources?: EvidenceSource[];
  /** Local session artifacts; omit for a remote artifact store. */
  localSessions?: LocalSessionAccess;
  /** Test seam: overrides how the ticket connector is constructed. */
  ticketConnectorFactory?: (provider: TicketProvider) => TicketConnector;
  /** Test seam: overrides how the git-host client is constructed. */
  gitHostClientFactory?: (gitHost: {
    owner: string;
    repo: string;
  }) => GitHostClient;
  /** Surface name used to prefix the pipeline's stderr fallback notes. */
  surface?: string;
}

/** The ticket the pipeline resolved against, once its provider and key are
 *  known. `url` is present only when the caller pasted a recognized link. */
export interface ResolvedTicketRef {
  provider: string;
  id: string;
  url?: string;
}

/**
 * What the pipeline produced.
 *
 * - `pulled`: a pre-assembled bundle a configured cloud deployment stored for
 *   this ticket, returned verbatim (the caller must not re-rank or re-shape it).
 * - `assembled`: a locally assembled fusion.v1 {@link RankedBundle}.
 * - `error`: an input/capability refusal the surface should report as an error.
 */
export type TicketResolution =
  | { kind: "error"; message: string }
  | {
      kind: "pulled";
      bundle: Record<string, unknown>;
      ticket?: ResolvedTicketRef;
    }
  | {
      kind: "assembled";
      bundle: RankedBundle;
      symptom: Symptom;
      ticket?: ResolvedTicketRef;
    };

/**
 * Resolve a ticket reference and/or described symptom to a fusion.v1
 * RankedBundle. This is the exact sequence `solveContext` ran inline, moved
 * verbatim: the ordering of the cloud pull short-circuit, the ticket fetch, the
 * remote-store refusal, the comparison path, the auto-locate + adapter phase,
 * the git-host intent inference and the gap assembly are unchanged, so a caller
 * that shapes the result the way `solveContext` did gets a byte-identical
 * payload.
 *
 * Never throws for an expected miss: an unrecognized ticket URL, a failed
 * ticket fetch, an inconclusive locate and a dead evidence source all degrade
 * to gaps on a deliverable bundle.
 */
export async function resolveTicketToBundle(
  args: Record<string, unknown>,
  deps: TicketResolutionDeps,
): Promise<TicketResolution> {
  const surface = deps.surface ?? "solveContext";
  const passedSymptom: Partial<Symptom> | undefined = isRecord(args.symptom)
    ? (args.symptom as unknown as Partial<Symptom>)
    : undefined;

  // The ticket arg is either a pasted URL string (recognized locally, zero
  // network) or the explicit { provider, ticketKey } object (`id` accepted as
  // a deprecated alias — contract decision #2). An unrecognized URL is an
  // honest miss (surfaced as a gap below), never a throw.
  let ticketArg: { provider?: string; id?: string } | undefined;
  let ticketUrlUnrecognized = false;
  if (typeof args.ticket === "string") {
    const resolved = parseTicketUrl(args.ticket);
    if (resolved) ticketArg = resolved;
    else ticketUrlUnrecognized = true;
  } else if (isRecord(args.ticket)) {
    ticketArg = {
      provider: stringField(args.ticket.provider),
      id: stringField(args.ticket.ticketKey) ?? stringField(args.ticket.id),
    };
  }

  // The ticket reference, surfaced to callers that link the resolved issue back
  // to its ticket (the capsule surfaces record it as an external ref). Derived
  // only from what the caller supplied — never fabricated.
  const ticketRef: ResolvedTicketRef | undefined =
    ticketArg?.provider && ticketArg.id
      ? {
          provider: ticketArg.provider,
          id: ticketArg.id,
          ...(typeof args.ticket === "string" ? { url: args.ticket } : {}),
        }
      : undefined;

  let symptom: Symptom | undefined = passedSymptom?.title
    ? (passedSymptom as Symptom)
    : undefined;
  const ticketGaps: {
    lane: "network";
    reason: string;
    suggestion?: string;
  }[] = [];

  // Cloud pull-path — BEFORE any local ticket-fetch/evidence/reproduction/
  // git-host logic. When the ticket resolves to a provider+id AND the cloud env
  // pair is configured, ask the cloud by-ticket endpoint for a pre-assembled
  // bundle. On a hit, return that stored bundle verbatim and short-circuit the
  // entire local pipeline. On any miss/failure/unconfigured env the helper
  // returns undefined and we fall through UNCHANGED to the local fetch +
  // auto-locate path — a deliberate always-fall-back design (mirrors
  // recallViaCloud): the pull is a fast path, never a hard dependency.
  if (ticketArg?.provider && ticketArg.id) {
    const pulled = await pullBundleByTicketViaCloud(
      ticketArg.provider,
      ticketArg.id,
    );
    if (pulled && isRecord(pulled.bundle)) {
      return {
        kind: "pulled",
        bundle: pulled.bundle,
        ...(ticketRef ? { ticket: ticketRef } : {}),
      };
    }
  }

  if (ticketArg?.provider && ticketArg.id) {
    try {
      const provider = ticketArg.provider as "jira" | "zendesk" | "trello";
      const connector: TicketConnector = deps.ticketConnectorFactory
        ? deps.ticketConnectorFactory(provider)
        : ticketClientFromEnv(provider);
      const fetched = await connector.fetchSymptom(ticketArg.id);
      // Passed symptom values win; fetched ticket fields fill gaps.
      symptom = { ...fetched, ...(passedSymptom ?? {}) } as Symptom;
    } catch (err) {
      const message =
        err instanceof TicketError
          ? `TicketError (status ${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      process.stderr.write(
        `${surface}: ticket fetch failed, falling back: ${message}\n`,
      );
      if (passedSymptom?.title) {
        symptom = passedSymptom as Symptom;
      } else {
        symptom = { title: ticketArg.id };
        ticketGaps.push({
          lane: "network",
          reason: `ticket fetch failed: ${message}`,
          suggestion: "check connector credentials",
        });
      }
    }
  } else if (ticketUrlUnrecognized && !symptom) {
    // A pasted ticket URL we could not recognize, with no symptom to fall back
    // on. Same honest-miss shape as a fetch failure: a minimal symptom (so the
    // pipeline proceeds) plus one gap explaining the miss — never a throw.
    symptom = { title: args.ticket as string };
    ticketGaps.push({
      lane: "network",
      reason: "ticket url not recognized",
      suggestion:
        "pass symptom.title or a supported jira/zendesk/trello ticket url",
    });
  }

  let noInputGiven = false;
  if (!symptom) {
    symptom = { title: "" };
    noInputGiven = true;
    ticketGaps.push({
      lane: "network",
      reason: "a symptom or ticket is required",
      suggestion: "pass symptom.title or ticket:{provider,id}",
    });
  }

  const baselineSession = stringField(args.baselineSession);
  const currentSession = stringField(args.currentSession);
  if (baselineSession && currentSession && !deps.localSessions) {
    return {
      kind: "error",
      message: `${surface} cannot compare baselineSession/currentSession with a remote artifact store; use getSessionManifest, getWindow, and getEvidence for each session without local-disk fallback.`,
    };
  }

  let evidence: EvidenceItem[] = [];
  let intent: IntentSignal[] = [];
  // The locate decision, when the auto-locate path runs — threaded onto the
  // bundle (RankedBundle.located) and folded into contextCompleteness. Stays
  // undefined for explicit baseline/current comparison bundles.
  let locatedDecision: Located | undefined;
  // Gaps declared by the adapter phase (unsupported keys, timeouts, byte caps).
  const adapterGaps: EvidenceGap[] = [];
  // True when a no-session locate produced a bundle populated PURELY from
  // adapter evidence (sessionless Mode A) — that bundle must still state that
  // no Crumbtrail session matched.
  let sessionlessAdapterBundle = false;

  if (baselineSession && currentSession && deps.localSessions) {
    const aDir = await deps.localSessions.resolveSessionDir(baselineSession);
    const bDir = await deps.localSessions.resolveSessionDir(currentSession);
    if (
      (await deps.localSessions.sessionExists(aDir)) &&
      (await deps.localSessions.sessionExists(bDir))
    ) {
      const comparison = await compareSessions(aDir, bDir);
      evidence = comparison.evidence;
      intent = comparison.intent;
    }
  }

  // Auto-locate: when the caller gave a ticket/symptom but NO explicit
  // baseline/current sessions, rank the recorded sessions against the symptom
  // and, on a confident match, populate evidence from the located session.
  // Placed BEFORE reproduction so "skip reproduction once evidence.length > 0"
  // naturally covers located evidence too. Never throws out of the tool; on an
  // inconclusive locate (or any failure) evidence stays [] and the existing
  // gaps-only path fires unchanged.
  if (
    !baselineSession &&
    !currentSession &&
    !noInputGiven &&
    deps.localSessions
  ) {
    try {
      // Shared locate → evidence slice (also used by the inner
      // /api/solve-context endpoint). On an inconclusive locate this returns
      // evidence: [] and the existing gaps-only path fires unchanged.
      const located = locateEvidence(symptom, deps.recallStore);
      evidence = located.evidence;
      // Expose the locate decision on the bundle (previously dropped here).
      // method "fuzzy": this is the scored locate engine; War-game 02's
      // deterministic token join sets "token" through the same field.
      locatedDecision = {
        outcome: located.match.outcome,
        confidence: located.match.confidence,
        method: "fuzzy",
        ...(located.match.sessionId
          ? { sessionId: located.match.sessionId }
          : {}),
        reasons: located.match.reasons,
        ...(located.match.outcome === "ambiguous" && located.match.candidates
          ? { candidates: located.match.candidates }
          : {}),
      };
      // Adapter phase: query the client's configured evidence sources for the
      // located window (matched) or a sessionless fallback window (Mode A) and
      // merge the neutral items ALONGSIDE session evidence — the single fusion
      // path ranks the mixed set. Never throws; ZERO sources → no-op, so this
      // block is byte-identical to before for a session-matched (or no-source)
      // request.
      const adapter = await gatherAdapterEvidence(symptom, located, {
        sources: deps.evidenceSources,
      });
      evidence = [...evidence, ...adapter.items];
      adapterGaps.push(...adapter.gaps);
      // A no-session locate whose bundle is populated purely from adapters must
      // still state that no Crumbtrail session matched (Mode A invariant).
      if (located.match.outcome !== "matched" && adapter.items.length > 0) {
        sessionlessAdapterBundle = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${surface}: incident location failed, falling back: ${message}\n`,
      );
    }
  }

  const gitHost = isRecord(args.gitHost)
    ? {
        owner: stringField(args.gitHost.owner),
        repo: stringField(args.gitHost.repo),
        baseRef: stringField(args.gitHost.baseRef),
        headRef: stringField(args.gitHost.headRef),
      }
    : undefined;
  const token = process.env.CRUMBTRAIL_GITHUB_TOKEN;

  if (
    gitHost &&
    gitHost.owner &&
    gitHost.repo &&
    gitHost.baseRef &&
    gitHost.headRef &&
    token &&
    evidence.length > 0
  ) {
    try {
      const client: GitHostClient = deps.gitHostClientFactory
        ? deps.gitHostClientFactory({
            owner: gitHost.owner,
            repo: gitHost.repo,
          })
        : new GitHubRestClient({
            owner: gitHost.owner,
            repo: gitHost.repo,
            token,
          });
      const commits = await client.listCommits({
        baseRef: gitHost.baseRef,
        headRef: gitHost.headRef,
      });
      intent = inferIntent(evidence, commits);
    } catch (err) {
      const message =
        err instanceof GitHostError
          ? `GitHostError (status ${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      process.stderr.write(
        `${surface}: git-host intent-inference failed, falling back to existing intent: ${message}\n`,
      );
    }
  }

  const gaps = [
    ...ticketGaps,
    ...(locatedDecision?.outcome === "ambiguous"
      ? [AMBIGUOUS_LOCATED_SESSION_GAP]
      : []),
    // Adapter-only (sessionless Mode A) bundle: state that no Crumbtrail session
    // matched even though the bundle is populated from evidence sources.
    ...(sessionlessAdapterBundle ? [NO_LOCATED_SESSION_GAP] : []),
    ...adapterGaps,
    ...(evidence.length === 0 && !noInputGiven
      ? [
          {
            // Unified with NO_LOCATED_SESSION_GAP so every no-match outcome
            // (auto-locate miss, comparison miss, sessionless) reads the same
            // "no recorded session matched this symptom" wording — the old
            // "compared" vs "matched" split confused readers about whether a
            // comparison had even run.
            lane: NO_LOCATED_SESSION_GAP.lane,
            reason: NO_LOCATED_SESSION_GAP.reason,
            suggestion: NO_LOCATED_SESSION_GAP.suggestion,
          },
        ]
      : []),
  ];

  const bundle = assembleBundle({
    symptom,
    evidence,
    intent,
    gaps,
    located: locatedDecision,
  });
  return {
    kind: "assembled",
    bundle,
    symptom,
    ...(ticketRef ? { ticket: ticketRef } : {}),
  };
}

/**
 * True when a record retrieved from a cloud deployment is a usable fusion.v1
 * RankedBundle. Narrow on purpose: only `schemaVersion`, `symptom` and the
 * ranked `evidence` array are load-bearing for downstream compilation, and a
 * stored payload that fails this check is reported honestly rather than
 * coerced.
 */
export function isFusionBundleRecord(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RankedBundle {
  return (
    value.schemaVersion === "fusion.v1" &&
    isRecord(value.symptom) &&
    Array.isArray(value.evidence)
  );
}
