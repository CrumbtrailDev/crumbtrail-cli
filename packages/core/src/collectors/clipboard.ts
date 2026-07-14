import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { truncate, now } from "../utils";
import { attachRedactionMetadata, redactNetworkTextBody } from "../redaction";

export function clipboardCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const maxLen = config.clipboardMaxLength;

  const handler = (event: Event) => {
    const type = event.type as "copy" | "cut" | "paste";
    let txt: string | undefined;

    if (type === "paste") {
      const ce = event as ClipboardEvent;
      txt = ce.clipboardData?.getData("text/plain");
    } else {
      txt = window.getSelection()?.toString();
    }

    const d: Record<string, unknown> = { op: type };
    if (txt) {
      const truncated = truncate(txt, maxLen);
      if (config.captureRawClipboard) {
        d.txt = truncated;
      } else {
        const redacted = redactNetworkTextBody(truncated, {
          contentType: "text/plain",
          path: "txt",
        });
        d.txt = redacted.body ?? "";
        if (redacted.bodySummary) d.txtSummary = redacted.bodySummary;
        attachRedactionMetadata(d, redacted.metadata);
      }
    }
    if (event.target instanceof Element) {
      const el: Record<string, unknown> = { tag: event.target.tagName };
      if (event.target.id) el.id = event.target.id;
      d.el = el;
    }

    bus.emit({ t: now(), k: "clip", d });
  };

  document.addEventListener("copy", handler, true);
  document.addEventListener("cut", handler, true);
  document.addEventListener("paste", handler, true);

  return () => {
    document.removeEventListener("copy", handler, true);
    document.removeEventListener("cut", handler, true);
    document.removeEventListener("paste", handler, true);
  };
}
