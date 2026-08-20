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
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
  }
  if (documentEvents) {
    document.addEventListener("securitypolicyviolation", onCspViolation);
  }

  return () => {
    if (windowEvents) {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    }
    if (documentEvents) {
      document.removeEventListener("securitypolicyviolation", onCspViolation);
    }
  };
}
