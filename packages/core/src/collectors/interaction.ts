import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import {
  BROWSER_REDACTION_POLICY,
  REDACTED_VALUE,
  attachRedactionMetadata,
  classifyStructuredValue,
  computeRedactedShape,
  mergeRedactionMetadata,
  redactInputValue,
  redactNetworkTextBody,
  redactUrl,
  type RedactionMetadata,
} from "../redaction";
import {
  isBlocked,
  isUnmasked,
  maskElementDescriptor,
  maskText,
} from "../masking";
import {
  ACCESSIBLE_NAME_MAX_LENGTH,
  describeElement,
  now,
  truncate,
} from "../utils";
import { subscribeNavCommit } from "../nav-signal";

/**
 * Runs an accessible name through the redaction the mobile lane already
 * applies to free text (`redactMobileText`'s `redactNetworkTextBody` call,
 * `contentType: "text/plain"`) before the structured classifier gets it.
 *
 * Order matters and is the whole point: a caption is authored into the page,
 * not typed by a user, so it needs the SAME deny-biased classifier a value
 * gets — an embedded email, card number, JWT or token must still be caught —
 * but with `ui-numbers.ts`'s free-text carve-out, because the classifier's
 * `free_text_value` catch-all was tuned for network body VALUES, where any
 * multi-word string is suspect, and a label is a short, visible-by-design
 * string ("Preferred contact time") where free text is normal. `keyName` is
 * the label text itself, exactly as `ui-numbers.ts`
 * passes it, so `redaction.denyFields` can match words inside the caption
 * ("patient" denies "Patient Sofia Ramirez") the same way it matches a field
 * name — and, by the same built-in rules, a caption containing a bare
 * "email"/"phone"/"ssn"/… is name-denied even with no custom deny list,
 * which is accepted here for the reason `ui-numbers.ts` accepts it: the
 * classifier cannot tell "this caption IS the sensitive datum" from "this
 * caption is A LABEL FOR ONE", so it redacts both.
 *
 * The text-plane pass runs first because it can replace just the sensitive
 * SUBSTRING of a longer sentence (a Bearer token, a key:value pair, an
 * embedded URL's query string) and leave the rest of the caption intact,
 * which the whole-value structured classifier cannot do. What it does not
 * catch — a spaced phone number, a dashed nine-digit SSN-style run, an IBAN
 * written into a sentence — is exactly what the structured classifier does
 * not catch either: neither is Bearer/JWT/prefixed/long-hex/long-alnum
 * token-shaped, and neither is a colon- or equals-delimited key/value pair.
 * That gap is accepted, the same way `ui-numbers.ts` accepts that a label
 * which is itself PII but reads as ordinary free text (a human name) survives
 * capture: mitigate with `redaction.denyFields`, `ignoreSelectors`, or
 * `data-crumbtrail-mask` on the element.
 *
 * `undefined` means "drop the field": returned when nothing is left to ship,
 * or when the cap would have to cut into text the text-plane pass already
 * redacted — slicing a `[REDACTED]` marker in half, or hiding that anything
 * was replaced at all, is worse than shipping no name.
 */
function redactAccessibleName(
  rawLabel: string,
  denyFields: string[] | undefined,
): { value: string | undefined; metadata?: RedactionMetadata } {
  const textPlane = redactNetworkTextBody(rawLabel, {
    contentType: "text/plain",
    path: "el.label",
  });
  const working = textPlane.body ?? rawLabel;

  const classification = classifyStructuredValue(working, working, denyFields);
  if (
    classification.action === "redact" &&
    classification.reason !== "free_text_value"
  ) {
    const classifyMetadata: RedactionMetadata = {
      policy: BROWSER_REDACTION_POLICY,
      fields: [
        {
          path: "el.label",
          reason: classification.reason,
          action: "redacted",
          shape: computeRedactedShape(working, classification.reason),
        },
      ],
    };
    return {
      value: REDACTED_VALUE,
      metadata: mergeRedactionMetadata(textPlane.metadata, classifyMetadata),
    };
  }

  if (working.length <= ACCESSIBLE_NAME_MAX_LENGTH) {
    return { value: working, metadata: textPlane.metadata };
  }
  if (textPlane.metadata) {
    return { value: undefined, metadata: textPlane.metadata };
  }
  return { value: truncate(working, ACCESSIBLE_NAME_MAX_LENGTH) };
}

/**
 * Redacts the descriptor's `label` (the target's accessible name, computed by
 * {@link describeElement}) and drops it entirely when nothing survives.
 *
 * An authored caption is not user content, so — unlike `val` on an `inp`
 * event — it survives `maskAllText`/`maskAllInputs`: `computeAccessibleName`
 * already refused a password field, and already honoured `ignoreSelectors`,
 * `data-crumbtrail-block` and `data-crumbtrail-mask` on the element (and, for
 * a `<label>`-derived name, on the label itself), which is the same
 * reasoning `ui-numbers.ts` applies to a rendered label.
 */
function finalizeAccessibleName(
  descriptor: Record<string, unknown>,
  config: CrumbtrailConfig,
): Record<string, unknown> {
  if (typeof descriptor.label !== "string" || descriptor.label === "")
    return descriptor;

  const { label: rawLabel, ...rest } = descriptor;
  const redacted = redactAccessibleName(rawLabel, config.redaction?.denyFields);
  const merged = mergeRedactionMetadata(
    readDescriptorMetadata(rest),
    redacted.metadata,
  );

  return {
    ...rest,
    ...(redacted.value !== undefined ? { label: redacted.value } : {}),
    ...(merged ? { redaction: merged } : {}),
  };
}

function describeInteractionTarget(
  target: Element,
  config: CrumbtrailConfig,
): Record<string, unknown> {
  try {
    const descriptor =
      config.describeInteractionElement?.(target) ??
      describeElement(target, config);
    if (isRecord(descriptor)) {
      // `label` is pulled out before the generic mask pass: `maskElementDescriptor`
      // asterisks every text-shaped descriptor field under `maskAllText`/
      // `maskAllInputs`, which is the right default for the rest of the
      // descriptor but wrong for an authored caption (see `finalizeAccessibleName`).
      // Masking everything else first, then finalizing the name last, is what
      // keeps the caption out of that generic pass without also exempting the
      // descriptor's other fields from it.
      const { label: rawLabel, ...rest } = removeUndefined(descriptor);
      const masked = maskElementDescriptor(target, rest, config);
      if (typeof rawLabel === "string" && rawLabel !== "") {
        return finalizeAccessibleName({ ...masked, label: rawLabel }, config);
      }
      return masked;
    }
  } catch {
    // Keep interaction capture alive even if a page-specific descriptor probe fails.
  }

  return {
    tag: target.tagName,
    descriptorError: "interaction_descriptor_failed",
  };
}

/** How many elements under the pointer are worth describing beneath the one that got the click. */
const MAX_COVERED_ELEMENTS = 3;

/**
 * What was actually under the pointer, and what actually received the event.
 *
 * "The button does nothing" is one of the most common reports a support desk
 * gets, and until now a session could not answer it. The click event alone says
 * an element was clicked; it cannot say that an invisible overlay, a cookie
 * banner, a modal backdrop or a mispositioned pseudo-element was sitting on top
 * of the control the person was aiming at. An evaluation run scored exactly that
 * case WRONG, with the judge noting the bundle showed only the ABSENCE of a
 * request and left the engineer to guess.
 *
 * Two facts close it:
 *
 *   `deep` — the innermost target from `composedPath()`. A click inside a shadow
 *   root reports the HOST as `target`, so any design system built on web
 *   components (which is most enterprise component libraries) describes the
 *   wrapper and loses the control.
 *
 *   `covered` — what lies BENEATH the element that received the click. When an
 *   interactive control is in that list, the reading is immediate: the person
 *   aimed at the button and something else took the click.
 *
 * Both are best-effort and silent on failure: interaction capture must survive a
 * page that has replaced `elementsFromPoint` or throws inside a getter.
 */
/**
 * The clicked element's box, as whole-pixel viewport coverage.
 *
 * Geometry is what separates "a div was over the button" from "a full-viewport div was over the
 * button", and only the second reads as an overlay swallowing the click. A bundle carrying the
 * element stack without it describes the right elements and still leaves the defect arguable.
 *
 * Safe to carry unconditionally, and worth stating why: a bounding rect is measurement, not
 * content. No text, no attribute values, nothing the user typed — so unlike selectors it needs no
 * redaction pass and cannot leak by carrying a value someone interpolated into the DOM.
 *
 * Rounded to whole pixels and expressed as a percentage of the viewport rather than raw CSS
 * pixels, because "covers 99% of the viewport" transfers across devices and `1512x944` does not.
 */
function describeElementBox(
  element: Element,
): Record<string, unknown> | undefined {
  try {
    const rect = element.getBoundingClientRect?.();
    if (!rect) return undefined;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return undefined;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const box: Record<string, unknown> = { w, h };
    if (vw > 0 && vh > 0) {
      box.viewportPct = Math.min(100, Math.round(((w * h) / (vw * vh)) * 100));
    }
    return box;
  } catch {
    // A detached or cross-origin element does not cost us the click.
    return undefined;
  }
}

function describeClickIntegrity(
  event: MouseEvent,
  target: Element,
  config: CrumbtrailConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const box = describeElementBox(target);
  if (box) out.box = box;

  try {
    const path = event.composedPath?.();
    const innermost = Array.isArray(path) ? path[0] : undefined;
    if (
      innermost instanceof Element &&
      innermost !== target &&
      !isBlocked(innermost)
    ) {
      out.deep = describeInteractionTarget(innermost, config);
    }
  } catch {
    // A page that overrode composedPath does not cost us the click.
  }

  try {
    const stack = document.elementsFromPoint?.(event.clientX, event.clientY);
    if (Array.isArray(stack) && stack.length > 1) {
      const receivedAt = stack.indexOf(target);
      // Everything strictly below the element that took the event. When the
      // target is not in the stack at all (detached, or re-rendered between the
      // click and this read) describe the whole stack rather than nothing: that
      // the target is absent is itself the finding.
      const beneath = receivedAt === -1 ? stack : stack.slice(receivedAt + 1);
      const covered = beneath
        .filter((element): element is Element => element instanceof Element)
        // An ancestor under the cursor is ordinary stacking, not interception: every click on a
        // button also lands on its div, its section and the body. Recording those made `covered`
        // non-empty for essentially every click, and a detector reading it fired on all of them —
        // measured at ten of thirty replayed sessions, in most of which nothing was covering
        // anything. What matters is an element the target does NOT contain: something overlapping
        // from elsewhere in the tree, which is what an overlay, a stale modal or a full-screen
        // frame actually is.
        .filter((element) => !element.contains(target))
        .filter((element) => !isBlocked(element))
        .slice(0, MAX_COVERED_ELEMENTS)
        .map((element) => {
          const descriptor = describeInteractionTarget(element, config);
          const elementBox = describeElementBox(element);
          // The box belongs on the covering element as much as on the target: which of the two is
          // viewport-sized is exactly what distinguishes an overlay from an ordinary ancestor.
          return elementBox ? { ...descriptor, box: elementBox } : descriptor;
        });
      if (covered.length > 0) {
        out.covered = covered;
        // Stated rather than left to be re-derived downstream. Whether the
        // clicked element was even in its own hit-test stack is the difference
        // between "an overlay took it" and "the control was gone by then".
        if (receivedAt === -1) out.targetNotInStack = true;
      }
    }
  } catch {
    // elementsFromPoint is unavailable or threw; the click still records.
  }

  return out;
}

function readDescriptorMetadata(
  descriptor: Record<string, unknown>,
): RedactionMetadata | undefined {
  const redaction = descriptor.redaction;
  if (!isRecord(redaction)) return undefined;
  if (redaction.policy !== BROWSER_REDACTION_POLICY) return undefined;
  if (!Array.isArray(redaction.fields)) return undefined;
  return redaction as unknown as RedactionMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function readSafeOrigin(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === "null" ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}

function isTopFrame(): boolean {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

function describeFrameContext(url: string): Record<string, unknown> {
  return removeUndefined({
    top: isTopFrame(),
    origin: readSafeOrigin(url),
  });
}

/**
 * How this document was reached, per the Navigation Timing API:
 * "navigate" | "reload" | "back_forward" | "prerender".
 *
 * `tr: "init"` covers every first load, so a back/forward that reloads the
 * document (a multi-page app, or an SPA entered through a hard navigation)
 * looks exactly like a fresh visit. This field is what separates them, without
 * changing what `tr` means.
 */
function readDocumentNavType(): string | undefined {
  try {
    const entries = performance?.getEntriesByType?.("navigation");
    const type = (entries?.[0] as PerformanceNavigationTiming | undefined)
      ?.type;
    return typeof type === "string" && type ? type : undefined;
  } catch {
    return undefined;
  }
}

export function interactionCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const cleanups: Array<() => void> = [];
  const inputVersions = new WeakMap<Element, number>();
  const observationTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Whether the deployment opted this element out.
   *
   * `matches` tested the exact event target, so `ignoreSelectors:
   * [".private-panel"]` captured every click on a button INSIDE the panel — the
   * button does not match the selector. `masking.isBlocked` does the same job
   * with `closest()`, and two opt-outs that behave differently is a
   * configuration contract nobody can hold. The list was also never consulted
   * by the input or submit paths, so values from an ignored subtree were
   * captured regardless.
   */
  const isIgnored = (target: Element): boolean =>
    config.ignoreSelectors.some((selector) => {
      try {
        return target.closest(selector) !== null;
      } catch {
        // An invalid selector is the integrator's typo, not a reason to throw
        // into their page.
        return false;
      }
    });

  // --- Clicks ---
  const onClick = (e: MouseEvent) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (isBlocked(target)) return;
    if (isIgnored(target)) return;

    const el = describeInteractionTarget(target, config);
    const d: Record<string, unknown> = {
      el,
      pos: [e.clientX, e.clientY],
      // Answers "the button does nothing": what the click really landed on, and
      // what was underneath it. Spread so the fields are absent rather than null
      // when the page gives us nothing — an absent field reads as "not captured",
      // and a null would read as "captured, nothing there".
      ...describeClickIntegrity(e, target, config),
    };
    attachRedactionMetadata(d, readDescriptorMetadata(el));

    bus.emit({
      t: now(),
      k: "clk",
      d,
    });
  };
  document.addEventListener("click", onClick, true);
  cleanups.push(() => document.removeEventListener("click", onClick, true));

  // --- Input / Change ---
  const isInputControl = (
    target: EventTarget | null,
  ): target is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;

  const emitInputState = (
    target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    eventType: string,
    trusted: boolean,
  ) => {
    if (!(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ))
      return;
    if (isBlocked(target)) return;
    if (isIgnored(target)) return;

    const el = describeInteractionTarget(target, config);
    const type = target instanceof HTMLInputElement ? target.type : undefined;
    // `maskInputTypes` was read by the keystroke collector and by nothing else,
    // so a deployment that listed `number` to keep a 2FA code out of capture
    // got masked keystrokes and the code itself in clear on the very next `inp`
    // event — the classifier keeps a number, and it never saw the setting.
    const maskedByPolicy =
      !isUnmasked(target) &&
      type !== undefined &&
      config.maskInputTypes.some(
        (entry) => entry.toLowerCase() === type.toLowerCase(),
      );
    const redacted = redactInputValue(target.value, {
      name: target.name || undefined,
      type,
      path: "val",
      maskedByPolicy,
    });
    // `maskAllInputs` stays the blanket for DOM snapshots and keystrokes, where there is no field
    // name and no policy to consult. This event has both, so the redaction policy decides and
    // `maskAllInputs` only chooses how a value it already redacted is rendered. Re-masking a value
    // the policy kept would throw the answer away a second time, after the one place entitled to
    // make that call said keep.
    const val =
      isUnmasked(target) || redacted.metadata === undefined
        ? { value: target.value, summary: undefined, metadata: undefined }
        : config.maskAllInputs
          ? { ...redacted, value: maskText(target.value) }
          : redacted;
    const d: Record<string, unknown> = {
      el,
      val: val.value,
      ev: eventType,
      // A user typing produces a trusted event; a script assigning `.value`
      // and dispatching its own does not. That is the difference between the
      // user entering the wrong thing and the app overwriting what they typed.
      trusted,
    };
    if (val.summary) d.valSummary = val.summary;
    attachRedactionMetadata(d, readDescriptorMetadata(el), val.metadata);

    bus.emit({
      t: now(),
      k: "inp",
      d,
    });
  };

  const observeSilentValueChange = (
    target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    expectedValue: string,
    version: number,
    delayMs: number,
  ) => {
    const timer = setTimeout(() => {
      observationTimers.delete(timer);
      let observed = target;
      if (!observed.isConnected) {
        // Frameworks often express a failed-submit reset by remounting the
        // entire form. Find the replacement control by stable, non-value
        // attributes so that a remount does not erase the observation too.
        const name = target.getAttribute("name");
        const id = target.getAttribute("id");
        if (name || id) {
          observed =
            Array.from(
              document.querySelectorAll<
                HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
              >("input, textarea, select"),
            ).find(
              (candidate) =>
                candidate.tagName === target.tagName &&
                candidate.getAttribute("type") ===
                  target.getAttribute("type") &&
                (name
                  ? candidate.getAttribute("name") === name
                  : candidate.getAttribute("id") === id),
            ) ?? target;
        }
      } else if ((inputVersions.get(observed) ?? 0) !== version) {
        return;
      }
      if (!observed.isConnected || observed.value === expectedValue) return;
      // React and browser autofill commonly assign the value property without
      // dispatching an input event. Emit a privacy scrubbed state observation
      // so a detector can distinguish the app taking a value back from the
      // user's own next keystroke.
      emitInputState(observed, "state", false);
    }, delayMs);
    observationTimers.add(timer);
  };

  const onInput = (e: Event) => {
    const target = e.target;
    if (!isInputControl(target)) return;
    const version = (inputVersions.get(target) ?? 0) + 1;
    inputVersions.set(target, version);
    emitInputState(target, e.type, e.isTrusted === true);
    if (e.isTrusted === true) {
      observeSilentValueChange(target, target.value, version, 450);
    }
  };
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  cleanups.push(() => {
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onInput, true);
  });

  // --- Submit ---
  const onSubmit = (e: Event) => {
    const target = e.target;
    if (!(target instanceof HTMLFormElement)) return;
    if (isBlocked(target)) return;
    if (isIgnored(target)) return;

    const el = describeInteractionTarget(target, config);
    const d: Record<string, unknown> = {
      el,
      val: "",
      ev: "submit",
      trusted: e.isTrusted === true,
    };
    attachRedactionMetadata(d, readDescriptorMetadata(el));

    bus.emit({
      t: now(),
      k: "inp",
      d,
    });

    // A failed submit can remount or reset the whole form without dispatching
    // an input event. Snapshot each value now, then emit only controls whose
    // value the application changed while handling the response.
    for (const control of target.querySelectorAll("input, textarea, select")) {
      if (!isInputControl(control)) continue;
      const version = inputVersions.get(control) ?? 0;
      observeSilentValueChange(control, control.value, version, 700);
    }
  };
  document.addEventListener("submit", onSubmit, true);
  cleanups.push(() => document.removeEventListener("submit", onSubmit, true));

  // --- Navigation ---
  let currentUrl = window.location.href;

  const emitNav = (to: string, from: string, tr: string) => {
    const toResult = redactUrl(to, "to");
    const fromResult = from ? redactUrl(from, "from") : undefined;
    const d: Record<string, unknown> = removeUndefined({
      from: fromResult?.value ?? "",
      to: toResult.value,
      tr,
      navType: tr === "init" ? readDocumentNavType() : undefined,
      fromOrigin: from ? readSafeOrigin(from) : undefined,
      toOrigin: readSafeOrigin(to),
      frame: describeFrameContext(to),
    });
    attachRedactionMetadata(d, fromResult?.metadata, toResult.metadata);
    bus.emit({ t: now(), k: "nav", d });
  };

  // Initial nav event
  emitNav(currentUrl, "", "init");

  // Route commits arrive via the shared nav-commit signal (single wrap of
  // the history API shared by all collectors); the callback runs after the
  // navigation is applied, so location.href is already the destination. The
  // NavCommitKind values ("push"/"replace"/"pop"/"hash") are exactly the
  // `tr` values this collector has always emitted.
  cleanups.push(
    subscribeNavCommit((kind) => {
      const from = currentUrl;
      currentUrl = window.location.href;
      emitNav(currentUrl, from, kind);
    }),
  );

  return () => {
    for (const timer of observationTimers) clearTimeout(timer);
    observationTimers.clear();
    for (const fn of cleanups) fn();
  };
}
