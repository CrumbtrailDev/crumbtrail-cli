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
 * Worker message traffic.
 *
 * A worker is a second program with its own global scope. Nothing this SDK patches exists inside
 * it: a `fetch` made from a worker is not recorded, an error thrown there does not reach the page's
 * handlers, and the work it does is invisible from the window. Applications put exactly the
 * interesting things there - parsing, pricing, sync, encryption, offline queues - so a capture that
 * says nothing about workers can be silent about the entire computation that produced a wrong
 * answer, while faithfully recording the click that asked for it.
 *
 * What IS observable from the window is the conversation: the script that was loaded and the
 * messages posted in each direction. That conversation is usually the application's own protocol -
 * "price these lines", "here are the totals" - and it names the inputs and outputs of the invisible
 * computation even when the computation itself stays dark.
 *
 * Message payloads go through the same structured redaction as a request body. Bounded like socket
 * frames, and for the same reason: a worker that streams progress updates must not be able to fill
 * a session with itself.
 */

/** Per-worker message cap. Beyond this a worker counts and stops quoting. */
export const WORKER_MAX_MESSAGES = 40;
/** Session-wide cap, so many small workers cannot add up to the same problem. */
export const WORKER_MAX_MESSAGES_TOTAL = 200;
/** Redacted bytes kept per message. */
export const WORKER_MAX_MESSAGE_BYTES = 2_048;

type WorkerCtor = new (
  scriptURL: string | URL,
  options?: WorkerOptions,
) => Worker;

interface WorkerGlobal {
  Worker?: WorkerCtor;
}

export function workerCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const scope = globalThis as WorkerGlobal;
  const OriginalWorker = scope.Worker;
  if (typeof OriginalWorker !== "function") return () => {};

  let totalMessages = 0;
  let nextWorkerId = 0;

  const emit = (d: Record<string, unknown>): void => {
    try {
      bus.emit({ t: now(), k: "worker.msg", d });
    } catch {
      // Capture never breaks the worker.
    }
  };

  const emitMessage = (
    workerId: number,
    script: string,
    op: "post" | "recv",
    payload: unknown,
    seq: number,
  ): void => {
    try {
      const d: Record<string, unknown> = { id: workerId, script, op, seq };
      const text = stringifyPayload(payload);
      if (text === undefined) {
        // A transferable, a stream, an ArrayBuffer: describing it honestly beats guessing at it.
        d.opaque = true;
        emit(d);
        return;
      }
      const result = redactNetworkTextBody(text, {
        // A message has no Content-Type. It is structured data, and the structured policy falls
        // back to whole-value treatment when the text does not parse.
        contentType: "application/json",
        maxLength: WORKER_MAX_MESSAGE_BYTES,
        path: "message",
        ...bodyRedactionOptions(config),
      });
      if (result.body !== undefined) d.body = result.body;
      if (result.bodySummary) d.bodySummary = result.bodySummary;
      d.bytes = text.length;
      attachRedactionMetadata(d, result.metadata);
      emit(d);
    } catch {
      // Capture never breaks the worker.
    }
  };

  class InstrumentedWorker extends (OriginalWorker as WorkerCtor) {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super(scriptURL, options);

      const workerId = (nextWorkerId += 1);
      const script = safeRedactUrl(
        typeof scriptURL === "string" ? scriptURL : String(scriptURL),
      );
      let posted = 0;
      let received = 0;
      let quoted = 0;

      const mayQuote = (): boolean =>
        quoted < WORKER_MAX_MESSAGES && totalMessages < WORKER_MAX_MESSAGES_TOTAL;
      const spend = (): void => {
        quoted += 1;
        totalMessages += 1;
      };

      emit({ id: workerId, script, op: "start" });

      try {
        this.addEventListener("message", (event: MessageEvent) => {
          received += 1;
          if (!mayQuote()) return;
          spend();
          emitMessage(workerId, script, "recv", event.data, received);
        });

        // A worker that throws reports here and nowhere else: the page's own error handlers never
        // see it, so without this the failure leaves no trace at all.
        this.addEventListener("error", (event: ErrorEvent) => {
          emit({
            id: workerId,
            script,
            op: "error",
            posted,
            received,
            ...(typeof event.message === "string"
              ? { msg: event.message.slice(0, 300) }
              : {}),
          });
        });
      } catch {
        // A host Worker without addEventListener still works; it just reports nothing.
      }

      const postMessage = this.postMessage.bind(this);
      this.postMessage = ((...args: unknown[]) => {
        posted += 1;
        if (mayQuote()) {
          spend();
          emitMessage(workerId, script, "post", args[0], posted);
        }
        return (postMessage as (...a: unknown[]) => unknown)(...args);
      }) as Worker["postMessage"];
    }
  }

  scope.Worker = InstrumentedWorker as unknown as WorkerCtor;

  return () => {
    // Only unwind our own patch: a third party may have replaced the constructor after us.
    if (scope.Worker === (InstrumentedWorker as unknown)) {
      scope.Worker = OriginalWorker;
    }
  };
}

/**
 * The message as text, or nothing when it is not text-shaped.
 *
 * Structured-clone payloads are ordinary JSON in practice. What is NOT ordinary - an ArrayBuffer, a
 * MessagePort, a transferred stream - stringifies to `{}` or throws, and reporting either as the
 * message content would be a fabrication. Those are reported as opaque instead.
 */
function stringifyPayload(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload;
  if (payload === null || payload === undefined) return String(payload);
  if (typeof payload === "number" || typeof payload === "boolean") {
    return String(payload);
  }
  if (typeof payload !== "object") return undefined;
  if (payload instanceof ArrayBuffer) return undefined;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(payload)) {
    return undefined;
  }
  try {
    const text = JSON.stringify(payload);
    // `{}` from a non-empty object means nothing was enumerable, which is the signature of a host
    // object rather than data.
    if (text === undefined) return undefined;
    if (text === "{}" && Object.keys(payload).length === 0 && !isPlainObject(payload)) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeRedactUrl(url: string): string {
  try {
    return redactUrl(url, "url").value;
  } catch {
    return "";
  }
}
