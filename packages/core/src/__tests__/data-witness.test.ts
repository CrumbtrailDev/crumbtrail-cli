import { describe, it, expect } from "vitest";
import { compileDataWitness, type DataWitness } from "../data-witness";
const witness: DataWitness = { schemaVersion: "data-witness.v1", id: "w", engine: "postgres", confidence: "high", requiresBoundKey: true, statements: [{ table: "public.items", identifyingColumns: ["id"], predicates: [{ column: "id", value: "x'; DELETE FROM items; --" }, { column: "total", value: 19 }] }] };
describe("witness compilation", () => {
  it.each(["postgres", "mysql", "sqlite", "mssql", "mongodb"] as const)("keeps values out of the %s shape", (engine) => {
    const result = compileDataWitness({ ...witness, engine })[0];
    expect(result.shape).not.toContain("DELETE");
    expect(result.parameters).toEqual(["x'; DELETE FROM items; --", 19]);
  });
  it("rejects injected identifiers", () => {
    expect(() => compileDataWitness({ ...witness, statements: [{ ...witness.statements[0], table: "items; DELETE FROM items" }] })).toThrow("invalid_identifier");
  });
  it("rejects free SQL and writing pipeline documents", () => {
    for (const extra of [{ sql: "DELETE FROM items" }, { pipeline: [{ $out: "items" }] }]) {
      expect(() => compileDataWitness({ ...witness, statements: [{ ...witness.statements[0], ...extra }] })).toThrow("invalid_witness");
    }
  });
  it("rejects a missing primary key binding", () => {
    expect(() => compileDataWitness({ ...witness, statements: [{ ...witness.statements[0], predicates: [{ column: "total", value: 19 }] }] })).toThrow("unbound_key");
  });
  it("refuses redacted values and operator documents", () => {
    for (const value of ["[REDACTED]", { $ne: null }, NaN, undefined]) {
      expect(() => compileDataWitness({ ...witness, statements: [{ ...witness.statements[0], predicates: [{ column: "id", value: value as string }] }] })).toThrow("invalid_value");
    }
  });
});
