// Every browser init the installer writes must name the cross-origin allowlist.
//
// `networkCorrelationAllowedOrigins` defaults to empty, and empty means only
// same origin calls carry the session, request and traceparent headers. A
// browser app calling an API on another host is the normal multi service shape,
// so an init that omits the field produces a wizard that reports success and a
// product whose frontend and backend evidence never joins, with nothing naming
// the cause. Asserted per snippet builder rather than once, so a recipe added
// later cannot drop the field quietly.

import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  capacitorInitSnippet,
  clientInitSnippet,
  nuxtPluginSnippet,
  reactNativeInitSnippet,
} from "../inject/snippets";
import { buildPlan } from "../inject/recipes";
import { buildAgentPrompt } from "../install/index";
import { fakeInjectIO } from "./helpers";

const CWD = "/proj";
const ENDPOINT = "https://ingest.example.com";
const KEY_EXPR = "import.meta.env.VITE_CRUMBTRAIL_KEY";
const p = (...parts: string[]) => path.join(CWD, ...parts);

describe("generated inits name the cross-origin correlation allowlist", () => {
  const browserSnippets: [string, string][] = [
    ["client", clientInitSnippet(ENDPOINT, KEY_EXPR, "web")],
    ["nuxt plugin", nuxtPluginSnippet(ENDPOINT, KEY_EXPR, "web")],
    ["capacitor", capacitorInitSnippet(ENDPOINT, KEY_EXPR, "app")],
    ["react native", reactNativeInitSnippet(ENDPOINT, KEY_EXPR, "app")],
  ];

  it.each(browserSnippets)(
    "%s init emits networkCorrelationAllowedOrigins",
    (_name, snippet) => {
      expect(snippet).toContain("networkCorrelationAllowedOrigins: [],");
    },
  );

  it.each(browserSnippets)(
    "%s init says what the empty list costs",
    (_name, snippet) => {
      expect(snippet).toContain("Backend origins this app calls");
      expect(snippet).toContain("frontend and backend evidence stay separate");
    },
  );

  it("fills in origins the installer already knows, and never invents one", () => {
    const known = clientInitSnippet(ENDPOINT, KEY_EXPR, "web", [
      "https://api.example.com",
      "http://localhost:4000",
    ]);
    expect(known).toContain(
      'networkCorrelationAllowedOrigins: ["https://api.example.com", "http://localhost:4000"],',
    );
    // The example lives in the comment, never in the emitted array.
    expect(clientInitSnippet(ENDPOINT, KEY_EXPR, "web")).toContain(
      "networkCorrelationAllowedOrigins: [],",
    );
  });

  it("reaches the file a real plan writes", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      { cwd: CWD, recipe: "next", endpoint: ENDPOINT, nextVersion: "15.4.0" },
      io,
    );
    expect(plan.content).toContain("networkCorrelationAllowedOrigins: [],");
  });

  it("is carried by the hand-off instructions when injection cannot run", () => {
    expect(
      buildAgentPrompt(
        "vite",
        { endpoint: ENDPOINT, apiKey: "<your-ingest-key>" },
        { serviceName: "web" },
      ),
    ).toContain("networkCorrelationAllowedOrigins: [],");
  });
});
