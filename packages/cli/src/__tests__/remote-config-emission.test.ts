// Every browser init the installer writes must opt into the capture config poll.
//
// The poll is the only path these capture settings have into a running app: the
// auto flag triggers and their tail, baseline sampling, consent mode, client
// side masking, switching session replay on, and live probe delivery all arrive
// on it. The kill switch, the budgets, row value redaction and the replay write
// refusal are enforced at ingest instead, so those are not at stake here. An
// init that omits `remoteConfig` produces an app whose settings page saves,
// persists and displays as applied while changing nothing, which is why this is
// asserted per snippet builder rather than once — a recipe added later must not
// be able to drop the line quietly.

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

describe("generated inits opt into the capture config poll", () => {
  const browserSnippets: [string, string][] = [
    ["client", clientInitSnippet(ENDPOINT, KEY_EXPR, "web")],
    ["nuxt plugin", nuxtPluginSnippet(ENDPOINT, KEY_EXPR, "web")],
    ["capacitor", capacitorInitSnippet(ENDPOINT, KEY_EXPR, "app")],
    ["react native", reactNativeInitSnippet(ENDPOINT, KEY_EXPR, "app")],
  ];

  it.each(browserSnippets)("%s init sets remoteConfig", (_name, snippet) => {
    expect(snippet).toContain("remoteConfig: true,");
  });

  it.each(browserSnippets)(
    "%s init names neither the config route nor a second copy of the key",
    (_name, snippet) => {
      // The route is derived by the SDK from httpEndpoint, so moving it never
      // has to reach code already committed in a customer's repository.
      expect(snippet).not.toContain("capture-config");
      expect(snippet).not.toContain("projectKey");
    },
  );

  it("reaches the file a real plan writes", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      { cwd: CWD, recipe: "next", endpoint: ENDPOINT, nextVersion: "15.4.0" },
      io,
    );
    expect(plan.content).toContain("remoteConfig: true,");
  });

  it("is carried by the hand-off instructions when injection cannot run", () => {
    expect(
      buildAgentPrompt(
        "vite",
        { endpoint: ENDPOINT, apiKey: "<your-ingest-key>" },
        { serviceName: "web" },
      ),
    ).toContain("remoteConfig: true,");
  });
});
