import { describe, expect, it } from "vitest";
import {
  caughtErrorDetector,
  errorDetector,
  resourceLoadFailureDetector,
  responseBodyErrorDetector,
  storageFailureDetector,
  streamFailureDetector,
  workerErrorDetector,
  wrongNumberDetector,
} from "../signals";
import type { BugEvent } from "../types";

function event(k: string, d: Record<string, unknown>): BugEvent {
  return { t: 1_000, k, d };
}

describe("browser failure detectors", () => {
  it("does not classify a handled recordError event as uncaught", () => {
    expect(
      errorDetector().inspect(
        event("err", { handled: true, msg: "caught", stk: "Error" }),
      ),
    ).toBeNull();
  });

  it("flags an application console error and ignores dependency output", () => {
    const detector = caughtErrorDetector();
    expect(
      detector.inspect(
        event("con", {
          lv: "err",
          args: ["Checkout failed"],
          stk: "Error\n    at submit (https://shop.test/assets/app.js:4:2)",
        }),
      ),
    ).toMatchObject({ tag: "auto:caught-error" });
    expect(
      detector.inspect(
        event("con", {
          lv: "err",
          args: ["dependency warning"],
          stk: "Error\n    at warn (https://shop.test/node_modules/lib.js:4:2)",
        }),
      ),
    ).toBeNull();
  });

  it("flags a success response carrying an explicit application failure", () => {
    const detector = responseBodyErrorDetector();
    expect(
      detector.inspect(
        event("net.res", {
          id: 7,
          st: 200,
          body: JSON.stringify({ data: null, errors: [{ message: "failed" }] }),
        }),
      ),
    ).toMatchObject({ tag: "auto:response-body-error" });
    expect(
      detector.inspect(event("net.res", { id: 8, st: 200, body: '{"ok":false}' }))?.reason,
    ).toContain("ok: false");
    expect(
      detector.inspect(event("net.res", { id: 9, st: 200, body: '{"success":true}' })),
    ).toBeNull();
    expect(
      detector.inspect(event("net.res", { id: 10, st: 500, body: '{"ok":false}' })),
    ).toBeNull();
  });

  it("flags stream and worker failures but not normal lifecycle events", () => {
    const stream = streamFailureDetector();
    expect(
      stream.inspect(event("net.ws", { url: "wss://shop.test/live", op: "error" })),
    ).toMatchObject({ tag: "auto:stream-failure" });
    expect(
      stream.inspect(
        event("net.ws", { url: "wss://shop.test/live", op: "close", code: 1000, clean: true }),
      ),
    ).toBeNull();
    expect(
      stream.inspect(
        event("net.ws", { url: "wss://shop.test/live", op: "close", code: 1006, clean: false }),
      ),
    ).toMatchObject({ tag: "auto:stream-failure" });

    const worker = workerErrorDetector();
    expect(
      worker.inspect(event("worker.msg", { id: 2, script: "checkout.worker.js", op: "error" })),
    ).toMatchObject({ tag: "auto:worker-error" });
    expect(
      worker.inspect(event("worker.msg", { id: 2, script: "checkout.worker.js", op: "recv" })),
    ).toBeNull();
  });

  it("flags invalid rendered numbers and failed resource loads", () => {
    expect(
      wrongNumberDetector().inspect(
        event("ui.num", {
          region: "Order summary",
          items: [{ label: "Total", value: Number.NaN }],
        }),
      ),
    ).toMatchObject({ tag: "auto:wrong-number" });
    expect(
      wrongNumberDetector().inspect(
        event("ui.num", { region: "Order summary", items: [{ label: "Total", value: 12 }] }),
      ),
    ).toBeNull();

    expect(
      resourceLoadFailureDetector().inspect(
        event("perf", {
          metric: "res",
          name: "https://shop.test/assets/checkout.js",
          initiatorType: "script",
          transferSize: 0,
          duration: 0,
        }),
      ),
    ).toMatchObject({ tag: "auto:resource-load-failure" });
    expect(
      resourceLoadFailureDetector().inspect(
        event("perf", {
          metric: "res",
          name: "https://shop.test/assets/checkout.js",
          initiatorType: "script",
          transferSize: 0,
          duration: 2,
        }),
      ),
    ).toBeNull();
  });

  it("flags rejected storage mutations and ignores successful ones", () => {
    const detector = storageFailureDetector();
    expect(
      detector.inspect(
        event("stor", {
          type: "local",
          op: "set",
          key: "[REDACTED_KEY]",
          outcome: "failure",
          errorName: "QuotaExceededError",
        }),
      ),
    ).toMatchObject({ tag: "auto:storage-failure" });
    expect(
      detector.inspect(event("stor", { type: "local", op: "set", outcome: "success" })),
    ).toBeNull();
  });
});
