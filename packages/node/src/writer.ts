import type { BugEvent } from "crumbtrail-core";
import {
  DEFAULT_MAX_SESSION_EVENT_BYTES,
  defaultSessionStore,
  type AppendEventsOptions,
  type AppendEventsResult,
} from "./session-store";

export { DEFAULT_MAX_SESSION_EVENT_BYTES };
export type { AppendEventsOptions, AppendEventsResult };

export function appendEvents(
  sessionDir: string,
  events: BugEvent[],
  options: AppendEventsOptions = {},
): AppendEventsResult {
  return defaultSessionStore.appendEvents(sessionDir, events, options);
}

export function writeBlob(
  sessionDir: string,
  name: string,
  data: Buffer,
): void {
  defaultSessionStore.writeBlob(sessionDir, name, data);
}
