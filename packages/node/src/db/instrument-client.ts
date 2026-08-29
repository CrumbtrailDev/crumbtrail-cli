/**
 * `instrumentDatabaseClient(client)` — the explicit path, for a client the
 * automatic one cannot reach.
 *
 * `autoCapture` instruments by replacing driver factories, so it covers clients
 * created after it runs, in the module graph it patched. This covers the rest:
 * a pool the host already built, and postgres.js under `"type": "module"`,
 * which the factory patch reports as `esm-unreachable` because the app imported
 * a different copy of the module than the one CommonJS resolved.
 *
 * The call is safe in any order relative to `autoCapture`. Events are routed
 * through the active sink at emit time, so instrumenting a pool at module load
 * and starting capture afterwards works, and is the ordinary shape.
 */

import {
  emitActiveDbEvent,
  readActiveDbRequestId,
} from "./active-sink";
import type { InstrumentDbClientOptions } from "./instrument-shared";
import { instrumentPgClient } from "./pg";
import { instrumentPostgresSql } from "./postgres-js";
import { instrumentMysqlClient } from "./mysql";
import { instrumentSqliteDatabase } from "./sqlite";
import { instrumentMssqlPool } from "./mssql";
import { instrumentNeonHttpQuery } from "./neon-http";
import { instrumentPlanetScaleClient } from "./planetscale";

/** Drivers the explicit path can wrap. `postgres` is porsager/postgres. */
export type InstrumentableDriver =
  | "pg"
  | "postgres"
  | "neon-http"
  | "planetscale"
  | "mysql2"
  | "better-sqlite3"
  | "mssql";

export interface InstrumentDatabaseClientOptions
  extends Partial<Omit<InstrumentDbClientOptions, "emit">> {
  /**
   * Which driver `client` came from. Detected from the client's shape when
   * absent; pass it explicitly if a wrapper or a proxy makes that ambiguous.
   */
  driver?: InstrumentableDriver;
}

/**
 * Shape detection, deliberately narrow. Each test names a member that driver
 * has and the others do not, and an unrecognised shape returns undefined rather
 * than guessing — wrapping a client as the wrong driver would corrupt its
 * statements, which is far worse than not instrumenting it.
 */
function detectDriver(client: unknown): InstrumentableDriver | undefined {
  // postgres.js: the client IS a tagged-template function.
  if (typeof client === "function") return "postgres";
  if (typeof client !== "object" || client === null) return undefined;
  const c = client as Record<string, unknown>;
  if (typeof c.connection === "function") return "planetscale";
  // better-sqlite3: synchronous prepare/exec, no query().
  if (typeof c.prepare === "function" && typeof c.query !== "function") {
    return "better-sqlite3";
  }
  // mssql: a pool hands out request objects.
  if (typeof c.request === "function") return "mssql";
  if (typeof c.query === "function") {
    // mysql2 exposes escapeId; pg does not.
    if (typeof c.escapeId === "function") return "mysql2";
    return "pg";
  }
  if (typeof c.execute === "function") return "planetscale";
  return undefined;
}

/**
 * Instrument one database client in place and return it, so the call can wrap
 * the expression that creates it.
 *
 * Never throws into the host: an unrecognised client is returned untouched.
 */
export function instrumentDatabaseClient<T>(
  client: T,
  options: InstrumentDatabaseClientOptions = {},
): T {
  const { driver, ...rest } = options;
  const resolved = driver ?? detectDriver(client);
  if (!resolved) return client;

  const instrumentOptions: InstrumentDbClientOptions = {
    ...rest,
    emit: emitActiveDbEvent,
    // An explicit requestId still wins; this is the fallback that makes the
    // call behave like the automatic path.
    getRequestId: rest.getRequestId ?? readActiveDbRequestId,
  };

  try {
    switch (resolved) {
      case "pg":
        return instrumentPgClient(
          client as Parameters<typeof instrumentPgClient>[0],
          instrumentOptions,
        ) as T;
      case "postgres":
        return instrumentPostgresSql(client, instrumentOptions) as T;
      case "neon-http":
        return instrumentNeonHttpQuery(client, instrumentOptions) as T;
      case "planetscale":
        return instrumentPlanetScaleClient(client, instrumentOptions) as T;
      case "mysql2":
        return instrumentMysqlClient(
          client as Parameters<typeof instrumentMysqlClient>[0],
          instrumentOptions,
        ) as T;
      case "better-sqlite3":
        return instrumentSqliteDatabase(
          client as Parameters<typeof instrumentSqliteDatabase>[0],
          instrumentOptions,
        ) as T;
      case "mssql":
        return instrumentMssqlPool(
          client as Parameters<typeof instrumentMssqlPool>[0],
          instrumentOptions,
        ) as T;
    }
  } catch {
    // A driver with an unexpected shape is not a reason to break the host's
    // database access.
    return client;
  }
}
