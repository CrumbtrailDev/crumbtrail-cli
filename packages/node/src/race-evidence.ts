import { createHmac } from "node:crypto";

/** The event planes that can carry bounded cross session race evidence. */
export type RaceEvidenceSurface = "db.diff" | "db.read" | "cache";

/**
 * Fixed format identifiers accepted by the race evidence contract.
 *
 * The names intentionally do not promise that a value was produced by a hash.
 * An application without a server credential may provide an already opaque id
 * in the same fixed format.
 */
export interface RaceEvidenceIdentifiers {
  resourceHash?: string;
  entityHash?: string;
  versionHash?: string;
  beforeVersionHash?: string;
  afterVersionHash?: string;
}

/** Context supplied to an application resolver. Raw values are never retained by this module. */
export interface RaceEvidenceResolverInput {
  surface: RaceEvidenceSurface;
  operation: string;
  table?: string;
  primaryKey?: Record<string, unknown> | null;
  cacheKey?: unknown;
  resourceSubject?: string;
  currentVersion?: unknown;
  beforeVersion?: unknown;
  afterVersion?: unknown;
}

/** Supplies fixed format opaque identifiers for one eligible operation. */
export type RaceEvidenceResolver = (
  input: RaceEvidenceResolverInput,
) => RaceEvidenceIdentifiers | undefined;

/** Opt in configuration for race evidence on a DB or cache instrumentation path. */
export interface RaceEvidenceOptions {
  /** Race evidence is absent unless this is explicitly true. */
  enabled?: boolean;
  /** One application declared subject shared by DB and cache operations. */
  resourceSubject?: string;
  /** DB field carrying the application's optimistic version. */
  optimisticVersionField?: string;
  /** Fixed format identifiers supplied for this operation. */
  identifiers?: RaceEvidenceIdentifiers;
  /** Resolver used when identifiers are not supplied. */
  resolve?: RaceEvidenceResolver;
}

/** Runtime sealed form. Entity identity is mandatory after validation. */
export type SealedRaceEvidence = Readonly<
  RaceEvidenceIdentifiers & { entityHash: string }
>;

export const RACE_EVIDENCE_IDENTIFIER_LENGTH = 64;
export const RACE_EVIDENCE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{64}$/;

const MAX_SOURCE_LENGTH = 2048;
const MAX_OBJECT_KEYS = 64;
const IDENTIFIER_KEYS = new Set<keyof RaceEvidenceIdentifiers>([
  "resourceHash",
  "entityHash",
  "versionHash",
  "beforeVersionHash",
  "afterVersionHash",
]);
const ELIGIBLE_CACHE_OPERATIONS = new Set([
  "get",
  "getbuffer",
  "getex",
  "set",
  "setex",
  "psetex",
  "del",
  "unlink",
]);

/**
 * Build a race evidence resolver from a server credential without exposing or
 * persisting the credential. The credential stays in this closure and every
 * output is a fixed length, domain separated HMAC SHA 256 digest.
 */
export function createHmacRaceEvidenceResolver(
  credential: string | undefined,
): RaceEvidenceResolver | undefined {
  const normalized = normalizeCredential(credential);
  if (!normalized) return undefined;
  const key = Buffer.from(normalized, "utf8");

  return (input) => {
    try {
      if (!isRaceEvidenceInputEligible(input)) return undefined;
      const entitySource =
        input.surface === "cache"
          ? input.cacheKey
          : { table: input.table, primaryKey: input.primaryKey };
      if (entitySource === undefined || entitySource === null) return undefined;
      if (input.surface === "cache" && Array.isArray(entitySource)) {
        return undefined;
      }
      if (
        input.surface !== "cache" &&
        typeof entitySource === "object" &&
        !Array.isArray(entitySource) &&
        (!input.table ||
          !input.primaryKey ||
          Array.isArray(input.primaryKey) ||
          Object.keys(input.primaryKey).length === 0)
      ) {
        return undefined;
      }
      // DB reads and diffs for one row must join, while cache identities stay in
      // their own domain even when a cache key happens to equal a DB primary key.
      const entityDomain =
        input.surface === "cache" ? "cache:entity" : "db:entity";
      const entityHash = digest(key, entityDomain, entitySource);
      if (!entityHash) return undefined;

      const resourceHash = input.resourceSubject
        ? digest(key, "resource", input.resourceSubject)
        : undefined;
      const currentVersion = hashVersion(key, input.currentVersion);
      const beforeVersion = hashVersion(key, input.beforeVersion);
      const afterVersion = hashVersion(key, input.afterVersion);
      return {
        entityHash,
        ...(resourceHash ? { resourceHash } : {}),
        ...(currentVersion ? { versionHash: currentVersion } : {}),
        ...(beforeVersion ? { beforeVersionHash: beforeVersion } : {}),
        ...(afterVersion ? { afterVersionHash: afterVersion } : {}),
      };
    } catch {
      return undefined;
    }
  };
}

/**
 * Build and seal one bounded race evidence object. Any malformed callback,
 * unsupported operation input, or serialization failure omits only this
 * optional object and leaves the normal event intact.
 */
export function buildRaceEvidence(
  options: RaceEvidenceOptions | undefined,
  input: RaceEvidenceResolverInput,
): SealedRaceEvidence | undefined {
  if (!options?.enabled || !isRaceEvidenceInputEligible(input)) return undefined;

  let candidate: RaceEvidenceIdentifiers | undefined;
  if (options.identifiers !== undefined) {
    candidate = options.identifiers;
  } else if (options.resolve) {
    try {
      candidate = options.resolve({
        ...input,
        ...(options.resourceSubject
          ? { resourceSubject: options.resourceSubject }
          : {}),
      });
    } catch {
      return undefined;
    }
  }
  if (!candidate) return undefined;
  return sanitizeRaceEvidence(candidate);
}

/** Return the configured version field only when it is a safe own property name. */
export function readOptimisticVersion(
  row: Record<string, unknown> | undefined,
  field: string | undefined,
): unknown {
  if (!row || !isVersionField(field)) return undefined;
  return Object.prototype.hasOwnProperty.call(row, field)
    ? row[field]
    : undefined;
}

export function isVersionField(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  );
}

export function isRaceEligibleCacheOperation(operation: string): boolean {
  return ELIGIBLE_CACHE_OPERATIONS.has(operation);
}

function sanitizeRaceEvidence(
  candidate: RaceEvidenceIdentifiers,
): SealedRaceEvidence | undefined {
  try {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(candidate);
    if (keys.length < 1 || keys.length > IDENTIFIER_KEYS.size) return undefined;
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !IDENTIFIER_KEYS.has(key as keyof RaceEvidenceIdentifiers),
      )
    ) {
      return undefined;
    }
    // Every eligible entity must have an opaque identity. Resource and version
    // ids without an entity id could be joined across unrelated rows.
    const values: Partial<RaceEvidenceIdentifiers> = {};
    for (const key of keys as Array<keyof RaceEvidenceIdentifiers>) {
      const value = candidate[key];
      if (!isIdentifier(value)) return undefined;
      values[key] = value;
    }
    if (!isIdentifier(values.entityHash)) return undefined;
    const sealed: RaceEvidenceIdentifiers & { entityHash: string } = {
      entityHash: values.entityHash,
      ...(values.resourceHash
        ? { resourceHash: values.resourceHash }
        : {}),
      ...(values.versionHash ? { versionHash: values.versionHash } : {}),
      ...(values.beforeVersionHash
        ? { beforeVersionHash: values.beforeVersionHash }
        : {}),
      ...(values.afterVersionHash
        ? { afterVersionHash: values.afterVersionHash }
        : {}),
    };
    return Object.freeze(sealed);
  } catch {
    return undefined;
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && RACE_EVIDENCE_IDENTIFIER_PATTERN.test(value)
  );
}

function isRaceEvidenceInputEligible(
  input: RaceEvidenceResolverInput,
): boolean {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.surface !== "string" ||
    typeof input.operation !== "string"
  ) {
    return false;
  }
  if (input.surface === "cache") {
    return (
      isRaceEligibleCacheOperation(input.operation) &&
      input.cacheKey !== undefined &&
      input.cacheKey !== null &&
      !Array.isArray(input.cacheKey)
    );
  }
  return (
    (input.surface === "db.read" || input.surface === "db.diff") &&
    input.operation.length > 0
  );
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length < 32 || /\s/.test(normalized)) return undefined;
  if (Buffer.byteLength(normalized, "utf8") < 32) return undefined;
  const frequencies = new Map<string, number>();
  for (const character of normalized) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  if (frequencies.size < 8) return undefined;
  const entropyBits = [...frequencies.values()].reduce((total, count) => {
    const probability = count / normalized.length;
    return total - probability * Math.log2(probability) * normalized.length;
  }, 0);
  if (entropyBits < 96) return undefined;
  return normalized;
}

function hashVersion(key: Buffer, value: unknown): string | undefined {
  return value === undefined ? undefined : digest(key, "version", value);
}

function digest(
  key: Buffer,
  domain: string,
  value: unknown,
): string | undefined {
  const source = canonicalize(value);
  if (source === undefined) return undefined;
  try {
    return createHmac("sha256", key)
      .update(`crumbtrail:races:v1\0${domain}\0${source}`, "utf8")
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** Small deterministic serializer for PKs, cache keys, and version values. */
function canonicalize(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return value.length <= MAX_SOURCE_LENGTH ? `s:${value}` : undefined;
    case "number":
      return Number.isFinite(value) ? `n:${String(value)}` : undefined;
    case "boolean":
      return `b:${value ? "1" : "0"}`;
    case "bigint":
      return `i:${String(value)}`;
    case "undefined":
      return "u:";
    case "object":
      if (Array.isArray(value)) {
        if (value.length > MAX_OBJECT_KEYS) return undefined;
        const entries = value.map((entry) => canonicalize(entry, depth + 1));
        if (!entries.every((entry) => entry !== undefined)) return undefined;
        const source = `a:[${entries.join(",")}]`;
        return source.length <= MAX_SOURCE_LENGTH ? source : undefined;
      }
      try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
          return undefined;
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > MAX_OBJECT_KEYS) return undefined;
        entries.sort(([left], [right]) => left.localeCompare(right));
        const rendered = entries.map(([key, entry]) => {
          const normalized = canonicalize(entry, depth + 1);
          return normalized === undefined
            ? undefined
            : `${key.length}:${key}=${normalized}`;
        });
        if (!rendered.every((entry) => entry !== undefined)) return undefined;
        const source = `o:{${rendered.join(",")}}`;
        return source.length <= MAX_SOURCE_LENGTH ? source : undefined;
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
}
