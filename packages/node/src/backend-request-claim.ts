/**
 * Which recorder owns one inbound request.
 *
 * Two recorders can see the same request in one process: the `node:http`
 * capture installed by `autoCapture` (which every wizard install injects) and
 * the Express middleware a user wired by hand or that `crumbtrail install`
 * added for an express recipe. Without this, an express app with both would
 * report every request twice — two `backend.req.start` events, two
 * `backend.req.end` events, one request.
 *
 * The Express middleware claims a request when it runs. The http capture holds
 * its events until the response is finished and then checks the claim, so a
 * claim made after the request started still wins: the framework-aware recorder
 * knows the matched route and the error the handler threw, and the http
 * recorder knows neither.
 *
 * A `WeakSet` keyed on the request object, so a claim costs nothing after the
 * request is collected and can never keep one alive.
 */
const claimed = new WeakSet<object>();

/** Claim a request for a framework-aware recorder. Idempotent. */
export function claimBackendRequest(req: unknown): void {
  if (typeof req !== "object" || req === null) return;
  claimed.add(req as object);
}

/** Whether a framework-aware recorder has claimed this request. */
export function isBackendRequestClaimed(req: unknown): boolean {
  if (typeof req !== "object" || req === null) return false;
  return claimed.has(req as object);
}
