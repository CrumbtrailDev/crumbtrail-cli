import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { attachRedactionMetadata, redactUrl } from "../redaction";
import { now } from "../utils";

/**
 * Server-sent events lifecycle.
 *
 * A stream that silently drops and reconnects leaves the page rendering stale
 * data with no error, no failed request, and no visible break — the app just
 * stops updating. `EventSource` reconnects on its own, so the only trace is the
 * open/error rhythm and the message count that stops climbing.
 *
 * Metadata only: the URL, the lifecycle transition, and how many messages
 * arrived. Message payloads are never read.
 */

/** A fresh stream to the same URL inside this window reads as a reconnect. */
export const SSE_REOPEN_WINDOW_MS = 30_000;

type SseOp = "open" | "error" | "close";

export function eventSourceCollector(
  bus: EventBus,
  _config: CrumbtrailConfig,
): CollectorCleanup {
  const OriginalEventSource = globalThis.EventSource;
  if (typeof OriginalEventSource !== "function") return () => {};

  // url -> timestamp of the last error/close. Keyed by string, so a closed
  // stream is not kept alive by this map.
  const lastEnded = new Map<string, number>();

  const emit = (
    url: string,
    op: SseOp,
    extra: { count?: number; reopen?: boolean } = {},
  ): void => {
    try {
      const urlResult = redactUrl(url, "url");
      const d: Record<string, unknown> = { url: urlResult.value, op };
      if (extra.count !== undefined) d.count = extra.count;
      if (extra.reopen) d.reopen = true;
      attachRedactionMetadata(d, urlResult.metadata);
      bus.emit({ t: now(), k: "net.sse", d });
    } catch {
      // Capture never breaks the stream.
    }
  };

  class InstrumentedEventSource extends OriginalEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      const href = typeof url === "string" ? url : String(url);
      let count = 0;
      const previousEnd = lastEnded.get(href);
      const reopen =
        previousEnd !== undefined && now() - previousEnd <= SSE_REOPEN_WINDOW_MS;

      try {
        this.addEventListener("open", () => {
          emit(href, "open", reopen ? { reopen: true } : {});
        });
        // Counting only: the event object is never read.
        this.addEventListener("message", () => {
          count += 1;
        });
        this.addEventListener("error", () => {
          lastEnded.set(href, now());
          emit(href, "error", { count });
        });
      } catch {
        // A host EventSource without addEventListener still works; it just
        // reports nothing.
      }

      const close = this.close.bind(this);
      this.close = () => {
        lastEnded.set(href, now());
        emit(href, "close", { count });
        close();
      };
    }
  }

  globalThis.EventSource =
    InstrumentedEventSource as unknown as typeof EventSource;

  return () => {
    // Only unwind our own patch: a third party may have replaced the
    // constructor after us.
    if (globalThis.EventSource === (InstrumentedEventSource as unknown)) {
      globalThis.EventSource = OriginalEventSource;
    }
    lastEnded.clear();
  };
}
