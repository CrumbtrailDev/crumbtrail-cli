import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { truncate, now } from "../utils";
import {
  attachRedactionMetadata,
  redactNetworkTextBody,
  type PayloadSummary,
} from "../redaction";
import { isBlocked, isUnmasked, maskText } from "../masking";

export function clipboardCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const maxLen = config.clipboardMaxLength;

  const handler = (event: Event) => {
    const type = event.type as "copy" | "cut" | "paste";
    const target = resolveTarget(event);
    if (target && isBlocked(target)) return;
    let txt: string | undefined;

    if (type === "paste") {
      const ce = event as ClipboardEvent;
      txt = ce.clipboardData?.getData("text/plain");
    } else {
      txt = window.getSelection()?.toString();
    }

    const d: Record<string, unknown> = { op: type };
    if (txt) {
      if (target && isUnmasked(target)) {
        d.txt = truncate(txt, maxLen);
      } else if (config.maskAllText) {
        d.txt = maskText(truncate(txt, maxLen));
      } else if (config.captureRawClipboard) {
        d.txt = truncate(txt, maxLen);
      } else {
        // Redact the whole text, then truncate. Truncating first can cut a
        // token in half, and the half that survives matches no token pattern
        // and is stored in the clear.
        const redacted = redactNetworkTextBody(txt, {
          contentType: "text/plain",
          path: "txt",
        });
        // `?? ""` erased the paste. `looksLikeJson` overrides the declared
        // text/plain, so `{"amount": 12.50,}` — JSON-shaped and not JSON — came
        // back with only a summary and the content that caused the bug was
        // gone. error.ts states the omission instead of hiding it.
        d.txt = truncate(
          redacted.body ?? bodyPlaceholder(redacted.bodySummary),
          maxLen,
        );
        if (redacted.bodySummary) d.txtSummary = redacted.bodySummary;
        attachRedactionMetadata(d, redacted.metadata);
      }
    }
    if (target) {
      const el: Record<string, unknown> = { tag: target.tagName };
      if (target.id) el.id = target.id;
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

function resolveTarget(event: Event): Element | undefined {
  if (event.target instanceof Element) return event.target;
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  if (!anchor) return undefined;
  return anchor instanceof Element
    ? anchor
    : (anchor.parentElement ?? undefined);
}

function bodyPlaceholder(summary: PayloadSummary | undefined): string {
  return summary ? `[${summary.action}:${summary.reason}]` : "[REDACTED]";
}
