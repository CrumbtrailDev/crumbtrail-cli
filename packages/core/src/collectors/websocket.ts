import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import {
  attachRedactionMetadata,
  redactNetworkTextBody,
  redactUrl,
} from "../redaction";
import { now } from "../utils";
import { bodyRedactionOptions } from "./network";

/**
 * WebSocket traffic.
 *
 * The transport was entirely invisible. `fetch` and `XMLHttpRequest` are patched, server-sent
 * events report their lifecycle, and a socket reported nothing at all — not that it opened, not
 * that it dropped, not a single frame. For an application whose state arrives over a socket, that
 * is the whole conversation missing: the page shows a stale price, a duplicated row, an order that
 * never advanced, and the capture contains no reason it could have happened, because nothing the
 * server said was ever written down.
 *
 * Frames are captured, not merely counted, and that is the deliberate difference from
 * `eventsource.ts`. Server-sent events are a one-way notification channel whose lifecycle rhythm is
 * usually the defect; a socket carries the application's actual state transitions, and a count of
 * them answers no question anyone asks. The same structured redaction that runs over request and
 * response bodies runs over every frame, so this captures no class of value the network collector
 * does not already capture.
 *
 * Bounded on three axes, because a chatty socket is a normal thing and must not be able to fill a
 * session with itself: bytes per frame, frames per socket, and frames across all sockets. Once a
 * socket passes its frame cap it keeps counting and stops quoting, so the tail of a long
 * conversation still reports its shape.
 */

/** Per-socket frame cap. Beyond this a socket counts and stops quoting. */
export const WS_MAX_FRAMES_PER_SOCKET = 40;
/** Session-wide frame cap, so many small sockets cannot add up to the same problem. */
export const WS_MAX_FRAMES_TOTAL = 200;
/** Redacted bytes kept per frame. */
export const WS_MAX_FRAME_BYTES = 2_048;
/** A fresh socket to the same URL inside this window reads as a reconnect. */
export const WS_REOPEN_WINDOW_MS = 30_000;

interface WsGlobal {
  WebSocket?: typeof WebSocket;
}

export function webSocketCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const scope = globalThis as WsGlobal;
  const OriginalWebSocket = scope.WebSocket;
  if (typeof OriginalWebSocket !== "function") return () => {};

  // url -> timestamp of the last close/error. Keyed by string so a dead socket is not kept alive.
  const lastEnded = new Map<string, number>();
  let totalFrames = 0;
  let nextSocketId = 0;

  const emit = (d: Record<string, unknown>): void => {
    try {
      bus.emit({ t: now(), k: "net.ws", d });
    } catch {
      // Capture never breaks the socket.
    }
  };

  const emitFrame = (
    socketId: number,
    url: string,
    op: "msg" | "send",
    payload: unknown,
    seq: number,
  ): void => {
    try {
      const d: Record<string, unknown> = { id: socketId, url, op, seq };

      if (typeof payload === "string") {
        // No declared content type. Declaring `application/json` was the belief
        // that the structured policy falls back to whole-value treatment when
        // the text does not parse — it does not. A `json` kind that fails
        // JSON.parse ends in `dropped: malformed_json_body` with no body at
        // all, so socket.io (`42["priceUpdate",…]`), STOMP, a bare `PING` and
        // any pipe-delimited tick were replaced by a stub that blamed the
        // application for sending bad JSON. Undeclared, `looksLikeJson`
        // classifies, and anything that is not JSON keeps its free-text scrub.
        const result = redactNetworkTextBody(payload, {
          maxLength: WS_MAX_FRAME_BYTES,
          path: "frame",
          ...bodyRedactionOptions(config),
        });
        if (result.body !== undefined) d.body = result.body;
        if (result.bodySummary) d.bodySummary = result.bodySummary;
        d.bytes = payload.length;
        attachRedactionMetadata(d, result.metadata);
      } else {
        // Binary frames are reported by shape only. Decoding one would mean guessing an encoding
        // and then redacting whatever came out, and a wrong guess publishes bytes nobody reviewed.
        d.binary = true;
        d.bytes = binaryByteLength(payload);
      }

      emit(d);
    } catch {
      // Capture never breaks the socket.
    }
  };

  class InstrumentedWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url as string, protocols as string[]);

      const socketId = (nextSocketId += 1);
      const href = typeof url === "string" ? url : String(url);
      const redactedUrl = safeRedactUrl(href);
      let received = 0;
      let sent = 0;
      let quoted = 0;
      const previousEnd = lastEnded.get(href);
      const reopen =
        previousEnd !== undefined && now() - previousEnd <= WS_REOPEN_WINDOW_MS;

      /** May this socket quote one more frame? Counters still advance either way. */
      const mayQuote = (): boolean =>
        quoted < WS_MAX_FRAMES_PER_SOCKET && totalFrames < WS_MAX_FRAMES_TOTAL;

      const spend = (): void => {
        quoted += 1;
        totalFrames += 1;
      };

      try {
        this.addEventListener("open", () => {
          emit({
            id: socketId,
            url: redactedUrl,
            op: "open",
            ...(reopen ? { reopen: true } : {}),
          });
        });

        this.addEventListener("message", (event: MessageEvent) => {
          received += 1;
          if (!mayQuote()) return;
          spend();
          emitFrame(socketId, redactedUrl, "msg", event.data, received);
        });

        this.addEventListener("error", () => {
          lastEnded.set(href, now());
          emit({
            id: socketId,
            url: redactedUrl,
            op: "error",
            received,
            sent,
          });
        });

        this.addEventListener("close", (event: CloseEvent) => {
          lastEnded.set(href, now());
          emit({
            id: socketId,
            url: redactedUrl,
            op: "close",
            received,
            sent,
            // A socket that closes uncleanly mid-conversation is the shape of a dropped stream, and
            // the code is the only thing that distinguishes it from an ordinary teardown.
            ...(typeof event.code === "number" ? { code: event.code } : {}),
            ...(typeof event.wasClean === "boolean"
              ? { clean: event.wasClean }
              : {}),
          });
        });
      } catch {
        // A host WebSocket without addEventListener still works; it just reports nothing.
      }

      const send = this.send.bind(this);
      this.send = (data: Parameters<WebSocket["send"]>[0]) => {
        sent += 1;
        if (mayQuote()) {
          spend();
          emitFrame(socketId, redactedUrl, "send", data, sent);
        }
        send(data);
      };
    }
  }

  scope.WebSocket = InstrumentedWebSocket as unknown as typeof WebSocket;

  return () => {
    // Only unwind our own patch: a third party may have replaced the constructor after us.
    if (scope.WebSocket === (InstrumentedWebSocket as unknown)) {
      scope.WebSocket = OriginalWebSocket;
    }
    lastEnded.clear();
  };
}

function safeRedactUrl(url: string): string {
  try {
    const result = redactUrl(url, "url");
    return result.value;
  } catch {
    return "";
  }
}

function binaryByteLength(payload: unknown): number | undefined {
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(payload)) {
    return payload.byteLength;
  }
  if (typeof Blob !== "undefined" && payload instanceof Blob) {
    return payload.size;
  }
  return undefined;
}
