import type { BugEvent } from "crumbtrail-core";
import {
  instrumentIoredisClient,
  instrumentNodeRedisClient,
  type InstrumentCacheClientOptions,
} from "./instrument";

const PATCHED = Symbol.for("crumbtrail.cache.autoInstrumented");

export const AUTO_INSTRUMENT_CACHE_DRIVERS = ["ioredis", "redis"] as const;

export type AutoInstrumentCacheDriver =
  (typeof AUTO_INSTRUMENT_CACHE_DRIVERS)[number];

export interface AutoInstrumentCacheOptions extends Omit<
  InstrumentCacheClientOptions,
  "emit"
> {
  emit: (event: BugEvent) => void;
  drivers?: readonly AutoInstrumentCacheDriver[];
  resolve?: (specifier: string) => unknown;
  replaceModule?: (specifier: string, value: unknown) => boolean;
  hostIsEsm?: () => boolean;
  onReport?: (report: AutoInstrumentCacheReport) => void;
}

export interface AutoInstrumentCacheDriverResult {
  driver: AutoInstrumentCacheDriver;
  status:
    | "patched"
    | "not-installed"
    | "unsupported-shape"
    | "already-patched"
    | "esm-unreachable";
  detail?: string;
}

export interface AutoInstrumentCacheReport {
  results: AutoInstrumentCacheDriverResult[];
  restore(): void;
}

type Restore = () => void;

export function autoInstrumentCacheClients(
  options: AutoInstrumentCacheOptions,
): AutoInstrumentCacheReport {
  const {
    drivers = AUTO_INSTRUMENT_CACHE_DRIVERS,
    resolve = defaultResolve,
    replaceModule = defaultReplaceModule,
    hostIsEsm = defaultHostIsEsm,
    onReport,
    ...instrumentOptions
  } = options;
  const restores: Restore[] = [];
  const results: AutoInstrumentCacheDriverResult[] = [];

  for (const driver of drivers) {
    let moduleExports: unknown;
    try {
      moduleExports = resolve(driver);
    } catch (error) {
      results.push({
        driver,
        status: "not-installed",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      results.push(
        driver === "ioredis"
          ? patchIoredis(
              moduleExports,
              instrumentOptions,
              restores,
              replaceModule,
              hostIsEsm,
            )
          : patchNodeRedis(moduleExports, instrumentOptions, restores),
      );
    } catch (error) {
      results.push({
        driver,
        status: "unsupported-shape",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report: AutoInstrumentCacheReport = {
    results,
    restore() {
      for (const restore of restores.splice(0).reverse()) {
        try {
          restore();
        } catch {
          // A module frozen after installation is safe to leave wrapped.
        }
      }
    },
  };
  try {
    onReport?.(report);
  } catch {
    // Reporting cannot break host startup.
  }
  return report;
}

export function formatAutoInstrumentCacheReport(
  report: AutoInstrumentCacheReport,
): string {
  const patched = report.results
    .filter((result) => result.status === "patched")
    .map((result) => result.driver);
  const blocked = report.results.filter(
    (result) =>
      result.status === "unsupported-shape" ||
      result.status === "esm-unreachable",
  );
  const blockedTail =
    blocked.length > 0
      ? `not instrumented: ${blocked
          .map(
            (result) => `${result.driver} (${result.detail ?? "unsupported"})`,
          )
          .join(", ")}`
      : "";
  if (patched.length > 0) {
    return `[crumbtrail] cache capture active for ${patched.join(", ")}${
      blockedTail ? `; ${blockedTail}` : ""
    }`;
  }
  if (report.results.length === 0) return "";
  if (blocked.length > 0) {
    return `[crumbtrail] no cache driver was instrumented; ${blockedTail}`;
  }
  return "";
}

export function autoInstrumentCachePatchedAnything(
  report: AutoInstrumentCacheReport,
): boolean {
  return report.results.some((result) => result.status === "patched");
}

function patchNodeRedis(
  moduleExports: unknown,
  options: InstrumentCacheClientOptions,
  restores: Restore[],
): AutoInstrumentCacheDriverResult {
  const mod = asRecord(moduleExports);
  if (!mod) return unsupported("redis", "module exports are not an object");
  const root = asRecord(mod.default) ?? mod;
  const statuses = ["createClient", "createCluster"].map((key) =>
    patchFactory(
      root,
      key,
      (client) => instrumentNodeRedisClient(asRecord(client) ?? {}, options),
      restores,
    ),
  );
  return summarizeStatuses("redis", statuses);
}

function patchIoredis(
  moduleExports: unknown,
  options: InstrumentCacheClientOptions,
  restores: Restore[],
  replaceModule: (specifier: string, value: unknown) => boolean,
  hostIsEsm: () => boolean,
): AutoInstrumentCacheDriverResult {
  const wrap = (client: unknown) =>
    instrumentIoredisClient(asRecord(client) ?? {}, options);
  if (typeof moduleExports === "function") {
    if (isPatched(moduleExports)) {
      return { driver: "ioredis", status: "already-patched" };
    }
    const wrapped = wrapFactory(
      moduleExports as (...args: unknown[]) => unknown,
      wrap,
    );
    wrapIoredisStatics(
      moduleExports as (...args: unknown[]) => unknown,
      wrapped,
      wrap,
    );
    if (!replaceModule("ioredis", wrapped)) {
      return unsupported(
        "ioredis",
        "the resolved module could not be replaced in the loader cache",
      );
    }
    restores.push(() => {
      replaceModule("ioredis", moduleExports);
    });
    if (hostIsEsm()) {
      return {
        driver: "ioredis",
        status: "esm-unreachable",
        detail:
          "the app loads ioredis as an ES module, a separate copy from the one wrapped here; call instrumentIoredisClient(client)",
      };
    }
    return { driver: "ioredis", status: "patched" };
  }

  const mod = asRecord(moduleExports);
  if (!mod) return unsupported("ioredis", "module exports are not an object");
  const statuses = ["default", "Redis", "Cluster"].map((key) =>
    patchFactory(mod, key, wrap, restores),
  );
  return summarizeStatuses("ioredis", statuses);
}

function wrapIoredisStatics(
  original: (...args: unknown[]) => unknown,
  wrapped: (...args: unknown[]) => unknown,
  wrap: (instance: unknown) => unknown,
): void {
  const source = asRecord(original);
  const target = asRecord(wrapped);
  if (!source || !target) return;
  for (const key of ["default", "Redis", "Cluster"]) {
    const factory = source[key];
    if (typeof factory !== "function") continue;
    try {
      target[key] =
        factory === original
          ? wrapped
          : wrapFactory(factory as (...args: unknown[]) => unknown, wrap);
    } catch {
      // A resistant static export does not prevent the primary constructor patch.
    }
  }
}

function patchFactory(
  target: Record<string, unknown>,
  key: string,
  wrap: (instance: unknown) => unknown,
  restores: Restore[],
): "patched" | "already-patched" | "unsupported-shape" {
  const original = target[key];
  if (isPatched(original)) return "already-patched";
  if (typeof original !== "function") return "unsupported-shape";
  const wrapped = wrapFactory(
    original as (...args: unknown[]) => unknown,
    wrap,
  );
  try {
    target[key] = wrapped;
  } catch {
    return "unsupported-shape";
  }
  restores.push(() => {
    target[key] = original;
  });
  return "patched";
}

function wrapFactory(
  original: (...args: unknown[]) => unknown,
  wrap: (instance: unknown) => unknown,
): (...args: unknown[]) => unknown {
  function Patched(this: unknown, ...args: unknown[]): unknown {
    const instance = new.target
      ? Reflect.construct(
          original,
          args,
          new.target === Patched ? original : new.target,
        )
      : original.apply(this, args);
    return isThenable(instance) ? instance.then(wrap) : wrap(instance);
  }
  try {
    Object.setPrototypeOf(Patched, original);
    Patched.prototype = original.prototype as object;
    Object.defineProperty(Patched, "name", { value: original.name });
    Object.defineProperty(Patched, PATCHED, { value: true });
  } catch {
    // Identity affordances are best effort; the factory remains callable.
  }
  return Patched;
}

function summarizeStatuses(
  driver: AutoInstrumentCacheDriver,
  statuses: Array<"patched" | "already-patched" | "unsupported-shape">,
): AutoInstrumentCacheDriverResult {
  if (statuses.includes("patched")) return { driver, status: "patched" };
  if (statuses.every((status) => status === "already-patched")) {
    return { driver, status: "already-patched" };
  }
  return unsupported(driver, "expected factory exports were missing");
}

function unsupported(
  driver: AutoInstrumentCacheDriver,
  detail: string,
): AutoInstrumentCacheDriverResult {
  return { driver, status: "unsupported-shape", detail };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === "object" || typeof value === "function")
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPatched(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[PATCHED] === true
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function defaultResolve(specifier: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(specifier);
}

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
    // Unknown host module mode is not proof of an unreachable patch.
  }
  return false;
}
