import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCommand } from "../commands";
import { postProcess } from "../post-process";
import { runBacktest } from "../run-backtest";
import { runCli } from "../cli";

let tmpDir: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-backtest-test-"));
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Builds a finalized session at the V2 partition depth the walker must reach. */
async function finalizedSession(id: string): Promise<string> {
  const dir = path.join(tmpDir, "ten_a", "prj_b", "2026-07-24", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id, start: 1_000 }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    `${JSON.stringify({ t: 1_000, k: "rej", d: { msg: "Failed to fetch", stk: "TypeError: Failed to fetch\n    at f (https://app.test/a.js:1:2)" } })}\n`,
  );
  await postProcess(dir);
  fs.rmSync(path.join(dir, "events.ndjson"));
  return dir;
}

/** Every file under a directory, hashed, so a single byte anywhere shows up. */
function hashTree(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      hashes[path.relative(dir, full)] = crypto
        .createHash("sha256")
        .update(fs.readFileSync(full))
        .digest("hex");
    }
  };
  walk(dir);
  return hashes;
}

function readCandidateRows(dir: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(dir, "candidates.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeCandidateRows(
  dir: string,
  rows: Record<string, unknown>[],
): void {
  fs.writeFileSync(
    path.join(dir, "candidates.jsonl"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
}

describe("backtest command routing", () => {
  it("routes the subcommand and strips the command word", () => {
    expect(parseCommand(["backtest", "ses_1", "--json"])).toEqual({
      command: "backtest",
      rest: ["ses_1", "--json"],
    });
  });

  it("prints focused help for backtest --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runCli(["backtest", "--help"])).toBe(0);
    const help = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(help).toContain("crumbtrail-server backtest");
    expect(help).toContain("--all");
    expect(help).toContain("--json");
    expect(help).not.toContain("--dry-run");
  });
});

describe("runBacktest", () => {
  it("leaves the session directory byte identical", async () => {
    const dir = await finalizedSession("ses_untouched");
    // Doctor the stored candidates so the run has a real diff to compute and
    // therefore real work to do; a no op run would pass this vacuously.
    const rows = readCandidateRows(dir);
    expect(rows.length).toBeGreaterThan(0);
    writeCandidateRows(dir, []);
    const before = hashTree(dir);
    expect(Object.keys(before).length).toBeGreaterThan(1);

    const code = await runBacktest([dir, "--json"]);

    expect(code).toBe(0);
    expect(hashTree(dir)).toEqual(before);
    const parsed = JSON.parse(stdout);
    expect(parsed.totals.would_newly_flag).toBeGreaterThan(0);
  });

  it("reports the exact candidate the current analyzer would newly flag", async () => {
    const dir = await finalizedSession("ses_newly");
    const rows = readCandidateRows(dir);
    const dropped = rows[0];
    writeCandidateRows(dir, rows.slice(1));

    expect(await runBacktest([dir, "--json"])).toBe(0);

    const report = JSON.parse(stdout).sessions[0];
    expect(report.status).toBe("compared");
    expect(report.would_newly_flag).toHaveLength(1);
    expect(report.would_newly_flag[0]).toMatchObject({
      detector: dropped.detector,
      title: dropped.title,
    });
    expect(report.would_stop_flagging).toEqual([]);
    expect(report.unchanged).toBe(rows.length - 1);
  });

  it("reports a stored candidate the current analyzer no longer flags", async () => {
    const dir = await finalizedSession("ses_stopped");
    const rows = readCandidateRows(dir);
    writeCandidateRows(dir, [
      ...rows,
      {
        ...rows[0],
        id: "cand_9999",
        detector: "retired_detector",
        title: "Flagged by an older build",
        anchor: { ...(rows[0].anchor as Record<string, unknown>), t: 999_999 },
      },
    ]);

    expect(await runBacktest([dir, "--json"])).toBe(0);

    const report = JSON.parse(stdout).sessions[0];
    expect(report.would_stop_flagging).toHaveLength(1);
    expect(report.would_stop_flagging[0]).toMatchObject({
      detector: "retired_detector",
      title: "Flagged by an older build",
    });
    expect(report.would_newly_flag).toEqual([]);
  });

  it("reports unchanged with an empty diff when nothing moved", async () => {
    const dir = await finalizedSession("ses_same");
    const stored = readCandidateRows(dir).length;
    expect(stored).toBeGreaterThan(0); // Otherwise "unchanged" would pass vacuously.

    expect(await runBacktest([dir, "--json"])).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.sessions[0]).toMatchObject({
      status: "compared",
      would_newly_flag: [],
      would_stop_flagging: [],
      unchanged: stored,
    });
    expect(parsed.totals.would_newly_flag).toBe(0);
    expect(parsed.totals.would_stop_flagging).toBe(0);
  });

  it("skips a session with no cold stream instead of failing", async () => {
    const dir = path.join(tmpDir, "ses_live");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: "x" }));

    const code = await runBacktest([dir, "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions[0]).toMatchObject({
      status: "skipped",
      reason: "no cold event stream",
    });
    expect(parsed.totals.skipped).toBe(1);
  });

  it("back tests every finalized session under the sessions dir", async () => {
    await finalizedSession("ses_one");
    await finalizedSession("ses_two");

    expect(await runBacktest(["--all", "--output", tmpDir, "--json"])).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(
      parsed.sessions.map((r: { sessionId: string }) => r.sessionId).sort(),
    ).toEqual(["ses_one", "ses_two"]);
    expect(parsed.totals.compared).toBe(2);
  });

  it("carries the same totals in --json as in the text form", async () => {
    const dir = await finalizedSession("ses_totals");
    const rows = readCandidateRows(dir);
    writeCandidateRows(dir, rows.slice(1));

    await runBacktest([dir, "--json"]);
    const parsed = JSON.parse(stdout);
    stdout = "";
    await runBacktest([dir]);

    expect(stdout).toContain("Back test — nothing was written.");
    expect(stdout).toContain(
      `${parsed.totals.compared} compared, ${parsed.totals.skipped} skipped, ${parsed.totals.failed} failed`,
    );
    expect(stdout).toContain(
      `${parsed.totals.would_newly_flag} would newly flag, ${parsed.totals.would_stop_flagging} would stop flagging, ${parsed.totals.unchanged} unchanged`,
    );
  });

  it("requires a target", async () => {
    expect(await runBacktest([])).toBe(1);
    expect(stderr).toContain("a session id or directory is required");
  });

  it("rejects a session and --all together", async () => {
    expect(await runBacktest(["ses_1", "--all"])).toBe(1);
    expect(stderr).toContain("not both");
  });
});
