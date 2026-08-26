import type { EventBus } from "../event-bus";
import type { CollectorCleanup } from "../types";
import { UI_ERROR_EVENT_KIND } from "../types";
import { now } from "../utils";

type RenderedErrorKind = "aria-alert" | "aria-invalid" | "native-invalid";

function hasErrorRole(element: Element): boolean {
  return (element.getAttribute("role") ?? "")
    .trim()
    .split(/\s+/)
    .some((role) => role === "alert" || role === "alertdialog");
}

function hasAriaInvalid(element: Element): boolean {
  return (element.getAttribute("aria-invalid") ?? "").toLowerCase() === "true";
}

function errorKind(element: Element): RenderedErrorKind | undefined {
  if (hasErrorRole(element)) return "aria-alert";
  if (hasAriaInvalid(element)) return "aria-invalid";
  return undefined;
}

function addElements(node: Node, elements: Set<Element>): void {
  if (node instanceof Element) {
    elements.add(node);
    for (const element of node.querySelectorAll("*")) elements.add(element);
  }
}

function addAncestors(
  element: Element | null,
  elements: Set<Element>,
): void {
  for (let current = element; current; current = current.parentElement)
    elements.add(current);
}

function isConnected(element: Element): boolean {
  return (
    element.ownerDocument === document &&
    document.documentElement.contains(element)
  );
}

function isNativeControl(element: Element): boolean {
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLObjectElement ||
    element instanceof HTMLOutputElement
  );
}

/**
 * Emits metadata-only events when the browser exposes a rendered validation failure.
 * The event never carries rendered copy or a selector. DOM text is captured separately
 * by the flag snapshot, under the normal masking policy.
 */
export function renderedErrorCollector(bus: EventBus): CollectorCleanup {
  if (
    typeof document === "undefined" ||
    typeof document.addEventListener !== "function" ||
    typeof MutationObserver !== "function"
  )
    return () => {};

  const ids = new WeakMap<Element, number>();
  const active = new Set<Element>();
  const contentful = new WeakMap<Element, boolean>();
  let nextId = 1;

  const idFor = (element: Element): number => {
    const existing = ids.get(element);
    if (existing !== undefined) return existing;
    ids.set(element, nextId);
    return nextId++;
  };

  const emit = (element: Element, kind: RenderedErrorKind) => {
    bus.emit({
      t: now(),
      k: UI_ERROR_EVENT_KIND,
      d: { id: idFor(element), kind },
    });
  };

  // Existing error states are context, not a transition caused by this SDK starting.
  for (const element of document.querySelectorAll("[role], [aria-invalid]")) {
    if (!isConnected(element)) continue;
    if (errorKind(element)) active.add(element);
    if (hasErrorRole(element))
      contentful.set(element, (element.textContent ?? "").trim().length > 0);
  }

  const observer = new MutationObserver((records) => {
    const candidates = new Set<Element>();
    const removed = new Set<Element>();
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.addedNodes) addElements(node, candidates);
        for (const node of record.removedNodes) addElements(node, removed);
        addAncestors(
          record.target instanceof Element ? record.target : null,
          candidates,
        );
      } else if (record.type === "attributes") {
        if (record.target instanceof Element) candidates.add(record.target);
      } else if (record.type === "characterData") {
        addAncestors(record.target.parentElement, candidates);
      }
    }

    // A detach followed by a reattach is a new entry into the document.
    for (const element of removed) active.delete(element);

    for (const element of candidates) {
      if (!isConnected(element)) {
        active.delete(element);
        continue;
      }

      const kind = errorKind(element);
      if (kind === undefined) {
        active.delete(element);
        continue;
      }

      const wasActive = active.has(element);
      const hasContent = hasErrorRole(element)
        ? (element.textContent ?? "").trim().length > 0
        : false;
      const becamePopulated =
        hasErrorRole(element) && !contentful.get(element) && hasContent;

      if (!wasActive || becamePopulated) emit(element, kind);
      active.add(element);
      if (hasErrorRole(element)) contentful.set(element, hasContent);
    }
  });

  observer.observe(document, {
    attributes: true,
    attributeFilter: ["role", "aria-invalid"],
    childList: true,
    characterData: true,
    subtree: true,
  });

  const onInvalid = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || !isNativeControl(target)) return;
    emit(target, "native-invalid");
  };
  document.addEventListener("invalid", onInvalid, true);

  return () => {
    observer.disconnect();
    document.removeEventListener("invalid", onInvalid, true);
    active.clear();
  };
}
