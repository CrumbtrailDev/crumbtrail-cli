import { describe, it, expect, vi } from "vitest";
import { CrumbtrailErrorBoundary } from "../error-boundary";

function makeLogger() {
  return {
    registerStateProvider: vi.fn(),
    addEvent: vi.fn(),
  };
}

describe("CrumbtrailErrorBoundary", () => {
  it("calls logger.addEvent with error details on componentDidCatch", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore — initialize state as React would
    instance.state = { hasError: false };

    const error = new Error("boom");
    error.stack = "Error: boom\n  at Foo (Foo.tsx:10)";
    const errorInfo = { componentStack: "\n  at Foo\n  at App" };

    instance.componentDidCatch(error, errorInfo);

    expect(logger.addEvent).toHaveBeenCalledOnce();
    expect(logger.addEvent).toHaveBeenCalledWith({
      type: "err",
      data: {
        msg: "boom",
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        source: "react-error-boundary",
      },
    });
  });

  it("redacts sensitive error strings before logging boundary events", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore - initialize state as React would
    instance.state = { hasError: false };

    const error = new Error("password=hunter2");
    error.stack = "Error: token=sk_fake_abcdefghijklmnopqrstuvwxyz\n  at Login";

    instance.componentDidCatch(error, {
      componentStack: "\n  at PasswordForm",
    });

    const event = logger.addEvent.mock.calls[0]![0];
    expect(event.data.msg).toBe("password=[REDACTED]");
    expect(event.data.stack).not.toContain(
      "sk_fake_abcdefghijklmnopqrstuvwxyz",
    );
    expect(event.data.componentStack).toBe("\n  at PasswordForm");
  });

  it("does not expose raw malformed JSON-like sensitive boundary strings", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore - initialize state as React would
    instance.state = { hasError: false };

    const error = new Error('{"password":"hunter2"');
    error.stack = 'Error: {"apiKey":"sk_fake_abcdefghijklmnopqrstuvwxyz"';

    instance.componentDidCatch(error, {
      componentStack: "\n  at PasswordForm",
    });

    const event = logger.addEvent.mock.calls[0]![0];
    expect(event.data.msg).toBe("[REDACTED]");
    expect(event.data.stack).toBe("[REDACTED]");
    expect(JSON.stringify(event.data)).not.toContain("hunter2");
    expect(JSON.stringify(event.data)).not.toContain(
      "sk_fake_abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("does not expose raw PII or compact sensitive boundary strings", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore - initialize state as React would
    instance.state = { hasError: false };

    const error = new Error("address=123 Main St");
    error.stack = 'Error: {dob:"2000-01-01", zip:"12345", jsessionid:"abc"}';

    instance.componentDidCatch(error, { componentStack: "\n  at AddressForm" });

    const event = logger.addEvent.mock.calls[0]![0];
    expect(event.data.msg).toBe("address=[REDACTED]");
    expect(event.data.stack).toBe("[REDACTED]");
    expect(JSON.stringify(event.data)).not.toContain("123 Main St");
    expect(JSON.stringify(event.data)).not.toContain("2000-01-01");
    expect(JSON.stringify(event.data)).not.toContain("12345");
    expect(JSON.stringify(event.data)).not.toContain("jsessionid");
  });

  it("getDerivedStateFromError returns hasError: true", () => {
    const result = CrumbtrailErrorBoundary.getDerivedStateFromError(
      new Error("test"),
    );
    expect(result).toEqual({ hasError: true });
  });

  it("render returns children when no error", () => {
    const logger = makeLogger();
    const children = "child-content";
    const instance = new CrumbtrailErrorBoundary({
      logger,
      children,
      fallback: "fallback-content",
    });
    // @ts-ignore
    instance.state = { hasError: false };

    const rendered = instance.render();
    expect(rendered).toBe(children);
  });

  it("render returns fallback when error has occurred", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({
      logger,
      children: "child-content",
      fallback: "fallback-content",
    });
    // @ts-ignore
    instance.state = { hasError: true };

    const rendered = instance.render();
    expect(rendered).toBe("fallback-content");
  });

  it("render returns null as default fallback when no fallback prop", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({
      logger,
      children: "child-content",
    });
    // @ts-ignore
    instance.state = { hasError: true };

    const rendered = instance.render();
    expect(rendered).toBeNull();
  });

  it("resetError clears the error state", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore
    instance.state = { hasError: true };
    instance.setState = vi.fn((updater) => {
      if (typeof updater === "function") {
        // @ts-ignore
        instance.state = { ...instance.state, ...updater(instance.state) };
      } else {
        // @ts-ignore
        instance.state = { ...instance.state, ...updater };
      }
    });

    instance.resetError();

    expect(instance.setState).toHaveBeenCalledWith({ hasError: false });
  });
});
