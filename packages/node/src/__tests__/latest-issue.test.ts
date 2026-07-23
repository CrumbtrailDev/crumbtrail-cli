import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveLatestIssue } from "../latest-issue";

/**
 * Pins the shared latest-issue definition (backing BOTH the getLatestIssue MCP
 * tool and the `fix-context --latest` CLI flag):
 * - qualifies iff index.json exists (finalize signal) AND errs non-empty OR
 *   failedReqs non-empty OR consoleErrors non-empty OR any candidates.jsonl row
 *   with severity critical/high
 * - index.networkErrors is deliberately not a clause: post-process pushes every
 *   net.err into it, and the ones it judged to be real failures are already in
 *   failedReqs
 * - recency = index.end, fallback index.start, then meta.start; ties -> session
 *   id descending
 * - hot-plane reads only (never events.ndjson)
 */
describe("resolveLatestIssue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-latest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(
    sessionId: string,
    opts: {
      meta?: Record<string, unknown>;
      index?: Record<string, unknown> | null;
      candidates?: Array<Record<string, unknown>>;
      eventsNdjson?: string;
    } = {},
  ): string {
    const dir = path.join(tmpDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: sessionId, ...(opts.meta ?? {}) }),
    );
    if (opts.index !== null) {
      fs.writeFileSync(
        path.join(dir, "index.json"),
        JSON.stringify({
          id: sessionId,
          errs: [],
          failedReqs: [],
          ...(opts.index ?? {}),
        }),
      );
    }
    if (opts.candidates) {
      fs.writeFileSync(
        path.join(dir, "candidates.jsonl"),
        opts.candidates.map((c) => JSON.stringify(c)).join("\n") + "\n",
      );
    }
    if (opts.eventsNdjson !== undefined) {
      fs.writeFileSync(path.join(dir, "events.ndjson"), opts.eventsNdjson);
    }
    return dir;
  }

  it("returns undefined for an empty store", () => {
    expect(resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
    expect(
      resolveLatestIssue({ outputDir: path.join(tmpDir, "does-not-exist") }),
    ).toBeUndefined();
  });

  it("ignores non-finalized sessions (no index.json), whatever else they contain", () => {
    seed("ses_live", {
      index: null,
      candidates: [{ id: "cand_0001", severity: "critical" }],
    });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
  });

  it("does not qualify a clean finalized session (no errs, no failedReqs, no high candidates)", () => {
    seed("ses_clean", {
      index: { end: 9000 },
      candidates: [
        { id: "cand_0001", severity: "medium" },
        { id: "cand_0002", severity: "low" },
      ],
    });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
  });

  it("qualifies via index.errs non-empty", () => {
    const dir = seed("ses_errs", {
      index: { end: 5000, errs: [{ t: 4000, msg: "boom" }] },
    });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_errs",
      dir,
    });
  });

  it("qualifies via index.failedReqs non-empty", () => {
    const dir = seed("ses_failed", {
      index: {
        end: 5000,
        failedReqs: [{ t: 4000, m: "GET", url: "/x", st: 500 }],
      },
    });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_failed",
      dir,
    });
  });

  it("qualifies via index.consoleErrors non-empty, with no err and no failed request", () => {
    // Real reproduction, artifacts shaped exactly as postProcess writes them for a session that
    // navigates, logs one console.error, and makes one database write:
    //   nav -> con(level "error") at +1000ms -> db.diff at +1500ms
    // No `err`/`rej` event and no failed request, so the first two clauses are silent, and the
    // db write ranks medium/66 (linked to the console error but not proof the write is wrong), so
    // the critical/high candidate clause is silent too. The console error is the error-class
    // evidence, and it must qualify the session on its own.
    const dir = seed("ses_console_only", {
      index: {
        start: 1784837000000,
        end: 1784837002000,
        consoleErrors: [
          {
            t: 1784837001000,
            offsetMs: 1000,
            lv: "err",
            msg: "checkout failed: coupon already redeemed",
          },
        ],
      },
      candidates: [
        {
          id: "cand_0001",
          detector: "db_mutation",
          severity: "medium",
          score: 66,
        },
        {
          id: "cand_0002",
          detector: "console_error",
          severity: "medium",
          score: 58,
        },
      ],
    });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_console_only",
      dir,
    });
  });

  it("does not qualify on index.networkErrors alone", () => {
    // post-process pushes every net.err into networkErrors, then keeps only the ones
    // isCountableNetworkFailure accepts — an AbortError from a fetch the user cancelled by
    // navigating away is recorded but is not a failure, so failedReqs stays empty. Recording the
    // exclusion: the trustworthy network errors already qualify through failedReqs.
    seed("ses_aborted_fetch", {
      index: {
        end: 5000,
        networkErrors: [
          {
            t: 4000,
            m: "GET",
            url: "/api/cart",
            msg: "The user aborted a request.",
          },
        ],
      },
      candidates: [{ id: "cand_0001", severity: "low" }],
    });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
  });

  it.each(["critical", "high"] as const)(
    "qualifies via a %s-severity candidates.jsonl row",
    (severity) => {
      const dir = seed("ses_cand", {
        index: { end: 5000 },
        candidates: [
          { id: "cand_0001", severity: "medium" },
          { id: "cand_0002", severity },
        ],
      });
      expect(resolveLatestIssue({ outputDir: tmpDir })).toEqual({
        sessionId: "ses_cand",
        dir,
      });
    },
  );

  it("orders by index.end recency across qualifying sessions", () => {
    seed("ses_old", { index: { end: 1000, errs: [{ t: 900, msg: "old" }] } });
    const newest = seed("ses_new", {
      index: { end: 9000, errs: [{ t: 8000, msg: "new" }] },
    });
    seed("ses_mid", { index: { end: 5000, errs: [{ t: 4000, msg: "mid" }] } });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_new",
      dir: newest,
    });
  });

  it("falls back to index.start, then meta.start, for recency", () => {
    // No index.end anywhere: a beats b via index.start; c has neither index.end
    // nor index.start and falls back to meta.start (largest of all -> wins).
    seed("ses_a", { index: { start: 5000, errs: [{ t: 1, msg: "a" }] } });
    seed("ses_b", { index: { start: 4000, errs: [{ t: 1, msg: "b" }] } });
    const c = seed("ses_c", {
      meta: { start: 6000 },
      index: { errs: [{ t: 1, msg: "c" }] },
    });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_c",
      dir: c,
    });
  });

  it("breaks recency ties by session id descending", () => {
    seed("ses_aaa", { index: { end: 5000, errs: [{ t: 1, msg: "x" }] } });
    const winner = seed("ses_zzz", {
      index: { end: 5000, errs: [{ t: 1, msg: "x" }] },
    });
    seed("ses_mmm", { index: { end: 5000, errs: [{ t: 1, msg: "x" }] } });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_zzz",
      dir: winner,
    });
  });

  it("reads the hot plane only — a malformed cold event stream is never touched", () => {
    const dir = seed("ses_hot", {
      index: { end: 5000, errs: [{ t: 1, msg: "x" }] },
      eventsNdjson: "{this is not json\nnor this",
    });
    expect(resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_hot",
      dir,
    });
  });

  it("skips a session whose index.json is malformed (not finalized cleanly)", () => {
    const dir = path.join(tmpDir, "ses_bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "ses_bad" }),
    );
    fs.writeFileSync(path.join(dir, "index.json"), "{not json");
    expect(resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
  });
});
