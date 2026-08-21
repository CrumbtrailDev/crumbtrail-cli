/**
 * Turning a live document into the format's node tuples.
 *
 * Three things happen here and nowhere else: node identity is assigned, the
 * page is masked, and anything that would make a replay reach back to the
 * customer's own servers is taken out.
 *
 * ## Identity
 *
 * Every node gets an integer the first time it is seen, and keeps it for the
 * life of the recording. Deltas name nodes by that integer rather than by a
 * selector, which is both smaller and unambiguous once the tree moves.
 *
 * ## Masking
 *
 * Form values are masked in both modes. `text_masked` additionally masks
 * rendered text, character by character, so the layout survives and the words
 * do not. Masking happens here, at the point of reading the DOM, so an
 * unmasked value never exists in a buffer, a chunk, or a request body.
 *
 * ## Stylesheets
 *
 * A `<link rel=stylesheet>` is inlined into a `<style>` when its rules are
 * readable, and dropped when they are not. It is never recorded as a link. A
 * replay that fetched the customer's stylesheet would tell their servers, in
 * their own access logs, every time an employee watched a session — and would
 * show the page as it is styled today rather than as it was styled then.
 */

import { ReplayNodeTag, type ReplayMasking } from "./format";

/** The widget the SDK injects. Never part of the customer's page. */
const WIDGET_ID = "crumbtrail-widget";

/**
 * Elements dropped with their subtree.
 *
 * The decoder drops these again on the way in. Dropping them here as well is
 * not redundancy for its own sake: it keeps them out of the bytes a customer's
 * page uploads, which is a size and a privacy question before it is a safety
 * one.
 */
const DROPPED_ELEMENTS = new Set(["script", "base", "noscript"]);

/** Attributes never recorded, whatever element they sit on. */
const DROPPED_ATTRIBUTES = new Set(["srcdoc", "integrity", "nonce"]);

/** Opt out markers a customer can put on their own markup. */
const MASK_ATTRIBUTE = "data-crumbtrail-mask";
const BLOCK_ATTRIBUTE = "data-crumbtrail-block";

export interface SerializeOptions {
  masking: ReplayMasking;
  /** Interns a string into the current chunk's table. */
  intern: (value: string) => number;
  ids: NodeIds;
}

/**
 * Node identity across the whole recording.
 *
 * A `WeakMap` so a node removed from the document and dropped by the page does
 * not keep its entry alive. Ids are never reused: a recycled id would make a
 * later delta land on a node the player knows by a different name.
 */
export class NodeIds {
  private readonly ids = new WeakMap<Node, number>();
  private next = 1;

  /** The node's id, assigning one if it has never been seen. */
  idFor(node: Node): number {
    const existing = this.ids.get(node);
    if (existing !== undefined) return existing;
    const id = this.next;
    this.next += 1;
    this.ids.set(node, id);
    return id;
  }

  /** The node's id, or undefined when it was never recorded. */
  known(node: Node): number | undefined {
    return this.ids.get(node);
  }

  forget(node: Node): void {
    this.ids.delete(node);
  }
}

/** Whether this node, or anything above it, is excluded from recording. */
export function isExcluded(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current instanceof Element) {
      if (current.id === WIDGET_ID) return true;
      if (current.hasAttribute(BLOCK_ATTRIBUTE)) return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Mask a form value.
 *
 * Length preserving and content free. The length is kept because an empty box
 * and a filled one are different states of the page, and a reader watching a
 * form fail needs to see that something was typed.
 */
export function maskValue(value: string): string {
  return "*".repeat(Math.min(value.length, 64));
}

/**
 * Mask rendered text, keeping whitespace and punctuation.
 *
 * Word shapes and line breaks survive, so the page still lays out the way it
 * did. The words do not.
 */
export function maskText(value: string): string {
  return value.replace(/[^\s\p{P}]/gu, "*");
}

/** Whether an element's text must be masked whatever the project setting is. */
function elementForcesMask(element: Element): boolean {
  return (
    element.hasAttribute(MASK_ATTRIBUTE) ||
    (element instanceof HTMLInputElement && element.type === "password")
  );
}

function shouldMaskText(node: Node, masking: ReplayMasking): boolean {
  if (masking === "text_masked") return true;
  let current: Node | null = node;
  while (current) {
    if (current instanceof Element && elementForcesMask(current)) return true;
    current = current.parentNode;
  }
  return false;
}

/** The CSS text of a stylesheet, or undefined when the browser will not say. */
function readStyleSheet(element: Element): string | undefined {
  const sheets = element.ownerDocument?.styleSheets;
  if (!sheets) return undefined;
  for (const sheet of Array.from(sheets)) {
    if (sheet.ownerNode !== element) continue;
    try {
      // Throws a SecurityError for a cross origin sheet, which is the ordinary
      // case for a CDN. Nothing is recorded for it rather than a link that
      // would be fetched at watch time.
      return Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isStylesheetLink(element: Element): boolean {
  return (
    element.tagName.toLowerCase() === "link" &&
    (element.getAttribute("rel") ?? "").toLowerCase().includes("stylesheet")
  );
}

/**
 * Attribute name and value pairs for an element, interned as they are met.
 *
 * A valueless attribute (`disabled`, `checked`) is an explicit null rather than
 * an interned empty string, because the two render differently for boolean
 * attributes and collapsing them loses real page state.
 */
export function serializeAttributes(
  element: Element,
  options: SerializeOptions,
): unknown[] {
  const pairs: unknown[] = [];
  for (const attr of Array.from(element.attributes)) {
    if (!isRecordableAttribute(attr.name)) continue;
    pairs.push(options.intern(attr.name));
    pairs.push(attr.value === "" ? null : options.intern(attr.value));
  }
  return pairs;
}

/**
 * Whether an attribute may be written into a chunk at all.
 *
 * The snapshot path and the mutation path must agree on this, and for a while
 * they did not: the opening snapshot dropped these names and the mutation
 * branch re-read `getAttribute` with no filter, so
 * `input.setAttribute("value", "4111111111111111")` — the ordinary vanilla or
 * jQuery way to prefill or clear a field — put the raw value straight into a
 * chunk, defeating the module's guarantee that an unmasked value never exists
 * in a buffer, a chunk, or a request body. `nonce` and `integrity` leaked by
 * the same route, and an inline handler carries page source.
 *
 * - `srcdoc`/`integrity`/`nonce`: content or security material, never layout.
 * - `on*`: an event handler is page source, and the decoder drops it anyway.
 * - `value`/`checked`: a form control's current state lives in its property
 *   once the page has touched it and is carried by masked input events. The
 *   attribute is whatever the markup was built with, or whatever the page just
 *   wrote into it.
 */
export function isRecordableAttribute(attributeName: string): boolean {
  const name = attributeName.toLowerCase();
  if (DROPPED_ATTRIBUTES.has(name)) return false;
  if (name.startsWith("on")) return false;
  if (name === "value" || name === "checked") return false;
  return true;
}

/**
 * Serialize one node and its subtree.
 *
 * Returns `undefined` for anything not recorded, which the caller omits. A
 * dropped node never gets an id, so a later delta naming something inside it is
 * a miss rather than a resurrection.
 */
export function serializeNode(
  node: Node,
  options: SerializeOptions,
): unknown[] | undefined {
  if (isExcluded(node)) return undefined;

  switch (node.nodeType) {
    case ReplayNodeTag.Document: {
      // The document's own id is claimed before its children are walked. Ids
      // are assigned in document order, and a parent numbered after its
      // subtree is a tree no other implementation would reproduce.
      const id = options.ids.idFor(node);
      const children: unknown[] = [];
      for (const child of Array.from(node.childNodes)) {
        const serialized = serializeNode(child, options);
        if (serialized) children.push(serialized);
      }
      return [ReplayNodeTag.Document, id, children];
    }
    case ReplayNodeTag.DocumentType: {
      const doctype = node as DocumentType;
      return [
        ReplayNodeTag.DocumentType,
        options.ids.idFor(node),
        options.intern(doctype.name),
      ];
    }
    case ReplayNodeTag.Text: {
      const raw = node.textContent ?? "";
      const text = shouldMaskText(node, options.masking) ? maskText(raw) : raw;
      return [
        ReplayNodeTag.Text,
        options.ids.idFor(node),
        options.intern(text),
      ];
    }
    case ReplayNodeTag.Comment:
      return [
        ReplayNodeTag.Comment,
        options.ids.idFor(node),
        options.intern(node.textContent ?? ""),
      ];
    case ReplayNodeTag.Element: {
      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      if (DROPPED_ELEMENTS.has(tag)) return undefined;
      if (isStylesheetLink(element)) return inlineStylesheet(element, options);

      const id = options.ids.idFor(node);
      // Interning order is load bearing: tag, then attributes, then children,
      // which is the first-seen order the golden fixtures pin. A table in any
      // other order is one no encoder could have produced.
      const tagRef = options.intern(tag);
      const attrs = serializeAttributes(element, options);
      const children: unknown[] = [];
      for (const child of Array.from(element.childNodes)) {
        const serialized = serializeNode(child, options);
        if (serialized) children.push(serialized);
      }
      return [ReplayNodeTag.Element, id, tagRef, attrs, children];
    }
    default:
      return undefined;
  }
}

/**
 * A `<link rel=stylesheet>` recorded as the rules it resolved to.
 *
 * The link keeps its own id, so a later mutation naming it still lands. When
 * the rules cannot be read the element is recorded with no attributes at all:
 * an empty `<style>` renders as the page missing that sheet, which is what a
 * cross origin stylesheet actually costs a replay.
 */
function inlineStylesheet(
  element: Element,
  options: SerializeOptions,
): unknown[] {
  const id = options.ids.idFor(element);
  const tagRef = options.intern("style");
  const css = readStyleSheet(element);
  const children: unknown[] = css
    ? [
        [
          ReplayNodeTag.Text,
          // The rules are recorded as a text node the page does not have, so it
          // needs an id of its own. It is detached and never mutated, so no
          // later delta can name it.
          options.ids.idFor(element.ownerDocument.createTextNode("")),
          options.intern(css),
        ],
      ]
    : [];
  return [ReplayNodeTag.Element, id, tagRef, [], children];
}
