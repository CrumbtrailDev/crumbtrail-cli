import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { safeStringify, now } from "../utils";
import { captureCallStack } from "../call-stack";
import {
  attachRedactionMetadata,
  redactNetworkTextBody,
  type RedactionMetadata,
} from "../redaction";

const LEVEL_MAP: Record<string, string> = {
  log: "log",
  warn: "warn",
  error: "err",
  debug: "dbg",
  info: "info",
};

const METHODS = ["log", "warn", "error", "debug", "info"] as const;

function redactConsoleArg(
  value: unknown,
  path: string,
): { value: string; metadata?: RedactionMetadata } {
  if (typeof value === "string") {
    const result = redactNetworkTextBody(value, {
      contentType: "text/plain",
      path,
    });
    return {
      value: safeStringify(result.body ?? ""),
      metadata: result.metadata,
    };
  }

  const serialized = safeStringify(value);
  const result = redactNetworkTextBody(serialized, {
    contentType: "application/json",
    path,
  });
  return {
    value: result.body ?? serialized,
    metadata: result.metadata,
  };
}

function redactConsoleStack(stack: string | undefined): {
  value?: string;
  metadata?: RedactionMetadata;
} {
  if (!stack) return {};
  const result = redactNetworkTextBody(stack, {
    contentType: "text/plain",
    path: "stk",
  });
  return { value: result.body ?? stack, metadata: result.metadata };
}

export function consoleCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const originals = new Map<string, (...args: unknown[]) => void>();

  for (const method of METHODS) {
    originals.set(method, console[method]);

    // Named and held in a binding because it is the stack BOUNDARY: every frame
    // at and above it is the SDK, and `captureCallStack` needs the function
    // itself to say so. An anonymous arrow assigned straight onto `console`
    // could not be pointed at.
    const instrumentedConsole = (...args: unknown[]) => {
      const redactedArgs = config.captureRawConsole
        ? args.map((a) => safeStringify(a))
        : args.map((a, index) => redactConsoleArg(a, `args[${index}]`));
      // Captured relative to THIS wrapper, so the first frame is the
      // application's `console.error(...)` call and not the collector standing
      // in front of it. `new Error().stack` here named this file, and
      // `evidence-index` takes the first frame as the code location — so the
      // only client-side code location the SDK produced today pointed at the
      // SDK's own bundle.
      const raw =
        method === "error" ? captureCallStack(instrumentedConsole) : undefined;
      const stack =
        raw === undefined
          ? undefined
          : config.captureRawConsole
            ? { value: raw }
            : redactConsoleStack(raw);
      const d: Record<string, unknown> = {
        lv: LEVEL_MAP[method],
        args: redactedArgs.map((arg) =>
          typeof arg === "string" ? arg : arg.value,
        ),
      };
      // Only when there IS one. Assigning undefined would put an empty `stk`
      // slot on every console.error from an engine that cannot strip frames,
      // which reads downstream as "captured, and it was blank".
      if (stack?.value !== undefined) d.stk = stack.value;
      if (!config.captureRawConsole) {
        attachRedactionMetadata(
          d,
          ...redactedArgs.map((arg) =>
            typeof arg === "string" ? undefined : arg.metadata,
          ),
          stack?.metadata,
        );
      }
      bus.emit({ t: now(), k: "con", d });
      originals.get(method)!.apply(console, args);
    };
    console[method] = instrumentedConsole;
  }

  return () => {
    for (const method of METHODS) {
      console[method] = originals.get(method)!;
    }
  };
}
