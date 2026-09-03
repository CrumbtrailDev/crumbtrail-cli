import { DB_WITNESS_EVENT_KIND, type BugEvent, type DataWitness, type DbWitnessEventData } from "crumbtrail-core";
import { buildDbReadEvent } from "./read-event";

/** Use the database read policy for both identifying values and predicate bindings. */
export function buildDbWitnessEvent(witness: DataWitness, observation: DbWitnessEventData, redactColumns?: readonly string[]): BugEvent {
  if (observation.witnessId !== witness.id || observation.statements.length !== witness.statements.length) throw new Error("WITNESS_OBSERVATION_MISMATCH");
  const statements = observation.statements.map((statement, index) => {
    const proposal = witness.statements[index];
    const scrub = (row: Record<string, unknown>) => {
      const event = buildDbReadEvent({ engine: witness.engine, table: proposal.table, requestId: observation.runId, pk: row, row, redactColumns });
      return event.d.row as Record<string, unknown>;
    };
    const bindings = scrub(Object.fromEntries(proposal.predicates.map((predicate, i) => [predicate.column, statement.parameters[i]])));
    return { ...statement, parameters: proposal.predicates.map((predicate) => bindings?.[predicate.column]), identifyingRows: statement.identifyingRows.map(scrub) };
  });
  return { t: Date.now(), k: DB_WITNESS_EVENT_KIND, d: { ...observation, statements } } as BugEvent;
}
