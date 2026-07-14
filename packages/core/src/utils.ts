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

  return desc;
}

export function generateSessionId(): string {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return `ses_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${randomHex(6)}`;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error(
      "Crumbtrail requires crypto.getRandomValues to generate session IDs safely",
    );
  }
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function now(): number {
  return Date.now();
}
