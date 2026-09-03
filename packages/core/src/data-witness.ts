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
  keySets?: WitnessPredicate[][];
  minimumRows?: number;
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
  constructor(
    readonly code:
      | "invalid_witness"
      | "invalid_identifier"
      | "invalid_value"
      | "unbound_key",
  ) {
    super(code);
  }
}
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export function validateDataWitness(
  value: unknown,
): asserts value is DataWitness {
  if (!value || typeof value !== "object")
    throw new WitnessValidationError("invalid_witness");
  const witness = value as DataWitness;
  if (
    witness.schemaVersion !== "data-witness.v1" ||
    typeof witness.id !== "string" ||
    !witness.id.length ||
    !["postgres", "mysql", "sqlite", "mssql", "mongodb"].includes(
      witness.engine,
    ) ||
    typeof witness.requiresBoundKey !== "boolean" ||
    !["high", "low"].includes(witness.confidence) ||
    !Array.isArray(witness.statements) ||
    witness.statements.length < 1 ||
    witness.statements.length > 3
  ) {
    throw new WitnessValidationError("invalid_witness");
  }
  for (const statement of witness.statements) {
    if (
      !statement ||
      typeof statement !== "object" ||
      Object.keys(statement).some(
        (key) =>
          ![
            "table",
            "identifyingColumns",
            "predicates",
            "keySets",
            "minimumRows",
          ].includes(key),
      ) ||
      typeof statement.table !== "string" ||
      !Array.isArray(statement.identifyingColumns) ||
      !statement.identifyingColumns.length ||
      statement.identifyingColumns.length > 32 ||
      !Array.isArray(statement.predicates) ||
      !statement.predicates.length ||
      statement.predicates.length > 64
    ) {
      throw new WitnessValidationError("invalid_witness");
    }
    if (
      new Set(statement.identifyingColumns).size !==
        statement.identifyingColumns.length ||
      new Set(statement.predicates.map((p) => p?.column)).size !==
        statement.predicates.length
    ) {
      throw new WitnessValidationError("invalid_witness");
    }
    if (
      statement.minimumRows !== undefined &&
      (!Number.isSafeInteger(statement.minimumRows) ||
        statement.minimumRows < 1 ||
        statement.minimumRows > 25 ||
        !statement.keySets)
    ) {
      throw new WitnessValidationError("invalid_witness");
    }
    if (
      statement.keySets !== undefined &&
      (!Array.isArray(statement.keySets) ||
        !statement.keySets.length ||
        statement.keySets.length > 25 ||
        statement.keySets.some(
          (keys) =>
            !Array.isArray(keys) ||
            keys.length !== statement.identifyingColumns.length ||
            keys.some(
              (key, index) =>
                key?.column !== statement.identifyingColumns[index],
            ),
        ))
    ) {
      throw new WitnessValidationError("invalid_witness");
    }
    const allPredicates = [
      ...statement.predicates,
      ...(statement.keySets?.flat() ?? []),
    ];
    for (const identifier of [
      ...statement.table.split("."),
      ...statement.identifyingColumns,
      ...allPredicates.map((p) => p?.column),
    ]) {
      if (
        typeof identifier !== "string" ||
        !IDENTIFIER.test(identifier) ||
        identifier.startsWith("__ct_witness_")
      )
        throw new WitnessValidationError("invalid_identifier");
    }
    for (const predicate of allPredicates) {
      if (
        !predicate ||
        Object.keys(predicate).some((key) => !["column", "value"].includes(key))
      )
        throw new WitnessValidationError("invalid_witness");
      const v = predicate.value;
      if (
        v !== null &&
        typeof v !== "boolean" &&
        !(typeof v === "number" && Number.isFinite(v)) &&
        !(
          typeof v === "string" &&
          v.length <= 4096 &&
          !/\[REDACTED|\[MASKED/i.test(v)
        )
      ) {
        throw new WitnessValidationError("invalid_value");
      }
    }
    if (
      witness.requiresBoundKey &&
      !statement.keySets &&
      !statement.identifyingColumns.every((column) =>
        statement.predicates.some((p) => p.column === column),
      )
    ) {
      throw new WitnessValidationError("unbound_key");
    }
  }
}

export interface CompiledWitnessStatement {
  shape: string;
  parameters: WitnessValue[];
  identifyingColumns: string[];
  table: string;
  parameterColumns: string[];
  filter?: Record<string, unknown>;
  minimumRows?: number;
}
export function compileDataWitness(
  witness: DataWitness,
): CompiledWitnessStatement[] {
  validateDataWitness(witness);
  return witness.statements.map((statement) => {
    const quote = (name: string) =>
      witness.engine === "mysql"
        ? `\`${name}\``
        : witness.engine === "mssql"
          ? `[${name}]`
          : `"${name}"`;
    const parameters: WitnessValue[] = [];
    const parameterColumns: string[] = [];
    const bind = (column: string, value: WitnessValue) => {
      const index = parameters.push(value) - 1;
      parameterColumns.push(column);
      return witness.engine === "postgres" || witness.engine === "mongodb"
        ? `$${index + 1}`
        : witness.engine === "mssql"
          ? `@p${index}`
          : "?";
    };
    const equal = (p: WitnessPredicate) => {
      const placeholder = bind(p.column, p.value);
      if (witness.engine === "postgres")
        return `${quote(p.column)} IS NOT DISTINCT FROM ${placeholder}`;
      if (witness.engine === "mysql")
        return `${quote(p.column)} <=> ${placeholder}`;
      if (witness.engine === "sqlite")
        return `${quote(p.column)} IS ${placeholder}`;
      return `(${quote(p.column)} = ${placeholder} OR (${quote(p.column)} IS NULL AND ${placeholder} IS NULL))`;
    };
    if (witness.engine === "mongodb") {
      const document = (
        predicates: WitnessPredicate[],
        shape: boolean,
      ): Record<string, unknown> =>
        Object.fromEntries(
          predicates.map((p) => [
            p.column,
            { $eq: shape ? bind(p.column, p.value) : p.value },
          ]),
        );
      const mongoFilter = (shape: boolean): Record<string, unknown> =>
        statement.keySets
          ? {
              $and: [
                document(statement.predicates, shape),
                { $or: statement.keySets.map((keys) => document(keys, shape)) },
              ],
            }
          : document(statement.predicates, shape);
      const filter = mongoFilter(false);
      const shape = {
        find: statement.table,
        filter: mongoFilter(true),
        ...(statement.minimumRows !== undefined
          ? { minimumRows: bind("__ct_witness_minimum", statement.minimumRows) }
          : {}),
      };
      return {
        shape: JSON.stringify(shape),
        parameters,
        parameterColumns,
        identifyingColumns: statement.identifyingColumns,
        table: statement.table,
        filter,
        minimumRows: statement.minimumRows,
      };
    }
    let where = statement.predicates.map(equal).join(" AND ");
    if (statement.keySets)
      where += ` AND (${statement.keySets.map((keys) => `(${keys.map(equal).join(" AND ")})`).join(" OR ")})`;
    const columns = statement.identifyingColumns.map(quote).join(", ");
    const table = statement.table.split(".").map(quote).join(".");
    const shape =
      statement.minimumRows === undefined
        ? `SELECT ${columns} FROM ${table} WHERE ${where}`
        : `SELECT ${columns} FROM (SELECT ${columns}, COUNT(*) OVER() AS __ct_witness_group_count FROM ${table} WHERE ${where}) AS __ct_witness_group WHERE __ct_witness_group_count > ${bind("__ct_witness_minimum", statement.minimumRows)}`;
    return {
      shape,
      parameters,
      parameterColumns,
      identifyingColumns: statement.identifyingColumns,
      table: statement.table,
    };
  });
}
