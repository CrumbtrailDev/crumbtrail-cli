import type { EventBus } from "../event-bus";
import type {
  CrumbtrailConfig,
  CollectorCleanup,
  RecordErrorOptions,
} from "../types";
import { now, safeStringify } from "../utils";
import {
  attachRedactionMetadata,
  redactNetworkTextBody,
  redactUrl,
  type PayloadSummary,
  type RedactionMetadata,
} from "../redaction";
import { drainEarlyCapture } from "../early-capture";
import { resourceFailureForTarget } from "../resource-failure";
import { emitResourceFailure } from "../resource-failure-event";

function bodyPlaceholder(summary: PayloadSummary | undefined): string {
  return summary ? `[${summary.action}:${summary.reason}]` : "[REDACTED]";
}

function redactText(
  value: string | undefined,
  path: string,
): { value?: string; metadata?: RedactionMetadata } {
  if (value == null) return {};
  const result = redactNetworkTextBody(value, {
    contentType: "text/plain",
    path,
  });
  return {
    value: result.body ?? bodyPlaceholder(result.bodySummary),
    metadata: result.metadata,
  };
}

function redactErrorPayload(
  payload: Record<string, unknown>,
  config: CrumbtrailConfig,
): Record<string, unknown> {
  if (config.captureRawErrors) return payload;

  const msg = redactText(
    typeof payload.msg === "string" ? payload.msg : undefined,
    "msg",
  );
  const stk = redactText(
    typeof payload.stk === "string" ? payload.stk : undefined,
    "stk",
  );
  const file =
    typeof payload.file === "string"
      ? redactUrl(payload.file, "file")
      : undefined;
  const d: Record<string, unknown> = {
    ...payload,
    ...(msg.value !== undefined ? { msg: msg.value } : {}),
    ...(stk.value !== undefined ? { stk: stk.value } : {}),
    ...(file ? { file: file.value } : {}),
  };
  attachRedactionMetadata(d, msg.metadata, stk.metadata, file?.metadata);
  return d;
}

const RECORDED_ERROR_MESSAGE_MAX_LENGTH = 2_000;
const RECORDED_ERROR_STACK_MAX_LENGTH = 8_000;
const RECORDED_ERROR_SOURCE_MAX_LENGTH = 200;

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return value.slice(0, maxLength);
  } catch {
    return undefined;
  }
}

function readErrorString(error: unknown, field: "message" | "stack"): string | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function"))
    return undefined;
  try {
    return boundedString((error as Record<string, unknown>)[field], field === "stack"
      ? RECORDED_ERROR_STACK_MAX_LENGTH
      : RECORDED_ERROR_MESSAGE_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

function describeRecordedError(error: unknown): string {
  const message = readErrorString(error, "message");
  if (message !== undefined && message !== "") return message;
  try {
    const serialized = safeStringify(error);
    if (serialized !== undefined) return serialized.slice(0, RECORDED_ERROR_MESSAGE_MAX_LENGTH);
  } catch {
    // Host supplied toString/valueOf can throw. The event still carries its handled state.
  }
  try {
    return String(error).slice(0, RECORDED_ERROR_MESSAGE_MAX_LENGTH);
  } catch {
    return "Unknown error";
  }
}

/** Build the browser wire event for an application error that host code handled. */
export function buildRecordedErrorData(
  error: unknown,
  options: RecordErrorOptions | undefined,
  config: CrumbtrailConfig,
): Record<string, unknown> {
  const source = boundedString(options?.source, RECORDED_ERROR_SOURCE_MAX_LENGTH) ?? "manual";
  const payload: Record<string, unknown> = {
    msg: describeRecordedError(error),
    stk: readErrorString(error, "stack"),
    fatal: options?.fatal === true,
    source,
    handled: true,
  };
  return redactErrorPayload(payload, config);
}

export function errorCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const onError = (event: ErrorEvent) => {
    const resource = resourceFailureForTarget(event.target);
    if (resource) {
      emitResourceFailure(bus, {
        ...resource,
        loading: document.readyState === "loading",
      });
      return;
    }

    bus.emit({
      t: now(),
      k: "err",
      d: redactErrorPayload(
        {
          msg: event.message,
          file: event.filename,
          line: event.lineno,
          col: event.colno,
          stk: event.error?.stack,
        },
        config,
      ),
    });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    bus.emit({
      t: now(),
      k: "rej",
      d: redactErrorPayload(
        {
          msg: reason instanceof Error ? reason.message : String(reason),
          stk: reason instanceof Error ? reason.stack : undefined,
        },
        config,
      ),
    });
  };

  /**
   * A Content Security Policy refusal.
   *
   * This is the quietest way for a feature to stop existing. The browser refuses to load a script,
   * a stylesheet, an image or a connection, and the page reports nothing: no JavaScript error,
   * because the code never ran; no failed request, because the request was never made. A capture
   * built on errors and network traffic is blind to it by construction, while the user watches a
   * button do nothing.
   *
   * It is also the only thing that distinguishes a policy refusal from the "Failed to fetch" a
   * blocked connection otherwise produces, which reads identically to being offline.
   *
   * Metadata only: which directive refused, what it refused, and where. The `sample` field a browser
   * may attach is a fragment of the page's own script or style text, so it is not read.
   */
  const onCspViolation = (event: SecurityPolicyViolationEvent) => {
    const blocked = redactUrl(
      typeof event.blockedURI === "string" ? event.blockedURI : "",
      "blockedUri",
    );
    const source = redactUrl(
      typeof event.sourceFile === "string" ? event.sourceFile : "",
      "sourceFile",
    );
    const d: Record<string, unknown> = {
      directive: event.effectiveDirective || event.violatedDirective,
      disposition: event.disposition,
      blockedUri: blocked.value,
      ...(source.value ? { file: source.value } : {}),
      ...(Number.isFinite(event.lineNumber) ? { line: event.lineNumber } : {}),
      ...(Number.isFinite(event.statusCode) ? { st: event.statusCode } : {}),
    };
    attachRedactionMetadata(d, blocked.metadata, source.metadata);
    bus.emit({ t: now(), k: "csp", d });
  };

  // Both targets are checked, and checked separately.
  //
  // React Native reaches here: `global.window = global` makes `typeof window`
  // an object, so init()'s non-browser escape hatch does not fire, but that
  // global has no `addEventListener` and RN never defines a `document`
  // instance. An unguarded bind is then a TypeError (window) or a
  // ReferenceError (document) thrown straight out of `Crumbtrail.init`, which
  // on RN means the host app dies at launch. RN reports its own errors through
  // `ErrorUtils` in `crumbtrail-react-native`; this collector simply has
  // nothing to bind to there, so it installs what exists and no more.
  const windowEvents =
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function";
  const documentEvents =
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function";

  if (windowEvents) {
    // Resource errors do not bubble. Capture phase is required to observe the
    // element target while keeping ordinary window runtime errors on `err`.
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
  }
  if (documentEvents) {
    document.addEventListener("securitypolicyviolation", onCspViolation);
  }

  // The network collector owns the shared queue when it is enabled. When it is
  // disabled, this collector is the sole owner of queued resource failures.
  // The collector map invokes errors before network, but only one branch can
  // drain because both collectors use the same config toggle.
  if (config.network !== true) {
    for (const record of drainEarlyCapture()) {
      if (record.kind !== "resource-error") continue;
      try {
        emitResourceFailure(bus, record);
      } catch {
        // A malformed early record never costs the rest of the queue.
      }
    }
  }

  return () => {
    if (windowEvents) {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
    }
    if (documentEvents) {
      document.removeEventListener("securitypolicyviolation", onCspViolation);
    }
  };
}
