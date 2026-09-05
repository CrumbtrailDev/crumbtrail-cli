import { computeElementSignature } from "./signature";

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
   * text for a button or link, `placeholder`, then `title`. Trimmed, capped at
   * 40 characters and passed through the same redaction a captured value gets,
   * so a name that happens to look like an email or a token is replaced rather
   * than shipped in clear. Never the VALUE of an input, and never present at
   * all for a password field or an element whose text is masked.
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

const ACCESSIBLE_NAME_MAX_LENGTH = 40;
const BUTTON_LIKE_TAGS = new Set(["BUTTON", "A"]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The text of a `<label>` associated with `el`, by `for=` first and then by
 * wrapping — the two ways HTML lets a label claim a control. Best-effort: an
 * invalid `for` value or an unsupported selector engine costs us this one
 * source, not the whole name.
 */
function readAssociatedLabelText(el: Element): string | undefined {
  try {
    if (el.id) {
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(el.id)
          : el.id.replace(/["\\]/g, "\\$&");
      const forLabel = el.ownerDocument?.querySelector(
        `label[for="${escaped}"]`,
      );
      if (forLabel instanceof HTMLElement) {
        const text = forLabel.innerText ?? forLabel.textContent;
        if (text) return text;
      }
    }
    const wrapping = el.closest("label");
    if (wrapping instanceof HTMLElement) {
      const text = wrapping.innerText ?? wrapping.textContent;
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
 * `title`. Trimmed, whitespace-collapsed and capped at
 * {@link ACCESSIBLE_NAME_MAX_LENGTH} characters.
 *
 * Never reads `.value` — a name answers "what is this control called", not
 * what a user typed into it, and a password field is refused outright so a
 * name never becomes a second path for a credential to leak. Redaction of the
 * result (a name that happens to look like an email or a token) is the
 * caller's job: this only extracts what the page says the element is called.
 */
export function computeAccessibleName(el: Element): string | undefined {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === "password")
    return undefined;

  const candidates: Array<string | null | undefined> = [
    el.getAttribute("aria-label"),
    readAssociatedLabelText(el),
    BUTTON_LIKE_TAGS.has(el.tagName) && el instanceof HTMLElement
      ? (el.innerText ?? el.textContent)
      : undefined,
    el.getAttribute("placeholder"),
    el.getAttribute("title"),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const collapsed = collapseWhitespace(candidate);
    if (collapsed) return truncate(collapsed, ACCESSIBLE_NAME_MAX_LENGTH);
  }

  return undefined;
}

export function describeElement(el: Element): ElementDescriptor {
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

  const label = computeAccessibleName(el);
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
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
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
  const ext = typeof file.name === "string" ? extractFileExtension(file.name) : undefined;
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
