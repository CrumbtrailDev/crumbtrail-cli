import type { BugEvent, CrumbtrailTransport, BugReport } from "../types";

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
    try {
      await fetch(`${this.endpoint}/api/events`, init);
    } catch {
      // Mirrors endSession: during teardown fetch can be torn down mid-flight;
      // sendBeacon is queued by the browser and survives unload. sessionId is
      // already in the body. No auth header on this path (same as endSession).
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function"
      ) {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(`${this.endpoint}/api/events`, blob);
      }
    }
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
    await fetch(`${this.endpoint}/api/blob/${name}`, {
      method: "POST",
      headers,
      body: blob,
    });
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
