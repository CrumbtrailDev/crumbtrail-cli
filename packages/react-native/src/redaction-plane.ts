/**
 * The redaction boundary for everything this package captures.
 *
 * `Crumbtrail.addEvent` is not one. It redacts `db.*` event data and hands
 * every other type straight to the bus, so a collector that emits through it
 * ships whatever it read. Core's own browser collectors do not rely on it
 * either: each calls the engine before it emits. This module is that call for
 * React Native, in one place so a new collector cannot quietly skip it.
 *
 * Nothing here decides what is sensitive. Every judgement comes from
 * `crumbtrail-core`, which is already a dependency; a second opinion written
 * here would be a weaker copy of the engine that ships beside it, and would
 * drift the moment the engine learned something new.
 */
import {
  MOBILE_REDACTION_POLICY,
  mergeRedactionMetadata,
  redactNetworkTextBody,
  redactUrl,
  type RedactionMetadata,
} from "crumbtrail-core";

export { MOBILE_REDACTION_POLICY };

/**
 * Longest URL kept before it is reported as oversized rather than captured.
 *
 * A URL is attacker-shaped in the same way a response body is: a deep link, a
 * signed upload target or a data URI can carry hundreds of kilobytes, and until
 * now the collector stored all of it on every request. Two thousand characters
 * clears the practical browser ceiling and every REST path this SDK has seen,
 * so it fires on the pathological case only.
 */
export const MOBILE_URL_MAX_LENGTH = 2_000;

/** Longest error message kept. Matches core's recorded-error bound. */
export const MOBILE_ERROR_MESSAGE_MAX_LENGTH = 2_000;

/** Longest stack kept. Matches core's recorded-error bound. */
export const MOBILE_ERROR_STACK_MAX_LENGTH = 8_000;

/**
 * Longest accessibility label kept.
 *
 * A label is on-screen text, so it is bounded like text and not like an
 * identifier. Long enough for a paragraph read by a screen reader.
 */
export const MOBILE_LABEL_MAX_LENGTH = 512;

/**
 * Restamp engine output with the plane that produced it.
 *
 * The engine has no idea which runtime called it and stamps the browser tag on
 * everything. Correcting it here is cheaper and far less error prone than
 * threading a policy through every entry point the engine exposes.
 */
export function stampMobilePlane(
  metadata: RedactionMetadata | undefined,
): RedactionMetadata | undefined {
  if (!metadata || metadata.policy === MOBILE_REDACTION_POLICY) return metadata;
  return { ...metadata, policy: MOBILE_REDACTION_POLICY };
}

export interface MobileRedactedText {
  value: string;
  metadata?: RedactionMetadata;
}

/**
 * Redact one captured URL.
 *
 * Strips userinfo and fragment and redacts query values, which is where an API
 * key or a session token rides. Oversized URLs are replaced by a stand-in
 * rather than truncated: half a signed URL is still half a signature, and a
 * truncated one reads to a debugger as the URL the app actually requested.
 */
export function redactMobileUrl(
  url: string | undefined,
  path = "url",
): MobileRedactedText | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  if (url.length > MOBILE_URL_MAX_LENGTH) {
    return {
      value: "[dropped:url_too_large]",
      metadata: stampMobilePlane({
        policy: MOBILE_REDACTION_POLICY,
        fields: [{ path, reason: "url_too_large", action: "dropped" }],
        summaries: [
          {
            kind: "text",
            action: "dropped",
            reason: "url_too_large",
            originalLength: url.length,
            limit: MOBILE_URL_MAX_LENGTH,
          },
        ],
      }),
    };
  }
  const result = redactUrl(url, path);
  return { value: result.value, metadata: stampMobilePlane(result.metadata) };
}

/**
 * Redact one captured free-text field: an error message, a stack, a label.
 *
 * `text/plain` is deliberate. These are prose, not payloads, so the engine's
 * text pass is the right one: it finds tokens, keys and credentials inside a
 * sentence instead of trying to read the sentence as a document.
 */
export function redactMobileText(
  value: string | undefined,
  path: string,
  maxLength?: number,
): MobileRedactedText | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const result = redactNetworkTextBody(value, {
    contentType: "text/plain",
    path,
    ...(maxLength !== undefined ? { maxLength } : {}),
  });
  const summary = result.bodySummary;
  return {
    value:
      result.body ??
      (summary ? `[${summary.action}:${summary.reason}]` : "[REDACTED]"),
    metadata: stampMobilePlane(result.metadata),
  };
}

/**
 * Attach merged metadata to an event payload under the mobile plane.
 *
 * Assigns the field itself rather than calling core's `attachRedactionMetadata`,
 * which merges again on the way in and would reset the plane tag: core's merge
 * only knows the browser tags and falls back to `browser-redaction.v1` for
 * anything else. Stamping after the merge is therefore the last word, and has
 * to be.
 */
export function attachMobileRedaction(
  target: Record<string, unknown>,
  ...items: Array<RedactionMetadata | undefined>
): void {
  const merged = stampMobilePlane(mergeRedactionMetadata(...items));
  if (merged) target.redaction = merged;
}
