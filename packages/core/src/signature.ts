export interface ElementSignature {
  /** Deterministic structural path from a uniquely-identified ancestor (or root) to the element. */
  path: string;
  /** Short stable hash of `path` — the element's identity across sessions. */
  sig: string;
}

/** Attribute names that uniquely identify an element, in priority order. */
const STABLE_ID_ATTRS = ['data-bug-id', 'data-testid', 'data-test', 'id'];

function stableAttr(el: Element): string | undefined {
  for (const attr of STABLE_ID_ATTRS) {
    const value = el.getAttribute?.(attr);
    if (value) return `${attr}=${value}`;
  }
  return undefined;
}

function segment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const attr = stableAttr(el);
  if (attr) return `${tag}[${attr}]`;

  const parent = el.parentElement;
  if (!parent) return tag;

  let index = 1;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === el) break;
    if (sibling.tagName === el.tagName) index++;
  }
  return `${tag}:nth-of-type(${index})`;
}

/** Build a deterministic path, stopping early at the first uniquely-identified ancestor. */
export function computeElementPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  let guard = 0;
  while (current && guard++ < 50) {
    const seg = segment(current);
    parts.unshift(seg);
    if (seg.includes('[')) break; // uniquely identified — no need to climb further
    current = current.parentElement;
  }
  return parts.join('>');
}

/** FNV-1a 32-bit, rendered base36. Deterministic, dependency-free. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function computeElementSignature(el: Element): ElementSignature {
  const path = computeElementPath(el);
  return { path, sig: hashString(path) };
}
