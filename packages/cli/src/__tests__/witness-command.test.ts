import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWitnessCommand, type WitnessCommandIO } from "../witness/command";
const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "witness-command-"));
  dirs.push(dir);
  const dbPath = join(dir, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE items (id INTEGER PRIMARY KEY,total INTEGER,secret TEXT); INSERT INTO items VALUES(1,19,'private row value')",
  );
  const script = join(dir, "repair.sh");
  writeFileSync(script, "repair contents");
  const witness = {
    schemaVersion: "data-witness.v1",
    id: "w",
    engine: "sqlite",
    confidence: "high",
    requiresBoundKey: true,
    statements: [
      {
        table: "items",
        identifyingColumns: ["id"],
        predicates: [
          { column: "id", value: 1 },
          { column: "total", value: 19 },
        ],
      },
    ],
  };
  const out = vi.fn();
  const requests: { url: string; body: any }[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), body });
    const result = body?.sessions
      ? { verdict: "verified_fix" }
      : body?.producer
        ? {
            runId: "run",
            reproCase: { serviceScope: "api" },
            witness: { status: "proposed", witness },
          }
        : String(url).includes("repro-validation")
          ? { witness: { status: "proposed", witness } }
          : {};
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const io: WitnessCommandIO = {
    env: {
      CRUMBTRAIL_ENDPOINT: "http://localhost",
      CRUMBTRAIL_AGENT_TOKEN: "agent",
      CRUMBTRAIL_PROJECT_KEY: "ingest",
      DATABASE_URL: dbPath,
    },
    fetch: fetcher as typeof fetch,
    out,
    wait: vi.fn(async () => {}),
    repair: vi.fn(async () => {
      db.exec("UPDATE items SET total=20 WHERE id=1");
      return true;
    }),
  };
  return { db, script, io, out, requests };
}
describe("witness command", () => {
  it("runs a repair, uploads two redacted observations, and asks the cloud to settle", async () => {
    const f = fixture();
    try {
      expect(
        await runWitnessCommand(
          ["--project", "p", "--issue", "i", "--fix-script", f.script],
          f.io,
        ),
      ).toBe(0);
      const uploads = f.requests.filter((r) => r.url.endsWith("/api/events"));
      expect(uploads).toHaveLength(2);
      expect(
        uploads.map((r) => r.body.events[0].d.statements[0].rowCount),
      ).toEqual([1, 0]);
      expect(JSON.stringify(f.out.mock.calls)).not.toContain(
        "private row value",
      );
      expect(f.requests.at(-1)?.body.sessions).toBeDefined();
    } finally {
      f.db.close();
    }
  });
  it("dry run needs no database credentials, executes no fix, and uploads nothing", async () => {
    const f = fixture();
    delete f.io.env.DATABASE_URL;
    delete f.io.env.CRUMBTRAIL_PROJECT_KEY;
    try {
      expect(
        await runWitnessCommand(
          ["--project", "p", "--issue", "i", "--dry-run"],
          f.io,
        ),
      ).toBe(0);
      expect(f.requests).toHaveLength(1);
      expect(f.io.repair).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
});
