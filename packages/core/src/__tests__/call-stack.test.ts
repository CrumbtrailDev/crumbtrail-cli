import { describe, it, expect } from "vitest";
import { captureCallStack, canCaptureCallStack } from "../call-stack";

/**
 * The property under test is NOT "a stack was captured" — an unstripped
 * `new Error().stack` satisfies that and is the defect. It is "the first frame
 * belongs to the caller", which is the only thing `evidence-index` reads.
 */
describe("captureCallStack", () => {
  function sdkBoundary(): string | undefined {
    return captureCallStack(sdkBoundary);
  }

  function applicationCode(): string | undefined {
    return sdkBoundary();
  }

  it("drops the boundary and everything above it", () => {
    const stack = applicationCode();
    expect(stack).toBeDefined();
    const frames = stack!.split("\n").slice(1);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toContain("applicationCode");
    // The negative half. Without it this test passes on a stack that merely
    // MENTIONS the caller somewhere below the SDK's own frames — which is what
    // the unstripped stack did, and why the old console test could not see the
    // bug it was closest to.
    expect(stack).not.toContain("sdkBoundary");
  });

  it("reports whether the runtime can strip at all", () => {
    // V8 under vitest. Stated as an assertion rather than assumed, so this file
    // fails loudly rather than silently skipping if it ever runs elsewhere.
    expect(canCaptureCallStack()).toBe(true);
  });
});
