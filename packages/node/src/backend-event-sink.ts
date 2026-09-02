import type { BugEvent } from "crumbtrail-core";

/** The small capture surface background work needs. */
export interface BackendEventSink {
  /** The session this sink owns, when it has one. */
  readonly sessionId?: string;
  /** Deliver one or more events. Delivery failures are capture failures. */
  record(events: BugEvent | readonly BugEvent[]): Promise<void>;
  /** Drain transport buffers without ending the session. */
  flush?(): Promise<void>;
  /** End a child session owned by this sink. */
  end?(): Promise<void>;
  /** Create a separately addressable session for one job execution. */
  startChildSession?(input: {
    sessionId: string;
    metadata?: Record<string, unknown>;
  }): Promise<BackendEventSink>;
  /** Write a durable causal edge between two sessions. */
  linkSessions?(input: {
    fromSessionId: string;
    toSessionId: string;
    relation: "caused" | "continues" | "retries" | "fans_out_to";
    method:
      | "threaded_id"
      | "trace_context"
      | "inferred_row"
      | "inferred_identity"
      | "operator";
    confidence: number;
    matchedOn?: Record<string, unknown>;
    anchorHint?: string;
  }): Promise<void>;
}

let activeSink: BackendEventSink | undefined;

/** Install the process capture sink used by generic job helpers. */
export function setActiveBackendEventSink(sink: BackendEventSink): void {
  activeSink = sink;
}

/** Read the process capture sink, if auto capture is running. */
export function getActiveBackendEventSink(): BackendEventSink | undefined {
  return activeSink;
}

/** Remove a sink only when it is still the active owner. */
export function clearActiveBackendEventSink(sink?: BackendEventSink): void {
  if (!sink || activeSink === sink) activeSink = undefined;
}
