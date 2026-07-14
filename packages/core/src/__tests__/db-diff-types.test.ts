import { describe, it, expect } from "vitest";
import {
  DB_DIFF_EVENT_KIND,
  type DbDiffEventData,
  type DbEngine,
  type BugEvent,
} from "../index";

describe("db.diff event kind", () => {
  it("exposes the canonical db.diff event kind constant", () => {
    expect(DB_DIFF_EVENT_KIND).toBe("db.diff");
  });

  it("types a db.diff payload as the d of a BugEvent", () => {
    const d: DbDiffEventData = {
      engine: "postgres",
      op: "update",
      table: "users",
      pk: { id: 7 },
      after: { id: 7, name: "Ada" },
      requestId: "trace-abc",
    };
    const event: BugEvent = {
      t: 1,
      k: DB_DIFF_EVENT_KIND,
      d: d as unknown as Record<string, unknown>,
    };
    expect(event.k).toBe("db.diff");
    expect((event.d as unknown as DbDiffEventData).op).toBe("update");
  });

  it("accepts every engine in the DbEngine union", () => {
    const engines: DbEngine[] = ["postgres", "mysql", "mssql", "sqlite"];
    const events = engines.map<DbDiffEventData>((engine) => ({
      engine,
      op: "insert",
      table: "orders",
      pk: { id: 1 },
      after: { id: 1 },
      requestId: "trace-1",
    }));
    expect(events.map((d) => d.engine)).toEqual(engines);
  });

  it("types an image-less statement-level fallback event with rowCount and pk null", () => {
    const d: DbDiffEventData = {
      engine: "mysql",
      op: "insert",
      table: "orders",
      pk: null,
      rowCount: 12,
      requestId: "trace-abc",
    };
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(12);
    expect(d.after).toBeUndefined();
    expect(d.before).toBeUndefined();
  });
});
