import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BugQueueManager } from "../bug-queue";
import type { BugReport } from "../bug-queue";

let bugsDir: string;
let queue: BugQueueManager;

function makeReport(overrides?: Partial<BugReport>): BugReport {
  return {
    bugId: `bug_${Math.random().toString(36).slice(2)}`,
    sessionId: "ses_test",
    flaggedAt: 1000,
    windowMs: 60_000,
    url: "http://localhost/page",
    userAgent: "test-agent",
    summary: {
      errorCount: 0,
      failedRequestCount: 0,
      eventCount: 0,
      eventKinds: {},
      durationMs: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  bugsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bgl-bugqueue-"));
  queue = new BugQueueManager({ bugsDir });
});

afterEach(() => {
  fs.rmSync(bugsDir, { recursive: true, force: true });
});

describe("BugQueueManager.create + get", () => {
  it('creates a bug and makes it retrievable with status "open"', async () => {
    const report = makeReport({ bugId: "bug_alpha" });
    await queue.create(report, []);

    const stored = queue.get("bug_alpha");
    expect(stored).toMatchObject({ bugId: "bug_alpha", status: "open" });
  });

  it("returns null for an unknown bugId", () => {
    expect(queue.get("does-not-exist")).toBeNull();
  });

  it("rejects creating a bug that already exists", async () => {
    const report = makeReport({ bugId: "bug_dup" });
    await queue.create(report, []);
    await expect(queue.create(report, [])).rejects.toThrow(
      "Bug already exists",
    );
  });

  it("rejects a bugId with path traversal characters", () => {
    expect(() => queue.get("../outside")).toThrow("Invalid bugId");
  });
});

describe("BugQueueManager.list", () => {
  it("lists bugs sorted by flaggedAt descending", async () => {
    await queue.create(makeReport({ bugId: "bug_old", flaggedAt: 1000 }), []);
    await queue.create(makeReport({ bugId: "bug_new", flaggedAt: 5000 }), []);

    const bugs = queue.list();
    expect(bugs.map((b) => b.bugId)).toEqual(["bug_new", "bug_old"]);
  });

  it('filters by the "after" timestamp', async () => {
    await queue.create(
      makeReport({ bugId: "bug_before", flaggedAt: 1000 }),
      [],
    );
    await queue.create(makeReport({ bugId: "bug_after", flaggedAt: 5000 }), []);

    const bugs = queue.list({ after: 2000 });
    expect(bugs.map((b) => b.bugId)).toEqual(["bug_after"]);
  });

  it('filters by the "before" timestamp', async () => {
    await queue.create(
      makeReport({ bugId: "bug_before", flaggedAt: 1000 }),
      [],
    );
    await queue.create(makeReport({ bugId: "bug_after", flaggedAt: 5000 }), []);

    const bugs = queue.list({ before: 2000 });
    expect(bugs.map((b) => b.bugId)).toEqual(["bug_before"]);
  });

  it("filters by status", async () => {
    await queue.create(makeReport({ bugId: "bug_open" }), []);
    await queue.create(makeReport({ bugId: "bug_resolved" }), []);
    queue.resolve("bug_resolved");

    expect(queue.list({ status: "resolved" }).map((b) => b.bugId)).toEqual([
      "bug_resolved",
    ]);
    expect(queue.list({ status: "open" }).map((b) => b.bugId)).toEqual([
      "bug_open",
    ]);
  });

  it("filters by tags using OR semantics (any matching tag qualifies)", async () => {
    await queue.create(
      makeReport({ bugId: "bug_billing", tags: ["billing"] }),
      [],
    );
    await queue.create(
      makeReport({ bugId: "bug_ui", tags: ["ui", "urgent"] }),
      [],
    );
    await queue.create(makeReport({ bugId: "bug_untagged" }), []);

    const billingOrUrgent = queue.list({ tags: ["billing", "urgent"] });
    expect(billingOrUrgent.map((b) => b.bugId).sort()).toEqual([
      "bug_billing",
      "bug_ui",
    ]);
  });

  it("returns an empty array when the bugs directory does not exist yet", () => {
    const emptyQueue = new BugQueueManager({
      bugsDir: path.join(bugsDir, "nested"),
    });
    fs.rmSync(path.join(bugsDir, "nested"), { recursive: true, force: true });
    expect(emptyQueue.list()).toEqual([]);
  });
});

describe("BugQueueManager.resolve", () => {
  it("marks an open bug as resolved", async () => {
    await queue.create(makeReport({ bugId: "bug_resolve_me" }), []);
    expect(queue.get("bug_resolve_me")?.status).toBe("open");

    queue.resolve("bug_resolve_me");

    expect(queue.get("bug_resolve_me")?.status).toBe("resolved");
  });

  it("does nothing for an unknown bugId (no throw)", () => {
    expect(() => queue.resolve("does-not-exist")).not.toThrow();
  });

  it("updates the LLM context file so it reflects resolution", async () => {
    await queue.create(makeReport({ bugId: "bug_llm_resolve" }), []);
    queue.resolve("bug_llm_resolve");

    const context = queue.getLlmContext("bug_llm_resolve");
    expect(context?.id).toBe("bug_llm_resolve");
  });
});

describe("BugQueueManager.writeVoice", () => {
  it("writes voice.webm and audio.webm and refreshes the LLM context", async () => {
    await queue.create(makeReport({ bugId: "bug_voice" }), []);

    const wrote = await queue.writeVoice(
      "bug_voice",
      Buffer.from("fake audio bytes"),
    );
    expect(wrote).toBe(true);

    const bugDir = queue.getBugDir("bug_voice");
    expect(fs.existsSync(path.join(bugDir, "voice.webm"))).toBe(true);
    expect(fs.existsSync(path.join(bugDir, "audio.webm"))).toBe(true);
    expect(fs.readFileSync(path.join(bugDir, "voice.webm"))).toEqual(
      Buffer.from("fake audio bytes"),
    );
  });

  it("returns false for an unknown bugId and writes nothing", async () => {
    const wrote = await queue.writeVoice("does-not-exist", Buffer.from("x"));
    expect(wrote).toBe(false);
  });
});

describe("BugQueueManager sanitization (via create)", () => {
  it("redacts token-like secrets from note, userAgent, and url", async () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    await queue.create(
      makeReport({
        bugId: "bug_secret",
        url: `https://app.example.test/page?token=${secret}`,
        userAgent: `agent Bearer ${"a".repeat(48)}`,
        note: `checkout failed with ${secret}`,
      }),
      [],
    );

    const stored = queue.get("bug_secret");
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Bearer ");
  });

  it("bounds oversized tags and drops non-string tags", async () => {
    await queue.create(
      makeReport({
        bugId: "bug_tags",
        tags: [
          "valid",
          "x".repeat(200),
          123 as unknown as string,
          null as unknown as string,
        ],
      }),
      [],
    );

    const stored = queue.get("bug_tags");
    expect(stored?.tags?.every((t) => t.length <= 64)).toBe(true);
    expect(stored?.tags).toContain("valid");
  });

  it("caps windowMs at the maximum allowed window and clamps negative values to zero", async () => {
    await queue.create(
      makeReport({ bugId: "bug_window_over", windowMs: 999_999_999_999 }),
      [],
    );
    await queue.create(
      makeReport({ bugId: "bug_window_negative", windowMs: -50 }),
      [],
    );

    expect(queue.get("bug_window_over")?.windowMs).toBe(24 * 60 * 60 * 1_000);
    expect(queue.get("bug_window_negative")?.windowMs).toBe(0);
  });

  it("normalizes a non-finite flaggedAt to a fallback timestamp rather than NaN", async () => {
    const before = Date.now();
    await queue.create(
      makeReport({ bugId: "bug_bad_time", flaggedAt: NaN }),
      [],
    );
    const stored = queue.get("bug_bad_time");
    expect(Number.isFinite(stored?.flaggedAt)).toBe(true);
    expect(stored!.flaggedAt).toBeGreaterThanOrEqual(before);
  });
});
