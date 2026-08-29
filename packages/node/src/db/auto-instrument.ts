/**
 * Zero-config DB instrumentation.
 *
 * The DB detectors — `db_delta_mismatch`, `db_field_divergence`,
 * `duplicate_write` — are the strongest silent-failure signals in the product,
 * and until now they required the host app to call `instrumentPgClient` by hand.
 * The installer never wrote that call, so in practice almost nobody had them:
 * a default install got the browser detectors and nothing else.
 *
 * This module closes that gap the way every other backend agent does it, by
 * wrapping the driver's own factories at startup so any client the app creates
 * afterwards is already instrumented. Sentry, Datadog, and OpenTelemetry all
 * behave this way, so the behavior is not surprising to anyone operating a Node
 * service.
 *
 * ## Why factory wrapping and not a module-loader hook
 *
 * `require-in-the-middle` style loader patching intercepts every `require` in
 * the process. That is a large, invasive surface for one feature, it interacts
 * badly with bundlers, and it fails differently under ESM. Instead this resolves
 * the driver ONLY if the host already depends on it, then replaces the specific
 * exported factories. A driver the app does not use is never even resolved.
 *
 * ## Guarantees
 *
 * - **Never throws into the host.** Every patch is individually try/caught. A
 *   driver with an unexpected shape is skipped and reported, not fatal.
 * - **Never installs twice.** Patched factories carry a marker symbol.
 * - **Reversible.** `restore()` puts every original factory back.
 * - **Silent about what it did NOT do.** The result lists both patched and
 *   skipped drivers with a reason, so "no DB evidence" is never a mystery.
 */

import type { BugEvent } from "crumbtrail-core";
import { createRequire } from "node:module";
import { instrumentPgClient } from "./pg";
import { instrumentMysqlClient } from "./mysql";
import { instrumentSqliteDatabase } from "./sqlite";
import { instrumentMssqlPool, instrumentMssqlTransaction } from "./mssql";
import { instrumentPostgresSql } from "./postgres-js";
import { enableMongoCommandMonitoring, instrumentMongoClient } from "./mongo";
import { instrumentNeonHttpQuery } from "./neon-http";
import { instrumentPlanetScaleClient } from "./planetscale";
import { instrumentPrismaClient } from "./prisma";
import type { InstrumentDbClientOptions } from "./instrument-shared";

/** Marks an already-wrapped factory so a second install is a no-op. */
const PATCHED = Symbol.for("crumbtrail.db.autoInstrumented");

/** Drivers this module knows how to wrap, in the order they are attempted. */
export const AUTO_INSTRUMENT_DRIVERS = [
  "@prisma/client",
  "pg",
  // porsager/postgres. Attempted before mysql2 for the same reason `pg` is
  // first: a Postgres app is the common case, and the two Postgres drivers are
  // mutually exclusive in practice.
  "postgres",
  "@neondatabase/serverless",
  "@planetscale/database",
  "mysql2",
  "mysql2/promise",
  "better-sqlite3",
  "node:sqlite",
  "mssql",
  "mongodb",
] as const;

export type AutoInstrumentDriver = (typeof AUTO_INSTRUMENT_DRIVERS)[number];

export interface AutoInstrumentDbOptions extends Omit<
  InstrumentDbClientOptions,
  "emit"
> {
  /** Sink for emitted `db.diff` / `db.read` events. */
  emit: (event: BugEvent) => void;
  /**
   * Restrict the attempt to these drivers. Absent ⇒ every driver in
   * {@link AUTO_INSTRUMENT_DRIVERS}. An empty array disables auto-instrumentation
   * entirely, which is the documented opt-out.
   */
  drivers?: readonly AutoInstrumentDriver[];
  /** Module resolver seam. Defaults to a CJS `require` off this module. */
  resolve?: (specifier: string) => unknown;
  /**
   * Replace a resolved module's whole export, for drivers whose export IS the
   * factory (postgres.js) and so have no property to swap. Returns whether the
   * replacement took. Defaults to writing `require.cache`.
   */
  replaceModule?: (specifier: string, value: unknown) => boolean;
  /**
   * Whether the host application loads its dependencies as ES modules.
   * Defaults to reading `"type"` from the nearest `package.json`.
   */
  hostIsEsm?: () => boolean;
  /** Reported once per install with what was and was not patched. */
  onReport?: (report: AutoInstrumentReport) => void;
}

export interface AutoInstrumentDriverResult {
  driver: AutoInstrumentDriver;
  status:
    | "patched"
    | "not-installed"
    | "unsupported-shape"
    | "already-patched"
    /**
     * The driver was found and wrapped in the CommonJS module graph, and the
     * host application loads it as an ES module — a separate copy the wrap
     * cannot reach. Reported separately from `patched` because claiming capture
     * that will not happen is worse than admitting it did not.
     */
    | "esm-unreachable";
  /** Present for every status except `patched`; never invented. */
  detail?: string;
}

export interface AutoInstrumentReport {
  results: AutoInstrumentDriverResult[];
  /** Undo every patch this install applied. Safe to call more than once. */
  restore(): void;
}

/** A factory we replaced, remembered so `restore()` can put it back. */
interface Restoration {
  target: Record<string, unknown>;
  key: string;
  original: unknown;
}

function isPatched(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[PATCHED] === true
  );
}

function markPatched<T extends object>(value: T): T {
  try {
    Object.defineProperty(value, PATCHED, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen factory still works; it just cannot carry the marker, so a second
    // install would double-wrap. Double wrapping emits each event twice, which is
    // wrong but not fatal, and `installed` below makes it unreachable in practice.
  }
  return value;
}

/**
 * Replace `target[key]` with a factory that passes its result through `wrap`.
 *
 * Handles both `new Ctor()` and `factory()` call styles, because `pg.Pool` is
 * used both ways in the wild and mysql2's `createPool` is a plain function.
 * Static properties are carried across so `pg.Pool.super_`-style access survives.
 */
function patchFactory(
  target: Record<string, unknown>,
  key: string,
  wrap: (instance: unknown) => unknown,
  restorations: Restoration[],
  prepareArgs?: (args: readonly unknown[]) => unknown[],
): "patched" | "already-patched" | "unsupported-shape" {
  const original = target[key];
  if (isPatched(original)) return "already-patched";
  if (typeof original !== "function") return "unsupported-shape";

  const originalFn = original as (...args: unknown[]) => unknown;

  function Patched(this: unknown, ...args: unknown[]): unknown {
    const callArgs = prepareArgs ? prepareArgs(args) : args;
    // `new pg.Pool()` — construct, then wrap the instance.
    if (new.target) {
      const instance = Reflect.construct(
        originalFn,
        callArgs,
        new.target === Patched ? originalFn : new.target,
      );
      return wrap(instance);
    }
    // `mysql.createPool()` — plain call.
    const result = originalFn.apply(this, callArgs);
    // A factory that returns a promise (mysql2/promise) resolves to the client.
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).then(wrap);
    }
    return wrap(result);
  }

  // Preserve identity affordances: statics, prototype, and name.
  try {
    Object.setPrototypeOf(Patched, originalFn);
    Patched.prototype = originalFn.prototype as object;
    Object.defineProperty(Patched, "name", { value: originalFn.name });
  } catch {
    // Cosmetic only — a driver that resists this is still correctly wrapped.
  }
  markPatched(Patched);

  try {
    target[key] = Patched;
  } catch {
    // A read-only export (a frozen ESM namespace) cannot be replaced.
    return "unsupported-shape";
  }
  restorations.push({ target, key, original: originalFn });
  return "patched";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === "object" || typeof value === "function")
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A CJS `require` that works when this file is bundled to either module system.
 * Kept behind a seam so tests never touch the real module graph.
 */
function defaultResolve(specifier: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(specifier);
}

/** Resolve a built-in without esbuild's ESM dynamic-require shim. */
function defaultResolveBuiltinSqlite(): unknown {
  const requireFromHost = createRequire(`${process.cwd()}/package.json`);
  return requireFromHost("node:sqlite");
}

/** Per-driver patch plans. Each returns the statuses it produced. */
/** Seams patchDriver needs that are not per-statement instrumentation options. */
interface PatchContext {
  replaceModule: (specifier: string, value: unknown) => boolean;
  hostIsEsm: () => boolean;
}

function patchDriver(
  driver: AutoInstrumentDriver,
  moduleExports: unknown,
  options: InstrumentDbClientOptions,
  restorations: Restoration[],
  context: PatchContext,
): AutoInstrumentDriverResult {
  const mod = asRecord(moduleExports);
  if (!mod) {
    return {
      driver,
      status: "unsupported-shape",
      detail: "module exports are not an object",
    };
  }
  // An ESM-wrapped CJS module hides the real exports behind `default`.
  const root = asRecord(mod.default) ?? mod;

  const statuses: ReturnType<typeof patchFactory>[] = [];

  if (driver === "pg") {
    for (const key of ["Client", "Pool"]) {
      statuses.push(
        patchFactory(
          root,
          key,
          (instance) =>
            instrumentPgClient(
              instance as Parameters<typeof instrumentPgClient>[0],
              options,
            ),
          restorations,
        ),
      );
    }
  } else if (driver === "@prisma/client") {
    statuses.push(
      patchFactory(
        root,
        "PrismaClient",
        (instance) =>
          instrumentPrismaClient(
            instance as Parameters<typeof instrumentPrismaClient>[0],
            options,
          ),
        restorations,
      ),
    );
  } else if (driver === "mysql2" || driver === "mysql2/promise") {
    for (const key of ["createConnection", "createPool"]) {
      statuses.push(
        patchFactory(
          root,
          key,
          (instance) =>
            instrumentMysqlClient(
              instance as Parameters<typeof instrumentMysqlClient>[0],
              options,
            ),
          restorations,
        ),
      );
    }
  } else if (driver === "@neondatabase/serverless") {
    statuses.push(
      patchFactory(
        root,
        "neon",
        (instance) => instrumentNeonHttpQuery(instance, options),
        restorations,
      ),
    );
    for (const key of ["Client", "Pool"]) {
      statuses.push(
        patchFactory(
          root,
          key,
          (instance) =>
            instrumentPgClient(
              instance as Parameters<typeof instrumentPgClient>[0],
              options,
            ),
          restorations,
        ),
      );
    }
  } else if (driver === "@planetscale/database") {
    for (const key of ["connect", "Client"]) {
      statuses.push(
        patchFactory(
          root,
          key,
          (instance) => instrumentPlanetScaleClient(instance, options),
          restorations,
        ),
      );
    }
  } else if (driver === "better-sqlite3") {
    // better-sqlite3's export IS the Database constructor, so the factory to
    // replace lives on the module record itself, not on a named property.
    const key = typeof mod.default === "function" ? "default" : "";
    if (key) {
      statuses.push(
        patchFactory(
          mod,
          key,
          (instance) =>
            instrumentSqliteDatabase(
              instance as Parameters<typeof instrumentSqliteDatabase>[0],
              options,
            ),
          restorations,
        ),
      );
    } else {
      return {
        driver,
        status: "unsupported-shape",
        detail: "no callable default export",
      };
    }
  } else if (driver === "node:sqlite") {
    statuses.push(
      patchFactory(
        root,
        "DatabaseSync",
        (instance) =>
          instrumentSqliteDatabase(
            instance as Parameters<typeof instrumentSqliteDatabase>[0],
            options,
          ),
        restorations,
      ),
    );
    if (statuses[0] === "patched") {
      if (context.hostIsEsm()) {
        return {
          driver: "node:sqlite",
          status: "esm-unreachable",
          detail:
            "the app imports node:sqlite as an ES module, whose DatabaseSync binding cannot be replaced; call instrumentSqliteDatabase(db) on your database",
        };
      }
    }
  } else if (driver === "postgres") {
    return patchPostgresJs(moduleExports, mod, options, restorations, context);
  } else if (driver === "mssql") {
    statuses.push(
      patchFactory(
        root,
        "ConnectionPool",
        (instance) =>
          instrumentMssqlPool(
            instance as Parameters<typeof instrumentMssqlPool>[0],
            options,
          ),
        restorations,
      ),
    );
    statuses.push(
      patchFactory(
        root,
        "Transaction",
        (instance) =>
          instrumentMssqlTransaction(
            instance as Parameters<typeof instrumentMssqlTransaction>[0],
            options,
          ),
        restorations,
      ),
    );
  } else if (driver === "mongodb") {
    statuses.push(
      patchFactory(
        root,
        "MongoClient",
        (instance) =>
          instrumentMongoClient(
            instance as Parameters<typeof instrumentMongoClient>[0],
            options,
          ),
        restorations,
        enableMongoCommandMonitoring
      ),
    );
  }

  if (statuses.length === 0) {
    return { driver, status: "unsupported-shape", detail: "nothing to patch" };
  }
  if (statuses.includes("patched")) return { driver, status: "patched" };
  if (statuses.every((s) => s === "already-patched")) {
    return { driver, status: "already-patched" };
  }
  return {
    driver,
    status: "unsupported-shape",
    detail: "expected factory exports were missing",
  };
}

/**
 * postgres.js has no factory PROPERTY to replace: `module.exports` IS the
 * factory (`postgres(url, options)`), and the ESM build's default export is a
 * frozen namespace binding. So the module's whole export is swapped in the
 * loader's cache instead, which is why `autoCapture` must run before the app
 * requires its database client — the CLI's prepend-injected snippet does.
 *
 * A bundled or transpiled copy that DOES expose a writable `default` is handled
 * first, because replacing a property is strictly safer than replacing a module.
 */
function patchPostgresJs(
  moduleExports: unknown,
  mod: Record<string, unknown>,
  options: InstrumentDbClientOptions,
  restorations: Restoration[],
  context: PatchContext,
): AutoInstrumentDriverResult {
  const wrap = (instance: unknown): unknown =>
    instrumentPostgresSql(instance, options);

  if (typeof mod.default === "function") {
    const status = patchFactory(mod, "default", wrap, restorations);
    return status === "patched" || status === "already-patched"
      ? { driver: "postgres", status }
      : {
          driver: "postgres",
          status,
          detail: "default export is not writable",
        };
  }

  if (typeof moduleExports !== "function") {
    return {
      driver: "postgres",
      status: "unsupported-shape",
      detail: "module export is neither a factory nor a namespace",
    };
  }
  if (isPatched(moduleExports)) {
    return { driver: "postgres", status: "already-patched" };
  }

  // Build the wrapper with the same machinery every other driver uses, in a
  // holder object, then install the holder's result as the module's export.
  const holder: Record<string, unknown> = { factory: moduleExports };
  const holderRestorations: Restoration[] = [];
  const status = patchFactory(holder, "factory", wrap, holderRestorations);
  if (status !== "patched") {
    return {
      driver: "postgres",
      status: "unsupported-shape",
      detail: "factory could not be wrapped",
    };
  }

  if (!context.replaceModule("postgres", holder.factory)) {
    return {
      driver: "postgres",
      status: "unsupported-shape",
      detail:
        "the resolved postgres module could not be replaced in the loader cache",
    };
  }

  // `restore()` writes `target[key] = original`; this slot turns that write back
  // into a module replacement, so the driver is restorable like every other one.
  const slot = {
    set factory(value: unknown) {
      context.replaceModule("postgres", value);
    },
    get factory(): unknown {
      return undefined;
    },
  };
  restorations.push({
    target: slot as unknown as Record<string, unknown>,
    key: "factory",
    original: moduleExports,
  });

  if (context.hostIsEsm()) {
    return {
      driver: "postgres",
      status: "esm-unreachable",
      detail:
        "the app loads postgres.js as an ES module, a separate copy from the " +
        "one wrapped here; call instrumentDatabaseClient(sql) on your client",
    };
  }
  return { driver: "postgres", status: "patched" };
}

/** Replace a resolved module's export in the CommonJS loader cache. */
function defaultReplaceModule(specifier: string, value: unknown): boolean {
  try {
    const resolved = require.resolve(specifier);
    const entry = require.cache?.[resolved];
    if (!entry) return false;
    entry.exports = value;
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the host application loads its dependencies as ES modules, per the
 * nearest `package.json`. A best-effort read: when it cannot be answered the
 * answer is "no", because reporting a driver as unreachable when it is in fact
 * instrumented would send a reader to fix something that is not broken.
 */
function defaultHostIsEsm(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    let dir = process.cwd();
    for (let depth = 0; depth < 6; depth += 1) {
      const file = path.join(dir, "package.json");
      if (fs.existsSync(file)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
        return asRecord(parsed)?.type === "module";
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // An unreadable package.json is not a reason to under-report capture.
  }
  return false;
}

/**
 * Wrap every DB driver the host actually depends on, so `db.diff` evidence is
 * captured without the app writing an `instrument*` call.
 *
 * Returns a report naming what was patched and what was not, and a `restore()`
 * that undoes all of it. Never throws.
 */
export function autoInstrumentDbClients(
  options: AutoInstrumentDbOptions,
): AutoInstrumentReport {
  const {
    drivers = AUTO_INSTRUMENT_DRIVERS,
    resolve: customResolve,
    replaceModule = defaultReplaceModule,
    hostIsEsm = defaultHostIsEsm,
    onReport,
    ...instrumentOptions
  } = options;
  const resolve = customResolve ?? defaultResolve;
  // A caller-supplied resolver remains the seam for every driver. Production
  // uses createRequire for node:sqlite because bundled ESM cannot call the
  // generic dynamic require shim even though the built-in is present.
  const resolveBuiltinSqlite =
    customResolve ?? (() => defaultResolveBuiltinSqlite());

  const context: PatchContext = { replaceModule, hostIsEsm };
  const restorations: Restoration[] = [];
  const results: AutoInstrumentDriverResult[] = [];

  for (const driver of drivers) {
    let moduleExports: unknown;
    try {
      moduleExports =
        driver === "node:sqlite"
          ? resolveBuiltinSqlite(driver)
          : resolve(driver);
    } catch (error) {
      // The overwhelmingly common case: the app does not use this driver. That
      // is not a problem and must not read like one.
      results.push({
        driver,
        status: "not-installed",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      results.push(
        patchDriver(
          driver,
          moduleExports,
          instrumentOptions,
          restorations,
          context,
        ),
      );
    } catch (error) {
      results.push({
        driver,
        status: "unsupported-shape",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report: AutoInstrumentReport = {
    results,
    restore() {
      // Drain: a second call finds nothing left to undo.
      for (const { target, key, original } of restorations.splice(0)) {
        try {
          target[key] = original;
        } catch {
          // A now-frozen export cannot be restored; leaving the wrapper in place
          // is still correct behavior, just no longer removable.
        }
      }
    },
  };

  try {
    onReport?.(report);
  } catch {
    // Reporting must never break installation.
  }
  return report;
}

/**
 * One line naming what is and is not instrumented.
 *
 * It used to return an empty string whenever nothing was patched, which is
 * exactly the case worth reporting: an app whose driver this build cannot wrap
 * got a silent install and a session with no database evidence in it, and
 * nothing anywhere connected the two. Now the silence has a sentence.
 */
export function formatAutoInstrumentReport(
  report: AutoInstrumentReport,
): string {
  const patched = report.results
    .filter((r) => r.status === "patched")
    .map((r) => r.driver);
  const blocked = report.results.filter(
    (r) => r.status === "unsupported-shape" || r.status === "esm-unreachable",
  );
  const blockedTail =
    blocked.length > 0
      ? `not instrumented: ${blocked
          .map((r) => `${r.driver} (${r.detail ?? "unsupported"})`)
          .join(", ")}`
      : "";

  if (patched.length > 0) {
    return `[crumbtrail] database capture active for ${patched.join(", ")}${
      blockedTail ? `; ${blockedTail}` : ""
    }`;
  }

  if (blocked.length > 0) {
    return (
      "[crumbtrail] no database driver was instrumented, so this session will " +
      `carry no database evidence; ${blockedTail}`
    );
  }

  // The documented opt-out (`drivers: []`) attempted nothing, so there is
  // nothing to report and no silence to explain.
  if (report.results.length === 0) return "";

  const attempted = report.results.map((r) => r.driver);
  return (
    "[crumbtrail] no database driver was instrumented, so this session will " +
    "carry no database evidence: none of the supported drivers " +
    `(${attempted.join(", ")}) is installed in this application`
  );
}

/** Whether anything at all ended up wrapped. Drives whether the line is loud. */
export function autoInstrumentPatchedAnything(
  report: AutoInstrumentReport,
): boolean {
  return report.results.some((r) => r.status === "patched");
}
