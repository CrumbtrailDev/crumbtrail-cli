import { describe, expect, it, vi } from "vitest";
import { CrumbtrailReactNativeErrorBoundary } from "../error-boundary";

function makeLogger() {
  return {
    registerStateProvider: vi.fn(),
    addEvent: vi.fn(),
  };
}

describe("CrumbtrailReactNativeErrorBoundary", () => {
  it("emits compatible err events through logger.addEvent", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailReactNativeErrorBoundary({
      logger,
      children: null,
    });
    instance.state = { hasError: false };

    const error = new Error("boom");
    error.stack = "Error: boom\n  at App";
    const errorInfo = { componentStack: "\n  at Screen\n  at App" };

    instance.componentDidCatch(error, errorInfo);

    expect(logger.addEvent).toHaveBeenCalledWith({
      type: "err",
      data: {
        msg: "boom",
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        source: "react-native-error-boundary",
      },
    });
  });

  it("redacts sensitive boundary strings before logging", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailReactNativeErrorBoundary({
      logger,
      children: null,
    });
    instance.state = { hasError: false };

    const error = new Error("password=hunter2");
    error.stack = "Error: token=sk_fake_abcdefghijklmnopqrstuvwxyz\n  at Login";
    instance.componentDidCatch(error, {
      componentStack: "\n  at PasswordScreen",
    });

    const event = logger.addEvent.mock.calls[0]![0];
    expect(event.data.msg).toBe("password=[REDACTED]");
    expect(event.data.stack).not.toContain(
      "sk_fake_abcdefghijklmnopqrstuvwxyz",
    );
  });
});
