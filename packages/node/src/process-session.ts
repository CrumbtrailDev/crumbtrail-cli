/**
 * The session this process owns, for backend events no browser correlated.
 *
 * `autoCapture` mints one session id and opens a session on the capture
 * endpoint for the errors it catches. The request recorders — the Express
 * middleware and the `node:http` capture — took their session only from the
 * browser's `x-crumbtrail-session-id` header, so on a backend with no browser
 * in the picture (an API, a worker, a service called by another service) every
 * request event was refused by the intake for having no session and dropped.
 * The visible result was a captured crash with `route: null` while the
 * middleware that knew the matched route and the thrown error reported nothing.
 *
 * So the recorders fall back to this id when, and only when, the request
 * carried no correlation of its own. A browser-correlated request still lands
 * in the browser's session exactly as before — the fallback is never consulted
 * for it — and the event records `sessionIdSource: "process"` so a reader can
 * tell a process-owned request from a joined one.
 *
 * Registered only once `autoCapture`'s handshake has succeeded, because the id
 * is useful as a fallback precisely when the endpoint already knows it: an id
 * no session start ever announced would be a different kind of drop.
 */
let processSessionId: string | undefined;

/** Announce the process's own capture session. Last writer wins. */
export function setProcessSessionId(sessionId: string | undefined): void {
  const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
  processSessionId = trimmed || undefined;
}

/**
 * Withdraw the process session. A `sessionId` argument only clears when it is
 * the id still registered, so one capture's `stop()` cannot silence another's.
 */
export function clearProcessSessionId(sessionId?: string): void {
  if (sessionId !== undefined && processSessionId !== sessionId) return;
  processSessionId = undefined;
}

/** The process's own capture session, when one has been established. */
export function getProcessSessionId(): string | undefined {
  return processSessionId;
}
