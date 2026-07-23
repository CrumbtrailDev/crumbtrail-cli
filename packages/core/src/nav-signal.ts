/**
 * Shared navigation-commit signal.
 *
 * Several collectors need to know when the SPA route commits (history API
 * pushState/replaceState, popstate, hashchange). Wrapping `history.pushState`
 * per collector is unsafe: cleanups run in registration order, so a later
 * collector's restore re-installs an earlier collector's dead wrapper and the
 * wrapper chain grows across init/stop cycles. This module installs exactly
 * one wrapper pair and fans commits out to subscribers.
 *
 * Install/restore is refcounted: the wrap happens when the first subscriber
 * arrives and is undone when the last one leaves — and only if
 * `history.pushState` / `history.replaceState` still point at our own
 * wrappers (defensive against third-party code wrapping over us; in that
 * case we leave the chain intact rather than break the third party).
 *
 * Subscribers are notified AFTER the underlying navigation has been applied,
 * so `window.location.href` already reflects the new URL inside a callback.
 */

export type NavCommitKind = "push" | "replace" | "pop" | "hash";
export type NavCommitSubscriber = (kind: NavCommitKind) => void;

const subscribers = new Set<NavCommitSubscriber>();

let installed = false;
// Bumped on every install() and restore(); wrappers capture the value at
// install time and only notify while it is still current, so a wrapper
// leaked to a third-party chain goes silent after restore().
let generation = 0;
let origPushState: History["pushState"] | undefined;
let origReplaceState: History["replaceState"] | undefined;
let wrappedPushState: History["pushState"] | undefined;
let wrappedReplaceState: History["replaceState"] | undefined;
let onPopState: (() => void) | undefined;
let onHashChange: (() => void) | undefined;

function notify(kind: NavCommitKind): void {
  // Snapshot: a subscriber may unsubscribe (or subscribe) during dispatch.
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(kind);
    } catch {
      // One collector's failure must not break navigation or its peers.
    }
  }
}

function install(): void {
  // Capture the originals in install()-local consts. The wrappers may leak
  // (a third party wraps over us, so restore() must skip re-assignment); a
  // leaked wrapper keeps delegating to these locals forever, even after the
  // module-level state is reset. It only notifies while its generation is
  // still current, so stale wrappers never emit after restore().
  const localOrigPushState = history.pushState;
  const localOrigReplaceState = history.replaceState;
  const wrapperGeneration = ++generation;

  origPushState = localOrigPushState;
  origReplaceState = localOrigReplaceState;

  wrappedPushState = function (
    this: History,
    ...args: Parameters<History["pushState"]>
  ) {
    localOrigPushState.apply(history, args);
    if (wrapperGeneration === generation) notify("push");
  };
  wrappedReplaceState = function (
    this: History,
    ...args: Parameters<History["replaceState"]>
  ) {
    localOrigReplaceState.apply(history, args);
    if (wrapperGeneration === generation) notify("replace");
  };
  history.pushState = wrappedPushState;
  history.replaceState = wrappedReplaceState;

  onPopState = () => notify("pop");
  onHashChange = () => notify("hash");
  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", onHashChange);
  installed = true;
}

function restore(): void {
  // Restore each function only if it still points at our wrapper; a page or
  // third-party SDK may have wrapped over us, and clobbering their chain
  // would break them. Leaving our (now subscriber-less) wrapper in place is
  // harmless: it delegates to the original and notifies nobody.
  if (history.pushState === wrappedPushState && origPushState) {
    history.pushState = origPushState;
  }
  if (history.replaceState === wrappedReplaceState && origReplaceState) {
    history.replaceState = origReplaceState;
  }
  if (onPopState) window.removeEventListener("popstate", onPopState);
  if (onHashChange) window.removeEventListener("hashchange", onHashChange);
  installed = false;
  generation++;
  origPushState = undefined;
  origReplaceState = undefined;
  wrappedPushState = undefined;
  wrappedReplaceState = undefined;
  onPopState = undefined;
  onHashChange = undefined;
}

/**
 * Subscribe to navigation commits. Returns an unsubscribe function; safe to
 * call more than once. In non-browser environments this is a no-op.
 */
export function subscribeNavCommit(
  subscriber: NavCommitSubscriber,
): () => void {
  if (typeof window === "undefined" || typeof history === "undefined") {
    return () => {};
  }
  if (!installed) install();
  subscribers.add(subscriber);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && installed) restore();
  };
}
