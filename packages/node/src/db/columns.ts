import {
  REDACTED_VALUE,
  redactValue,
  type RedactionMetadata,
} from "crumbtrail-core";

/**
 * Default sensitive column names whose values are always dropped before a `db.diff` event rests.
 * Hosts can extend this list per shim via `redactColumns`. Matching is name-based and
 * normalization-aware (case-insensitive; `apiKey`/`api_key`/`APIKEY` all match `api_key`).
 */
export const DEFAULT_SENSITIVE_DB_COLUMNS = [
  "password",
  "token",
  "secret",
  "api_key",
  "ssn",
] as const;

function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildSensitiveColumnSet(
  extra: readonly string[] = [],
): Set<string> {
  const set = new Set<string>();
  for (const name of [...DEFAULT_SENSITIVE_DB_COLUMNS, ...extra]) {
    if (typeof name === "string" && name.trim())
      set.add(normalizeColumnName(name));
  }
  return set;
}

export interface RedactedColumns {
  value: Record<string, unknown> | undefined;
  metadata?: RedactionMetadata;
}

/**
 * Column-level redaction: drops/masks configured sensitive columns to `[REDACTED]`, then runs the
 * shared browser redaction policy over the remaining values as defense-in-depth so token-like
 * strings can never rest in a `db.diff` event even from an unlisted column.
 */
export function redactColumns(
  row: Record<string, unknown> | undefined,
  sensitive: Set<string>,
  path: string,
): RedactedColumns {
  if (!row) return { value: undefined };

  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    masked[key] = sensitive.has(normalizeColumnName(key))
      ? REDACTED_VALUE
      : value;
  }

  const scrubbed = redactValue(masked, path);
  return {
    value: scrubbed.value as Record<string, unknown>,
    metadata: scrubbed.metadata,
  };
}
