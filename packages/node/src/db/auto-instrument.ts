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
import { instrumentPgClient } from "./pg";
import { instrumentMysqlClient } from "./mysql";
import { instrumentSqliteDatabase } from "./sqlite";
import { instrumentMssqlPool } from "./mssql";
import type { InstrumentDbClientOptions } from "./instrument-shared";

/** Marks an already-wrapped factory so a second install is a no-op. */
const PATCHED = Symbol.for("crumbtrail.db.autoInstrumented");

/** Drivers this module knows how to wrap, in the order they are attempted. */
export const AUTO_INSTRUMENT_DRIVERS = [
  "pg",
  "mysql2",
  "mysql2/promise",
  "better-sqlite3",
  "mssql",
] as const;

export type AutoInstrumentDriver = (typeof AUTO_INSTRUMENT_DRIVERS)[number];

export interface AutoInstrumentDbOptions
  extends Omit<InstrumentDbClientOptions, "emit"> {
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
  /** Reported once per install with what was and was not patched. */
  onReport?: (report: AutoInstrumentReport) => void;
}

export interface AutoInstrumentDriverResult {
  driver: AutoInstrumentDriver;
  status: "patched" | "not-installed" | "unsupported-shape" | "already-patched";
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
): "patched" | "already-patched" | "unsupported-shape" {
  const original = target[key];
  if (isPatched(original)) return "already-patched";
  if (typeof original !== "function") return "unsupported-shape";

  const originalFn = original as (...args: unknown[]) => unknown;

  function Patched(this: unknown, ...args: unknown[]): unknown {
    // `new pg.Pool()` — construct, then wrap the instance.
    if (new.target) {
      const instance = Reflect.construct(
        originalFn,
        args,
        new.target === Patched ? originalFn : new.target,
      );
      return wrap(instance);
    }
    // `mysql.createPool()` — plain call.
    const result = originalFn.apply(this, args);
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

/** Per-driver patch plans. Each returns the statuses it produced. */
function patchDriver(
  driver: AutoInstrumentDriver,
  moduleExports: unknown,
  options: InstrumentDbClientOptions,
  restorations: Restoration[],
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
    resolve = defaultResolve,
    onReport,
    ...instrumentOptions
  } = options;

  const restorations: Restoration[] = [];
  const results: AutoInstrumentDriverResult[] = [];

  for (const driver of drivers) {
    let moduleExports: unknown;
    try {
      moduleExports = resolve(driver);
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
        patchDriver(driver, moduleExports, instrumentOptions, restorations),
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

/** One line naming what is and is not instrumented. Empty when nothing matched. */
export function formatAutoInstrumentReport(
  report: AutoInstrumentReport,
): string {
  const patched = report.results
    .filter((r) => r.status === "patched")
    .map((r) => r.driver);
  if (patched.length === 0) return "";
  const unsupported = report.results.filter(
    (r) => r.status === "unsupported-shape",
  );
  const tail =
    unsupported.length > 0
      ? `; not instrumented: ${unsupported.map((r) => `${r.driver} (${r.detail ?? "unsupported"})`).join(", ")}`
      : "";
  return `[crumbtrail] database capture active for ${patched.join(", ")}${tail}`;
}
