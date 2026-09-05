import {
  bodyRedactionOptions,
  buildResponseBodyMeta,
  shouldExclude,
  type ResponseBodyMeta,
} from "./collectors/network";
import { WS_MAX_FRAME_BYTES } from "./collectors/websocket";
import { WORKER_MAX_MESSAGE_BYTES } from "./collectors/worker";
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
 * - what do the current redaction rules and size caps make of these payloads,
 *   including the parsed copy of a response body in `d.bodyMeta.data`?
 *
 * Where the answer cannot be recovered from the built event — rendered page
 * text in a DOM snapshot, a keystroke, or an interaction's element descriptor,
 * all masked at capture time under a mode the policy has since tightened — the
 * event is DROPPED rather than guessed at, and the caller declares the drop as
 * a `capture_gap`. Fail closed: a held event may lose detail or lose itself on
 * release, never gain reach.
 */

/**
 * Which collector switch owns which event kinds, for the "collector now off"
 * test.
 *
 * Keyed by the remote collector switches in `REMOTE_COLLECTOR_KEYS`, and
 * `crumbtrail.ts` asserts at compile time that every one of them appears here.
 * Without that assertion a switch added to the policy surface silently gains no
 * release-time meaning, which is how `uiNumbers`, `listeners` and `campaign`
 * were missing from the first version of this map.
 *
 * Two kinds are easy to transpose and are not: `snap` is the STORAGE
 * collector's snapshot, and the DOM snapshot is `dom.snap`.
 */
export const COLLECTOR_EVENT_KINDS = {
  console: ["con"],
  network: ["net.req", "net.res", "net.err", "net.req.file"],
  interactions: ["clk", "inp", "nav"],
  keystrokes: ["key"],
  scroll: ["scr"],
  visibility: ["vis"],
  clipboard: ["clip"],
  errors: ["err", "rej", "csp"],
  performance: ["perf"],
  cookies: ["cookie"],
  storage: ["stor", "snap"],
  heartbeat: ["hb"],
  uiNumbers: ["ui.num", "ui.layout"],
  listeners: ["ui.listeners"],
  eventSource: ["net.sse"],
  webSocket: ["net.ws"],
  workers: ["worker.msg"],
  environment: ["env"],
  // `campaign` adds utm labels to the environment snapshot rather than emitting
  // a kind of its own, so turning it off has nothing of its own to drop. The
  // entry exists so the exhaustiveness check stays meaningful.
  campaign: [],
  domSnapshot: ["dom.snap"],
} satisfies Record<string, readonly string[]>;

/**
 * Kinds whose payload is user-visible page content, masked at capture time
 * under the mode then in force and carrying no record of which mode that was.
 * A policy that tightens masking mid-hold cannot be applied to them after the
 * fact: `maskElementDescriptor` and the snapshot cloner run over the live DOM,
 * which is gone by release, so a `clk` on a button reading
 * "Continue as jane@acme.com" holds that text with nothing left to re-mask it
 * from.
 */
const MASKING_DEPENDENT_KINDS = new Set([
  "dom.snap",
  "key",
  "clip",
  "clk",
  "inp",
]);

/** Per-kind ceilings, so a re-redaction does not re-cap a frame at the body limit. */
function maxBodyLengthFor(kind: string, config: CrumbtrailConfig): number {
  if (kind === "net.ws") return WS_MAX_FRAME_BYTES;
  if (kind === "worker.msg") return WORKER_MAX_MESSAGE_BYTES;
  return config.networkMaxBodySize;
}

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

/**
 * One parked event plus what the emitter knew and the event does not carry.
 * The extra fields are read by the release pass and go no further.
 */
export interface HeldEvent {
  event: BugEvent;
  rawUrl?: string;
}

export interface HeldEventPolicyContext {
  /** The masking switches in force when the event was held. */
  heldMasking: MaskingState;
  /** True when the session was shed by a sample rate the policy carried. */
  samplingShed: boolean;
  /**
   * The URL as the application gave it, before redaction, when the emitter
   * supplied one. `d.url` has already been through `redactUrl`, so an
   * `excludeUrls` pattern aimed at a credential or a query value it replaced
   * would never match the only copy the built event carries.
   *
   * It lives in the hold entry and reaches nothing else: it is read here and
   * never written back onto the released event.
   */
  rawUrl?: string;
}

function urlOf(event: BugEvent): string | undefined {
  const url = event.d?.url;
  return typeof url === "string" ? url : undefined;
}

/**
 * Re-runs one text payload through the current redaction rules and size cap,
 * and returns what the pass recorded about it so the event's own redaction
 * metadata can say that a second pass ran. Metadata that still claimed only the
 * capture-time rules would name a policy the delivered payload never went
 * through.
 */
function reredactBody(
  data: Record<string, unknown>,
  field: string,
  contentTypeField: string,
  maxLength: number,
  config: CrumbtrailConfig,
): RedactionMetadata | undefined {
  const body = data[field];
  if (typeof body !== "string" || body.length === 0) return undefined;
  const contentType = data[contentTypeField];
  const result = redactNetworkTextBody(body, {
    ...(typeof contentType === "string" ? { contentType } : {}),
    maxLength,
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
 * Rebuilds `d.bodyMeta` from the body as it now stands.
 *
 * `bodyMeta.data` is a parsed copy of the response body, capped but otherwise
 * verbatim, so re-redacting `d.body` and leaving `bodyMeta` alone publishes the
 * cleartext anyway through the parsed view — the exact field a `denyFields`
 * policy was pointed at. Rebuilt from the new body it agrees with it; with no
 * body left to parse the size facts survive and the parsed view does not.
 */
function rebuildBodyMeta(
  data: Record<string, unknown>,
  config: CrumbtrailConfig,
): void {
  const meta = data.bodyMeta as ResponseBodyMeta | undefined;
  if (!meta || typeof meta !== "object") return;
  const body = data.body;
  const declaredCt = typeof data.ct === "string" ? data.ct : meta.ct;
  const rebuilt = buildResponseBodyMeta({
    contentType: declaredCt ?? "",
    ...(typeof meta.bytes === "number"
      ? { contentLength: String(meta.bytes) }
      : {}),
    ...(typeof body === "string" ? { redactedBody: body } : {}),
  });
  if (rebuilt) data.bodyMeta = rebuilt;
  else delete data.bodyMeta;
  void config;
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

  for (const [key, kinds] of Object.entries(COLLECTOR_EVENT_KINDS)) {
    if (
      (kinds as readonly string[]).includes(event.k) &&
      config[key as keyof CrumbtrailConfig] === false
    )
      return undefined;
  }

  if (
    MASKING_DEPENDENT_KINDS.has(event.k) &&
    maskingTightened(context.heldMasking, config)
  ) {
    return undefined;
  }

  // The raw URL when the emitter kept one, the redacted URL otherwise. Matching
  // on the redacted copy still catches every pattern aimed at a host or a path,
  // which is what `excludeUrls` is normally written against.
  const url = context.rawUrl ?? urlOf(event);
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

  // `denyFields`, `mode: "full"` and a lowered size cap all land on the payload
  // text, which is the one field a built event still carries in a form the
  // collector's own redactor can read. Deliberately scoped to the payloads: a
  // blanket pass over `d` would also rewrite `requestId`, `traceId` and
  // `spanId`, which are token-shaped, and losing those breaks the join to the
  // backend that makes a held request worth keeping.
  const existing = data.redaction as RedactionMetadata | undefined;
  const maxLength = maxBodyLengthFor(event.k, config);
  const bodyMetadata = reredactBody(data, "body", "ct", maxLength, config);
  const reqBodyMetadata = reredactBody(
    data,
    "reqBody",
    "reqCt",
    maxLength,
    config,
  );
  if (bodyMetadata || reqBodyMetadata) {
    attachRedactionMetadata(data, existing, bodyMetadata, reqBodyMetadata);
    // Only after the body it is derived from has settled.
    rebuildBodyMeta(data, config);
  }

  return { ...event, d: data };
}
