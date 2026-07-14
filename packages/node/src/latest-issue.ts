import { defaultSessionStore } from "./session-store";

/**
 * Shared "latest issue" resolver behind BOTH the `getLatestIssue` MCP tool and
 * the `fix-context --latest` CLI flag, so the two surfaces always agree on
 * which session "the latest issue" means.
 *
 * Pinned definition (mirrored by latest-issue.test.ts):
 * - Scan every session under `outputDir` via the storage seam
 *   (`defaultSessionStore.listSessions`).
 * - A session QUALIFIES iff its `index.json` exists (index.json presence IS the
 *   finalize signal) AND it carries error-class evidence: `index.errs`
 *   non-empty, OR `index.failedReqs` non-empty, OR any `candidates.jsonl` row
 *   with severity `"critical"` or `"high"`.
 * - RECENCY is `index.end`, falling back to `index.start`, then `meta.start`,
 *   then 0. Remaining ties break by session id descending, then session dir
 *   descending (plain code-unit comparison — never locale-dependent).
 * - Deterministic and hot-plane only: reads index.json, candidates.jsonl and
 *   meta.json — NEVER the cold event stream (events.ndjson / events.ndjson.zst).
 */
export interface LatestIssue {
  sessionId: string;
  dir: string;
}

export function resolveLatestIssue(opts: {
  outputDir: string;
}): LatestIssue | undefined {
  let best: { sessionId: string; dir: string; recency: number } | undefined;

  for (const { id, dir } of defaultSessionStore.listSessions(opts.outputDir)) {
    const index = readJsonRecord(dir, "index.json");
    if (!index) continue; // not finalized
    if (!hasErrorClassEvidence(dir, index)) continue;

    const recency = recencyOf(dir, index);
    if (!best || beats({ sessionId: id, dir, recency }, best)) {
      best = { sessionId: id, dir, recency };
    }
  }

  return best ? { sessionId: best.sessionId, dir: best.dir } : undefined;
}

function beats(
  candidate: { sessionId: string; dir: string; recency: number },
  incumbent: { sessionId: string; dir: string; recency: number },
): boolean {
  if (candidate.recency !== incumbent.recency)
    return candidate.recency > incumbent.recency;
  if (candidate.sessionId !== incumbent.sessionId)
    return candidate.sessionId > incumbent.sessionId;
  return candidate.dir > incumbent.dir;
}

function hasErrorClassEvidence(
  dir: string,
  index: Record<string, unknown>,
): boolean {
  if (Array.isArray(index.errs) && index.errs.length > 0) return true;
  if (Array.isArray(index.failedReqs) && index.failedReqs.length > 0)
    return true;
  return candidateSeverities(dir).some(
    (severity) => severity === "critical" || severity === "high",
  );
}

function recencyOf(dir: string, index: Record<string, unknown>): number {
  const end = finiteNumber(index.end);
  if (end !== undefined) return end;
  const start = finiteNumber(index.start);
  if (start !== undefined) return start;
  const meta = readJsonRecord(dir, "meta.json");
  return finiteNumber(meta?.start) ?? 0;
}

/** Severities of the ranked candidates.jsonl rows (hot plane), rank order. */
function candidateSeverities(dir: string): string[] {
  const buf = defaultSessionStore.readArtifact(dir, "candidates.jsonl");
  if (!buf) return [];
  const severities: string[] = [];
  for (const line of buf.toString("utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).severity === "string"
      ) {
        severities.push((parsed as Record<string, unknown>).severity as string);
      }
    } catch {
      // candidates.jsonl is written deterministically; skip malformed lines defensively.
    }
  }
  return severities;
}

function readJsonRecord(
  dir: string,
  name: string,
): Record<string, unknown> | undefined {
  try {
    const buf = defaultSessionStore.readArtifact(dir, name);
    if (!buf) return undefined;
    const parsed: unknown = JSON.parse(buf.toString("utf-8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
