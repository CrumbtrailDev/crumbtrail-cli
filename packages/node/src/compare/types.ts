import type { BugEvent, DbDiffOp, DbEngine } from "crumbtrail-core";
import type { EvidenceItem, IntentSignal } from "crumbtrail-core";

export const SESSION_COMPARE_SCHEMA_VERSION = "session-compare.v1" as const;

export type ComparisonVerdict = "regression" | "clean";
export type ComparisonConfidence = "high" | "medium" | "low";

export interface SessionComparison {
  schemaVersion: typeof SESSION_COMPARE_SCHEMA_VERSION;
  verdict: ComparisonVerdict;
  confidence: ComparisonConfidence;
  a: SessionRef;
  b: SessionRef;
  alignment: { matchedSteps: number; unmatchedA: number; unmatchedB: number };
  divergences: Divergence[];
  noise: { suppressedCount: number; rules: string[] };
  /** Neutral, complete projection of divergences. Consumed by cloud fusion. */
  evidence: EvidenceItem[];
  /** Intent inference. Empty until the git-host connector (slice 2) lands. */
  intent: IntentSignal[];
  /**
   * Structured environment/flag/config/release/build delta between A and B —
   * the "works in QA, fails in prod, here is the config delta" channel. Present
   * only when the env plane diverges (mirrors the single `env.snapshot`
   * divergence). Additive: existing consumers that ignore it are unaffected.
   */
  envDelta?: EnvDiff;
}

/** One environment key that was added, removed, or changed between two sessions. */
export interface EnvValueChange {
  key: string;
  /** Value in session A. Omitted for keys added in B. */
  before?: unknown;
  /** Value in session B. Omitted for keys removed in B. */
  after?: unknown;
}

/** Added/removed/changed breakdown for one env channel (flags or config). */
export interface EnvChannelDelta {
  added: EnvValueChange[];
  removed: EnvValueChange[];
  changed: EnvValueChange[];
}

/**
 * A clear added/removed/changed delta of the declared environment between two
 * sessions: feature flags, config, and the release/build labels. Only the keys
 * the noise model treats as real signal appear here (timestamp/uuid churn is
 * suppressed exactly as in the divergence channel).
 */
export interface EnvDiff {
  flags: EnvChannelDelta;
  config: EnvChannelDelta;
  /** Present only when the release label differs between A and B. */
  release?: { before?: string; after?: string };
  /** Present only when the build/commit label differs between A and B. */
  build?: { before?: string; after?: string };
}

export interface SessionRef {
  sessionId: string;
  release?: string;
  build?: string;
}

export interface Divergence {
  plane: "flow" | "network" | "db" | "env";
  kind: string;
  sig?: string;
  requestId?: string;
  table?: string;
  pk?: Record<string, unknown>;
  before: unknown;
  after: unknown;
  brief: string;
  /**
   * Structured added/removed/changed breakdown, attached to the env-plane
   * `env.snapshot` divergence. Lets consumers render the config delta without
   * re-diffing the opaque before/after blobs. Undefined on all other planes.
   */
  envDelta?: EnvDiff;
}

export interface CompareOptions {
  alignmentWindow?: number;
  disableNoiseRules?: string[];
}

export interface FlowStep {
  idx: number;
  t: number;
  kind: "clk" | "inp" | "nav";
  sig: string;
  label?: string;
}

export interface NetworkCall {
  t: number;
  method: string;
  route: string;
  status?: number;
  durMs?: number;
  requestId?: string;
  anchorSig?: string;
  responseHeaders?: Record<string, string>;
  body?: unknown;
}

export interface DbWrite {
  t: number;
  /**
   * DB dialect the write ran against. Normalized on extraction (missing/unknown → `"postgres"`,
   * the only engine that ever emitted historically) so it is never undefined, and folded into the
   * comparator's dbKey so two engines writing a same-named table never collide.
   */
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  pk: Record<string, unknown> | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  requestId: string;
  anchorSig?: string;
}

export interface ComparableSession {
  sessionId: string;
  dir: string;
  events: BugEvent[];
  steps: FlowStep[];
  network: NetworkCall[];
  dbWrites: DbWrite[];
  environment: Record<string, unknown>;
  release?: string;
  build?: string;
}
