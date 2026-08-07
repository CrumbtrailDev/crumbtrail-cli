import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { writeEvidenceIndex } from "../evidence-index";

/**
 * The request succeeded, the user saw a confirmation, and the work behind it did not happen.
 * Nothing in the session looks wrong from the request plane alone.
 */
describe("job_did_not_complete", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-outcome-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function candidatesFor(events: BugEvent[]) {
    const index = {
      id: "ses_jobs",
      start: events[0].t,
      end: events.at(-1)!.t,
      dur: events.at(-1)!.t - events[0].t,
      evts: events.length,
      stats: {},
    };
    return writeEvidenceIndex({ sessionDir: tmpDir, events, index });
  }

  const startedAt = 1_700_002_000_000;

  it("reports a job that failed after the request had returned", async () => {
    const candidates = await candidatesFor([
      {
        t: startedAt,
        k: "backend.job.start",
        d: { job: "record-payment", jobId: "j1", requestId: "r1" },
      },
      {
        t: startedAt + 500,
        k: "backend.job.error",
        d: {
          job: "record-payment",
          jobId: "j1",
          requestId: "r1",
          outcome: "failure",
          error: { name: "TypeError", message: "order not found" },
        },
      },
    ]);

    const found = candidates.find((c) => c.detector === "job_did_not_complete");
    expect(found).toBeDefined();
    expect(found?.severity).toBe("high");
    expect(found?.anchor.message).toContain("order not found");
  });

  // "Nothing to do" is what a job says when the record it was meant to act on is missing. Treating
  // it as success is how the defect stays hidden.
  it("treats a skipped run as a finding, not as normal operation", async () => {
    const candidates = await candidatesFor([
      {
        t: startedAt,
        k: "backend.job.start",
        d: { job: "record-payment", jobId: "j2" },
      },
      {
        t: startedAt + 200,
        k: "backend.job.end",
        d: { job: "record-payment", jobId: "j2", outcome: "skipped" },
      },
    ]);

    expect(
      candidates.find((c) => c.detector === "job_did_not_complete")?.title,
    ).toContain("nothing to do");
  });

  it("reports a job that started and never reported an ending", async () => {
    const candidates = await candidatesFor([
      {
        t: startedAt,
        k: "backend.job.start",
        d: { job: "record-payment", jobId: "j3" },
      },
      { t: startedAt + 100, k: "nav", d: { url: "https://app.test/orders" } },
    ]);

    expect(
      candidates.find((c) => c.detector === "job_did_not_complete")?.title,
    ).toContain("never reported an ending");
  });

  it("says nothing about a job that simply worked", async () => {
    const candidates = await candidatesFor([
      {
        t: startedAt,
        k: "backend.job.start",
        d: { job: "record-payment", jobId: "j4" },
      },
      {
        t: startedAt + 120,
        k: "backend.job.end",
        d: { job: "record-payment", jobId: "j4", outcome: "success" },
      },
    ]);

    expect(
      candidates.find((c) => c.detector === "job_did_not_complete"),
    ).toBeUndefined();
  });

  // A finding that reports `isolated` drops out of the incident thread and leaves the causal chain
  // null, which is the failure this repository has already paid for once with click_target_intercepted.
  it("threads the finding to the request that enqueued the job", async () => {
    const candidates = await candidatesFor([
      {
        t: startedAt,
        k: "clk",
        d: { el: { sig: "place-order", path: "button[data-testid='place-order']" } },
      },
      {
        t: startedAt + 50,
        k: "net.req",
        d: { id: 1, requestId: "r-order", m: "POST", url: "https://app.test/api/orders" },
      },
      {
        t: startedAt + 150,
        k: "net.res",
        d: { id: 1, requestId: "r-order", st: 200 },
      },
      {
        t: startedAt + 400,
        k: "backend.job.start",
        d: { job: "record-payment", jobId: "j9", requestId: "r-order" },
      },
      {
        t: startedAt + 900,
        k: "backend.job.error",
        d: {
          job: "record-payment",
          jobId: "j9",
          requestId: "r-order",
          outcome: "failure",
          error: { name: "TypeError", message: "order not found" },
        },
      },
    ]);

    const found = candidates.find((c) => c.detector === "job_did_not_complete");
    expect(found?.causalRole).not.toBe("isolated");
  });
});
