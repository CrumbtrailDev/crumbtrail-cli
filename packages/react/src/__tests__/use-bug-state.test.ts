import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBugState } from "../use-bug-state";

function makeLogger() {
  const unregister = vi.fn();
  return {
    registerStateProvider: vi.fn(
      (_name: string, _provider: () => unknown) => unregister,
    ),
    unregister,
  };
}

describe("useBugState", () => {
  it("registers a state provider with the given name on mount", () => {
    const logger = makeLogger();
    renderHook(() => useBugState(logger, "cart", { items: 3 }));

    expect(logger.registerStateProvider).toHaveBeenCalledOnce();
    expect(logger.registerStateProvider).toHaveBeenCalledWith(
      "cart",
      expect.any(Function),
    );
  });

  it("the registered provider returns the latest value without re-registering", () => {
    const logger = makeLogger();
    const { rerender } = renderHook(
      ({ value }) => useBugState(logger, "cart", value),
      {
        initialProps: { value: { items: 1 } },
      },
    );

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    expect(provider()).toEqual({ items: 1 });

    rerender({ value: { items: 5 } });

    expect(logger.registerStateProvider).toHaveBeenCalledOnce();
    expect(provider()).toEqual({ items: 5 });
  });

  it("redacts sensitive snapshot values by default", () => {
    const logger = makeLogger();
    renderHook(() =>
      useBugState(logger, "session", {
        email: "ada@example.test",
        address: "123 Main St",
        jsessionid: "abc123",
        nested: { token: "sk_fake_abcdefghijklmnopqrstuvwxyz" },
        ok: "visible",
      }),
    );

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    expect(provider()).toEqual({
      email: "[REDACTED]",
      address: "[REDACTED]",
      jsessionid: "[REDACTED]",
      nested: { token: "[REDACTED]" },
      ok: "visible",
    });
  });

  it("redacts malformed JSON-like sensitive strings by default", () => {
    const logger = makeLogger();
    renderHook(() => useBugState(logger, "session", '{"password":"hunter2"'));

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    expect(provider()).toBe("[REDACTED]");
    expect(JSON.stringify(provider())).not.toContain("hunter2");
  });

  it("redacts malformed JSON-like PII and compact sensitive strings by default", () => {
    const logger = makeLogger();
    renderHook(() =>
      useBugState(
        logger,
        "session",
        '{address:"123 Main St", dob:"2000-01-01", zip:"12345", jsessionid:"abc"}',
      ),
    );

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    expect(provider()).toBe("[REDACTED]");
  });

  it("returns raw snapshot values only when explicitly opted in", () => {
    const logger = makeLogger();
    renderHook(() =>
      useBugState(
        logger,
        "session",
        { password: "hunter2" },
        { captureRawState: true },
      ),
    );

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    expect(provider()).toEqual({ password: "hunter2" });
  });

  it("unregisters the previous provider and registers a new one when name changes", () => {
    const logger = makeLogger();
    const { rerender } = renderHook(
      ({ name }) => useBugState(logger, name, "v"),
      {
        initialProps: { name: "a" },
      },
    );

    rerender({ name: "b" });

    expect(logger.unregister).toHaveBeenCalledOnce();
    expect(logger.registerStateProvider).toHaveBeenCalledTimes(2);
    expect(logger.registerStateProvider).toHaveBeenNthCalledWith(
      2,
      "b",
      expect.any(Function),
    );
  });

  it("calls the unregister callback on unmount", () => {
    const logger = makeLogger();
    const { unmount } = renderHook(() => useBugState(logger, "cart", 1));

    unmount();

    expect(logger.unregister).toHaveBeenCalledOnce();
  });

  it("does nothing when logger is null", () => {
    const { result } = renderHook(() => useBugState(null, "cart", 1));
    expect(result.current).toBeUndefined();
  });

  it("does nothing when logger is undefined", () => {
    expect(() =>
      renderHook(() => useBugState(undefined, "cart", 1)),
    ).not.toThrow();
  });

  it("does not throw when logger lacks a registerStateProvider function", () => {
    const brokenLogger = {} as never;
    expect(() =>
      renderHook(() => useBugState(brokenLogger, "cart", 1)),
    ).not.toThrow();
  });
});
