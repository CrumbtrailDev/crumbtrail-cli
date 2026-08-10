// Reading a browser stack into a callsite.
//
// Every test is either "the fact survives" or "the guess is refused", for the
// same reason `code-locations` states: a wrong path sends a reader somewhere
// confidently irrelevant and does not announce itself.

import { describe, expect, it } from "vitest";

import { clientCallsiteFromStack, parseClientFrame } from "../client-callsite";

describe("parseClientFrame", () => {
  it("reads a named V8 frame", () => {
    expect(
      parseClientFrame(
        "    at saveAddress (http://127.0.0.1:5637/src/lib/api-addresses.js:12:9)",
      ),
    ).toEqual({
      file: "http://127.0.0.1:5637/src/lib/api-addresses.js",
      line: 12,
      column: 9,
      fn: "saveAddress",
    });
  });

  it("reads an anonymous frame", () => {
    expect(
      parseClientFrame("    at http://127.0.0.1:5637/src/main.jsx:3:1"),
    ).toEqual({
      file: "http://127.0.0.1:5637/src/main.jsx",
      line: 3,
      column: 1,
    });
  });

  it("drops a dev server's cache-busting query", () => {
    // `?v=4f2a1c` changes on every restart. Keeping it would make one file look
    // like a different file each time the dev server came back up.
    expect(
      parseClientFrame(
        "    at request (http://127.0.0.1:5637/src/lib/api.js?v=4f2a1c:8:5)",
      )?.file,
    ).toBe("http://127.0.0.1:5637/src/lib/api.js");
  });

  it("refuses a frame with no position", () => {
    // A bare bundle URL is a provenance label, not a place to look.
    expect(
      parseClientFrame("    at http://127.0.0.1:5637/assets/index.js"),
    ).toBeUndefined();
  });

  it("refuses a header line", () => {
    expect(parseClientFrame("Error")).toBeUndefined();
    expect(parseClientFrame("TypeError: x is not a function")).toBeUndefined();
  });
});

describe("clientCallsiteFromStack", () => {
  const stack = [
    "Error",
    "    at saveAddress (http://127.0.0.1:5637/src/lib/api-addresses.js:12:9)",
    "    at onSave (http://127.0.0.1:5637/src/pages/Account.jsx:88:13)",
    "    at HTMLFormElement.submit (http://127.0.0.1:5637/src/pages/Account.jsx:140:5)",
  ].join("\n");

  it("takes the innermost frame and keeps the callers above it", () => {
    const callsite = clientCallsiteFromStack(stack);
    expect(callsite?.file).toBe(
      "http://127.0.0.1:5637/src/lib/api-addresses.js",
    );
    expect(callsite?.fn).toBe("saveAddress");
    expect(callsite?.stack?.map((frame) => frame.fn)).toEqual([
      "onSave",
      "HTMLFormElement.submit",
    ]);
  });

  it("skips the header line even when it contains a URL", () => {
    const withUrlHeader = [
      "Error: failed to load http://127.0.0.1:5637/x.js:1:1",
      "    at boot (http://127.0.0.1:5637/src/main.jsx:3:1)",
    ].join("\n");
    expect(clientCallsiteFromStack(withUrlHeader)?.file).toBe(
      "http://127.0.0.1:5637/src/main.jsx",
    );
  });

  it("returns undefined for a stack with no located frame", () => {
    expect(clientCallsiteFromStack("Error\n    at <anonymous>")).toBeUndefined();
  });

  it("returns undefined for a non-string", () => {
    expect(clientCallsiteFromStack(undefined)).toBeUndefined();
    expect(clientCallsiteFromStack(42)).toBeUndefined();
    expect(clientCallsiteFromStack("")).toBeUndefined();
  });

  it("does not invent a repository path", () => {
    // `/src/pages/Account.jsx` is served from the client app's root; the repo
    // path is `client/src/pages/Account.jsx`. Only the build knows that, so the
    // URL is carried as reported rather than prefixed on a layout convention.
    const callsite = clientCallsiteFromStack(stack);
    expect(callsite?.file.startsWith("http://")).toBe(true);
    expect(callsite?.file).not.toContain("client/src");
  });
});
