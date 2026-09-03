import type { DbEngine } from "./types";

export const DB_WITNESS_EVENT_KIND = "db.witness" as const;
export const DATA_WITNESS_ROW_CAP = 25;
export type WitnessEngine = Exclude<DbEngine, "prisma">;
export type WitnessValue = string | number | boolean | null;
export interface WitnessPredicate {
  column: string;
  value: WitnessValue;
}
/** The runner compiles this restricted document. It never executes agent supplied SQL. */
export interface WitnessStatement {
  table: string;
  identifyingColumns: string[];
  predicates: WitnessPredicate[];
}
export interface DataWitness {
  schemaVersion: "data-witness.v1";
  id: string;
  engine: WitnessEngine;
  confidence: "high" | "low";
  requiresBoundKey: boolean;
  statements: WitnessStatement[];
}
export interface WitnessRunIdentity {
  kind: "migration";
  fingerprint: string;
}
export interface WitnessStatementObservation {
  shape: string;
  parameters: WitnessValue[];
  status: "executed" | "refused" | "failed" | "skipped";
  rowCount: number;
  identifyingRows: Record<string, unknown>[];
}
export interface DbWitnessEventData {
  witnessId: string;
  engine: WitnessEngine;
  runId: string;
  phase: "before" | "after";
  identity: WitnessRunIdentity;
  statements: WitnessStatementObservation[];
}

export class WitnessValidationError extends Error {
  constructor(readonly code: "invalid_witness" | "invalid_identifier" | "invalid_value" | "unbound_key") {
    super(code);
  }
}
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export function validateDataWitness(value: unknown): asserts value is DataWitness {
  if (!value || typeof value !== "object") throw new WitnessValidationError("invalid_witness");
  const witness = value as DataWitness;
  if (witness.schemaVersion !== "data-witness.v1" ||
      typeof witness.id !== "string" || !witness.id.length ||
      !["postgres", "mysql", "sqlite", "mssql", "mongodb"].includes(witness.engine) ||
      typeof witness.requiresBoundKey !== "boolean" ||
      !["high", "low"].includes(witness.confidence) ||
      !Array.isArray(witness.statements) || witness.statements.length < 1 || witness.statements.length > 3) {
    throw new WitnessValidationError("invalid_witness");
  }
  for (const statement of witness.statements) {
    if (!statement || typeof statement !== "object" ||
        Object.keys(statement).some((key) => !["table", "identifyingColumns", "predicates"].includes(key)) ||
        typeof statement.table !== "string" ||
        !Array.isArray(statement.identifyingColumns) || !statement.identifyingColumns.length ||
        statement.identifyingColumns.length > 32 ||
        !Array.isArray(statement.predicates) || !statement.predicates.length || statement.predicates.length > 64) {
      throw new WitnessValidationError("invalid_witness");
    }
    for (const identifier of [...statement.table.split("."), ...statement.identifyingColumns, ...statement.predicates.map((p) => p?.column)]) {
      if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) throw new WitnessValidationError("invalid_identifier");
    }
    for (const predicate of statement.predicates) {
      if (!predicate || Object.keys(predicate).some((key) => !["column", "value"].includes(key))) throw new WitnessValidationError("invalid_witness");
      const v = predicate.value;
      if (v !== null && typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v)) &&
          !(typeof v === "string" && v.length <= 4096 && !/\[REDACTED|\[MASKED/i.test(v))) {
        throw new WitnessValidationError("invalid_value");
      }
    }
    if (witness.requiresBoundKey && !statement.identifyingColumns.every((column) => statement.predicates.some((p) => p.column === column))) {
      throw new WitnessValidationError("unbound_key");
    }
  }
}

export interface CompiledWitnessStatement {
  shape: string;
  parameters: WitnessValue[];
  identifyingColumns: string[];
  table: string;
  filter?: Record<string, { $eq: WitnessValue }>;
}
export function compileDataWitness(witness: DataWitness): CompiledWitnessStatement[] {
  validateDataWitness(witness);
  return witness.statements.map((statement) => {
    const quote = (name: string) => witness.engine === "mysql" ? `\`${name}\`` : witness.engine === "mssql" ? `[${name}]` : `"${name}"`;
    const parameters = statement.predicates.map((p) => p.value);
    if (witness.engine === "mongodb") {
      const filter = Object.fromEntries(statement.predicates.map((p) => [p.column, { $eq: p.value }]));
      return { shape: JSON.stringify({ find: statement.table, filter: Object.fromEntries(statement.predicates.map((p, i) => [p.column, { $eq: `$${i + 1}` }])) }), parameters, identifyingColumns: statement.identifyingColumns, table: statement.table, filter };
    }
    const placeholder = (i: number) => witness.engine === "postgres" ? `$${i + 1}` : witness.engine === "mssql" ? `@p${i}` : "?";
    const where = statement.predicates.map((p, i) => {
      if (witness.engine === "postgres") return `${quote(p.column)} IS NOT DISTINCT FROM ${placeholder(i)}`;
      if (witness.engine === "mysql") return `${quote(p.column)} <=> ${placeholder(i)}`;
      if (witness.engine === "sqlite") return `${quote(p.column)} IS ${placeholder(i)}`;
      return `(${quote(p.column)} = ${placeholder(i)} OR (${quote(p.column)} IS NULL AND ${placeholder(i)} IS NULL))`;
    }).join(" AND ");
    return { shape: `SELECT ${statement.identifyingColumns.map(quote).join(", ")} FROM ${statement.table.split(".").map(quote).join(".")} WHERE ${where}`, parameters, identifyingColumns: statement.identifyingColumns, table: statement.table };
  });
}
