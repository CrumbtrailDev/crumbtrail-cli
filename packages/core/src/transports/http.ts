import type { BugEvent, CrumbtrailTransport, BugReport } from "../types";

/**
 * A batch the server refused.
 *
 * `fetch` resolves for 4xx and 5xx alike, so a transport that only catches
 * thrown errors treats "payload too large" and "rate limited" as delivery. The
 * events are dropped, nothing records it, and the resulting session is
 * indistinguishable from one where nothing happened. Throwing lets the caller
 * declare the hole.
 */
export class EventDeliveryError extends Error {
  /** HTTP status, or 0 when the request never produced a response. */
  readonly status: number;
  readonly eventCount: number;

  constructor(status: number, eventCount: number) {
    super(
      status > 0
        ? `capture endpoint rejected ${eventCount} event(s) with ${status}`
        : `capture endpoint unreachable for ${eventCount} event(s)`,
    );
    this.name = "EventDeliveryError";
    this.status = status;
    this.eventCount = eventCount;
  }
}

/**
 * A stored object the server refused.
 *
 * Separate from {@link EventDeliveryError} because it carries no event count: a
 * blob is one artifact, and reporting it as "rejected 0 events" would read as a
 * refusal that cost nothing.
 */
export class BlobDeliveryError extends Error {
  readonly status: number;
  readonly objectName: string;

  constructor(objectName: string, status: number) {
    super(`capture endpoint refused ${objectName} with ${status}`);
    this.name = "BlobDeliveryError";
    this.status = status;
    this.objectName = objectName;
  }
}

export interface HttpTransportOptions {
  authToken?: string;
}

/**
 * Browsers cap the total in-flight `keepalive` request body budget at 64 KiB
 * and reject oversized bodies outright. Stay under a conservative 60 KB so a
 * batch never fails just because it asked to outlive the page; bigger batches
 * fall back to a plain fetch.
 */
const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * Exact UTF-8 byte length via TextEncoder (available in every browser and
 * Node release we support). The `String.length` fallback counts UTF-16 code
 * units, which under-counts multi-byte characters; the 60 KB budget vs the
 * 64 KiB browser cap absorbs that slack for our mostly-ASCII JSON payloads.
 */
function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

export class HttpTransport implements CrumbtrailTransport {
  private sessionId = "";
  private authToken?: string;
  private endpoint: string;

  constructor(endpoint: string, options?: HttpTransportOptions) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.authToken = options?.authToken;
  }

  private withAuthHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    if (!this.authToken) return headers;
    return { ...headers, "X-Crumbtrail-Auth": this.authToken };
  }

  async sendEvents(events: BugEvent[]): Promise<void> {
    const body = JSON.stringify({ sessionId: this.sessionId, events });
    const init: RequestInit = {
      method: "POST",
      headers: this.withAuthHeaders({ "Content-Type": "application/json" }),
      body,
    };
    // keepalive lets the request outlive the page (pagehide/tab close), but
    // only bodies under the browser's keepalive budget may opt in.
    if (utf8ByteLength(body) <= KEEPALIVE_MAX_BYTES) init.keepalive = true;
    let response: Response | undefined;
    try {
      response = await fetch(`${this.endpoint}/api/events`, init);
    } catch {
      // Mirrors endSession: during teardown fetch can be torn down mid-flight;
      // sendBeacon is queued by the browser and survives unload. sessionId is
      // already in the body. No auth header on this path (same as endSession).
      //
      // The return value matters. A page that logs in a tight loop exhausts the
      // browser's in-flight request budget, every fetch rejects, and the beacon
      // queue is full too — so `sendBeacon` answers false and the batch is
      // simply gone. Swallowing that is how a session drops most of a burst and
      // still reports itself complete.
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function"
      ) {
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(`${this.endpoint}/api/events`, blob)) return;
      }
      throw new EventDeliveryError(0, events.length);
    }
    // A refusal is not a delivery. Retrying by beacon would be refused the same
    // way, so surface it instead: the caller turns this into a capture gap.
    if (response && !response.ok)
      throw new EventDeliveryError(response.status, events.length);
  }

  async sendBlob(
    name: string,
    blob: Blob,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const headers = this.withAuthHeaders({
      "Content-Type": "application/octet-stream",
      "X-Session-Id": this.sessionId,
    });
    if (metadata) {
      headers["X-Metadata"] = JSON.stringify(metadata);
    }
    const response = await fetch(`${this.endpoint}/api/blob/${name}`, {
      method: "POST",
      headers,
      body: blob,
    });
    // A refusal is not a delivery. Session replay in particular is refused with
    // 403 by a project that has not opted in, and a caller that read that as
    // success would keep uploading a recording the server is discarding.
    if (!response.ok) throw new BlobDeliveryError(name, response.status);
  }

  async startSession(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.sessionId = sessionId;
    await fetch(`${this.endpoint}/api/session/start`, {
      method: "POST",
      headers: this.withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sessionId, metadata }),
    });
  }

  async sendBugReport(
    report: BugReport,
    events: BugEvent[],
    voiceBlob?: Blob,
  ): Promise<void> {
    await fetch(`${this.endpoint}/api/bug/flag`, {
      method: "POST",
      headers: this.withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ report, events }),
    });

    if (voiceBlob) {
      await fetch(`${this.endpoint}/api/bug/${report.bugId}/voice`, {
        method: "POST",
        headers: this.withAuthHeaders({
          "Content-Type": "application/octet-stream",
        }),
        body: voiceBlob,
      });
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const body = JSON.stringify({ sessionId });
    try {
      await fetch(`${this.endpoint}/api/session/end`, {
        method: "POST",
        headers: this.withAuthHeaders({ "Content-Type": "application/json" }),
        body,
      });
    } catch {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function"
      ) {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(`${this.endpoint}/api/session/end`, blob);
      }
    }
  }
}
