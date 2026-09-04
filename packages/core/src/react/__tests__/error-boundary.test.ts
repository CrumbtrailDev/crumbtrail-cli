import { describe, it, expect, vi } from "vitest";
import { CrumbtrailErrorBoundary } from "../error-boundary";
import { BROWSER_REDACTION_POLICY } from "../../redaction";

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
        stk: error.stack,
        componentStk: errorInfo.componentStack,
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
    expect(event.data.stk).not.toContain("sk_fake_abcdefghijklmnopqrstuvwxyz");
    expect(event.data.componentStk).toBe("\n  at PasswordForm");
  });

  // The next two cases previously asserted `stk === "[REDACTED]"`. They were
  // written to prove that a malformed, JSON-like error string cannot leak a
  // secret, and the only tool the forked React rules had was to return a bare
  // marker for the whole string, so the assertion pinned that. What it also
  // pinned was the destruction of every stack trace that contains a bracket and
  // any key-like token reading as sensitive — and `d.stk` is the single field
  // the analyzer indexes, and the sole reason a boundary is installed.
  //
  // The new behaviour is the shared engine's free-text route, the same one
  // `collectors/error.ts` gives `msg` and `stk`: the secret is substituted and
  // every frame survives. The privacy claim these tests were written to make is
  // unchanged and still asserted; only the whole-payload deletion is gone.
  it("substitutes secrets in malformed JSON-like boundary strings and keeps the rest", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore - initialize state as React would
    instance.state = { hasError: false };

    const error = new Error('{"password":"hunter2"');
    error.stack =
      'Error: {"apiKey":"sk_fake_abcdefghijklmnopqrstuvwxyz"\n    at Login (src/Login.tsx:4:1)';

    instance.componentDidCatch(error, {
      componentStack: "\n  at PasswordForm",
    });

    const event = logger.addEvent.mock.calls[0]![0];
    expect(JSON.stringify(event.data)).not.toContain("hunter2");
    expect(JSON.stringify(event.data)).not.toContain(
      "sk_fake_abcdefghijklmnopqrstuvwxyz",
    );
    expect(event.data.stk).toContain("at Login (src/Login.tsx:4:1)");
  });

  it("keeps a stack whose frames read as PII field names", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore - initialize state as React would
    instance.state = { hasError: false };

    // A React child-type error quotes the offending keys, so the message
    // carries a brace while the frames carry `address` and `zip`. That exact
    // combination erased the whole trace under the forked rules.
    const error = new Error(
      "Objects are not valid as a React child (found: object with keys {email, zip})",
    );
    error.stack =
      "Error: bad child\n    at ZipInput (src/ZipInput.tsx)\n    at AddressForm (src/AddressForm.tsx)\n    at Checkout (src/Checkout.tsx)";

    instance.componentDidCatch(error, { componentStack: "\n  at AddressForm" });

    const event = logger.addEvent.mock.calls[0]![0];
    expect(event.data.stk).toContain("ZipInput");
    expect(event.data.stk).toContain("AddressForm");
    expect(event.data.stk).toContain("Checkout");
    expect(event.data.componentStk).toBe("\n  at AddressForm");
  });

  it("does not expose raw PII assigned in a boundary message", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore - initialize state as React would
    instance.state = { hasError: false };

    const error = new Error("address=123 Main St");
    error.stack = 'Error: {dob:"2000-01-01"}\n    at Form (src/Form.tsx:2:1)';

    instance.componentDidCatch(error, { componentStack: "\n  at AddressForm" });

    const event = logger.addEvent.mock.calls[0]![0];
    expect(event.data.msg).toBe("address=[REDACTED]");
    expect(JSON.stringify(event.data)).not.toContain("123 Main St");
    expect(event.data.stk).toContain("at Form (src/Form.tsx:2:1)");
  });

  it("attaches the redaction evidence the React plane produced", () => {
    const logger = makeLogger();
    const instance = new CrumbtrailErrorBoundary({ logger, children: null });
    // @ts-ignore - initialize state as React would
    instance.state = { hasError: false };

    const error = new Error("password=hunter2");
    error.stack = "Error: password=hunter2\n    at Login (src/Login.tsx:4:1)";
    instance.componentDidCatch(error, { componentStack: "\n  at Login" });

    const event = logger.addEvent.mock.calls[0]![0];
    const redaction = event.data.redaction as {
      policy: string;
      fields: Array<{ path: string }>;
    };
    expect(redaction.policy).toBe(BROWSER_REDACTION_POLICY);
    expect(redaction.fields.map((field) => field.path)).toContain(
      "msg.password",
    );
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
