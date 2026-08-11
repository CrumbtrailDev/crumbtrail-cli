// Reading a browser stack into a callsite.
//
// Every test is either "the fact survives" or "the guess is refused", for the
// same reason `code-locations` states: a wrong path sends a reader somewhere
// confidently irrelevant and does not announce itself.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clientCallsiteFromStack,
  clientCallsiteResolver,
  parseClientFrame,
  resolveClientCallsite,
} from "../client-callsite";

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

describe("frames with no script behind them", () => {
  it("refuses <anonymous>", () => {
    // Measured on a real capture: this produced the code location
    // `<anonymous>:305` — a path nobody can open, on a line that means nothing.
    expect(parseClientFrame("    at <anonymous>:305:14")).toBeUndefined();
    expect(parseClientFrame("    at foo (<anonymous>:1:1)")).toBeUndefined();
  });

  it("refuses native and eval frames", () => {
    expect(parseClientFrame("    at Array.map (native:1:1)")).toBeUndefined();
    expect(parseClientFrame("    at eval at boot (x:1:1)")).toBeUndefined();
  });

  it("still accepts a real script", () => {
    // The other direction. A refusal rule wide enough to drop real frames would
    // empty the field this whole change exists to fill.
    expect(parseClientFrame("    at go (http://h/src/a.js:2:3)")?.file).toBe("http://h/src/a.js");
    expect(parseClientFrame("    at go (/srv/app/a.js:2:3)")?.file).toBe("/srv/app/a.js");
  });
});

/* ------------------------------------------------------------------ */
/* Production stack shapes                                             */
/* ------------------------------------------------------------------ */

/**
 * The frames a real deployment emits, as opposed to the ones a dev server does.
 *
 * The parser was measured against a Vite dev server, where a frame is
 * `http://127.0.0.1:5637/src/pages/Account.jsx:88:13` — already the file a
 * person edits. Nothing about that shape exercises the cases that only appear
 * once an application is BUILT, and a parser that only handles the shape it was
 * written against is a parser that works in the harness and nowhere else.
 */
describe("parseClientFrame — shapes a dev server never produces", () => {
  it("reads a minified single-line bundle frame", () => {
    // The overwhelmingly common production shape: everything on generated line
    // 1, at a large column. Nothing may reject it for being unreadable — that is
    // the source map's job, and it cannot do it if the frame never parses.
    expect(
      parseClientFrame("    at n (https://app.example.test/assets/index-a3f2c1.js:1:48213)"),
    ).toEqual({
      file: "https://app.example.test/assets/index-a3f2c1.js",
      line: 1,
      column: 48213,
      fn: "n",
    });
  });

  it("reads a webpack-internal frame", () => {
    expect(
      parseClientFrame(
        "    at onSave (webpack-internal:///./src/pages/Account.jsx:88:13)",
      ),
    ).toEqual({
      file: "webpack-internal:///./src/pages/Account.jsx",
      line: 88,
      column: 13,
      fn: "onSave",
    });
  });

  it("reads an async frame without mangling the function name", () => {
    // V8 prefixes `async` on a frame suspended at an await. It is part of the
    // rendered function label, and dropping the frame over it would lose exactly
    // the awaited calls a request travels through.
    expect(
      parseClientFrame("    at async saveAddress (https://app.example.test/a.js:1:20)"),
    ).toMatchObject({ fn: "async saveAddress", line: 1, column: 20 });
  });

  it("reads a class-qualified frame", () => {
    expect(
      parseClientFrame("    at HTMLFormElement.handleSubmit (https://app.example.test/a.js:1:9)"),
    ).toMatchObject({ fn: "HTMLFormElement.handleSubmit" });
  });

  it("refuses a frame from inside eval rather than reporting the eval site", () => {
    // V8 renders these with a nested location. The outer parentheses make it
    // ambiguous which position belongs to the file, and picking one is a guess.
    expect(
      parseClientFrame(
        "    at eval (eval at <anonymous> (https://app.example.test/a.js:1:1), <anonymous>:1:1)",
      ),
    ).toBeUndefined();
  });

  it("refuses an extension frame that is not the application at all", () => {
    // `chrome-extension://` parses as a URL and would otherwise be published as
    // the place to fix a defect in someone else's code.
    expect(
      parseClientFrame("    at x (chrome-extension://abcdefg/inject.js:1:1)"),
    ).toBeUndefined();
  });

  it("keeps a hashed chunk name distinct from an unhashed one", () => {
    // The query strip exists for a dev server's `?v=4f2a1c`. It must not reach
    // into the FILENAME hash, which is the only thing telling two builds apart.
    expect(
      parseClientFrame("    at n (https://app.example.test/assets/index-a3f2c1.js?v=9:1:5)")?.file,
    ).toBe("https://app.example.test/assets/index-a3f2c1.js");
  });
});

/* ------------------------------------------------------------------ */
/* Source maps                                                         */
/* ------------------------------------------------------------------ */

/**
 * Real esbuild output, borrowed from `source-map.test.ts` for the reason stated
 * there: a hand written `mappings` string encodes the same assumptions as the
 * decoder, so it can pass while disagreeing with every bundler in use.
 *
 * Original `board.ts`; minified to one line. `throw` sits at generated column
 * 45 (original 4:5) and `items.length` at column 27 (original line 2).
 */
const BUNDLE_MAP = JSON.stringify({
  version: 3,
  sources: ["board.ts"],
  mappings:
    "MAAO,SAASA,EAAYC,EAAyB,CACnD,IAAMC,EAAQD,EAAM,OACpB,GAAIC,IAAU,EACZ,MAAM,IAAI,MAAM,eAAe,EAEjC,OAAOA,CACT",
  names: ["renderBoard", "items", "total"],
});

describe("resolveClientCallsite", () => {
  const lookup = () => BUNDLE_MAP;

  it("resolves a minified bundle frame back to the repository file", () => {
    // The case the whole feature fails on in production: without this the
    // location published is `index.min.js:1:45`, a file nobody wrote at a line
    // that does not exist.
    expect(
      resolveClientCallsite(
        { file: "https://app.example.test/assets/index.min.js", line: 1, column: 45, fn: "n" },
        lookup,
      ),
    ).toEqual({
      file: "board.ts",
      line: 4,
      column: 5,
      fn: "n",
      minifiedFile: "https://app.example.test/assets/index.min.js",
    });
  });

  it("resolves the caller chain too, not only the innermost frame", () => {
    // The chain is the reason this shape was reused for client callsites: the
    // request goes out through a shared helper and the line to fix is a frame
    // out. A resolver that stopped at the head would leave the frame that
    // actually matters minified.
    const resolved = resolveClientCallsite(
      {
        file: "https://app.example.test/assets/index.min.js",
        line: 1,
        column: 45,
        stack: [
          { file: "https://app.example.test/assets/index.min.js", line: 1, column: 27 },
        ],
      },
      lookup,
    );
    expect(resolved.stack?.[0]).toEqual({
      file: "board.ts",
      line: 2,
      column: 17,
      minifiedFile: "https://app.example.test/assets/index.min.js",
    });
  });

  it("leaves the frame alone when there is no map, and says nothing was mapped", () => {
    // Honest degradation, matching `resolveCandidateFrames`. The ABSENCE of
    // `minifiedFile` is the assertion that matters: it is what tells a reader
    // downstream that this path is as the runtime reported it.
    const untouched = resolveClientCallsite(
      { file: "https://app.example.test/assets/index.min.js", line: 1, column: 45 },
      () => undefined,
    );
    expect(untouched).toEqual({
      file: "https://app.example.test/assets/index.min.js",
      line: 1,
      column: 45,
    });
    expect(untouched.minifiedFile).toBeUndefined();
  });

  it("leaves the frame alone when the map is corrupt", () => {
    expect(
      resolveClientCallsite(
        { file: "https://app.example.test/assets/index.min.js", line: 1, column: 45 },
        () => "{ not json",
      ).file,
    ).toBe("https://app.example.test/assets/index.min.js");
  });

  it("leaves the frame alone when the map does not cover the position", () => {
    expect(
      resolveClientCallsite(
        { file: "https://app.example.test/assets/index.min.js", line: 99, column: 1 },
        lookup,
      ).minifiedFile,
    ).toBeUndefined();
  });
});

describe("clientCallsiteResolver", () => {
  const previous = process.env.CRUMBTRAIL_SOURCEMAP_DIR;
  afterEach(() => {
    if (previous === undefined) delete process.env.CRUMBTRAIL_SOURCEMAP_DIR;
    else process.env.CRUMBTRAIL_SOURCEMAP_DIR = previous;
  });

  it("is off unless CRUMBTRAIL_SOURCEMAP_DIR is set", () => {
    // Gated on the SAME variable as candidate-frame resolution. Two source-map
    // switches that can disagree is a support question nobody can answer from
    // the artifact alone.
    delete process.env.CRUMBTRAIL_SOURCEMAP_DIR;
    expect(clientCallsiteResolver()).toBeUndefined();
  });

  it("resolves through a directory of build output when it is set", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-clientmap-"));
    try {
      fs.writeFileSync(path.join(dir, "index.min.js.map"), BUNDLE_MAP);
      process.env.CRUMBTRAIL_SOURCEMAP_DIR = dir;
      const resolve = clientCallsiteResolver();
      expect(resolve).toBeDefined();
      expect(
        resolve!({
          file: "https://app.example.test/assets/index.min.js",
          line: 1,
          column: 45,
        }),
      ).toMatchObject({ file: "board.ts", line: 4, column: 5 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
