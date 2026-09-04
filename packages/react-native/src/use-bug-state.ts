import { useEffect, useRef } from "react";

export interface BugStateLogger {
  registerStateProvider(name: string, provider: () => unknown): () => void;
}

export interface UseBugStateOptions {
  /**
   * @deprecated Set `captureRawState` on the `Crumbtrail` config instead.
   *
   * This flag used to skip a redaction pass this package ran on the value
   * before handing it over. That pass is gone, so the flag no longer does
   * anything here. Redaction happens where the snapshot is emitted, in
   * `crumbtrail-core`, and `CrumbtrailConfig.captureRawState` is the switch
   * that turns it off.
   */
  captureRawState?: boolean;
}

/**
 * Register a value so it is attached to any bug flagged while the component is
 * mounted.
 *
 * The value is handed over unmodified. `crumbtrail-core` redacts it when it
 * emits the `state.snap` event, using the same engine as every other capture.
 *
 * This package used to redact it here first, with a name list and a token
 * regex of its own. That pass ran ahead of core's and destroyed the evidence
 * core produces: it flattened values to a bare `[REDACTED]` before the engine
 * ever saw them, so the engine could no longer say WHY a value went — a cart
 * id core reports as `long_hex_token` and an order note it reports as
 * `long_token_like_string` both arrived already blank and were recorded with no
 * reason at all. It was weaker as well as destructive, missing an `email` field
 * the engine catches. One engine, one pass, at the point of emit.
 */
export function useBugState(
  logger: BugStateLogger | null | undefined,
  name: string,
  value: unknown,
  _options: UseBugStateOptions = {},
): void {
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!logger || typeof logger.registerStateProvider !== "function") return;
    return logger.registerStateProvider(name, () => valueRef.current);
  }, [logger, name]);
}
