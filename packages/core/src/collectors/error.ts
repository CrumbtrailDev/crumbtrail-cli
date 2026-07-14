import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { now } from "../utils";
import {
  attachRedactionMetadata,
  redactNetworkTextBody,
  redactUrl,
  type PayloadSummary,
  type RedactionMetadata,
} from "../redaction";

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

export function errorCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const onError = (event: ErrorEvent) => {
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

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
