import path from "node:path";
import { buildDistinctBugSignature, type DistinctBug } from "./distinct-bugs";
import {
  defaultSessionStore,
  normalizePartitionSegment,
} from "./session-store";

// --- Local issue recall ("have we seen this before?") ---------------------
// A dependency-free, offline analogue of the cloud hybrid recall: text overlap
// stands in for the vector term, combined with the same structured boosts.
// score = 0.6·text-overlap + 0.2·same-route + 0.1·same-error-family + 0.1·env-overlap
//
// This module is the recall/similarity engine, extracted from the MCP server so
// it can be exercised without a JSON-RPC transport. Storage access is injected
// through a small `RecallStore` seam rather than reaching into the server class.

/**
 * The partition a caller is entitled to see.
 *
 * A hosted deployment stores every tenant's sessions under one sessions
 * directory, partitioned as `{sessionsDir}/{tenant}/{app}/{date}/{id}`. A
 * caller acting for one tenant may only ever be shown that tenant's subtree, so
 * a scope is a NARROWING and never a hint: a store that is handed one and
 * cannot honour it must answer with no sessions at all rather than with a wider
 * set. Answering wider is how a ticket in one tenant gets matched to another
 * tenant's recorded session.
 *
 * `projectId` is the application segment (`meta.app`) inside the tenant. It is
 * optional because a tenant-wide locate is a real case; `tenantId` is not,
 * because a project id is unique only within its tenant and a project-only
 * narrowing would have to span every tenant to be evaluated.
 */
export interface RecallScope {
  tenantId: string;
  projectId?: string;
}

/**
 * Storage seam the recall engine depends on. The MCP server satisfies this by
 * delegating to its session store + JSON readers; tests can supply an in-memory
 * fake to exercise ranking/dedup/limit without any real MCP server or files.
 */
export interface RecallStore {
  /**
   * Every session the caller may see. With a {@link RecallScope} the result
   * MUST be confined to that partition — see the type for why an implementation
   * that cannot confine it returns nothing instead of everything. Omitting the
   * scope means the whole store, which is the self-hosted single-tenant model
   * where the store root IS the boundary.
   */
  listSessions(
    scope?: RecallScope,
  ): Promise<Array<{ id: string; dir: string }>>;
  readJsonRecord(
    dir: string,
    name: string,
  ): Promise<Record<string, unknown> | undefined>;
  readDistinctBugs(dir: string): Promise<unknown[]>;
  /** Pure structural guard — no IO, so it stays synchronous. */
  isDistinctBugRecord(x: unknown): boolean;
}

export interface LocalIssueProfile {
  tokens: string[];
  route?: string;
  errorFamily?: string;
  facetTokens: string[];
}

// Minimal private copies of the shared record helpers (kept private in
// mcp-server.ts). Duplicated here to keep the engine dependency-free.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

export function tokenizeIssueText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[redacted\]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && token.length < 40);
}

export function jaccardTokens(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function scoreLocalIssue(
  query: LocalIssueProfile,
  candidate: LocalIssueProfile,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const textSim = jaccardTokens(query.tokens, candidate.tokens);
  if (textSim >= 0.3) reasons.push("semantic");
  let sameRoute = 0;
  if (
    query.route &&
    candidate.route &&
    query.route.trim().toLowerCase() === candidate.route.trim().toLowerCase()
  ) {
    sameRoute = 1;
    reasons.push("same-route");
  }
  let sameError = 0;
  if (
    query.errorFamily &&
    candidate.errorFamily &&
    query.errorFamily === candidate.errorFamily
  ) {
    sameError = 1;
    reasons.push("same-error");
  }
  const envOverlap = jaccardTokens(query.facetTokens, candidate.facetTokens);
  if (envOverlap > 0) reasons.push("env-overlap");
  const score =
    0.6 * textSim + 0.2 * sameRoute + 0.1 * sameError + 0.1 * envOverlap;
  return { score, reasons };
}

export function strongestBug(bugs: DistinctBug[]): DistinctBug {
  const rank: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return [...bugs].sort(
    (a, b) =>
      (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0) ||
      a.firstSeen - b.firstSeen,
  )[0];
}

export function bugProfile(
  bug: DistinctBug,
  bundle: Record<string, unknown>,
): LocalIssueProfile {
  const rep = bug.representative ?? ({} as DistinctBug["representative"]);
  const tokens = tokenizeIssueText(
    [bug.title, rep.detector, rep.message, rep.route]
      .filter((v): v is string => Boolean(v))
      .join(" "),
  );
  const env = isRecord(bundle.environment) ? bundle.environment : {};
  const flagKeys = isRecord(env.flags) ? Object.keys(env.flags) : [];
  const configKeys = isRecord(env.config) ? Object.keys(env.config) : [];
  const requestIds = new Set(bug.requestIds ?? []);
  const dbTables = Array.isArray(bundle.databaseDiffs)
    ? bundle.databaseDiffs
        .filter(isRecord)
        .filter(
          (diff) =>
            typeof diff.requestId !== "string" ||
            requestIds.has(diff.requestId),
        )
        .map((diff) => stringField(diff.table))
        .filter((table): table is string => Boolean(table))
    : [];
  return {
    tokens,
    route: rep.route,
    errorFamily: rep.detector,
    facetTokens: [...flagKeys, ...configKeys, ...dbTables],
  };
}

/** Build a recall query profile from a session's strongest distinct bug. */
export async function sessionIssueProfile(
  dir: string,
  store: RecallStore,
): Promise<LocalIssueProfile | undefined> {
  const bugs = (await store.readDistinctBugs(dir)).filter((bug) =>
    store.isDistinctBugRecord(bug),
  ) as unknown as DistinctBug[];
  if (bugs.length === 0) return undefined;
  const seed = strongestBug(bugs);
  const bundle =
    (await store.readJsonRecord(dir, "llm.json")) ??
    (await store.readJsonRecord(dir, "bundle.json")) ??
    {};
  return bugProfile(seed, bundle);
}

/** Scan the local session store and rank every distinct bug against the query. */
export async function recallLocal(
  query: LocalIssueProfile,
  store: RecallStore,
  excludeSessionId: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const scored: Array<{
    score: number;
    reasons: string[];
    signature: string | undefined;
    match: Record<string, unknown>;
  }> = [];
  for (const { id, dir } of await store.listSessions()) {
    if (excludeSessionId && id === excludeSessionId) continue;
    const bundle =
      (await store.readJsonRecord(dir, "llm.json")) ??
      (await store.readJsonRecord(dir, "bundle.json")) ??
      {};
    for (const raw of await store.readDistinctBugs(dir)) {
      if (!store.isDistinctBugRecord(raw)) continue;
      const bug = raw as unknown as DistinctBug;
      const candidate = bugProfile(bug, bundle);
      const { score, reasons } = scoreLocalIssue(query, candidate);
      if (score <= 0) continue;
      scored.push({
        score,
        reasons,
        signature: buildDistinctBugSignature(bug),
        match: removeUndefined({
          sessionId: id,
          bugId: bug.bugId,
          signature: buildDistinctBugSignature(bug),
          title: bug.title,
          route: bug.representative?.route,
          errorFamily: bug.representative?.detector,
          severity: bug.severity,
          score: Math.round(score * 1000) / 1000,
          reasons,
        }),
      });
    }
  }
  // Dedupe by signature, keeping the highest-scoring occurrence.
  const bySignature = new Map<string, (typeof scored)[number]>();
  const unkeyed: (typeof scored)[number][] = [];
  for (const entry of scored) {
    if (!entry.signature) {
      unkeyed.push(entry);
      continue;
    }
    const existing = bySignature.get(entry.signature);
    if (!existing || entry.score > existing.score)
      bySignature.set(entry.signature, entry);
  }
  return [...bySignature.values(), ...unkeyed]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.match);
}

// --- Storage-plane readers (extracted verbatim from McpServer) -------------
//
// These three helpers were private-but-stateless methods on McpServer. They are
// extracted here — the home of the RecallStore seam — so both the MCP tool
// (via McpServer, which now delegates to them) and the inner HTTP endpoint (via
// buildRecallStore) share ONE implementation. Behavior is byte-identical to the
// original private methods.

/** Read + JSON-parse a single named artifact from a session dir, or undefined
 *  when it is absent or not a JSON object. Never throws. */
export async function readSessionJsonRecord(
  dir: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const buf = await defaultSessionStore.readArtifact(dir, name);
    if (!buf) return undefined;
    const parsed: unknown = JSON.parse(buf.toString("utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Read the grouped distinct bugs from a session's finalized hot-plane bundle
 *  (llm.json, else bundle.json). Returns [] when absent. */
export async function readSessionDistinctBugs(
  dir: string,
): Promise<Record<string, unknown>[]> {
  const bundle =
    (await readSessionJsonRecord(dir, "llm.json")) ??
    (await readSessionJsonRecord(dir, "bundle.json"));
  return Array.isArray(bundle?.distinctBugs)
    ? bundle!.distinctBugs.filter(isRecord)
    : [];
}

/** Structural guard: is `bug` a fully-formed distinct-bug record? */
export function isDistinctBugRecord(bug: unknown): bug is DistinctBug {
  if (!isRecord(bug)) return false;
  return (
    typeof bug.bugId === "string" &&
    typeof bug.title === "string" &&
    typeof bug.severity === "string" &&
    typeof bug.firstSeen === "number" &&
    typeof bug.lastSeen === "number" &&
    isRecord(bug.representative)
  );
}

/**
 * Resolve the directory a scoped listing may walk, or `undefined` when the scope
 * names no reachable partition.
 *
 * The narrowing is the ROOT, not a filter applied afterwards: an out-of-scope
 * session is never enumerated, so it can never be scored, ranked or returned.
 * Segment names are derived with the same normalisation the finalizer used to
 * write them, and a tenant or project id that does not normalise to a usable
 * segment resolves to `undefined` — no candidates — rather than widening to the
 * store root.
 */
function scopedSessionsRoot(
  outputDir: string,
  scope: RecallScope | undefined,
): string | undefined {
  if (!scope) return outputDir;
  const tenant = normalizePartitionSegment(scope.tenantId);
  if (!tenant) return undefined;
  if (scope.projectId === undefined) return path.join(outputDir, tenant);
  const project = normalizePartitionSegment(scope.projectId);
  if (!project) return undefined;
  return path.join(outputDir, tenant, project);
}

/** Build a RecallStore rooted at `outputDir` from the shared storage readers.
 *  Identical to the store McpServer.recallStore() constructs, so the MCP tool
 *  and the inner /api/solve-context endpoint locate against the same data. */
export function buildRecallStore(outputDir: string): RecallStore {
  return {
    listSessions: (scope) => {
      const root = scopedSessionsRoot(outputDir, scope);
      if (root === undefined) return Promise.resolve([]);
      return defaultSessionStore.listSessions(root);
    },
    readJsonRecord: (dir, name) => readSessionJsonRecord(dir, name),
    readDistinctBugs: (dir) => readSessionDistinctBugs(dir),
    isDistinctBugRecord: (x) => isDistinctBugRecord(x),
  };
}

/**
 * Local exact-duplicate lookup: distinct bugs in the session store whose
 * signature is one of `signatures`.
 *
 * Exact only, deliberately. The cloud's `duplicates` section is signature or
 * `(source, sourceRef)` equality with no threshold and no closest-match
 * fallback, and the local analogue keeps that contract: a near miss is a
 * precedent, never a duplicate. `recallLocal` is the fuzzy path and stays where
 * it is.
 */
export async function recallLocalDuplicates(
  store: RecallStore,
  signatures: readonly string[],
  limit: number,
): Promise<Record<string, unknown>[]> {
  const wanted = new Set(signatures.filter(Boolean));
  if (wanted.size === 0) return [];
  const seen = new Set<string>();
  const matches: Record<string, unknown>[] = [];
  for (const { id, dir } of await store.listSessions()) {
    for (const raw of await store.readDistinctBugs(dir)) {
      if (!store.isDistinctBugRecord(raw)) continue;
      const bug = raw as unknown as DistinctBug;
      const signature = buildDistinctBugSignature(bug);
      if (!signature || !wanted.has(signature) || seen.has(signature)) continue;
      seen.add(signature);
      matches.push(
        removeUndefined({
          sessionId: id,
          bugId: bug.bugId,
          signature,
          title: bug.title,
          route: bug.representative?.route,
          errorFamily: bug.representative?.detector,
          severity: bug.severity,
          // How the equality was established. Never a score: this section has
          // none.
          via: "signature",
        }),
      );
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}
