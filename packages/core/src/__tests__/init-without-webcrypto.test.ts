// A runtime with no WebCrypto — an older Node doing SSR, an embedded WebView, a
// harness without the polyfill — used to take the host application down with it:
// `generateSessionId()` throws, and `Crumbtrail.init()` called it unguarded on
// both the SSR branch and the browser branch, so the exception escaped into the
// customer's entry point and failed the render.
//
// Early capture already treats the same call as fallible, for the same stated
// reason. init() must too: the SDK does not break the app it is watching.

import { afterEach, describe, expect, it } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import { generateSessionId } from "../utils";

function withoutWebCrypto<T>(run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    value: {},
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
}

const transport = () => ({
  sendEvents: async () => {},
  sendBlob: async () => {},
  startSession: async () => {},
  endSession: async () => {},
  sendBugReport: async () => {},
});

describe("init() on a runtime without crypto.getRandomValues", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("still returns an instance with a usable session id", async () => {
    const logger = withoutWebCrypto(() =>
      Crumbtrail.init({
        transportInstance: transport(),
        network: false,
        environment: false,
        domSnapshot: false,
        sessionPersistence: "memory",
        flushIntervalMs: 100_000,
        flushBufferSize: 1_000,
      }),
    );

    expect(logger.getSessionId()).toMatch(/^ses_/);
    await logger.stop();
  });

  it("keeps generateSessionId() itself honest about the weaker source", () => {
    withoutWebCrypto(() => {
      // No throw, and the id is still shaped like a session id.
      expect(generateSessionId()).toMatch(/^ses_/);
    });
  });
});
