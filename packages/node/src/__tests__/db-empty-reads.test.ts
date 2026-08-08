import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { instrumentPgClient } from "../db";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";

/**
 * A SELECT that matched nothing left no trace whatsoever: the per-row emit loop had no rows to
 * walk, and the truncation branch compared `rowCount > emittedRows` — `0 > 0`. So the one database
 * outcome behind null dereferences, empty states, and lookups against the wrong key or the wrong
 * time window was the one a session could not record.
 */
const scratch: string[] = [];

function fakePgClient(rowsFor: (text: string) => unknown[]) {
  return {
    query(text: string) {
      const rows = rowsFor(text);
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-empty-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index: { id: "s1", start: 1_000, end: 6_000, dur: 5_000 },
    candidates: [],
  } as never);
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("a SELECT that matched nothing is recorded", () => {
  it("emits a zero-row read the per-row path cannot produce", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(fakePgClient(() => []), {
      requestId: "req-1",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await db.query("SELECT * FROM coupons WHERE code = $1", ["NIGHTLY"]);

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("db.read.bulk");
    expect(events[0].d).toMatchObject({
      table: "coupons",
      rowCount: 0,
      emittedRows: 0,
      requestId: "req-1",
    });
  });

  it("numbers the statement, so two empty lookups are distinguishable", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(fakePgClient(() => []), {
      requestId: "req-2",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await db.query("SELECT * FROM coupons WHERE code = $1", ["A"]);
    await db.query("SELECT * FROM payments WHERE order_id = $1", [1]);

    expect(events.map((e) => (e.d as Record<string, unknown>).stmt)).toEqual([
      1, 2,
    ]);
  });

  it("still emits rows normally when the query found some", async () => {
    const events: BugEvent[] = [];
    const db = instrumentPgClient(fakePgClient(() => [{ id: 1, code: "X" }]), {
      requestId: "req-3",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await db.query("SELECT * FROM coupons WHERE code = $1", ["X"]);

    expect(events.map((e) => e.k)).toEqual(["db.read"]);
  });

  it("renders the lookup as a question asked and an answer got", () => {
    const markdown = renderLlmMarkdown(
      bundleFor([
        {
          t: 1_500,
          k: "db.read.bulk",
          d: {
            engine: "postgres",
            table: "coupons",
            requestId: "req-checkout",
            rowCount: 0,
            emittedRows: 0,
            truncatedRows: 0,
            samplePks: [],
            stmt: 3,
          },
        } as unknown as BugEvent,
      ]),
    );
    expect(markdown).toContain("## Lookups That Found Nothing");
    expect(markdown).toContain("coupons");
    expect(markdown).toContain("#3");
  });

  it("omits the section when every lookup found something", () => {
    const markdown = renderLlmMarkdown(bundleFor([]));
    expect(markdown).not.toContain("## Lookups That Found Nothing");
  });
});
