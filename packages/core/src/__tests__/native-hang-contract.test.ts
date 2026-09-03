import { describe, expect, it } from "vitest";
import {
  isNativeHangEventData,
  NATIVE_HANG_MAX_DURATION_MS,
  NATIVE_HANG_MAX_STACK_CHARS,
  NATIVE_HANG_MAX_STACK_FRAMES,
  type NativeHangEventData,
} from "../index";

describe("native-hang event contract", () => {
  const valid: NativeHangEventData = {
    source: "main-thread",
    thresholdMs: 5000,
    observedDurationMs: 7420,
    recovered: false,
    previousLaunch: true,
    stk: "Error\n    at Checkout.submit (Checkout.swift:42)",
  };

  it("accepts the required payload and optional existing stack field", () => {
    expect(isNativeHangEventData(valid)).toBe(true);
    expect(
      isNativeHangEventData({
        source: "dart",
        thresholdMs: 5000,
        observedDurationMs: 5000,
        recovered: true,
        previousLaunch: false,
      }),
    ).toBe(true);
  });

  it("accepts forward compatible unknown fields", () => {
    expect(isNativeHangEventData({ ...valid, futureField: "ignored" })).toBe(
      true,
    );
  });

  it.each([
    { source: "android-main-thread" },
    { source: "main-thread", thresholdMs: -1 },
    { source: "main-thread", observedDurationMs: 1.5 },
    { source: "main-thread", recovered: "false" },
    { source: "main-thread", previousLaunch: 0 },
  ])("rejects malformed required fields: %j", (override) => {
    expect(isNativeHangEventData({ ...valid, ...override })).toBe(false);
  });

  it("rejects out of bound durations and stacks", () => {
    expect(
      isNativeHangEventData({
        ...valid,
        thresholdMs: NATIVE_HANG_MAX_DURATION_MS + 1,
      }),
    ).toBe(false);
    expect(
      isNativeHangEventData({
        ...valid,
        stk: "x".repeat(NATIVE_HANG_MAX_STACK_CHARS + 1),
      }),
    ).toBe(false);
    expect(isNativeHangEventData({ ...valid, stk: "" })).toBe(false);
    expect(
      isNativeHangEventData({
        ...valid,
        stk: Array.from(
          { length: NATIVE_HANG_MAX_STACK_FRAMES + 1 },
          () => "x",
        ).join("\n"),
      }),
    ).toBe(false);
  });

  it("rejects null, arrays, and missing payloads", () => {
    expect(isNativeHangEventData(null)).toBe(false);
    expect(isNativeHangEventData([])).toBe(false);
    expect(isNativeHangEventData({})).toBe(false);
  });
});
