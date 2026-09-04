import {
  compileDataWitness,
  DB_WITNESS_EVENT_KIND,
  type BugEvent,
  type DataWitness,
  type DbWitnessEventData,
} from "crumbtrail-core";
import { buildDbReadEvent } from "./read-event";

/** Use the database read policy for both identifying values and predicate bindings. */
export function buildDbWitnessEvent(
  witness: DataWitness,
  observation: DbWitnessEventData,
  redactColumns?: readonly string[],
): BugEvent {
  if (
    observation.witnessId !== witness.id ||
    observation.engine !== witness.engine ||
    !["before", "after"].includes(observation.phase) ||
    observation.identity?.kind !== "migration" ||
    !/^[a-f0-9]{64}$/.test(observation.identity.fingerprint) ||
    observation.statements.length !== witness.statements.length
  )
    throw new Error("WITNESS_OBSERVATION_MISMATCH");
  const compiled = compileDataWitness(witness);
  const statements = observation.statements.map((statement, index) => {
    const proposal = witness.statements[index];
    if (
      statement.shape !== compiled[index].shape ||
      JSON.stringify(statement.parameters) !==
        JSON.stringify(compiled[index].parameters) ||
      !Number.isSafeInteger(statement.rowCount) ||
      statement.rowCount < 0 ||
      !Array.isArray(statement.identifyingRows) ||
      statement.identifyingRows.length !== Math.min(statement.rowCount, 25)
    )
      throw new Error("WITNESS_OBSERVATION_MISMATCH");
    const scrub = (row: Record<string, unknown>) => {
      const event = buildDbReadEvent({
        engine: witness.engine,
        table: proposal.table,
        requestId: observation.runId,
        pk: row,
        row,
        redactColumns,
      });
      return event.d.row as Record<string, unknown>;
    };
    const parameters = statement.parameters.map((value, i) => {
      const column = compiled[index].parameterColumns[i];
      if (!column) throw new Error("WITNESS_OBSERVATION_MISMATCH");
      return scrub({ [column]: value })?.[column];
    });
    return {
      ...statement,
      parameters,
      identifyingRows: statement.identifyingRows.map((row) =>
        scrub(
          Object.fromEntries(
            proposal.identifyingColumns.map((column) => {
              if (!Object.hasOwn(row, column))
                throw new Error("WITNESS_OBSERVATION_MISMATCH");
              return [column, row[column]];
            }),
          ),
        ),
      ),
    };
  });
  return {
    t: Date.now(),
    k: DB_WITNESS_EVENT_KIND,
    d: { ...observation, statements },
  } as BugEvent;
}
