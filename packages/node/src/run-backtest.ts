import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCliConfig } from "./config";
import { reanalyzeSession } from "./post-process";
import {
  findFinalizedSessionDirs,
  resolveSessionTarget,
} from "./run-reanalyze";

/** One flagged candidate, reduced to what a reader needs to act on it. */
export interface BacktestCandidateRef {
  detector: string;
  title: string;
  severity: string;
  /** The identity this diff joined on. Exposed so a surprising diff is explainable. */
  key: string;
}

export interface BacktestReport {
  sessionId: string;
  sessionDir: string;
  status: "compared" | "skipped" | "failed";
  /** Flagged by the current analyzer, absent from the stored artifacts. */
  would_newly_flag?: BacktestCandidateRef[];
  /** Present in the stored artifacts, no longer flagged by the current analyzer. */
  would_stop_flagging?: BacktestCandidateRef[];
  /** Candidates both sides agree on. */
  unchanged?: number;
  reason?: string;
}

interface BacktestTotals {
  sessions: number;
  compared: number;
  skipped: number;
  failed: number;
  would_newly_flag: number;
  would_stop_flagging: number;
  unchanged: number;
}

export interface BacktestOutput {
  sessions: BacktestReport[];
  totals: BacktestTotals;
}

/**
 * `crumbtrail-server backtest <session|--all>` — replay stored sessions through
 * the current analyzer and report what it WOULD flag, changing nothing on disk.
 *
 * `reanalyze` answers the same replay question but overwrites the stored
 * artifacts in place, so it cannot tell an operator what an analyzer change
 * would do before they accept it. This copies each session's artifacts into a
 * temp directory, replays there, and diffs the produced `candidates.jsonl`
 * against the stored one. The session directory is only ever read.
 */
export async function runBacktest(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const all = rest.includes("--all");
  const outputIdx = rest.indexOf("--output");
  const outputDir =
    outputIdx >= 0 && rest[outputIdx + 1]
      ? rest[outputIdx + 1]
      : defaultCliConfig().output;
  const target = rest.find(
    (arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--output",
  );

  if (!all && !target) {
    process.stderr.write(
      "crumbtrail-server backtest: a session id or directory is required (or --all).\n",
    );
    return 1;
  }
  if (all && target) {
    process.stderr.write(
      "crumbtrail-server backtest: pass a session or --all, not both.\n",
    );
    return 1;
  }

  const sessionDirs = all
    ? findFinalizedSessionDirs(outputDir)
    : [resolveSessionTarget(target as string, outputDir)];

  if (sessionDirs.length === 0) {
    process.stderr.write(
      `crumbtrail-server backtest: no finalized sessions found under ${outputDir}.\n`,
    );
    return 1;
  }

  const sessions: BacktestReport[] = [];
  for (const sessionDir of sessionDirs) {
    sessions.push(await backtestOne(sessionDir));
  }
  const output: BacktestOutput = { sessions, totals: totalsOf(sessions) };

  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatOutput(output)}\n`);
  }
  // A failure to replay one session fails the run, so a corpus sweep never
  // reports a clean diff over sessions it could not actually read.
  return sessions.some((report) => report.status === "failed") ? 1 : 0;
}

async function backtestOne(sessionDir: string): Promise<BacktestReport> {
  const sessionId = path.basename(sessionDir);
  if (!fs.existsSync(path.join(sessionDir, "events.ndjson.zst"))) {
    return {
      sessionId,
      sessionDir,
      status: "skipped",
      reason: "no cold event stream",
    };
  }

  const stored = readCandidates(path.join(sessionDir, "candidates.jsonl"));
  let scratchRoot: string | undefined;
  try {
    scratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-backtest-"),
    );
    const replayDir = path.join(scratchRoot, sessionId);
    // A full recursive copy, not a hand picked subset: the analyzer reads
    // meta.json, index.json and the cold artifacts, and a partial copy would
    // make the replay differ from the stored run for reasons that are not the
    // analyzer.
    fs.cpSync(sessionDir, replayDir, { recursive: true });

    const result = await reanalyzeSession(replayDir);
    if (!result.reanalyzed) {
      return {
        sessionId,
        sessionDir,
        status: "skipped",
        reason: "no cold event stream",
      };
    }
    const replayed = readCandidates(path.join(replayDir, "candidates.jsonl"));
    return {
      sessionId,
      sessionDir,
      status: "compared",
      ...diff(stored, replayed),
    };
  } catch (err) {
    return {
      sessionId,
      sessionDir,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function diff(
  stored: Map<string, BacktestCandidateRef>,
  replayed: Map<string, BacktestCandidateRef>,
): Pick<
  BacktestReport,
  "would_newly_flag" | "would_stop_flagging" | "unchanged"
> {
  const newly: BacktestCandidateRef[] = [];
  const stopped: BacktestCandidateRef[] = [];
  let unchanged = 0;
  for (const [key, ref] of replayed) {
    if (stored.has(key)) unchanged += 1;
    else newly.push(ref);
  }
  for (const [key, ref] of stored) {
    if (!replayed.has(key)) stopped.push(ref);
  }
  const byKey = (a: BacktestCandidateRef, b: BacktestCandidateRef) =>
    a.key.localeCompare(b.key);
  return {
    would_newly_flag: newly.sort(byKey),
    would_stop_flagging: stopped.sort(byKey),
    unchanged,
  };
}

/**
 * Reads `candidates.jsonl` into a map keyed by a stable identity.
 *
 * The emitted `id` is positional (`cand_0001`, assigned after ranking in
 * `evidence-index.ts`), so joining on it would call every rank change a new
 * flag. The join is on the detector, the anchor timestamp and the single
 * strongest thing the detector anchored on instead, which survives a re-rank, a
 * re-worded title and a newly enriched anchor field.
 *
 * Two candidates that are identical under that key are still two findings, so
 * repeats carry an ordinal rather than collapsing. Without it a session that
 * gained one duplicate would report as unchanged.
 */
function readCandidates(file: string): Map<string, BacktestCandidateRef> {
  const found = new Map<string, BacktestCandidateRef>();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return found; // No stored candidates is a real state, not an error.
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // candidates.jsonl is written deterministically; skip a bad line defensively.
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const row = parsed as {
      detector?: unknown;
      title?: unknown;
      severity?: unknown;
      anchor?: Record<string, unknown> | null;
    };
    const detector = typeof row.detector === "string" ? row.detector : "";
    if (!detector) continue;
    const anchor =
      typeof row.anchor === "object" && row.anchor !== null ? row.anchor : {};
    const subject =
      anchor.requestId ??
      anchor.message ??
      anchor.errorCode ??
      anchor.url ??
      "";
    const base = [detector, String(anchor.t ?? ""), String(subject)].join("|");
    let key = base;
    for (let repeat = 2; found.has(key); repeat += 1) key = `${base}#${repeat}`;
    found.set(key, {
      key,
      detector,
      title: typeof row.title === "string" ? row.title : "",
      severity: typeof row.severity === "string" ? row.severity : "",
    });
  }
  return found;
}

function totalsOf(sessions: BacktestReport[]): BacktestTotals {
  const sum = (pick: (r: BacktestReport) => number) =>
    sessions.reduce((acc, report) => acc + pick(report), 0);
  return {
    sessions: sessions.length,
    compared: sessions.filter((r) => r.status === "compared").length,
    skipped: sessions.filter((r) => r.status === "skipped").length,
    failed: sessions.filter((r) => r.status === "failed").length,
    would_newly_flag: sum((r) => r.would_newly_flag?.length ?? 0),
    would_stop_flagging: sum((r) => r.would_stop_flagging?.length ?? 0),
    unchanged: sum((r) => r.unchanged ?? 0),
  };
}

function formatOutput(output: BacktestOutput): string {
  const lines = ["Back test — nothing was written."];
  for (const report of output.sessions) {
    if (report.status !== "compared") {
      lines.push(
        `${report.status.padEnd(8)} ${report.sessionId}  ${report.reason ?? ""}`,
      );
      continue;
    }
    const newly = report.would_newly_flag ?? [];
    const stopped = report.would_stop_flagging ?? [];
    lines.push(
      `compared ${report.sessionId}  +${newly.length} -${stopped.length} =${report.unchanged ?? 0}`,
    );
    for (const ref of newly)
      lines.push(`  would newly flag    ${ref.detector}  ${ref.title}`);
    for (const ref of stopped)
      lines.push(`  would stop flagging ${ref.detector}  ${ref.title}`);
  }
  const { totals } = output;
  lines.push(
    "",
    `${totals.compared} compared, ${totals.skipped} skipped, ${totals.failed} failed`,
    `${totals.would_newly_flag} would newly flag, ${totals.would_stop_flagging} would stop flagging, ${totals.unchanged} unchanged`,
  );
  return lines.join("\n");
}
