import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { safeStringify, now } from "../utils";
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

    console[method] = (...args: unknown[]) => {
      const redactedArgs = config.captureRawConsole
        ? args.map((a) => safeStringify(a))
        : args.map((a, index) => redactConsoleArg(a, `args[${index}]`));
      const stack =
        method === "error"
          ? config.captureRawConsole
            ? { value: new Error().stack }
            : redactConsoleStack(new Error().stack)
          : undefined;
      const d: Record<string, unknown> = {
        lv: LEVEL_MAP[method],
        args: redactedArgs.map((arg) =>
          typeof arg === "string" ? arg : arg.value,
        ),
      };
      if (method === "error") d.stk = stack?.value;
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
  }

  return () => {
    for (const method of METHODS) {
      console[method] = originals.get(method)!;
    }
  };
}
