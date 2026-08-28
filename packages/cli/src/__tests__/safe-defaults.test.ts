// The installer's own safety posture, asserted on the emitted text.
//
// Every one of these lines was added because a customer found its absence in
// production: cookie, keystroke and clipboard capture on a first deploy, an
// unconfigured service still paying for `autoCapture`'s hooks and driver
// patches, and Express middleware recording 4xx bodies and patching stdout a
// second time behind an `autoCapture` that had already done it. An SDK default
// moving is not allowed to quietly undo any of that, which is what these
// assertions are for.

import { describe, expect, it } from "vitest";
import {
  capacitorInitSnippet,
  clientInitSnippet,
  expressErrorMiddlewareSnippet,
  expressManualWiringSnippet,
  expressRequestMiddlewareSnippet,
  nestInitSnippet,
  nodeInitSnippet,
  nuxtPluginSnippet,
  staticScriptTagSnippet,
  tauriInitSnippet,
} from "../inject/snippets";

const ENDPOINT = "https://ingest.example.com";
const CLIENT_KEY = "import.meta.env.VITE_CRUMBTRAIL_KEY";
const SERVER_KEY = "process.env.CRUMBTRAIL_KEY";

/** The key expression is source text, so it has to be escaped to match on. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PRIVATE_COLLECTORS = [
  "cookies: false,",
  "keystrokes: false,",
  "clipboard: false,",
];

describe("browser inits opt out of the collectors that record the person", () => {
  const browserSnippets: Array<[string, string]> = [
    ["client", clientInitSnippet(ENDPOINT, CLIENT_KEY, "web", null)],
    ["nuxt", nuxtPluginSnippet(ENDPOINT, CLIENT_KEY, "web", null)],
    ["capacitor", capacitorInitSnippet(ENDPOINT, CLIENT_KEY, "app", null)],
    [
      "static",
      staticScriptTagSnippet({ endpoint: ENDPOINT, keyLiteral: "ctkey_TODO" }),
    ],
    ["tauri", tauriInitSnippet()],
  ];

  for (const [name, snippet] of browserSnippets) {
    it(`${name} names all three, off`, () => {
      for (const line of PRIVATE_COLLECTORS) expect(snippet).toContain(line);
    });

    // The evidence a bug is actually read from must survive the opt-outs, or
    // the install reports success and shows an empty session.
    it(`${name} leaves console, network and storage alone`, () => {
      expect(snippet).not.toContain("console: false");
      expect(snippet).not.toContain("network: false");
      expect(snippet).not.toContain("storage: false");
      expect(snippet).not.toContain("errors: false");
    });
  }
});

describe("backend capture only runs with a key", () => {
  it("guards autoCapture", () => {
    expect(nodeInitSnippet(ENDPOINT, SERVER_KEY, "api")).toContain(
      `if (${SERVER_KEY}) {`,
    );
  });

  it("guards the Nest variant too", () => {
    expect(nestInitSnippet(ENDPOINT, SERVER_KEY, "api")).toContain(
      `if (${SERVER_KEY}) {`,
    );
  });

  it("guards both Express middleware", () => {
    expect(
      expressRequestMiddlewareSnippet("app", ENDPOINT, SERVER_KEY),
    ).toMatch(new RegExp(`^if \\(${escapeRe(SERVER_KEY)}\\) app\\.use\\(`));
    expect(expressErrorMiddlewareSnippet("app", ENDPOINT, SERVER_KEY)).toMatch(
      new RegExp(`^if \\(${escapeRe(SERVER_KEY)}\\) app\\.use\\(`),
    );
  });
});

describe("Express middleware captures no more than the install asked for", () => {
  const request = expressRequestMiddlewareSnippet("app", ENDPOINT, SERVER_KEY);
  const error = expressErrorMiddlewareSnippet("app", ENDPOINT, SERVER_KEY);

  it("records no response bodies", () => {
    expect(request).toContain('captureResponseBody: "off"');
    expect(error).toContain('captureResponseBody: "off"');
  });

  // autoCapture is injected into the same process by the express recipe, so
  // these two would be a second stdout patch producing the same events.
  it("leaves logs and runtime warnings to autoCapture", () => {
    expect(request).toContain("captureLogs: false");
    expect(request).toContain("captureRuntimeWarnings: false");
  });

  it("says the same thing in the manual wiring block", () => {
    const manual = expressManualWiringSnippet(ENDPOINT, SERVER_KEY);
    expect(manual).toContain('captureResponseBody: "off"');
    expect(manual).toContain("captureLogs: false");
    expect(manual).toContain(`if (${SERVER_KEY}) app.use(`);
  });
});
