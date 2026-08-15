/**
 * Shared plumbing for the `crumbtrail-core` wire-contract conformance tests.
 *
 * `test-fixtures/wire-contract/` is the machine readable form of
 * `docs/specs/native-sdk-wire-contract.md`. The Swift, Kotlin and Dart SDKs each
 * read those same files and assert their own serialisation matches, so a field
 * rename that would otherwise drift silently through several languages fails
 * every suite at once. This module is the `crumbtrail-core` end of that.
 *
 * Two deliberate choices, both copied from the Swift and Kotlin loaders:
 *
 * 1. **The fixtures are read from the repo root, never copied into the
 *    package.** A per SDK copy is a second source of truth, and a fixture set
 *    that can drift per SDK fails to catch the exact drift it exists to catch.
 *    See the comment in `packages/swift/Package.swift`, which argues the same
 *    point for a SwiftPM bundled resource.
 * 2. **Comparison goes through a canonical writer, not raw file text.** The
 *    fixtures are pretty printed with two space indentation; an SDK payload is
 *    not. Re-serialising both sides through {@link canonicalJson} makes the
 *    comparison structural — about keys and values, not about whitespace or the
 *    order a language happened to build an object in.
 *
 * This file is consumed by `wire-contract.test.ts` and is intended to be
 * consumed unchanged by the per kind and transport conformance suites that
 * follow it. Add to it rather than forking it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BugEvent, TargetDescriptor } from "../types";

/**
 * Fixed values the fixtures are written with, so they are byte comparable.
 *
 * A conformance test substitutes its SDK's real name and version before
 * comparing, and asserts everything else verbatim.
 */
export const FIXTURE_TIMESTAMP = 1_754_000_000_000;

/** @see FIXTURE_TIMESTAMP */
export const FIXTURE_SDK = {
  name: "crumbtrail-fixture",
  version: "0.0.0-fixture",
} as const;

/** @see FIXTURE_TIMESTAMP */
export const FIXTURE_CAPABILITIES: string[] = ["app-lifecycle", "device-info"];

/**
 * How many files `test-fixtures/wire-contract/events/` holds.
 *
 * Asserted by the suite so that adding a fixture without adding a matching
 * `crumbtrail-core` assertion fails here, loudly, rather than passing silently
 * while the reference implementation is quietly exempt from the new kind.
 */
export const EVENT_FIXTURE_COUNT = 12;

/**
 * Keys that make a target descriptor identify something.
 *
 * From `docs/specs/native-sdk-wire-contract.md`: "At least one identifying key
 * must be present, or omit `target` entirely." The deprecated `testId`,
 * `accessibilityLabel`, `text`, `viewName`, `screen` and `selector` spellings
 * are deliberately NOT identity — the spec says not to send them at all, so a
 * descriptor made only of those is not a conformant target.
 */
export const TARGET_IDENTITY_KEYS = [
  "role",
  "label",
  "testID",
  "accessibilityId",
  "componentName",
  "routePath",
  "ancestryHash",
] as const satisfies readonly (keyof TargetDescriptor)[];

const RELATIVE_FIXTURE_PATH = join("test-fixtures", "wire-contract");

let cachedFixtureDir: string | undefined;

/**
 * Absolute path of `test-fixtures/wire-contract/`, found by walking up from this
 * file rather than from the process CWD.
 *
 * CWD is not reliable here: vitest can be invoked from the package or from the
 * monorepo root, and `packages/core/vitest.config.ts` already documents one bug
 * caused by anchoring a path to the CWD.
 *
 * Throws rather than returning a best guess. A silently wrong directory would
 * make every downstream assertion compare against an empty string and pass.
 */
export function wireContractDir(): string {
  if (cachedFixtureDir !== undefined) return cachedFixtureDir;

  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    const candidate = join(dir, RELATIVE_FIXTURE_PATH);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      cachedFixtureDir = candidate;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `repo root not found: no ${RELATIVE_FIXTURE_PATH} directory above ${start}`,
      );
    }
    dir = parent;
  }
}

/** Raw text of `events/<name>.json`, exactly as it sits on disk. */
export function readEventFixtureText(name: string): string {
  return readFileSync(
    join(wireContractDir(), "events", `${name}.json`),
    "utf8",
  );
}

/** Parsed `events/<name>.json`. */
export function readEventFixture(name: string): Record<string, unknown> {
  return JSON.parse(readEventFixtureText(name)) as Record<string, unknown>;
}

/** Canonical JSON text of `events/<name>.json`, ready to compare against. */
export function eventFixtureCanonical(name: string): string {
  return canonicalJson(readEventFixture(name));
}

/** Parsed `transport.json`. */
export function readTransportFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(wireContractDir(), "transport.json"), "utf8"),
  ) as Record<string, unknown>;
}

/** Fixture base names under `events/`, sorted, without the `.json` suffix. */
export function listEventFixtureNames(): string[] {
  return readdirSync(join(wireContractDir(), "events"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/**
 * Serialise a value to JSON with a deterministic byte output.
 *
 * Mirrors the Kotlin writer in `packages/kotlin/.../JsonValue.kt` so both sides
 * of a cross language comparison normalise identically:
 *
 * - object keys are sorted;
 * - `undefined` valued keys are dropped, because an absent field and a null one
 *   are different claims on the ingest side, and "we did not observe this" is
 *   almost always the true one. An explicit `null` is preserved;
 * - whole numbers lose any trailing decimal, so `402.0` and `402` are the same
 *   token rather than two tokens that fail a byte comparison;
 * - control characters are `\u` escaped, or the payload is not valid JSON and
 *   ingest rejects the whole batch.
 *
 * Throws on anything JSON cannot carry (a function, a symbol, `NaN`,
 * `Infinity`) instead of quietly emitting `null` the way `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return formatNumber(value);
    case "string":
      return quoteString(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson cannot serialise ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const body = entries
    .map(([key, entry]) => `${quoteString(key)}:${canonicalJson(entry)}`)
    .join(",");
  return `{${body}}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`canonicalJson cannot serialise the number ${value}`);
  }
  // Below 1e15 a whole number is exactly representable and `toFixed(0)` is
  // plain digits. Above it, `String` switches to exponent form — which is what
  // `JSON.stringify` emits too, so both sides still agree.
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return Object.is(value, -0) ? "0" : value.toFixed(0);
  }
  return String(value);
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

function quoteString(value: string): string {
  let out = '"';
  for (const char of value) {
    const short = SHORT_ESCAPES[char];
    if (short !== undefined) {
      out += short;
    } else if (char < " ") {
      out += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

/** True when a target descriptor names an element rather than only locating one. */
export function targetIdentifiesSomething(
  target: TargetDescriptor | undefined,
): boolean {
  if (!target) return false;
  return TARGET_IDENTITY_KEYS.some((key) => {
    const value = (target as Record<string, unknown>)[key];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * The wire form of a `BugEvent`, as an ordinary object.
 *
 * This is the reference envelope encoder the conformance suites compare
 * against. It applies exactly the two omission rules the spec states and the
 * Kotlin SDK implements:
 *
 * - an empty `capabilities` array is omitted rather than sent empty, because an
 *   absent field and an empty array are different claims;
 * - a `target` that identifies nothing — bounds only, say — is dropped, since it
 *   names no element and costs payload on every event.
 *
 * What it deliberately does NOT do is invent values. `schemaVersion` and
 * `platform` are optional on a `BugEvent` (absent means `1` and `web`, for
 * backward compatibility with the browser SDKs), and this encoder passes that
 * absence through rather than defaulting it. A conformance test that needs them
 * present sets them on the event, which is what a native SDK does.
 */
export function toWireEnvelope(event: BugEvent): Record<string, unknown> {
  const capabilities =
    event.capabilities && event.capabilities.length > 0
      ? [...event.capabilities]
      : undefined;

  return {
    t: event.t,
    k: event.k,
    d: event.d,
    schemaVersion: event.schemaVersion,
    platform: event.platform,
    sdk: event.sdk ? { ...event.sdk } : undefined,
    capabilities,
    target: targetIdentifiesSomething(event.target) ? event.target : undefined,
    sessionId: event.sessionId,
    offsetMs: event.offsetMs,
  };
}

/** Canonical JSON text of a `BugEvent`'s wire form. */
export function encodeWireEvent(event: BugEvent): string {
  return canonicalJson(toWireEnvelope(event));
}
