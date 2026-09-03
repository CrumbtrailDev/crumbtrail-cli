import { describe, it, expect } from "vitest";
import type { DataWitness, DbWitnessEventData } from "crumbtrail-core";
import { buildDbWitnessEvent } from "../db/witness-event";
describe("witness redaction", () => {
  it("preserves counts and shapes while applying read row redaction to keys and parameters", () => {
    const witness: DataWitness = { schemaVersion: "data-witness.v1", id: "w", engine: "postgres", confidence: "high", requiresBoundKey: true, statements: [{ table: "items", identifyingColumns: ["id", "token"], predicates: [{column:"id",value:1},{column:"token",value:"secretvalue"}] }] };
    const observation: DbWitnessEventData = { witnessId: "w", engine: "postgres", runId: "run", phase: "before", identity: {kind:"migration",fingerprint:"abc"}, statements: [{ shape: "SELECT id, token FROM items WHERE id = $1 AND token = $2", parameters: [1,"secretvalue"], status: "executed", rowCount: 7, identifyingRows: [{id:1,token:"secretvalue"}] }] };
    const event = buildDbWitnessEvent(witness, observation);
    expect(event.k).toBe("db.witness");
    expect(JSON.stringify(event)).not.toContain("secretvalue");
    expect(event.d.statements).toMatchObject([{rowCount:7,shape:observation.statements[0].shape,identifyingRows:[{id:1,token:"[REDACTED]"}]}]);
  });
});
