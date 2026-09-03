import { instrumentMysqlClient } from "./mysql";
import {
  suppressRaceEvidence,
  type InstrumentDbClientOptions,
} from "./instrument-shared";

export interface DuckTypedPlanetScaleResult {
  rows?: unknown[];
  rowsAffected?: number;
  insertId?: string | number;
  fields?: unknown[];
}

export interface DuckTypedPlanetScaleConnection {
  execute(
    sql: unknown,
    args?: unknown,
    options?: unknown,
  ): Promise<DuckTypedPlanetScaleResult>;
  transaction?<T>(
    fn: (connection: DuckTypedPlanetScaleConnection) => Promise<T>,
  ): Promise<T>;
}

export interface DuckTypedPlanetScaleClient {
  connection(): DuckTypedPlanetScaleConnection;
}

const HOST_RESULT = Symbol("crumbtrail.planetscale.hostResult");
const INSTRUMENTED = Symbol.for("crumbtrail.db.planetscaleInstrumented");

type CompatResult = unknown[] & { [HOST_RESULT]?: DuckTypedPlanetScaleResult };

function toCompatResult(result: DuckTypedPlanetScaleResult): CompatResult {
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const affected =
    typeof result.rowsAffected === "number" &&
    Number.isFinite(result.rowsAffected)
      ? result.rowsAffected
      : 0;
  const numericInsertId = Number(result.insertId);
  const payload =
    rows.length > 0
      ? rows
      : {
          affectedRows: affected,
          ...(Number.isSafeInteger(numericInsertId) && numericInsertId > 0
            ? { insertId: numericInsertId }
            : {}),
        };
  const compat = [payload, result.fields ?? []] as CompatResult;
  compat[HOST_RESULT] = result;
  return compat;
}

function fromCompatResult(result: unknown): DuckTypedPlanetScaleResult {
  return (
    (result as CompatResult)[HOST_RESULT] ??
    (result as DuckTypedPlanetScaleResult)
  );
}

function isInstrumented(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[INSTRUMENTED] === true,
  );
}

function wrapConnection(
  connection: DuckTypedPlanetScaleConnection,
  options: InstrumentDbClientOptions,
): DuckTypedPlanetScaleConnection {
  if (isInstrumented(connection) || typeof connection.execute !== "function") {
    return connection;
  }

  const rawExecute = connection.execute.bind(connection);
  const makeCompatClient = (executeOptions?: unknown) => ({
    query: async (sql: unknown, args?: unknown): Promise<unknown> =>
      toCompatResult(await rawExecute(sql, args, executeOptions)),
    execute: async (sql: unknown, args?: unknown): Promise<unknown> =>
      toCompatResult(await rawExecute(sql, args, executeOptions)),
  });
  const instrumented = instrumentMysqlClient(makeCompatClient(), options);

  return new Proxy(connection, {
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true;
      if (prop === "execute") {
        return async (
          sql: unknown,
          args?: unknown,
          executeOptions?: unknown,
        ): Promise<DuckTypedPlanetScaleResult> => {
          const wrapped =
            executeOptions === undefined
              ? instrumented
              : instrumentMysqlClient(
                  makeCompatClient(executeOptions),
                  options,
                );
          return fromCompatResult(await wrapped.execute!(sql, args));
        };
      }
      if (prop === "transaction" && typeof target.transaction === "function") {
        return <T>(
          fn: (tx: DuckTypedPlanetScaleConnection) => Promise<T>,
        ): Promise<T> =>
          target.transaction!((tx) => fn(wrapConnection(tx, options)));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Wraps either a PlanetScale `Connection` or its `Client` connection factory.
 * PlanetScale returns MySQL result metadata over HTTP, so this adapter feeds
 * that result through the existing MySQL capture pipeline and returns the
 * driver's original result object unchanged.
 */
export function instrumentPlanetScaleClient<T>(
  client: T,
  options: InstrumentDbClientOptions,
): T {
  if (!client || typeof client !== "object" || isInstrumented(client)) {
    return client;
  }
  // The HTTP client exposes no transaction outcome to this hook. Keep its
  // MySQL-compatible diffs, but never present them as committed race evidence.
  const captureOptions = suppressRaceEvidence(options);
  const value = client as Record<string, unknown>;
  if (typeof value.execute === "function") {
    return wrapConnection(
      client as unknown as DuckTypedPlanetScaleConnection,
      captureOptions,
    ) as T;
  }
  if (typeof value.connection !== "function") return client;

  return new Proxy(client as object, {
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true;
      if (prop === "connection") {
        return (...args: unknown[]) => {
          const connection = (
            value.connection as (
              ...values: unknown[]
            ) => DuckTypedPlanetScaleConnection
          ).apply(client, args);
          return wrapConnection(connection, captureOptions);
        };
      }
      const member = Reflect.get(target, prop, receiver);
      return typeof member === "function" ? member.bind(target) : member;
    },
  }) as T;
}
