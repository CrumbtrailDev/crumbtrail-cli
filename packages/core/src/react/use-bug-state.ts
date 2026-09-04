import { useEffect, useRef } from "react";
import { redactReactSnapshot } from "./redact-snapshot";

export interface BugStateLogger {
  registerStateProvider(name: string, provider: () => unknown): () => void;
}

export interface UseBugStateOptions {
  captureRawState?: boolean;
}

export { redactReactSnapshot };

export function useBugState(
  logger: BugStateLogger | null | undefined,
  name: string,
  value: unknown,
  options: UseBugStateOptions = {},
): void {
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!logger || typeof logger.registerStateProvider !== "function") return;
    return logger.registerStateProvider(name, () =>
      options.captureRawState
        ? valueRef.current
        : redactReactSnapshot(valueRef.current, `state.${name}`),
    );
  }, [logger, name, options.captureRawState]);
}
