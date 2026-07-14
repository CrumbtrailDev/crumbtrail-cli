import {
  REDACTED_VALUE,
  redactNetworkTextBody,
  redactUrl,
  redactValue,
  type EvidenceGap,
  type EvidenceItem,
  type EvidenceRef,
  type EvidenceSourceResult,
} from "crumbtrail-core";

/**
 * Redaction boundary for adapter output. Every adapter result passes through
 * here BEFORE anything is retained or bundled — mirroring how `otel-adapter.ts`
 * redacts attributes/status-messages/log-bodies at the ingest boundary.
 *
 * What is redacted: the free-text/payload fields an adapter carries from a
 * provider — `brief`, `before`, `after`, gap `reason`/`suggestion`, and the
 * deep-link `ref.url` (see below). What is NOT touched: structural correlation
 * fields (`id`, `lane`, `kind`, `whenObserved`, and `ref`'s non-URL join keys),
 * exactly as otel-adapter keeps traceId/requestId intact while scrubbing the
 * payload around them.
 *
 * `ref.url` decision: a deep link is provenance, so a plain issue URL
 * (`https://acme.sentry.io/issues/12345/`) is preserved verbatim. But a URL can
 * carry a token in its query/userinfo (`?token=…`, `user:pass@host`), so it is
 * run through `redactUrl`, which strips embedded credentials/query-secrets and
 * the hash while leaving the origin + path intact. Net effect: clean links stay
 * clickable; token-bearing links keep their location but lose the secret.
 */

export function redactText(value: string, path: string): string {
  // Short briefs pass through unchanged; token-like / sensitive content is
  // scrubbed. `body` is undefined only when summarized (oversized) — fall back
  // to the redaction marker so nothing raw leaks.
  return redactNetworkTextBody(value, { path }).body ?? REDACTED_VALUE;
}

function redactRef(ref: EvidenceRef, index: number): EvidenceRef {
  if (typeof ref.url !== "string" || ref.url.length === 0) return ref;
  return {
    ...ref,
    url: redactUrl(ref.url, `evidence[${index}].ref.url`).value,
  };
}

export function redactEvidenceItem(
  item: EvidenceItem,
  index = 0,
): EvidenceItem {
  return {
    ...item,
    brief: redactText(item.brief, `evidence[${index}].brief`),
    before: redactValue(item.before, `evidence[${index}].before`).value,
    after: redactValue(item.after, `evidence[${index}].after`).value,
    ref: redactRef(item.ref, index),
  };
}

export function redactEvidenceGap(gap: EvidenceGap, index = 0): EvidenceGap {
  return {
    ...gap,
    reason: redactText(gap.reason, `gaps[${index}].reason`),
    ...(gap.suggestion !== undefined
      ? { suggestion: redactText(gap.suggestion, `gaps[${index}].suggestion`) }
      : {}),
  };
}

/**
 * Redact a whole adapter result. Returns a new result (items + gaps redacted);
 * `stats` and `schemaVersion` pass through untouched.
 */
export function redactSourceResult(
  result: EvidenceSourceResult,
): EvidenceSourceResult {
  return {
    ...result,
    items: result.items.map((item, index) => redactEvidenceItem(item, index)),
    gaps: result.gaps.map((gap, index) => redactEvidenceGap(gap, index)),
  };
}
