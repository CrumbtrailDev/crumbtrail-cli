import { describe, it, expect } from "vitest";
import {
  caughtErrorDetector,
  responseBodyErrorDetector,
  streamFailureDetector,
  workerErrorDetector,
} from "../signals";
import type { BugEvent } from "../types";

const APP_STACK = [
  "Error",
  "    at submitOrder (https://shop.example.com/assets/checkout-9f2a.js:412:19)",
  "    at onClick (https://shop.example.com/assets/checkout-9f2a.js:88:5)",
].join("\n");

function con(d: Record<string, unknown>): BugEvent {
  return { t: 1_000, k: "con", d };
}

describe("caughtErrorDetector", () => {
  it("flags an error-level console event with an application stack", () => {
    const signal = caughtErrorDetector().inspect(
      con({ lv: "err", args: ["Checkout failed"], stk: APP_STACK }),
    );
    expect(signal?.tag).toBe("auto:caught-error");
    expect(signal?.reason).toContain("Checkout failed");
  });

  it("ignores levels below error", () => {
    for (const lv of ["log", "warn", "info", "dbg"]) {
      expect(
        caughtErrorDetector().inspect(con({ lv, args: ["x"], stk: APP_STACK })),
      ).toBeNull();
    }
  });

  it("ignores a console error with no stack", () => {
    // An engine that strips frames gives a bare message with no throw site, which is not a report.
    expect(
      caughtErrorDetector().inspect(con({ lv: "err", args: ["boom"] })),
    ).toBeNull();
  });

  it("ignores a dependency logging at error level", () => {
    const stack =
      "Error\n    at warn (https://shop.example.com/node_modules/.vite/react-dom.js:112:9)";
    expect(
      caughtErrorDetector().inspect(
        con({ lv: "err", args: ["Warning: each child needs a key"], stk: stack }),
      ),
    ).toBeNull();
  });

  it("ignores the SDK's own console output", () => {
    const stack =
      "Error\n    at emit (https://shop.example.com/assets/crumbtrail-core.js:900:3)";
    expect(
      caughtErrorDetector().inspect(
        con({ lv: "err", args: ["capture failed"], stk: stack }),
      ),
    ).toBeNull();
  });

  it("skips anonymous frames to reach the first located one", () => {
    const stack = [
      "Error",
      "    at <anonymous>",
      "    at retry (https://shop.example.com/assets/app.js:9:1)",
    ].join("\n");
    expect(
      caughtErrorDetector().inspect(con({ lv: "err", args: ["x"], stk: stack })),
    ).not.toBeNull();
  });

  it("gives the same key to the same throw site and message", () => {
    const d = caughtErrorDetector();
    const a = d.inspect(con({ lv: "err", args: ["Checkout failed"], stk: APP_STACK }));
    const b = d.inspect(con({ lv: "err", args: ["Checkout failed"], stk: APP_STACK }));
    expect(a?.key).toBe(b?.key);
  });
});

function res(d: Record<string, unknown>): BugEvent {
  return { t: 1_000, k: "net.res", d };
}

describe("responseBodyErrorDetector", () => {
  it("flags a 200 carrying a GraphQL errors array", () => {
    const signal = responseBodyErrorDetector().inspect(
      res({
        id: 7,
        st: 200,
        body: JSON.stringify({ data: null, errors: [{ message: "Cart not found" }] }),
      }),
    );
    expect(signal?.tag).toBe("auto:response-body-error");
    expect(signal?.reason).toContain("1 error");
  });

  it("counts a batched GraphQL response", () => {
    const signal = responseBodyErrorDetector().inspect(
      res({
        id: 8,
        st: 200,
        body: JSON.stringify([{ data: {} }, { errors: [{ m: 1 }, { m: 2 }] }]),
      }),
    );
    expect(signal?.reason).toContain("2 errors");
  });

  it("flags an explicit ok: false and success: false", () => {
    const d = responseBodyErrorDetector();
    expect(d.inspect(res({ id: 1, st: 200, body: '{"ok":false}' }))?.reason).toContain(
      "ok: false",
    );
    expect(
      d.inspect(res({ id: 2, st: 200, body: '{"success":false}' }))?.reason,
    ).toContain("success: false");
  });

  it("stays silent on a body that merely has an empty error slot", () => {
    const d = responseBodyErrorDetector();
    for (const body of [
      '{"data":{"cart":{}},"errors":[]}',
      '{"data":{},"errors":null}',
      '{"ok":true}',
      '{"success":true}',
    ]) {
      expect(d.inspect(res({ id: 3, st: 200, body }))).toBeNull();
    }
  });

  it("leaves a 4xx or 5xx to the request failure detector", () => {
    // Otherwise one response raises two signals and spends two entries in the dedup set.
    const body = JSON.stringify({ errors: [{ message: "nope" }] });
    const d = responseBodyErrorDetector();
    expect(d.inspect(res({ id: 4, st: 400, body }))).toBeNull();
    expect(d.inspect(res({ id: 5, st: 500, body }))).toBeNull();
  });

  it("stays silent on a body that is not JSON", () => {
    expect(
      responseBodyErrorDetector().inspect(
        res({ id: 6, st: 200, body: "errors: something went wrong" }),
      ),
    ).toBeNull();
  });
});

describe("streamFailureDetector", () => {
  it("flags a socket error and a server-sent stream error", () => {
    const d = streamFailureDetector();
    expect(
      d.inspect({ t: 1, k: "net.ws", d: { id: 1, url: "wss://x/live", op: "error" } })
        ?.tag,
    ).toBe("auto:stream-failure");
    expect(
      d.inspect({ t: 2, k: "net.sse", d: { url: "https://x/events", op: "error" } })
        ?.reason,
    ).toContain("stream");
  });

  it("flags a socket that closed early", () => {
    const d = streamFailureDetector();
    expect(
      d.inspect({
        t: 3,
        k: "net.ws",
        d: { url: "wss://x/live", op: "close", code: 1006, clean: false },
      })?.reason,
    ).toContain("1006");
  });

  it("stays silent on a clean close", () => {
    const d = streamFailureDetector();
    for (const code of [1000, 1001, 1005]) {
      expect(
        d.inspect({
          t: 4,
          k: "net.ws",
          d: { url: "wss://x/live", op: "close", code, clean: true },
        }),
      ).toBeNull();
    }
  });

  it("stays silent on an SSE close, which carries no code to judge it by", () => {
    expect(
      streamFailureDetector().inspect({
        t: 5,
        k: "net.sse",
        d: { url: "https://x/events", op: "close", count: 40 },
      }),
    ).toBeNull();
  });

  it("stays silent on open and frame events", () => {
    const d = streamFailureDetector();
    expect(
      d.inspect({ t: 6, k: "net.ws", d: { url: "wss://x", op: "open" } }),
    ).toBeNull();
    expect(
      d.inspect({ t: 7, k: "net.ws", d: { url: "wss://x", op: "msg", seq: 1 } }),
    ).toBeNull();
  });
});

describe("workerErrorDetector", () => {
  it("flags a worker that threw", () => {
    const signal = workerErrorDetector().inspect({
      t: 1,
      k: "worker.msg",
      d: { id: 2, script: "sync.worker.js", op: "error", msg: "quota exceeded" },
    });
    expect(signal?.tag).toBe("auto:worker-error");
    expect(signal?.reason).toContain("quota exceeded");
  });

  it("stays silent on the worker's ordinary traffic", () => {
    const d = workerErrorDetector();
    for (const op of ["start", "post", "recv"]) {
      expect(
        d.inspect({ t: 2, k: "worker.msg", d: { id: 2, script: "s.js", op } }),
      ).toBeNull();
    }
  });
});
