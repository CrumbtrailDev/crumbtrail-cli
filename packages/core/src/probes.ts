/**
 * Live probes — a named, permissioned, bounded introspection registry.
 *
 * A probe answers one question about the running application and answers it as a table, because a
 * table is what a coding agent can read and a paragraph is not. Probes run inside a customer's live
 * app, so every bound here is load bearing rather than defensive decoration.
 *
 * Four rules, taken from the discipline of the hosted evidence fan out
 * (`packages/cloud/src/evidence-sources/fetch-all.ts` in the crumbtrail repository — a different
 * repository and a different package, so this is the discipline copied, never the code imported):
 *
 * 1. `runProbe` never throws and never rejects. Every failure becomes `ok: false` plus a short
 *    reason.
 * 2. One `AbortController` and one `Promise.race` deadline per probe. A probe that hangs is
 *    abandoned at the deadline and the signal fires so a cooperative probe can stop early.
 * 3. A row cap and a serialized byte cap, folded in row order, so a repeat run on the same input
 *    drops exactly the same rows.
 * 4. `ok` is derived by this framework. A probe cannot declare itself healthy; it either returns a
 *    table or it throws, and this module decides what that means.
 *
 * Security: a probe is selected by a name from {@link PROBE_NAMES} and takes nothing else. No
 * selector, no URL, no expression, no path. A probe that could be parameterised by a server would
 * be a remote code execution surface in someone else's production application.
 *
 * This module is pure: no transport, no module level mutable state, and no timer beyond the one
 * deadline each `runProbe` call owns and clears.
 */

import { buildEnvSnapshot } from "./collectors/environment";
import {
  redactProbeStorageKey,
  redactStoredValue,
  redactTokenLikeString,
  redactUrl,
  redactUrlsInText,
  redactValue,
} from "./redaction";
import { safeStringify, truncate } from "./utils";

/* ------------------------------------------------------------------ */
/* Allowlist                                                           */
/* ------------------------------------------------------------------ */

/**
 * The complete set of probes that can ever run. Frozen, and the only accepted input to
 * {@link runProbe}. Adding a name here is the whole of adding a probe's permission surface.
 */
export const PROBE_NAMES = Object.freeze([
  "runtime.env",
  "runtime.cpu_profile",
  "storage.snapshot",
  "network.inflight",
  "flags.current",
] as const);

export type ProbeName = (typeof PROBE_NAMES)[number];

const PROBE_NAME_SET: ReadonlySet<string> = new Set<string>(PROBE_NAMES);

/** Exact membership test against the frozen allowlist. No normalization, by design. */
export function isProbeName(value: unknown): value is ProbeName {
  return typeof value === "string" && PROBE_NAME_SET.has(value);
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

/** Wall clock budget for one probe. Short, because this runs in a user's live application. */
export const PROBE_DEFAULT_TIMEOUT_MS = 2_000;
export const PROBE_MAX_TIMEOUT_MS = 10_000;

/** Rows kept before truncation. */
export const PROBE_DEFAULT_MAX_ROWS = 200;
export const PROBE_MAX_MAX_ROWS = 5_000;

/** Serialized bytes kept before truncation, measured over the rows only. */
export const PROBE_DEFAULT_MAX_BYTES = 32_768;
export const PROBE_MAX_MAX_BYTES = 262_144;

/** Maximum number of function rows a CPU profile may expose. */
export const CPU_PROFILE_MAX_FUNCTIONS = 50;

/** Fixed sampling window used by the Node executor. Core only validates this bound. */
export const CPU_PROFILE_MAX_DURATION_MS = 2_000;

/** Maximum count any CPU profile scalar may report. */
export const CPU_PROFILE_MAX_SAMPLE_COUNT = 1_000_000;

const CPU_PROFILE_FUNCTION_NAME_MAX_LENGTH = 160;
const CPU_PROFILE_URL_MAX_LENGTH = 512;
const CPU_PROFILE_SOURCE_POSITION_MAX = 1_000_000_000;

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** The minimum of the Web Storage surface a snapshot needs. */
export interface ProbeStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export interface ProbeStorageArea {
  /** Area label carried into the `area` column, e.g. `localStorage`. */
  area: string;
  storage: ProbeStorageLike;
}

/** Feature flags and runtime config an application declared through `setEnv`. */
export interface ProbeEnvDeclaration {
  flags?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

/** One privacy-safe function row from a Node CPU profile. */
export interface CpuProfileFunction {
  functionName: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  selfSamples: number;
}

/** The only profile data allowed to cross the SDK event boundary. */
export interface CpuProfileProbeData {
  durationMs: number;
  sampleCount: number;
  topFunctions: CpuProfileFunction[];
}

/** Host-provided implementation for the Node-only CPU profile probe. */
export type CpuProfileProbeExecutor = (
  signal: AbortSignal,
) => Awaitable<CpuProfileProbeData>;

type Awaitable<T> = T | Promise<T>;

/**
 * Everything a probe is allowed to read. Supplied by the host (the SDK instance), never by a
 * server. A source the host does not supply makes its probe report `ok: false, error: "unavailable"`
 * rather than silently returning an empty table, so "nothing to report" and "cannot report" stay
 * distinguishable.
 */
export interface ProbeContext {
  /**
   * Backs `flags.current`. Mirrors `CollectorContext.getDeclaredEnv`.
   *
   * Every supplier receives the probe's deadline signal, so a host that does real work to answer
   * can stop when the probe has already been abandoned.
   */
  getDeclaredEnv?: (
    signal: AbortSignal,
  ) => Awaitable<ProbeEnvDeclaration | undefined>;
  /**
   * Backs `network.inflight`, by reading the `network.pending` live state provider the network
   * collector already registers (`collectors/network.ts`). Mirrors the registry on the SDK
   * instance; returns `undefined` when no provider of that name is registered.
   */
  getState?: (name: string, signal: AbortSignal) => Awaitable<unknown>;
  /** Backs `storage.snapshot`. Defaults to the ambient `localStorage` and `sessionStorage`. */
  getStorageAreas?: (
    signal: AbortSignal,
  ) => Awaitable<Iterable<ProbeStorageArea> | undefined>;
  /**
   * Node-only CPU profile executor. Browser/core callers must omit this and
   * receive `unavailable` for `runtime.cpu_profile`.
   */
  getCpuProfile?: CpuProfileProbeExecutor;
  /**
   * True only when the config poll was authenticated by this exact runtime
   * binding. CPU profiling never runs from an untargeted poll.
   */
  runtimeTargeted?: boolean;
  /** Clock, for latency. Injectable so tests are not wall clock dependent. */
  now?: () => number;
  /** Per probe deadline in ms. Clamped to `[1, PROBE_MAX_TIMEOUT_MS]`. */
  timeoutMs?: number;
  /** Row cap. Clamped to `[1, PROBE_MAX_MAX_ROWS]`. */
  maxRows?: number;
  /** Serialized byte cap over the rows. Clamped to `[256, PROBE_MAX_MAX_BYTES]`. */
  maxBytes?: number;
}

/**
 * One probe's answer.
 *
 * `rowCount` is the number of rows actually returned, i.e. `rows.length`. It is not a total of what
 * existed before capping — `truncated` is the signal that something was dropped.
 */
export interface ProbeResult {
  name: string;
  /** Derived here, never supplied by a probe. True only when the probe produced a table. */
  ok: boolean;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  latencyMs: number;
  /** CPU profile summary fields. Present only for a successful CPU profile. */
  durationMs?: number;
  sampleCount?: number;
  topFunctions?: CpuProfileFunction[];
  /**
   * Why the probe produced nothing. Bounded and redacted. Present when and only when `ok` is
   * false. Either a framework reason (`unknown probe`, `timeout`, `unavailable`) or the probe's own
   * thrown message after redaction.
   */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

interface ProbeTable {
  columns: string[];
  rows: unknown[][];
  /** Set by a probe that already dropped rows at its own source. */
  truncated?: boolean;
  /** Specialized bounded payload for `runtime.cpu_profile`. */
  cpuProfile?: CpuProfileProbeData;
}

type ProbeFn = (ctx: ProbeContext, signal: AbortSignal) => Promise<ProbeTable>;

interface ResolvedLimits {
  timeoutMs: number;
  maxRows: number;
  maxBytes: number;
}

/** A source the host did not supply. Reported as `unavailable`, distinct from an empty table. */
const UNAVAILABLE = "unavailable";

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveLimits(ctx: ProbeContext): ResolvedLimits {
  return {
    timeoutMs: clampInt(
      ctx.timeoutMs,
      PROBE_DEFAULT_TIMEOUT_MS,
      1,
      PROBE_MAX_TIMEOUT_MS,
    ),
    maxRows: clampInt(ctx.maxRows, PROBE_DEFAULT_MAX_ROWS, 1, PROBE_MAX_MAX_ROWS),
    maxBytes: clampInt(
      ctx.maxBytes,
      PROBE_DEFAULT_MAX_BYTES,
      256,
      PROBE_MAX_MAX_BYTES,
    ),
  };
}

/**
 * UTF-8 length without `Buffer` or `TextEncoder`, so the byte cap is identical in every runtime the
 * browser SDK ships into and identical between two runs on the same input.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: four bytes, and the low half is consumed with it.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * A name that failed the allowlist is still echoed back so an agent can see what was refused, but it
 * is attacker controlled text. Strip it to the probe name alphabet and bound it, so nothing command
 * shaped, path shaped or URL shaped survives into a stored event.
 */
function sanitizeRefusedName(value: unknown): string {
  if (typeof value !== "string") return "";
  return truncate(value.replace(/[^A-Za-z0-9._-]/g, ""), 64);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/**
 * A thrown message is untrusted — it can embed a credential or a tokenized URL — so it crosses the
 * same redaction boundary as any captured value before it is allowed to rest.
 */
function redactErrorMessage(error: unknown): string {
  const raw = truncate(messageOf(error), 300);
  const withoutUrls = redactUrlsInText(raw, "probe.error").value;
  return redactTokenLikeString(withoutUrls, "probe.error").value;
}

function failure(name: string, error: string, latencyMs: number): ProbeResult {
  return {
    name,
    ok: false,
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    latencyMs,
    error,
  };
}

/**
 * Apply the row cap and then the byte cap, folding rows in the order the probe produced them and
 * dropping from the tail. Both caps are pure functions of the rows, so the same table capped twice
 * yields the same rows twice.
 */
function capTable(
  name: string,
  table: ProbeTable,
  limits: ResolvedLimits,
  latencyMs: number,
): ProbeResult {
  if (table.cpuProfile) {
    return {
      name,
      ok: true,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      latencyMs,
      ...sanitizeCpuProfileData(table.cpuProfile),
    };
  }

  const columns = table.columns.map((column) => truncate(String(column), 64));
  let truncated = table.truncated === true;

  const withinRowCap = table.rows.slice(0, limits.maxRows);
  if (table.rows.length > withinRowCap.length) truncated = true;

  const rows: unknown[][] = [];
  let runningBytes = 0;
  for (const row of withinRowCap) {
    const size = utf8ByteLength(safeStringify(row));
    if (runningBytes + size > limits.maxBytes) {
      truncated = true;
      break;
    }
    rows.push(row);
    runningBytes += size;
  }

  return {
    name,
    ok: true,
    columns,
    rows,
    rowCount: rows.length,
    truncated,
    latencyMs,
  };
}

function boundedProfileNumber(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return Math.min(max, Math.floor(value));
}

function boundedProfileString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? truncate(trimmed, maxLength) : undefined;
}

function boundedProfileUrl(value: unknown): string | undefined {
  const url = boundedProfileString(value, CPU_PROFILE_URL_MAX_LENGTH);
  if (!url) return undefined;
  try {
    return boundedProfileString(
      redactUrl(url, "probe.runtime.cpu_profile.url").value,
      CPU_PROFILE_URL_MAX_LENGTH,
    );
  } catch {
    return undefined;
  }
}

function normalizedProfileFunctionName(value: unknown): string {
  const name = boundedProfileString(
    value,
    CPU_PROFILE_FUNCTION_NAME_MAX_LENGTH,
  );
  if (!name || name === "(anonymous)" || name === "(program)")
    return "(anonymous)";
  if (
    ["(root)", "(idle)", "(garbage collector)"].includes(name) ||
    name.startsWith("internal/") ||
    name.startsWith("node:internal/")
  )
    return "[internal]";
  return name;
}

/** Copy only the fixed CPU profile schema into the public probe result. */
function sanitizeCpuProfileData(
  value: CpuProfileProbeData,
): Pick<ProbeResult, "durationMs" | "sampleCount" | "topFunctions"> {
  const durationMs = boundedProfileNumber(
    value?.durationMs,
    CPU_PROFILE_MAX_DURATION_MS,
  );
  const sampleCount = boundedProfileNumber(
    value?.sampleCount,
    CPU_PROFILE_MAX_SAMPLE_COUNT,
  );
  if (durationMs === undefined || sampleCount === undefined)
    throw new Error("malformed cpu profile");
  if (!Array.isArray(value.topFunctions))
    throw new Error("malformed cpu profile");

  const topFunctions: CpuProfileFunction[] = [];
  for (const row of value.topFunctions.slice(0, CPU_PROFILE_MAX_FUNCTIONS)) {
    if (!row || typeof row !== "object") continue;
    const source = row as unknown as Record<string, unknown>;
    const selfSamples = boundedProfileNumber(
      source.selfSamples,
      CPU_PROFILE_MAX_SAMPLE_COUNT,
    );
    if (selfSamples === undefined) continue;
    const functionName = normalizedProfileFunctionName(source.functionName);
    const url = boundedProfileUrl(source.url);
    const lineNumber = boundedProfileNumber(
      source.lineNumber,
      CPU_PROFILE_SOURCE_POSITION_MAX,
    );
    const columnNumber = boundedProfileNumber(
      source.columnNumber,
      CPU_PROFILE_SOURCE_POSITION_MAX,
    );
    topFunctions.push({
      functionName,
      ...(url ? { url } : {}),
      ...(lineNumber !== undefined ? { lineNumber } : {}),
      ...(columnNumber !== undefined ? { columnNumber } : {}),
      selfSamples,
    });
  }

  return { durationMs, sampleCount, topFunctions };
}

/**
 * The clock a probe run measures itself with. A host supplied `now` is used when it answers a
 * finite number and `Date.now` stands in whenever it throws or answers anything else, so no
 * latency reading can fail the run it is only describing.
 */
function safeClock(now: ProbeContext["now"]): () => number {
  if (typeof now !== "function") return Date.now;
  return () => {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : Date.now();
    } catch {
      return Date.now();
    }
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("aborted");
}

/* ------------------------------------------------------------------ */
/* Built in probes                                                     */
/* ------------------------------------------------------------------ */

/**
 * What runtime is this. Reuses `buildEnvSnapshot`, which already guards every ambient global it
 * reads and degrades to whatever is available outside a browser.
 */
const runtimeEnvProbe: ProbeFn = async (_ctx, signal) => {
  throwIfAborted(signal);
  const snapshot = buildEnvSnapshot();
  const flat: Record<string, unknown> = {};

  if (snapshot.userAgent) flat.userAgent = snapshot.userAgent;
  if (snapshot.browser) {
    flat.browser = snapshot.browser.name;
    if (snapshot.browser.version) flat.browserVersion = snapshot.browser.version;
  }
  if (snapshot.os) flat.os = snapshot.os;
  if (snapshot.viewport) {
    flat.viewportWidth = snapshot.viewport.w;
    flat.viewportHeight = snapshot.viewport.h;
  }
  if (snapshot.locale) flat.locale = snapshot.locale;
  if (snapshot.timezone) flat.timezone = snapshot.timezone;
  if (snapshot.appBuild) flat.appBuild = snapshot.appBuild;

  const redacted = redactValue(flat, "probe.runtime.env").value;
  const rows = Object.keys(redacted)
    .sort()
    .map((key) => [key, redacted[key]]);

  return { columns: ["key", "value"], rows };
};

/**
 * What the app has stashed in Web Storage right now.
 *
 * Read this one against who answers it. A probe is taken by whichever application instance polls
 * next, so the storage described here belongs to some visitor who is present, not to the session an
 * agent is investigating and not to anyone involved in the defect. That makes the ordinary storage
 * collector's key handling wrong here: the collector is recording the session that actually hit the
 * bug, so it can emit a key verbatim, and `session:alice@example.com:cart` from a bystander is a
 * different thing entirely.
 *
 * So keys go through {@link redactProbeStorageKey}, which keeps the shape and drops every span that
 * could name a person, and values go through the collector's `redactStoredValue`, which replaces
 * every non empty value unconditionally. What is left answers the question the probe is for: which
 * keys exist, how many, and which patterns they follow. The raw byte length survives redaction,
 * because "this key holds 40KB" is the useful part.
 */
const storageSnapshotProbe: ProbeFn = async (ctx, signal) => {
  const supplied = ctx.getStorageAreas
    ? await ctx.getStorageAreas(signal)
    : ambientStorageAreas();
  throwIfAborted(signal);
  const areas = supplied ? Array.from(supplied) : [];
  if (areas.length === 0) throw new Error(UNAVAILABLE);

  const rows: unknown[][] = [];
  for (const { area, storage } of areas) {
    const label = truncate(String(area), 32);
    const length = typeof storage?.length === "number" ? storage.length : 0;
    for (let index = 0; index < length; index += 1) {
      throwIfAborted(signal);
      const key = storage.key(index);
      if (key === null) continue;
      const raw = storage.getItem(key);
      const keyResult = redactProbeStorageKey(key, `${label}.key`);
      const valueResult = redactStoredValue(raw, {
        key,
        path: `${label}.${keyResult.value}.value`,
      });
      rows.push([
        label,
        keyResult.value,
        valueResult.value ?? "",
        utf8ByteLength(raw ?? ""),
      ]);
    }
  }

  return { columns: ["area", "key", "value", "bytes"], rows };
};

function ambientStorageAreas(): ProbeStorageArea[] {
  const areas: ProbeStorageArea[] = [];
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = (globalThis as Record<string, unknown>)[area] as
        | ProbeStorageLike
        | undefined;
      if (
        storage &&
        typeof storage.length === "number" &&
        typeof storage.key === "function" &&
        typeof storage.getItem === "function"
      ) {
        areas.push({ area, storage });
      }
    } catch {
      // Storage access throws outright when the browser blocks site data.
    }
  }
  return areas;
}

/**
 * What requests are still open right now. Reads the `network.pending` live state provider the
 * network collector already registers; there is no browser API for this, so an app running without
 * the network collector reports `unavailable` rather than an empty table.
 */
const networkInflightProbe: ProbeFn = async (ctx, signal) => {
  if (!ctx.getState) throw new Error(UNAVAILABLE);
  const state = await ctx.getState("network.pending", signal);
  throwIfAborted(signal);
  if (state == null) throw new Error(UNAVAILABLE);
  if (!Array.isArray(state)) throw new Error("malformed pending state");

  const rows = state.map((entry) => {
    const record = (
      entry && typeof entry === "object" ? entry : {}
    ) as Record<string, unknown>;
    const method = truncate(String(record.method ?? ""), 16);
    const url =
      typeof record.url === "string"
        ? redactUrl(record.url, "probe.network.inflight.url").value
        : "";
    const ageMs =
      typeof record.ageMs === "number" && Number.isFinite(record.ageMs)
        ? record.ageMs
        : null;
    return [method, url, ageMs];
  });

  return { columns: ["method", "url", "ageMs"], rows };
};

/**
 * What the app believes its flags and config are. Values cross `redactValue`, the same boundary the
 * environment collector puts declared env through before it rests in a `k:'env'` event.
 */
const flagsCurrentProbe: ProbeFn = async (ctx, signal) => {
  if (!ctx.getDeclaredEnv) throw new Error(UNAVAILABLE);
  const declared = await ctx.getDeclaredEnv(signal);
  throwIfAborted(signal);
  if (declared == null) throw new Error(UNAVAILABLE);

  const rows: unknown[][] = [];
  for (const scope of ["flag", "config"] as const) {
    const source = scope === "flag" ? declared.flags : declared.config;
    if (!source || typeof source !== "object") continue;
    const redacted = redactValue(
      { ...source } as Record<string, unknown>,
      `probe.flags.${scope}`,
    ).value;
    for (const key of Object.keys(redacted).sort()) {
      rows.push([scope, key, redacted[key]]);
    }
  }

  return { columns: ["scope", "key", "value"], rows };
};

/**
 * A CPU profile is a Node capability, not a browser capability. The targeted
 * bit is checked before the host executor is called so an old Cloud response
 * cannot make a bystander profile itself.
 */
const runtimeCpuProfileProbe: ProbeFn = async (ctx, signal) => {
  if (!ctx.runtimeTargeted || !ctx.getCpuProfile) throw new Error(UNAVAILABLE);
  throwIfAborted(signal);
  const profile = await ctx.getCpuProfile(signal);
  throwIfAborted(signal);
  return { columns: [], rows: [], cpuProfile: profile };
};

const BUILT_IN_PROBES: Readonly<Record<ProbeName, ProbeFn>> = Object.freeze({
  "runtime.env": runtimeEnvProbe,
  "runtime.cpu_profile": runtimeCpuProfileProbe,
  "storage.snapshot": storageSnapshotProbe,
  "network.inflight": networkInflightProbe,
  "flags.current": flagsCurrentProbe,
});

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run one allowlisted probe. Resolves to a {@link ProbeResult} in every case and rejects in none.
 *
 * An unknown name runs nothing at all: the allowlist is checked against the raw string before any
 * sanitizing, so no amount of punctuation can be normalized into a name that is on the list.
 */
export async function runProbe(
  name: string,
  ctx: ProbeContext = {},
): Promise<ProbeResult> {
  // Rule 1 is absolute, and the host's clock is host code: a `ctx.now` that throws must not turn
  // into an exception raised inside someone else's application. Wrapped once here so every later
  // reading, including the ones taken while handling a failure, is safe.
  const nowFn = safeClock(ctx.now);
  const start = nowFn();

  if (!isProbeName(name)) {
    return failure(sanitizeRefusedName(name), "unknown probe", 0);
  }

  const limits = resolveLimits(ctx);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, limits.timeoutMs);
  });

  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => BUILT_IN_PROBES[name](ctx, controller.signal))
        .then(
          (table) => ({ table }) as const,
          (error) => ({ error }) as const,
        ),
      deadline,
    ]);

    const latencyMs = Math.max(0, nowFn() - start);

    if ("timedOut" in outcome) return failure(name, "timeout", latencyMs);
    if ("error" in outcome) {
      return failure(name, redactErrorMessage(outcome.error), latencyMs);
    }
    return capTable(name, outcome.table, limits, latencyMs);
  } catch (error) {
    // Unreachable through the paths above, which already fold rejection into `outcome`. Kept
    // because rule 1 is absolute: a defect in the capping code must not become an exception
    // thrown inside someone else's application.
    return failure(name, redactErrorMessage(error), Math.max(0, nowFn() - start));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
