import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";

function diffEvent(callsite?: Record<string, unknown>): BugEvent {
  return {
    t: 1_000,
    k: "db.diff",
    d: {
      engine: "postgres",
      op: "insert",
      table: "reviews",
      pk: { id: 8 },
      after: { id: 8, product_id: 1, stars: 5 },
      requestId: "req-a",
      ...(callsite ? { callsite } : {}),
    },
  } as unknown as BugEvent;
}

const CHAIN = {
  file: "server/src/repos/reviews-repo.js",
  line: 5,
  column: 20,
  fn: "insertReview",
  stack: [
    { file: "server/src/services/review-service.js", line: 22, fn: "create" },
    { file: "server/src/routes/reviews.js", line: 41 },
  ],
};

// buildLlmBundle reads meta.json and stats artifacts off disk, so it needs a
// real session directory rather than a synthetic session object.
const scratch: string[] = [];

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-db-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index: { id: "s1", start: 1_000, end: 2_000, dur: 1_000 },
    candidates: [],
  } as never);
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("db.diff callsites reach the agent-facing bundle", () => {
  it("carries the chain into databaseDiffs", () => {
    const bundle = bundleFor([diffEvent(CHAIN)]);
    const diff = bundle.databaseDiffs[0];
    expect(diff.callsite?.file).toBe("server/src/repos/reviews-repo.js");
    expect(diff.callsite?.fn).toBe("insertReview");
    expect(diff.callsite?.stack?.map((f) => f.file)).toEqual([
      "server/src/services/review-service.js",
      "server/src/routes/reviews.js",
    ]);
  });

  it("omits callsite entirely when the SDK did not capture one", () => {
    const bundle = bundleFor([diffEvent()]);
    expect(bundle.databaseDiffs[0].callsite).toBeUndefined();
  });

  it("never nests a stack inside a stack frame", () => {
    const nested = {
      ...CHAIN,
      stack: [{ file: "a/b.js", line: 1, stack: [{ file: "c/d.js", line: 2 }] }],
    };
    const bundle = bundleFor([diffEvent(nested)]);
    for (const frame of bundle.databaseDiffs[0].callsite?.stack ?? []) {
      expect(frame.stack).toBeUndefined();
    }
  });

  it("renders a row-changes section naming the line that issued the write", () => {
    const markdown = renderLlmMarkdown(bundleFor([diffEvent(CHAIN)]));
    expect(markdown).toContain("## Database Row Changes");
    expect(markdown).toContain("reviews");
    expect(markdown).toContain(
      "insertReview server/src/repos/reviews-repo.js:5",
    );
    expect(markdown).toContain("server/src/routes/reviews.js:41");
  });

  it("says how to turn callsites on when none were captured", () => {
    const markdown = renderLlmMarkdown(bundleFor([diffEvent()]));
    expect(markdown).toContain("## Database Row Changes");
    expect(markdown).toContain("captureCallsite");
  });

  it("renders no section at all when the session wrote nothing", () => {
    const markdown = renderLlmMarkdown(bundleFor([]));
    expect(markdown).not.toContain("## Database Row Changes");
  });
});
