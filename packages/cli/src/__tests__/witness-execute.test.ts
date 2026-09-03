import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DataWitness } from "crumbtrail-core";
import { executeWitness } from "../witness/execute";
const witness: DataWitness = { schemaVersion: "data-witness.v1", id: "w", engine: "sqlite", confidence: "high", requiresBoundKey: true, statements: [{ table: "items", identifyingColumns: ["id"], predicates: [{ column: "id", value: 1 }, { column: "total", value: 19 }] }] };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
describe("witness execution", () => {
  it("reads a bad row then observes repair without exposing other columns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "witness-")); dirs.push(dir);
    const file = join(dir, "data.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, total INTEGER, secret TEXT); INSERT INTO items VALUES (1,19,'never printed')");
    const before = await executeWitness(witness, file);
    expect(before[0].rowCount).toBe(1);
    expect(before[0].identifyingRows).toEqual([{ id: 1 }]);
    db.exec("UPDATE items SET total=20 WHERE id=1");
    expect((await executeWitness(witness, file))[0].rowCount).toBe(0);
    db.close();
  });
  it("reports the true count with at most 25 identifying rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "witness-")); dirs.push(dir);
    const file = join(dir, "data.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, total INTEGER)");
    for (let id = 0; id < 40; id++) db.prepare("INSERT INTO items VALUES (?,19)").run(id);
    db.close();
    const result = await executeWitness({ ...witness, requiresBoundKey: false, statements: [{ ...witness.statements[0], predicates: [{column: "total", value: 19}] }] }, file);
    expect(result[0].rowCount).toBe(40);
    expect(result[0].identifyingRows).toHaveLength(25);
  });
  it("refuses executable text before connecting", async () => {
    const connect = vi.fn();
    await expect(executeWitness({ ...witness, statements: [{ ...witness.statements[0], table: "items; DROP TABLE items" }] }, "unused", connect)).rejects.toThrow("invalid_identifier");
    expect(connect).not.toHaveBeenCalled();
  });
  it("sanitizes driver errors and closes after a statement failure", async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ execute: async () => { throw new Error("password=secret row=private"); }, close }));
    const failure = executeWitness({ ...witness, engine: "postgres" }, "postgres://user:password@unreachable.example/db", connect);
    await expect(failure).rejects.toMatchObject({ target: "unreachable.example", message: "WITNESS_CONNECTION_FAILED" });
    expect(close).toHaveBeenCalledOnce();
  });
});
