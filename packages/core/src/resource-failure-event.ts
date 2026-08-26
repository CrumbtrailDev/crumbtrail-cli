import type { EventBus } from "./event-bus";
import { attachRedactionMetadata, redactUrl } from "./redaction";
import { now } from "./utils";

export interface ResourceFailureRecord {
  element?: string;
  url: string;
  loading?: boolean;
}

/** Emits one browser-managed resource failure through the normal network-error schema. */
export function emitResourceFailure(
  bus: EventBus,
  record: ResourceFailureRecord,
): void {
  const url = redactUrl(record.url, "url");
  const d: Record<string, unknown> = {
    transport: "resource",
    element: record.element,
    url: url.value,
    loading: record.loading,
  };
  attachRedactionMetadata(d, url.metadata);
  bus.emit({ t: now(), k: "net.err", d });
}
