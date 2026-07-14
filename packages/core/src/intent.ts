import type { EvidenceItem, IntentSignal } from "./evidence";
import { tokenize } from "./tokenize";

/** Minimum shared tokens required to consider a commit as explaining an evidence item (weak path). */
const MIN_SHARED = 2;

/**
 * Structural/scaffolding path noise excluded from identity/path matching.
 * These are directory or framework words, not domain-identifying nouns.
 */
const STRUCTURAL_TOKENS = new Set([
  "src",
  "dist",
  "index",
  "node",
  "lib",
  "libs",
  "test",
  "tests",
  "app",
  "apps",
  "routes",
  "route",
  "api",
  "www",
  "http",
  "https",
  "com",
  "main",
  "packages",
  "pkg",
  "build",
]);

/** URL-path-like substrings within free text, e.g. "/api/checkout". */
const ROUTE_SEGMENT_PATTERN = /\/[a-z0-9_\-/]+/gi;

/** A commit range on a git host (e.g. a release tag pair). */
export interface GitHostRef {
  baseRef: string;
  headRef: string;
}

/** A single commit in a compared range, as reported by a git host. */
export interface CommitInfo {
  sha: string;
  message: string;
  pr?: string;
  files: string[];
}

/** Correlates behavior-change evidence to git-host commits. No network. */
export interface GitHostClient {
  /** Commits in (baseRef, headRef] that touch the repo. Implementations may prefilter. */
  listCommits(ref: GitHostRef): Promise<CommitInfo[]>;
}

function tokensForEvidence(item: EvidenceItem): Set<string> {
  const tokens = new Set<string>();
  const { ref, brief } = item;
  if (ref.sig) for (const t of tokenize(ref.sig)) tokens.add(t);
  if (ref.table) for (const t of tokenize(ref.table)) tokens.add(t);
  if (brief) for (const t of tokenize(brief)) tokens.add(t);
  return tokens;
}

function tokensForCommit(commit: CommitInfo): Set<string> {
  const tokens = new Set<string>();
  for (const file of commit.files) {
    for (const t of tokenize(file)) tokens.add(t);
  }
  for (const t of tokenize(commit.message)) tokens.add(t);
  return tokens;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count++;
  return count;
}

function withoutStructural(tokens: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const t of tokens) if (!STRUCTURAL_TOKENS.has(t)) result.add(t);
  return result;
}

/**
 * Domain-identity tokens for an evidence item: the table name (if any) and
 * any route/path segments parsed out of the free-text brief (e.g.
 * "/api/checkout" -> "checkout"), with structural/scaffolding words removed.
 */
function evidenceIdentityTokens(item: EvidenceItem): Set<string> {
  const tokens = new Set<string>();
  const { ref, brief } = item;
  if (ref.table) for (const t of tokenize(ref.table)) tokens.add(t);
  if (brief) {
    const matches = brief.match(ROUTE_SEGMENT_PATTERN) ?? [];
    for (const segment of matches) {
      for (const t of tokenize(segment)) tokens.add(t);
    }
  }
  return withoutStructural(tokens);
}

/**
 * Path-identity tokens for a commit: all tokens derived from its file
 * paths, with structural/scaffolding words removed.
 */
function commitPathTokens(commit: CommitInfo): Set<string> {
  const tokens = new Set<string>();
  for (const file of commit.files) {
    for (const t of tokenize(file)) tokens.add(t);
  }
  return withoutStructural(tokens);
}

/**
 * Pure correlation: an evidence item is "explained" when a commit in range
 * plausibly caused it, via either of two paths:
 *  - STRONG: an evidence identity token (table name or a brief's route
 *    segment, minus structural noise) appears among the commit's
 *    file-path tokens (minus structural noise). A single such match
 *    qualifies.
 *  - WEAK (fallback): total shared tokens across all evidence fields and
 *    all commit fields (message + file paths) is >= MIN_SHARED.
 * The best commit per evidence item is the one with the highest
 * (strong-match-count * 100 + weak-shared-count), ties broken by
 * lexicographically smallest sha. Deterministic, never throws. Returns
 * signals in the input evidence order.
 */
export function inferIntent(
  evidence: EvidenceItem[],
  commits: CommitInfo[],
): IntentSignal[] {
  const signals: IntentSignal[] = [];
  const commitTokens = commits.map((commit) => ({
    commit,
    tokens: tokensForCommit(commit),
    pathTokens: commitPathTokens(commit),
  }));

  for (const item of evidence) {
    const evidenceTokens = tokensForEvidence(item);
    const identityTokens = evidenceIdentityTokens(item);
    let best: { commit: CommitInfo; score: number } | undefined;

    for (const { commit, tokens, pathTokens } of commitTokens) {
      const strong = sharedCount(identityTokens, pathTokens);
      const weak = sharedCount(evidenceTokens, tokens);
      const qualifies = strong >= 1 || weak >= MIN_SHARED;
      if (!qualifies) continue;

      const score = strong * 100 + weak;
      if (
        !best ||
        score > best.score ||
        (score === best.score && commit.sha < best.commit.sha)
      ) {
        best = { commit, score };
      }
    }

    if (best) {
      signals.push({
        evidenceId: item.id,
        explainedByCommit: {
          sha: best.commit.sha,
          pr: best.commit.pr,
          message: best.commit.message,
        },
        prIntent: best.commit.message.split("\n")[0],
      });
    }
  }

  return signals;
}
