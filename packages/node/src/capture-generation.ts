/**
 * Internal ownership marker for work that completes asynchronously.
 *
 * An instrumented client can outlive the autoCapture session that created its
 * wrapper. The marker is captured at operation start and checked at completion
 * so a late callback cannot be filed into a newer session.
 */
export type CaptureGeneration = symbol;
export type CaptureGenerationState = CaptureGeneration | null;

export interface CaptureGenerationOptions {
  /** Generation captured when this operation started. `null` means inactive. */
  captureGeneration?: CaptureGenerationState;
  /** Reads the currently active capture generation for a new operation. */
  getCaptureGeneration?: () => CaptureGeneration | undefined;
}

/** Capture ownership once, at the start of an operation. */
export function captureGenerationFor<T extends CaptureGenerationOptions>(
  options: T,
): T {
  if (typeof options.getCaptureGeneration !== "function") return options;
  let generation: CaptureGenerationState = null;
  try {
    generation = options.getCaptureGeneration() ?? null;
  } catch {
    // A broken lifecycle seam fails closed for this operation.
  }
  return { ...options, captureGeneration: generation };
}

/** Rebind an existing operation to the generation captured at its start. */
export function withCaptureGeneration<T extends CaptureGenerationOptions>(
  options: T,
  generation: CaptureGenerationState | undefined,
): T {
  if (!Object.prototype.hasOwnProperty.call(options, "captureGeneration"))
    return options;
  return { ...options, captureGeneration: generation ?? null };
}

/** Whether an operation is still eligible to emit into its owning session. */
export function ownsCaptureGeneration(
  options: CaptureGenerationOptions,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(options, "captureGeneration"))
    return true;
  return options.captureGeneration !== null;
}
