import { computeElementSignature } from "./signature";
import { isBlocked, isMaskForced } from "./masking";
import type { CrumbtrailConfig } from "./types";

export interface ElementDescriptor {
  tag: string;
  id?: string;
  cls?: string;
  txt?: string;
  href?: string;
  name?: string;
  type?: string;
  /** Stable identity hash — lets the AI reference this element across sessions. */
  sig?: string;
  /** Deterministic structural path the sig is derived from. */
  path?: string;
  /**
   * Accessible name of the interaction target, in priority order: `aria-label`,
   * an associated `<label>` (`for=` or wrapping), the element's own visible
   * text for a button or link, `placeholder`, then `title`. Trimmed and
   * whitespace-collapsed here; redacted and capped at 40 characters by
   * `collectors/interaction.ts` — deliberately in that order, so a secret
   * embedded in a long caption is classified before the cap can cut it into
   * an unrecognizable, un-redacted fragment. Never the VALUE of an input, and
   * never present at all for a password field, an element (or, for a
   * `<label>`-derived name, the label itself) matched by `ignoreSelectors`,
   * or carrying `data-crumbtrail-block`/`data-crumbtrail-mask`.
   */
  label?: string;
}

export function safeStringify(value: unknown, maxDepth = 3): string {
  const seen = new WeakSet();

  function process(val: unknown, depth: number): unknown {
    if (val === null || val === undefined) return val;

    const type = typeof val;
    if (type === "string" || type === "number" || type === "boolean")
      return val;
    if (type === "bigint") return val.toString();
    if (type === "symbol") return (val as symbol).toString();
    if (type === "function")
      return `[Function: ${(val as Function).name || "anonymous"}]`;

    if (seen.has(val as object)) return "[Circular]";
    if (depth > maxDepth) {
      return Array.isArray(val) ? `[Array(${val.length})]` : "[Object]";
    }
    seen.add(val as object);

    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }

    if (Array.isArray(val)) {
      return val.map((v) => process(v, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>)) {
      out[k] = process((val as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }

  try {
    return JSON.stringify(process(value, 0));
  } catch {
    try {
      return String(value);
    } catch {
      return "[Unserializable]";
    }
  }
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

/**
 * Cap applied to `el.label` after redaction, in `collectors/interaction.ts`.
 * Exported so that pipeline is the only place the number is written down.
 */
export const ACCESSIBLE_NAME_MAX_LENGTH = 40;
const BUTTON_LIKE_TAGS = new Set(["BUTTON", "A"]);
const FORM_CONTROL_DESCENDANT_TAGS = new Set([
  "SELECT",
  "OPTION",
  "INPUT",
  "TEXTAREA",
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Whether `el` is a legitimate source for an accessible name: not blocked, not
 * force-masked, and not matched by `ignoreSelectors`. Applied to the
 * interaction TARGET and, separately, to a `<label>` found elsewhere in the
 * document — a `for=` reference or a wrapping ancestor is a different element
 * than the one that was clicked or typed into, and an integrator excluding
 * that element (a blocked panel, an ignored region) must not have its opt-out
 * bypassed just because the control it labels sits outside it.
 */
function isAccessibleNameSource(
  el: Element,
  config: Pick<CrumbtrailConfig, "ignoreSelectors">,
): boolean {
  if (isBlocked(el) || isMaskForced(el)) return false;
  for (const selector of config.ignoreSelectors) {
    try {
      if (el.closest(selector)) return false;
    } catch {
      // An invalid selector is the integrator's typo, not a reason to refuse
      // an otherwise-usable source.
    }
  }
  return true;
}

/**
 * A label's own text, excluding anything read from a form control it wraps.
 *
 * A `<label>` wrapping a `<select>` reports every option's text through
 * `textContent` — chosen and unchosen alike — which turned "Country" into
 * "CountryCanadaUnited StatesMexico...". Only `SELECT`, `OPTION`, `INPUT` and
 * `TEXTAREA` subtrees are skipped; visually-hidden but accessible text
 * (`sr-only`-style spans) is ordinary text here and is kept, same as it
 * would be read by a screen reader.
 */
function labelOwnText(label: Element): string {
  let text = "";
  const collect = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (FORM_CONTROL_DESCENDANT_TAGS.has(element.tagName)) return;
    for (const child of Array.from(element.childNodes)) collect(child);
  };
  for (const child of Array.from(label.childNodes)) collect(child);
  return text;
}

/**
 * The text of a `<label>` associated with `el`, by `for=` first and then by
 * wrapping — the two ways HTML lets a label claim a control. Best-effort: an
 * invalid `for` value or an unsupported selector engine costs us this one
 * source, not the whole name.
 */
function readAssociatedLabelText(
  el: Element,
  config: Pick<CrumbtrailConfig, "ignoreSelectors">,
): string | undefined {
  try {
    if (el.id) {
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(el.id)
          : el.id.replace(/["\\]/g, "\\$&");
      const forLabel = el.ownerDocument?.querySelector(
        `label[for="${escaped}"]`,
      );
      if (
        forLabel instanceof HTMLElement &&
        isAccessibleNameSource(forLabel, config)
      ) {
        const text = labelOwnText(forLabel);
        if (text) return text;
      }
    }
    const wrapping = el.closest("label");
    if (
      wrapping instanceof HTMLElement &&
      isAccessibleNameSource(wrapping, config)
    ) {
      const text = labelOwnText(wrapping);
      if (text) return text;
    }
  } catch {
    // An invalid `for=` value or a detached node costs us this source, not the whole name.
  }
  return undefined;
}

/**
 * The accessible name of an interaction target, resolved in the same order a
 * screen reader would: an explicit `aria-label`, an associated `<label>`, the
 * element's own visible text for a button or link, `placeholder`, then
 * `title`. Trimmed and whitespace-collapsed, but deliberately NOT redacted or
 * capped here — `collectors/interaction.ts` does both, in that order, over
 * the untruncated text, because classifying a name after it has already been
 * cut to size lets a truncated secret (an email whose domain got sliced off,
 * a card number missing its last four digits) ship in clear.
 *
 * Never reads `.value` — a name answers "what is this control called", not
 * what a user typed into it — and a password field is refused outright so a
 * name never becomes a second path for a credential to leak. `ignoreSelectors`,
 * `data-crumbtrail-block` and `data-crumbtrail-mask` are honoured on `el`
 * itself and, separately, on a `<label>` read from elsewhere in the document.
 */
export function computeAccessibleName(
  el: Element,
  config: Pick<CrumbtrailConfig, "ignoreSelectors">,
): string | undefined {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === "password")
    return undefined;
  if (!isAccessibleNameSource(el, config)) return undefined;

  const candidates: Array<string | null | undefined> = [
    el.getAttribute("aria-label"),
    readAssociatedLabelText(el, config),
    BUTTON_LIKE_TAGS.has(el.tagName) && el instanceof HTMLElement
      ? (el.innerText ?? el.textContent)
      : undefined,
    el.getAttribute("placeholder"),
    el.getAttribute("title"),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const collapsed = collapseWhitespace(candidate);
    if (collapsed) return collapsed;
  }

  return undefined;
}

export function describeElement(
  el: Element,
  config: Pick<CrumbtrailConfig, "ignoreSelectors"> = { ignoreSelectors: [] },
): ElementDescriptor {
  const desc: ElementDescriptor = { tag: el.tagName };

  if (el.id) desc.id = el.id;

  if (el.className && typeof el.className === "string") {
    desc.cls = truncate(el.className, 200);
  }

  if (el instanceof HTMLElement) {
    const txt = el.innerText ?? el.textContent;
    if (txt) desc.txt = truncate(txt.trim(), 100);
  }

  if (el instanceof HTMLAnchorElement) {
    desc.href = el.href;
  }

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el.name) desc.name = el.name;
  }

  if (el instanceof HTMLInputElement) {
    if (el.type) desc.type = el.type;
  }

  try {
    const signature = computeElementSignature(el);
    desc.sig = signature.sig;
    desc.path = signature.path;
  } catch {
    // Descriptor stays valid without a signature — never break capture.
  }

  const label = computeAccessibleName(el, config);
  if (label) desc.label = label;

  return desc;
}

/**
 * Bodies that are not strings but are still readable text.
 *
 * Shared by the live network collector and by `crumbtrail-core/early`, so a
 * form submission issued before init is recorded exactly as the same call
 * issued after it. It lives here rather than in the collector because the early
 * entry point must not pull the collector (and the whole redaction module) into
 * the bundle that sits at the top of the host's entry file.
 *
 * `fetch(url, { body: new URLSearchParams(form) })` and `body: new FormData(form)` are how a form
 * submission is normally written, and both were discarded whole as "non-text". Every field a user
 * filled in - the quantity that was wrong, the address that was rejected, the id of the record
 * being edited - went missing from the capture for no reason other than the container it arrived
 * in. Both are read without consuming them, and the same body redaction runs over the result.
 *
 * File parts are described, never read. The form FIELD name survives as the JSON key, which is the
 * part that matters - a reader needs to know the upload was attached to `invoice`, not what the
 * document said. The file's own name and MIME type are free text and answer to the same value rules
 * as any other string in a body, which redact them; only the byte count and the file extension are
 * kept, because a size and a file type are shape, not content. The extension is the tail of the
 * name after its last dot, never the stem, and only when it is short and alphanumeric enough to be
 * a type rather than a fragment of free text.
 */
export function readStructuredBody(body: unknown): string | undefined {
  try {
    if (
      typeof URLSearchParams !== "undefined" &&
      body instanceof URLSearchParams
    ) {
      return body.toString();
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of body.entries()) {
        const described =
          typeof value === "string"
            ? value
            : describeFilePart(value as { name?: string; size?: number });
        const existing = fields[key];
        if (existing === undefined) fields[key] = described;
        else if (Array.isArray(existing)) existing.push(described);
        else fields[key] = [existing, described];
      }
      return JSON.stringify(fields);
    }
  } catch {
    // An exotic host implementation is reported as non-text, exactly as before.
  }
  return undefined;
}

function describeFilePart(file: {
  name?: string;
  size?: number;
}): Record<string, unknown> {
  const ext =
    typeof file.name === "string" ? extractFileExtension(file.name) : undefined;
  return {
    file: true,
    ...(typeof file.size === "number" ? { bytes: file.size } : {}),
    ...(ext ? { ext } : {}),
  };
}

/**
 * The file type, never the name. Lowercased tail after the last dot, kept only
 * when it is short and alphanumeric enough to be an extension rather than a
 * fragment of the (free text, unredacted-in-this-function) stem: a dotfile
 * with nothing before the dot (`.gitignore`), a name with no dot, and a tail
 * longer than a real extension ever is all report no extension rather than
 * guessing.
 */
export function extractFileExtension(name: string): string | undefined {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return undefined;
  const tail = name.slice(dotIndex + 1).toLowerCase();
  if (tail.length === 0 || tail.length > 8) return undefined;
  return /^[a-z0-9]+$/.test(tail) ? tail : undefined;
}

export function generateSessionId(): string {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return `ses_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${randomHex(6)}`;
}

/**
 * Random hex, from WebCrypto where there is any.
 *
 * A runtime without `crypto.getRandomValues` — an older Node doing SSR, an
 * embedded WebView, a harness with no polyfill — used to make this throw, and
 * `Crumbtrail.init()` calls it before anything is wrapped in a try/catch, so the
 * exception escaped into the host application's entry point and failed the
 * render. The SDK does not break the app it is watching. A session id is an
 * opaque correlation key rather than a secret, and `correlation.ts` already
 * falls back the same way for the trace ids that travel beside it on the wire,
 * so the fallback keeps one behaviour across both instead of two.
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const getRandomValues = globalThis.crypto?.getRandomValues;
  if (getRandomValues) {
    getRandomValues.call(globalThis.crypto, bytes);
  } else {
    for (let i = 0; i < byteLength; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function now(): number {
  return Date.now();
}
