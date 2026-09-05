import { shouldExclude, bodyRedactionOptions } from "./collectors/network";
import {
  attachRedactionMetadata,
  redactInputValue,
  redactNetworkTextBody,
  type RedactionMetadata,
} from "./redaction";
import { CAPTURE_GAP_EVENT_KIND, type BugEvent } from "./types";
import type { CrumbtrailConfig } from "./types";

/**
 * The second half of the admission hold.
 *
 * Events emitted before the remote capture policy lands are held rather than
 * destroyed (see `Crumbtrail.holdForAdmission`). They were BUILT under the
 * local config, so releasing them as they are would publish what the policy
 * that just arrived forbids: a first-render `POST /api/kyc` carrying an `ssn`
 * field would ship unredacted to a URL the policy excludes, because the
 * collector redacted it under the looser rules and nothing looked again.
 *
 * Every held event therefore passes through this module before it is emitted,
 * and it re-asks the policy questions that can still be answered from a built
 * event:
 *
 * - is this collector still on?
 * - is this URL still captured?
 * - are headers still captured?
 * - is what the user typed still captured?
 * - what do the current redaction rules and size caps make of these bodies?
 *
 * Where the answer cannot be recovered from the built event — a DOM snapshot or
 * a keystroke built under masking the policy has since tightened — the
 * event is DROPPED rather than guessed at, and the caller declares the drop as
 * a `capture_gap`. Fail closed: a held event may lose detail or lose itself on
 * release, never gain reach.
 */

/** Which config switch owns which event kinds, for the "collector now off" test. */
const COLLECTOR_EVENT_KINDS: Array<{
  key: keyof CrumbtrailConfig;
  kinds: readonly string[];
}> = [
  { key: "console", kinds: ["con"] },
  {
    key: "network",
    kinds: ["net.req", "net.res", "net.err", "net.req.file"],
  },
  { key: "interactions", kinds: ["clk", "inp", "nav"] },
  { key: "keystrokes", kinds: ["key"] },
  { key: "scroll", kinds: ["scr"] },
  { key: "visibility", kinds: ["vis"] },
  { key: "clipboard", kinds: ["clip"] },
  { key: "errors", kinds: ["err", "rej", "csp"] },
  { key: "performance", kinds: ["perf"] },
  { key: "cookies", kinds: ["cookie"] },
  { key: "storage", kinds: ["stor"] },
  { key: "heartbeat", kinds: ["hb"] },
  { key: "eventSource", kinds: ["net.sse"] },
  { key: "webSocket", kinds: ["net.ws"] },
  { key: "workers", kinds: ["worker.msg"] },
  { key: "environment", kinds: ["env"] },
  { key: "domSnapshot", kinds: ["snap"] },
];

/**
 * Kinds whose payload is user-visible content shaped by the masking mode, and
 * which carry no record of the mode they were built under. A policy that
 * tightens masking mid-hold cannot be applied to them after the fact.
 */
const MASKING_DEPENDENT_KINDS = new Set(["snap", "key", "clip"]);

/** The masking switches, as they stood when an event was held. Tighten-only. */
export interface MaskingState {
  maskAllText: boolean;
  maskAllInputs: boolean;
}

export function readMaskingState(config: CrumbtrailConfig): MaskingState {
  return {
    maskAllText: config.maskAllText === true,
    maskAllInputs: config.maskAllInputs === true,
  };
}

function maskingTightened(
  held: MaskingState,
  config: CrumbtrailConfig,
): boolean {
  const now = readMaskingState(config);
  return (
    (now.maskAllText && !held.maskAllText) ||
    (now.maskAllInputs && !held.maskAllInputs)
  );
}

export interface HeldEventPolicyContext {
  /** The masking switches in force when the event was held. */
  heldMasking: MaskingState;
  /** True when the session was shed by a sample rate the policy carried. */
  samplingShed: boolean;
}

function urlOf(event: BugEvent): string | undefined {
  const url = event.d?.url;
  return typeof url === "string" ? url : undefined;
}

/**
 * Re-runs one text body through the current redaction rules and size cap, and
 * returns what the pass recorded about it so the event's own redaction metadata
 * can say that a second pass ran. Metadata that still claimed only the capture
 * time rules would name a policy the delivered payload never went through.
 */
function reredactBody(
  data: Record<string, unknown>,
  field: string,
  contentTypeField: string,
  config: CrumbtrailConfig,
): RedactionMetadata | undefined {
  const body = data[field];
  if (typeof body !== "string" || body.length === 0) return undefined;
  const contentType = data[contentTypeField];
  const result = redactNetworkTextBody(body, {
    ...(typeof contentType === "string" ? { contentType } : {}),
    maxLength: config.networkMaxBodySize,
    path: field,
    ...bodyRedactionOptions(config),
  });
  if (result.body === undefined) delete data[field];
  else data[field] = result.body;
  // A lowered size cap turns a body into a summary. Carrying the summary is
  // what keeps "too large to keep" distinguishable from "there was no body".
  if (result.bodySummary !== undefined) data.bodySummary = result.bodySummary;
  else if (result.body !== undefined) delete data.bodySummary;
  return result.metadata;
}

/**
 * Returns the event as the current policy would have it, or `undefined` when
 * the policy means it must not be emitted at all.
 *
 * The event is rebuilt rather than mutated: a held event is still referenced by
 * whatever produced it, and re-redaction must not reach back into the
 * collector's own state.
 */
export function reapplyPolicyToHeldEvent(
  event: BugEvent,
  config: CrumbtrailConfig,
  context: HeldEventPolicyContext,
): BugEvent | undefined {
  // A gap record says what capture lost. It survives every tightening, because
  // the alternative is a session that lost evidence and does not say so.
  if (event.k === CAPTURE_GAP_EVENT_KIND) return event;

  // A shed session records nothing. The hold predates the sample rate that shed
  // it, so this is the only place that decision reaches these events.
  if (context.samplingShed) return undefined;

  for (const { key, kinds } of COLLECTOR_EVENT_KINDS) {
    if (kinds.includes(event.k) && config[key] === false) return undefined;
  }

  if (
    MASKING_DEPENDENT_KINDS.has(event.k) &&
    maskingTightened(context.heldMasking, config)
  ) {
    return undefined;
  }

  const url = urlOf(event);
  if (url !== undefined && shouldExclude(url, config)) return undefined;

  const data: Record<string, unknown> = { ...event.d };

  if (config.networkCaptureHeaders === false) delete data.hdrs;

  // `captureInputValues: false` is a one-way switch that turns every input into
  // a placeholder. `redactInputValue` reads it off the module-level flag the
  // policy already set, so this asks the same function the collector asks.
  if (
    event.k === "inp" &&
    config.redaction?.captureInputValues === false &&
    typeof data.val === "string"
  ) {
    data.val = redactInputValue(data.val, { path: "val" }).value;
  }

  // `denyFields`, `mode: "full"` and a lowered `networkMaxBodySize` all land on
  // the payload text, which is the one field a built event still carries in a
  // form the collector's own redactor can read. Deliberately scoped to the
  // bodies: a blanket pass over `d` would also rewrite `requestId`, `traceId`
  // and `spanId`, which are token-shaped, and losing those breaks the join to
  // the backend that makes a held request worth keeping.
  const existing = data.redaction as RedactionMetadata | undefined;
  const bodyMetadata = reredactBody(data, "body", "ct", config);
  const reqBodyMetadata = reredactBody(data, "reqBody", "reqCt", config);
  if (bodyMetadata || reqBodyMetadata)
    attachRedactionMetadata(data, existing, bodyMetadata, reqBodyMetadata);

  return { ...event, d: data };
}
